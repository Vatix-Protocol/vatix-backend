import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  lockResolutionCandidate,
  lockResolutionCandidateOrThrow,
  ResolutionLockError,
} from "./resolutionLock.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => makeLogger()),
  };
}

describe("lockResolutionCandidate", () => {
  it("returns null when no row matches the candidate id", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const result = await lockResolutionCandidate(tx as any, "missing-id");
    expect(result).toBeNull();
  });

  it("returns the locked row when found", async () => {
    const row = { id: "c1", status: "PROPOSED" };
    const tx = { $queryRaw: vi.fn().mockResolvedValue([row]) };
    const result = await lockResolutionCandidate(tx as any, "c1");
    expect(result).toEqual(row);
  });
});

describe("lockResolutionCandidateOrThrow (production hardening — resolutionLock gap)", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("fails fast with ResolutionLockError when the underlying lock query throws, instead of silently returning null", async () => {
    // This is the failing-test-first case for the reported gap: two
    // replicas racing to finalize the same candidate must never have the
    // failure swallowed into an off-chain/no-op fallback.
    process.env.NODE_ENV = "production";
    const dbError = new Error("deadlock detected");
    const tx = { $queryRaw: vi.fn().mockRejectedValue(dbError) };
    const logger = makeLogger();

    await expect(
      lockResolutionCandidateOrThrow(tx as any, "candidate-1", logger)
    ).rejects.toThrow(ResolutionLockError);
    expect(logger.error).toHaveBeenCalledWith(
      "resolution_candidates lock acquisition failed",
      expect.objectContaining({ candidateId: "candidate-1" })
    );
  });

  it("fails fast in dev too — lock failures are never environment-gated", async () => {
    process.env.NODE_ENV = "development";
    const tx = { $queryRaw: vi.fn().mockRejectedValue(new Error("timeout")) };

    await expect(
      lockResolutionCandidateOrThrow(tx as any, "candidate-2")
    ).rejects.toThrow(ResolutionLockError);
  });

  it("logs contention (not an error) when the row was already moved to a terminal status by a competing worker", async () => {
    process.env.NODE_ENV = "production";
    const row = { id: "c3", status: "RESOLVED" };
    const tx = { $queryRaw: vi.fn().mockResolvedValue([row]) };
    const logger = makeLogger();

    const result = await lockResolutionCandidateOrThrow(
      tx as any,
      "c3",
      logger
    );

    expect(result).toEqual(row);
    expect(logger.warn).toHaveBeenCalledWith(
      "resolution_candidates lock contention detected",
      expect.objectContaining({ candidateId: "c3", status: "RESOLVED" })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not flag contention for a row still in a non-terminal status", async () => {
    const row = { id: "c4", status: "PROPOSED" };
    const tx = { $queryRaw: vi.fn().mockResolvedValue([row]) };
    const logger = makeLogger();

    await lockResolutionCandidateOrThrow(tx as any, "c4", logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
