import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateUserAddress,
  validateOrderSide,
  validateOutcome,
  validatePrice,
  validateQuantity,
  validateOrderFields,
  validateMarketState,
  validateOrder,
  assertValidOrder,
  OrderValidationError,
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

    it("should reject null/undefined", () => {
      expect(validateUserAddress(null as unknown as string)).toBe(
        "User address must be a string"
      );
      expect(validateUserAddress(undefined as unknown as string)).toBe(
        "User address must be a string"
      );
    });
  });

  describe("validateOrderSide", () => {
    it("should accept BUY", () => {
      expect(validateOrderSide("BUY")).toBeNull();
    });

    it("should accept SELL", () => {
      expect(validateOrderSide("SELL")).toBeNull();
    });

    it("should reject other strings", () => {
      expect(validateOrderSide("buy")).toBe(
        "Order side must be 'BUY' or 'SELL'"
      );
      expect(validateOrderSide("HOLD")).toBe(
        "Order side must be 'BUY' or 'SELL'"
      );
      expect(validateOrderSide("")).toBe("Order side must be 'BUY' or 'SELL'");
    });

    it("should reject null/undefined", () => {
      expect(validateOrderSide(null)).toBe("Order side is required");
      expect(validateOrderSide(undefined)).toBe("Order side is required");
    });
  });

  describe("validateOutcome", () => {
    it("should accept YES", () => {
      expect(validateOutcome("YES")).toBeNull();
    });

    it("should accept NO", () => {
      expect(validateOutcome("NO")).toBeNull();
    });

    it("should reject other strings", () => {
      expect(validateOutcome("yes")).toBe("Outcome must be 'YES' or 'NO'");
      expect(validateOutcome("MAYBE")).toBe("Outcome must be 'YES' or 'NO'");
      expect(validateOutcome("")).toBe("Outcome must be 'YES' or 'NO'");
    });

    it("should reject null/undefined", () => {
      expect(validateOutcome(null)).toBe("Outcome is required");
      expect(validateOutcome(undefined)).toBe("Outcome is required");
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

    it("should reject null/undefined", () => {
      expect(validateQuantity(null)).toBe("Quantity is required");
      expect(validateQuantity(undefined)).toBe("Quantity is required");
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
      });

      const result = await validateMarketState("market-123");
      expect(result.valid).toBe(false);
      expect(result.errors.marketId).toContain("ended");
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
