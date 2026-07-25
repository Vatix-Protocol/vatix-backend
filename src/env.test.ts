import { describe, it, expect } from "vitest";
import { parseApiEnv, apiEnvSchema } from "./env.js";

const VALID_ENV = {
  NODE_ENV: "development",
  PORT: "3000",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  ORACLE_CHALLENGE_WINDOW_SECONDS: "86400",
  ORACLE_POLL_INTERVAL_MS: "30000",
};

describe("parseApiEnv", () => {
  it("loads valid API env without throwing", () => {
    const env = parseApiEnv(VALID_ENV);
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(env.ORACLE_CHALLENGE_WINDOW_SECONDS).toBe(86400);
    expect(env.ORACLE_POLL_INTERVAL_MS).toBe(30_000);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() =>
      parseApiEnv({ ...VALID_ENV, DATABASE_URL: undefined })
    ).toThrow("Missing required environment variable: DATABASE_URL");
  });

  it("throws when DATABASE_URL uses an invalid scheme", () => {
    expect(() =>
      parseApiEnv({ ...VALID_ENV, DATABASE_URL: "mysql://localhost/db" })
    ).toThrow("postgresql://");
  });

  it("throws on invalid NODE_ENV", () => {
    expect(() => parseApiEnv({ ...VALID_ENV, NODE_ENV: "staging" })).toThrow(
      "NODE_ENV must be one of development | test | production"
    );
  });

  it("throws on invalid PORT (non-integer)", () => {
    expect(() => parseApiEnv({ ...VALID_ENV, PORT: "abc" })).toThrow("PORT");
  });

  it("throws on PORT exceeding max (65535)", () => {
    expect(() => parseApiEnv({ ...VALID_ENV, PORT: "99999" })).toThrow("65535");
  });

  it("throws when ORACLE_POLL_INTERVAL_MS is below minimum", () => {
    expect(() =>
      parseApiEnv({ ...VALID_ENV, ORACLE_POLL_INTERVAL_MS: "1000" })
    ).toThrow("ORACLE_POLL_INTERVAL_MS must be >= 5000");
  });

  it("applies defaults when optional values are omitted", () => {
    const env = parseApiEnv({
      DATABASE_URL: VALID_ENV.DATABASE_URL,
    });
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.ORACLE_POLL_INTERVAL_MS).toBe(30_000);
  });

  it("exports a schema for documentation and tooling", () => {
    expect(apiEnvSchema.shape.DATABASE_URL).toBeDefined();
  });
});
