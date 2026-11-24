import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeMarketEtag, validateMarketQuestion } from "./market.dto";
import { MARKET_QUESTION_MAX_LENGTH } from "@vatix/shared/marketLifecycle.js";

describe("computeMarketEtag", () => {
  it("returns the same string for two Date instances built from the same ISO timestamp", () => {
    const iso = "2024-01-02T03:04:05.678Z";
    const a = computeMarketEtag({ id: "mkt-1", updatedAt: new Date(iso) });
    const b = computeMarketEtag({ id: "mkt-1", updatedAt: new Date(iso) });
    expect(a).toBe(b);
  });

  it("returns different strings when only updatedAt differs", () => {
    const a = computeMarketEtag({
      id: "mkt-1",
      updatedAt: new Date("2024-01-02T03:04:05.678Z"),
    });
    const b = computeMarketEtag({
      id: "mkt-1",
      updatedAt: new Date("2024-01-02T03:04:05.679Z"),
    });
    expect(a).not.toBe(b);
  });

  it("returns different strings when only id differs", () => {
    const updatedAt = new Date("2024-01-02T03:04:05.678Z");
    const a = computeMarketEtag({ id: "mkt-1", updatedAt });
    const b = computeMarketEtag({ id: "mkt-2", updatedAt });
    expect(a).not.toBe(b);
  });

  it("preserves the weak-validator W/ prefix and quoting", () => {
    const etag = computeMarketEtag({
      id: "mkt-1",
      updatedAt: new Date("2024-01-02T03:04:05.678Z"),
    });
    expect(etag.startsWith('W/"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
  });

  it("pins the exact output for a fixed id and timestamp", () => {
    const etag = computeMarketEtag({
      id: "mkt-1",
      updatedAt: new Date("2024-01-02T03:04:05.678Z"),
    });
    expect(etag).toBe('W/"mkt-1-2024-01-02T03:04:05.678Z"');
  });
});

describe("validateMarketQuestion uses the shared MARKET_QUESTION_MAX_LENGTH (#1561)", () => {
  it("pins the shared cap at 500", () => {
    expect(MARKET_QUESTION_MAX_LENGTH).toBe(500);
  });

  it("accepts a question exactly at the cap", () => {
    expect(validateMarketQuestion("q".repeat(500))).toBeNull();
  });

  it("rejects a question one character over the cap", () => {
    expect(validateMarketQuestion("q".repeat(501))).toBe(
      `Question must be at most ${MARKET_QUESTION_MAX_LENGTH} characters`
    );
  });

  it("rejects empty and non-string questions", () => {
    expect(validateMarketQuestion("")).toBe("Question is required");
    expect(validateMarketQuestion("   ")).toBe("Question is required");
    expect(validateMarketQuestion(42)).toBe("Question must be a string");
  });

  it("imports the cap from the shared module instead of a local literal", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./market.dto.ts", import.meta.url)),
      "utf8"
    );
    expect(source).toMatch(
      /import\s*\{[^}]*\bMARKET_QUESTION_MAX_LENGTH\b[^}]*\}\s*from\s*"@vatix\/shared\/marketLifecycle\.js"/
    );
    expect(source).not.toMatch(/\b500\b/);
  });
});
