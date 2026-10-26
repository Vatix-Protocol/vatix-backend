import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { resolve } from "path";

config();

const sharedSrc = resolve(import.meta.dirname, "packages/shared/src");

export default defineConfig({
  resolve: {
    alias: {
      // Resolve `@vatix/shared/...` workspace imports to the TypeScript sources.
      "@vatix/shared": sharedSrc,
      // Resolve deep relative imports like `../../../packages/shared/src/logger.js`
      // that some src/ modules use when not going through the package name.
      [resolve(import.meta.dirname, "packages/shared/src")]: sharedSrc,
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.spec.ts"],
    // Global setup file for test utilities
    setupFiles: ["./tests/setup.ts"],
    // Serialize test files — DB tests share one Postgres instance and advisory
    // locks block across processes, causing hook timeouts when files run in parallel.
    fileParallelism: false,
    // Use forks for proper process isolation (required for advisory locks to work)
    pool: "forks",
    // Test timeout
    testTimeout: 30000,
    // Hook timeout
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // Measure every source file, not just the ones a test happens to import,
      // so untested modules count against the gate.
      include: ["src/**/*.ts", "apps/**/*.ts", "packages/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "src/generated/**"],
      // Fail the run when coverage drops below these floors. Keys must sit
      // directly under `thresholds`: any other key (e.g. Jest's `global`) is
      // read as a file glob and silently enforces nothing. This is a ratchet —
      // raise the floors as coverage improves; never lower them to make CI pass.
      // See docs/testing.md#coverage-gates.
      thresholds: {
        statements: 65,
        branches: 64,
        functions: 64,
        lines: 65,
      },
    },
  },
});
