import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * #984 — config.ts and env.ts must be a single source of truth. Two parsers
 * (a Zod schema in env.ts plus ad-hoc `process.env` reads in config.ts) let
 * an undeclared / unvalidated variable leak into one code path. This is a
 * static source scan: it fails if config.ts ever reaches for `process.env`
 * again instead of consuming the Zod-parsed `env` object.
 *
 * Behavioural coverage for the values themselves (ADMIN_TOKEN production
 * rejection, DATABASE_STATEMENT_TIMEOUT_MS parsing/defaults) lives in
 * src/env.test.ts.
 */

const configSource = readFileSync(
  fileURLToPath(new URL("./config.ts", import.meta.url)),
  "utf8"
);

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, "``"); // template literals
}

describe("config.ts single source of truth (#984)", () => {
  const code = stripCommentsAndStrings(configSource);

  it("never reads process.env directly — every value flows through env.ts", () => {
    expect(code).not.toMatch(/process\s*\.\s*env/);
  });

  it("derives its values from the Zod-validated parseApiEnv()", () => {
    expect(code).toMatch(/parseApiEnv/);
    expect(configSource).toMatch(/from "\.\/env\.js"/);
  });

  it("still exposes the deprecated adminToken and the statement-timeout knobs", () => {
    expect(code).toMatch(/adminToken/);
    expect(code).toMatch(/databaseStatementTimeoutMs/);
  });
});
