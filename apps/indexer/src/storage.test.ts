import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PrismaClient } from "../../../src/generated/prisma/client";
import { PrismaCursorStorageClient } from "./storage.js";

const NETWORK_ID = "testnet";
const CURSOR_KEY = "ledger_checkpoint";

const mockIndexerCursor = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

const mockTransaction = vi.fn(
  async (
    callback: (tx: { indexerCursor: typeof mockIndexerCursor }) => unknown
  ) => callback({ indexerCursor: mockIndexerCursor })
);

const mockPrisma = {
  indexerCursor: mockIndexerCursor,
  $transaction: mockTransaction,
} as unknown as PrismaClient;

vi.mock("../../../src/services/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

describe("PrismaCursorStorageClient", () => {
  let storage: PrismaCursorStorageClient;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new PrismaCursorStorageClient(NETWORK_ID, CURSOR_KEY);
  });

  describe("loadCursor", () => {
    it("returns null when no row exists", async () => {
      mockIndexerCursor.findUnique.mockResolvedValue(null);

      await expect(storage.loadCursor()).resolves.toBeNull();
      expect(mockIndexerCursor.findUnique).toHaveBeenCalledWith({
        where: {
          networkId_cursorKey: {
            networkId: NETWORK_ID,
            cursorKey: CURSOR_KEY,
          },
        },
        select: { cursorValue: true },
      });
    });

    it("returns null when cursorValue is unset", async () => {
      mockIndexerCursor.findUnique.mockResolvedValue({ cursorValue: null });

      await expect(storage.loadCursor()).resolves.toBeNull();
    });

    it("returns persisted cursorValue", async () => {
      mockIndexerCursor.findUnique.mockResolvedValue({
        cursorValue: "0000012345",
      });

      await expect(storage.loadCursor()).resolves.toBe("0000012345");
    });
  });

  describe("saveCursor", () => {
    it("upserts cursorValue within a transaction", async () => {
      await storage.saveCursor("0000012345");

      expect(mockTransaction).toHaveBeenCalledOnce();
      expect(mockIndexerCursor.upsert).toHaveBeenCalledWith({
        where: {
          networkId_cursorKey: {
            networkId: NETWORK_ID,
            cursorKey: CURSOR_KEY,
          },
        },
        create: {
          networkId: NETWORK_ID,
          cursorKey: CURSOR_KEY,
          cursorValue: "0000012345",
        },
        update: {
          cursorValue: "0000012345",
        },
      });
    });
  });
});
