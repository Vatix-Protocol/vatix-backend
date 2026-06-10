import { afterAll, beforeEach } from "vitest";
import {
  getTestPrismaClient,
  cleanDatabase,
  disconnectTestPrisma,
} from "./helpers/test-database.js";

// Global test setup — no advisory lock here; DB test files acquire their own.
afterAll(async () => {
  try {
    await Promise.race([
      disconnectTestPrisma(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("cleanup timeout")), 5000)
      ),
    ]);
  } catch {
    // ignore cleanup errors
  }
});

// Clean database before each test (non-fatal if DB unavailable)
beforeEach(async () => {
  try {
    await cleanDatabase();
  } catch {
    // DB not available — non-DB tests are unaffected
  }
});

import type {
  MarketStatus,
  OrderSide,
  OrderStatus,
  Outcome,
} from "../src/generated/prisma/client/index.js";

/** Overridable fields when creating a test Market. */
export interface TestMarketOverrides {
  question?: string;
  endTime?: Date;
  oracleAddress?: string;
  status?: MarketStatus;
  outcome?: boolean | null;
}

/** Overridable fields when creating a test UserPosition. */
export interface TestPositionOverrides {
  yesShares?: number;
  noShares?: number;
  lockedCollateral?: number;
  isSettled?: boolean;
}

/** Overridable fields when creating a test Order. */
export interface TestOrderOverrides {
  side?: OrderSide;
  outcome?: Outcome;
  price?: number;
  quantity?: number;
  filledQuantity?: number;
  status?: OrderStatus;
}

// Global test utilities
export const testUtils = {
  // Create test market
  createTestMarket: async (overrides: TestMarketOverrides = {}) => {
    const prisma = getTestPrismaClient();
    const defaultMarket = {
      question: "Test market question?",
      endTime: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
      oracleAddress: "G" + "A".repeat(55), // Valid Stellar address
      status: "ACTIVE" as MarketStatus,
      outcome: null,
    };

    return prisma.market.create({
      data: { ...defaultMarket, ...overrides },
    });
  },

  // Create test position
  createTestPosition: async (
    marketId: string,
    userAddress: string,
    overrides: TestPositionOverrides = {}
  ) => {
    const prisma = getTestPrismaClient();
    const defaultPosition = {
      yesShares: 100,
      noShares: 50,
      lockedCollateral: 1.5,
      isSettled: false,
    };

    return prisma.userPosition.create({
      data: {
        marketId,
        userAddress,
        ...defaultPosition,
        ...overrides,
      },
    });
  },

  // Create test order
  createTestOrder: async (
    marketId: string,
    userAddress: string,
    overrides: TestOrderOverrides = {}
  ) => {
    const prisma = getTestPrismaClient();
    const defaultOrder = {
      side: "BUY" as OrderSide,
      outcome: "YES" as Outcome,
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN" as OrderStatus,
    };

    return prisma.order.create({
      data: {
        marketId,
        userAddress,
        ...defaultOrder,
        ...overrides,
      },
    });
  },

  // Generate valid Stellar address
  generateStellarAddress: (prefix: string = "G") => {
    return (prefix + "A".repeat(56)).slice(0, 56);
  },

  // Fixed precision assertions for decimal values
  assertDecimalEqual: (
    actual: number,
    expected: number,
    precision: number = 8
  ) => {
    const multiplier = Math.pow(10, precision);
    const actualScaled = Math.round(actual * multiplier);
    const expectedScaled = Math.round(expected * multiplier);
    return actualScaled === expectedScaled;
  },
};

// Export for use in tests
export { getTestPrismaClient };
