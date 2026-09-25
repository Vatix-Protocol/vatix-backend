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
    const result = await checkReadiness(
      [okProbe("db"), okProbe("redis")],
      { correlationId: "corr-789", sleep: noopSleep },
    );

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("ok");
    expect(result.body.correlationId).toBe("corr-789");
    expect(result.body.errors).toEqual([]);
  });

  it("returns 503 with DEPENDENCY_UNAVAILABLE when a probe fails", async () => {
    const result = await checkReadiness(
      [failingProbe("db", "ECONNREFUSED")],
      { correlationId: "corr-abc", sleep: noopSleep },
    );

    expect(result.status).toBe(503);
    expect(result.body.status).toBe("unavailable");
    expect(result.body.correlationId).toBe("corr-abc");
    expect(result.body.errors).toEqual([
      { dependency: "db", code: "DEPENDENCY_UNAVAILABLE" },
    ]);
  });

  it("never leaks connection strings or internal addresses in errors", async () => {
    const result = await checkReadiness(
      [
        failingProbe(
          "db",
          "connect ECONNREFUSED postgres://user:secret@10.0.0.5:5432/vatix",
        ),
      ],
      { correlationId: "corr-secret", sleep: noopSleep },
    );

    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("10.0.0.5");
  });

  it("returns 503 with PROBE_TIMEOUT when a probe exceeds the timeout", async () => {
    const result = await checkReadiness(
      [
        {
          name: "slow-db",
          check: async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
          },
        },
      ],
      { correlationId: "corr-timeout", timeoutMs: 10, sleep: noopSleep },
    );

    expect(result.status).toBe(503);
    expect(result.body.errors).toEqual([
      { dependency: "slow-db", code: "PROBE_TIMEOUT" },
    ]);
  });

  it("aggregates errors across multiple failing probes", async () => {
    const result = await checkReadiness(
      [
        failingProbe("db", "db down"),
        failingProbe("redis", "redis down"),
      ],
      { correlationId: "corr-multi", sleep: noopSleep },
    );

    expect(result.status).toBe(503);
    expect(result.body.errors).toEqual([
      { dependency: "db", code: "DEPENDENCY_UNAVAILABLE" },
      { dependency: "redis", code: "DEPENDENCY_UNAVAILABLE" },
    ]);
  });

  it("passes the correlation id through to the response for log/trace stitching", async () => {
    const result = await checkReadiness(
      [okProbe("db")],
      { correlationId: "corr-trace", sleep: noopSleep },
    );

    expect(result.body.correlationId).toBe("corr-trace");
  });
});
