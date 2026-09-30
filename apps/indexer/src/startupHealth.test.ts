import { describe, it, expect, vi } from "vitest";
import {
  checkStartupHealth,
  checkLiveDependencies,
  checkLiveness,
  checkReadiness,
} from "./startupHealth.js";
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

describe("checkLiveDependencies fail-closed on missing Redis (#1193)", () => {
  const noopSleep = async () => {};

  const okProbe = (name: string): DependencyProbe => ({
    name,
    check: vi.fn().mockResolvedValue(undefined),
  });

  const failingProbe = (name: string, message = "connection refused") => ({
    name,
    check: vi.fn().mockRejectedValue(new Error(message)),
  });

  it("reports not-ready when the redis probe is unreachable in production", async () => {
    const db = okProbe("database");
    const redis = failingProbe("redis", "ECONNREFUSED 127.0.0.1:6379");

    const result = await checkLiveDependencies([db, redis], {
      nodeEnv: "production",
      retries: 0,
      sleep: noopSleep,
    });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.errors).toEqual([
      "redis is not ready: ECONNREFUSED 127.0.0.1:6379",
    ]);
    expect(redis.check).toHaveBeenCalledTimes(1);
  });

  it("does not silently pass when redis is missing from the probe set", async () => {
    // A missing redis probe must not be treated as healthy: the caller is
    // responsible for registering it, and readiness must fail closed when the
    // required dependency is absent from the probe list.
    const db = okProbe("database");

    const result = await checkLiveDependencies([db], {
      nodeEnv: "production",
      retries: 0,
      sleep: noopSleep,
      required: ["database", "redis"],
    });

    expect(result.ready).toBe(false);
    expect(result.errors).toEqual([
      "redis is not ready: required dependency probe is missing",
    ]);
  });

  it("fails closed when redis is unreachable even if other probes succeed", async () => {
    const db = okProbe("database");
    const horizon = okProbe("horizon");
    const redis = failingProbe("redis", "redis down");

    const result = await checkLiveDependencies([db, horizon, redis], {
      nodeEnv: "production",
      retries: 0,
      sleep: noopSleep,
    });

    expect(result.ready).toBe(false);
    expect(result.errors).toEqual(["redis is not ready: redis down"]);
  });

  it("never leaks redis credentials or URLs in error messages", async () => {
    const redis = failingProbe(
      "redis",
      "connect failed for redis://user:secret@redis.internal:6379",
    );

    const result = await checkLiveDependencies([redis], {
      nodeEnv: "production",
      retries: 0,
      sleep: noopSleep,
    });

    expect(result.ready).toBe(false);
    for (const err of result.errors) {
      expect(err).not.toContain("secret");
      expect(err).not.toContain("redis://");
    }
  });
});

describe("checkLiveness (#1081)", () => {
  it("always returns 200 with a correlation id", () => {
    const result = checkLiveness("corr-123");
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("ok");
    expect(result.body.correlationId).toBe("corr-123");
    expect(result.body.errors).toEqual([]);
  });

  it("never includes dependency errors in the liveness response", () => {
    const result = checkLiveness("corr-456");
    expect(result.body.errors).toEqual([]);
  });
});

describe("checkReadiness (#1081)", () => {
  const noopSleep = async () => {};

  const okProbe = (name: string): DependencyProbe => ({
    name,
    check: vi.fn().mockResolvedValue(undefined),
  });

  const failingProbe = (name: string, message = "connection refused") => ({
    name,
    check: vi.fn().mockRejectedValue(new Error(message)),
  });

  it("returns 200 when every probe succeeds", async () => {
    const result = await checkReadiness([okProbe("database")], {
      nodeEnv: "production",
      sleep: noopSleep,
    });

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("ok");
    expect(result.body.errors).toEqual([]);
  });

  it("returns 503 and fails closed when a dependency is down", async () => {
    const result = await checkReadiness([failingProbe("database")], {
      nodeEnv: "production",
      retries: 0,
      sleep: noopSleep,
    });

    expect(result.status).toBe(503);
    expect(result.body.status).toBe("unavailable");
    expect(result.body.errors.length).toBeGreaterThan(0);
  });

  it("returns 503 when redis is unreachable (#1193)", async () => {
    const result = await checkReadiness(
      [okProbe("database"), failingProbe("redis", "redis down")],
      { nodeEnv: "production", retries: 0, sleep: noopSleep },
    );

    expect(result.status).toBe(503);
    expect(result.body.status).toBe("unavailable");
    expect(result.body.errors).toEqual(["redis is not ready: redis down"]);
  });

  it("includes a correlation id in the readiness response", async () => {
    const result = await checkReadiness([okProbe("database")], {
      nodeEnv: "production",
      sleep: noopSleep,
      correlationId: "corr-789",
    });

    expect(result.body.correlationId).toBe("corr-789");
  });
});
