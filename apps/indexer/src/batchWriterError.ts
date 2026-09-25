/**
 * Typed batch-writer errors.
 *
 * Lives in its own dependency-free module so consumers (notably the gap
 * back-fill job) can import the error *value* without dragging in the Prisma
 * client and its `DATABASE_URL` env validation at module load (#1151/#1152).
 *
 * @module apps/indexer/src/batchWriterError
 */

/**
 * Stable, typed error codes surfaced by the batch writer. Callers (and ops
 * dashboards) can branch on `code` without parsing free-form messages.
 *
 * - `BATCH_WRITE_TOO_LARGE` (#1152) — the batch exceeded the configured hard
 *   record cap. Fails closed: nothing is sent to the database.
 * - `BATCH_WRITE_INVALID_INPUT` (#1152) — the caller passed something other
 *   than an array of records. Fails closed: nothing is sent to the database.
 */
export type BatchWriteErrorCode =
  | "BATCH_WRITE_DEPENDENCY_UNAVAILABLE"
  | "BATCH_WRITE_FAILED"
  | "BATCH_WRITE_TOO_LARGE"
  | "BATCH_WRITE_INVALID_INPUT";

/**
 * Thrown when a batch cannot be committed. The batch is applied atomically or
 * not at all — a mid-batch failure aborts the transaction and rolls back every
 * record, so callers never observe a partially persisted batch.
 */
export class BatchWriteError extends Error {
  readonly code: BatchWriteErrorCode;
  readonly correlationId: string;
  readonly cause?: unknown;

  constructor(
    code: BatchWriteErrorCode,
    message: string,
    correlationId: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "BatchWriteError";
    this.code = code;
    this.correlationId = correlationId;
    this.cause = cause;
  }
}
