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
