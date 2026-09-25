import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { buildTestApp, resetRateLimits } from "../../tests/integration/helpers/build-test-app.js";
import { testUtils } from "../../tests/setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../../tests/helpers/test-database.js";
import { getPrismaClient } from "../../services/prisma.js";
import { resolutionsRoutes } from "./resolutions.js";
import { buildSignableMessage } from "./middleware/stellarAuth.js";
import { issueChallenge } from "./middleware/nonceStore.js";

const keypair = Keypair.random();
const address = keypair.publicKey();

async function authHeaders(
  body: Record<string, unknown>
): Promise<Record<string, string>> {
  const timestamp = Date.now();
  const { nonce } = await issueChallenge(address);
  const sig = keypair
    .sign(buildSignableMessage({ ...body, nonce, timestamp }))
    .toString("base64");
  return {
    "x-signature": sig,
    "x-timestamp": String(timestamp),
    "x-nonce": nonce,
  };
}

describe("POST /v1/resolutions/:id/challenge", () => {
  let app: FastifyInstance;
  let prisma = getPrismaClient();

  beforeAll(async () => {
    await acquireDatabaseLock();
    app = await buildTestApp({ plugins: [resolutionsRoutes] });
  });

  afterAll(async () => {
    await app.close();
    await releaseDatabaseLock();
  });

  beforeEach(async () => {
    resetRateLimits();
    vi.restoreAllMocks();
  });

  it("returns 404 when candidate does not exist", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "POST",
      url: `/v1/resolutions/${fakeId}/challenge`,
      headers: await authHeaders({}),
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("NOT_FOUND");
  });

  it("transitions a PROPOSED candidate to CHALLENGED", async () => {
    const market = await testUtils.createTestMarket({ status: "RESOLVED" });

    // Create a PROPOSED resolution candidate
    const candidate = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        status: "PROPOSED",
        operatorAddress: address,
        createdAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/resolutions/${candidate.id}/challenge`,
      headers: await authHeaders({}),
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.candidateId).toBe(candidate.id);
    expect(body.marketId).toBe(market.id);
    expect(body.status).toBe("CHALLENGED");

    // Verify the status was updated in DB
    const updated = await prisma.resolutionCandidate.findUnique({
      where: { id: candidate.id },
    });
    expect(updated?.status).toBe("CHALLENGED");
  });

  it("returns 409 when candidate is already finalized (ACCEPTED)", async () => {
    const market = await testUtils.createTestMarket({ status: "RESOLVED" });

    const candidate = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        status: "ACCEPTED",
        operatorAddress: address,
        createdAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/resolutions/${candidate.id}/challenge`,
      headers: await authHeaders({}),
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ILLEGAL_TRANSITION");
  });

  it("returns 400 when challenge window is closed", async () => {
    const market = await testUtils.createTestMarket({ status: "RESOLVED" });

    // Create a candidate that was proposed > 24h ago (default challenge window)
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const candidate = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        status: "PROPOSED",
        operatorAddress: address,
        createdAt: oldDate,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/resolutions/${candidate.id}/challenge`,
      headers: await authHeaders({}),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("WINDOW_CLOSED");
  });

  it("requires authentication (rejects unsigned requests)", async () => {
    const market = await testUtils.createTestMarket({ status: "RESOLVED" });

    const candidate = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        status: "PROPOSED",
        operatorAddress: address,
        createdAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/resolutions/${candidate.id}/challenge`,
      payload: {},
    });

    // Should be rejected by verifyStellarSignature (401 or similar)
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("logs audit trail on successful challenge", async () => {
    const market = await testUtils.createTestMarket({ status: "RESOLVED" });

    const candidate = await prisma.resolutionCandidate.create({
      data: {
        marketId: market.id,
        proposedOutcome: true,
        status: "PROPOSED",
        operatorAddress: address,
        createdAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/resolutions/${candidate.id}/challenge`,
      headers: await authHeaders({}),
      payload: {},
    });

    expect(res.statusCode).toBe(201);

    // Verify audit log was created
    const auditLog = await prisma.resolutionAuditLog.findFirst({
      where: {
        candidateId: candidate.id,
        action: "CHALLENGE",
      },
    });
    expect(auditLog).toBeDefined();
    expect(auditLog?.beforeStatus).toBe("PROPOSED");
    expect(auditLog?.afterStatus).toBe("CHALLENGED");
  });
});
