import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNBOOK_PATH = resolve(
  process.cwd(),
  "docs/runbooks/incident-runbook.md"
);
const COMPOSE_PATH = resolve(process.cwd(), "docker-compose.yml");
const COMPOSE_DOC_PATH = resolve(process.cwd(), "docs/docker-compose.md");
const SCHEMA_PATH = resolve(process.cwd(), "prisma/schema.prisma");

// ---------------------------------------------------------------------------
// Container-name helpers (existing)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prisma schema parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the body of a top-level Prisma block (model or enum) by counting
 * braces, so nested `{ }` inside field defaults or @@unique/@@index directives
 * don't terminate the match prematurely.
 *
 * Returns an array of `[name, body]` pairs for every block with the given
 * keyword (`model` or `enum`).
 */
function extractPrismaBlocks(
  schema: string,
  keyword: "model" | "enum",
): Array<[string, string]> {
  const results: Array<[string, string]> = [];
  const headerRe = new RegExp(`^${keyword}\\s+(\\w+)\\s*\\{`, "gm");
  let headerMatch: RegExpExecArray | null;

  while ((headerMatch = headerRe.exec(schema)) !== null) {
    const name = headerMatch[1];
    let depth = 1;
    let i = headerMatch.index + headerMatch[0].length;
    const bodyStart = i;

    while (i < schema.length && depth > 0) {
      if (schema[i] === "{") depth++;
      else if (schema[i] === "}") depth--;
      i++;
    }

    // `i` is now one past the closing `}`.
    const body = schema.slice(bodyStart, i - 1);
    results.push([name, body]);
  }

  return results;
}

/**
 * Parse prisma/schema.prisma and return:
 *   - `tables`: the set of SQL table names (from @@map or the model name)
 *   - `enumMembers`: all enum member values across all enums
 */
function parsePrismaSchema(schema: string): {
  tables: Set<string>;
  enumMembers: Set<string>;
} {
  const tables = new Set<string>();
  const enumMembers = new Set<string>();

  // Extract model → SQL table name mappings.
  for (const [modelName, body] of extractPrismaBlocks(schema, "model")) {
    // Check for @@map("table_name") — the authoritative SQL table name.
    const mapMatch = body.match(/@@map\("([^"]+)"\)/);
    if (mapMatch) {
      tables.add(mapMatch[1]);
    } else {
      // No @@map → Prisma uses the model name as-is for the SQL table.
      tables.add(modelName);
    }
  }

  // Extract all enum member names.
  for (const [, body] of extractPrismaBlocks(schema, "enum")) {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      // Skip blank lines, doc comments, and block-level directives (@@).
      if (
        !trimmed ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("///") ||
        trimmed.startsWith("@@")
      ) {
        continue;
      }
      // Enum member name is the first identifier token.
      const memberMatch = trimmed.match(/^(\w+)/);
      if (memberMatch) {
        enumMembers.add(memberMatch[1]);
      }
    }
  }

  return { tables, enumMembers };
}

// ---------------------------------------------------------------------------
// Runbook SQL extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract all content inside fenced ```sql ... ``` blocks in a Markdown file.
 */
function extractSqlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fencedRe = /```sql\s*([\s\S]*?)```/gi;
  for (const match of markdown.matchAll(fencedRe)) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Strip single-line SQL comments (`-- ...`) from a SQL snippet so that
 * keywords and identifiers in comments don't get picked up as table/column
 * references.
 */
function stripSqlLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * Extract table names referenced in FROM/JOIN/INSERT INTO/UPDATE/DELETE FROM
 * clauses inside an SQL snippet.
 * Returns lowercase identifiers only (no schema prefix, no aliases).
 */
function extractTableNamesFromSql(sql: string): Set<string> {
  const tables = new Set<string>();
  const stripped = stripSqlLineComments(sql);
  // Matches: FROM tbl, JOIN tbl, INTO tbl, UPDATE tbl
  // The table name must start with a letter or underscore (not a number).
  const tableRefRe =
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/gi;
  for (const match of stripped.matchAll(tableRefRe)) {
    // Strip a schema prefix (e.g. "pg_catalog.pg_locks" → "pg_locks").
    const raw = match[1].toLowerCase();
    // Skip SQL keywords that appear after FROM/INTO/etc in expressions
    // (e.g. "DO UPDATE SET …" or "FROM STEP …" after comment stripping).
    const SQL_NON_TABLE_KEYWORDS = new Set([
      "set",
      "select",
      "where",
      "values",
      "returning",
      "on",
      "as",
    ]);
    if (SQL_NON_TABLE_KEYWORDS.has(raw)) continue;
    const name = raw.includes(".") ? raw.split(".").pop()! : raw;
    tables.add(name);
  }
  return tables;
}

