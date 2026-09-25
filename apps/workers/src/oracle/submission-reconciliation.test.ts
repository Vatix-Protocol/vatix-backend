import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Api: {
      GetTransactionStatus: {
        SUCCESS: "SUCCESS",
        FAILED: "FAILED",
        NOT_FOUND: "NOT_FOUND",
      },
    },
  },
}));

import {
  checkOnChainStatus,
  computePayloadHash,
  isDefinitivelyConfirmed,
  reconcileInFlightSubmissions,
  claimSubmissionIntent,
  recordBroadcast,
  recordConfirmed,
  resetForRetry,
  recordFailed,
} from "./submission-reconciliation.js";
import { oracleSubmissionConfirmationLatency } from "../../../../src/services/metrics.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};

describe("computePayloadHash", () => {
  it("is stable for the same payload and differs for different payloads", () => {
    const a = computePayloadHash({
      marketId: "m1",
      outcome: true,
      timestamp: "t1",
    });
    const b = computePayloadHash({
      marketId: "m1",
      outcome: true,
      timestamp: "t1",
    });
    const c = computePayloadHash({
      marketId: "m1",
      outcome: false,
      timestamp: "t1",
    });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("isDefinitivelyConfirmed (Issue 4 — hash-only confirm marks CONFIRMED too early)", () => {
  it("is true only for SUCCESS with a positive ledger number", () => {
    expect(isDefinitivelyConfirmed({ status: "SUCCESS", ledger: 10 })).toBe(
      true
    );
  });

  it("is false for SUCCESS missing ledger metadata — must not be trusted on status alone", () => {
    expect(isDefinitivelyConfirmed({ status: "SUCCESS" } as any)).toBe(false);
    expect(
      isDefinitivelyConfirmed({ status: "SUCCESS", ledger: 0 } as any)
    ).toBe(false);
    expect(
      isDefinitivelyConfirmed({ status: "SUCCESS", ledger: NaN } as any)
    ).toBe(false);
  });

  it("is false for any non-SUCCESS status regardless of ledger", () => {
    expect(
      isDefinitivelyConfirmed({ status: "FAILED", ledger: 10 } as any)
    ).toBe(false);
    expect(
      isDefinitivelyConfirmed({ status: "NOT_FOUND", ledger: 10 } as any)
    ).toBe(false);
  });
});

describe("checkOnChainStatus", () => {
  it("returns CONFIRMED on SUCCESS with ledger metadata", async () => {
    const server = {
      getTransaction: vi
        .fn()
        .mockResolvedValue({ status: "SUCCESS", ledger: 10 }),
    };
    await expect(
      checkOnChainStatus(server as any, "hash1", new Date())
    ).resolves.toBe("CONFIRMED");
  });

  it("does not confirm on SUCCESS status alone when ledger metadata is missing (Issue 4)", async () => {
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
    };
    await expect(
      checkOnChainStatus(server as any, "hash1", new Date())
    ).resolves.toBe("AMBIGUOUS");
  });

  it("returns FAILED on an on-chain FAILED status", async () => {
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: "FAILED" }),
    };
    await expect(
      checkOnChainStatus(server as any, "hash1", new Date())
    ).resolves.toBe("FAILED");
  });

  it("returns AMBIGUOUS for NOT_FOUND within the tx's timebound", async () => {
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
    };
    const broadcastAt = new Date(); // just broadcast — well within the 30s timebound
    await expect(
      checkOnChainStatus(server as any, "hash1", broadcastAt)
    ).resolves.toBe("AMBIGUOUS");
  });

  it("returns FAILED for NOT_FOUND once the timebound has definitely expired", async () => {
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
    };
    const broadcastAt = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    await expect(
      checkOnChainStatus(server as any, "hash1", broadcastAt)
    ).resolves.toBe("FAILED");
  });

  it("returns AMBIGUOUS for NOT_FOUND when broadcastAt is unknown", async () => {
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
    };
    await expect(
      checkOnChainStatus(server as any, "hash1", null)
    ).resolves.toBe("AMBIGUOUS");
  });
});

