/**
 * Oracle health server — opt-in bind policy and deny-by-default exposure
 * (#1116).
 */

import { describe, it, expect } from "vitest";
import {
  resolveHealthServerOptions,
  isLoopbackHost,
  startHealthServer,
} from "./health-server.js";

describe("resolveHealthServerOptions (#1116)", () => {
  it("is disabled unless ORACLE_HEALTH_PORT is set", () => {
    expect(resolveHealthServerOptions({})).toBeNull();
  });

  it("defaults to loopback so the probe surface is not routable by default", () => {
    expect(resolveHealthServerOptions({ ORACLE_HEALTH_PORT: "9099" })).toEqual({
      host: "127.0.0.1",
      port: 9099,
    });
  });

  it("honours an explicit host and token", () => {
    expect(
      resolveHealthServerOptions({
        ORACLE_HEALTH_PORT: "9099",
        ORACLE_HEALTH_HOST: "0.0.0.0",
        ORACLE_HEALTH_TOKEN: "tok",
      })
    ).toEqual({ host: "0.0.0.0", port: 9099, requiredToken: "tok" });
  });

  it("rejects an invalid port", () => {
    expect(() =>
      resolveHealthServerOptions({ ORACLE_HEALTH_PORT: "not-a-port" })
    ).toThrow(/ORACLE_HEALTH_PORT/);
    expect(() =>
      resolveHealthServerOptions({ ORACLE_HEALTH_PORT: "70000" })
    ).toThrow(/ORACLE_HEALTH_PORT/);
  });

  it("refuses a non-loopback production bind without a token", () => {
    expect(() =>
      resolveHealthServerOptions({
        NODE_ENV: "production",
        ORACLE_HEALTH_PORT: "9099",
        ORACLE_HEALTH_HOST: "0.0.0.0",
      })
    ).toThrow(/ORACLE_HEALTH_TOKEN/);
  });

  it("allows a non-loopback production bind when a token is set", () => {
    expect(
      resolveHealthServerOptions({
        NODE_ENV: "production",
        ORACLE_HEALTH_PORT: "9099",
        ORACLE_HEALTH_HOST: "0.0.0.0",
        ORACLE_HEALTH_TOKEN: "tok",
      })
    ).toEqual({ host: "0.0.0.0", port: 9099, requiredToken: "tok" });
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

describe("startHealthServer (#1116)", () => {
  it("does not start a server when the feature is disabled", async () => {
    await expect(startHealthServer({}, {})).resolves.toBeUndefined();
  });
});
