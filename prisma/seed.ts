import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import "dotenv/config";

// Sample Stellar addresses (56 characters, starting with 'G')
const ORACLE_ADDRESS =
  "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const USER_ADDRESSES = [
  "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
  "GCFXHS4GXL6BVUCXBWXGTITROWLVYXQKQLF4YH5O5JT3YZXCYPAFBJZB",
  "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOBD3SDPKFKDCWDI",
  "GBCR5OVQ54S2EKHLBZMK6S5VMWJX4SC5CJWNTB4CGUQQVNTS5MZWFLJW",
  "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
];

interface SeedResult {
  markets: number;
  orders: number;
  positions: number;
}

/**
 * Creates a Prisma client instance for seeding
 */
function createPrismaClient(): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PrismaPg(pool);

  return new PrismaClient({ adapter });
}

/**
 * Clears all existing data from the database
 * Only runs in development environment
 */
async function clearDatabase(prisma: PrismaClient): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    console.log("Skipping database clear in production environment");
    return;
  }

  console.log("Clearing existing data...");

  // Delete in order respecting foreign key constraints
  await prisma.order.deleteMany();
  await prisma.userPosition.deleteMany();
  await prisma.market.deleteMany();

  console.log("Database cleared successfully");
}

/**
 * Creates sample markets with different statuses
 */
async function createMarkets(prisma: PrismaClient) {
  console.log("Creating sample markets...");

  const markets = await prisma.market.createManyAndReturn({
    data: [
      {
        question: "Will BTC reach $100k by March 1, 2026?",
        endTime: new Date("2026-03-01T00:00:00Z"),
        oracleAddress: ORACLE_ADDRESS,
        status: "ACTIVE",
      },
      {
        question: "Will ETH flip BTC by end of 2026?",
        endTime: new Date("2026-12-31T23:59:59Z"),
        oracleAddress: ORACLE_ADDRESS,
        status: "ACTIVE",
      },
      {
        question: "Did SOL reach $200 in January 2026?",
        endTime: new Date("2026-01-31T23:59:59Z"),
        resolutionTime: new Date("2026-02-01T12:00:00Z"),
        oracleAddress: ORACLE_ADDRESS,
        status: "RESOLVED",
        outcome: false,
      },
      {
        question: "Will the Fed cut rates in Q1 2026?",
        endTime: new Date("2026-03-31T23:59:59Z"),
        oracleAddress: ORACLE_ADDRESS,
        status: "ACTIVE",
      },
      {
        question: "Will there be a major exchange hack in 2026?",
        endTime: new Date("2025-06-30T23:59:59Z"),
        oracleAddress: ORACLE_ADDRESS,
        status: "CANCELLED",
      },
    ],
  });

  console.log(`Created ${markets.length} markets`);
  return markets;
}

/**
 * Creates sample orders for each market
 */
async function createOrders(
  prisma: PrismaClient,
  markets: { id: string; status: string }[]
) {
  console.log("Creating sample orders...");

  const ordersData: Array<{
    marketId: string;
    userAddress: string;
    side: "BUY" | "SELL";
    outcome: "YES" | "NO";
    price: number;
    quantity: number;
    filledQuantity: number;
    status: "OPEN" | "FILLED" | "CANCELLED" | "PARTIALLY_FILLED";
  }> = [];

  for (const market of markets) {
    // Skip cancelled markets - they shouldn't have active orders
    if (market.status === "CANCELLED") {
      continue;
    }

    // Create a realistic order book for each market
    // BUY YES orders (bids) at various prices
    ordersData.push(
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[0],
        side: "BUY",
        outcome: "YES",
        price: 0.55,
        quantity: 100,
        filledQuantity: 0,
        status: "OPEN",
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[1],
        side: "BUY",
        outcome: "YES",
        price: 0.52,
        quantity: 250,
        filledQuantity: 0,
        status: "OPEN",
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[2],
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 500,
        filledQuantity: 0,
        status: "OPEN",
      }
    );

    // SELL YES orders (asks) at various prices
    ordersData.push(
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[3],
        side: "SELL",
        outcome: "YES",
        price: 0.58,
        quantity: 150,
        filledQuantity: 0,
        status: "OPEN",
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[4],
        side: "SELL",
        outcome: "YES",
        price: 0.6,
        quantity: 200,
        filledQuantity: 0,
        status: "OPEN",
      }
    );

    // BUY NO orders
    ordersData.push(
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[2],
        side: "BUY",
        outcome: "NO",
        price: 0.42,
        quantity: 300,
        filledQuantity: 0,
        status: "OPEN",
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[3],
        side: "BUY",
        outcome: "NO",
        price: 0.4,
        quantity: 400,
        filledQuantity: 0,
        status: "OPEN",
      }
    );

    // SELL NO orders
    ordersData.push(
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[0],
        side: "SELL",
        outcome: "NO",
        price: 0.45,
        quantity: 200,
        filledQuantity: 0,
        status: "OPEN",
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[1],
        side: "SELL",
        outcome: "NO",
        price: 0.48,
        quantity: 150,
        filledQuantity: 0,
        status: "OPEN",
      }
    );

    // Add some filled and partially filled orders for realism
    ordersData.push(
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[4],
        side: "BUY",
        outcome: "YES",
        price: 0.53,
        quantity: 100,
        filledQuantity: 100,
        status: "FILLED",
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[0],
        side: "SELL",
        outcome: "YES",
        price: 0.53,
        quantity: 100,
        filledQuantity: 100,
        status: "FILLED",
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[1],
        side: "BUY",
        outcome: "NO",
        price: 0.44,
        quantity: 200,
        filledQuantity: 75,
        status: "PARTIALLY_FILLED",
      }
    );
  }

  const orders = await prisma.order.createManyAndReturn({
    data: ordersData,
  });

  console.log(`Created ${orders.length} orders`);
  return orders;
}

