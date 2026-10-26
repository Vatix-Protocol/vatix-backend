import { describe, it, expect, vi, afterEach } from "vitest";
import { checkDbReadiness } from "./dbReadiness.js";

const mockQueryRaw = vi.fn();
const mockGetPrismaClient = vi.fn(() => ({ $queryRaw: mockQueryRaw }));

vi.mock("./prisma.js", () => ({
  getPrismaClient: () => mockGetPrismaClient(),
}));

describe("checkDbReadiness", () => {
  afterEach(() => vi.clearAllMocks());

  it("resolves without throwing when the database is reachable", async () => {
    mockQueryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    await expect(checkDbReadiness()).resolves.toBeUndefined();
    expect(mockQueryRaw).toHaveBeenCalledOnce();
  });

  it("rejects with DEPENDENCY_UNAVAILABLE when the query rejects", async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error("connection refused"));
    await expect(checkDbReadiness()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
  });

  it("rejects with DEPENDENCY_TIMEOUT when the query does not settle within the deadline", async () => {
    mockQueryRaw.mockReturnValueOnce(new Promise(() => {}));
    const start = Date.now();
    await expect(checkDbReadiness({ timeoutMs: 50 })).rejects.toMatchObject({
      code: "DEPENDENCY_TIMEOUT",
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("does not surface secrets or driver detail in the thrown error", async () => {
    const sensitiveError = new Error("auth failed: password=hunter2 host=db.internal");
    mockQueryRaw.mockRejectedValueOnce(sensitiveError);
    try {
      await checkDbReadiness();
      throw new Error("expected checkDbReadiness to reject");
    } catch (err) {
      const error = err as Error & { code?: string; cause?: unknown };
      expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(error.message).toBe("db: DEPENDENCY_UNAVAILABLE");
      expect(error.message).not.toContain("hunter2");
      expect(error.message).not.toContain("db.internal");
      expect(error.cause).toBe(sensitiveError);
    }
  });

  describe("with an injected client", () => {
    it("resolves when the injected client query resolves", async () => {
      const queryRaw = vi.fn().mockResolvedValueOnce([{ "?column?": 1 }]);
      await expect(
        checkDbReadiness({ client: { $queryRaw: queryRaw } }),
      ).resolves.toBeUndefined();
      expect(queryRaw).toHaveBeenCalledOnce();
      expect(mockGetPrismaClient).not.toHaveBeenCalled();
    });

    it("rejects with DEPENDENCY_UNAVAILABLE when the injected client rejects", async () => {
      const queryRaw = vi.fn().mockRejectedValueOnce(new Error("connection refused"));
      await expect(
        checkDbReadiness({ client: { $queryRaw: queryRaw } }),
      ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
      expect(mockGetPrismaClient).not.toHaveBeenCalled();
    });

    it("rejects with DEPENDENCY_TIMEOUT when the injected client never settles", async () => {
      const queryRaw = vi.fn().mockReturnValueOnce(new Promise(() => {}));
      const start = Date.now();
      await expect(
        checkDbReadiness({ client: { $queryRaw: queryRaw }, timeoutMs: 50 }),
      ).rejects.toMatchObject({ code: "DEPENDENCY_TIMEOUT" });
      expect(Date.now() - start).toBeLessThan(1000);
      expect(mockGetPrismaClient).not.toHaveBeenCalled();
    });
  });
});
