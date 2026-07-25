import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SettlementWorker,
  type SettlementWorkerConfig,
  type SettlementRedisClient,
  type SettlementStellarConfig,
} from "./settlement-worker.js";
import type { QueueJob } from "../consumers/queue-consumer.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

// ---------------------------------------------------------------------------
// Stellar SDK mock — variables hoisted via vi.hoisted so they are accessible
// inside the vi.mock() factory (which Vitest also hoists to the top).
// ---------------------------------------------------------------------------
const {
  mockContractCall,
  mockContractCtor,
  mockKeypairPublicKey,
  mockKeypairFromSecret,
  mockTxSign,
  mockTxBuilderBuild,
  mockTxBuilderSetTimeout,
  mockTxBuilderAddOp,
  mockTransactionBuilderCtor,
  mockGetAccount,
  mockPrepareTransaction,
  mockSendTransaction,
  mockGetTransaction,
  mockRpcServerCtor,
} = vi.hoisted(() => {
  // Leaf mock functions — referenced by class instances below.
  const mockContractCall = vi.fn().mockReturnValue("mock-operation");
  const mockKeypairPublicKey = vi
    .fn()
    .mockReturnValue(
      "GSIGNER1111111111111111111111111111111111111111111111111"
    );
  const mockKeypairFromSecret = vi.fn().mockReturnValue({
    publicKey: mockKeypairPublicKey,
  });
  const mockTxSign = vi.fn();
  const mockTxBuilderBuild = vi.fn();
  const mockTxBuilderSetTimeout = vi.fn();
  const mockTxBuilderAddOp = vi.fn();
  const mockGetAccount = vi.fn().mockResolvedValue({ id: "mock-account" });
  const mockPrepareTransaction = vi
    .fn()
    .mockImplementation((tx: unknown) => Promise.resolve(tx));
  const mockSendTransaction = vi.fn().mockResolvedValue({
    status: "PENDING",
    hash: "abc123txhash",
  });
  const mockGetTransaction = vi.fn().mockResolvedValue({
    status: "SUCCESS",
    ledger: 1000,
  });

  // Vitest 4.x: use `class` keyword inside mockImplementation for constructors.
  const mockContractCtor = vi.fn().mockImplementation(
    class {
      call = mockContractCall;
    }
  );

  const mockTransactionBuilderCtor = vi.fn().mockImplementation(
    class {
      addOperation = mockTxBuilderAddOp.mockReturnThis();
      setTimeout = mockTxBuilderSetTimeout.mockReturnThis();
      build = mockTxBuilderBuild.mockReturnValue({ sign: mockTxSign });
    }
  );

  const mockRpcServerCtor = vi.fn().mockImplementation(
    class {
      getAccount = mockGetAccount;
      prepareTransaction = mockPrepareTransaction;
      sendTransaction = mockSendTransaction;
      getTransaction = mockGetTransaction;
    }
  );

  return {
    mockContractCall,
    mockContractCtor,
    mockKeypairPublicKey,
    mockKeypairFromSecret,
    mockTxSign,
    mockTxBuilderBuild,
    mockTxBuilderSetTimeout,
    mockTxBuilderAddOp,
    mockTransactionBuilderCtor,
    mockGetAccount,
    mockPrepareTransaction,
    mockSendTransaction,
    mockGetTransaction,
    mockRpcServerCtor,
  };
});

