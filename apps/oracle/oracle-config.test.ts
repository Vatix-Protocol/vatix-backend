import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadOracleConfig } from "./oracle-config.js";

describe("oracle-config", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads default config when env is empty", () => {
    const config = loadOracleConfig({});
    expect(config).toBeDefined();
    expect(config.challengeWindowSeconds).toBe(86400);
    expect(config.logLevel).toBe("info");
    expect(config.secretKey).toBeUndefined();
  });

  it("loads config from env", () => {
    const config = loadOracleConfig({
      ORACLE_CHALLENGE_WINDOW_SECONDS: "3600",
      ORACLE_LOG_LEVEL: "debug",
      ORACLE_SECRET_KEY: "secret123",
    });
    expect(config.challengeWindowSeconds).toBe(3600);
    expect(config.logLevel).toBe("debug");
    expect(config.secretKey).toBe("secret123");
  });

  it("throws on invalid challenge window", () => {
    expect(() =>
      loadOracleConfig({ ORACLE_CHALLENGE_WINDOW_SECONDS: "invalid" })
    ).toThrow();
    expect(() =>
      loadOracleConfig({ ORACLE_CHALLENGE_WINDOW_SECONDS: "-1" })
    ).toThrow();
  });

  it("throws on invalid log level", () => {
    expect(() => loadOracleConfig({ ORACLE_LOG_LEVEL: "invalid" })).toThrow();
  });
});
