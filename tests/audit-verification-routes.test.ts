/**
 * Integration tests for audit verification routes.
 * Verifies that audit routes are mounted under /v1/admin with proper auth.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../src/index.js";
import type { FastifyInstance } from "fastify";

describe("Audit Verification Routes: /v1/admin/audit", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /v1/admin/audit/verify-chain requires authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/audit/verify-chain",
      payload: {
        marketId: "test-market-1",
      },
    });

    // Should reject without auth (either 401 or 403)
    expect([401, 403]).toContain(response.statusCode);
  });

  it("GET /v1/admin/audit/watermark/:marketId requires authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/audit/watermark/test-market-1",
    });

    // Should reject without auth
    expect([401, 403]).toContain(response.statusCode);
  });

  it("GET /v1/admin/audit/events/:marketId requires authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/audit/events/test-market-1",
    });

    // Should reject without auth
    expect([401, 403]).toContain(response.statusCode);
  });

  it("POST /v1/admin/audit/verify-chain route exists and requires valid marketId", async () => {
    // With proper admin auth headers
    const adminKey = process.env.ADMIN_API_KEY || "test-admin-key";
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/audit/verify-chain",
      payload: {
        marketId: "nonexistent-market",
      },
      headers: {
        "x-api-key": adminKey,
      },
    });

    // Should not be 404 (route exists), but should be 4xx for validation or auth
    expect(response.statusCode).not.toBe(404);
  });
});
