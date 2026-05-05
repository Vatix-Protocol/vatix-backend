import { beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  getTestPrismaClient,
  cleanDatabase,
  disconnectTestPrisma,
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "./helpers/test-database.js";

// Global test setup
beforeAll(async () => {
  // Acquire database lock for tests that modify data
  await acquireDatabaseLock();
  // Ensure Prisma client is available
  getTestPrismaClient();
});

afterAll(async () => {
  // Release lock and disconnect
  await releaseDatabaseLock();
  await disconnectTestPrisma();
});

// Clean database before each test
beforeEach(async () => {
  await cleanDatabase();
});

// Global test utilities
export const testUtils = {
  // Create test market
  createTestMarket: async (overrides: Partial<any> = {}) => {
    const prisma = getTestPrismaClient();
    const defaultMarket = {
      question: "Test market question?",
      endTime: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
      oracleAddress: "G" + "A".repeat(55), // Valid Stellar address
      status: "ACTIVE",
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
    overrides: Partial<any> = {}
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
    overrides: Partial<any> = {}
  ) => {
    const prisma = getTestPrismaClient();
    const defaultOrder = {
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 100,
      filledQuantity: 0,
      status: "OPEN",
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
