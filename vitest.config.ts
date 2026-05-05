import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config();

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.spec.ts"],
    // Global setup file for test utilities
    setupFiles: ["./tests/setup.ts"],
    // File parallelism enabled - database tests use advisory locks for synchronization
    fileParallelism: true,
    // Use forks for proper process isolation (required for advisory locks to work)
    pool: "forks",
    // Test timeout
    testTimeout: 30000,
    // Hook timeout
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "**/*.test.ts",
        "**/*.spec.ts",
        "tests/",
        "scripts/",
        "coverage/",
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
});
