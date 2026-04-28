import { describe, it, expect } from "vitest";
import {
  REDACTED,
  isSensitiveKey,
  redactObject,
  redactMeta,
} from "./logRedactor.js";

describe("isSensitiveKey", () => {
  it("matches known sensitive keys (exact)", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("private_key")).toBe(true);
    expect(isSensitiveKey("secret")).toBe(true);
    expect(isSensitiveKey("cookie")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSensitiveKey("Password")).toBe(true);
    expect(isSensitiveKey("TOKEN")).toBe(true);
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("API_KEY")).toBe(true);
  });

  it("does not match safe keys", () => {
    expect(isSensitiveKey("userId")).toBe(false);
    expect(isSensitiveKey("marketId")).toBe(false);
    expect(isSensitiveKey("statusCode")).toBe(false);
    expect(isSensitiveKey("durationMs")).toBe(false);
  });
});

describe("redactObject", () => {
  it("replaces sensitive top-level fields with REDACTED", () => {
    const result = redactObject({
      userId: "u1",
      password: "s3cr3t",
      token: "tok123",
    });
    expect(result).toEqual({
      userId: "u1",
      password: REDACTED,
      token: REDACTED,
    });
  });

  it("leaves non-sensitive fields untouched", () => {
    const result = redactObject({ statusCode: 200, path: "/health" });
    expect(result).toEqual({ statusCode: 200, path: "/health" });
  });

  it("redacts nested sensitive fields", () => {
    const result = redactObject({
      user: { id: "u1", password: "hunter2" },
      meta: { api_key: "key-abc" },
    });
    expect(result).toEqual({
      user: { id: "u1", password: REDACTED },
      meta: { api_key: REDACTED },
    });
  });

  it("handles arrays by redacting objects inside them", () => {
    const result = redactObject([
      { name: "alice", secret: "shh" },
      { name: "bob", secret: "shh2" },
    ]);
    expect(result).toEqual([
      { name: "alice", secret: REDACTED },
      { name: "bob", secret: REDACTED },
    ]);
  });

  it("returns primitives unchanged", () => {
    expect(redactObject("hello")).toBe("hello");
    expect(redactObject(42)).toBe(42);
    expect(redactObject(null)).toBe(null);
    expect(redactObject(undefined)).toBe(undefined);
  });

  it("does not mutate the original object", () => {
    const original = { password: "secret", name: "alice" };
    redactObject(original);
    expect(original.password).toBe("secret");
  });
});

describe("redactMeta", () => {
  it("returns undefined when called with undefined", () => {
    expect(redactMeta(undefined)).toBeUndefined();
  });

  it("redacts sensitive keys in a meta object", () => {
    const result = redactMeta({ requestId: "r1", authorization: "Bearer xyz" });
    expect(result).toEqual({ requestId: "r1", authorization: REDACTED });
  });
});
