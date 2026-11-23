import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sanitizeUserAddress,
  validateUserAddress,
  validateOrderSide,
  validateOutcome,
  validatePrice,
  validateTickSize,
  validateQuantity,
  validateMaxSlippagePct,
  computeEffectiveWorstPrice,
  MAX_SLIPPAGE,
  validateOrderFields,
  validateMarketState,
  validateOrder,
  assertValidOrder,
  OrderValidationError,
  TICK_SIZE,
  MAX_ORDER_QUANTITY,
  type OrderInput,
} from "./validation.js";

// Mock the prisma service
const mockFindUnique = vi.fn();
vi.mock("../services/prisma.js", () => ({
  getPrismaClient: () => ({
    market: {
      findUnique: mockFindUnique,
    },
  }),
}));

// Test fixtures - Stellar addresses are exactly 56 characters starting with 'G'
const validAddress = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const validOrder: OrderInput = {
  marketId: "market-123",
  userAddress: validAddress,
  side: "BUY",
  outcome: "YES",
  price: 0.5,
  quantity: 100,
};

describe("Order Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validateUserAddress", () => {
    it("should accept valid 56-char address starting with G", () => {
      expect(validateUserAddress(validAddress)).toBeNull();
    });

    it("should reject address that is too short", () => {
      const shortAddress = "GABCDEFGHIJK";
      expect(validateUserAddress(shortAddress)).toBe(
        "User address must be exactly 56 characters"
      );
    });

    it("should reject address that is too long", () => {
      const longAddress = "G" + "A".repeat(60);
      expect(validateUserAddress(longAddress)).toBe(
        "User address must be exactly 56 characters"
      );
    });

    it("should reject address that does not start with G", () => {
      // Exactly 56 characters but starts with 'A' instead of 'G'
      const invalidPrefix =
        "AABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
      expect(validateUserAddress(invalidPrefix)).toBe(
        "User address must start with G"
      );
    });

    it("should reject empty string", () => {
      expect(validateUserAddress("")).toBe("User address is required");
    });

    it("should reject non-base32 characters in Stellar address", () => {
      const invalidCharsetAddress =
        "G1BCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
      expect(validateUserAddress(invalidCharsetAddress)).toBe(
        "User address must be a valid Stellar public key (G + 55 base32 chars)"
      );
    });

    it("should reject null/undefined", () => {
      expect(validateUserAddress(null as unknown as string)).toBe(
        "User address must be a string"
      );
      expect(validateUserAddress(undefined as unknown as string)).toBe(
        "User address must be a string"
      );
    });

    it("should reject non-string values", () => {
      expect(validateUserAddress(123 as unknown as string)).toBe(
        "User address must be a string"
      );
      expect(validateUserAddress({} as unknown as string)).toBe(
        "User address must be a string"
      );
      expect(validateUserAddress([] as unknown as string)).toBe(
        "User address must be a string"
      );
    });

    it("should accept an address matching ^G[A-Z2-7]{55}$", () => {
      const address = "G" + "A".repeat(55);
      expect(address).toMatch(/^G[A-Z2-7]{55}$/);
      expect(validateUserAddress(address)).toBeNull();
    });

    // #1532: ^G[A-Z2-7]{55}$ is base32-uppercase only. validateUserAddress
    // must not lowercase the address before testing it against that regex,
    // or a lowercase letter would silently be folded into a valid key.
    it("should reject an otherwise-valid address containing a lowercase letter", () => {
      const lowercasedOne =
        "G" + "A".repeat(54) + "a"; // 56 chars, one lowercase tail letter
      expect(lowercasedOne).toHaveLength(56);
      expect(lowercasedOne.startsWith("G")).toBe(true);
      expect(validateUserAddress(lowercasedOne)).toBe(
        "User address must be a valid Stellar public key (G + 55 base32 chars)"
      );
    });

    it("should reject a fully lowercase address and must not rewrite it to uppercase first", () => {
      const fullyLowercase = validAddress.toLowerCase();
      // The lowercase 'g' prefix fails the explicit startsWith("G") check
      // before the charset regex even runs — confirming the function does
      // not uppercase the input first (that would make this a valid key).
      expect(validateUserAddress(fullyLowercase)).toBe(
        "User address must start with G"
      );
      expect(fullyLowercase).not.toBe(validAddress);
    });
  });

  describe("validateOrderSide", () => {
    const cases: Array<[string, unknown, string | null]> = [
      ["null", null, "Order side is required"],
      ["undefined", undefined, "Order side is required"],
      ["BUY", "BUY", null],
      ["SELL", "SELL", null],
      ["lowercase buy", "buy", "Order side must be 'BUY' or 'SELL'"],
      ["lowercase sell", "sell", "Order side must be 'BUY' or 'SELL'"],
      ["YES (wrong enum)", "YES", "Order side must be 'BUY' or 'SELL'"],
      ["MAYBE", "MAYBE", "Order side must be 'BUY' or 'SELL'"],
      ["empty string", "", "Order side must be 'BUY' or 'SELL'"],
    ];

    it.each(cases)("should handle %s", (_label, input, expected) => {
      expect(validateOrderSide(input)).toBe(expected);
    });
  });

  describe("validateOutcome", () => {
    const cases: Array<[string, unknown, string | null]> = [
      ["null", null, "Outcome is required"],
      ["undefined", undefined, "Outcome is required"],
      ["YES", "YES", null],
      ["NO", "NO", null],
      ["lowercase yes", "yes", "Outcome must be 'YES' or 'NO'"],
      ["lowercase no", "no", "Outcome must be 'YES' or 'NO'"],
      ["buy (wrong enum)", "buy", "Outcome must be 'YES' or 'NO'"],
      ["MAYBE", "MAYBE", "Outcome must be 'YES' or 'NO'"],
      ["empty string", "", "Outcome must be 'YES' or 'NO'"],
    ];

    it.each(cases)("should handle %s", (_label, input, expected) => {
      expect(validateOutcome(input)).toBe(expected);
    });
  });

  describe("validatePrice", () => {
    it("should accept 0.5", () => {
      expect(validatePrice(0.5)).toBeNull();
    });

    it("should accept 0.01 (near min)", () => {
      expect(validatePrice(0.01)).toBeNull();
    });

    it("should accept 0.99 (near max)", () => {
      expect(validatePrice(0.99)).toBeNull();
    });

    it("should reject 0 (boundary)", () => {
      expect(validatePrice(0)).toBe(
        "Price must be between 0 and 1 (exclusive)"
      );
    });

    it("should reject 1 (boundary)", () => {
      expect(validatePrice(1)).toBe(
        "Price must be between 0 and 1 (exclusive)"
      );
    });

    it("should reject negative numbers", () => {
      expect(validatePrice(-0.5)).toBe(
        "Price must be between 0 and 1 (exclusive)"
      );
    });

    it("should reject values greater than 1", () => {
      expect(validatePrice(1.5)).toBe(
        "Price must be between 0 and 1 (exclusive)"
      );
    });

    it("should reject non-number values", () => {
      expect(validatePrice("0.5")).toBe("Price must be a number");
      expect(validatePrice({})).toBe("Price must be a number");
    });

    it("should reject NaN", () => {
      expect(validatePrice(NaN)).toBe("Price must be a number");
    });

    it("should reject null/undefined", () => {
      expect(validatePrice(null)).toBe("Price is required");
      expect(validatePrice(undefined)).toBe("Price is required");
    });

    it("should reject NaN and non-numbers with the number message", () => {
      expect(validatePrice(NaN)).toBe("Price must be a number");
      expect(validatePrice("0.5")).toBe("Price must be a number");
      expect(validatePrice(true)).toBe("Price must be a number");
      expect(validatePrice([])).toBe("Price must be a number");
    });

    it("should reject 1 and -0.5 with the exclusive range message", () => {
      expect(validatePrice(1)).toBe("Price must be between 0 and 1 (exclusive)");
      expect(validatePrice(-0.5)).toBe(
        "Price must be between 0 and 1 (exclusive)"
      );
    });

    it("should accept 0.5", () => {
      expect(validatePrice(0.5)).toBeNull();
    });

    it("should reject price not aligned to tick size", () => {
      expect(validatePrice(0.505)).toBe(
        `Price must be a multiple of ${TICK_SIZE} (e.g. 0.01, 0.50, 0.99)`
      );
      expect(validatePrice(0.123)).toBe(
        `Price must be a multiple of ${TICK_SIZE} (e.g. 0.01, 0.50, 0.99)`
      );
    });
  });

  describe("validateTickSize", () => {
    it("should accept prices that are exact multiples of TICK_SIZE", () => {
      expect(validateTickSize(0.01)).toBeNull();
      expect(validateTickSize(0.1)).toBeNull();
      expect(validateTickSize(0.5)).toBeNull();
      expect(validateTickSize(0.99)).toBeNull();
    });

    it("should reject price with sub-tick fractional component", () => {
      const msg = `Price must be a multiple of ${TICK_SIZE} (e.g. 0.01, 0.50, 0.99)`;
      expect(validateTickSize(0.005)).toBe(msg);
      expect(validateTickSize(0.125)).toBe(msg);
      expect(validateTickSize(0.505)).toBe(msg);
      expect(validateTickSize(0.333)).toBe(msg);
    });

    it("should accept 0.50", () => {
      expect(validateTickSize(0.5)).toBeNull();
    });

    it("should reject 0.015", () => {
      expect(validateTickSize(0.015)).toBe(
        `Price must be a multiple of ${TICK_SIZE} (e.g. 0.01, 0.50, 0.99)`
      );
    });

    it("should correctly handle IEEE-754 edge cases (0.51, 0.97, 0.03)", () => {
      expect(validateTickSize(0.51)).toBeNull();
      expect(validateTickSize(0.97)).toBeNull();
      expect(validateTickSize(0.03)).toBeNull();
    });
  });

  describe("validateQuantity", () => {
    it("should accept 1", () => {
      expect(validateQuantity(1)).toBeNull();
    });

    it("should accept 1000000", () => {
      expect(validateQuantity(1000000)).toBeNull();
    });

    it("should reject 0", () => {
      expect(validateQuantity(0)).toBe("Quantity must be positive");
    });

    it("should reject negative numbers", () => {
      expect(validateQuantity(-5)).toBe("Quantity must be positive");
    });

    it("should reject decimals (1.5)", () => {
      expect(validateQuantity(1.5)).toBe("Quantity must be an integer");
    });

    it("should reject non-number values", () => {
      expect(validateQuantity("100")).toBe("Quantity must be a number");
      expect(validateQuantity({})).toBe("Quantity must be a number");
    });

    it("should reject NaN", () => {
      expect(validateQuantity(NaN)).toBe("Quantity must be a number");
    });

    it("should reject non-finite numbers", () => {
      expect(validateQuantity(Infinity)).toBe("Quantity must be a number");
      expect(validateQuantity(-Infinity)).toBe("Quantity must be a number");
      expect(validateQuantity(Number.MAX_VALUE)).toBe(
        "Quantity must be a number",
      );
    });

    it("should reject values above the maximum storable integer", () => {
      expect(validateQuantity(MAX_ORDER_QUANTITY)).toBeNull();
      expect(validateQuantity(MAX_ORDER_QUANTITY + 1)).toBe(
        `Quantity must be at most ${MAX_ORDER_QUANTITY}`,
      );
    });

    it("should reject null/undefined", () => {
      expect(validateQuantity(null)).toBe("Quantity is required");
      expect(validateQuantity(undefined)).toBe("Quantity is required");
    });

    it.each([
      { input: 0, expected: "Quantity must be positive" },
      { input: -1, expected: "Quantity must be positive" },
      { input: 1.5, expected: "Quantity must be an integer" },
      { input: NaN, expected: "Quantity must be a number" },
      { input: 1, expected: null },
    ])(
      "should return $expected for $input",
      ({ input, expected }: { input: number; expected: string | null }) => {
        expect(validateQuantity(input)).toBe(expected);
      }
    );
  });

  describe("computeEffectiveWorstPrice", () => {
    it("returns null when no limitPrice is supplied", () => {
      expect(computeEffectiveWorstPrice("BUY", undefined, 5)).toBeNull();
    });

    it("enforces MAX_SLIPPAGE when maxSlippagePct is omitted", () => {
      expect(MAX_SLIPPAGE).toBe(0.1);
      // BUY: limitPrice * (1 + MAX_SLIPPAGE)
      expect(computeEffectiveWorstPrice("BUY", 0.5)).toBeCloseTo(0.55, 10);
      // SELL: limitPrice * (1 - MAX_SLIPPAGE)
      expect(computeEffectiveWorstPrice("SELL", 0.5)).toBeCloseTo(0.45, 10);
    });

    it("prefers an explicit maxSlippagePct over MAX_SLIPPAGE", () => {
      expect(computeEffectiveWorstPrice("BUY", 0.5, 20)).toBeCloseTo(0.6, 10);
      expect(computeEffectiveWorstPrice("SELL", 0.5, 20)).toBeCloseTo(0.4, 10);
    });

    it("treats the enforced remainder as inclusive", () => {
      const buyBound = computeEffectiveWorstPrice("BUY", 0.5);
      const sellBound = computeEffectiveWorstPrice("SELL", 0.5);
      // A fill exactly on the boundary is within tolerance.
      expect(0.5 * (1 + MAX_SLIPPAGE) <= buyBound!).toBe(true);
      expect(0.5 * (1 - MAX_SLIPPAGE) >= sellBound!).toBe(true);
    });

    it("clamps the bound into (0, 1)", () => {
      expect(computeEffectiveWorstPrice("BUY", 0.99, 100)).toBe(1);
      expect(computeEffectiveWorstPrice("SELL", 0.01, 100)).toBe(0);
    });
  });

  describe("validateMaxSlippagePct", () => {
    it("accepts 0 and 100 inclusive", () => {
      expect(validateMaxSlippagePct(0)).toBeNull();
      expect(validateMaxSlippagePct(100)).toBeNull();
    });

    it("rejects out-of-range and non-numeric values", () => {
      expect(validateMaxSlippagePct(-1)).toBe(
        "maxSlippagePct must be between 0 and 100"
      );
      expect(validateMaxSlippagePct(101)).toBe(
        "maxSlippagePct must be between 0 and 100"
      );
      expect(validateMaxSlippagePct("5")).toBe(
        "maxSlippagePct must be a number"
      );
    });
  });

  describe("validateMaxSlippagePct", () => {
    it("should accept 0 (lower boundary)", () => {
      expect(validateMaxSlippagePct(0)).toBeNull();
    });

    it("should accept 100 (upper boundary)", () => {
      expect(validateMaxSlippagePct(100)).toBeNull();
    });

    it("should reject 101 (above upper boundary)", () => {
      expect(validateMaxSlippagePct(101)).toBe(
        "maxSlippagePct must be between 0 and 100"
      );
    });

    it("should reject -1 (below lower boundary)", () => {
      expect(validateMaxSlippagePct(-1)).toBe(
        "maxSlippagePct must be between 0 and 100"
      );
    });

    it("should reject NaN", () => {
      expect(validateMaxSlippagePct(NaN)).toBe(
        "maxSlippagePct must be a number"
      );
    });
  });

  describe("validateOrderFields", () => {
    it("should pass valid order", () => {
      const result = validateOrderFields(validOrder);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual({});
    });

    it("should return all errors for multiple invalid fields", () => {
      const invalidOrder: OrderInput = {
        marketId: "market-123",
        userAddress: "invalid",
        side: "INVALID" as "BUY",
        outcome: "MAYBE" as "YES",
        price: 2,
        quantity: -5,
      };

      const result = validateOrderFields(invalidOrder);
      expect(result.valid).toBe(false);
      expect(Object.keys(result.errors)).toHaveLength(5);
      expect(result.errors.userAddress).toBeDefined();
      expect(result.errors.side).toBeDefined();
      expect(result.errors.outcome).toBeDefined();
      expect(result.errors.price).toBeDefined();
      expect(result.errors.quantity).toBeDefined();
    });

    it("should reject order with price not aligned to tick size", () => {
      const orderWithBadPrice: OrderInput = {
        ...validOrder,
        price: 0.505,
      };

      const result = validateOrderFields(orderWithBadPrice);
      expect(result.valid).toBe(false);
      expect(result.errors.price).toContain("multiple of");
    });
  });

  describe("validateMarketState", () => {
    it("should pass for active market with future end time", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day in future
      mockFindUnique.mockResolvedValue({
        id: "market-123",
        status: "ACTIVE",
        endTime: futureDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      const result = await validateMarketState("market-123");
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual({});
    });

    it("should fail when market does not exist", async () => {
      mockFindUnique.mockResolvedValue(null);

      const result = await validateMarketState("non-existent");
      expect(result.valid).toBe(false);
      expect(result.errors.marketId).toBe("Market not found");
    });

    it("should fail for RESOLVED market", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      mockFindUnique.mockResolvedValue({
        id: "market-123",
        status: "RESOLVED",
        endTime: futureDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      const result = await validateMarketState("market-123");
      expect(result.valid).toBe(false);
      expect(result.errors.marketId).toContain("resolved");
    });

    it("should fail for CANCELLED market", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      mockFindUnique.mockResolvedValue({
        id: "market-123",
        status: "CANCELLED",
        endTime: futureDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      const result = await validateMarketState("market-123");
      expect(result.valid).toBe(false);
      expect(result.errors.marketId).toContain("cancelled");
    });

    it("should fail for market with past endTime", async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day in past
      mockFindUnique.mockResolvedValue({
        id: "market-123",
        status: "ACTIVE",
        endTime: pastDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      const result = await validateMarketState("market-123");
      expect(result.valid).toBe(false);
      expect(result.errors.marketId).toContain("ended");
    });

    it("should hide a soft-deleted market from the tradable check, even while status is ACTIVE (#1539)", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      mockFindUnique.mockResolvedValue({
        id: "market-123",
        status: "ACTIVE",
        endTime: futureDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: new Date(),
      });

      const result = await validateMarketState("market-123");
      expect(result.valid).toBe(false);
      // Soft-deleted markets are reported exactly like a nonexistent market —
      // never the row's own question/prices, and never a status-specific
      // message that would confirm the (still-ACTIVE) row exists.
      expect(result.errors.marketId).toBe("Market not found");
    });
  });

  describe("validateOrder", () => {
    it("should pass valid order with active market", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      mockFindUnique.mockResolvedValue({
        id: "market-123",
        status: "ACTIVE",
        endTime: futureDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      const result = await validateOrder(validOrder);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual({});
    });

    it("should return field errors before DB check", async () => {
      const invalidOrder: OrderInput = {
        ...validOrder,
        price: 2,
      };

      const result = await validateOrder(invalidOrder);
      expect(result.valid).toBe(false);
      expect(result.errors.price).toBeDefined();
      // DB should not have been called
      expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it("should return market errors after field validation passes", async () => {
      mockFindUnique.mockResolvedValue(null);

      const result = await validateOrder(validOrder);
      expect(result.valid).toBe(false);
      expect(result.errors.marketId).toBe("Market not found");
    });
  });

  describe("assertValidOrder", () => {
    it("should not throw for valid order", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      mockFindUnique.mockResolvedValue({
        id: "market-123",
        status: "ACTIVE",
        endTime: futureDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      await expect(assertValidOrder(validOrder)).resolves.toBeUndefined();
    });

    it("should throw OrderValidationError for invalid order", async () => {
      const invalidOrder: OrderInput = {
        ...validOrder,
        price: 2,
      };

      await expect(assertValidOrder(invalidOrder)).rejects.toThrow(
        OrderValidationError
      );
    });

    it("should include all validation failures in error", async () => {
      const invalidOrder: OrderInput = {
        marketId: "market-123",
        userAddress: "invalid",
        side: "BUY",
        outcome: "YES",
        price: 2,
        quantity: 100,
      };

      try {
        await assertValidOrder(invalidOrder);
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(OrderValidationError);
        const validationError = error as OrderValidationError;
        expect(validationError.fields?.userAddress).toBeDefined();
        expect(validationError.fields?.price).toBeDefined();
      }
    });
  });

  describe("OrderValidationError", () => {
    it("should have correct name", () => {
      const error = new OrderValidationError({ field: "error message" });
      expect(error.name).toBe("OrderValidationError");
    });

    it("should concatenate error messages", () => {
      const error = new OrderValidationError({
        field1: "Error 1",
        field2: "Error 2",
      });
      expect(error.message).toContain("Error 1");
      expect(error.message).toContain("Error 2");
    });

    it("should expose fields object", () => {
      const fields = { field: "error message" };
      const error = new OrderValidationError(fields);
      expect(error.fields).toEqual(fields);
    });
  });
});

// ─── sanitizeUserAddress ──────────────────────────────────────────────────────

describe("sanitizeUserAddress", () => {
  const valid56 = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

  it("returns null for non-string input", () => {
    expect(sanitizeUserAddress(null)).toBeNull();
    expect(sanitizeUserAddress(undefined)).toBeNull();
    expect(sanitizeUserAddress(123)).toBeNull();
    expect(sanitizeUserAddress({})).toBeNull();
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeUserAddress("  " + valid56 + "  ")).toBe(valid56);
    expect(sanitizeUserAddress("\t" + valid56 + "\n")).toBe(valid56);
  });

  it("uppercases the address so case-insensitive submissions are accepted", () => {
    const lower = valid56.toLowerCase();
    expect(sanitizeUserAddress(lower)).toBe(valid56);
  });

  it("strips null-byte injection characters", () => {
    const withNull = "\x00" + valid56 + "\x00";
    expect(sanitizeUserAddress(withNull)).toBe(valid56);
  });

  it("strips newline characters used for log injection", () => {
    const withNewline = valid56.slice(0, 28) + "\n" + valid56.slice(28);
    const sanitized = sanitizeUserAddress(withNewline)!;
    expect(sanitized).not.toContain("\n");
    // Embedding a newline yields 57 chars; stripping it restores a valid 56-char key.
    expect(sanitized).toHaveLength(56);
    expect(validateUserAddress(sanitized)).toBeNull();
  });

  it("strips carriage-return characters", () => {
    const withCR = valid56.slice(0, 10) + "\r" + valid56.slice(10);
    expect(sanitizeUserAddress(withCR)).not.toContain("\r");
  });

  it("returns empty string for all-whitespace input", () => {
    expect(sanitizeUserAddress("   ")).toBe("");
  });

  it("sanitized valid address passes validateUserAddress", () => {
    const padded = "  " + valid56 + "  ";
    const sanitized = sanitizeUserAddress(padded)!;
    expect(validateUserAddress(sanitized)).toBeNull();
  });

  it("SQL-fragment-style input is rejected after sanitization", () => {
    const sqlInjection = "' OR '1'='1";
    const sanitized = sanitizeUserAddress(sqlInjection)!;
    expect(validateUserAddress(sanitized)).not.toBeNull();
  });

  it("unicode look-alike characters are rejected after sanitization", () => {
    // Cyrillic look-alike (U+0433) mixed in — not in [A-Z2-7] charset
    const lookalike = "\u0433" + valid56.slice(1);
    const sanitized = sanitizeUserAddress(lookalike)!;
    expect(validateUserAddress(sanitized)).not.toBeNull();
  });
});
