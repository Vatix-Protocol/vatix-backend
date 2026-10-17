import { describe, it, expect, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAdmin } from "./adminGuard.js";
import type { AdminIdentityService } from "../../services/admin-identity.js";

function makeReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return reply as unknown as FastifyReply & {
    statusCode: number;
    body: unknown;
  };
}

function makeRequest(authorization?: string) {
  return {
    id: "req-test",
    headers: authorization ? { authorization } : {},
    log: { error: vi.fn() },
  } as unknown as FastifyRequest;
}

function makeIdentityService(
  overrides: Partial<AdminIdentityService> = {}
): AdminIdentityService {
  return {
    validateCredential: vi.fn().mockResolvedValue(true),
    listActiveAdmins: vi.fn().mockResolvedValue([{ id: "admin-1" }]),
    ...overrides,
  } as unknown as AdminIdentityService;
}

function bodyText(reply: { body: unknown }): string {
  return JSON.stringify(reply.body ?? "");
}

  afterEach(async () => {
    await server.close();
    await prisma.adminIdentityAuditLog.deleteMany({});
    await prisma.adminIdentity.deleteMany({});
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

describe("requireAdmin", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const reply = makeReply();
    const guard = requireAdmin({
      identityService: makeIdentityService(),
      isProduction: false,
    });

    await guard(makeRequest(), reply);

    expect(reply.statusCode).toBe(401);
  });

  it("returns 401 for a non-Bearer scheme", async () => {
    const reply = makeReply();
    const guard = requireAdmin({
      identityService: makeIdentityService(),
      isProduction: false,
    });

    await guard(makeRequest("Basic YWxpY2U6c2VjcmV0"), reply);

    expect(reply.statusCode).toBe(401);
  });

  it("does not query the identity store for a malformed credential", async () => {
    const findFirstSpy = vi.spyOn(prisma.adminIdentity, "findFirst");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer invalid-format" },
    });
    expect(res.statusCode).toBe(403);
    expect(findFirstSpy).not.toHaveBeenCalled();
  });

  it("allows request with valid identity and credential", async () => {
    await identityService.createIdentity("alice", "secret123", "system");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer alice:secret123" },
    });

    await guard(makeRequest("Bearer alice"), reply);

    expect(reply.statusCode).toBe(401);
    expect(bodyText(reply)).not.toContain("alice");
  });

  it("returns 401 for a Bearer token with an empty credential", async () => {
    const reply = makeReply();
    const guard = requireAdmin({
      identityService: makeIdentityService(),
      isProduction: false,
    });

    await guard(makeRequest("Bearer alice:"), reply);

    expect(reply.statusCode).toBe(401);
    expect(bodyTex
    });

    await guard(makeRequest("Bearer alice"), reply);

    expect(reply.statusCode).toBe(401);
    expect(bodyText(reply)).not.toContain("alice");
  });

  it("returns 401 for a Bearer token with an empty credential", async () => {
    const reply = makeReply();
    const guard = requireAdmin({
      identityService: makeIdentityService(),
      isProduction: false,
    });

    await guard(makeRequest("Bearer alice:"), reply);

    expect(reply.statusCode).toBe(401);
    expect(bodyText(reply)).not.toContain("alice");
  });

  it("returns 401 when credential validation fails", async () => {
    const reply = makeReply();
    const identityService = makeIdentityService({
      validateCredential: vi.fn().mockResolvedValue(false),
    });
    const guard = requireAdmin({ identityService, isProduction: false });

    await guard(makeRequest("Bearer alice:wrong-password"), reply);

    expect(reply.statusCode).toBe(401);
    expect(bodyText(reply)).not.toContain("wrong-password");
  });

  it("returns 5xx when the identity service throws", async () => {
    const reply = makeReply();
    const request = makeRequest("Bearer alice:secret");
    const identityService = makeIdentityService({
      validateCredential: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const guard = requireAdmin({ identityService, isProduction: false });

    await guard(request, reply);

    expect(reply.statusCode).toBeGreaterThanOrEqual(500);
    expect(reply.statusCode).toBeLessThan(600);
    expect(bodyText(reply)).not.toContain("secret");
    expect(request.log.error).toHaveBeenCalled();
  });

  it("returns 503 in production when no active admins exist", async () => {
    const reply = makeReply();
    const identityService = makeIdentityService({
      listActiveAdmins: vi.fn().mockResolvedValue([]),
    });
    const guard = requireAdmin({ identityService, isProduction: true });

    await guard(makeRequest("Bearer alice:secret"), reply);

    expect(reply.statusCode).toBe(503);
  });

  it("allows an authenticated admin through", async () => {
    const reply = makeReply();
    const guard = requireAdmin({
      identityService: makeIdentityService(),
      isProduction: false,
    });

    await guard(makeRequest("Bearer alice:secret"), reply);

    expect(reply.statusCode).toBe(200);
  });
});