describe("reconcileInFlightSubmissions", () => {
  let prisma: {
    oracleReport: {
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = {
      oracleReport: {
        findMany: vi.fn(),
        update: vi.fn().mockResolvedValue({ broadcastAt: null }),
      },
    };
  });

  it("is a no-op without a Stellar server (off-chain deployments)", async () => {
    const summary = await reconcileInFlightSubmissions(
      prisma as any,
      undefined,
      mockLogger
    );

    expect(summary).toEqual({ confirmed: 0, failed: 0, ambiguous: 0 });
    expect(prisma.oracleReport.findMany).not.toHaveBeenCalled();
  });

  it("confirms rows whose broadcast tx succeeded on-chain", async () => {
    prisma.oracleReport.findMany.mockResolvedValue([
      {
        marketId: "market-1",
        payloadHash: "hash1",
        txHash: "tx1",
        attempts: 1,
        broadcastAt: new Date(),
      },
    ]);
    const server = {
      getTransaction: vi
        .fn()
        .mockResolvedValue({ status: "SUCCESS", ledger: 10 }),
    };

    const summary = await reconcileInFlightSubmissions(
      prisma as any,
      server as any,
      mockLogger
    );

    expect(summary.confirmed).toBe(1);
    expect(prisma.oracleReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          marketId_payloadHash: { marketId: "market-1", payloadHash: "hash1" },
        },
        data: expect.objectContaining({ status: "CONFIRMED", txHash: "tx1" }),
      })
    );
  });

  it("clears rows for retry once non-inclusion is definite", async () => {
    prisma.oracleReport.findMany.mockResolvedValue([
      {
        marketId: "market-1",
        payloadHash: "hash1",
        txHash: "tx1",
        attempts: 1,
        broadcastAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    ]);
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
    };

    const summary = await reconcileInFlightSubmissions(
      prisma as any,
      server as any,
      mockLogger
    );

    expect(summary.failed).toBe(1);
    expect(prisma.oracleReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING", txHash: null }),
      })
    );
  });

  it("leaves recently-broadcast rows ambiguous rather than clearing them", async () => {
    prisma.oracleReport.findMany.mockResolvedValue([
      {
        marketId: "market-1",
        payloadHash: "hash1",
        txHash: "tx1",
        attempts: 1,
        broadcastAt: new Date(),
      },
    ]);
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
    };

    const summary = await reconcileInFlightSubmissions(
      prisma as any,
      server as any,
      mockLogger
    );

    expect(summary.ambiguous).toBe(1);
    expect(prisma.oracleReport.update).not.toHaveBeenCalled();
  });

  it("#949: a crashing chain check on one row does not stop reconciliation of the rest", async () => {
    prisma.oracleReport.findMany.mockResolvedValue([
      {
        marketId: "market-broken",
        payloadHash: "hash-broken",
        txHash: "tx-broken",
        attempts: 1,
        broadcastAt: new Date(),
      },
      {
        marketId: "market-ok",
        payloadHash: "hash-ok",
        txHash: "tx-ok",
        attempts: 1,
        broadcastAt: new Date(),
      },
    ]);
    const server = {
      getTransaction: vi
        .fn()
        .mockRejectedValueOnce(new Error("RPC unreachable"))
        .mockResolvedValueOnce({ status: "SUCCESS", ledger: 20 }),
    };

    const summary = await reconcileInFlightSubmissions(
      prisma as any,
      server as any,
      mockLogger
    );

    // The broken row is left ambiguous (never silently dropped or
    // mis-classified as failed) and the second row still gets reconciled.
    expect(summary).toEqual({ confirmed: 1, failed: 0, ambiguous: 1 });
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to reconcile in-flight oracle submission",
      expect.objectContaining({
        marketId: "market-broken",
        error: "RPC unreachable",
      })
    );
    expect(prisma.oracleReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          marketId_payloadHash: {
            marketId: "market-ok",
            payloadHash: "hash-ok",
          },
        },
        data: expect.objectContaining({ status: "CONFIRMED" }),
      })
    );
  });
});

