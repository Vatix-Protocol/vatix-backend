/**
 * Finalization Job Types
 *
 * Strongly-typed representations of finalization job inputs, outputs,
 * and intermediate state. No `any` — every value is explicitly typed.
 *
 * @module apps/workers/src/finalization/types
 */

/** Status of an individual finalization candidate after processing. */
export type FinalizationCandidateStatus =
  | "finalized"
  | "skipped"
  | "errored";

/** Result of processing a single finalization candidate. */
export interface FinalizationCandidateResult {
  /** Resolution candidate ID. */
  candidateId: string;
  /** Associated market ID. */
  marketId: string;
  /** Outcome that was finalized. */
  proposedOutcome: boolean;
  /** Processing status. */
  status: FinalizationCandidateStatus;
  /** Error message if status is "errored". */
  error?: string;
}

/** Aggregate result of a finalization job run. */
export interface FinalizationJobResult {
  /** Total candidates evaluated. */
  totalCandidates: number;
  /** Number successfully finalized. */
  finalizedCount: number;
  /** Number skipped (e.g. already finalized or still in challenge window). */
  skippedCount: number;
  /** Number that errored during finalization. */
  erroredCount: number;
  /** Per-candidate results. */
  candidates: FinalizationCandidateResult[];
  /** ISO timestamp when the job started. */
  startedAt: string;
  /** ISO timestamp when the job completed. */
  completedAt: string;
  /** Duration of the job run in milliseconds. */
  durationMs: number;
}

/**
 * Valid OS signals that trigger a graceful shutdown.
 * Constrained to the three signals the finalization worker handles.
 */
export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/**
 * Async handler invoked when a shutdown signal is received.
 * Receives the signal name, performs cleanup, and exits the process.
 */
export type ShutdownHandler = (signal: ShutdownSignal) => Promise<void>;

/** Payload shape for a finalization job enqueued via Redis or similar. */
export interface FinalizationJobPayload {
  /** Unique job ID for idempotency. */
  jobId: string;
  /** Challenge window override in seconds (uses config default if omitted). */
  challengeWindowSeconds?: number;
  /** ISO timestamp when the job was enqueued. */
  enqueuedAt: string;
}
