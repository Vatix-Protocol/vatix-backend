import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpiryJob } from "./job";
import type { PrismaClient } from "@prisma/client";

describe("ExpiryJob", () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = {
      market: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as PrismaClient;
  });

  it("returns zero counts when there are no candidates", async () => {
    vi.mocked(prisma.market.findMany).mockResolvedValue([]);

    const job = new ExpiryJob(prisma);
    const result = await job.run();

    expect(result).toEqual({
      totalCandidates: 0,
      expiredCount: 0,
      skippedCount: 0,
      erroredCount: 0,
    });
  });

  it("reports a non-zero erroredCount when the candidate query fails", async () => {
    vi.mocked(prisma.market.findMany).mockRejectedValue(
      new Error("database unavailable"),
    );

    const job = new ExpiryJob(prisma);
    const result = await job.run();

    expect(result.erroredCount).toBeGreaterThan(0);
    expect(result.totalCandidates).toBe(0);
    expect(result.expiredCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });
});
