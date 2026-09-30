import { PoolClient } from 'pg';
import { pool } from './db';
import { logger } from './logger';
import { IngestionEvent } from './types';

/**
 * Stable error codes surfaced by the batch writer. Callers (ingestion loop)
 * rely on these to decide whether the checkpoint may advance.
 */
export type BatchWriteErrorCode =
  | 'BATCH_WRITE_FAILED'
  | 'CHECKPOINT_COMMIT_FAILED';

export class BatchWriteError extends Error {
  readonly code: BatchWriteErrorCode;
  readonly correlationId: string;

  constructor(code: BatchWriteErrorCode, message: string, correlationId: string) {
    super(message);
    this.name = 'BatchWriteError';
    this.code = code;
    this.correlationId = correlationId;
  }
}

export interface BatchWriteResult {
  /** Number of events persisted in this batch. */
  written: number;
  /** Checkpoint value durably committed alongside the batch. */
  checkpoint: number;
}

/**
 * Persist a batch of ingestion events and advance the checkpoint in a single
 * atomic transaction. Either both the events and the checkpoint are committed,
 * or neither is. This guarantees the checkpoint can never advance past events
 * that were not durably written (and vice versa), which is required for
 * idempotent, replay-safe ingestion.
 *
 * On any storage/DB failure the transaction is rolled back and a typed
 * {@link BatchWriteError} is thrown so the caller fails closed and does NOT
 * advance its in-memory checkpoint.
 */
export async function writeBatchAtomic(
  events: IngestionEvent[],
  checkpoint: number,
  correlationId: string,
): Promise<BatchWriteResult> {
  if (events.length === 0) {
    // Nothing to persist; still commit the checkpoint atomically so an empty
    // batch cannot silently skip ahead without a durable write.
    return commitCheckpointOnly(checkpoint, correlationId);
  }

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
  } catch (err) {
    logger.error('batch_writer.connect_failed', {
      correlationId,
      error: (err as Error).message,
    });
    throw new BatchWriteError(
      'BATCH_WRITE_FAILED',
      'failed to acquire database connection',
      correlationId,
    );
  }

  try {
    await client.query('BEGIN');

    for (const event of events) {
      await client.query(
        `INSERT INTO ingestion_events (id, ledger, payload, ingested_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [event.id, event.ledger, event.payload],
      );
    }

    await client.query(
      `INSERT INTO ingestion_checkpoint (id, checkpoint, updated_at)
       VALUES ('singleton', $1, NOW())
       ON CONFLICT (id) DO UPDATE
         SET checkpoint = EXCLUDED.checkpoint, updated_at = NOW()`,
      [checkpoint],
    );

    await client.query('COMMIT');

    logger.info('batch_writer.committed', {
      correlationId,
      written: events.length,
      checkpoint,
    });

    return { written: events.length, checkpoint };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('batch_writer.rollback_failed', {
        correlationId,
        error: (rollbackErr as Error).message,
      });
    }

    logger.error('batch_writer.commit_failed', {
      correlationId,
      error: (err as Error).message,
    });

    throw new BatchWriteError(
      'CHECKPOINT_COMMIT_FAILED',
      'atomic batch/checkpoint commit failed',
      correlationId,
    );
  } finally {
    client.release();
  }
}

async function commitCheckpointOnly(
  checkpoint: number,
  correlationId: string,
): Promise<BatchWriteResult> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
  } catch (err) {
    logger.error('batch_writer.connect_failed', {
      correlationId,
      error: (err as Error).message,
    });
    throw new BatchWriteError(
      'BATCH_WRITE_FAILED',
      'failed to acquire database connection',
      correlationId,
    );
  }

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ingestion_checkpoint (id, checkpoint, updated_at)
       VALUES ('singleton', $1, NOW())
       ON CONFLICT (id) DO UPDATE
         SET checkpoint = EXCLUDED.checkpoint, updated_at = NOW()`,
      [checkpoint],
    );
    await client.query('COMMIT');
    return { written: 0, checkpoint };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('batch_writer.rollback_failed', {
        correlationId,
        error: (rollbackErr as Error).message,
      });
    }
    logger.error('batch_writer.commit_failed', {
      correlationId,
      error: (err as Error).message,
    });
    throw new BatchWriteError(
      'CHECKPOINT_COMMIT_FAILED',
      'atomic checkpoint commit failed',
      correlationId,
    );
  } finally {
    client.release();
  }
}
