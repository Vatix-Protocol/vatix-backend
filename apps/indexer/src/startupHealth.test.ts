import { describe, it, expect, vi } from "vitest";
import { checkStartupHealth, checkLiveDependencies } from "./startupHealth.js";
import type { DependencyProbe } from "./startupHealth.js";

const validInput = {
  cursor: "12345",
  networkId: "mainnet",
  cursorKey: "ingestion",
  databaseUrl: "postgresql://user:pass@localhost:5432/vatix",
};

describe("checkStartupHealth", () => {
  it("returns 200 for valid input", () => {
    expect(checkStartupHealth(validInput)).toMatchObject({
      status: 200,
      valid: true,
      errors: [],
    });
  });

  it("accepts null cursor (no persisted cursor yet)", () => {
    const result = checkStartupHealth({ ...validInput, cursor: null });
    expect(result.status).toBe(200);
    expect(result.valid).toBe(true);
  });

  it("returns 400 when databaseUrl is missing", () => {
    const result = checkStartupHealth({
      ...validInput,
      databaseUrl: undefined,
    });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("DATABASE_URL"))).toBe(true);
  });

  it("returns 400 when databaseUrl is an empty string", () => {
    const result = checkStartupHealth({ ...validInput, databaseUrl: "" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("DATABASE_URL"))).toBe(true);
  });

  it("returns 400 when databaseUrl is whitespace only", () => {
    const result = checkStartupHealth({ ...validInput, databaseUrl: "   " });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
  });

  it("returns 400 when networkId is empty", () => {
    const result = checkStartupHealth({ ...validInput, networkId: "" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("networkId"))).toBe(true);
  });

  it("returns 400 when networkId is whitespace only", () => {
    const result = checkStartupHealth({ ...validInput, networkId: "   " });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
  });

  it("returns 400 when cursorKey is empty", () => {
    const result = checkStartupHealth({ ...validInput, cursorKey: "" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cursorKey"))).toBe(true);
  });

  it("returns 400 when cursor is non-numeric", () => {
    const result = checkStartupHealth({
      ...validInput,
      cursor: "not-a-number",
    });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cursor"))).toBe(true);
  });

  it("returns 400 when cursor is negative", () => {
    const result = checkStartupHealth({ ...validInput, cursor: "-1" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
  });

  it("returns 400 when cursor is a float", () => {
    const result = checkStartupHealth({ ...validInput, cursor: "1.5" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
  });

  it("collects multiple validation errors", () => {
    const result = checkStartupHealth({
      cursor: "bad",
      networkId: "",
      cursorKey: "",
      databaseUrl: undefined,
    });
    expect(result.status).toBe(400);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("checkLiveDependencies (#947)", () => {
  const noopSleep = async () => {};

  const okProbe = (name: string): DependencyProbe => ({
    name,
    check: vi.fn().mockResolvedValue(undefined),
  });

  const failingProbe = (name: string, message = "connection refused") => ({
    name,
    check: vi.fn().mockRejectedValue(new Error(message)),
  });

  it("skips the check in development by default (no network access required)", async () => {
    const db = failingProbe("database");
    const result = await checkLiveDependencies([db], {
      nodeEnv: "development",
    });

    expect(result).toEqual({ ready: true, skipped: true, errors: [] });
    expect(db.check).not.toHaveBeenCalled();
  });

  it("skips the check in test by default", async () => {
    const db = failingProbe("database");
    const result = await checkLiveDependencies([db], { nodeEnv: "test" });

    expect(result.skipped).toBe(true);
    expect(db.check).not.toHaveBeenCalled();
  });

  it("runs the check in production and succeeds when every probe succeeds", async () => {
    const db = okProbe("database");
    const horizon = okProbe("horizon");

    const result = await checkLiveDependencies([db, horizon], {
      nodeEnv: "production",
      sleep: noopSleep,
    });

    expect(result).toEqual({ ready: true, skipped: false, errors: [] });
    expect(db.check).toHaveBeenCalledTimes(1);
    expect(horizon.check).toHaveBeenCalledTimes(1);
  });

  it("runs the check outside production when force is set", async () => {
    const db = failingProbe("database");

    const result = await checkLiveDependencies([db], {
      nodeEnv: "development",
      force: true,
      retries: 0,
      sleep: noopSleep,
    });

    expect(result.skipped).toBe(false);
    expect(db.check).toHaveBeenCalledTimes(1);
  });

  it("retries a failing probe before giving up, and reports not-ready after exhausting retries", async () => {
    const check = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await checkLiveDependencies([{ name: "database", check }], {
      nodeEnv: "production",
      retries: 3,
      sleep,
    });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.errors).toEqual(["database is not ready: ECONNREFUSED"]);
    // 1 initial + 3 retries = 4 attempts; sleeps between attempts only (3).
    expect(check).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("recovers if a probe fails then succeeds within the retry budget", async () => {
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("not ready yet"))
      .mockResolvedValueOnce(undefined);

    const result = await checkLiveDependencies([{ name: "horizon", check }], {
      nodeEnv: "production",
      retries: 3,
      sleep: noopSleep,
    });

    expect(result.ready).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("aggregates errors across multiple failing probes and still probes every dependency", async () => {
    const db = failingProbe("database", "db down");
    const horizon = failingProbe("horizon", "horizon down");

    const result = await checkLiveDependencies([db, horizon], {
      nodeEnv: "production",
      retries: 0,
      sleep: noopSleep,
    });

    expect(result.ready).toBe(false);
    expect(result.errors).toEqual([
      "database is not ready: db down",
      "horizon is not ready: horizon down",
    ]);
    expect(db.check).toHaveBeenCalledTimes(1);
    expect(horizon.check).toHaveBeenCalledTimes(1);
  });
});
