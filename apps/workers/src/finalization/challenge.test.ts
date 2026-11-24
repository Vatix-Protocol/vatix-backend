import { describe, it, expect, vi, afterEach } from "vitest";
import {
  challengeResolutionCandidate,
  ChallengeNotFoundError,
  IllegalChallengeTransitionError,
  UnauthorizedChallengeActorError,
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

interface PrismaOverrides {
  marketId?: string | null;
  oracleAddress?: string | null;
  bondAccount?: string | null;
}

/**
 * Builds a mock prisma whose $transaction runs against a tx locking to
 * `lockedStatus`, plus the plain (non-transaction) reads that
 * `assertAuthorizedChallenger` performs before the lock is ever taken:
 * resolutionCandidate.findUnique (marketId lookup), market.findUnique
 * (oracle address), and collateralDeposit.findFirst (bond lookup).
 *
 * By default the candidate resolves to "mkt-1" whose oracle is
 * "oracle-addr" and which has no collateral deposit, so tests that pass
 * actor "operator-a" must either be in CHALLENGE_ADMIN_ADDRESSES or match
 * one of the overrides below to be authorized.
 */
function makePrisma(lockedStatus: string | null, overrides: PrismaOverrides = {}) {
  const marketId =
    overrides.marketId === undefined ? "mkt-1" : overrides.marketId;
  const oracleAddress =
    overrides.oracleAddress === undefined ? "oracle-addr" : overrides.oracleAddress;

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

  const findCandidate = vi.fn().mockResolvedValue(
    marketId === null ? null : { marketId }
  );
  const findMarket = vi.fn().mockResolvedValue(
    oracleAddress === null ? null : { oracleAddress }
  );
  const findBond = vi.fn().mockResolvedValue(
    overrides.bondAccount ? { id: "deposit-1" } : null
  );

  const prisma = {
    $transaction: transaction,
    resolutionCandidate: { findUnique: findCandidate },
    market: { findUnique: findMarket },
    collateralDeposit: { findFirst: findBond },
  } as unknown as PrismaClient;

  return { prisma, queryRaw, updateCandidate, auditLogCreate, findCandidate, findMarket, findBond };
}

describe("challengeResolutionCandidate", () => {
  const ENV_KEY = "CHALLENGE_ADMIN_ADDRESSES";
  const originalAdminAddresses = process.env[ENV_KEY];

  afterEach(() => {
    if (originalAdminAddresses === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalAdminAddresses;
    }
  });

  it("locks the row FOR UPDATE, transitions PROPOSED -> CHALLENGED, and writes an audit log for an authorized actor (market oracle)", async () => {
    const { prisma, queryRaw, updateCandidate, auditLogCreate } =
      makePrisma("PROPOSED");
    const logger = makeLogger();

    // "oracle-addr" is the default oracleAddress makePrisma wires up for
    // mkt-1, so this actor is authorized via the market-oracle role.
    const result = await challengeResolutionCandidate(
      prisma,
      logger,
      "cand-1",
      "oracle-addr"
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
        actor: "oracle-addr",
      },
    });
    expect(result).toEqual({
      candidateId: "cand-1",
      marketId: "mkt-1",
      status: "CHALLENGED",
    });
  });

  it("authorizes a challenger who has posted collateral (a bond) for the market", async () => {
    const { prisma, auditLogCreate } = makePrisma("PROPOSED", {
      bondAccount: "bonded-challenger",
    });
    const logger = makeLogger();

    const result = await challengeResolutionCandidate(
      prisma,
      logger,
      "cand-1",
      "bonded-challenger"
    );

    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ actor: "bonded-challenger" }),
    });
    expect(result.status).toBe("CHALLENGED");
  });

  it("authorizes a configured admin address regardless of market oracle/bond state", async () => {
    process.env[ENV_KEY] = "admin-addr-1, admin-addr-2";
    const { prisma, auditLogCreate, findMarket, findBond } =
      makePrisma("PROPOSED");
    const logger = makeLogger();

    const result = await challengeResolutionCandidate(
      prisma,
      logger,
      "cand-1",
      "admin-addr-2"
    );

    // Admin check short-circuits before any market/bond lookup is needed.
    expect(findMarket).not.toHaveBeenCalled();
    expect(findBond).not.toHaveBeenCalled();
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ actor: "admin-addr-2" }),
    });
    expect(result.status).toBe("CHALLENGED");
  });

  it("rejects an unauthorized actor with UnauthorizedChallengeActorError and never locks or mutates the candidate (#1544)", async () => {
    const { prisma, queryRaw, updateCandidate, auditLogCreate } = makePrisma(
      "PROPOSED"
    );
    const logger = makeLogger();

    await expect(
      challengeResolutionCandidate(prisma, logger, "cand-1", "random-caller")
    ).rejects.toThrow(UnauthorizedChallengeActorError);

    // Never even acquires the row lock, so the candidate stays PROPOSED.
    expect(queryRaw).not.toHaveBeenCalled();
    expect(updateCandidate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty/missing actor string outright", async () => {
    const { prisma, queryRaw } = makePrisma("PROPOSED");
    const logger = makeLogger();

    await expect(
      challengeResolutionCandidate(prisma, logger, "cand-1", "")
    ).rejects.toThrow(UnauthorizedChallengeActorError);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("rejects with IllegalChallengeTransitionError when finalize already won the race (status=ACCEPTED)", async () => {
    const { prisma, updateCandidate } = makePrisma("ACCEPTED");
    const logger = makeLogger();

    await expect(
      challengeResolutionCandidate(prisma, logger, "cand-1", "oracle-addr")
    ).rejects.toThrow(IllegalChallengeTransitionError);
    expect(updateCandidate).not.toHaveBeenCalled();
  });

  it("rejects with IllegalChallengeTransitionError when already CHALLENGED", async () => {
    const { prisma } = makePrisma("CHALLENGED");
    const logger = makeLogger();

    await expect(
      challengeResolutionCandidate(prisma, logger, "cand-1", "oracle-addr")
    ).rejects.toThrow(IllegalChallengeTransitionError);
  });

  it("rejects with ChallengeNotFoundError when the candidate row doesn't exist", async () => {
    const { prisma, updateCandidate } = makePrisma(null, { marketId: null });
    const logger = makeLogger();

    await expect(
      challengeResolutionCandidate(prisma, logger, "missing", "operator-a")
    ).rejects.toThrow(ChallengeNotFoundError);
    expect(updateCandidate).not.toHaveBeenCalled();
  });

  it("carries statusCode for HTTP mapping (403 / 404 / 409)", async () => {
    const unauthorized = new UnauthorizedChallengeActorError("x");
    const notFound = new ChallengeNotFoundError("x");
    const illegal = new IllegalChallengeTransitionError("x", "ACCEPTED");
    expect(unauthorized.statusCode).toBe(403);
    expect(notFound.statusCode).toBe(404);
    expect(illegal.statusCode).toBe(409);
  });
});
