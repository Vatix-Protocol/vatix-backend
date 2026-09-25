import { describe, it, expect } from "vitest";
import { safeJsonParse, safeStringify, sanitizeForJson } from "./safeJson.js";

// ── #776: safeJsonParse — no uncaught SyntaxError from event bodies ───────────

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
    // This is the key acceptance criterion for #776: no uncaught SyntaxError
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
});
