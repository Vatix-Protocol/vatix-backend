/**
 * Oracle Submission State Machine & Reconciliation (#996)
 *
 * Makes oracle report submission crash-safe by persisting a durable
 * intent -> broadcast -> confirmed/failed state machine for every
 * (marketId, payloadHash) pair, and by reconciling any submission left
 * "in flight" (broadcast but not yet confirmed) against the chain — on
 * worker startup, and inline before a retry would otherwise resubmit.
 *
 * Without this, a crash between broadcasting a resolve_market tx and
 * persisting its txHash/status is ambiguous: the retry loop cannot tell
 * whether the tx landed on-chain, so it either double-submits (a fresh tx
 * calling resolve_market again) or wrongly reports failure for a
 * resolution that actually succeeded.
 *
 * @module apps/workers/src/oracle/submission-reconciliation
 */
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import {
  oracleSubmissionAmbiguousTotal,
  oracleSubmissionConfirmationLatency,
} from "../../../../src/services/metrics.js";

/** Matches the `.setTimeout(30)` used when building the resolve_market tx.
 *  Once this many seconds have elapsed since broadcast, the tx's timebound
 *  has expired network-wide — it can never be included after that point, no
 *  matter what an individual RPC node currently reports. */
const TX_TIMEBOUND_SECONDS = 30;

/** Extra margin over the timebound before a persistent NOT_FOUND is treated
 *  as definite non-inclusion rather than "not yet visible to this RPC node".
 *  Keeps a slow-to-index node from being misread as proof of non-inclusion. */
const NON_INCLUSION_GRACE_MS = 60_000;

export type SubmissionIntentKey = {
  marketId: string;
  payloadHash: string;
};

export type OracleReportRow = {
  id: string;
  status: string;
  txHash: string | null;
  attempts: number;
  broadcastAt: Date | null;
  confirmedAt: Date | null;
};

/** Deterministic hash of the exact payload that gets signed and submitted.
 *  Must be computed from a stable payload (no wall-clock timestamps minted
 *  per attempt) so retries and redeliveries of the same submission hash to
 *  the same key. */
export function computePayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Idempotently claims (or fetches) the durable submission-intent row for a
 * market+payload. Upserts on the (marketId, payloadHash) unique constraint
 * so every attempt for the same logical submission reuses one row instead
 * of inserting a fresh "intent" row per retry.
 */
export async function claimSubmissionIntent(
  prisma: PrismaClient,
  args: SubmissionIntentKey & {
    source: string;
    candidateResolution: boolean;
    createdAt: Date;
  }
): Promise<OracleReportRow> {
  return prisma.oracleReport.upsert({
    where: {
      marketId_payloadHash: {
        marketId: args.marketId,
        payloadHash: args.payloadHash,
      },
    },
    create: {
      marketId: args.marketId,
      payloadHash: args.payloadHash,
      source: args.source,
      confidence: 1.0,
      candidateResolution: args.candidateResolution,
      status: "PENDING",
      attempts: 0,
      createdAt: args.createdAt,
    },
    // Existing row (any status) is returned as-is — the caller inspects
    // status/txHash to decide whether to broadcast, reconcile, or skip.
    update: {},
  });
}

/**
 * Persists the broadcast tx hash immediately after sendTransaction returns
 * it — *before* polling for confirmation. This is the crash-safety
 * linchpin: once this write commits, a crash before confirmation leaves a
 * durable record that a specific tx is in flight, so a restart reconciles
 * against the chain instead of blindly building and sending a new one.
 */
export async function recordBroadcast(
  prisma: PrismaClient,
  args: SubmissionIntentKey & { txHash: string; attempts: number }
): Promise<OracleReportRow> {
  return prisma.oracleReport.update({
    where: {
      marketId_payloadHash: {
        marketId: args.marketId,
        payloadHash: args.payloadHash,
      },
    },
    data: {
      status: "SUBMITTED",
      txHash: args.txHash,
      attempts: args.attempts,
      broadcastAt: new Date(),
    },
  });
}

/** Marks the submission confirmed on-chain and records confirmation latency. */
export async function recordConfirmed(
  prisma: PrismaClient,
  args: SubmissionIntentKey & { txHash: string }
): Promise<OracleReportRow> {
  const row = await prisma.oracleReport.update({
    where: {
      marketId_payloadHash: {
        marketId: args.marketId,
        payloadHash: args.payloadHash,
      },
    },
    data: {
      status: "CONFIRMED",
      txHash: args.txHash,
      confidence: 1.0,
      confirmedAt: new Date(),
    },
  });

  if (row.broadcastAt) {
    oracleSubmissionConfirmationLatency.observe(
      Date.now() - row.broadcastAt.getTime()
    );
  }

  return row;
}

