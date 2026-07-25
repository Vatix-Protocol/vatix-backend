import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getAnalyticsPrismaClient,
  disconnectAnalyticsPrisma,
  isAnalyticsDatabaseConfigured,
} from "./analytics-prisma.js";

describe("Analytics Prisma Client Service (#743)", () => {
  afterEach(async () => {
    await disconnectAnalyticsPrisma();
    delete process.env.ANALYTICS_DATABASE_URL;
    vi.restoreAllMocks();
  });

  it("returns a defined client instance", () => {
    const client = getAnalyticsPrismaClient();
    expect(client).toBeDefined();
  });

  it("returns the same instance (singleton behavior)", () => {
    const client1 = getAnalyticsPrismaClient();
    const client2 = getAnalyticsPrismaClient();
    expect(client1).toBe(client2);
  });

  it("falls back to the primary database when ANALYTICS_DATABASE_URL is unset", () => {
    expect(process.env.ANALYTICS_DATABASE_URL).toBeUndefined();
    expect(isAnalyticsDatabaseConfigured()).toBe(false);

    const client = getAnalyticsPrismaClient();
    expect(client).toBeDefined();
  });

  it("executes a simple query successfully against the resolved connection", async () => {
    const client = getAnalyticsPrismaClient();
    const result = await client.$queryRaw<
      Array<{ result: number }>
    >`SELECT 1 as result`;
    expect(result[0].result).toBe(1);
  });

  it("creates a new instance after disconnect", async () => {
    const client1 = getAnalyticsPrismaClient();
    await disconnectAnalyticsPrisma();
    const client2 = getAnalyticsPrismaClient();
    expect(client2).toBeDefined();
    expect(client2).not.toBe(client1);
  });

  it("handles multiple disconnect calls gracefully", async () => {
    getAnalyticsPrismaClient();
    await disconnectAnalyticsPrisma();
    await expect(disconnectAnalyticsPrisma()).resolves.toBeUndefined();
  });
});
