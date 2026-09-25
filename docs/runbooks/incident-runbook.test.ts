import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Validation tests for incident runbook SQL queries.
 * These tests ensure runbook SQL examples remain in sync with the actual schema.
 */

const prisma = new PrismaClient();

describe("Incident Runbook SQL Validation", () => {
  beforeAll(async () => {
    // Ensure we can connect to the test database
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("Incident 5: Oracle Resolution Failure detection queries", () => {
    it("validates query for CHALLENGED resolution candidates", async () => {
      // This query should not throw — it validates the schema exists
      const result = await prisma.$queryRaw`
        SELECT
          rc.id,
          rc.market_id,
          rc.status,
          rc.proposed_outcome,
          rc.confidence_score,
          rc.created_at,
          NOW() - rc.created_at as age_since_proposed
        FROM resolution_candidates rc
        WHERE rc.status = 'CHALLENGED'
        ORDER BY rc.created_at ASC
        LIMIT 5;
      `;
      expect(Array.isArray(result)).toBe(true);
    });

    it("validates query for resolution candidates by market", async () => {
      const result = await prisma.$queryRaw`
        SELECT
          rc.id,
          rc.status,
          rc.proposed_outcome,
          rc.confidence_score,
          rc.source,
          rc.created_at
        FROM resolution_candidates rc
        WHERE rc.market_id = 'test-market-id-that-does-not-exist'
        ORDER BY rc.created_at DESC;
      `;
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0); // No matching market
    });

    it("validates query for markets awaiting resolution", async () => {
      const result = await prisma.$queryRaw`
        SELECT DISTINCT
          m.id,
          m.status,
          m.end_time,
          COUNT(rc.id) as candidate_count,
          MAX(CASE WHEN rc.status = 'CHALLENGED' THEN 1 ELSE 0 END) as has_challenged
        FROM markets m
        LEFT JOIN resolution_candidates rc ON m.id = rc.market_id
        WHERE m.status = 'ACTIVE'
        GROUP BY m.id
        ORDER BY m.end_time ASC
        LIMIT 5;
      `;
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("Incident 7: Stuck CHALLENGED Resolution Candidates detection", () => {
    it("validates query for old CHALLENGED candidates", async () => {
      // Query from Incident 7 detection section
      const result = await prisma.$queryRaw`
        SELECT id, market_id, status, created_at, confidence_score
        FROM resolution_candidates
        WHERE status = 'CHALLENGED'
          AND created_at < NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 10;
      `;
      expect(Array.isArray(result)).toBe(true);
    });

    it("validates query checking for resolution rows", async () => {
      // Query from Incident 7 detection section
      const result = await prisma.$queryRaw`
        SELECT rc.id, rc.market_id, rc.status, r.id as resolution_id
        FROM resolution_candidates rc
        LEFT JOIN resolutions r ON r.market_id = rc.market_id
        WHERE rc.status = 'CHALLENGED'
          AND rc.created_at < NOW() - INTERVAL '24 hours'
        LIMIT 10;
      `;
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("Verification queries", () => {
    it("validates market status query uses correct enum values", async () => {
      // Verify that the schema has the expected MarketStatus values
      const result = await prisma.$queryRaw`
        SELECT DISTINCT status FROM markets;
      `;
      expect(Array.isArray(result)).toBe(true);
      // Should contain ACTIVE, RESOLVED, CANCELLED (if any exist in DB)
    });

    it("validates resolution_candidates status enum", async () => {
      // Verify that CHALLENGED is a valid status
      const result = await prisma.$queryRaw`
        SELECT COUNT(*) as count
        FROM resolution_candidates
        WHERE status IN ('PROPOSED', 'CHALLENGED', 'ACCEPTED', 'REJECTED');
      `;
      expect(result).toBeDefined();
    });
  });
});
