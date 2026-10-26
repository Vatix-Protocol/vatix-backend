import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runbookPath = resolve(__dirname, '../../docs/runbooks/incident-runbook.md');
const runbook = readFileSync(runbookPath, 'utf8');

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
});
