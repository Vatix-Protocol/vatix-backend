/**
 * Replay-market forensics documentation parity (issue #988).
 *
 * "Ops cannot reconstruct a book's fills." The replay CLI only helps during an
 * incident if its behaviour is documented and the docs don't drift from the
 * script. These tests fail if:
 *   - a CLI flag the script accepts is undocumented in docs/replay-forensics.md
 *     or the script's own --help text, or
 *   - the incident runbook stops pointing operators at the replay procedure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const script = read("scripts/replay-market.ts");
const doc = read("docs/replay-forensics.md");
const scriptsReadme = read("scripts/README.md");
const incidentRunbook = read("docs/runbooks/incident-runbook.md");

/** Every `--flag` string literal compared against inside the arg parser. */
function scriptFlags(source: string): string[] {
  const start = source.indexOf("export function parseArgs");
  const end = source.indexOf("function log(", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  const flags = new Set<string>();
  for (const m of body.matchAll(/"(--[a-z-]+)"/g)) flags.add(m[1]);
  return [...flags];
}

describe("replay-market CLI ↔ docs parity", () => {
  const flags = scriptFlags(script);

  it("the script actually defines flags to check", () => {
    expect(flags).toEqual(
      expect.arrayContaining(["--market", "--outcome", "--as-of", "--sample"])
    );
  });

  it("every CLI flag is documented in docs/replay-forensics.md", () => {
    for (const flag of flags) {
      expect(doc, `docs/replay-forensics.md is missing ${flag}`).toContain(
        flag
      );
    }
  });

  it("every CLI flag appears in the script's own --help text", () => {
    const help = script.slice(
      script.indexOf("export const HELP"),
      script.indexOf("export function parseArgs")
    );
    for (const flag of flags) {
      expect(help, `HELP text is missing ${flag}`).toContain(flag);
    }
  });

  it("the script supports -h/--help", () => {
    expect(script).toMatch(/args\[i\] === "-h" \|\| args\[i\] === "--help"/);
  });
});

describe("replay-market operator guidance", () => {
  it("docs/replay-forensics.md documents exit codes and read-only safety", () => {
    expect(doc).toMatch(/exit(s)? code/i);
    expect(doc.toLowerCase()).toContain("read-only");
  });

  it("docs/replay-forensics.md documents the pnpm alias and a fills-reconstruction recipe", () => {
    expect(doc).toContain("pnpm replay:market");
    expect(doc).toMatch(/reconstruct.*fill/i);
  });

  it("scripts/README.md links replay-market to the forensics doc", () => {
    expect(scriptsReadme).toContain("replay-market.ts");
    expect(scriptsReadme).toContain("docs/replay-forensics.md");
  });

  it("the incident runbook points operators at the replay procedure", () => {
    expect(incidentRunbook).toContain("replay-forensics.md");
    expect(incidentRunbook).toMatch(/replay:market|replay-market\.ts/);
  });
});
