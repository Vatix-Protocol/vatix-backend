import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { walletRoutes } from "./wallet.js";

const VALID_ACCOUNT =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const VALID_KEY = "test-api-key";

const cachedAccount = {
  accountId: VALID_ACCOUNT,
  sequence: "123",
  balances: [{ asset_type: "native", balance: "50.0000000" }],
  fetchedAt: Date.now(),
};

// Mock horizonCache so tests run without Redis
vi.mock("../../services/horizonCache.js", () => ({
  horizonCache: {
    get: vi.fn(async (id: string) =>
      id === VALID_ACCOUNT ? cachedAccount : null
    ),
  },
}));

function buildServer(apiKey = VALID_KEY): FastifyInstance {
  process.env.API_KEY = apiKey;
  const server = Fastify({ logger: false });
  server.setErrorHandler((err: FastifyError, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({
      code: (err as any).code ?? "error",
      message: err.message,
      statusCode: err.statusCode ?? 500,
    });
  });
  server.register(walletRoutes);
  return server;
}

describe("GET /v1/wallet/accounts/:accountId", () => {
  let server: FastifyInstance;

  afterEach(async () => {
    await server?.close();
    vi.clearAllMocks();
  });

  // --- success path ---

  it("returns cached account for a valid authenticated request", async () => {
    server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: `/v1/wallet/accounts/${VALID_ACCOUNT}`,
      headers: { "x-api-key": VALID_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.account.accountId).toBe(VALID_ACCOUNT);
    expect(body.data.source).toBe("cache");
    // no private keys in response
    expect(JSON.stringify(body)).not.toContain("privateKey");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  // --- failure paths ---

  it("returns 401 when API key is missing", async () => {
    server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: `/v1/wallet/accounts/${VALID_ACCOUNT}`,
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when API key is wrong", async () => {
    server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: `/v1/wallet/accounts/${VALID_ACCOUNT}`,
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for an invalid Stellar account ID", async () => {
    server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/v1/wallet/accounts/not-a-stellar-key",
      headers: { "x-api-key": VALID_KEY },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/valid Stellar public key/);
  });

  it("returns 404 when account is not in cache", async () => {
    server = buildServer();
    const unknownAccount =
      "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON";
    const res = await server.inject({
      method: "GET",
      url: `/v1/wallet/accounts/${unknownAccount}`,
      headers: { "x-api-key": VALID_KEY },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/not found in cache/);
  });
});
