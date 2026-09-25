import { describe, it, expect, vi } from "vitest";
import {
  challengeResolutionCandidate,
  ChallengeNotFoundError,
  IllegalChallengeTransitionError,
} from "./challenge.js";
import type { PrismaClient } from "../../../../src/generated/prisma/client/index.js";
import type { Logger } from "../../../indexer/src/logger.js";

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    }),
  };
}

/** Builds a mock prisma whose $transaction runs against a tx locking to `lockedStatus`. */
function makePrisma(lockedStatus: string | null) {
  const queryRaw = vi
    .fn()
    .mockResolvedValue(
      lockedStatus === null ? [] : [{ id: "cand-1", status: lockedStatus }]
    );
  const updateCandidate = vi
    .fn()
    .mockResolvedValue({ id: "cand-1", marketId: "mkt-1" });
  const auditLogCreate = vi.fn().mockResolvedValue({});

  const tx = {
    $queryRaw: queryRaw,
    resolutionCandidate: { update: updateCandidate },
    resolutionAuditLog: { create: auditLogCreate },
  };

  const transaction = vi
    .fn()
    .mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        await fn(tx)
    );

  const prisma = {
    $transaction: transaction,
  } as unknown as PrismaClient;

  return { prisma, queryRaw, updateCandidate, auditLogCreate };
}

describe("challengeResolutionCandidate", () => {
  it("locks the row FOR UPDATE, transitions PROPOSED -> CHALLENGED, and writes an audit log", async () => {
    const { prisma, queryRaw, updateCandidate, auditLogCreate } =
      makePrisma("PROPOSED");
    const logger = makeLogger();

    const result = await challengeResolutionCandidate(
      prisma,
      logger,
      "cand-1",
      "operator-a"
    );

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(updateCandidate).toHaveBeenCalledWith({
      where: { id: "cand-1" },
      data: { status: "CHALLENGED" },
      select: { id: true, marketId: true },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: {
        candidateId: "cand-1",
        marketId: "mkt-1",
        action: "CHALLENGE",
        beforeStatus: "PROPOSED",
        afterStatus: "CHALLENGED",
        actor: "operator-a",
      },
    });
    expect(result).toEqual({
      candidateId: "cand-1",
      marketId: "mkt-1",
      status: "CHALLENGED",
    });
  });

  it("rejects with IllegalChallengeTransitionError when finalize already won the race (status=ACCEPTED)", async () => {
    const { prisma, updateCandidate } = makePrisma("ACCEPTED");
    const logger = makeLogger();

    await expect(
      challengeResolutionCandidate(prisma, logger, "cand-1", "operator-a")
    ).rejects.toThrow(IllegalChallengeTransitionError);
    expect(updateCandidate).not.toHaveBeenCalled();
  });

  it("rejects with IllegalChallengeTransitionError when already CHALLENGED", async () => {
    const { prisma } = makePrisma("CHALLENGED");
    const logger = makeLogger();

    await expect(
      challengeResolutionCandidate(prisma, logger, "cand-1", "operator-a")
    ).rejects.toThrow(IllegalChallengeTransitionError);
  });

  it("rejects with ChallengeNotFoundError when the candidate row doesn't exist", async () => {
    const { prisma, updateCandidate } = makePrisma(null);
    const logger = makeLogger();

    await expect(
      challengeResolutionCandidate(prisma, logger, "missing", "operator-a")
    ).rejects.toThrow(ChallengeNotFoundError);
    expect(updateCandidate).not.toHaveBeenCalled();
  });

  it("carries statusCode for HTTP mapping (404 / 409)", async () => {
    const notFound = new ChallengeNotFoundError("x");
    const illegal = new IllegalChallengeTransitionError("x", "ACCEPTED");
    expect(notFound.statusCode).toBe(404);
    expect(illegal.statusCode).toBe(409);
  });
});
