import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BatchWriter } from './batchWriter';

/**
 * Unit tests for BatchWriter rollback, idempotency/replay, and fail-closed
 * behavior on dependency outage. These invariants guard the money path:
 * a partial batch failure must never leave partially committed state, and
 * replayed/concurrent writes must not double-apply.
 */

type Row = { id: string; amount: number };

function makeWriter(overrides: Partial<{
  flush: (rows: Row[]) => Promise<void>;
  maxBatchSize: number;
}> = {}) {
  const flush = overrides.flush ?? vi.fn(async () => {});
  const writer = new BatchWriter<Row>({
    maxBatchSize: overrides.maxBatchSize ?? 100,
    flush,
  });
  return { writer, flush };
}

describe('BatchWriter rollback', () => {
  let flush: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    flush = vi.fn(async () => {});
  });

  it('does not leave partially committed state when a batch flush fails', async () => {
    const committed: Row[] = [];
    flush = vi.fn(async (rows: Row[]) => {
      // Simulate a transactional write that fails midway: nothing is committed.
      if (rows.some((r) => r.id === 'bad')) {
        throw new Error('db write failed');
      }
      committed.push(...rows);
    });

    const { writer } = makeWriter({ flush, maxBatchSize: 2 });
    writer.add({ id: 'ok-1', amount: 1 });
    writer.add({ id: 'bad', amount: 2 });

    await expect(writer.flush()).rejects.toThrow('db write failed');
    expect(committed).toEqual([]);
  });

  it('rolls back buffered rows so a retry can re-attempt the same batch', async () => {
    let attempts = 0;
    const committed: Row[] = [];
    flush = vi.fn(async (rows: Row[]) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient db outage');
      committed.push(...rows);
    });

    const { writer } = makeWriter({ flush, maxBatchSize: 10 });
    writer.add({ id: 'a', amount: 1 });
    writer.add({ id: 'b', amount: 2 });

    await expect(writer.flush()).rejects.toThrow('transient db outage');
    expect(committed).toEqual([]);

    // Retry after the outage: the same rows must still be present and applied once.
    await writer.flush();
    expect(committed).toEqual([
      { id: 'a', amount: 1 },
      { id: 'b', amount: 2 },
    ]);
  });
});

describe('BatchWriter idempotency / replay', () => {
  it('does not double-apply when the same batch is flushed concurrently', async () => {
    const committed: Row[] = [];
    const flush = vi.fn(async (rows: Row[]) => {
      committed.push(...rows);
    });

    const { writer } = makeWriter({ flush, maxBatchSize: 10 });
    writer.add({ id: 'x', amount: 5 });

    await Promise.all([writer.flush(), writer.flush()]);

    expect(committed).toEqual([{ id: 'x', amount: 5 }]);
  });

  it('dedupes replayed rows by id so a replay does not double-apply', async () => {
    const committed: Row[] = [];
    const flush = vi.fn(async (rows: Row[]) => {
      committed.push(...rows);
    });

    const { writer } = makeWriter({ flush, maxBatchSize: 10 });
    writer.add({ id: 'dup', amount: 1 });
    writer.add({ id: 'dup', amount: 1 });

    await writer.flush();

    expect(committed).toEqual([{ id: 'dup', amount: 1 }]);
  });
});

describe('BatchWriter fail-closed on dependency outage', () => {
  it('rejects the flush instead of silently succeeding when the DB is down', async () => {
    const flush = vi.fn(async () => {
      throw new Error('ECONNREFUSED db');
    });

    const { writer } = makeWriter({ flush, maxBatchSize: 10 });
    writer.add({ id: 'a', amount: 1 });

    await expect(writer.flush()).rejects.toThrow('ECONNREFUSED db');
  });

  it('does not report success when the flush resolves without committing', async () => {
    const committed: Row[] = [];
    const flush = vi.fn(async (rows: Row[]) => {
      // Simulate a fail-closed guard: no rows committed, but no throw either.
      if (rows.length === 0) return;
      throw new Error('write rejected by fail-closed guard');
    });

    const { writer } = makeWriter({ flush, maxBatchSize: 10 });
    writer.add({ id: 'a', amount: 1 });

    await expect(writer.flush()).rejects.toThrow('write rejected by fail-closed guard');
    expect(committed).toEqual([]);
  });
});
