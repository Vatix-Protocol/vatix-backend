import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for issue #990: the Prisma seed path must run with only a
 * Postgres connection. A Redis import in the seed script — or in the helpers
 * the seed tests pull in — would make `pnpm prisma:seed` and the seed test
 * suite fail in any environment without a live Redis, silently in CI and
 * loudly for operators bootstrapping a database.
 */
const here = dirname(fileURLToPath(import.meta.url));

const REDIS_IMPORT_PATTERNS = [
  /from\s+["'][^"']*services\/redis(?:\.js)?["']/,
  /require\(\s*["'][^"']*services\/redis/,
  /from\s+["']ioredis["']/,
  /require\(\s*["']ioredis["']\)/,
];

describe("Prisma seed — no live Redis dependency (#990)", () => {
  const files = [
    "seed.ts",
    "seed.test.ts",
    "schema.test.ts",
    "../tests/helpers/test-database.ts",
    "../tests/setup.ts",
  ];

  it.each(files)("%s does not import a Redis client", (relativePath) => {
    const source = readFileSync(resolve(here, relativePath), "utf8");

    for (const pattern of REDIS_IMPORT_PATTERNS) {
      expect(
        pattern.test(source),
        `${relativePath} must not import Redis (matched ${pattern})`
      ).toBe(false);
    }
  });

  it("seed() refuses to run when NODE_ENV=production", async () => {
    const { seed } = await import("./seed");
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      await expect(seed()).rejects.toThrow(/must not run in production/);
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });
});
