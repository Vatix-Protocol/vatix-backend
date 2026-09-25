import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import {
  processJob,
  type QueueJob,
  type QueueConsumerConfig,
} from "../consumers/queue-consumer.js";
import { logDeadLetter } from "../consumers/dead-letter.js";
import { withRetry } from "../../../oracle/retry-utils.js";
import {
  classifySettlementError,
  annotateError,
  isRetryable,
  shouldQuarantine,
  type SettlementErrorInfo,
  type SettlementErrorStatus,
} from "./error-codes.js";
import {
  settlementDuplicateSkippedTotal,
  settlementErrorQuarantinedTotal,
} from "../../../../src/services/metrics.js";

/** Retry config for individual Stellar RPC calls (getAccount, prepareTransaction,
 *  sendTransaction). Bounded and short-lived so a transient RPC blip is absorbed
 *  in place instead of burning one of the settlement job's limited queue retries. */
const STELLAR_RPC_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5_000,
};

/**
 * Zod schema used to validate the raw job payload before processing.
 * Any field that is missing, empty, or of the wrong type causes the job to be
 * classified as INVALID_PAYLOAD and dead-lettered immediately (non-retryable).
 */
const SettlementPayloadSchema = z.object({
  tradeId: z.string().min(1, "tradeId is required"),
  marketId: z.string().min(1, "marketId is required"),
  outcome: z.enum(["YES", "NO"], {
    errorMap: () => ({ message: "outcome must be YES or NO" }),
  }),
  buyOrderId: z.string().min(1, "buyOrderId is required"),
  sellOrderId: z.string().min(1, "sellOrderId is required"),
  buyerAddress: z.string().min(1, "buyerAddress is required"),
  sellerAddress: z.string().min(1, "sellerAddress is required"),
  price: z
    .string()
    .min(1, "price is required")
    .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, {
      message: "price must be a positive numeric string",
    }),
  quantity: z
    .string()
    .min(1, "quantity is required")
    .refine((v) => Number.isInteger(Number(v)) && Number(v) > 0, {
      message: "quantity must be a positive integer string",
    }),
  timestamp: z
    .string()
    .min(1, "timestamp is required")
    .refine((v) => Number.isFinite(Number(v)), {
      message: "timestamp must be a numeric string",
    }),
});

export interface SettlementJobPayload {
  tradeId: string;
  marketId: string;
  outcome: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerAddress: string;
  sellerAddress: string;
  price: string;
  quantity: string;
  timestamp: string;
}

export interface SettlementWorkerConfig {
  maxAttempts: number;
  processingTimeoutMs: number;
  idempotencyTtlSeconds: number;
  stellar?: SettlementStellarConfig;
  /**
   * Number of permanent (non-retryable) failures for the same tradeId before
   * the trade is quarantined and no longer reprocessed automatically (#870).
   * Defaults to 1 — a permanent error will not self-heal on retry, so a single
   * occurrence is generally sufficient, but this stays configurable so
   * repeated manual replays (via scripts/replay-dlq.ts) are also bounded.
   */
  quarantineThreshold?: number;
}

export interface SettlementStellarConfig {
  rpcUrl: string;
  rpcUrls?: string[];
  contractId: string;
  networkPassphrase: string;
  signerSecret: string;
}

export interface SettlementRedisClient {
  exists: (key: string) => Promise<boolean | number>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
  /**
   * Atomically set a key only if it does not already exist.
   * Returns true when the key was set, false when it already existed.
   */
  setnx: (key: string, value: string, ttl?: number) => Promise<boolean>;
  /** Delete a key. Used to release the idempotency lock after a failed
   *  attempt so a legitimate retry or replay can reprocess the trade (#870). */
  del: (key: string) => Promise<void>;
}

/** Row shape read/written by the settlement worker on the `trades` table. */
export interface SettlementTradeRow {
  tradeId: string;
  settlementStatus: "PENDING" | "SETTLED" | "QUARANTINED";
  settlementFailureCount: number;
  quarantinedAt: Date | null;
}

/**
 * Minimal Prisma surface the settlement worker needs to apply settlement
 * mutations transactionally and record poison-pill quarantine state (#870).
 * Kept narrow (rather than depending on the full generated PrismaClient type)
 * so unit tests can inject a lightweight mock, mirroring SettlementRedisClient.
 */
