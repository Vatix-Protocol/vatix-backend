import { describe, it, expect } from "vitest";
import {
  MAX_REDACTION_DEPTH,
  REDACTED,
  REDACTION_TRUNCATED,
  isSensitiveKey,
  redactObject,
  redactMeta,
  redactText,
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

  // Regression: the depth guard used to `return value` unchanged, which turned
  // redaction OFF below the limit and logged nested secrets in plaintext.
  it("fails closed past the depth limit instead of leaking the subtree", () => {
    let deep: Record<string, unknown> = { password: "hunter2-must-not-leak" };
    for (let i = 0; i < MAX_REDACTION_DEPTH + 2; i++) {
      deep = { nested: deep };
    }

    const result = JSON.stringify(redactObject(deep));
    expect(result).not.toContain("hunter2-must-not-leak");
    expect(result).toContain(REDACTION_TRUNCATED);
  });

  it("still redacts at the shallow depths operators actually use", () => {
    expect(redactObject({ a: { b: { password: "x" } } })).toEqual({
      a: { b: { password: REDACTED } },
    });
  });

  it("terminates on a circular object", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;

    expect(redactObject(circular)).toEqual({
      name: "root",
      self: REDACTION_TRUNCATED,
    });
  });

  it("terminates on a self-referencing array", () => {
    const arr: unknown[] = ["a"];
    arr.push(arr);

    expect(() => redactObject({ arr })).not.toThrow();
  });

  it("redacts secrets reachable before the cycle", () => {
    const inner: Record<string, unknown> = { password: "x" };
    inner.loop = inner;

    const output = JSON.stringify(redactObject({ inner, apiKey: "y" }));
    expect(output).not.toContain('"x"');
    expect(output).not.toContain('"y"');
  });

  it("allows the same object to appear twice in sibling branches", () => {
    // The cycle guard tracks the current path, not everything ever visited, so
    // a repeated (non-circular) reference must still be fully redacted.
    const shared = { password: "x" };

    expect(redactObject({ left: shared, right: shared })).toEqual({
      left: { password: REDACTED },
      right: { password: REDACTED },
    });
  });
});

describe("redactText (#1138)", () => {
  it("redacts URL userinfo passwords", () => {
    expect(redactText("redis://admin:hunter2@cache:6379")).toBe(
      `redis://admin:${REDACTED}@cache:6379`
    );
  });

  it("handles a password containing url-encoded characters", () => {
    expect(redactText("postgres://u:p%40ss%2Fword@db:5432/vatix")).toBe(
      `postgres://u:${REDACTED}@db:5432/vatix`
    );
  });

  it("redacts bearer tokens", () => {
    expect(redactText("Authorization: Bearer abc.def.ghi")).toBe(
      `Authorization: Bearer ${REDACTED}`
    );
  });

  it("redacts key=value credentials", () => {
    expect(redactText("password=hunter2 secret=s3cr3t")).toBe(
      `password=${REDACTED} secret=${REDACTED}`
    );
  });

  it("redacts quoted values", () => {
    expect(redactText(`api_key="abcdef123456"`)).toBe(`api_key=${REDACTED}`);
  });

  it("leaves ordinary prose untouched", () => {
    const line = "Archived 42 events for market mkt_abc in 120ms";
    expect(redactText(line)).toBe(line);
  });

  it("does not mangle a URL with no credentials", () => {
    expect(redactText("https://api.example.com/v1/prices?limit=10")).toBe(
      "https://api.example.com/v1/prices?limit=10"
    );
  });

  it("is safe on empty and non-string input", () => {
    expect(redactText("")).toBe("");
    expect(redactText(undefined as unknown as string)).toBeUndefined();
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
