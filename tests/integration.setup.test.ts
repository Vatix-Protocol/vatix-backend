import { describe, it, expect, afterAll } from "vitest";
import {
  getTestPrismaClient,
  testUtils,
} from "./setup.js";
import { disconnectTestPrisma } from "./helpers/test-database.js";

describe("Integration Test Setup", () => {
  afterAll(async () => {
    await disconnectTestPrisma();
  });

  it("should initialise the Vitest test environment", () => {
    expect(process.env.NODE_ENV).toBeDefined();
    expect(testUtils.generateStellarAddress()).toMatch(/^G[A-Z0-9]{55}$/);
  });

  it("should load database environment configuration", () => {
    expect(process.env.DATABASE_URL).toBeDefined();
  });

  it("should instantiate the shared test Prisma client without throwing", () => {
    expect(() => getTestPrismaClient()).not.toThrow();
  });
});