export interface SettlementPrismaClient {
  trade: {
    findUnique(args: {
      where: { tradeId: string };
    }): Promise<SettlementTradeRow | null>;
    update(args: {
      where: { tradeId: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
  $transaction<T>(fn: (tx: SettlementPrismaClient) => Promise<T>): Promise<T>;
}

export class SettlementWorker {
  private readonly consumerConfig: QueueConsumerConfig;
  private readonly idempotencyTtlSeconds: number;
  private readonly logger: ILogger;
  private readonly redisClient: SettlementRedisClient;
  private readonly stellarConfig?: SettlementStellarConfig;
  private readonly prisma?: SettlementPrismaClient;
  private readonly quarantineThreshold: number;
  private readonly retryClassificationCounts: Record<
    SettlementErrorStatus,
    number
  > = {
    transient: 0,
    fatal: 0,
    invalid_input: 0,
  };

  constructor(
    redisClient: SettlementRedisClient,
    logger: ILogger,
    config: SettlementWorkerConfig,
    prisma?: SettlementPrismaClient
  ) {
    this.redisClient = redisClient;
    this.logger = logger;
    this.idempotencyTtlSeconds = config.idempotencyTtlSeconds;
    this.stellarConfig = config.stellar;
    this.prisma = prisma;
    this.quarantineThreshold = config.quarantineThreshold ?? 1;
    this.consumerConfig = {
      queueName: "settlement",
      maxAttempts: config.maxAttempts,
      processingTimeoutMs: config.processingTimeoutMs,
    };
  }

  /** Snapshot of failures classified so far, grouped by retry disposition (#870). */
  getRetryClassificationCounts(): Readonly<
    Record<SettlementErrorStatus, number>
  > {
    return { ...this.retryClassificationCounts };
  }

  /** Count of trades currently held in quarantine, for operator dashboards (#870). */
  async getQuarantineDepth(): Promise<number> {
    if (!this.prisma) return 0;
    return this.prisma.trade.count({
      where: { settlementStatus: "QUARANTINED" },
    });
  }

  async process(job: QueueJob): Promise<void> {
    try {
      await processJob(this.logger, this.consumerConfig, job, (j) =>
        this.handleJob(j)
      );
    } catch (error) {
      const tradeId = this.extractTradeId(job);
      const errorInfo = classifySettlementError(error);
      const annotated = annotateError(error, errorInfo);
      const permanent = !isRetryable(errorInfo);

      this.retryClassificationCounts[errorInfo.status]++;

      if (shouldQuarantine(errorInfo)) {
        // e.g. INVALID_SIGNATURE / STELLAR_TX_BAD_AUTH — retrying these
        // forever would just burn RPC quota re-deriving the same rejection.
        settlementErrorQuarantinedTotal.inc({ code: errorInfo.code });
      }

      this.logger.info("Settlement job error classified", {
        jobId: job.id,
        tradeId,
        errorCode: errorInfo.code,
        errorStatus: errorInfo.status,
        reason: errorInfo.message,
        attempt: job.attempts,
        maxAttempts: this.consumerConfig.maxAttempts,
      });

      // Release the idempotency lock so a legitimate retry (BullMQ redelivery)
      // or a manual replay (scripts/replay-dlq.ts) can actually reprocess the
      // trade instead of silently no-op'ing as "already processed" — the lock
      // is only meant to mark completed work, not in-flight attempts (#870).
      if (tradeId) {
        await this.releaseIdempotencyLock(tradeId);
      }

      let quarantined = false;
      if (tradeId && permanent) {
        quarantined = await this.recordPermanentFailure(tradeId, errorInfo);
      }

      // Permanent errors are dead-lettered on first occurrence (they will not
      // self-heal on retry); transient errors only once retries are exhausted.
      if (permanent || job.attempts >= this.consumerConfig.maxAttempts) {
        await logDeadLetter(this.logger, {
          id: job.id,
          queue: this.consumerConfig.queueName,
          payload: job.payload,
          reason: errorInfo.message,
          errorCode: errorInfo.code,
          classification: errorInfo.status,
        });
      }

      if (permanent) {
        this.logger.warn("Settlement job failed permanently, not retrying", {
          jobId: job.id,
          tradeId,
          errorCode: errorInfo.code,
          quarantined,
        });
        // UnrecoverableError tells BullMQ to stop retrying immediately,
        // regardless of `attempts`, so a poison pill fails fast instead of
        // occupying the single processing slot through the full backoff
        // schedule and delaying unrelated jobs behind it (#870).
        const unrecoverable = new UnrecoverableError(annotated.message);
        Object.assign(unrecoverable, {
          settlementErrorCode: errorInfo.code,
          settlementErrorStatus: errorInfo.status,
          settlementErrorRetryable: false,
        });
        throw unrecoverable;
      }

      throw annotated;
    }
  }

  private async handleJob(job: QueueJob): Promise<void> {
    // Validate the raw payload before touching any external resources.
    // An invalid payload is a non-retryable client error — fail fast so the job
    // is dead-lettered immediately rather than burning retry quota.
    const parseResult = SettlementPayloadSchema.safeParse(job.payload);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`invalid payload — ${issues}`);
    }

    const payload = parseResult.data as SettlementJobPayload;
    const { tradeId } = payload;

    // Poison-pill quarantine gate (#870): a previously quarantined trade is
    // held aside for manual review — skip it without re-running Stellar RPC
    // calls or blocking the (single-concurrency) worker on newer jobs for
    // other trades/markets.
    if (this.prisma) {
      const existing = await this.prisma.trade.findUnique({
        where: { tradeId },
      });
      if (existing?.settlementStatus === "QUARANTINED") {
        this.logger.warn("Settlement job skipped (trade quarantined)", {
          tradeId,
          jobId: job.id,
          quarantinedAt: existing.quarantinedAt,
        });
        return;
      }
    }

    const idempotencyKey = `settlement:processed:${tradeId}`;

    // Atomically claim the idempotency lock via SET NX.
    // This prevents double-settlement when two workers race on the same tradeId.
    const claimed = await this.redisClient.setnx(
      idempotencyKey,
      "1",
      this.idempotencyTtlSeconds
    );

    if (!claimed) {
      settlementDuplicateSkippedTotal.inc();
      this.logger.info("Settlement job skipped (already processed)", {
        tradeId,
        jobId: job.id,
      });
      return;
    }

    this.logger.info("Processing settlement job", {
      tradeId,
      marketId: payload.marketId,
      buyOrderId: payload.buyOrderId,
      sellOrderId: payload.sellOrderId,
      price: payload.price,
      quantity: payload.quantity,
    });

    let txHash: string | null = null;
    if (this.stellarConfig) {
      txHash = await this.executeOnChain(payload);
    } else {
      this.logger.warn(
        "No Stellar config provided — settlement recorded off-chain only",
        { tradeId, marketId: payload.marketId }
      );
    }

    // Apply the settlement outcome for this tradeId atomically (#870). A
    // failure here rolls back the whole transaction — no observable
    // half-applied settlement — and re-throws so the job is retried/
    // classified by the normal error path in process().
    await this.applySettlement(tradeId, txHash);

    this.logger.info("Settlement job completed", {
      tradeId,
      marketId: payload.marketId,
    });
  }

  /**
   * Atomically applies the settlement outcome for a tradeId (#870). Reads the
   * trade row and writes its terminal settlement state as a single Prisma
   * transaction so a mid-transaction failure leaves no partial update.
   * A no-op (transactionally safe) when no Prisma client was configured, so
   * callers that only need on-chain settlement continue to work unchanged.
   */
  private async applySettlement(
    tradeId: string,
    txHash: string | null
  ): Promise<void> {
    if (!this.prisma) return;

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.trade.findUnique({ where: { tradeId } });

      if (!existing) {
        this.logger.warn("Settlement apply skipped — trade row not found", {
          tradeId,
        });
        return;
      }

      if (existing.settlementStatus === "SETTLED") {
        // Already applied by a prior attempt (e.g. process crashed after
        // commit but before the job was acknowledged) — idempotent no-op.
        return;
      }

      await tx.trade.update({
        where: { tradeId },
        data: {
          settlementStatus: "SETTLED",
          settledAt: new Date(),
          settlementTxHash: txHash,
          settlementErrorCode: null,
          settlementFailureCount: 0,
          quarantinedAt: null,
        },
      });
    });
  }

