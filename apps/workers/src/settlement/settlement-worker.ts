import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import {
  processJob,
  type QueueJob,
  type QueueConsumerConfig,
} from "../consumers/queue-consumer.js";
import { logDeadLetter } from "../consumers/dead-letter.js";

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
      if (job.attempts >= this.consumerConfig.maxAttempts) {
        await logDeadLetter(this.logger, {
          id: job.id,
          queue: this.consumerConfig.queueName,
          payload: job.payload,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private async handleJob(job: QueueJob): Promise<void> {
    const payload = job.payload as unknown as SettlementJobPayload;
    const { tradeId } = payload;

    const idempotencyKey = `settlement:processed:${tradeId}`;
    const alreadyProcessed = await this.redisClient.exists(idempotencyKey);

    if (alreadyProcessed) {
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

    await this.redisClient.set(idempotencyKey, "1", this.idempotencyTtlSeconds);

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

    const sourceAccount = await server.getAccount(keypair.publicKey());

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

    const preparedTx = await server.prepareTransaction(tx);
    preparedTx.sign(keypair);

    const sendResult = await server.sendTransaction(preparedTx);

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
      if (
        txStatus.status === StellarRpc.Api.GetTransactionStatus.SUCCESS
      ) {
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
