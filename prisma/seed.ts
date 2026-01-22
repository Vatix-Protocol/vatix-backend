/**
 * Database seed script for Vatix Backend
 * 
 * Populates the database with sample markets, orders, and positions for testing and development.
 * 
 * Usage:
 *   pnpm prisma:seed
 * 
 * This script is idempotent - it can be run multiple times safely.
 * In development mode, it clears existing data before seeding.
 */

import "dotenv/config";
import { PrismaClient, MarketStatus, OrderSide, OrderStatus, Outcome } from "../src/generated/prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// Sample Stellar addresses (56 characters - base32 encoded public keys)
// Stellar addresses start with 'G' and are exactly 56 characters (G + 55 chars)
// Format: G + 55 alphanumeric characters (A-Z, 0-9)
const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS || "GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRS";
const USER_ADDRESSES = [
  "GAABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQR",
  "GBABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQR",
  "GCABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQR",
  "GDABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQR",
  "GEABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQR",
];

interface SeedMarket {
  question: string;
  endTime: Date;
  resolutionTime?: Date;
  status: MarketStatus;
  outcome?: boolean;
  orders: Array<{
    userAddress: string;
    side: OrderSide;
    outcome: Outcome;
    price: string;
    quantity: number;
    filledQuantity?: number;
    status: OrderStatus;
  }>;
  positions: Array<{
    userAddress: string;
    yesShares: number;
    noShares: number;
    lockedCollateral: string;
  }>;
}

const seedData: SeedMarket[] = [
  {
    question: "Will BTC reach $100k by March 1, 2026?",
    endTime: new Date("2026-03-01T23:59:59Z"),
    status: MarketStatus.ACTIVE,
    orders: [
      { userAddress: USER_ADDRESSES[0], side: OrderSide.BUY, outcome: Outcome.YES, price: "0.65", quantity: 100, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[1], side: OrderSide.BUY, outcome: Outcome.YES, price: "0.68", quantity: 150, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[2], side: OrderSide.SELL, outcome: Outcome.YES, price: "0.70", quantity: 80, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[0], side: OrderSide.SELL, outcome: Outcome.NO, price: "0.32", quantity: 200, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[3], side: OrderSide.BUY, outcome: Outcome.NO, price: "0.30", quantity: 120, status: OrderStatus.OPEN },
    ],
    positions: [
      { userAddress: USER_ADDRESSES[0], yesShares: 50, noShares: 0, lockedCollateral: "32.50" },
      { userAddress: USER_ADDRESSES[1], yesShares: 100, noShares: 0, lockedCollateral: "68.00" },
      { userAddress: USER_ADDRESSES[2], yesShares: 0, noShares: 30, lockedCollateral: "9.60" },
    ],
  },
  {
    question: "Will ETH flip BTC by end of 2026?",
    endTime: new Date("2026-12-31T23:59:59Z"),
    status: MarketStatus.ACTIVE,
    orders: [
      { userAddress: USER_ADDRESSES[1], side: OrderSide.BUY, outcome: Outcome.YES, price: "0.25", quantity: 200, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[2], side: OrderSide.BUY, outcome: Outcome.YES, price: "0.28", quantity: 180, status: OrderStatus.PARTIALLY_FILLED, filledQuantity: 90 },
      { userAddress: USER_ADDRESSES[3], side: OrderSide.SELL, outcome: Outcome.YES, price: "0.30", quantity: 150, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[4], side: OrderSide.BUY, outcome: Outcome.NO, price: "0.72", quantity: 300, status: OrderStatus.FILLED, filledQuantity: 300 },
      { userAddress: USER_ADDRESSES[0], side: OrderSide.SELL, outcome: Outcome.NO, price: "0.75", quantity: 100, status: OrderStatus.OPEN },
    ],
    positions: [
      { userAddress: USER_ADDRESSES[1], yesShares: 200, noShares: 0, lockedCollateral: "50.00" },
      { userAddress: USER_ADDRESSES[2], yesShares: 90, noShares: 0, lockedCollateral: "25.20" },
      { userAddress: USER_ADDRESSES[4], yesShares: 0, noShares: 300, lockedCollateral: "216.00" },
    ],
  },
  {
    question: "Did SOL reach $200 in January 2026?",
    endTime: new Date("2026-01-31T23:59:59Z"),
    resolutionTime: new Date("2026-02-01T10:00:00Z"),
    status: MarketStatus.RESOLVED,
    outcome: false, // SOL did not reach $200
    orders: [
      { userAddress: USER_ADDRESSES[0], side: OrderSide.BUY, outcome: Outcome.YES, price: "0.45", quantity: 150, status: OrderStatus.FILLED, filledQuantity: 150 },
      { userAddress: USER_ADDRESSES[2], side: OrderSide.BUY, outcome: Outcome.YES, price: "0.48", quantity: 100, status: OrderStatus.FILLED, filledQuantity: 100 },
      { userAddress: USER_ADDRESSES[3], side: OrderSide.SELL, outcome: Outcome.YES, price: "0.50", quantity: 200, status: OrderStatus.FILLED, filledQuantity: 200 },
      { userAddress: USER_ADDRESSES[4], side: OrderSide.BUY, outcome: Outcome.NO, price: "0.52", quantity: 250, status: OrderStatus.FILLED, filledQuantity: 250 },
      { userAddress: USER_ADDRESSES[1], side: OrderSide.SELL, outcome: Outcome.NO, price: "0.55", quantity: 180, status: OrderStatus.FILLED, filledQuantity: 180 },
    ],
    positions: [
      { userAddress: USER_ADDRESSES[0], yesShares: 150, noShares: 0, lockedCollateral: "67.50" },
      { userAddress: USER_ADDRESSES[2], yesShares: 100, noShares: 0, lockedCollateral: "48.00" },
      { userAddress: USER_ADDRESSES[4], yesShares: 0, noShares: 250, lockedCollateral: "130.00" },
      { userAddress: USER_ADDRESSES[1], yesShares: 0, noShares: 180, lockedCollateral: "99.00" },
    ],
  },
  {
    question: "Will the S&P 500 close above 6000 by June 2026?",
    endTime: new Date("2026-06-30T23:59:59Z"),
    status: MarketStatus.ACTIVE,
    orders: [
      { userAddress: USER_ADDRESSES[3], side: OrderSide.BUY, outcome: Outcome.YES, price: "0.40", quantity: 175, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[0], side: OrderSide.BUY, outcome: Outcome.YES, price: "0.42", quantity: 200, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[1], side: OrderSide.SELL, outcome: Outcome.YES, price: "0.45", quantity: 120, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[4], side: OrderSide.BUY, outcome: Outcome.NO, price: "0.58", quantity: 220, status: OrderStatus.OPEN },
      { userAddress: USER_ADDRESSES[2], side: OrderSide.SELL, outcome: Outcome.NO, price: "0.60", quantity: 160, status: OrderStatus.OPEN },
    ],
    positions: [
      { userAddress: USER_ADDRESSES[3], yesShares: 175, noShares: 0, lockedCollateral: "70.00" },
      { userAddress: USER_ADDRESSES[4], yesShares: 0, noShares: 220, lockedCollateral: "127.60" },
    ],
  },
  {
    question: "Will AI achieve AGI by 2027?",
    endTime: new Date("2027-12-31T23:59:59Z"),
    status: MarketStatus.CANCELLED,
    orders: [
      { userAddress: USER_ADDRESSES[0], side: OrderSide.BUY, outcome: Outcome.YES, price: "0.20", quantity: 300, status: OrderStatus.CANCELLED },
      { userAddress: USER_ADDRESSES[1], side: OrderSide.BUY, outcome: Outcome.NO, price: "0.80", quantity: 250, status: OrderStatus.CANCELLED },
    ],
    positions: [],
  },
];

