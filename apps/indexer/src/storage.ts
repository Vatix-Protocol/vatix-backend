import { Pool, PoolClient } from 'pg';
import { Logger } from 'pino';

/**
 * Stable error codes surfaced by the storage layer. Callers (ingestion,
 * startup health, ops tooling) can branch on these without string matching.
 */
export type StorageErrorCode =
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_WRITE_FAILED'
  | 'STORAGE_CHECKPOINT_CONFLICT';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly correlationId?: string;
  readonly cause?: unknown;

  constructor(
    code: StorageErrorCode,
    message: string,
    options: { correlationId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.correlationId = options.correlationId;
    this.cause = options.cause;
  }
}

export interface CheckpointRecord {
  stream: string;
  cursor: string;
  updatedAt: Date;
}

/**
 * A single unit of ingestion work: the events to persist plus the checkpoint
 * cursor that must only advance if those events are durably written.
 */
export interface IngestionBatch<TEvent = unknown> {
  stream: string;
  /** Cursor the checkpoint is currently at (optimistic concurrency guard). */
  expectedCursor: string;
  /** Cursor to advance to once the batch is committed. */
  nextCursor: string;
  events: TEvent[];
}

export interface CommitResult {
  stream: string;
  cursor: string;
  eventsWritten: number;
  /** True when the batch was already applied (idempotent replay). */
  replayed: boolean;
}

/**
 * Persists a batch of ingestion events and advances the checkpoint in a single
 * atomic transaction. Either both the events and the checkpoint land, or
 * neither does — the checkpoint can never diverge from persisted events.
 *
 * Replay safety: if the checkpoint is already at `nextCursor` the batch is
 * treated as an idempotent replay and no events are double-applied. If the
 * checkpoint is at neither `expectedCursor` nor `nextCursor` a
 * STORAGE_CHECKPOINT_CONFLICT is raised so the caller can re-read and retry.
 */
export class Storage {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async getCheckpoint(stream: string): Promise<CheckpointRecord | null> {
    try {
      const { rows } = await this.pool.query<{
        stream: string;
        cursor: string;
        updated_at: Date;
      }>(
        'SELECT stream, cursor, updated_at FROM ingestion_checkpoints WHERE stream = $1',
        [stream],
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      return { stream: row.stream, cursor: row.cursor, updatedAt: row.updated_at };
    } catch (err) {
      throw new StorageError('STORAGE_UNAVAILABLE', 'failed to read ingestion checkpoint', {
        cause: err,
      });
    }
  }

  /**
   * Atomically persist `batch.events` and advance the checkpoint to
   * `batch.nextCursor`. Fail-closed: any error rolls back the whole
   * transaction so the checkpoint is never advanced past unwritten events.
   */
  async commitIngestionBatch<TEvent>(
    batch: IngestionBatch<TEvent>,
    correlationId?: string,
  ): Promise<CommitResult> {
    const { stream, expectedCursor, nextCursor, events } = batch;
    let client: PoolClient | undefined;

    try {
      client = await this.pool.connect();
    } catch (err) {
      throw new StorageError('STORAGE_UNAVAILABLE', 'failed to acquire storage connection', {
        correlationId,
        cause: err,
      });
    }

    try {
      await client.query('BEGIN');

      // Lock the checkpoint row (if any) so concurrent commits serialize.
      const { rows } = await client.query<{ cursor: string }>(
        'SELECT cursor FROM ingestion_checkpoints WHERE stream = $1 FOR UPDATE',
        [stream],
      );
      const currentCursor = rows.length > 0 ? rows[0].cursor : null;

      // Idempotent replay: the batch was already committed.
      if (currentCursor === nextCursor) {
        await client.query('COMMIT');
        this.logger.info(
          { stream, cursor: nextCursor, correlationId, replayed: true },
          'ingestion batch already committed; skipping',
        );
        return { stream, cursor: nextCursor, eventsWritten: 0, replayed: true };
      }

      // Optimistic concurrency: refuse to advance from an unexpected cursor.
      if (currentCursor !== expectedCursor) {
        await client.query('ROLLBACK');
        throw new StorageError(
          'STORAGE_CHECKPOINT_CONFLICT',
          `checkpoint for stream '${stream}' is at '${currentCursor ?? 'null'}', expected '${expectedCursor}'`,
          { correlationId },
        );
      }

      // Persist events first; the checkpoint only advances after this succeeds.
      for (const event of events) {
        await client.query(
          'INSERT INTO ingestion_events (stream, cursor, payload) VALUES ($1, $2, $3)',
          [stream, nextCursor, JSON.stringify(event)],
        );
      }

      await client.query(
        `INSERT INTO ingestion_checkpoints (stream, cursor, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (stream) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
        [stream, nextCursor],
      );

      await client.query('COMMIT');

      this.logger.info(
        { stream, cursor: nextCursor, eventsWritten: events.length, correlationId },
        'ingestion batch committed atomically',
      );
      return { stream, cursor: nextCursor, eventsWritten: events.length, replayed: false };
    } catch (err) {
      // Fail closed: never leave a partially applied batch or advanced cursor.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        this.logger.error(
          { stream, correlationId, err: rollbackErr },
          'failed to roll back ingestion batch transaction',
        );
      }

      if (err instanceof StorageError) throw err;

      this.logger.error(
        { stream, correlationId, err },
        'ingestion batch commit failed; checkpoint not advanced',
      );
      throw new StorageError('STORAGE_WRITE_FAILED', 'failed to commit ingestion batch', {
        correlationId,
        cause: err,
      });
    } finally {
      client.release();
    }
  }
}
