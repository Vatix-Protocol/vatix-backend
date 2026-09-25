import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrismaCursorStorageClient } from "./storage.js";
import { CursorConflictError, CursorStorageConfigError } from "./storage.js";

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
  const $transaction = vi.fn().mockImplementation(async (cb) => {
    const tx = {
      indexerCursor: {
        findUnique: vi.fn().mockResolvedValue(findResult),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    return cb(tx as never);
  });
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

      expect(mockPrisma.indexerCursor.upsert).toHaveBeenCalledWith({
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

    it("advances cursor forward without error", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "42" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      await client.saveCursor("100");

      expect(mockPrisma.indexerCursor.upsert).toHaveBeenCalledWith({
        where: { networkId_cursorKey: { networkId, cursorKey } },
        create: { networkId, cursorKey, cursorValue: "100" },
        update: { cursorValue: "100" },
      });
    });

    it("throws CursorConflictError when cursor would regress (replay guard)", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "100" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      await expect(client.saveCursor("50")).rejects.toThrow(CursorConflictError);
    });

    it("allows saving the same cursor value (idempotent)", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "42" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      await client.saveCursor("42");

      expect(mockPrisma.indexerCursor.upsert).toHaveBeenCalledWith({
        where: { networkId_cursorKey: { networkId, cursorKey } },
        create: { networkId, cursorKey, cursorValue: "42" },
        update: { cursorValue: "42" },
      });
    });

    it("saves cursor from null (first write) without conflict check", async () => {
      const mockPrisma = makeMockPrisma(null);
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      await client.saveCursor("1");

      expect(mockPrisma.indexerCursor.upsert).toHaveBeenCalledWith({
        where: { networkId_cursorKey: { networkId, cursorKey } },
        create: { networkId, cursorKey, cursorValue: "1" },
        update: { cursorValue: "1" },
      });
    });

    it("fails closed when storage throws", async () => {
      const mockPrisma = makeMockPrisma();
      mockPrisma.indexerCursor.findUnique.mockRejectedValue(
        new Error("DB connection lost")
      );
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      await expect(client.saveCursor("99")).rejects.toThrow("DB connection lost");
    });
  });

  describe("saveLedgerHash", () => {
    it("upserts ledger hash using hash cursor key", async () => {
      const mockPrisma = makeMockPrisma();
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      await client.saveLedgerHash("0xabc123");

      expect(mockPrisma.indexerCursor.upsert).toHaveBeenCalledWith({
        where: {
          networkId_cursorKey: {
            networkId,
            cursorKey: `${cursorKey}:ledger_hash`,
          },
        },
        create: {
          networkId,
          cursorKey: `${cursorKey}:ledger_hash`,
          cursorValue: "0xabc123",
        },
        update: { cursorValue: "0xabc123" },
      });
    });

    it("fails closed when storage throws", async () => {
      const mockPrisma = makeMockPrisma();
      mockPrisma.indexerCursor.upsert.mockRejectedValue(
        new Error("DB connection lost")
      );
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      await expect(client.saveLedgerHash("0xabc123")).rejects.toThrow(
        "DB connection lost"
      );
    });
  });

  describe("loadLedgerHash", () => {
    it("returns hash when row exists", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "0xabc123" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      const result = await client.loadLedgerHash();

      expect(result).toBe("0xabc123");
      expect(mockPrisma.indexerCursor.findUnique).toHaveBeenCalledWith({
        where: {
          networkId_cursorKey: {
            networkId,
            cursorKey: `${cursorKey}:ledger_hash`,
          },
        },
        select: { cursorValue: true },
      });
    });

    it("returns null when hash row is missing", async () => {
      const mockPrisma = makeMockPrisma(null);
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      expect(await client.loadLedgerHash()).toBeNull();
    });
  });

  describe("saveCursorWithBatch", () => {
    it("atomically writes batch and cursor in a single transaction", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "42" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      const writeBatch = vi.fn().mockResolvedValue(undefined);

      await client.saveCursorWithBatch("100", writeBatch, "42");

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(writeBatch).toHaveBeenCalledTimes(1);
    });

    it("throws CursorConflictError when concurrent writer advanced the cursor", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "200" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      const writeBatch = vi.fn().mockResolvedValue(undefined);

      await expect(
        client.saveCursorWithBatch("100", writeBatch, "42")
      ).rejects.toThrow(CursorConflictError);
    });

    it("rolls back batch write when cursor conflict is detected", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "200" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      const writeBatch = vi.fn().mockResolvedValue(undefined);

      await expect(
        client.saveCursorWithBatch("100", writeBatch, "42")
      ).rejects.toThrow(CursorConflictError);

      // Batch write should never have been called since conflict is detected first
      expect(writeBatch).not.toHaveBeenCalled();
    });

    it("rolls back cursor advance when batch write fails", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "42" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      const writeBatch = vi.fn().mockRejectedValue(new Error("Batch write failed"));

      await expect(
        client.saveCursorWithBatch("100", writeBatch, "42")
      ).rejects.toThrow("Batch write failed");

      // Cursor upsert should not have been called since batch failed
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("succeeds without expectedPreviousCursor (no conflict check)", async () => {
      const mockPrisma = makeMockPrisma({ cursorValue: "42" });
      vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

      const client = new PrismaCursorStorageClient(networkId, cursorKey);
      const writeBatch = vi.fn().mockResolvedValue(undefined);

      await client.saveCursorWithBatch("100", writeBatch);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(writeBatch).toHaveBeenCalledTimes(1);
    });
  });
});
