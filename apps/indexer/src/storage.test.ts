import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const upsertMock = vi.fn();
const findUniqueMock = vi.fn();
const transactionMock = vi.fn(async (fn: (tx: any) => Promise<void>) => {
  return fn({
    indexerCursor: { upsert: upsertMock, findUnique: findUniqueMock },
  });
});

vi.mock("../../../src/services/prisma.js", () => ({
  getPrismaClient: () => ({
    indexerCursor: { findUnique: findUniqueMock, upsert: upsertMock },
    $transaction: transactionMock,
  }),
}));

import {
  PrismaCursorStorageClient,
  CursorStorageConfigError,
  CursorConflictError,
} from "./storage.js";

describe("PrismaCursorStorageClient", () => {
  beforeEach(() => {
    upsertMock.mockReset();
    findUniqueMock.mockReset();
    transactionMock.mockClear();
  });

  it("does not advance the cursor when the batch write throws (no holes)", async () => {
    const client = new PrismaCursorStorageClient("stellar-mainnet", "matching");
    const batchError = new Error("write failed");
    const writeBatch = vi.fn().mockRejectedValue(batchError);

    await expect(
      client.saveCursorWithBatch("cursor-2", writeBatch)
    ).rejects.toThrow("write failed");

    expect(writeBatch).toHaveBeenCalledTimes(1);
    // The cursor upsert must never run once the batch write has failed.
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("persists the batch and cursor atomically on success", async () => {
    const client = new PrismaCursorStorageClient("stellar-mainnet", "matching");
    const order: string[] = [];
    const writeBatch = vi.fn().mockImplementation(async () => {
      order.push("batch");
    });
    upsertMock.mockImplementation(async () => {
      order.push("cursor");
    });

    await client.saveCursorWithBatch("cursor-3", writeBatch);

    expect(order).toEqual(["batch", "cursor"]);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it("raises CursorConflictError when another writer already advanced the cursor", async () => {
    const client = new PrismaCursorStorageClient("stellar-mainnet", "matching");
    findUniqueMock.mockResolvedValue({ cursor: "cursor-99" });
    const writeBatch = vi.fn();

    await expect(
      client.saveCursorWithBatch("cursor-4", writeBatch, "cursor-3")
    ).rejects.toThrow(CursorConflictError);

    expect(writeBatch).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  describe("production configuration guardrails", () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it("fails fast in production with an empty cursorKey", () => {
      process.env.NODE_ENV = "production";
      expect(() => new PrismaCursorStorageClient("stellar-mainnet", "")).toThrow(
        CursorStorageConfigError
      );
    });

    it("allows an empty cursorKey outside production", () => {
      process.env.NODE_ENV = "test";
      expect(() => new PrismaCursorStorageClient("stellar-mainnet", "")).not.toThrow();
    });
  });
});
