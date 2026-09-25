import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { AdminIdentityService } from "../../services/admin-identity.js";
import { requireAdmin } from "./adminGuard.js";

describe("requireAdmin guard", () => {
  let server: FastifyInstance;
  let prisma = getPrismaClient();
  let identityService: AdminIdentityService;

  beforeEach(async () => {
    prisma = getPrismaClient();
    identityService = new AdminIdentityService(prisma);
    server = Fastify({ logger: false });
    server.addHook("onRequest", requireAdmin);
    server.get("/admin/test", async () => ({ ok: true }));

    // Clean up test identities
    await prisma.adminIdentityAuditLog.deleteMany({});
    await prisma.adminIdentity.deleteMany({});
  });

  afterEach(async () => {
    await server.close();
    await prisma.adminIdentityAuditLog.deleteMany({});
    await prisma.adminIdentity.deleteMany({});
    vi.unstubAllEnvs();
  });

  it("returns 401 when no Authorization header", async () => {
    await identityService.createIdentity("alice", "secret123", "system");
    const res = await server.inject({ method: "GET", url: "/admin/test" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when header is not Bearer scheme", async () => {
    await identityService.createIdentity("alice", "secret123", "system");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when credential format is invalid", async () => {
    await identityService.createIdentity("alice", "secret123", "system");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer invalid-format" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("FORBIDDEN");
  });

  it("allows request with valid identity and credential", async () => {
    await identityService.createIdentity("alice", "secret123", "system");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer alice:secret123" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("returns 403 when credential is wrong for valid identity", async () => {
    await identityService.createIdentity("alice", "secret123", "system");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer alice:wrongsecret" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when identity does not exist", async () => {
    await identityService.createIdentity("alice", "secret123", "system");
    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer bob:secret123" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects revoked identities", async () => {
    await identityService.createIdentity("alice", "secret123", "system");
    await identityService.revokeIdentity("alice", "system", "test revocation");

    const res = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer alice:secret123" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts new credential after rotation", async () => {
    await identityService.createIdentity("alice", "oldcredential", "system");
    await identityService.rotateCredential(
      "alice",
      "newcredential",
      "system"
    );

    const resOld = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer alice:oldcredential" },
    });
    expect(resOld.statusCode).toBe(403);

    const resNew = await server.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer alice:newcredential" },
    });
    expect(resNew.statusCode).toBe(200);
  });
});
