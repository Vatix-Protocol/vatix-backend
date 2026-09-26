import { describe, it, expect } from "vitest";
import {
  PROBE_ERROR_CODES,
  classifyProbeError,
  sanitizeProbeMessage,
} from "./probeErrors.js";

describe("sanitizeProbeMessage", () => {
  it("redacts a full postgres DSN including embedded credentials", () => {
    const message = sanitizeProbeMessage(
      new Error(
        "Can't reach database server at `postgres://vatix:s3cr3t@db.internal:5432/vatix`"
      )
    );

    expect(message).not.toContain("s3cr3t");
    expect(message).not.toContain("db.internal");
    expect(message).not.toContain("postgres://");
    expect(message).toContain("[REDACTED]");
  });

  it("redacts a redis:// URL with a password", () => {
    const message = sanitizeProbeMessage(
      new Error("connect ECONNREFUSED redis://:hunter2@10.0.0.5:6379")
    );

    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("10.0.0.5");
    expect(message).not.toContain("6379");
  });

  it("redacts a bare host:port pair from a socket error", () => {
    const message = sanitizeProbeMessage(
      new Error("connect ECONNREFUSED 10.0.0.5:6379")
    );

    expect(message).not.toContain("10.0.0.5");
    expect(message).not.toContain("6379");
    expect(message).toContain("ECONNREFUSED");
  });

  it("redacts credentials embedded in an https URL", () => {
    const message = sanitizeProbeMessage(
      new Error("request to https://rpc-token@rpc.example/soroban failed")
    );

    expect(message).not.toContain("rpc-token");
    expect(message).not.toContain("rpc.example");
  });

  it("redacts secret-bearing key=value pairs", () => {
    const message = sanitizeProbeMessage(
      new Error("auth rejected: api_key=abcd1234 password=hunter2")
    );

    expect(message).not.toContain("abcd1234");
    expect(message).not.toContain("hunter2");
  });

  it("redacts a Stellar secret seed", () => {
    const seed = `S${"A".repeat(55)}`;
    const message = sanitizeProbeMessage(new Error(`bad seed ${seed}`));

    expect(message).not.toContain(seed);
  });

  it("redacts a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const message = sanitizeProbeMessage(new Error(`token ${jwt} rejected`));

    expect(message).not.toContain(jwt);
  });

  it("keeps a benign message intact so operators keep the signal", () => {
    expect(sanitizeProbeMessage(new Error("connection refused"))).toBe(
      "connection refused"
    );
  });

  it("handles a bare string rejection", () => {
    const message = sanitizeProbeMessage("postgres://u:p@host:5432/db");

    expect(message).not.toContain("u:p");
    expect(message).toContain("[REDACTED]");
  });

  it("never returns an empty string for an empty or exotic rejection", () => {
    expect(sanitizeProbeMessage(new Error(""))).toBe(
      PROBE_ERROR_CODES.DEPENDENCY_UNAVAILABLE
    );
    expect(sanitizeProbeMessage(null)).toBe(
      PROBE_ERROR_CODES.DEPENDENCY_UNAVAILABLE
    );
    expect(sanitizeProbeMessage(undefined)).toBe(
      PROBE_ERROR_CODES.DEPENDENCY_UNAVAILABLE
    );
    expect(sanitizeProbeMessage({})).toBe("[object Object]");
  });

  it("collapses multi-line driver output into a single line", () => {
    const message = sanitizeProbeMessage(
      new Error("connect failed\n    at TCPConnectWrap\n    at listOnConnect")
    );

    expect(message).not.toContain("\n");
  });

  it("truncates a very long message", () => {
    const message = sanitizeProbeMessage(new Error("x".repeat(1000)));

    expect(message.length).toBeLessThanOrEqual(200);
  });
});

describe("classifyProbeError", () => {
  it("classifies a timeout by error code without reading the message", () => {
    const err = Object.assign(new Error("postgres://u:p@h:5432/db"), {
      code: "ETIMEDOUT",
    });

    expect(classifyProbeError(err)).toBe(PROBE_ERROR_CODES.PROBE_TIMEOUT);
  });

  it("classifies a DOM-style TimeoutError by name", () => {
    expect(classifyProbeError(new Error("aborted"))).toBe(
      PROBE_ERROR_CODES.DEPENDENCY_UNAVAILABLE
    );
    expect(
      classifyProbeError(
        Object.assign(new Error("aborted"), { name: "TimeoutError" })
      )
    ).toBe(PROBE_ERROR_CODES.PROBE_TIMEOUT);
  });

  it("defaults to DEPENDENCY_UNAVAILABLE", () => {
    expect(classifyProbeError(new Error("boom"))).toBe(
      PROBE_ERROR_CODES.DEPENDENCY_UNAVAILABLE
    );
  });
});
