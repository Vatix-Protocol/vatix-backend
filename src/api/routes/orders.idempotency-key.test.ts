import { describe, it, expect, vi } from "vitest";

// parseIdempotencyKey is a pure header parser; stub the module-level
// dependencies that orders.ts pulls in so importing it does not open DB/Redis
// connections.
vi.mock("../../services/prisma.js", () => ({
  getPrismaClient: vi.fn(),
}));
vi.mock("../../services/redis.js", () => ({ redis: {} }));
vi.mock("../../services/audit.js", () => ({
  auditService: { getWalletTradeHistory: vi.fn() },
}));
vi.mock("../../matching/matching-service.js", () => ({
  matchingService: { placeOrder: vi.fn() },
}));

import { parseIdempotencyKey } from "./orders.js";
import { ValidationError } from "../middleware/errors.js";

const requestWith = (key: string) =>
  ({ headers: { "idempotency-key": key } }) as unknown as Parameters<
    typeof parseIdempotencyKey
  >[0];

// The pattern is ^[A-Za-z0-9_.:-]{1,128}$ (#1560). This exercises the header
// parser only, not the payload hash.
describe("parseIdempotencyKey pattern (#1560)", () => {
  it("returns a key containing a colon unchanged", () => {
    const key = "order:2026-11-23:abc";
    expect(parseIdempotencyKey(requestWith(key))).toBe(key);
  });

  it.each([
    ["a slash", "order/123"],
    ["a space", "order 123"],
    ["a 129-character key", "a".repeat(129)],
  ])("rejects a key with %s", (_label, key) => {
    expect(() => parseIdempotencyKey(requestWith(key))).toThrow(
      ValidationError
    );
  });
});
