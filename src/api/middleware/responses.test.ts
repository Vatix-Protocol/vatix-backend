import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import {
  unauthorized,
  forbidden,
  matchingUnavailable,
  serviceUnavailable,
  success,
} from "./responses.js";
import { errorHandler } from "./errorHandler.js";
import { ValidationError } from "./errors.js";
import { makeGenReqId, requestIdMiddleware, UUID_REGEX } from "./requestId.js";

describe("Auth response helpers", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = Fastify({ logger: false });
    server.get("/test-401", async (_, reply) => {
      unauthorized(reply);
    });
    server.get("/test-401-msg", async (_, reply) => {
      unauthorized(reply, "Token expired");
    });
    server.get("/test-403", async (_, reply) => {
      forbidden(reply);
    });
    server.get("/test-403-msg", async (_, reply) => {
      forbidden(reply, "Admin only");
    });
    server.get("/test-200", async (_, reply) => {
      success(reply, { message: "ok" });
    });
  });

  afterEach(() => server.close());

  it("unauthorized returns 401 with UNAUTHORIZED code", async () => {
    const res = await server.inject({ method: "GET", url: "/test-401" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.statusCode).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("unauthorized accepts custom message", async () => {
    const res = await server.inject({ method: "GET", url: "/test-401-msg" });
    expect(JSON.parse(res.body).error).toBe("Token expired");
  });

  it("forbidden returns 403 with FORBIDDEN code", async () => {
    const res = await server.inject({ method: "GET", url: "/test-403" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
    expect(body.statusCode).toBe(403);
    expect(body.error).toBe("Forbidden");
  });

  it("forbidden accepts custom message", async () => {
    const res = await server.inject({ method: "GET", url: "/test-403-msg" });
    expect(JSON.parse(res.body).error).toBe("Admin only");
  });

  it("401 and 403 are distinct status codes", async () => {
    const r401 = await server.inject({ method: "GET", url: "/test-401" });
    const r403 = await server.inject({ method: "GET", url: "/test-403" });
    expect(r401.statusCode).not.toBe(r403.statusCode);
  });

  it("success helper returns standardized success envelope", async () => {
    const res = await server.inject({ method: "GET", url: "/test-200" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ message: "ok" });
    // The envelope echoes the request id resolved by the server, so it lines
    // up with the x-request-id header and the request logs (#1123). This bare
    // test server uses Fastify's default genReqId ("req-N"); the UUID form is
    // covered by the correlation-id suite below.
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId).toBe(body.requestId.trim());
    expect(typeof body.timestamp).toBe("string");
    expect(() => new Date(body.timestamp)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// #1124 — one standard error envelope for every error path.
//
// A guard that sends a response directly (authz / dependency) and an error
// that is thrown and mapped by errorHandler must be indistinguishable to a
// client: same fields, same code vocabulary, and a usable requestId.
// ---------------------------------------------------------------------------

describe("standard error envelope (#1124)", () => {
  const CASES = [
    {
      name: "unauthorized",
      helper: unauthorized,
      status: 401,
      code: "UNAUTHORIZED",
    },
    {
      name: "forbidden",
      helper: forbidden,
      status: 403,
      code: "FORBIDDEN",
    },
    {
      name: "matchingUnavailable",
      helper: matchingUnavailable,
      status: 503,
      code: "MATCHING_UNAVAILABLE",
    },
    {
      name: "serviceUnavailable",
      helper: serviceUnavailable,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    },
  ] as const;

  let server: FastifyInstance;
  afterEach(() => server.close());

  for (const c of CASES) {
    it(`${c.name} returns the full envelope (code/message/error/statusCode/requestId)`, async () => {
      server = Fastify({ logger: false, genReqId: () => "req-envelope" });
      server.get("/x", async (_, reply) => c.helper(reply));

      const res = await server.inject({ method: "GET", url: "/x" });
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(c.status);
      expect(body).toEqual({
        code: c.code,
        message: body.message,
        error: body.message,
        statusCode: c.status,
        requestId: "req-envelope",
      });
      // `error` mirrors `message` for clients written against the old shape.
      expect(body.error).toBe(body.message);
      expect(typeof body.message).toBe("string");
    });
  }

  it("always includes a non-empty requestId so a denial is traceable", async () => {
    server = Fastify({ logger: false, genReqId: () => "req-trace" });
    server.get("/x", async (_, reply) => forbidden(reply));

    const res = await server.inject({ method: "GET", url: "/x" });
    const body = JSON.parse(res.body);

    expect(body).toHaveProperty("requestId");
    expect(body.requestId).toBe("req-trace");
  });

  it("uses the same envelope as a thrown error mapped by errorHandler", async () => {
    server = Fastify({ logger: false, genReqId: () => "req-same" });
    server.setErrorHandler(errorHandler);
    // Guard path: sends directly.
    server.get("/guard", async (_, reply) => forbidden(reply));
    // Thrown path: mapped by the central error handler.
    server.get("/thrown", async () => {
      throw new ValidationError("bad input");
    });

    const guardBody = JSON.parse(
      (await server.inject({ method: "GET", url: "/guard" })).body
    );
    const thrownBody = JSON.parse(
      (await server.inject({ method: "GET", url: "/thrown" })).body
    );

    // Identical key sets — a client needs only one parse path.
    expect(Object.keys(guardBody).sort()).toEqual(
      Object.keys(thrownBody).sort()
    );
    expect(guardBody.requestId).toBe(thrownBody.requestId);
  });

  it("does not leak a stack trace in the envelope", async () => {
    server = Fastify({ logger: false });
    server.get("/x", async (_, reply) => serviceUnavailable(reply));

    const res = await server.inject({ method: "GET", url: "/x" });
    expect(JSON.parse(res.body)).not.toHaveProperty("stack");
  });

  it("keeps a caller-supplied message in both message and error", async () => {
    server = Fastify({ logger: false, genReqId: () => "req-msg" });
    server.get("/x", async (_, reply) => unauthorized(reply, "Token expired"));

    const body = JSON.parse(
      (await server.inject({ method: "GET", url: "/x" })).body
    );
    expect(body.message).toBe("Token expired");
    expect(body.error).toBe("Token expired");
  });
});

// ---------------------------------------------------------------------------
// #1123 — the success envelope must carry the same correlation id as the
// x-request-id response header and the structured request logs.
// ---------------------------------------------------------------------------

describe("success envelope correlation id (#1123)", () => {
  let server: FastifyInstance;

  afterEach(() => server.close());

  it("reuses the Fastify request id rather than minting a new UUID", async () => {
    const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
    server = Fastify({ logger: false, genReqId: () => VALID_UUID });
    await server.register(requestIdMiddleware);
    server.get("/ok", async (_, reply) => {
      success(reply, { message: "ok" });
    });

    const res = await server.inject({ method: "GET", url: "/ok" });
    const body = JSON.parse(res.body);

    expect(body.requestId).toBe(VALID_UUID);
    expect(res.headers["x-request-id"]).toBe(VALID_UUID);
  });

  it("honours a caller-supplied x-request-id through the real middleware stack", async () => {
    const SUPPLIED = "550e8400-e29b-41d4-a716-446655440000";
    server = Fastify({ logger: false, genReqId: makeGenReqId() });
    await server.register(requestIdMiddleware);
    server.get("/ok", async (_, reply) => {
      success(reply, { message: "ok" });
    });

    const res = await server.inject({
      method: "GET",
      url: "/ok",
      headers: { "x-request-id": SUPPLIED },
    });
    const body = JSON.parse(res.body);

    // One id across body + header: a support ticket quoting the header is
    // enough to find the body, the logs, and the DB/Redis work behind it.
    expect(res.headers["x-request-id"]).toBe(SUPPLIED);
    expect(body.requestId).toBe(SUPPLIED);
  });

  it("still produces a valid UUID when the caller supplies a malformed id", async () => {
    server = Fastify({ logger: false, genReqId: makeGenReqId() });
    await server.register(requestIdMiddleware);
    server.get("/ok", async (_, reply) => {
      success(reply, { message: "ok" });
    });

    const res = await server.inject({
      method: "GET",
      url: "/ok",
      headers: { "x-request-id": "../../etc/passwd" },
    });
    const body = JSON.parse(res.body);

    expect(body.requestId).toMatch(UUID_REGEX);
    expect(res.headers["x-request-id"]).toBe(body.requestId);
  });

  it("never reflects an attacker-controlled id into the body unvalidated", async () => {
    const EVIL = "<script>alert(1)</script>";
    server = Fastify({ logger: false, genReqId: makeGenReqId() });
    await server.register(requestIdMiddleware);
    server.get("/ok", async (_, reply) => {
      success(reply, { message: "ok" });
    });

    const res = await server.inject({
      method: "GET",
      url: "/ok",
      headers: { "x-request-id": EVIL },
    });

    expect(JSON.parse(res.body).requestId).not.toBe(EVIL);
  });

  it("gives distinct ids to distinct requests (no shared/reused id)", async () => {
    server = Fastify({ logger: false, genReqId: makeGenReqId() });
    await server.register(requestIdMiddleware);
    server.get("/ok", async (_, reply) => {
      success(reply, { message: "ok" });
    });

    const a = JSON.parse((await server.inject({ url: "/ok" })).body);
    const b = JSON.parse((await server.inject({ url: "/ok" })).body);
    expect(a.requestId).not.toBe(b.requestId);
  });
});
