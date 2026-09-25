import type {
  NormalizedTrade,
  NormalizedResolution,
  NormalizedCollateralDeposit,
} from "./types.js";
import type {
  PersistedTrade,
  PersistedResolution,
  PersistedCollateralDeposit,
  PersistedMarketCreated,
  DuplicateEventLogger,
} from "./idempotency.js";
import { insertAllIfNew, insertIfNew } from "./idempotency.js";
import { sharesRawToInt } from "./decimalUtils.js";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";
import type { PrismaClient } from "../../../src/generated/prisma/client/index.js";
import { sleep } from "./retry.js";
import { batchRejectedTotalCounter } from "./metrics.js";
import { BatchWriteError } from "./batchWriterError.js";

export type BatchRecord =
  | { kind: "trade"; data: PersistedTrade }
  | { kind: "resolution"; data: PersistedResolution }
  | { kind: "collateral_deposited"; data: PersistedCollateralDeposit }
  | { kind: "market_created"; data: PersistedMarketCreated };

export interface BatchWriteError {
  record: Record<string, unknown>;
  error: string;
}

export interface BatchWriteResult {
  written: number;
  skipped: number;
  errors: BatchWriteError[];
}

export interface BatchWriter {
  write(records: BatchRecord[]): Promise<BatchWriteResult>;
  flush(): Promise<void>;
}

/**
 * Stable, typed error codes surfaced by the batch writer. Callers (and ops
 * dashboards) can branch on `code` without parsing free-form messages.
 *
 * Re-exported from `./batchWriterError.js` so existing importers keep working
 * while consumers that only need the error type (e.g. the gap back-fill job)
 * can avoid loading the Prisma-backed writer.
 */
export type { BatchWriteErrorCode } from "./batchWriterError.js";
export { BatchWriteError };

