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
  reconcileInFlightSubmissions,
} from "./submission-reconciliation.js";

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

describe("checkOnChainStatus", () => {
  it("returns CONFIRMED on SUCCESS", async () => {
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
    };
    await expect(
      checkOnChainStatus(server as any, "hash1", new Date())
    ).resolves.toBe("CONFIRMED");
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
      getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
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
});
