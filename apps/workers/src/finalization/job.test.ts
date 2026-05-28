import { describe, it, expect, vi } from "vitest";
import { FinalizationJob, FinalizationValidationError } from "./job.js";
import type { FinalizationJobConfig, FinalizationCandidate } from "./job.js";
import type { Logger } from "../../../indexer/src/logger.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makePrisma(candidates: FinalizationCandidate[] = []) {
  return {
    resolutionCandidate: {
      findMany: vi.fn().mockResolvedValue(candidates),
    },
  } as unknown as PrismaClient;
}

function makeConfig(
  challengeWindowSeconds: number
): FinalizationJobConfig {
  return { challengeWindowSeconds };
}

describe("FinalizationJob", () => {
  describe("input validation", () => {
    it("throws FinalizationValidationError (statusCode 400) for negative challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), makeConfig(-1));
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
      await expect(job.run()).rejects.toMatchObject({ statusCode: 400 });
    });

    it("throws FinalizationValidationError for NaN challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), makeConfig(NaN));
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
    });

    it("throws FinalizationValidationError for Infinity challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), makeConfig(Infinity));
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
    });

    it("accepts zero challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), makeConfig(0));
      await expect(job.run()).resolves.toBeUndefined();
    });

    it("accepts a positive challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), makeConfig(3600));
      await expect(job.run()).resolves.toBeUndefined();
    });
  });
});
