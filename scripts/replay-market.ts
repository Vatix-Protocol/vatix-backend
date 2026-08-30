#!/usr/bin/env tsx
/**
 * Deterministic order/trade replay & forensics CLI.
 *
 * Given a marketId + outcome, replays the full order arrival history through
 * the real matching engine (src/matching/engine.ts) into a fresh, isolated
 * OrderBook, then diffs the result against ledger truth (Order/Trade rows)
 * and the cached Redis depth snapshot. Exits non-zero on divergence with a
 * structured JSON report.
 *
 * Read-only: only ever issues Prisma `findMany`/`findUnique` reads and Redis
 * `GET`s. Never writes to the database or cache.
 *
 * See docs/replay-forensics.md for when to run this and how to interpret a
 * divergence report.
 *
 * Usage:
 *   npx tsx scripts/replay-market.ts --market <id> --outcome YES
 *   npx tsx scripts/replay-market.ts --market <id> --outcome NO --as-of 2026-07-29T00:00:00Z
 *   npx tsx scripts/replay-market.ts --sample 20   # sample N random active markets (both outcomes)
 */
import { getPrismaClient } from "../src/services/prisma.js";
import { redis } from "../src/services/redis.js";
import { replayEvents, type ReplayEvent } from "../src/matching/replay.js";
import {
  buildDivergenceReport,
  type LedgerOrder,
  type LedgerTrade,
  type ReplayDivergenceReport,
} from "../src/matching/replay-diff.js";
import { replayDivergenceTotal } from "../src/services/metrics.js";
import type { Outcome, OrderSide } from "../src/types/index.js";

interface Args {
  marketId?: string;
  outcome?: Outcome;
  asOf: Date;
  sample?: number;
  help?: boolean;
}

export const HELP = `
Deterministic order/trade replay & forensics CLI — reconstructs a book's fills.

Usage:
  pnpm replay:market -- --market <id> --outcome <YES|NO> [--as-of <iso-date>]
  pnpm replay:market -- --sample <N>

Options:
  --market <id>       Market to replay
  --outcome <YES|NO>  Which side of the market to replay
  --as-of <iso-date>  Replay only orders/trades at or before this instant
                      (default: now) — use the incident time for postmortems
  --sample <N>        Instead of one market, replay N recent markets (both
                      outcomes) and exit non-zero if any diverges
  -h, --help          Show this help

Requires DATABASE_URL (and REDIS_URL for the depth cross-check). Read-only:
issues only Prisma reads and Redis GETs. Exit code 0 = replay matches ledger
truth exactly, 1 = divergence or error. See docs/replay-forensics.md.
`;

export function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  const args = argv;
  let marketId: string | undefined;
  let outcome: Outcome | undefined;
  let asOf = new Date();
  let sample: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-h" || args[i] === "--help") {
      return { asOf, help: true };
    } else if (args[i] === "--market" && args[i + 1]) {
      marketId = args[++i];
    } else if (args[i] === "--outcome" && args[i + 1]) {
      const value = args[++i].toUpperCase();
      if (value !== "YES" && value !== "NO") {
        throw new Error(`--outcome must be YES or NO, got "${value}"`);
      }
      outcome = value;
    } else if (args[i] === "--as-of" && args[i + 1]) {
      const parsed = new Date(args[++i]);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error("--as-of must be a valid date/time string");
      }
      asOf = parsed;
    } else if (args[i] === "--sample" && args[i + 1]) {
      sample = parseInt(args[++i], 10);
      if (!Number.isFinite(sample) || sample < 1) {
        throw new Error("--sample must be a positive integer");
      }
    }
  }

  if (sample === undefined && (!marketId || !outcome)) {
    throw new Error(
      "Usage: pnpm replay:market -- --market <id> --outcome <YES|NO> [--as-of <iso-date>]  OR  --sample <N>  (see --help)"
    );
  }

  return { marketId, outcome, asOf, sample };
}

function log(
  level: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "replay-market",
      message,
      ...meta,
    })
  );
}

/**
 * Anchor cancel events for orders with no persisted cancellation timestamp.
 *
 * The Order table does not currently record when a cancel happened (only
 * that it did, via `status: CANCELLED`), so exact interleaving with later
 * order arrivals cannot be reconstructed with certainty. This anchors each
 * cancel immediately after the *last* trade event that touched the order
 * (or immediately after its own create event if it was never touched),
 * which bounds the uncertainty window to (last fill, actual cancel] rather
 * than guessing "at creation" or "at the end" — see docs/replay-forensics.md
 * for the full rationale. Orders resolved this way are returned as
 * `ambiguous` so the report can surface them distinctly from hard
 * divergences.
 */
interface RawOrder {
  id: string;
  userAddress: string;
  side: OrderSide;
  price: number;
  quantity: number;
  createdAt: Date;
  status: string;
}

