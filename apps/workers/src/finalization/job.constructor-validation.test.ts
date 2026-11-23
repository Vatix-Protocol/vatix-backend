import { describe, it, expect, vi, afterEach } from "vitest";
import { FinalizationJob, FinalizationValidationError } from "./job.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";

// ---------------------------------------------------------------------------
// #1556 — challengeWindowSeconds is validated at construction.
//
// Only the constructor is exercised: run() is never called and no poll timer
// is started, so nothing here depends on the clock.
// ---------------------------------------------------------------------------

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ILogger;
}

function makePrisma() {
  const findMany = vi.fn().mockResolvedValue([]);
  const $transaction = vi.fn();
  const prisma = {
    resolutionCandidate: { findMany },
    $transaction,
  } as unknown as PrismaClient;
  return { prisma, findMany, $transaction };
}

function construct(challengeWindowSeconds: number) {
  const { prisma, findMany, $transaction } = makePrisma();
  const build = () =>
    new FinalizationJob(prisma, makeLogger(), { challengeWindowSeconds });
  return { build, findMany, $transaction };
}

describe("FinalizationJob constructor — challengeWindowSeconds validation (#1556)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws FinalizationValidationError for -1", () => {
    const { build, findMany, $transaction } = construct(-1);

    expect(build).toThrow(FinalizationValidationError);
    expect(build).toThrow(
      /challengeWindowSeconds must be a non-negative number/
    );
    expect(build).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(findMany).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("throws FinalizationValidationError for NaN", () => {
    const { build, findMany, $transaction } = construct(NaN);

    expect(build).toThrow(FinalizationValidationError);
    expect(findMany).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("accepts 0", () => {
    const { build, findMany, $transaction } = construct(0);

    expect(build).not.toThrow();
    expect(build()).toBeInstanceOf(FinalizationJob);
    // Construction alone must not query or schedule anything.
    expect(findMany).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("does not schedule a timer when constructed", () => {
    vi.useFakeTimers();
    construct(0).build();
    expect(vi.getTimerCount()).toBe(0);
  });
});