/**
 * Main seed function
 * Can be imported and used in tests
 * 
 * @param options - Optional configuration
 * @param options.clearFirst - Whether to clear existing data before seeding (default: true in dev/test, false in production)
 */
export async function seed(options?: { clearFirst?: boolean }) {
  const isDevelopment = process.env.NODE_ENV === "development" || !process.env.NODE_ENV;
  const isTest = process.env.NODE_ENV === "test";
  const shouldClear = options?.clearFirst ?? (isDevelopment || isTest);

  console.log(" Starting database seed...");
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);

  // Initialize Prisma Client with adapter
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/vatix",
  });

  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.$connect();
    console.log(" Connected to database");

    // Clear existing data for idempotency (always in dev/test, or when explicitly requested)
    if (shouldClear) {
      console.log(" Clearing existing data...");
      await prisma.order.deleteMany();
      await prisma.userPosition.deleteMany();
      await prisma.market.deleteMany();
      console.log(" Existing data cleared");
    }

    // Create markets and related data
    console.log(`\n Creating ${seedData.length} markets...`);

    for (const marketData of seedData) {
      console.log(`\n  Creating market: "${marketData.question}"`);
      console.log(`    Status: ${marketData.status}`);

      // Create market
      const market = await prisma.market.create({
        data: {
          question: marketData.question,
          endTime: marketData.endTime,
          resolutionTime: marketData.resolutionTime,
          oracleAddress: ORACLE_ADDRESS,
          status: marketData.status,
          outcome: marketData.outcome,
        },
      });

      console.log(`     Market created (ID: ${market.id})`);

      // Create orders
      if (marketData.orders.length > 0) {
        console.log(`     Creating ${marketData.orders.length} orders...`);
        for (const orderData of marketData.orders) {
          await prisma.order.create({
            data: {
              marketId: market.id,
              userAddress: orderData.userAddress,
              side: orderData.side,
              outcome: orderData.outcome,
              price: orderData.price,
              quantity: orderData.quantity,
              filledQuantity: orderData.filledQuantity ?? 0,
              status: orderData.status,
            },
          });
        }
        console.log(`     ${marketData.orders.length} orders created`);
      }

      // Create positions
      if (marketData.positions.length > 0) {
        console.log(`     Creating ${marketData.positions.length} positions...`);
        for (const positionData of marketData.positions) {
          await prisma.userPosition.create({
            data: {
              marketId: market.id,
              userAddress: positionData.userAddress,
              yesShares: positionData.yesShares,
              noShares: positionData.noShares,
              lockedCollateral: positionData.lockedCollateral,
              isSettled: marketData.status === MarketStatus.RESOLVED,
            },
          });
        }
        console.log(`     ${marketData.positions.length} positions created`);
      }
    }

    // Summary
    const marketCount = await prisma.market.count();
    const orderCount = await prisma.order.count();
    const positionCount = await prisma.userPosition.count();

    console.log("\n" + "=".repeat(50));
    console.log(" Seed Summary:");
    console.log(`   Markets: ${marketCount}`);
    console.log(`   Orders: ${orderCount}`);
    console.log(`   Positions: ${positionCount}`);
    console.log("=".repeat(50));
    console.log("\n Database seeded successfully!");

  } catch (error) {
    console.error(" Error seeding database:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Run seed if script is executed directly
if (require.main === module) {
  seed()
    .then(() => {
      console.log(" Seed completed!");
      process.exit(0);
    })
    .catch((error) => {
      console.error(" Seed failed:", error);
      process.exit(1);
    });
}
