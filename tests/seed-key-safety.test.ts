/**
 * Tests for seed data safety policy (issue #969).
 *
 * Verifies that:
 *   1. The seed function refuses to run in NODE_ENV=production (fail-fast).
 *   2. The ORACLE_ADDRESS placeholder is not a known real Stellar keypair format
 *      that could be mistaken for a live signer.
 *   3. Placeholder addresses match the documented naming convention so operators
 *      can visually identify them as non-production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Import seed with a fresh module registry so we can override NODE_ENV
 * between tests without the module-level closure retaining a stale value.
 */
async function importSeed() {
  // vi.resetModules() ensures each test gets a fresh module tree
  return import("../prisma/seed.js");
}

// ---------------------------------------------------------------------------
// Production guard
// ---------------------------------------------------------------------------

describe("Seed: production guard (issue #969)", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.resetModules();
  });

  it("throws when NODE_ENV=production to prevent seeding live databases", async () => {
    process.env.NODE_ENV = "production";
    vi.resetModules();

    const { seed } = await importSeed();

    // A stub Prisma client — we should never reach DB calls
    const stubPrisma = {} as any;

    await expect(seed(stubPrisma)).rejects.toThrow(/must not run in production/i);
  });

  it("does NOT throw when NODE_ENV=development", async () => {
    process.env.NODE_ENV = "development";
    vi.resetModules();

    const { seed } = await importSeed();

    // Minimal stub that satisfies the seed function's call sites
    const stubPrisma = {
      order: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      userPosition: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      market: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createManyAndReturn: vi.fn().mockResolvedValue([]),
      },
      $disconnect: vi.fn().mockResolvedValue(undefined),
    } as any;

    // Should not throw (even if no data is created due to stub)
    await expect(seed(stubPrisma)).resolves.toMatchObject({
      markets: expect.any(Number),
    });
  });

  it("does NOT throw when NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    vi.resetModules();

    const { seed } = await importSeed();

    const stubPrisma = {
      order: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      userPosition: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      market: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createManyAndReturn: vi.fn().mockResolvedValue([]),
      },
      $disconnect: vi.fn().mockResolvedValue(undefined),
    } as any;

    await expect(seed(stubPrisma)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Placeholder address policy
// ---------------------------------------------------------------------------

describe("Seed: placeholder address policy (issue #969)", () => {
  /**
   * Known real Stellar public keys that appeared in early seed data.
   * These must NOT exist in the seed file after the fix.
   */
  const KNOWN_REAL_KEYS = [
    "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ",
    "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
    "GCFXHS4GXL6BVUCXBWXGTITROWLVYXQKQLF4YH5O5JT3YZXCYPAFBJZB",
    "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOBD3SDPKFKDCWDI",
    "GBCR5OVQ54S2EKHLBZMK6S5VMWJX4SC5CJWNTB4CGUQQVNTS5MZWFLJW",
    "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
  ];

  it("seed.ts does not contain any known real Stellar public keys", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");

    const seedSource = readFileSync(
      resolve(process.cwd(), "prisma/seed.ts"),
      "utf-8"
    );

    for (const key of KNOWN_REAL_KEYS) {
      expect(seedSource).not.toContain(key);
    }
  });

  it("ORACLE_ADDRESS placeholder contains 'SEED' and 'PLACEHOLDER' in its name", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");

    const seedSource = readFileSync(
      resolve(process.cwd(), "prisma/seed.ts"),
      "utf-8"
    );

    // The replacement pattern must include both markers so operators
    // cannot mistake it for a real address.
    const oracleLineMatch = seedSource.match(
      /const ORACLE_ADDRESS\s*=\s*["']([^"']+)["']/
    );
    expect(oracleLineMatch).not.toBeNull();
    const oracleAddress = oracleLineMatch![1];

    expect(oracleAddress.toUpperCase()).toContain("SEED");
    expect(oracleAddress.toUpperCase()).toContain("PLACEHOLDER");
  });

  it(".env.example warns operators not to use seed keys as oracle signers", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");

    const envExample = readFileSync(
      resolve(process.cwd(), ".env.example"),
      "utf-8"
    );

    // The comment block around ORACLE_SECRET_KEY must contain the warning
    expect(envExample).toMatch(/seed/i);
    expect(envExample).toMatch(/ORACLE_SECRET_KEY/);
  });
});