/**
 * Creates sample user positions.
 *
 * Field mapping (Prisma camelCase → DB snake_case):
 *   yesShares        → yes_shares        (Int)
 *   noShares         → no_shares         (Int)
 *   lockedCollateral → locked_collateral (Decimal 20,8) — passed as string
 *                      for exact precision; Prisma coerces string → Decimal.
 *   isSettled        → is_settled        (Boolean) — true only for RESOLVED
 *                      markets; CANCELLED markets are not settled.
 */
async function createPositions(
  prisma: PrismaClient,
  markets: { id: string; status: string }[]
) {
  console.log("Creating sample user positions...");

  // UserPosition fields aligned with prisma/schema.prisma UserPosition model.
  // lockedCollateral is provided as a string to avoid floating-point rounding
  // that could silently corrupt Decimal(20,8) storage.
  const positionsData: Array<{
    marketId: string;
    userAddress: string;
    yesShares: number;
    noShares: number;
    lockedCollateral: string;
    isSettled: boolean;
  }> = [];

  for (const market of markets) {
    // Only RESOLVED markets have settled positions; ACTIVE and CANCELLED are
    // both considered unsettled (CANCELLED markets never reach settlement).
    const isSettled = market.status === "RESOLVED";

    positionsData.push(
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[0],
        yesShares: 100,
        noShares: 0,
        lockedCollateral: "55.00000000",
        isSettled,
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[1],
        yesShares: 50,
        noShares: 75,
        lockedCollateral: "60.00000000",
        isSettled,
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[2],
        yesShares: 0,
        noShares: 200,
        lockedCollateral: "80.00000000",
        isSettled,
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[3],
        yesShares: 150,
        noShares: 50,
        lockedCollateral: "100.00000000",
        isSettled,
      },
      {
        marketId: market.id,
        userAddress: USER_ADDRESSES[4],
        yesShares: 100,
        noShares: 0,
        lockedCollateral: "53.00000000",
        isSettled,
      }
    );
  }

  const positions = await prisma.userPosition.createManyAndReturn({
    data: positionsData,
  });

  console.log(`Created ${positions.length} user positions`);
  return positions;
}

/**
 * Main seed function that populates the database with sample data
 * Exported for testing use
 */
export async function seed(prisma?: PrismaClient): Promise<SeedResult> {
  const client = prisma ?? createPrismaClient();
  const shouldDisconnect = !prisma;

  try {
    console.log("Starting database seed...\n");

    // Clear existing data (development only)
    await clearDatabase(client);

    // Create sample data
    const markets = await createMarkets(client);
    const orders = await createOrders(client, markets);
    const positions = await createPositions(client, markets);

    console.log("\nSeed completed successfully!");
    console.log("Summary:");
    console.log(`  - Markets: ${markets.length}`);
    console.log(`  - Orders: ${orders.length}`);
    console.log(`  - Positions: ${positions.length}`);

    return {
      markets: markets.length,
      orders: orders.length,
      positions: positions.length,
    };
  } finally {
    if (shouldDisconnect) {
      await client.$disconnect();
    }
  }
}

// Run seed when executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  seed()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