describe("oracle report state-machine writers (#949)", () => {
  let prisma: {
    oracleReport: {
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    prisma = {
      oracleReport: {
        upsert: vi.fn().mockResolvedValue({ id: "row-1" }),
        update: vi.fn().mockResolvedValue({ id: "row-1" }),
      },
    };
  });

  it("claimSubmissionIntent upserts on (marketId, payloadHash) without clobbering an existing row", async () => {
    await claimSubmissionIntent(prisma as any, {
      marketId: "m1",
      payloadHash: "h1",
      source: "oracle-worker",
      candidateResolution: true,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    expect(prisma.oracleReport.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { marketId_payloadHash: { marketId: "m1", payloadHash: "h1" } },
        create: expect.objectContaining({ status: "PENDING", attempts: 0 }),
        update: {},
      })
    );
  });

  it("recordBroadcast sets SUBMITTED, the tx hash, and broadcastAt", async () => {
    await recordBroadcast(prisma as any, {
      marketId: "m1",
      payloadHash: "h1",
      txHash: "tx1",
      attempts: 1,
    });

    expect(prisma.oracleReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUBMITTED",
          txHash: "tx1",
          attempts: 1,
          broadcastAt: expect.any(Date),
        }),
      })
    );
  });

  it("recordConfirmed sets CONFIRMED/confirmedAt and observes confirmation latency when broadcastAt is known", async () => {
    const broadcastAt = new Date(Date.now() - 2_500);
    prisma.oracleReport.update.mockResolvedValue({ broadcastAt });

    const before = (
      await oracleSubmissionConfirmationLatency.get()
    ).values.reduce(
      (sum, v) => sum + (v.metricName?.endsWith("_count") ? v.value : 0),
      0
    );

    await recordConfirmed(prisma as any, {
      marketId: "m1",
      payloadHash: "h1",
      txHash: "tx1",
    });

    expect(prisma.oracleReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CONFIRMED",
          txHash: "tx1",
          confirmedAt: expect.any(Date),
        }),
      })
    );

    const after = (
      await oracleSubmissionConfirmationLatency.get()
    ).values.reduce(
      (sum, v) => sum + (v.metricName?.endsWith("_count") ? v.value : 0),
      0
    );
    expect(after).toBe(before + 1);
  });

  it("recordConfirmed does not observe latency when broadcastAt is unknown", async () => {
    prisma.oracleReport.update.mockResolvedValue({ broadcastAt: null });

    const before = (
      await oracleSubmissionConfirmationLatency.get()
    ).values.reduce(
      (sum, v) => sum + (v.metricName?.endsWith("_count") ? v.value : 0),
      0
    );

    await recordConfirmed(prisma as any, {
      marketId: "m1",
      payloadHash: "h1",
      txHash: "tx1",
    });

    const after = (
      await oracleSubmissionConfirmationLatency.get()
    ).values.reduce(
      (sum, v) => sum + (v.metricName?.endsWith("_count") ? v.value : 0),
      0
    );
    expect(after).toBe(before);
  });

  it("resetForRetry clears txHash/broadcastAt back to PENDING", async () => {
    await resetForRetry(prisma as any, {
      marketId: "m1",
      payloadHash: "h1",
      attempts: 2,
    });

    expect(prisma.oracleReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "PENDING",
          txHash: null,
          broadcastAt: null,
          attempts: 2,
        },
      })
    );
  });

  it("recordFailed marks the row permanently FAILED and clears candidateResolution", async () => {
    await recordFailed(prisma as any, {
      marketId: "m1",
      payloadHash: "h1",
      attempts: 5,
    });

    expect(prisma.oracleReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "FAILED",
          candidateResolution: null,
          attempts: 5,
        },
      })
    );
  });
});
