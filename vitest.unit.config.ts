import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    testTimeout: 10000,
    exclude: [
      // Integration suites — require a live Postgres via vitest.integration.config.ts
      "tests/integration/**",
      // DB-backed suites outside tests/integration/ that construct a real
      // PrismaClient or hold a pg advisory lock at module/beforeAll scope
      "docs/runbooks/incident-runbook.test.ts",
      "prisma/seed.test.ts",
      "prisma/schema.test.ts",
      "tests/prisma.schema.test.ts",
      "tests/integration.setup.test.ts",
      "src/api/routes/resolutions.test.ts",
    ],
  },
});
