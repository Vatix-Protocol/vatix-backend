import { describe, it, expect, vi } from "vitest";
import { loadFinalizationConfig } from "./config.js";
import { FinalizationJob } from "./job.js";
import { ConfigValidationError } from "../../../../packages/shared/src/config.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { Logger } from "../../../indexer/src/logger.js";

/**
 * Integration test (issue #950): the challenge window the finalization worker
 * actually enforces must be the one the on-chain resolution contract uses.
 *
 * These tests wire the real config loader to the real FinalizationJob (no
 * mock of either) and prove the seconds value flows end to end and that a
 * production drift is rejected before the worker can run a single tick.
 */

function makeLogger(): Logger {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue(child),
  } as unknown as Logger;
}

/** Prisma stub that records the windowCutoff passed to the candidate query. */
function makeRecordingPrisma(): {
  prisma: PrismaClient;
  seenCutoffs: Date[];
} {
  const seenCutoffs: Date[] = [];
  const prisma = {
    resolutionCandidate: {
      findMany: vi.fn().mockImplementation((args: { where?: any }) => {
        const lte = args?.where?.createdAt?.lte;
        if (lte instanceof Date) seenCutoffs.push(lte);
        return Promise.resolve([]);
      }),
    },
  } as unknown as PrismaClient;
  return { prisma, seenCutoffs };
}

describe("finalization challenge window ↔ on-chain contract (#950)", () => {
  it("defaults the enforced window to ORACLE_CHALLENGE_WINDOW_SECONDS and feeds it to the job", async () => {
    const config = loadFinalizationConfig({
      NODE_ENV: "test",
      ORACLE_CHALLENGE_WINDOW_SECONDS: "86400",
    });
    expect(config.challengeWindowSeconds).toBe(86400);

    const { prisma, seenCutoffs } = makeRecordingPrisma();
    const before = Date.now();
    const job = new FinalizationJob(prisma, makeLogger(), {
      challengeWindowSeconds: config.challengeWindowSeconds,
    });
    await job.run();
    const after = Date.now();

    expect(seenCutoffs).toHaveLength(1);
    const cutoffMs = seenCutoffs[0].getTime();
    // The job only considers candidates older than now - 86400s.
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 86400 * 1000 - 5);
    expect(cutoffMs).toBeLessThanOrEqual(after - 86400 * 1000 + 5);
  });

  it("refuses to build a config whose finalization window drifts from the chain in production", () => {
    expect(() =>
      loadFinalizationConfig({
        NODE_ENV: "production",
        ORACLE_CHALLENGE_WINDOW_SECONDS: "86400",
        FINALIZATION_CHALLENGE_WINDOW_SECONDS: "3600",
      })
    ).toThrow(ConfigValidationError);
  });

  it("lets a local stub shorten the window outside production, but flags the drift for the worker to log", () => {
    const config = loadFinalizationConfig({
      NODE_ENV: "development",
      ORACLE_CHALLENGE_WINDOW_SECONDS: "86400",
      FINALIZATION_CHALLENGE_WINDOW_SECONDS: "5",
    });
    expect(config.challengeWindowSeconds).toBe(5);
    expect(config.challengeWindowOverridden).toBe(true);
  });
});