const CHAIN_RESOLUTION_SOURCE_PREFIX = "chain:market_resolved";
/** Stellar null account — used when the on-chain tuple omits oracle address. */
const UNKNOWN_OPERATOR_ADDRESS =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Prisma/Postgres error codes that are safe to retry — the operation did not
 * partially commit so repeating it is idempotent given the write-idempotency
 * guarantees already in place.
 *
 * P1001 — Cannot reach database server
 * P1008 — Operations timed out
 * P1017 — Server closed the connection
 * 40001 — Serialization failure (Postgres)
 * 40P01 — Deadlock detected (Postgres)
 * P2002 — Unique constraint violation (#946). Every `create()` issued inside
 *   this transaction targets a row keyed by `idempotencyKey`, so this code
 *   can only mean a concurrent batch writer (another instance, or an
 *   overlapping retry of this same event range under Horizon's
 *   at-least-once delivery) committed the identical idempotent record
 *   between our dedup read and our insert. Postgres aborts the whole
 *   transaction on the conflicting statement, so we cannot locally
 *   downgrade it to a skip — retrying is safe and correct: the next
 *   attempt's dedup check will see the now-committed row and classify it
 *   as a duplicate instead of racing it again.
 */
const RETRYABLE_PRISMA_CODES = new Set([
  "P1001",
  "P1008",
  "P1017",
  "40001",
  "40P01",
  "P2002",
]);

/**
 * Dependency-outage codes that must fail closed: the batch is aborted and a
 * typed error is surfaced rather than partially persisting. These are a subset
 * of the retryable codes — after exhausting retries they are reported as
 * dependency-unavailable so callers can shed load / alert.
 */
const DEPENDENCY_UNAVAILABLE_CODES = new Set([
  "P1001",
  "P1008",
  "P1017",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);

const BATCH_WRITE_MAX_RETRIES = 3;
const BATCH_WRITE_RETRY_DELAY_MS = 200;

function errorCodeOf(err: unknown): string {
  if (!(err instanceof Error)) return "";
  return (err as any).code ?? (err as any).errorCode ?? "";
}

function isBatchWriteRetryable(err: unknown): boolean {
  return RETRYABLE_PRISMA_CODES.has(errorCodeOf(err));
}

function isDependencyUnavailable(err: unknown): boolean {
  return DEPENDENCY_UNAVAILABLE_CODES.has(errorCodeOf(err));
}

function newCorrelationId(): string {
  return `bw_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Size / input DoS guard (#1152)
// ---------------------------------------------------------------------------

/** Env var that overrides the hard cap on records accepted per batch. */
export const MAX_BATCH_RECORDS_ENV_VAR = "INDEXER_BATCH_MAX_RECORDS";

/**
 * Safe default cap on records accepted in a single batch. Chosen well above
 * any legitimate ingestion or back-fill batch (`INDEXER_LEDGER_WINDOW_SIZE`
 * defaults to 100 ledgers, which cannot produce anything close to this many
 * records) while still bounding the work a single call can enqueue inside one
 * database transaction.
 */
export const DEFAULT_MAX_BATCH_RECORDS = 1_000;

/**
 * Resolve the effective record cap.
 *
 * An absent, blank, non-integer, or non-positive value falls back to
 * `DEFAULT_MAX_BATCH_RECORDS` — a malformed/attacker-controlled config must
 * never *disable* the guard (fail-closed, never fail-open).
 */
export function resolveMaxBatchRecords(env: Env = process.env): number {
  const raw = env[MAX_BATCH_RECORDS_ENV_VAR];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_BATCH_RECORDS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_MAX_BATCH_RECORDS;
  }

  return parsed;
}

type Env = Record<string, string | undefined>;

/**
 * Assert that a batch may be persisted, before any database work happens.
 *
 * Exported so every entrypoint that builds a batch (ingestion, gap back-fill,
 * operator scripts) can pre-check with the same rule the writer enforces
 * internally. Fails closed: an oversized or malformed batch is rejected with a
 * typed `BatchWriteError` and nothing reaches the database.
 *
 * @throws {BatchWriteError} `BATCH_WRITE_INVALID_INPUT` when `records` is not
 *   an array, or `BATCH_WRITE_TOO_LARGE` when it exceeds `maxRecords`.
 */
export function assertBatchWithinLimits(
  records: unknown,
  options: { maxRecords?: number; correlationId?: string } = {}
): asserts records is BatchRecord[] {
  const maxRecords = options.maxRecords ?? resolveMaxBatchRecords();
  const correlationId = options.correlationId ?? newCorrelationId();

  if (!Array.isArray(records)) {
    batchRejectedTotalCounter.inc({ reason: "invalid_input" });
    throw new BatchWriteError(
      "BATCH_WRITE_INVALID_INPUT",
      "Batch write rejected: records must be an array",
      correlationId
    );
  }

  if (records.length > maxRecords) {
    batchRejectedTotalCounter.inc({ reason: "too_large" });
    throw new BatchWriteError(
      "BATCH_WRITE_TOO_LARGE",
      `Batch write rejected: ${records.length} records exceeds the maximum of ${maxRecords}`,
      correlationId
    );
  }
}

export interface PrismaBatchWriterConfig {
  /**
   * Hard cap on records accepted per `write()` call (#1152). Defaults to
   * `INDEXER_BATCH_MAX_RECORDS` when set, otherwise
   * `DEFAULT_MAX_BATCH_RECORDS`. Values must be positive integers.
   */
  maxRecords?: number;
}

export class PrismaBatchWriter implements BatchWriter {
  private readonly prisma = getPrismaClient();
  /** Effective, already-validated record cap for this writer instance. */
  private readonly maxRecords: number;

  constructor(
    private readonly logger?: ILogger,
    config: PrismaBatchWriterConfig = {}
  ) {
    if (
      config.maxRecords !== undefined &&
      (!Number.isInteger(config.maxRecords) || config.maxRecords < 1)
    ) {
      throw new BatchWriteError(
        "BATCH_WRITE_INVALID_INPUT",
        "maxRecords must be a positive integer",
        newCorrelationId()
      );
    }
    this.maxRecords = config.maxRecords ?? resolveMaxBatchRecords();
  }

  async write(records: BatchRecord[]): Promise<BatchWriteResult> {
    if (records.length === 0) {
      return { written: 0, skipped: 0, errors: [] };
    }

    const correlationId = newCorrelationId();

    // Size / input DoS guard (#1152) — must run before any database work so a
    // griefing caller cannot force a huge transaction or exhaust memory.
    try {
      assertBatchWithinLimits(records, {
        maxRecords: this.maxRecords,
        correlationId,
      });
    } catch (err) {
      this.logger?.error("Batch write rejected by size guard", {
        code: err instanceof BatchWriteError ? err.code : "BATCH_WRITE_FAILED",
        correlationId,
        recordCount: Array.isArray(records) ? records.length : null,
        maxRecords: this.maxRecords,
      });
      throw err;
    }

    let written = 0;
    let skipped = 0;
    const errors: BatchWriteError[] = [];
    const duplicateLogger: DuplicateEventLogger | undefined = this.logger
      ? {
          info: (message, meta) => this.logger!.info(message, meta),
        }
      : undefined;

    // Retry the transaction on transient DB errors (connection reset,
    // serialisation failures, deadlocks). Each batch is idempotent thanks to
    // the indexerProcessedEvent deduplication layer so retrying is safe.
    let lastError: unknown;
    for (let attempt = 0; attempt <= BATCH_WRITE_MAX_RETRIES; attempt++) {
      try {
        await this.prisma.$transaction(async (tx) => {
          // Reset per-attempt counters inside the transaction so a retry
          // starts from a clean slate.
          written = 0;
          skipped = 0;
          errors.length = 0;

          const keyedRecords = records.map((record) => ({
            ...record,
            idempotencyKey: record.data.idempotencyKey,
          }));
          const recordByKey = new Map(
            records.map((record) => [record.data.idempotencyKey, record])
          );

          const deduped = await insertAllIfNew(
            keyedRecords,
            async (record) => {
              const existing = await tx.indexerProcessedEvent.findUnique({
                where: { idempotencyKey: record.idempotencyKey },
              });

              return existing ? null : record;
            },
            { logger: duplicateLogger }
          );

          skipped += deduped.duplicateCount;

          // A record failing to persist must abort and roll back the whole
          // transaction rather than committing the records that already
          // succeeded — a batch is applied atomically or not at all, so a
          // retry never has to reason about a half-applied batch (Issue #756).
          for (const dedupedRecord of deduped.inserted) {
            const record = recordByKey.get(dedupedRecord.idempotencyKey);
            if (!record) {
              continue;
            }

            const result = await insertIfNew(
              record.data,
              async (persisted) =>
                this.persistRecord(
                  tx,
                  record,
                  persisted as
                    | PersistedTrade
                    | PersistedResolution
                    | PersistedCollateralDeposit
                    | PersistedMarketCreated
                ),
              { logger: duplicateLogger }
            );

            if (result.status === "inserted") {
              written += 1;
            } else {
              skipped += 1;
            }
          }
        });

        // Transaction succeeded — exit the retry loop
        return { written, skipped, errors };
      } catch (err) {
        lastError = err;
        const isLast = attempt === BATCH_WRITE_MAX_RETRIES;

        if (!isLast && isBatchWriteRetryable(err)) {
          const delay = BATCH_WRITE_RETRY_DELAY_MS * 2 ** attempt;
          this.logger?.warn("Transient DB error in batch write, retrying", {
            attempt: attempt + 1,
            maxRetries: BATCH_WRITE_MAX_RETRIES,
            delayMs: delay,
            correlationId,
            error: err instanceof Error ? err.message : String(err),
          });
          await sleep(delay);
          continue;
        }

        // Fail closed: the transaction has rolled back, so nothing was
        // partially persisted. Surface a stable typed error so callers can
        // shed load / alert without parsing messages.
        const dependencyDown = isDependencyUnavailable(err);
        const code: BatchWriteErrorCode = dependencyDown
          ? "BATCH_WRITE_DEPENDENCY_UNAVAILABLE"
          : "BATCH_WRITE_FAILED";
        const message = dependencyDown
          ? "Batch write aborted: dependency unavailable"
          : "Batch write aborted: transaction failed";

        this.logger?.error(message, {
          code,
          correlationId,
          recordCount: records.length,
          error: err instanceof Error ? err.message : String(err),
        });

        throw new BatchWriteError(code, message, correlationId, err);
      }
    }

    // Unreachable — satisfies TypeScript
    throw lastError;
  }

  async flush(): Promise<void> {
    // Single $transaction per write() — nothing buffered between batches.
  }

  private async persistRecord(
    tx: Omit<
      PrismaClient,
      "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
    >,
    record: BatchRecord,
    persisted:
      | PersistedTrade
      | PersistedResolution
      | PersistedCollateralDeposit
      | PersistedMarketCreated
  ): Promise<
    | PersistedTrade
    | PersistedResolution
    | PersistedCollateralDeposit
    | PersistedMarketCreated
    | null
  > {
    const existing = await tx.indexerProcessedEvent.findUnique({
      where: { idempotencyKey: persisted.idempotencyKey },
    });
    if (existing) {
      return null;
    }

    await tx.indexerProcessedEvent.create({
      data: {
        idempotencyKey: persisted.idempotencyKey,
        eventKind: record.kind,
        ledger: persisted.ledger,
      },
    });

    if (record.kind === "trade") {
      const trade = persisted as PersistedTrade;
      await tx.indexedTrade.create({
        data: {
          idempotencyKey: trade.idempotencyKey,
          eventId: trade.eventId,
          ledger: trade.ledger,
          marketId: trade.marketId,
          traderAddress: trade.traderAddress,
          counterpartyAddress: trade.counterpartyAddress,
          direction: trade.direction,
          outcome: trade.outcome,
          priceRaw: trade.priceRaw.toString(),
          quantityRaw: trade.quantityRaw.toString(),
          buyOrderId: trade.buyOrderId,
          sellOrderId: trade.sellOrderId,
        },
      });
      await this.reconcileTradeIntoPositions(tx, trade);
    } else if (record.kind === "resolution") {
      const resolution = persisted as PersistedResolution;
      await tx.resolutionCandidate.create({
        data: {
          marketId: resolution.marketId,
          proposedOutcome: resolution.outcome === "YES",
          source: `${CHAIN_RESOLUTION_SOURCE_PREFIX}:${resolution.contractId}`,
          status: "PROPOSED",
          operatorAddress:
            resolution.oracleAddress.trim() !== ""
              ? resolution.oracleAddress
              : UNKNOWN_OPERATOR_ADDRESS,
          idempotencyKey: resolution.idempotencyKey,
          confidenceScore: resolution.confidenceScore ?? null,
        },
      });
    } else if (record.kind === "collateral_deposited") {
      const deposit = persisted as PersistedCollateralDeposit;
      await tx.collateralDeposit.create({
        data: {
          idempotencyKey: deposit.idempotencyKey,
          ledger: deposit.ledger,
          marketId: deposit.marketId,
          account: deposit.account,
          amountRaw: deposit.amountRaw.toString(),
        },
      });
    } else if (record.kind === "market_created") {
      const market = persisted as PersistedMarketCreated;
      await tx.indexedMarket.create({
        data: {
          idempotencyKey: market.idempotencyKey,
          ledger: market.ledger,
          marketId: market.marketId,
          contractId: market.contractId,
          operatorAddress: market.operatorAddress ?? UNKNOWN_OPERATOR_ADDRESS,
        },
      });
    }

    return persisted;
  }

  private async reconcileTradeIntoPositions(
    tx: Omit<
      PrismaClient,
      "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
    >,
    trade: PersistedTrade
  ): Promise<void> {
    // #948: validated bigint -> Number boundary (rejects negative/non-integer/
    // precision-losing quantities) instead of a bare `Number(raw)`, which
    // silently truncates past Number.MAX_SAFE_INTEGER.
    let quantity: number;
    try {
      quantity = sharesRawToInt(trade.quantityRaw);
    } catch (err) {
      this.logger?.warn(
        "Skipping position reconciliation: invalid trade quantity",
        {
          idempotencyKey: trade.idempotencyKey,
          marketId: trade.marketId,
          quantityRaw: trade.quantityRaw.toString(),
          error: err instanceof Error ? err.message : String(err),
        }
      );
      return;
    }
    if (quantity <= 0) return;

    const delta =
      trade.direction === "BUY" ? trade.quantityRaw : -trade.quantityRaw;

    await tx.indexedPosition.upsert({
      where: {
        marketId_traderAddress_outcome: {
          marketId: trade.marketId,
          traderAddress: trade.traderAddress,
          outcome: trade.outcome,
        },
      },
      create: {
        marketId: trade.marketId,
        traderAddress: trade.traderAddress,
        outcome: trade.outcome,
        quantityRaw: delta.toString(),
      },
      update: {
        quantityRaw: { increment: delta.toString() },
      },
    });
  }
}