vi.mock("@stellar/stellar-sdk", () => ({
  Contract: mockContractCtor,
  Keypair: { fromSecret: mockKeypairFromSecret },
  TransactionBuilder: mockTransactionBuilderCtor,
  nativeToScVal: vi.fn().mockReturnValue("mock-scval"),
  rpc: {
    Server: mockRpcServerCtor,
    Api: {
      GetTransactionStatus: { SUCCESS: "SUCCESS", FAILED: "FAILED" },
    },
  },
  xdr: {},
}));

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function makeRedisClient(
  overrides?: Partial<SettlementRedisClient>
): SettlementRedisClient {
  return {
    exists: vi.fn().mockResolvedValue(false),
    set: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<SettlementWorkerConfig>
): SettlementWorkerConfig {
  return {
    maxAttempts: 3,
    processingTimeoutMs: 5_000,
    idempotencyTtlSeconds: 86_400,
    ...overrides,
  };
}

function makeJob(overrides?: Partial<QueueJob>): QueueJob {
  return {
    id: "stream-id-1-0",
    payload: {
      tradeId: "trade-abc-123",
      marketId: "market-001",
      outcome: "YES",
      buyOrderId: "buy-order-1",
      sellOrderId: "sell-order-1",
      buyerAddress: "GBUYERADDRESS",
      sellerAddress: "GSELLERADDRESS",
      price: "0.65",
      quantity: "100",
      timestamp: "1700000000000",
    },
    attempts: 1,
    ...overrides,
  };
}

describe("SettlementWorker", () => {
  let logger: ILogger;
  let redisClient: SettlementRedisClient;
  let worker: SettlementWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = makeLogger();
    redisClient = makeRedisClient();
    worker = new SettlementWorker(redisClient, logger, makeConfig());
  });

  describe("process — success path", () => {
    it("logs job receipt and completion for a new trade", async () => {
      const job = makeJob();

      await worker.process(job);

      expect(logger.info).toHaveBeenCalledWith(
        "Job received from queue",
        expect.objectContaining({
          jobId: job.id,
          queue: "settlement",
          attempt: 1,
        })
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Processing settlement job",
        expect.objectContaining({ tradeId: "trade-abc-123" })
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Settlement job completed",
        expect.objectContaining({ tradeId: "trade-abc-123" })
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Job processed successfully",
        expect.objectContaining({ jobId: job.id })
      );
    });

    it("writes the idempotency key to Redis on success", async () => {
      const job = makeJob();

      await worker.process(job);

      expect(redisClient.set).toHaveBeenCalledWith(
        "settlement:processed:trade-abc-123",
        "1",
        86_400
      );
    });
  });

  describe("process — idempotency", () => {
    it("skips processing when trade was already processed", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockResolvedValue(true),
      });
      worker = new SettlementWorker(redisClient, logger, makeConfig());

      const job = makeJob();

      await worker.process(job);

      expect(logger.info).toHaveBeenCalledWith(
        "Settlement job skipped (already processed)",
        expect.objectContaining({ tradeId: "trade-abc-123", jobId: job.id })
      );
      expect(redisClient.set).not.toHaveBeenCalled();
    });

    it("checks the correct idempotency key", async () => {
      const job = makeJob({
        payload: { ...makeJob().payload, tradeId: "trade-xyz-999" },
      });

      await worker.process(job);

      expect(redisClient.exists).toHaveBeenCalledWith(
        "settlement:processed:trade-xyz-999"
      );
    });
  });

  describe("process — failure path", () => {
    it("re-throws the error when handler fails below max attempts", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockRejectedValue(new Error("Redis down")),
      });
      worker = new SettlementWorker(
        redisClient,
        logger,
        makeConfig({ maxAttempts: 3 })
      );

      const job = makeJob({ attempts: 1 });

      await expect(worker.process(job)).rejects.toThrow("Redis down");
    });

    it("logs warn (not error) when attempts remain", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockRejectedValue(new Error("transient")),
      });
      worker = new SettlementWorker(
        redisClient,
        logger,
        makeConfig({ maxAttempts: 3 })
      );

      const job = makeJob({ attempts: 1 });

      await expect(worker.process(job)).rejects.toThrow();

      expect(logger.warn).toHaveBeenCalledWith(
        "Job processing failed, will retry",
        expect.objectContaining({ jobId: job.id, attempt: 1 })
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("dead-letters and logs error after max attempts", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockRejectedValue(new Error("permanent failure")),
      });
      worker = new SettlementWorker(
        redisClient,
        logger,
        makeConfig({ maxAttempts: 3 })
      );

      const job = makeJob({ attempts: 3 });

      await expect(worker.process(job)).rejects.toThrow("permanent failure");

      expect(logger.error).toHaveBeenCalledWith(
        "Job processing failed, max attempts exceeded",
        expect.objectContaining({ jobId: job.id, attempt: 3, maxAttempts: 3 })
      );
      expect(logger.error).toHaveBeenCalledWith(
        "Job dead-lettered",
        expect.objectContaining({
          messageId: job.id,
          queue: "settlement",
          reason: "permanent failure",
        })
      );
    });

    it("does not dead-letter when attempts are below max", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockRejectedValue(new Error("transient")),
      });
      worker = new SettlementWorker(
        redisClient,
        logger,
        makeConfig({ maxAttempts: 3 })
      );

      const job = makeJob({ attempts: 2 });

      await expect(worker.process(job)).rejects.toThrow();

      const deadLetterCalls = (
        logger.error as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => call[0] === "Job dead-lettered");
      expect(deadLetterCalls).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Stellar SDK invocation tests
