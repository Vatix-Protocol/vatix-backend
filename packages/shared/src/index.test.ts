import { describe, it, expect } from "vitest";
import {
  MAX_REDACTION_DEPTH,
  REDACTED,
  REDACTION_TRUNCATED,
  SENSITIVE_KEYS,
  isSensitiveKey,
  redactObject,
  redactMeta,
} from "./index.js";

describe("public barrel surface (#1304)", () => {
  it("exports the documented redaction symbols", () => {
    expect(REDACTED).toBeDefined();
    expect(REDACTION_TRUNCATED).toBeDefined();
    expect(SENSITIVE_KEYS).toBeDefined();
    expect(isSensitiveKey).toBeTypeOf("function");
    expect(redactObject).toBeTypeOf("function");
    expect(redactMeta).toBeTypeOf("function");
    expect(MAX_REDACTION_DEPTH).toBeDefined();
  });

  it("exposes MAX_REDACTION_DEPTH as a number", () => {
    expect(typeof MAX_REDACTION_DEPTH).toBe("number");
  });

  it("keeps the truncation marker distinct from the redaction marker", () => {
    expect(REDACTION_TRUNCATED).not.toBe(REDACTED);
  });
});
