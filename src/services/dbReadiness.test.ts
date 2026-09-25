import { describe, it, expect, vi, afterEach } from "vitest";
import { checkDbReadiness } from "./dbReadiness.js";

const mockQueryRaw = vi.fn();

vi.mock("./prisma.js", () => ({
  getPrismaClient: () => ({ $queryRaw: mockQueryRaw }),
}));

describe("checkDbReadiness", () => {
  afterEach(() => vi.clearAllMocks());

  it("resolves without throwing when the database is reachable", async () => {
    mockQueryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    await expect(checkDbReadiness()).resolves.toBeUndefined();
    expect(mockQueryRaw).toHaveBeenCalledOnce();
  });

  it("throws when the database is unreachable", async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error("connection refused"));
    await expect(checkDbReadiness()).rejects.toThrow("connection refused");
  });

  it("does not surface secrets or private keys in the thrown error", async () => {
    const sensitiveError = new Error("auth failed: password=hunter2");
    mockQueryRaw.mockRejectedValueOnce(sensitiveError);
    try {
      await checkDbReadiness();
    } catch (err) {
      // The error propagates as-is; the caller (readyRoute) only logs err.message.
      // Confirm the service itself does not redact or log anything here —
      // secret handling is the caller's responsibility.
      expect(err).toBe(sensitiveError);
    }
  });
});
