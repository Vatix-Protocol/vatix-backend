import { describe, it, expect } from "vitest";
import { safeJsonParse, safeStringify, sanitizeForJson } from "./safeJson.js";

// ── #776 / #1100: safeJsonParse — no uncaught SyntaxError from event bodies & DoS limits ───

describe("safeJsonParse", () => {
  it("returns ok:true and the parsed value for valid JSON", () => {
    const result = safeJsonParse<{ foo: string }>('{"foo":"bar"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ foo: "bar" });
    }
  });

  it("parses a JSON array", () => {
    const result = safeJsonParse<number[]>("[1,2,3]");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });

  it("parses a JSON primitive string", () => {
    const result = safeJsonParse<string>('"hello"');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello");
  });

  it("parses a JSON null", () => {
    const result = safeJsonParse<null>("null");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it("returns ok:false for invalid JSON — does NOT throw", () => {
    expect(() => safeJsonParse("{not valid json}")).not.toThrow();
    const result = safeJsonParse("{not valid json}");
    expect(result.ok).toBe(false);
  });

  it("returns a SyntaxError in the error field for invalid JSON", () => {
    const result = safeJsonParse("{{bad}}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SyntaxError);
    }
  });

  it("returns ok:false for an empty string", () => {
    const result = safeJsonParse("");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for truncated JSON", () => {
    const result = safeJsonParse('{"foo":');
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for a bare identifier (not quoted)", () => {
    const result = safeJsonParse("undefined");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for trailing garbage after valid JSON", () => {
    const result = safeJsonParse('{"ok":true}garbage');
    expect(result.ok).toBe(false);
  });

  it("does not throw on any input — never produces an uncaught SyntaxError", () => {
    const badInputs = [
      "}{",
      "[[[",
      "NaN",
      "undefined",
      "",
      "  ",
      "<xml>not json</xml>",
      "SELECT * FROM users",
    ];
    for (const bad of badInputs) {
      expect(() => safeJsonParse(bad)).not.toThrow();
    }
  });

  // ── DoS Limits for safeJsonParse ──────────────────────────────────────────

  it("rejects JSON strings exceeding maxLength", () => {
    const longStr = '{"a":' + '"x"'.repeat(100) + "}";
    const result = safeJsonParse(longStr, { maxLength: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds maximum allowed length");
    }
  });

  it("rejects JSON exceeding maxDepth", () => {
    // Build nested JSON: {"a":{"a":{...}}}
    let json = "1";
    for (let i = 0; i < 10; i++) {
      json = `{"a":${json}}`;
    }
    const result = safeJsonParse(json, { maxDepth: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds maximum allowed depth");
    }
  });

  it("rejects arrays exceeding maxArrayLength", () => {
    const result = safeJsonParse("[1,2,3,4,5]", { maxArrayLength: 2 });
    expect(result.ok).toBe(false);
  });

  it("rejects objects exceeding maxObjectKeys", () => {
    const result = safeJsonParse('{"a":1,"b":2,"c":3}', { maxObjectKeys: 2 });
    expect(result.ok).toBe(false);
  });

  it("uses default limits when options not provided", () => {
    // Very deeply nested object that exceeds default maxDepth (32)
    let json = "1";
    for (let i = 0; i < 40; i++) {
      json = `{"a":${json}}`;
    }
    const result = safeJsonParse(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds maximum allowed depth");
    }
  });

  it("handles non-string input gracefully", () => {
    const result = safeJsonParse(123 as unknown as string);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Input must be a string");
    }
  });
});

// ── safeStringify ─────────────────────────────────────────────────────────────

describe("safeStringify", () => {
  it("serializes a plain object", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });

  it("serializes bigint as string", () => {
    expect(safeStringify({ n: 9007199254740993n })).toBe(
      '{"n":"9007199254740993"}'
    );
  });

  it("serializes an Error as an object with name/message", () => {
    const result = JSON.parse(safeStringify(new Error("boom")));
    expect(result.name).toBe("Error");
    expect(result.message).toBe("boom");
  });

  it("handles circular references gracefully", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => safeStringify(obj)).not.toThrow();
    const result = JSON.parse(safeStringify(obj));
    expect(result.self).toBe("[Circular]");
  });

  it("handles maxDepth gracefully in safeStringify", () => {
    let obj: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 10; i++) {
      obj = { next: obj };
    }
    expect(() => safeStringify(obj, { maxDepth: 3 })).not.toThrow();
    const parsed = JSON.parse(safeStringify(obj, { maxDepth: 3 }));
    expect(safeStringify(obj, { maxDepth: 3 })).toContain("[Depth Exceeded]");
  });

  it("truncates arrays exceeding maxArrayLength in safeStringify", () => {
    const arr = [1, 2, 3, 4, 5];
    const res = JSON.parse(safeStringify(arr, { maxArrayLength: 2 }));
    expect(res).toEqual([1, 2, "[Array Truncated]"]);
  });

  it("truncates objects exceeding maxObjectKeys in safeStringify", () => {
    const obj = { a: 1, b: 2, c: 3 };
    const res = JSON.parse(safeStringify(obj, { maxObjectKeys: 1 }));
    expect(res).toEqual({ a: 1, "[KeysTruncated]": true });
  });
});

// ── sanitizeForJson ───────────────────────────────────────────────────────────

describe("sanitizeForJson", () => {
  it("passes through primitives unchanged", () => {
    expect(sanitizeForJson(null)).toBeNull();
    expect(sanitizeForJson(true)).toBe(true);
    expect(sanitizeForJson(42)).toBe(42);
    expect(sanitizeForJson("str")).toBe("str");
  });

  it("converts bigint to string", () => {
    expect(sanitizeForJson(123n)).toBe("123");
  });

  it("recursively sanitizes arrays", () => {
    expect(sanitizeForJson([1n, "x", null])).toEqual(["1", "x", null]);
  });

  it("recursively sanitizes objects", () => {
    expect(sanitizeForJson({ a: 1n, b: "ok" })).toEqual({ a: "1", b: "ok" });
  });

  it("handles maxDepth in sanitizeForJson", () => {
    let obj: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 5; i++) {
      obj = { next: obj };
    }
    const res = sanitizeForJson(obj, { maxDepth: 2 });
    const str = JSON.stringify(res);
    expect(str).toContain("[Depth Exceeded]");
  });

  it("truncates arrays in sanitizeForJson", () => {
    const arr = [1, 2, 3, 4, 5];
    const res = sanitizeForJson(arr, { maxArrayLength: 2 });
    expect(res).toEqual([1, 2, "[Array Truncated]"]);
  });

  it("truncates objects in sanitizeForJson", () => {
    const obj = { a: 1, b: 2, c: 3 };
    const res = sanitizeForJson(obj, { maxObjectKeys: 1 });
    expect(res).toEqual({ a: 1, "[KeysTruncated]": true });
  });
});