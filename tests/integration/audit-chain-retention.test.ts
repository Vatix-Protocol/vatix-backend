/**
 * Integration test (issue #952): the trade audit hash chain must detect an
 * archived row that is deleted or expires out from under it — otherwise the
 * chain is decorative and a retention policy silently defeats forensics.
 *
 * Runs against a real Postgres via the integration harness. Builds a proper
 * hash chain of `trade_audit_events` rows, proves verification passes, then
 * deletes an intermediate row (what a retention job / manual purge does) and
 * proves verification now reports a gap.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPrismaClient, testUtils } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { auditService } from "../../src/services/audit.js";
import {
  computeAuditEntryHash,
  AUDIT_CHAIN_ROOT_HASH,
} from "../../src/services/auditChain.js";

describe("trade audit chain retention / restore drill (#952)", () => {
  const prisma = getTestPrismaClient();

  beforeAll(async () => {
    await acquireDatabaseLock();
  });

  afterAll(async () => {
    await releaseDatabaseLock();
  });

  async function seedChain(marketId: string, n: number) {
    let prevHash = AUDIT_CHAIN_ROOT_HASH;
    const base = Date.now();
    for (let i = 0; i < n; i++) {
      const payload = JSON.stringify({ tradeId: `t-${i}`, seq: i });
      const entryHash = computeAuditEntryHash(payload, prevHash);
      await prisma.tradeAuditEvent.create({
        data: {
          tradeId: `t-${i}`,
          marketId,
          payload,
          prevHash,
          entryHash,
          streamId: `${base + i}-0`,
          archivedAt: new Date(base + i * 1000),
        },
      });
      prevHash = entryHash;
    }
  }

  it("passes for an intact chain and reports a gap once an archived row is purged", async () => {
    const market = await testUtils.createTestMarket({ status: "ACTIVE" });
    await seedChain(market.id, 6);

    const intact = await auditService.verifyAuditChain(market.id);
    expect(intact.valid).toBe(true);
    expect(intact.totalEvents).toBe(6);
    expect(intact.gapCount).toBe(0);

    // Simulate a retention job / manual purge deleting an intermediate archive.
    const rows = await prisma.tradeAuditEvent.findMany({
      where: { marketId: market.id },
      orderBy: { archivedAt: "asc" },
    });
    await prisma.tradeAuditEvent.delete({ where: { id: rows[3].id } });

    const afterPurge = await auditService.verifyAuditChain(market.id);
    expect(afterPurge.valid).toBe(false);
    expect(afterPurge.gapCount).toBe(1);
    expect(afterPurge.mismatchCount).toBe(0); // surviving rows still hash fine
    expect(afterPurge.errors.some((e) => e.kind === "chain_gap")).toBe(true);

    // Restore drill: re-insert the archived row from backup → chain heals.
    await prisma.tradeAuditEvent.create({
      data: {
        tradeId: rows[3].tradeId,
        marketId: rows[3].marketId,
        payload: rows[3].payload,
        prevHash: rows[3].prevHash,
        entryHash: rows[3].entryHash,
        streamId: rows[3].streamId,
        archivedAt: rows[3].archivedAt,
      },
    });

    const restored = await auditService.verifyAuditChain(market.id);
    expect(restored.valid).toBe(true);
    expect(restored.gapCount).toBe(0);
  });
});