/**
 * Clears a submission's broadcast state back to PENDING so a fresh tx can be
 * built and sent. Only safe to call once non-inclusion is *definite* (the
 * previous tx's timebound has expired network-wide) — never on ambiguous
 * NOT_FOUND, which could still land.
 */
export async function resetForRetry(
  prisma: PrismaClient,
  args: SubmissionIntentKey & { attempts: number }
): Promise<OracleReportRow> {
  return prisma.oracleReport.update({
    where: {
      marketId_payloadHash: {
        marketId: args.marketId,
        payloadHash: args.payloadHash,
      },
    },
    data: {
      status: "PENDING",
      txHash: null,
      broadcastAt: null,
      attempts: args.attempts,
    },
  });
}

/** Marks the submission permanently failed (max retries exhausted). */
export async function recordFailed(
  prisma: PrismaClient,
  args: SubmissionIntentKey & { attempts: number }
): Promise<OracleReportRow> {
  return prisma.oracleReport.update({
    where: {
      marketId_payloadHash: {
        marketId: args.marketId,
        payloadHash: args.payloadHash,
      },
    },
    data: {
      status: "FAILED",
      candidateResolution: null,
      attempts: args.attempts,
    },
  });
}

export type ChainCheckResult = "CONFIRMED" | "FAILED" | "AMBIGUOUS";

/**
 * Checks a broadcast tx's on-chain status. Returns "AMBIGUOUS" for a
 * NOT_FOUND result until the tx's timebound has definitely expired — up to
 * that point the tx may simply not have propagated to this RPC node yet, or
 * may still be included in an upcoming ledger.
 */
export async function checkOnChainStatus(
  server: Pick<StellarRpc.Server, "getTransaction">,
  txHash: string,
  broadcastAt: Date | null
): Promise<ChainCheckResult> {
  const txStatus = await server.getTransaction(txHash);

  if (txStatus.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
    return "CONFIRMED";
  }
  if (txStatus.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
    return "FAILED";
  }

  // NOT_FOUND: only treat as definite non-inclusion once the tx's timebound
  // has certainly lapsed everywhere, not just on the node we happened to ask.
  if (
    broadcastAt &&
    Date.now() - broadcastAt.getTime() >
      TX_TIMEBOUND_SECONDS * 1000 + NON_INCLUSION_GRACE_MS
  ) {
    return "FAILED";
  }

  return "AMBIGUOUS";
}

/**
 * On worker startup, reconciles every submission left in the SUBMITTED
 * (broadcast, unconfirmed) state — e.g. because the previous process
 * crashed between broadcast and confirmation — against the chain, so
 * pending retries pick up an accurate status instead of resubmitting.
 */
export async function reconcileInFlightSubmissions(
  prisma: PrismaClient,
  server: Pick<StellarRpc.Server, "getTransaction"> | undefined,
  logger: ILogger
): Promise<{ confirmed: number; failed: number; ambiguous: number }> {
  const summary = { confirmed: 0, failed: 0, ambiguous: 0 };

  if (!server) {
    return summary;
  }

  const inFlight = await prisma.oracleReport.findMany({
    where: { status: "SUBMITTED", txHash: { not: null } },
  });

  logger.info("Reconciling in-flight oracle submissions", {
    count: inFlight.length,
  });

  for (const row of inFlight) {
    if (!row.txHash || !row.marketId) continue;

    const key = { marketId: row.marketId, payloadHash: row.payloadHash };

    try {
      const result = await checkOnChainStatus(
        server,
        row.txHash,
        row.broadcastAt
      );

      if (result === "CONFIRMED") {
        await recordConfirmed(prisma, { ...key, txHash: row.txHash });
        summary.confirmed++;
        logger.info("Reconciled oracle submission: confirmed on-chain", {
          ...key,
          txHash: row.txHash,
        });
      } else if (result === "FAILED") {
        await resetForRetry(prisma, { ...key, attempts: row.attempts });
        summary.failed++;
        logger.warn(
          "Reconciled oracle submission: definite non-inclusion, cleared for retry",
          { ...key, txHash: row.txHash }
        );
      } else {
        summary.ambiguous++;
        oracleSubmissionAmbiguousTotal.inc();
        logger.warn(
          "Oracle submission remains ambiguous after reconciliation — leaving in place",
          { ...key, txHash: row.txHash }
        );
      }
    } catch (error) {
      summary.ambiguous++;
      oracleSubmissionAmbiguousTotal.inc();
      logger.error("Failed to reconcile in-flight oracle submission", {
        ...key,
        txHash: row.txHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("Oracle submission reconciliation complete", summary);

  return summary;
}
