import { describe, it, expect } from "vitest";
import {
  REDACTED,
  REDACTION_TRUNCATED,
  MAX_REDACTION_DEPTH,
  isSensitiveKey,
  redactObject,
  redactText,
  redactMeta,
} from "./logRedactor";

describe("isSensitiveKey", () => {
  it("matches known sensitive keys case-insensitively", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("PASSWORD")).toBe(true);
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
  });

  it("does not match ordinary keys", () => {
    expect(isSensitiveKey("marketId")).toBe(false);
    expect(isSensitiveKey("streamId")).toBe(false);
    expect(isSensitiveKey("hash")).toBe(false);
  });
});

describe("redactObject", () => {
  it("redacts sensitive keys at the top level", () => {
    const result = redactObject({ password: "hunter2", user: "alice" });
    expect(result).toEqual({ password: REDACTED, user: "alice" });
  });

  it("redacts sensitive keys nested in objects and arrays", () => {
    const result = redactObject({
      nested: { token: "abc123" },
      list: [{ secret: "s3cr3t" }, { ok: true }],
    });
    expect(result).toEqual({
      nested: { token: REDACTED },
      list: [{ secret: REDACTED }, { ok: true }],
    });
  });

  it("does not mutate the original object", () => {
    const original = { password: "hunter2" };
    redactObject(original);
    expect(original.password).toBe("hunter2");
  });

  it("returns non-object values as-is", () => {
    expect(redactObject("plain")).toBe("plain");
    expect(redactObject(42)).toBe(42);
    expect(redactObject(null)).toBe(null);
  });

  it("fails closed past MAX_REDACTION_DEPTH and never leaks the secret", () => {
    const secret = "deep-secret-value";
    // Build a chain of plain objects deeper than the limit, with a sensitive
    // key at the very bottom. The depth guard must truncate before reaching it.
    let fixture: Record<string, unknown> = { password: secret };
    for (let i = 0; i < MAX_REDACTION_DEPTH + 5; i++) {
      fixture = { child: fixture };
    }

    const result = redactObject(fixture);
    const serialized = JSON.stringify(result);

    expect(serialized).toContain(REDACTION_TRUNCATED);
    expect(serialized).not.toContain(secret);
  });

  it("truncates a self-referencing object without throwing", () => {
    const a: any = {};
    a.self = a;

    let result: unknown;
    expect(() => {
      result = redactObject(a);
    }).not.toThrow();

    expect(JSON.stringify(result)).toContain(REDACTION_TRUNCATED);
  });

  it("truncates a self-referencing array without throwing", () => {
    const a: any[] = [];
    a.push(a);

    let result: unknown;
    expect(() => {
      result = redactObject(a);
    }).not.toThrow();

    expect(JSON.stringify(result)).toContain(REDACTION_TRUNCATED);
  });

  it("does not throw when a getter throws and replaces the key", () => {
    const hostile = {
      safe: "ok",
      get boom(): unknown {
        throw new Error("x");
      },
    };

    let result: any;
    expect(() => {
      result = redactObject(hostile);
    }).not.toThrow();

    expect(result.safe).toBe("ok");
    expect(result.boom).toBe(REDACTION_TRUNCATED);
  });
});

describe("redactText", () => {
  it("scrubs URL userinfo passwords", () => {
    expect(redactText("redis://user:pass@host:6379")).toBe(
      `redis://user:${REDACTED}@host:6379`
    );
  });

  it("scrubs key=value secrets", () => {
    expect(redactText("password=hunter2")).toBe(`password=${REDACTED}`);
  });

  it("scrubs bearer tokens", () => {
    expect(redactText("Authorization: Bearer abc.def.ghi")).toBe(
      `Authorization: Bearer ${REDACTED}`
    );
  });

  it("leaves ordinary prose untouched", () => {
    expect(redactText("market 0xabc settled")).toBe("market 0xabc settled");
  });
});

describe("redactMeta", () => {
  it("returns undefined for undefined input", () => {
    expect(redactMeta(undefined)).toBeUndefined();
  });

  it("redacts sensitive fields in metadata", () => {
    expect(redactMeta({ token: "abc", id: 1 })).toEqual({
      token: REDACTED,
      id: 1,
    });
  });
});
