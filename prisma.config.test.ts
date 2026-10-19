import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("prisma.config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws an error naming DATABASE_URL when it is unset", async () => {
    vi.stubEnv("DATABASE_URL", "");

    await expect(import("./prisma.config")).rejects.toThrow(/DATABASE_URL/);
  });

  it("resolves datasource.url from DATABASE_URL when it is set", async () => {
    const url = "postgresql://user:pass@localhost:5432/db";
    vi.stubEnv("DATABASE_URL", url);

    const mod = await import("./prisma.config");
    const config = mod.default;

    expect(config.datasource.url).toBe(url);
  });
});
