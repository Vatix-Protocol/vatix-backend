/**
 * Integration test: finalization of CHALLENGED candidates.
 *
 * Verifies that the finalization job can evaluate CHALLENGED candidates
 * and transition them to either REJECTED (challenge upheld) or ACCEPTED
 * (challenge denied) based on competing resolution confidence scores.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { getTestPrismaClient, testUtils } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { FinalizationJob } from "../../apps/workers/src/finalization/job.js";
import type { ILogger } from "../../packages/shared/src/logger.js";

function silentLogger(): ILogger {
  const noop = () => undefined;
  const logger: ILogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

const WINDOW_SECONDS = 3600;

describe("Finalization of CHALLENGED candidates", () => {
  const prisma = getTestPrismaClient();

  beforeAll(async () => {
    await acquireDatabaseLock();
  });

  afterAll(async () => {
    await releaseDatabaseLock();
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("rejects a CHALLENGED candidate when competing PROPOSED has higher confidence", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const now = new Date(Date.now() - WINDOW_SECONDS * 1000 - 1000);

    // Create the challenged candidate with lower confidence
    const challenged = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        source: "oracle1",
        operatorAddress: testUtils.generateStellarAddress(),
        status: "CHALLENGED",
        confidenceScore: 0.7,
        createdAt: now,
      },
    });

    // Create a competing PROPOSED candidate with higher confidence
    const competing = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: false,
        source: "oracle2",
        operatorAddress: testUtils.generateStellarAddress(),
        status: "PROPOSED",
        confidenceScore: 0.9,
        createdAt: new Date(Date.now() - WINDOW_SECONDS * 1000 + 5000), // slightly newer
      },
    });

    // Run finalization
    const job = new FinalizationJob(prisma, silentLogger(), {
      challengeWindowSeconds: WINDOW_SECONDS,
    });
    const result = await job.run();

    // Verify the challenged candidate was rejected
    const rejectedCandidate = await prisma.resolutionCandidate.findUniqueOrThrow({
      where: { id: challenged.id },
    });
    expect(rejectedCandidate.status).toBe("REJECTED");

    // Verify no resolution was created for the rejected candidate
    const resolutions = await prisma.resolution.findMany({
      where: { marketId: market.id },
    });
    expect(resolutions).toHaveLength(0);

    // Verify audit log shows the rejection
    const auditLog = await prisma.resolutionAuditLog.findFirst({
      where: {
        candidateId: challenged.id,
        action: "ADJUDICATE_CHALLENGE",
      },
    });
    expect(auditLog).toBeDefined();
    expect(auditLog?.afterStatus).toBe("REJECTED");

    // Verify result includes the finalized candidate
    expect(result.finalizedCount).toBe(1);
  });

  it("accepts (denies challenge) a CHALLENGED candidate when no competing proposal exists", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const now = new Date(Date.now() - WINDOW_SECONDS * 1000 - 1000);

    // Create a challenged candidate
    const challenged = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        source: "oracle1",
        operatorAddress: testUtils.generateStellarAddress(),
        status: "CHALLENGED",
        confidenceScore: 0.8,
        createdAt: now,
      },
    });

    // Run finalization
    const job = new FinalizationJob(prisma, silentLogger(), {
      challengeWindowSeconds: WINDOW_SECONDS,
    });
    const result = await job.run();

    // Verify the challenged candidate was accepted
    const acceptedCandidate = await prisma.resolutionCandidate.findUniqueOrThrow({
      where: { id: challenged.id },
    });
    expect(acceptedCandidate.status).toBe("ACCEPTED");

    // Verify a resolution was created
    const resolution = await prisma.resolution.findFirst({
      where: { marketId: market.id },
    });
    expect(resolution).toBeDefined();
    expect(resolution?.outcome).toBe(true);

    // Verify market was resolved
    const updatedMarket = await prisma.market.findUniqueOrThrow({
      where: { id: market.id },
    });
    expect(updatedMarket.status).toBe("RESOLVED");
    expect(updatedMarket.outcome).toBe(true);

    // Verify audit log shows finalization
    const auditLog = await prisma.resolutionAuditLog.findFirst({
      where: {
        candidateId: challenged.id,
        action: "FINALIZE",
        beforeStatus: "CHALLENGED",
      },
    });
    expect(auditLog).toBeDefined();

    expect(result.finalizedCount).toBe(1);
  });

  it("accepts CHALLENGED candidate even with equal confidence (no strictly higher competing)", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const now = new Date(Date.now() - WINDOW_SECONDS * 1000 - 1000);

    // Create a challenged candidate
    const challenged = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        source: "oracle1",
        operatorAddress: testUtils.generateStellarAddress(),
        status: "CHALLENGED",
        confidenceScore: 0.8,
        createdAt: now,
      },
    });

    // Create a competing proposal with equal (not higher) confidence
    await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: false,
        source: "oracle2",
        operatorAddress: testUtils.generateStellarAddress(),
        status: "PROPOSED",
        confidenceScore: 0.8, // equal, not higher
        createdAt: new Date(Date.now() - WINDOW_SECONDS * 1000 + 5000),
      },
    });

    // Run finalization
    const job = new FinalizationJob(prisma, silentLogger(), {
      challengeWindowSeconds: WINDOW_SECONDS,
    });
    const result = await job.run();

    // Verify the challenged candidate was accepted (challenge denied)
    const acceptedCandidate = await prisma.resolutionCandidate.findUniqueOrThrow({
      where: { id: challenged.id },
    });
    expect(acceptedCandidate.status).toBe("ACCEPTED");

    expect(result.finalizedCount).toBeGreaterThanOrEqual(1);
  });

  it("skips CHALLENGED candidates within challenge window", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    const now = new Date();

    // Create a challenged candidate still within the window
    const candidate = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        source: "oracle1",
        operatorAddress: testUtils.generateStellarAddress(),
        status: "CHALLENGED",
        confidenceScore: 0.8,
        createdAt: new Date(now.getTime() - 1000), // very recent, within window
      },
    });

    // Run finalization
    const job = new FinalizationJob(prisma, silentLogger(), {
      challengeWindowSeconds: WINDOW_SECONDS,
    });
    const result = await job.run();

    // Verify the candidate was skipped (still within window)
    const skippedCandidate = await prisma.resolutionCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(skippedCandidate.status).toBe("CHALLENGED");

    // Verify no resolution was created
    const resolutions = await prisma.resolution.findMany({
      where: { marketId: market.id },
    });
    expect(resolutions).toHaveLength(0);

    expect(result.skippedCount).toBeGreaterThanOrEqual(1);
  });
});