// ---------------------------------------------------------------------------
describe("SettlementWorker — Stellar SDK invoke (executeOnChain)", () => {
  const stellarConfig: SettlementStellarConfig = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: "CCONTRACT11111111111111111111111111111111111111111111111111",
    networkPassphrase: "Test SDF Network ; September 2015",
    signerSecret: "SSECRET111111111111111111111111111111111111111111111111111",
  };

  let logger: ILogger;
  let redisClient: SettlementRedisClient;
  let stellarWorker: SettlementWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Reset mocks to their default resolved values
    mockGetAccount.mockResolvedValue({ id: "mock-account" });
    mockPrepareTransaction.mockImplementation((tx) => Promise.resolve(tx));
    mockSendTransaction.mockResolvedValue({
      status: "PENDING",
      hash: "abc123txhash",
    });
    mockGetTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 1000 });

    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    redisClient = {
      exists: vi.fn().mockResolvedValue(false),
      set: vi.fn().mockResolvedValue(undefined),
    };
    stellarWorker = new SettlementWorker(redisClient, logger, {
      maxAttempts: 3,
      processingTimeoutMs: 5_000,
      idempotencyTtlSeconds: 86_400,
      stellar: stellarConfig,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes Contract.call('settle_trade') with correct arguments", async () => {
    const job: QueueJob = {
      id: "job-stellar-1",
      attempts: 1,
      payload: {
        tradeId: "trade-on-chain-001",
        marketId: "market-001",
        outcome: "YES",
        buyOrderId: "buy-1",
        sellOrderId: "sell-1",
        buyerAddress: "GBUYER111111111111111111111111111111111111111111111111",
        sellerAddress: "GSELLER11111111111111111111111111111111111111111111111",
        price: "0.65",
        quantity: "100",
        timestamp: "1700000000000",
      },
    };

    const processPromise = stellarWorker.process(job);
    await vi.runAllTimersAsync();
    await processPromise;

    expect(mockContractCall).toHaveBeenCalledWith(
      "settle_trade",
      expect.anything(), // tradeId ScVal
      expect.anything(), // marketId ScVal
      expect.anything(), // outcome ScVal
      expect.anything(), // buyerAddress ScVal
      expect.anything(), // sellerAddress ScVal
      expect.anything(), // price ScVal
      expect.anything() // quantity ScVal
    );
  });

  it("builds, signs, and submits the transaction", async () => {
    const job: QueueJob = {
      id: "job-stellar-2",
      attempts: 1,
      payload: {
        tradeId: "trade-on-chain-002",
        marketId: "market-002",
        outcome: "NO",
        buyOrderId: "buy-2",
        sellOrderId: "sell-2",
        buyerAddress: "GBUYER111111111111111111111111111111111111111111111111",
        sellerAddress: "GSELLER11111111111111111111111111111111111111111111111",
        price: "0.30",
        quantity: "50",
        timestamp: "1700000001000",
      },
    };

    const processPromise = stellarWorker.process(job);
    await vi.runAllTimersAsync();
    await processPromise;

    expect(mockGetAccount).toHaveBeenCalled();
    expect(mockPrepareTransaction).toHaveBeenCalled();
    expect(mockTxSign).toHaveBeenCalled();
    expect(mockSendTransaction).toHaveBeenCalled();
  });

  it("logs settlement confirmed after successful on-chain confirmation", async () => {
    const job: QueueJob = {
      id: "job-stellar-3",
      attempts: 1,
      payload: {
        tradeId: "trade-on-chain-003",
        marketId: "market-003",
        outcome: "YES",
        buyOrderId: "buy-3",
        sellOrderId: "sell-3",
        buyerAddress: "GBUYER111111111111111111111111111111111111111111111111",
        sellerAddress: "GSELLER11111111111111111111111111111111111111111111111",
        price: "0.50",
        quantity: "200",
        timestamp: "1700000002000",
      },
    };

    const processPromise = stellarWorker.process(job);
    await vi.runAllTimersAsync();
    await processPromise;

    expect(logger.info).toHaveBeenCalledWith(
      "settle_trade confirmed on-chain",
      expect.objectContaining({
        tradeId: "trade-on-chain-003",
        hash: "abc123txhash",
      })
    );
  });

  it("throws when sendTransaction returns ERROR status", async () => {
    mockSendTransaction.mockResolvedValue({
      status: "ERROR",
      hash: "errored-hash",
    });

    const job: QueueJob = {
      id: "job-stellar-err",
      attempts: 1,
      payload: {
        tradeId: "trade-err-001",
        marketId: "market-001",
        outcome: "YES",
        buyOrderId: "buy-e",
        sellOrderId: "sell-e",
        buyerAddress: "GBUYER111111111111111111111111111111111111111111111111",
        sellerAddress: "GSELLER11111111111111111111111111111111111111111111111",
        price: "0.50",
        quantity: "10",
        timestamp: "1700000003000",
      },
    };

    await expect(stellarWorker.process(job)).rejects.toThrow(
      "settle_trade submission failed"
    );
  });

  it("throws when transaction is confirmed as FAILED on-chain", async () => {
    mockGetTransaction.mockResolvedValue({ status: "FAILED" });

    const job: QueueJob = {
      id: "job-stellar-fail",
      attempts: 1,
      payload: {
        tradeId: "trade-fail-001",
        marketId: "market-001",
        outcome: "YES",
        buyOrderId: "buy-f",
        sellOrderId: "sell-f",
        buyerAddress: "GBUYER111111111111111111111111111111111111111111111111",
        sellerAddress: "GSELLER11111111111111111111111111111111111111111111111",
        price: "0.50",
        quantity: "10",
        timestamp: "1700000004000",
      },
    };

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection.
    const processPromise = stellarWorker.process(job);
    const expectation = expect(processPromise).rejects.toThrow(
      "settle_trade transaction failed on-chain"
    );
    await vi.runAllTimersAsync();
    await expectation;
  });
});
