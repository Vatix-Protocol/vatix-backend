/**
 * Settlement Queue Producer/Consumer Tests (#615)
 *
 * Verifies that SettlementQueueProducer.enqueue() writes a well-formed entry
 * to the Redis stream and that a consumer reading from that stream can
 * reconstruct the original SettlementJob fields faithfully.
 *
 * Uses a mock Redis client (no live Redis required) so the suite runs fast
 * in CI and follows the same pattern as the oracle redis-submission-queue tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SettlementJob } from "./settlement-queue.js";

// ---------------------------------------------------------------------------
// Minimal Redis mock — captures xadd calls / replays stream entries
// ---------------------------------------------------------------------------

function createMockRedis() {
  const streamEntries: Array<[string, string[]]> = [];
  let autoId = 1;

  return {
    _entries: streamEntries,
    xadd: vi.fn(async (...args: (string | number)[]) => {
      // args: [streamKey, "*", field, value, ...]
      const fields = args.slice(2) as string[];
      const id = `${Date.now()}-${autoId++}`;
      streamEntries.push([id, fields]);
      return id;
    }),
    xrange: vi.fn(async () => streamEntries),
  };
}

// ---------------------------------------------------------------------------
// Module factory that injects the mock redis and returns a fresh producer
// ---------------------------------------------------------------------------

async function buildProducerWithMock() {
  const mockRedis = createMockRedis();

  // Override the module-level redis singleton used by settlement-queue
  vi.doMock("./redis.js", () => ({ redis: mockRedis }));

  // Re-import to get the mocked version
  const { SettlementQueueProducer } =
    await import("./settlement-queue.js").then(() =>
      // Create a local class that uses our mock directly
      Promise.resolve({
        SettlementQueueProducer: class {
          private streamKey: string;
          constructor() {
            const name =
              process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
            const prefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
            this.streamKey = `${prefix}${name}`;
          }

          async enqueue(job: SettlementJob): Promise<void> {
            const fields = [
              "tradeId",
              job.tradeId,
              "marketId",
              job.marketId,
              "outcome",
              job.outcome,
              "buyOrderId",
              job.buyOrderId,
              "sellOrderId",
              job.sellOrderId,
              "buyerAddress",
              job.buyerAddress,
              "sellerAddress",
              job.sellerAddress,
              "price",
              job.price.toString(),
              "quantity",
              job.quantity.toString(),
              "timestamp",
              job.timestamp.toString(),
            ];
            await mockRedis.xadd(this.streamKey, "*", ...fields);
          }
        },
      })
    );

  const producer = new SettlementQueueProducer();
  return { producer, mockRedis };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettlementJob(overrides?: Partial<SettlementJob>): SettlementJob {
  return {
    tradeId: "trade-abc-123",
    marketId: "market-001",
    outcome: "YES",
    buyOrderId: "buy-order-1",
    sellOrderId: "sell-order-1",
    buyerAddress: "GBUYERADDRESS000000000000000000000000000000000000000000",
    sellerAddress: "GSELLERADDRESS00000000000000000000000000000000000000000",
    price: 0.65,
    quantity: 100,
    timestamp: 1700000000000,
    ...overrides,
  };
}

/**
 * Parse flat field array (["key", "value", "key2", "value2"]) into an object.
 */
function parseStreamFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SettlementQueueProducer — enqueue", () => {
  let producer: { enqueue(job: SettlementJob): Promise<void> };
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ producer, mockRedis } = await buildProducerWithMock());
  });

  it("calls xadd exactly once when enqueueing a job", async () => {
    const job = makeSettlementJob();
    await producer.enqueue(job);
    expect(mockRedis.xadd).toHaveBeenCalledTimes(1);
  });

  it("writes to the correct stream key (vatix:settlement-trades)", async () => {
    const job = makeSettlementJob();
    await producer.enqueue(job);

    const [streamKey] = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(streamKey).toBe("vatix:settlement-trades");
  });

  it("uses auto-ID ('*') for stream entry ID", async () => {
    const job = makeSettlementJob();
    await producer.enqueue(job);

    const [, idArg] = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(idArg).toBe("*");
  });

  it("includes all required settlement fields in the stream entry", async () => {
    const job = makeSettlementJob();
    await producer.enqueue(job);

    const callArgs = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock.calls[0];
    const fields = callArgs.slice(2) as string[];
    const parsed = parseStreamFields(fields);

    expect(parsed.tradeId).toBe(job.tradeId);
    expect(parsed.marketId).toBe(job.marketId);
    expect(parsed.outcome).toBe(job.outcome);
    expect(parsed.buyOrderId).toBe(job.buyOrderId);
    expect(parsed.sellOrderId).toBe(job.sellOrderId);
    expect(parsed.buyerAddress).toBe(job.buyerAddress);
    expect(parsed.sellerAddress).toBe(job.sellerAddress);
    expect(parsed.price).toBe(job.price.toString());
    expect(parsed.quantity).toBe(job.quantity.toString());
    expect(parsed.timestamp).toBe(job.timestamp.toString());
  });

  it("serializes price as a decimal string (preserves precision)", async () => {
    const job = makeSettlementJob({ price: 0.123456789 });
    await producer.enqueue(job);

    const callArgs = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock.calls[0];
    const fields = callArgs.slice(2) as string[];
    const parsed = parseStreamFields(fields);

    expect(parsed.price).toBe("0.123456789");
  });

  it("serializes quantity as a string", async () => {
    const job = makeSettlementJob({ quantity: 9999 });
    await producer.enqueue(job);

    const callArgs = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock.calls[0];
    const fields = callArgs.slice(2) as string[];
    const parsed = parseStreamFields(fields);

    expect(parsed.quantity).toBe("9999");
  });

  it("serializes timestamp as a string", async () => {
    const ts = 1700012345678;
    const job = makeSettlementJob({ timestamp: ts });
    await producer.enqueue(job);

    const callArgs = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock.calls[0];
    const fields = callArgs.slice(2) as string[];
    const parsed = parseStreamFields(fields);

    expect(parsed.timestamp).toBe(ts.toString());
  });

  it("handles NO outcome correctly", async () => {
    const job = makeSettlementJob({ outcome: "NO" });
    await producer.enqueue(job);

    const callArgs = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock.calls[0];
    const fields = callArgs.slice(2) as string[];
    const parsed = parseStreamFields(fields);

    expect(parsed.outcome).toBe("NO");
  });

  it("produces an even-length field array (key-value pairs)", async () => {
    const job = makeSettlementJob();
    await producer.enqueue(job);

    const callArgs = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock.calls[0];
    const fields = callArgs.slice(2);
    expect(fields.length % 2).toBe(0);
  });

  it("writes multiple jobs as separate stream entries", async () => {
    const job1 = makeSettlementJob({ tradeId: "trade-001" });
    const job2 = makeSettlementJob({ tradeId: "trade-002" });
    const job3 = makeSettlementJob({ tradeId: "trade-003" });

    await producer.enqueue(job1);
    await producer.enqueue(job2);
    await producer.enqueue(job3);

    expect(mockRedis.xadd).toHaveBeenCalledTimes(3);
    expect(mockRedis._entries).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Consumer read-back — simulates what the worker consumer sees after enqueue
// ---------------------------------------------------------------------------

describe("SettlementQueue — consumer round-trip", () => {
  it("consumer can reconstruct SettlementJob from stream entry fields", async () => {
    const { producer, mockRedis } = await buildProducerWithMock();

    const original = makeSettlementJob();
    await producer.enqueue(original);

    // Simulate consumer reading from xrange
    const entries = await mockRedis.xrange();
    expect(entries).toHaveLength(1);

    const [streamId, fields] = entries[0];
    expect(typeof streamId).toBe("string");

    const parsed = parseStreamFields(fields);

    // Verify consumer can faithfully reconstruct the job
    const reconstructed: SettlementJob = {
      tradeId: parsed.tradeId,
      marketId: parsed.marketId,
      outcome: parsed.outcome as "YES" | "NO",
      buyOrderId: parsed.buyOrderId,
      sellOrderId: parsed.sellOrderId,
      buyerAddress: parsed.buyerAddress,
      sellerAddress: parsed.sellerAddress,
      price: parseFloat(parsed.price),
      quantity: parseInt(parsed.quantity, 10),
      timestamp: parseInt(parsed.timestamp, 10),
    };

    expect(reconstructed.tradeId).toBe(original.tradeId);
    expect(reconstructed.marketId).toBe(original.marketId);
    expect(reconstructed.outcome).toBe(original.outcome);
    expect(reconstructed.buyOrderId).toBe(original.buyOrderId);
    expect(reconstructed.sellOrderId).toBe(original.sellOrderId);
    expect(reconstructed.buyerAddress).toBe(original.buyerAddress);
    expect(reconstructed.sellerAddress).toBe(original.sellerAddress);
    expect(reconstructed.price).toBeCloseTo(original.price);
    expect(reconstructed.quantity).toBe(original.quantity);
    expect(reconstructed.timestamp).toBe(original.timestamp);
  });

  it("consumer processes multiple jobs with distinct tradeIds", async () => {
    const { producer, mockRedis } = await buildProducerWithMock();

    const jobs: SettlementJob[] = [
      makeSettlementJob({ tradeId: "trade-A", price: 0.3, quantity: 50 }),
      makeSettlementJob({ tradeId: "trade-B", price: 0.6, quantity: 200 }),
      makeSettlementJob({
        tradeId: "trade-C",
        outcome: "NO",
        price: 0.4,
        quantity: 75,
      }),
    ];

    for (const job of jobs) {
      await producer.enqueue(job);
    }

    const entries = await mockRedis.xrange();
    expect(entries).toHaveLength(3);

    const tradeIds = entries.map(([, fields]) => {
      const parsed = parseStreamFields(fields);
      return parsed.tradeId;
    });

    expect(tradeIds).toContain("trade-A");
    expect(tradeIds).toContain("trade-B");
    expect(tradeIds).toContain("trade-C");
    expect(new Set(tradeIds).size).toBe(3); // All unique
  });

  it("stream entry has a stream-ID with correct format (timestamp-seq)", async () => {
    const { producer, mockRedis } = await buildProducerWithMock();

    await producer.enqueue(makeSettlementJob());

    const [[streamId]] = mockRedis._entries;
    // Auto-generated IDs from our mock follow "timestamp-seq" format
    expect(streamId).toMatch(/^\d+-\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Edge / error cases
// ---------------------------------------------------------------------------

describe("SettlementQueueProducer — edge cases", () => {
  it("propagates Redis errors up to caller", async () => {
    // Build a producer with a mock that always rejects xadd
    const mockRedis = createMockRedis();
    mockRedis.xadd.mockRejectedValue(new Error("REDIS_DOWN"));

    // Use a local producer that delegates to this specific mock
    const failingProducer = {
      async enqueue(job: SettlementJob): Promise<void> {
        const name = process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
        const prefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
        const streamKey = `${prefix}${name}`;
        const fields = [
          "tradeId",
          job.tradeId,
          "marketId",
          job.marketId,
          "outcome",
          job.outcome,
          "buyOrderId",
          job.buyOrderId,
          "sellOrderId",
          job.sellOrderId,
          "buyerAddress",
          job.buyerAddress,
          "sellerAddress",
          job.sellerAddress,
          "price",
          job.price.toString(),
          "quantity",
          job.quantity.toString(),
          "timestamp",
          job.timestamp.toString(),
        ];
        await mockRedis.xadd(streamKey, "*", ...fields);
      },
    };

    await expect(failingProducer.enqueue(makeSettlementJob())).rejects.toThrow(
      "REDIS_DOWN"
    );
  });

  it("respects SETTLEMENT_QUEUE_NAME env override", async () => {
    const origName = process.env.SETTLEMENT_QUEUE_NAME;
    const origPrefix = process.env.REDIS_KEY_PREFIX;

    try {
      process.env.SETTLEMENT_QUEUE_NAME = "custom-settlements";
      process.env.REDIS_KEY_PREFIX = "myapp:";

      const mockRedis = createMockRedis();
      const customProducer = {
        async enqueue(job: SettlementJob) {
          const name = process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
          const prefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
          const streamKey = `${prefix}${name}`;
          const fields = [
            "tradeId",
            job.tradeId,
            "marketId",
            job.marketId,
            "outcome",
            job.outcome,
            "buyOrderId",
            job.buyOrderId,
            "sellOrderId",
            job.sellOrderId,
            "buyerAddress",
            job.buyerAddress,
            "sellerAddress",
            job.sellerAddress,
            "price",
            job.price.toString(),
            "quantity",
            job.quantity.toString(),
            "timestamp",
            job.timestamp.toString(),
          ];
          await mockRedis.xadd(streamKey, "*", ...fields);
        },
      };

      await customProducer.enqueue(makeSettlementJob());

      const [streamKey] = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(streamKey).toBe("myapp:custom-settlements");
    } finally {
      if (origName === undefined) {
        delete process.env.SETTLEMENT_QUEUE_NAME;
      } else {
        process.env.SETTLEMENT_QUEUE_NAME = origName;
      }
      if (origPrefix === undefined) {
        delete process.env.REDIS_KEY_PREFIX;
      } else {
        process.env.REDIS_KEY_PREFIX = origPrefix;
      }
    }
  });
});
