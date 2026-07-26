import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import {
  processJob,
  type QueueJob,
  type QueueConsumerConfig,
} from "../consumers/queue-consumer.js";
import { logDeadLetter } from "../consumers/dead-letter.js";
import { withRetry } from "../../../oracle/retry-utils.js";
import { classifySettlementError, annotateError } from "./error-codes.js";

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
}

export interface SettlementStellarConfig {
  rpcUrl: string;
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
}

export class SettlementWorker {
  private readonly consumerConfig: QueueConsumerConfig;
  private readonly idempotencyTtlSeconds: number;
  private readonly logger: ILogger;
  private readonly redisClient: SettlementRedisClient;
  private readonly stellarConfig?: SettlementStellarConfig;

  constructor(
    redisClient: SettlementRedisClient,
    logger: ILogger,
    config: SettlementWorkerConfig
  ) {
    this.redisClient = redisClient;
    this.logger = logger;
    this.idempotencyTtlSeconds = config.idempotencyTtlSeconds;
    this.stellarConfig = config.stellar;
    this.consumerConfig = {
      queueName: "settlement",
      maxAttempts: config.maxAttempts,
      processingTimeoutMs: config.processingTimeoutMs,
    };
  }

  async process(job: QueueJob): Promise<void> {
    try {
      await processJob(this.logger, this.consumerConfig, job, (j) =>
        this.handleJob(j)
      );
    } catch (error) {
      const errorInfo = classifySettlementError(error);
      const annotated = annotateError(error, errorInfo);

      this.logger.info("Settlement job error classified", {
        jobId: job.id,
        tradeId: (job.payload as Record<string, unknown>)?.tradeId,
        errorCode: errorInfo.code,
        errorStatus: errorInfo.status,
        reason: errorInfo.message,
        attempt: job.attempts,
        maxAttempts: this.consumerConfig.maxAttempts,
      });

      if (job.attempts >= this.consumerConfig.maxAttempts) {
        await logDeadLetter(this.logger, {
          id: job.id,
          queue: this.consumerConfig.queueName,
          payload: job.payload,
          reason: errorInfo.message,
        });
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

    const idempotencyKey = `settlement:processed:${tradeId}`;

    // Atomically claim the idempotency lock via SET NX.
    // This prevents double-settlement when two workers race on the same tradeId.
    const claimed = await this.redisClient.setnx(
      idempotencyKey,
      "1",
      this.idempotencyTtlSeconds
    );

    if (!claimed) {
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

    if (this.stellarConfig) {
      await this.executeOnChain(payload);
    } else {
      this.logger.warn(
        "No Stellar config provided — settlement recorded off-chain only",
        { tradeId, marketId: payload.marketId }
      );
    }

    this.logger.info("Settlement job completed", {
      tradeId,
      marketId: payload.marketId,
    });
  }

  private async executeOnChain(payload: SettlementJobPayload): Promise<void> {
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
        return;
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
