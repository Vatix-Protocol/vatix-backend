import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config';

// Sample Stellar addresses (56 characters, starting with 'G')
const ORACLE_ADDRESS = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ';

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
    throw new Error('DATABASE_URL environment variable is not set');
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
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    console.log('Skipping database clear in production environment');
    return;
  }

  console.log('Clearing existing data...');

  // Delete in order respecting foreign key constraints
  await prisma.order.deleteMany();
  await prisma.userPosition.deleteMany();
  await prisma.market.deleteMany();

  console.log('Database cleared successfully');
}

/**
 * Creates sample markets with different statuses
 */
async function createMarkets(prisma: PrismaClient) {
  console.log('Creating sample markets...');

  const markets = await prisma.market.createManyAndReturn({
    data: [
      {
        question: 'Will BTC reach $100k by March 1, 2026?',
        endTime: new Date('2026-03-01T00:00:00Z'),
        oracleAddress: ORACLE_ADDRESS,
        status: 'ACTIVE',
      },
      {
        question: 'Will ETH flip BTC by end of 2026?',
        endTime: new Date('2026-12-31T23:59:59Z'),
        oracleAddress: ORACLE_ADDRESS,
        status: 'ACTIVE',
      },
      {
        question: 'Did SOL reach $200 in January 2026?',
        endTime: new Date('2026-01-31T23:59:59Z'),
        resolutionTime: new Date('2026-02-01T12:00:00Z'),
        oracleAddress: ORACLE_ADDRESS,
        status: 'RESOLVED',
        outcome: false,
      },
      {
        question: 'Will the Fed cut rates in Q1 2026?',
        endTime: new Date('2026-03-31T23:59:59Z'),
        oracleAddress: ORACLE_ADDRESS,
        status: 'ACTIVE',
      },
      {
        question: 'Will there be a major exchange hack in 2026?',
        endTime: new Date('2025-06-30T23:59:59Z'),
        oracleAddress: ORACLE_ADDRESS,
        status: 'CANCELLED',
      },
    ],
  });

  console.log(`Created ${markets.length} markets`);
  return markets;
}

/**
 * Main seed function that populates the database with sample data
 * Exported for testing use
 */
export async function seed(prisma?: PrismaClient): Promise<SeedResult> {
  const client = prisma ?? createPrismaClient();
  const shouldDisconnect = !prisma;

  try {
    console.log('Starting database seed...\n');

    // Clear existing data (development only)
    await clearDatabase(client);

    // Create sample data
    const markets = await createMarkets(client);

    console.log('\nSeed completed successfully!');
    console.log('Summary:');
    console.log(`  - Markets: ${markets.length}`);

    return {
      markets: markets.length,
      orders: 0,
      positions: 0,
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
      console.error('Seed failed:', error);
      process.exit(1);
    });
}
