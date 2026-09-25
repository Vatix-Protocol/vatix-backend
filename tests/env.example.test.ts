import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiEnvSchema } from "../src/env.js";

const ENV_EXAMPLE_PATH = resolve(process.cwd(), ".env.example");

describe(".env.example settlement queue documentation", () => {
  const content = readFileSync(ENV_EXAMPLE_PATH, "utf8");

  it("defines a dedicated Settlement Queue section", () => {
    expect(content).toMatch(/#\s*Settlement Queue/);
  });

  it("documents SETTLEMENT_QUEUE_NAME with default settlement-trades", () => {
    expect(content).toMatch(/SETTLEMENT_QUEUE_NAME=settlement-trades/);
    expect(content).toMatch(/Default:\s*settlement-trades/);
  });

  it("documents REDIS_KEY_PREFIX interaction for the settlement queue key", () => {
    expect(content).toMatch(/REDIS_KEY_PREFIX.*SETTLEMENT_QUEUE_NAME/s);
  });

  it("documents optional on-chain settlement env vars", () => {
    expect(content).toContain("SETTLEMENT_CONTRACT_ID=");
    expect(content).toContain("STELLAR_SECRET_KEY=");
  });

  it("does not duplicate SETTLEMENT_QUEUE_NAME assignment", () => {
    const assignmentLines = content
      .split("\n")
      .filter((line) => line.startsWith("SETTLEMENT_QUEUE_NAME="));
    expect(assignmentLines).toHaveLength(1);
  });
});

// ── Env example / apiEnvSchema drift guard ──────────────────────────────────
//
// apiEnvSchema (src/env.ts) is the single source of truth for API-service
// env vars. Every key it declares must be documented in .env.example — an
// undocumented required var (e.g. a new production fail-fast check) can
// otherwise ship silently and only surface as a production boot failure,
// which is exactly the "silently drop trades/resolutions/admin actions"
// failure mode this guards against. This test intentionally fails the
// moment a new key is added to apiEnvSchema without a matching
// .env.example entry — that failure IS the signal, not a bug in the test.
describe("env.example vs apiEnvSchema drift", () => {
  const content = readFileSync(ENV_EXAMPLE_PATH, "utf8");

  // Matches both live assignments (FOO=bar) and intentionally-commented-out
  // deprecated vars (# FOO=), e.g. the deprecated ADMIN_TOKEN entry.
  const documentedKeys = new Set(
    content
      .split("\n")
      .map((line) => line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => match[1])
  );

  const schemaKeys = Object.keys(apiEnvSchema.shape);

  it("has at least one schema key to check (sanity check)", () => {
    expect(schemaKeys.length).toBeGreaterThan(0);
  });

  it.each(schemaKeys)(
    "documents apiEnvSchema key %s in .env.example",
    (key) => {
      expect(documentedKeys.has(key)).toBe(true);
    }
  );
});
