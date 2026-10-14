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

const SQL_BLOCK_PATTERN = /```sql\n([\s\S]*?)```/g;
const STATEMENT_KEYWORD = /\b(SELECT|UPDATE|INSERT|DELETE)\b/i;

interface SqlBlock {
  /** 1-based line number of the opening ```sql fence. */
  startLine: number;
  content: string;
}

function extractSqlBlocks(content: string): SqlBlock[] {
  const blocks: SqlBlock[] = [];
  for (const match of content.matchAll(SQL_BLOCK_PATTERN)) {
    const offset = match.index ?? 0;
    blocks.push({
      startLine: content.slice(0, offset).split("\n").length,
      content: match[1],
    });
  }
  return blocks;
}

/**
 * Drop `--` line comments and single-quoted literals before the lexical checks.
 * Runbook snippets carry prose like `(e.g. '1234567')` and values such as
 * `'[CURRENT_LEDGER - 100]'`; without this the parenthesis check would report
 * balanced prose as an unbalanced query.
 */
function stripCommentsAndLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? sql.length : newline;
      continue;
    }
    if (char === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += "''";
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

function parenthesisProblem(sql: string): boolean {
  let depth = 0;
  for (const char of sql) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
    }
  }
  return depth !== 0;
}

/**
 * Lexical validation only: no SQL parser, no dependency. Catches the obvious
 * breakage a contributor can introduce while editing the runbook.
 */
function validateSqlBlocks(content: string): string[] {
  const problems: string[] = [];
  for (const block of extractSqlBlocks(content)) {
    const label = `SQL block starting at line ${block.startLine}`;
    const sql = stripCommentsAndLiterals(block.content);
    if (sql.trim() === "") {
      problems.push(`${label} is empty`);
      continue;
    }
    if (!STATEMENT_KEYWORD.test(sql)) {
      problems.push(
        `${label} has no statement keyword (SELECT, UPDATE, INSERT or DELETE)`
      );
    }
    if (parenthesisProblem(sql)) {
      problems.push(`${label} has unbalanced parentheses`);
    }
  }
  return problems;
}

describe("incident runbook SQL blocks (config scope, min-039)", () => {
  it("extracts the fenced SQL blocks from the runbook", () => {
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");
    const blocks = extractSqlBlocks(runbook);

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.startLine).toBeGreaterThan(0);
      expect(block.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("passes on the current runbook", () => {
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");

    expect(validateSqlBlocks(runbook)).toEqual([]);
  });

  it("fails when a fenced SQL block has unbalanced parentheses", () => {
    const problems = validateSqlBlocks(
      "```sql\nSELECT count(* FROM events;\n```\n"
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unbalanced parentheses");
  });

  it("fails when a fenced SQL block has a stray closing parenthesis", () => {
    const problems = validateSqlBlocks(
      "```sql\nSELECT * FROM events WHERE id = 1);\n```\n"
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unbalanced parentheses");
  });

  it("fails when a fenced SQL block contains no statement keyword", () => {
    const problems = validateSqlBlocks(
      "```sql\nSET search_path TO public;\n```\n"
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no statement keyword");
  });

  it("fails when a fenced SQL block is empty", () => {
    const problems = validateSqlBlocks("```sql\n\n-- nothing to run\n```\n");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("is empty");
  });

  it("ignores prose and literals when checking parentheses", () => {
    const problems = validateSqlBlocks(
      [
        "```sql",
        "-- Expected: a ledger sequence string (e.g. '1234567'), recent",
        "SELECT cursor_value FROM indexer_cursors",
        "WHERE cursor_value = '[CURRENT_LEDGER - 100]';",
        "```",
        "",
      ].join("\n")
    );

    expect(problems).toEqual([]);
  });

  it("reports the line number of the offending block", () => {
    const problems = validateSqlBlocks(
      [
        "# Runbook",
        "",
        "Some prose.",
        "",
        "```sql",
        "SELECT count(* FROM events;",
        "```",
        "",
      ].join("\n")
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("line 5");
  });
});