/**
 * Extract single-quoted string literals used in WHERE comparisons that look
 * like Prisma enum values — i.e. ALL_CAPS identifiers like `'CHALLENGED'` or
 * `'ACTIVE'`.
 *
 * Only matches literals that appear on the right-hand side of a column
 * comparison (`column = 'VALUE'` or `column IN ('VALUE', ...)`), not free-form
 * strings in INSERT VALUES or string concatenations.  This prevents action
 * strings like 'FINALIZE' (a VarChar column value) from being mistaken for
 * Prisma enum members.
 *
 * Lowercase values (`'ingestion'`, `'testnet'`, `'idle'`, etc.) are
 * intentionally excluded — they are plain string constants, not enum members.
 */
function extractEnumLiteralsFromSql(sql: string): Set<string> {
  const literals = new Set<string>();
  const stripped = stripSqlLineComments(sql);
  // Match: identifier = 'ALL_CAPS_VALUE'  (no lowercase letters)
  // Must have at least 2 uppercase characters so single-letter values are skipped.
  // No `i` flag — we deliberately require the literal to be uppercase.
  const comparisonRe = /\b\w+\s*(?:=|IN\s*\()\s*'([A-Z][A-Z0-9_]+)'/g;
  for (const match of stripped.matchAll(comparisonRe)) {
    literals.add(match[1]);
  }
  return literals;
}

// ---------------------------------------------------------------------------
// PostgreSQL system / infrastructure tables that live outside our schema
// ---------------------------------------------------------------------------
const PG_SYSTEM_TABLES = new Set([
  "pg_stat_activity",
  "pg_locks",
  "pg_stat_user_tables",
  "pg_tables",
  "pg_stat_statements",
  "pg_catalog",
  "information_schema",
]);

// These tables are referenced in the runbook but are not in the Prisma schema
// (e.g. an `events` table that is Postgres-native or a legacy `audit_log`).
// We maintain an explicit exclusion list so new runbook additions that reference
// a real Prisma table can't hide behind this list by accident.
const RUNBOOK_UNMODELED_TABLES = new Set([
  // `events` appears in Incident 1 SQL but has no corresponding Prisma model;
  // it is a raw PostgreSQL table written by the indexer outside Prisma's ORM.
  "events",
  // `audit_log` is referenced as a target for manual-intervention inserts but
  // has no Prisma model definition in the current schema.
  "audit_log",
]);

describe("incident runbook (config scope, min-039)", () => {
  // -------------------------------------------------------------------------
  // Existing container-name assertions — MUST remain untouched
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // NEW: Schema drift — SQL in the runbook must reference known tables/enums
  // -------------------------------------------------------------------------

  it("prisma/schema.prisma is parseable and contains expected models", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const { tables, enumMembers } = parsePrismaSchema(schema);

    // Sanity-check that parsing produced results; a zero count means the
    // regex broke, not that the schema is empty.
    expect(tables.size).toBeGreaterThan(0);
    expect(enumMembers.size).toBeGreaterThan(0);

    // Spot-check a few known tables and enum members so a silent parse failure
    // is caught immediately.
    expect(tables).toContain("markets");
    expect(tables).toContain("orders");
    expect(tables).toContain("resolution_candidates");
    expect(enumMembers).toContain("ACTIVE");
    expect(enumMembers).toContain("CHALLENGED");
  });

  it("every table name in runbook SQL blocks exists in prisma/schema.prisma", () => {
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");
    const schema = readFileSync(SCHEMA_PATH, "utf8");

    const { tables: schemaTables } = parsePrismaSchema(schema);
    const sqlBlocks = extractSqlBlocks(runbook);

    const missingTables: string[] = [];

    for (const block of sqlBlocks) {
      const referencedTables = extractTableNamesFromSql(block);
      for (const table of referencedTables) {
        if (PG_SYSTEM_TABLES.has(table)) continue;
        if (RUNBOOK_UNMODELED_TABLES.has(table)) continue;
        if (!schemaTables.has(table)) {
          missingTables.push(table);
        }
      }
    }

    expect(
      missingTables,
      `Runbook SQL references tables not found in prisma/schema.prisma: ${[...new Set(missingTables)].join(", ")}`,
    ).toEqual([]);
  });

  it("every status literal in runbook SQL blocks exists in a prisma/schema.prisma enum", () => {
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");
    const schema = readFileSync(SCHEMA_PATH, "utf8");

    const { enumMembers } = parsePrismaSchema(schema);
    const sqlBlocks = extractSqlBlocks(runbook);

    const missingLiterals: string[] = [];

    for (const block of sqlBlocks) {
      const literals = extractEnumLiteralsFromSql(block);
      for (const literal of literals) {
        if (!enumMembers.has(literal)) {
          missingLiterals.push(literal);
        }
      }
    }

    expect(
      missingLiterals,
      `Runbook SQL uses enum literals not found in any prisma/schema.prisma enum: ${[...new Set(missingLiterals)].join(", ")}`,
    ).toEqual([]);
  });
});
