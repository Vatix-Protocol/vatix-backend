import { describe, it, expect, vi } from "vitest";
import { FinalizationJob, FinalizationValidationError } from "./job.js";
import type { Logger } from "../../../indexer/src/logger.js";

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makePrisma(candidates: unknown[] = []) {
  return {
    resolutionCandidate: {
      findMany: vi.fn().mockResolvedValue(candidates),
    },
  } as unknown as Parameters<typeof FinalizationJob>[0];
}

describe("FinalizationJob", () => {
  describe("input validation", () => {
    it("throws FinalizationValidationError (statusCode 400) for negative challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), -1);
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
      await expect(job.run()).rejects.toMatchObject({ statusCode: 400 });
    });

    it("throws FinalizationValidationError for NaN challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), NaN);
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
    });

    it("throws FinalizationValidationError for Infinity challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), Infinity);
      await expect(job.run()).rejects.toThrow(FinalizationValidationError);
    });

    it("accepts zero challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), 0);
      await expect(job.run()).resolves.toBeUndefined();
    });

    it("accepts a positive challengeWindowSeconds", async () => {
      const job = new FinalizationJob(makePrisma(), makeLogger(), 3600);
      await expect(job.run()).resolves.toBeUndefined();
    });
  });
});
