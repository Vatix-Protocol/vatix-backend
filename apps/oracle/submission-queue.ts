/**
 * Submission Queue Types
 *
 * Typed representation of items held in the oracle submission queue
 * before they are dispatched on-chain.
 *
 * @module apps/oracle/submission-queue
 */

import type { ProviderResult, ResolutionRequest } from "./provider-adapter.js";

/** Possible states of a queued submission. */
export type SubmissionStatus = "pending" | "submitted" | "failed";

/** A single item waiting to be submitted to the chain. */
export interface SubmissionQueueItem {
  /** Unique identifier for this queue entry. */
  id: string;
  /** The original resolution request that triggered this submission. */
  request: ResolutionRequest;
  /** The resolved result from the provider. */
  result: ProviderResult;
  /** Current processing status. */
  status: SubmissionStatus;
  /** ISO timestamp when the item was enqueued. */
  enqueuedAt: string;
  /** Number of submission attempts made so far. */
  attempts: number;
  /** ISO timestamp of the last attempt, if any. */
  lastAttemptAt?: string;
  /** Error message from the last failed attempt, if any. */
  lastError?: string;
}

/** Snapshot of the submission queue at a point in time. */
export interface SubmissionQueueSnapshot {
  pending: number;
  submitted: number;
  failed: number;
  items: SubmissionQueueItem[];
}

const VALID_STATUSES: SubmissionStatus[] = ["pending", "submitted", "failed"];

export class SubmissionQueueValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "SubmissionQueueValidationError";
  }
}

/**
 * Validates a SubmissionQueueItem, throwing a 400-status error on invalid input.
 *
 * @throws {SubmissionQueueValidationError} When the item is invalid.
 */
export function validateSubmissionQueueItem(
  item: unknown
): SubmissionQueueItem {
  if (!item || typeof item !== "object") {
    throw new SubmissionQueueValidationError("item must be an object");
  }
  const i = item as Record<string, unknown>;

  if (!i.id || typeof i.id !== "string") {
    throw new SubmissionQueueValidationError("id must be a non-empty string");
  }
  if (!i.request || typeof i.request !== "object") {
    throw new SubmissionQueueValidationError("request must be an object");
  }
  const req = i.request as Record<string, unknown>;
  if (!req.marketId || typeof req.marketId !== "string") {
    throw new SubmissionQueueValidationError(
      "request.marketId must be a non-empty string"
    );
  }
  if (!req.oracleAddress || typeof req.oracleAddress !== "string") {
    throw new SubmissionQueueValidationError(
      "request.oracleAddress must be a non-empty string"
    );
  }
  if (!i.result || typeof i.result !== "object") {
    throw new SubmissionQueueValidationError("result must be an object");
  }
  if (!VALID_STATUSES.includes(i.status as SubmissionStatus)) {
    throw new SubmissionQueueValidationError(
      `status must be one of: ${VALID_STATUSES.join(", ")}`
    );
  }
  if (!i.enqueuedAt || typeof i.enqueuedAt !== "string") {
    throw new SubmissionQueueValidationError(
      "enqueuedAt must be a non-empty string"
    );
  }
  if (!Number.isInteger(i.attempts) || (i.attempts as number) < 0) {
    throw new SubmissionQueueValidationError(
      "attempts must be a non-negative integer"
    );
  }

  return item as SubmissionQueueItem;
}

export interface QueueLogger {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}

export class SubmissionQueue {
  private items: SubmissionQueueItem[] = [];
  
  // Use structured logging
  constructor(private readonly logger: QueueLogger) {}

  enqueue(item: SubmissionQueueItem): void {
    validateSubmissionQueueItem(item);
    this.items.push(item);
    this.logger.info("Submission queued successfully", {
      id: item.id,
      marketId: item.request.marketId,
      oracleAddress: item.request.oracleAddress,
      status: item.status,
      enqueuedAt: item.enqueuedAt
    });
  }
}
