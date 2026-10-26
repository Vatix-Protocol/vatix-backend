import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..', '..');
const runbookPath = resolve(__dirname, '../../docs/runbooks/incident-runbook.md');
const runbook = readFileSync(runbookPath, 'utf8');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

interface SqlBlock {
  sql: string;
  startLine: number;
}

function extractSqlBlocks(content: string): SqlBlock[] {
  const blocks: SqlBlock[] = [];
  const pattern = /```sql\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const startLine = content.slice(0, match.index).split('\n').length;
    blocks.push({ sql: match[1], startLine });
  }
  return blocks;
}

function hasBalancedParentheses(sql: string): boolean {
  let depth = 0;
  for (const char of sql) {
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

const STATEMENT_KEYWORD = /\b(SELECT|UPDATE|INSERT|DELETE)\b/i;

function extractComposeContainerNames(compose: string): Set<string> {
  const names = new Set<string>();
  const regex = /container_name:\s*(vatix-[a-z-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(compose)) !== null) {
    names.add(match[1]);
  }
  return names;
}

function extractComposeServiceNames(compose: string): Set<string> {
  const names = new Set<string>();
  const lines = compose.split('\n');
  let inServices = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) {
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) {
      inServices = false;
      continue;
    }
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) {
      names.add(match[1]);
    }
  }
  return names;
}

function extractRunbookContainerNames(text: string): Set<string> {
  const names = new Set<string>();
  const regex = /\bvatix-[a-z-]+\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    names.add(match[0]);
  }
  return names;
}

describe('incident runbook', () => {
  it('references the expected container names', () => {
    expect(runbook).toContain('vatix-indexer');
    expect(runbook).toContain('vatix-postgres');
  });

  describe('SQL blocks', () => {
    const blocks = extractSqlBlocks(runbook);

    it('contains at least one fenced SQL block', () => {
      expect(blocks.length).toBeGreaterThan(0);
    });

    it('has no empty SQL blocks', () => {
      for (const block of blocks) {
        expect(
          block.sql.trim().length,
          `SQL block starting at line ${block.startLine} is empty`,
        ).toBeGreaterThan(0);
      }
    });

    it('has balanced parentheses in every SQL block', () => {
      for (const block of blocks) {
        expect(
          hasBalancedParentheses(block.sql),
          `SQL block starting at line ${block.startLine} has unbalanced parentheses`,
        ).toBe(true);
      }
    });

    it('contains a statement keyword in every SQL block', () => {
      for (const block of blocks) {
        expect(
          STATEMENT_KEYWORD.test(block.sql),
          `SQL block starting at line ${block.startLine} has no statement keyword (SELECT/UPDATE/INSERT/DELETE)`,
        ).toBe(true);
      }
    });
  });

  it('every container referenced in the runbook is defined in docker-compose.yml', () => {
    const compose = readRepoFile('docker-compose.yml');
    const containerNames = extractComposeContainerNames(compose);
    const serviceNames = extractComposeServiceNames(compose);
    const knownServices = [...serviceNames].sort();
    const referenced = extractRunbookContainerNames(runbook);

    const missing = [...referenced].filter(
      (name) => !containerNames.has(name) && !serviceNames.has(name),
    );

    expect(
      missing,
      `Runbook references containers not defined in docker-compose.yml. ` +
        `Known services: ${knownServices.join(', ')}`,
    ).toEqual([]);
  });

  it('every container name documented in docs/docker-compose.md is defined in docker-compose.yml', () => {
    const compose = readRepoFile('docker-compose.yml');
    const composeDocs = readRepoFile('docs/docker-compose.md');
    const containerNames = extractComposeContainerNames(compose);
    const documented = extractRunbookContainerNames(composeDocs);
    const missing = [...documented].filter((name) => !containerNames.has(name));

    expect(missing).toEqual([]);
  });
});
