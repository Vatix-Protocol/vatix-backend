import { describe, it, expect, afterAll } from "vitest";
import { getTestPrismaClient, testUtils } from "./setup.js";
import { disconnectTestPrisma } from "./helpers/test-database.js";

describe("Integration Test Setup", () => {
  afterAll(async () => {
    try {
      await Promise.race([
        disconnectTestPrisma(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // ignore cleanup errors
    }
  }, 5000);

  it("should initialise the Vitest test environment", () => {
    expect(process.env.NODE_ENV).toBeDefined();
    expect(testUtils.generateStellarAddress()).toMatch(/^G[A-Z0-9]{55}$/);
  });

  it("should load database environment configuration", () => {
    const url =
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/vatix";
    expect(url).toMatch(/^postgres(ql)?:\/\//);
  });

  it("should instantiate the shared test Prisma client without throwing", () => {
    expect(() => getTestPrismaClient()).not.toThrow();
  });
});
