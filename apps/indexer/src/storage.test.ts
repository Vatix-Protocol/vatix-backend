import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrismaCursorStorageClient } from "./storage.js";

// Mock the prisma singleton before importing storage
vi.mock("../../../src/services/prisma.js", () => ({
  getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from "../../../src/services/prisma.js";

function makeMockPrisma(
  findResult: { cursorValue: string | null } | null = null
) {
  const upsert = vi.fn().mockResolvedValue({});
  const findUnique = vi.fn().mockResolvedValue(findResult);
  const $transaction = vi
    .fn()
    .mockImplementation((fn: (tx: unknown) => Promise<void>) =>
      fn({ indexerCursor: { upsert } })
    );
  return { indexerCursor: { findUnique, upsert }, $transaction };
}

describe("PrismaCursorStorageClient", () => {
  const networkId = "testnet";
  const cursorKey = "ingestion";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loadCursor", () => {
    it("returns cursorValue when row exists", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "42" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      const result = await client.loadCursor();

      expect(result).toBe("42");
      expect(mockPrisma.indexerCursor.findUnique).toHaveBeenCalledWith({
        where: { networkId_cursorKey: { networkId, cursorKey } },
        select: { cursorValue: true },
      });
    });

    it("returns null when row is missing", async () => {
      const mockPrisma = makeMockPrisma(null);
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      expect(await client.loadCursor()).toBeNull();
    });

    it("returns null when cursorValue is null", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: null });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      expect(await client.loadCursor()).toBeNull();
    });
  });

  describe("saveCursor", () => {
    it("upserts cursorValue using composite key", async () => {
      const mockPrisma = makeMockPrisma();
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      await client.saveCursor("99");

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      const txFn = vi.mocked(mockPrisma.$transaction).mock.calls[0][0] as (
        tx: typeof mockPrisma
      ) => Promise<void>;

      // Re-run the transaction fn directly to inspect the upsert call
      const upsert = vi.fn().mockResolvedValue({});
      await txFn({ indexerCursor: { upsert } } as never);
      expect(upsert).toHaveBeenCalledWith({
        where: { networkId_cursorKey: { networkId, cursorKey } },
        create: { networkId, cursorKey, cursorValue: "99" },
        update: { cursorValue: "99" },
      });
    });

    it("emits structured log with event key", async () => {
      const mockPrisma = makeMockPrisma();
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const logger = {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const client = new PrismaCursorStorageClient(
        networkId,
        cursorKey,
        logger as never
      );
      await client.saveCursor("55");

      expect(logger.info).toHaveBeenCalledWith(
        "Indexer cursor saved",
        expect.objectContaining({
          event: "indexer.cursor.saved",
          cursorValue: "55",
          networkId,
          cursorKey,
        })
      );
    });

    it("independent rows per cursorKey with same networkId", async () => {
      const prismaA = makeMockPrisma({ cursorValue: "10" });
      const prismaB = makeMockPrisma({ cursorValue: "20" });

      vi.mocked(getPrismaClient)
        .mockReturnValueOnce(prismaA as never)
        .mockReturnValueOnce(prismaB as never);

      const clientA = new PrismaCursorStorageClient(networkId, "keyA");
      const clientB = new PrismaCursorStorageClient(networkId, "keyB");

      const a = await clientA.loadCursor();
      const b = await clientB.loadCursor();

      expect(a).toBe("10");
      expect(b).toBe("20");
      expect(prismaA.indexerCursor.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { networkId_cursorKey: { networkId, cursorKey: "keyA" } },
        })
      );
      expect(prismaB.indexerCursor.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { networkId_cursorKey: { networkId, cursorKey: "keyB" } },
        })
      );
    });
  });
});
