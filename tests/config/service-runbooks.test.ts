import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Keeps the operations runbooks in the service READMEs honest: every command,
 * link, anchor and env var they reference must exist in the repository.
 */

const ROOT = process.cwd();
const READMES = [
  "apps/workers/README.md",
  "apps/oracle/README.md",
  "apps/indexer/README.md",
];
const REQUIRED_SECTIONS = [
  "## Operations runbook",
  "### Start and stop",
  "### Common failures",
  "### Kill switches and rollback",
];

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** GitHub-style heading slugs, including the `-1`, `-2` suffixes for duplicates. */
function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  for (const [, text] of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

function scriptsOf(packageJsonPath: string): Record<string, string> {
  return JSON.parse(read(packageJsonPath)).scripts ?? {};
}

function workspaceScripts(): Map<string, Record<string, string>> {
  const byName = new Map<string, Record<string, string>>();
  for (const dir of ["apps", "packages"]) {
    for (const entry of readdirSync(resolve(ROOT, dir))) {
      const pkg = join(dir, entry, "package.json");
      if (existsSync(resolve(ROOT, pkg))) {
        byName.set(JSON.parse(read(pkg)).name, scriptsOf(pkg));
      }
    }
  }
  return byName;
}

function sourceCorpus(): string {
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "generated") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
        chunks.push(readFileSync(path, "utf8"));
      }
    }
  };
  for (const dir of ["apps", "packages", "src"]) walk(resolve(ROOT, dir));
  return chunks.join("\n");
}

/** Env var names from the first column of every table headed "... env var ...". */
function documentedEnvVars(markdown: string): string[] {
  const vars: string[] = [];
  let inEnvTable = false;
  let previousWasTable = false;
  for (const line of markdown.split("\n")) {
    const isTable = line.startsWith("|");
    if (isTable && !previousWasTable) {
      inEnvTable = /env var/i.test(line.split("|")[1] ?? "");
    } else if (isTable && inEnvTable && !/^\|\s*-/.test(line)) {
      const firstCell = line.split("|")[1] ?? "";
      for (const [, name] of firstCell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
        vars.push(name);
      }
    }
    previousWasTable = isTable;
  }
  return vars;
}

describe.each(READMES)("operations runbook in %s", (readmePath) => {
  const markdown = read(readmePath);
  const runbook = markdown.slice(markdown.indexOf("## Operations runbook"));

  it("has the required runbook sections", () => {
    for (const section of REQUIRED_SECTIONS) {
      expect(markdown).toContain(section);
    }
  });

  it("links to the incident runbook and SECURITY.md", () => {
    expect(markdown).toContain("../../docs/runbooks/incident-runbook.md");
    expect(markdown).toContain("SECURITY.md");
  });

  it("only references pnpm scripts that exist", () => {
    const rootScripts = scriptsOf("package.json");
    const workspaces = workspaceScripts();
    const commands = [
      ...runbook.matchAll(/`pnpm (?:--filter (\S+) )?([a-z][\w:-]*)/g),
    ];
    expect(commands.length).toBeGreaterThan(0);

    for (const [command, workspace, script] of commands) {
      const scripts = workspace ? workspaces.get(workspace) : rootScripts;
      expect(scripts, `${command}: unknown workspace`).toBeDefined();
      expect(Object.keys(scripts!), command).toContain(script);
    }
  });

  it("only links to files and headings that exist", () => {
    const links = [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    for (const link of links.filter((l) => !/^https?:/.test(l))) {
      const [file, anchor] = link.split("#");
      const target = file
        ? resolve(ROOT, dirname(readmePath), file)
        : resolve(ROOT, readmePath);
      expect(existsSync(target), `${link}: missing file`).toBe(true);
      if (anchor && target.endsWith(".md")) {
        const slugs = headingSlugs(readFileSync(target, "utf8"));
        expect(slugs.has(anchor), `${link}: missing heading`).toBe(true);
      }
    }
  });

  it("only documents env vars the code reads", () => {
    const corpus = sourceCorpus();
    const vars = documentedEnvVars(markdown);
    expect(vars.length).toBeGreaterThan(0);
    for (const name of vars) {
      expect(corpus.includes(name), `${name} is not read anywhere`).toBe(true);
    }
  });
});
