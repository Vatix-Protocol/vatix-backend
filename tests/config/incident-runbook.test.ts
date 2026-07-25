import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNBOOK_PATH = resolve(
  process.cwd(),
  "docs/runbooks/incident-runbook.md"
);
const COMPOSE_PATH = resolve(process.cwd(), "docker-compose.yml");
const COMPOSE_DOC_PATH = resolve(process.cwd(), "docs/docker-compose.md");

function extractRunbookContainerNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(/\b(vatix-[a-z-]+)\b/g)) {
    names.add(match[1]);
  }
  return names;
}

function extractComposeContainerNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(/container_name:\s*(vatix-[a-z-]+)/g)) {
    names.add(match[1]);
  }
  return names;
}

describe("incident runbook (config scope, min-039)", () => {
  it("runbook exists and references docker container names", () => {
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");
    const referenced = extractRunbookContainerNames(runbook);
    expect(referenced.size).toBeGreaterThan(0);
    expect(referenced).toContain("vatix-backend");
    expect(referenced).toContain("vatix-indexer");
    expect(referenced).toContain("vatix-postgres");
    expect(referenced).toContain("vatix-redis");
  });

  it("every container referenced in the runbook is defined in docker-compose.yml", () => {
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");
    const compose = readFileSync(COMPOSE_PATH, "utf8");
    const referenced = extractRunbookContainerNames(runbook);
    const defined = extractComposeContainerNames(compose);

    for (const name of referenced) {
      expect(defined.has(name)).toBe(true);
    }
  });

  it("docker-compose.yml container names are documented in docs/docker-compose.md", () => {
    const compose = readFileSync(COMPOSE_PATH, "utf8");
    const doc = readFileSync(COMPOSE_DOC_PATH, "utf8");
    const defined = extractComposeContainerNames(compose);

    for (const name of defined) {
      expect(doc).toContain(name);
    }
  });

  it("docs/docker-compose.md links to the incident runbook", () => {
    const doc = readFileSync(COMPOSE_DOC_PATH, "utf8");
    expect(doc).toContain("docs/runbooks/incident-runbook.md");
  });
});
