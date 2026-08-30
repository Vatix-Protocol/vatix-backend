import { describe, it, expect, afterEach } from "vitest";
import { safeJsonParse, safeJsonSanitize, UnsafeJsonError } from "./safeJson.js";

describe("safeJsonParse", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("parses a well-formed Horizon-style payload unchanged", () => {
    const payload = JSON.stringify({
      id: "evt-1",
      ledger: 100,
      topic: ["trade", "resolved"],
      value: { amount: "1000", nested: { ok: true } },
    });

    const result = safeJsonParse<Record<string, unknown>>(payload, {
      strictMode: false,
    });

    expect(result).toMatchObject({
      id: "evt-1",
      ledger: 100,
      topic: ["trade", "resolved"],
    });
  });

  it("throws on invalid JSON text", () => {
    expect(() => safeJsonParse("{not valid json", { strictMode: false })).toThrow(
      /invalid JSON payload/
    );
  });

  it("strips __proto__ keys when not in strict mode", () => {
    const malicious = '{"a":1,"__proto__":{"polluted":true}}';
    const result = safeJsonParse<Record<string, unknown>>(malicious, {
      strictMode: false,
    });

    expect(result.a).toBe(1);
    expect((result as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
  });

  it("strips nested constructor/prototype pollution vectors", () => {
    const malicious = JSON.stringify({
      value: { constructor: { prototype: { polluted: true } } },
    });

    const result = safeJsonParse<Record<string, any>>(malicious, {
      strictMode: false,
    });

    expect(result.value).toBeDefined();
    expect(result.value.constructor).toBeUndefined();
  });

  it("throws UnsafeJsonError in strict mode when a dangerous key is present", () => {
    const malicious = '{"__proto__":{"polluted":true}}';
    expect(() => safeJsonParse(malicious, { strictMode: true })).toThrow(
      UnsafeJsonError
    );
  });

  it("defaults to strict/fail-fast mode in production", () => {
    process.env.NODE_ENV = "production";
    const malicious = '{"prototype":{"polluted":true}}';
    expect(() => safeJsonParse(malicious)).toThrow(UnsafeJsonError);
  });

  it("defaults to lenient stripping outside production", () => {
    process.env.NODE_ENV = "test";
    const malicious = '{"prototype":{"polluted":true}}';
    expect(() => safeJsonParse(malicious)).not.toThrow();
  });

  it("does not actually pollute Object.prototype no matter the mode", () => {
    const malicious = '{"__proto__":{"polluted":true}}';
    try {
      safeJsonParse(malicious, { strictMode: true });
    } catch {
      // expected in strict mode
    }
    safeJsonParse(malicious, { strictMode: false });

    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("safeJsonSanitize", () => {
  it("sanitizes an already-parsed object graph the same way", () => {
    // JSON.parse (unlike an object literal) creates a genuine own
    // enumerable "__proto__" property, which is the real attack vector.
    const value = JSON.parse('{"ok":true,"__proto__":{"polluted":true}}');
    const result = safeJsonSanitize<Record<string, unknown>>(value, {
      strictMode: false,
    });
    expect((result as any).polluted).toBeUndefined();
  });
});
