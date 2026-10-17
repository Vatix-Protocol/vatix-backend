import { describe, expect, it, vi } from "vitest";
import { createReadyDeps } from "./ready-deps";

function makePrisma(findFirst: ReturnType<typeof vi.fn>) {
  return {
    indexerCursor: { findFirst },
  } as unknown as Parameters<typeof createReadyDeps>[0]["prisma"];
}

const redisStub = { ping: vi.fn().mockResolvedValue("PONG") };

describe("createReadyDeps().getLastIndexedAt", () => {
  it("returns null when there is no cursor row", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const deps = createReadyDeps({ prisma: makePrisma(findFirst), redis: redisStub });

    await expect(deps.getLastIndexedAt()).resolves.toBeNull();
  });

  it("returns a non-null timestamp when cursorValue is 0", async () => {
    const updatedAt = new Date("2026-04-27T12:00:00.000Z");
    const findFirst = vi.fn().mockResolvedValue({ updatedAt, cursorValue: 0 });
    const deps = createReadyDeps({ prisma: makePrisma(findFirst), redis: redisStub });

    const result = await deps.getLastIndexedAt();
    expect(result).not.toBeNull();
    expect(result?.getTime()).toBe(updatedAt.getTime());
  });

  it("returns the cursor row's updatedAt when cursorValue is set", async () => {
    const updatedAt = new Date("2026-04-27T12:34:56.000Z");
    const findFirst = vi.fn().mockResolvedValue({ updatedAt, cursorValue: 42 });
    const deps = createReadyDeps({ prisma: makePrisma(findFirst), redis: redisStub });

    const result = await deps.getLastIndexedAt();
    expect(result?.getTime()).toBe(updatedAt.getTime());
  });

  it("propagates a Prisma rejection to the caller", async () => {
    const error = new Error("db down");
    const findFirst = vi.fn().mockRejectedValue(error);
    const deps = createReadyDeps({ prisma: makePrisma(findFirst), redis: redisStub });

    await expect(deps.getLastIndexedAt()).rejects.toBe(error);
  });
});