function buildReplayEvents(
  ordersRaw: RawOrder[],
  trades: Array<LedgerTrade & { tradedAt: Date }>
): { events: ReplayEvent[]; ambiguous: string[] } {
  const createdAtById = new Map(
    ordersRaw.map((o) => [o.id, o.createdAt.getTime()])
  );

  const events: ReplayEvent[] = ordersRaw
    .map((o) => ({
      type: "create" as const,
      id: o.id,
      userAddress: o.userAddress,
      side: o.side,
      price: o.price,
      quantity: o.quantity,
      timestamp: o.createdAt.getTime(),
    }))
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

  const ambiguous: string[] = [];
  const cancelInsertions: Array<{ afterOrderId: string; event: ReplayEvent }> =
    [];

  for (const o of ordersRaw) {
    if (o.status !== "CANCELLED") continue;

    const touchingTrades = trades.filter(
      (t) => t.buyOrderId === o.id || t.sellOrderId === o.id
    );

    let anchorOrderId = o.id;
    if (touchingTrades.length > 0) {
      const lastTrade = touchingTrades.reduce((latest, t) =>
        t.tradedAt.getTime() > latest.tradedAt.getTime() ? t : latest
      );
      const counterpartyId =
        lastTrade.buyOrderId === o.id
          ? lastTrade.sellOrderId
          : lastTrade.buyOrderId;
      const ownCreatedAt = createdAtById.get(o.id) ?? -Infinity;
      const counterpartyCreatedAt =
        createdAtById.get(counterpartyId) ?? -Infinity;
      // The taker is whichever side was created later — see doc comment above.
      anchorOrderId =
        counterpartyCreatedAt > ownCreatedAt ? counterpartyId : o.id;
      ambiguous.push(o.id);
    }

    cancelInsertions.push({
      afterOrderId: anchorOrderId,
      event: {
        type: "cancel",
        id: o.id,
        timestamp: createdAtById.get(o.id) ?? 0,
      },
    });
  }

  for (const { afterOrderId, event } of cancelInsertions) {
    const idx = events.findIndex(
      (e) => e.type === "create" && e.id === afterOrderId
    );
    events.splice(idx === -1 ? events.length : idx + 1, 0, event);
  }

  return { events, ambiguous };
}

async function replayMarketOutcome(
  marketId: string,
  outcome: Outcome,
  asOf: Date
): Promise<ReplayDivergenceReport> {
  const prisma = getPrismaClient();

  const ordersRaw = await prisma.order.findMany({
    where: { marketId, outcome, createdAt: { lte: asOf } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const tradesRaw = await prisma.trade.findMany({
    where: { marketId, outcome, tradedAt: { lte: asOf } },
    orderBy: [{ tradedAt: "asc" }, { id: "asc" }],
  });

  const ledgerOrders: LedgerOrder[] = ordersRaw.map((o) => ({
    id: o.id,
    userAddress: o.userAddress,
    side: o.side,
    price: Number(o.price),
    quantity: o.quantity,
    filledQuantity: o.filledQuantity,
    status: o.status as LedgerOrder["status"],
  }));

  const ledgerTrades: Array<LedgerTrade & { tradedAt: Date }> = tradesRaw.map(
    (t) => ({
      buyOrderId: t.buyOrderId,
      sellOrderId: t.sellOrderId,
      quantity: t.quantity,
      price: Number(t.price),
      tradedAt: t.tradedAt,
    })
  );

  const normalizedOrdersRaw: RawOrder[] = ordersRaw.map((o) => ({
    id: o.id,
    userAddress: o.userAddress,
    side: o.side,
    price: Number(o.price),
    quantity: o.quantity,
    createdAt: o.createdAt,
    status: o.status,
  }));

  const { events, ambiguous } = buildReplayEvents(
    normalizedOrdersRaw,
    ledgerTrades
  );

  const replay = replayEvents(marketId, outcome, events);

  let redisSnapshot = null;
  try {
    redisSnapshot = await redis.getOrderBook(marketId, outcome);
  } catch (error) {
    log(
      "warn",
      "Failed to read Redis order book snapshot; skipping depth cross-check",
      {
        marketId,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }

  return buildDivergenceReport({
    marketId,
    outcome,
    asOf,
    ledgerOrders,
    ledgerTrades,
    replay,
    redisSnapshot,
    cancelAmbiguities: ambiguous,
  });
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const prisma = getPrismaClient();
  let exitCode = 0;

  try {
    if (args.sample !== undefined) {
      const markets = await prisma.market.findMany({
        where: { deletedAt: null },
        select: { id: true },
        take: args.sample,
        orderBy: { createdAt: "desc" },
      });

      const outcomes: Outcome[] = ["YES", "NO"];
      let divergentCount = 0;

      for (const market of markets) {
        for (const outcome of outcomes) {
          const report = await replayMarketOutcome(
            market.id,
            outcome,
            args.asOf
          );
          if (report.hasDivergence) {
            divergentCount++;
            replayDivergenceTotal.inc();
            log("error", "Replay divergence detected", { report });
          } else {
            log("info", "Replay clean", {
              marketId: market.id,
              outcome,
              ordersReplayed: report.ordersReplayed,
              tradesReplayed: report.tradesReplayed,
            });
          }
        }
      }

      log("info", "Sample replay complete", {
        marketsChecked: markets.length,
        divergentBookChecks: divergentCount,
      });

      exitCode = divergentCount > 0 ? 1 : 0;
    } else {
      const report = await replayMarketOutcome(
        args.marketId!,
        args.outcome!,
        args.asOf
      );
      console.log(JSON.stringify(report, null, 2));
      exitCode = report.hasDivergence ? 1 : 0;
    }
  } finally {
    await redis.disconnect();
    await prisma.$disconnect();
  }

  process.exit(exitCode);
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
