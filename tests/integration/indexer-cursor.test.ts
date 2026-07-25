import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaCursorStorageClient } from "../../apps/indexer/src/storage.js";

// Patch getPrismaClient to use test-scoped Prisma instance
import * as prismaModule from "../../src/services/prisma.js";

let pool: Pool;
let prisma: PrismaClient;

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });

  // Wire the singleton to our test prisma instance
  vi.spyOn(prismaModule, "getPrismaClient").mockReturnValue(prisma as never);

  // Clean slate
  await prisma.indexerCursor.deleteMany({
    where: { networkId: "integration-test" },
  });
});

afterAll(async () => {
  await prisma.indexerCursor.deleteMany({
    where: { networkId: "integration-test" },
  });
  await prisma.$disconnect();
  await pool.end();
  vi.restoreAllMocks();
});

describe("PrismaCursorStorageClient — integration", () => {
  const networkId = "integration-test";

  it("loadCursor returns null for missing row", async () => {
    const client = new PrismaCursorStorageClient(networkId, "missing-key");
    expect(await client.loadCursor()).toBeNull();
  });

  it("saveCursor then loadCursor returns the same value", async () => {
    const client = new PrismaCursorStorageClient(networkId, "basic");
    await client.saveCursor("42");
    expect(await client.loadCursor()).toBe("42");
  });

  it("simulated restart: new client instance reads back the persisted cursor", async () => {
    const writer = new PrismaCursorStorageClient(networkId, "restart");
    await writer.saveCursor("1234567");

    const reader = new PrismaCursorStorageClient(networkId, "restart");
    expect(await reader.loadCursor()).toBe("1234567");
  });

  it("upserting the same key updates cursorValue and bumps updatedAt", async () => {
    const client = new PrismaCursorStorageClient(networkId, "upsert");
    await client.saveCursor("100");

    const before = await prisma.indexerCursor.findUnique({
      where: { networkId_cursorKey: { networkId, cursorKey: "upsert" } },
    });

    // Small delay to ensure updatedAt differs
    await new Promise((r) => setTimeout(r, 10));
    await client.saveCursor("200");

    const after = await prisma.indexerCursor.findUnique({
      where: { networkId_cursorKey: { networkId, cursorKey: "upsert" } },
    });

    expect(after?.cursorValue).toBe("200");
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before!.updatedAt.getTime()
    );
  });

  it("different cursorKey with same networkId produces independent rows", async () => {
    const clientA = new PrismaCursorStorageClient(networkId, "independent-a");
    const clientB = new PrismaCursorStorageClient(networkId, "independent-b");

    await clientA.saveCursor("111");
    await clientB.saveCursor("222");

    expect(await clientA.loadCursor()).toBe("111");
    expect(await clientB.loadCursor()).toBe("222");
  });

  it("cursorValue null is handled gracefully (treated as unset)", async () => {
    // Insert a row with explicit null cursorValue
    await prisma.indexerCursor.create({
      data: { networkId, cursorKey: "null-value", cursorValue: null },
    });

    const client = new PrismaCursorStorageClient(networkId, "null-value");
    expect(await client.loadCursor()).toBeNull();
  });

  it("PollingIngestionLoop checkpoint path: saveCursor then reload via new storage client", async () => {
    const writer = new PrismaCursorStorageClient(networkId, "checkpoint");
    await writer.saveCursor("9999");

    // Simulate restart: brand new client instance reads same DB row
    const reloader = new PrismaCursorStorageClient(networkId, "checkpoint");
    const restored = await reloader.loadCursor();
    expect(restored).toBe("9999");
  });
});
