import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config();

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.spec.ts"],
    // File parallelism enabled - database tests use advisory locks for synchronization
    fileParallelism: true,
    // Use forks for proper process isolation (required for advisory locks to work)
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "**/*.test.ts"],
    },
  },
});