  /**
   * Records a permanent (non-retryable) failure against the trade row and
   * quarantines it once `quarantineThreshold` such failures have accumulated
   * (#870). Runs as a single Prisma transaction (read-then-write) so the
   * failure count and quarantine flag never diverge under concurrent writers.
   * Returns whether this call caused the trade to become quarantined.
   */
  private async recordPermanentFailure(
    tradeId: string,
    errorInfo: SettlementErrorInfo
  ): Promise<boolean> {
    if (!this.prisma) return false;

    let quarantined = false;

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.trade.findUnique({ where: { tradeId } });

      // Nothing to quarantine — either the trade doesn't exist yet, or it
      // already settled successfully (this failure was a late/duplicate
      // delivery racing a successful attempt).
      if (!existing || existing.settlementStatus === "SETTLED") return;

      const failureCount = existing.settlementFailureCount + 1;
      quarantined = failureCount >= this.quarantineThreshold;

      await tx.trade.update({
        where: { tradeId },
        data: {
          settlementFailureCount: failureCount,
          settlementErrorCode: errorInfo.code,
          settlementStatus: quarantined
            ? "QUARANTINED"
            : existing.settlementStatus,
          quarantinedAt: quarantined ? new Date() : existing.quarantinedAt,
        },
      });
    });

    return quarantined;
  }

  /** Best-effort release of the idempotency lock; never throws (#870). */
  private async releaseIdempotencyLock(tradeId: string): Promise<void> {
    try {
      await this.redisClient.del(`settlement:processed:${tradeId}`);
    } catch (error) {
      this.logger.warn("Failed to release settlement idempotency lock", {
        tradeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Safely extracts tradeId from a job payload of unknown shape. */
  private extractTradeId(job: QueueJob): string | undefined {
    const value = (job.payload as Record<string, unknown> | undefined)?.tradeId;
    return typeof value === "string" ? value : undefined;
  }

  private async executeOnChain(payload: SettlementJobPayload): Promise<string> {
    const { rpcUrl, contractId, networkPassphrase, signerSecret } =
      this.stellarConfig!;

    const keypair = Keypair.fromSecret(signerSecret);
    const server = new StellarRpc.Server(rpcUrl);
    const contract = new Contract(contractId);

    const onRpcRetry = (error: Error, attempt: number, delayMs: number) => {
      this.logger.warn("Retrying Stellar RPC call for settle_trade", {
        tradeId: payload.tradeId,
        attempt,
        delayMs,
        error: error.message,
      });
    };

    const sourceAccount = await withRetry(
      () => server.getAccount(keypair.publicKey()),
      STELLAR_RPC_RETRY_CONFIG,
      onRpcRetry
    );

    const outcomeScVal = nativeToScVal(payload.outcome === "YES", {
      type: "bool",
    });
    const args: xdr.ScVal[] = [
      nativeToScVal(payload.tradeId, { type: "string" }),
      nativeToScVal(payload.marketId, { type: "string" }),
      outcomeScVal,
      nativeToScVal(payload.buyerAddress, { type: "address" }),
      nativeToScVal(payload.sellerAddress, { type: "address" }),
      nativeToScVal(BigInt(Math.round(Number(payload.price) * 1e7)), {
        type: "i128",
      }),
      nativeToScVal(BigInt(payload.quantity), { type: "i128" }),
    ];

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase,
    })
      .addOperation(contract.call("settle_trade", ...args))
      .setTimeout(30)
      .build();

    const preparedTx = await withRetry(
      () => server.prepareTransaction(tx),
      STELLAR_RPC_RETRY_CONFIG,
      onRpcRetry
    );
    preparedTx.sign(keypair);

    const sendResult = await withRetry(
      () => server.sendTransaction(preparedTx),
      STELLAR_RPC_RETRY_CONFIG,
      onRpcRetry
    );

    if (sendResult.status === "ERROR") {
      throw new Error(
        `settle_trade submission failed: status=ERROR hash=${sendResult.hash}`
      );
    }

    this.logger.info("settle_trade submitted, awaiting confirmation", {
      tradeId: payload.tradeId,
      hash: sendResult.hash,
    });

    // Poll until the transaction is confirmed or fails
    const MAX_POLL_ATTEMPTS = 30;
    const POLL_INTERVAL_MS = 1_000;
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const txStatus = await server.getTransaction(sendResult.hash);
      if (txStatus.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
        this.logger.info("settle_trade confirmed on-chain", {
          tradeId: payload.tradeId,
          hash: sendResult.hash,
          ledger: txStatus.ledger,
        });
        return sendResult.hash;
      }
      if (txStatus.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(
          `settle_trade transaction failed on-chain: hash=${sendResult.hash}`
        );
      }
    }

    throw new Error(
      `settle_trade not confirmed after ${MAX_POLL_ATTEMPTS}s: hash=${sendResult.hash}`
    );
  }
}
