/**
 * Submission Queue Types
 *
 * Typed representation of items held in the oracle submission queue
 * before they are dispatched on-chain.
 *
 * @module apps/oracle/submission-queue
 */

import type { ProviderResult, ResolutionRequest } from "./provider-adapter.js";
import type { ILogger } from "../../packages/shared/src/logger.js";

/** Possible states of a queued submission. */
export type SubmissionStatus =
  | "pending"
  | "submitted"
  | "failed"
  /**
   * Poison message: the item exceeded the retry threshold or was rejected as
   * un-processable and must not be retried automatically (#1150).
   */
  | "quarantined";

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
  /** ISO timestamp when the item was quarantined as a poison message (#1150). */
  quarantinedAt?: string;
}

export interface SubmissionQueueLogMeta {
  id: string;
  marketId: string;
  oracleAddress: string;
  status: SubmissionStatus;
  enqueuedAt: string;
  attempts?: number;
  lastAttemptAt?: string;
  lastError?: string;
  /** Populated only for quarantined (poison) items (#1150). */
  quarantinedAt?: string;
}

/** Snapshot of the submission queue at a point in time. */
export interface SubmissionQueueSnapshot {
  pending: number;
  submitted: number;
  failed: number;
  /** Items held back as poison messages (#1150). */
  quarantined?: number;
  items: SubmissionQueueItem[];
}

const VALID_STATUSES: SubmissionStatus[] = [
  "pending",
  "submitted",
  "failed",
  "quarantined",
];

/**
 * Stable, machine-readable error codes for the submission queue (#1150).
 * Callers (workers, dashboards) branch on `code`; messages are never parsed.
 */
export const SUBMISSION_QUEUE_ERROR_CODES = {
  /** The item failed validation — never enqueued. */
  SUBMISSION_QUEUE_INVALID_ITEM: "SUBMISSION_QUEUE_INVALID_ITEM",
  /** Attempts exceeded the poison threshold — the item is quarantined. */
  SUBMISSION_QUEUE_POISON: "SUBMISSION_QUEUE_POISON",
  /** The in-memory queue is at capacity — shed load, fail closed. */
  SUBMISSION_QUEUE_FULL: "SUBMISSION_QUEUE_FULL",
  /**
   * A replayed enqueue reused an existing `id` with a *different* payload.
   * The queue never overwrites a live entry (no double submission, no
   * silently-swallowed conflicting resolution); the caller must reconcile.
   */
  SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT:
    "SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT",
  /** The referenced item does not exist in the queue. */
  SUBMISSION_QUEUE_NOT_FOUND: "SUBMISSION_QUEUE_NOT_FOUND",
} as const;

export type SubmissionQueueErrorCode =
  (typeof SUBMISSION_QUEUE_ERROR_CODES)[keyof typeof SUBMISSION_QUEUE_ERROR_CODES];

/** Correlation id for a single queue operation (#1150). */
function newQueueCorrelationId(): string {
  return `sq_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Deterministic idempotency key for a submission (#1114).
 *
 * The enqueue `id` is the queue's deduplication key, so it must be a pure
 * function of the resolution being submitted — never of wall-clock time or
 * randomness. Two producers (or the same producer after a crash/replay) that
 * resolved the same market to the same outcome at the same instant therefore
 * derive the same key, and the second enqueue is a no-op instead of a second
 * on-chain submission.
 *
 * Components:
 *   - `marketId`    : the market being resolved
 *   - `oracleAddress`: the submitting oracle account (different oracle ⇒
 *                      different submission, never deduplicated together)
 *   - `resolvedAt`  : the provider's resolution timestamp, normalised to UTC
 *                      ISO-8601 so equivalent spellings collapse to one key
 *
 * @throws {SubmissionQueueValidationError} when any component is missing or
 *   `resolvedAt` is not a parseable date.
 */
export function buildSubmissionIdempotencyKey(input: {
  marketId: string;
  oracleAddress: string;
  resolvedAt: string;
}): string {
  const { marketId, oracleAddress, resolvedAt } = input ?? {};

  if (!marketId || typeof marketId !== "string") {
    throw new SubmissionQueueValidationError(
      "idempotency key requires a non-empty marketId"
    );
  }
  if (!oracleAddress || typeof oracleAddress !== "string") {
    throw new SubmissionQueueValidationError(
      "idempotency key requires a non-empty oracleAddress"
    );
  }

  const resolvedAtMs = Date.parse(resolvedAt ?? "");
  if (!Number.isFinite(resolvedAtMs)) {
    throw new SubmissionQueueValidationError(
      "idempotency key requires resolvedAt to be an ISO-8601 date string"
    );
  }

  return `${marketId}:${oracleAddress}:${new Date(resolvedAtMs).toISOString()}`;
}

/**
 * True when two items carry the same resolution payload, i.e. a replay of the
 * same work (#1114). Compares only the resolution facts — never the queue's
 * mutable bookkeeping (`status`, `attempts`, timestamps).
 */
export function isSameSubmissionPayload(
  a: Pick<SubmissionQueueItem, "request" | "result">,
  b: Pick<SubmissionQueueItem, "request" | "result">
): boolean {
  return (
    a.request.marketId === b.request.marketId &&
    a.request.oracleAddress === b.request.oracleAddress &&
    a.result.outcome === b.result.outcome &&
    a.result.timestamp === b.result.timestamp &&
    a.result.source === b.result.source
  );
}

/**
 * Typed operational error for the submission queue. Always carries a stable
 * `code`, a `correlationId` for log/metric stitching, and a `retryable` flag
 * so consumers know whether a replay could ever succeed. Never embeds secrets
 * or raw dependency addresses.
 */
export class SubmissionQueueError extends Error {
  readonly code: SubmissionQueueErrorCode;
  readonly correlationId: string;
  /** False for permanent failures (poison) — retrying cannot succeed. */
  readonly retryable: boolean;
  readonly statusCode: number;
  readonly itemId?: string;

  constructor(
    code: SubmissionQueueErrorCode,
    message: string,
    options: {
      correlationId?: string;
      retryable?: boolean;
      statusCode?: number;
      itemId?: string;
    } = {}
  ) {
    super(message);
    this.name = "SubmissionQueueError";
    this.code = code;
    this.correlationId = options.correlationId ?? newQueueCorrelationId();
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? 500;
    this.itemId = options.itemId;
  }
}

/**
 * Thrown when a queue item is malformed. Retains its historical name,
 * `statusCode = 400`, and message behaviour; now also carries the stable
 * `SUBMISSION_QUEUE_INVALID_ITEM` code (#1150).
 */
export class SubmissionQueueValidationError extends Error {
  readonly statusCode = 400;
  readonly code = SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_INVALID_ITEM;
  readonly correlationId: string;

  constructor(message: string, correlationId?: string) {
    super(message);
    this.name = "SubmissionQueueValidationError";
    this.correlationId = correlationId ?? newQueueCorrelationId();
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

/**
 * In-memory submission queue (deprecated — use Redis via apps/workers/src/oracle/redis-submission-queue.ts).
 * Provided for backwards compatibility during migration.
 *
 * ## Poison handling (#1150)
 *
 * A *poison message* is a submission that cannot succeed no matter how often
 * it is retried (malformed payload, permanently rejected on-chain, ...).
 * Unhandled, one such item pins a worker in a retry loop and starves every
 * other market's resolution. The queue therefore:
 *
 * 1. Counts attempts per item. At `maxAttemptsBeforeQuarantine` the item moves
 *    to the terminal `quarantined` status and can never leave it — replaying
 *    the same `id` throws `SUBMISSION_QUEUE_POISON` (non-retryable) so the
 *    consumer dead-letters it instead of re-arming the loop.
 * 2. Caps the queue at `maxQueueDepth`, failing closed with
 *    `SUBMISSION_QUEUE_FULL` (retryable) so an untrusted producer cannot grow
 *    the process without bound.
 * 3. Idempotently deduplicates re-enqueues of a live item by `id` — a replay
 *    after a crash returns the existing entry rather than double-submitting.
 *    The `id` must be derived with `buildSubmissionIdempotencyKey()` (a pure
 *    function of the resolution) so a replay after a crash, a duplicated poll
 *    cycle, or a second producer collides instead of queueing twice (#1114).
 *    A replayed id carrying a *different* payload is a conflict, not a
 *    replay: it raises the non-retryable
 *    `SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT` and never overwrites the live
 *    entry.
 *
 * Every failure path logs a structured message with the item `id`, `marketId`,
 * attempts, and a correlation id, and never with provider payloads or secrets.
 */
export class SubmissionQueue {
  private items: SubmissionQueueItem[] = [];
  /** Attempts after which an item becomes a poison message (#1150). */
  readonly maxAttemptsBeforeQuarantine: number;
  /** Maximum retained (non-quarantined) items before shedding load (#1150). */
  readonly maxQueueDepth: number;
  /** Conflict policy for a replayed id carrying a different payload (#1114). */
  readonly idempotencyConflict: "throw" | "return-existing";

  constructor(
    private readonly logger: ILogger,
    config: SubmissionQueueConfig = {}
  ) {
    this.maxAttemptsBeforeQuarantine =
      config.maxAttemptsBeforeQuarantine ??
      readPositiveIntEnv(
        "ORACLE_SUBMISSION_POISON_MAX_ATTEMPTS",
        DEFAULT_MAX_ATTEMPTS_BEFORE_QUARANTINE
      );
    this.maxQueueDepth =
      config.maxQueueDepth ??
      readPositiveIntEnv(
        "ORACLE_SUBMISSION_QUEUE_MAX_DEPTH",
        DEFAULT_MAX_QUEUE_DEPTH
      );
    this.idempotencyConflict = config.idempotencyConflict ?? "throw";
  }

  enqueue(item: SubmissionQueueItem): SubmissionQueueItem {
    validateSubmissionQueueItem(item);

    const existing = this.get(item.id);

    // Replayed enqueue of a live item: idempotent no-op (#1150) so a crash
    // between "enqueued" and "acknowledged" never double-submits.
    if (existing && existing.status !== "quarantined") {
      // Same id but a different resolution is NOT a replay — it is a
      // conflicting write. Silently keeping the first entry would hide a
      // genuine disagreement (or a hijacked id), so it is surfaced with a
      // stable code and the existing entry is left untouched (#1114).
      if (!isSameSubmissionPayload(existing, item)) {
        const correlationId = newQueueCorrelationId();
        this.logger.warn("Oracle submission idempotency conflict", {
          id: item.id,
          marketId: item.request.marketId,
          oracleAddress: item.request.oracleAddress,
          status: existing.status,
          enqueuedAt: existing.enqueuedAt,
          attempts: existing.attempts,
          correlationId,
          code: SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT,
        } satisfies SubmissionQueueLogMeta);

        if (this.idempotencyConflict === "throw") {
          throw new SubmissionQueueError(
            SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT,
            `Submission ${item.id} already exists with a different resolution payload`,
            {
              correlationId,
              itemId: item.id,
              statusCode: 409,
              retryable: false,
            }
          );
        }
      }

      this.logger.info("Oracle submission deduplicated", {
        id: item.id,
        marketId: item.request.marketId,
        oracleAddress: item.request.oracleAddress,
        status: existing.status,
        enqueuedAt: existing.enqueuedAt,
        attempts: existing.attempts,
      } satisfies SubmissionQueueLogMeta);
      return existing;
    }

    // A replayed poison item must never re-enter the loop (#1150).
    if (
      existing?.status === "quarantined" ||
      item.status === "quarantined" ||
      item.attempts >= this.maxAttemptsBeforeQuarantine
    ) {
      // Retain the item so operators can inspect it in the snapshot/DLQ.
      if (!existing) {
        this.items.push(item);
      }
      this.quarantineItem(
        existing ?? item,
        existing ? "replay of quarantined item" : "attempt threshold exceeded"
      );
      throw new SubmissionQueueError(
        SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_POISON,
        `Submission ${item.id} is a poison message and cannot be enqueued`,
        {
          correlationId: newQueueCorrelationId(),
          itemId: item.id,
          statusCode: 422,
          retryable: false,
        }
      );
    }

    // Depth guard: fail closed rather than growing memory without bound (#1150).
    const live = this.items.filter((i) => i.status !== "quarantined").length;
    if (live >= this.maxQueueDepth) {
      throw new SubmissionQueueError(
        SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_FULL,
        `Submission queue is at capacity (${live}/${this.maxQueueDepth})`,
        {
          correlationId: newQueueCorrelationId(),
          statusCode: 503,
          retryable: true,
        }
      );
    }

    this.items.push(item);
    this.logger.info("Oracle submission queued", {
      id: item.id,
      marketId: item.request.marketId,
      oracleAddress: item.request.oracleAddress,
      status: item.status,
      enqueuedAt: item.enqueuedAt,
      attempts: item.attempts,
      lastAttemptAt: item.lastAttemptAt,
      lastError: item.lastError,
    } satisfies SubmissionQueueLogMeta);

    return item;
  }

  /**
   * Look up an item by id. Returns `undefined` when unknown.
   */
  get(id: string): SubmissionQueueItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  /**
   * Look up an item by id or throw `SUBMISSION_QUEUE_NOT_FOUND` (#1150).
   */
  require(id: string): SubmissionQueueItem {
    const item = this.get(id);
    if (!item) {
      throw new SubmissionQueueError(
        SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_NOT_FOUND,
        `Submission ${id} is not in the queue`,
        { itemId: id, statusCode: 404 }
      );
    }
    return item;
  }

  /**
   * Record a failed attempt. At `maxAttemptsBeforeQuarantine` the item is
   * quarantined as a poison message; further calls are idempotent and never
   * un-quarantine it (#1150).
   *
   * @returns the updated item.
   */
  recordFailure(id: string, errorMessage: string): SubmissionQueueItem {
    const item = this.require(id);

    if (item.status === "quarantined") {
      return item;
    }

    item.attempts += 1;
    item.lastAttemptAt = new Date().toISOString();
    // Cap the stored error so a hostile/verbose producer cannot bloat memory.
    item.lastError = truncateForLog(errorMessage);

    if (item.attempts >= this.maxAttemptsBeforeQuarantine) {
      this.quarantineItem(item, "attempt threshold exceeded");
      return item;
    }

    item.status = "failed";
    this.logger.warn("Oracle submission attempt failed", {
      id: item.id,
      marketId: item.request.marketId,
      oracleAddress: item.request.oracleAddress,
      status: item.status,
      enqueuedAt: item.enqueuedAt,
      attempts: item.attempts,
      lastAttemptAt: item.lastAttemptAt,
      lastError: item.lastError,
    } satisfies SubmissionQueueLogMeta);

    return item;
  }

  /**
   * Record a successful submission (#1150). A quarantined item stays
   * quarantined — quarantine is terminal, so an automated success can never
   * clear it; releasing is an explicit operator action.
   */
  recordSuccess(id: string): SubmissionQueueItem {
    const item = this.require(id);
    if (item.status === "quarantined") {
      return item;
    }

    item.status = "submitted";
    item.lastAttemptAt = new Date().toISOString();
    return item;
  }

  /**
   * Move an item to the terminal `quarantined` state and emit a single
   * error-level log so operators can alert on poison messages (#1150).
   * Idempotent: a quarantined item is returned unchanged.
   */
  quarantine(id: string, reason: string): SubmissionQueueItem {
    return this.quarantineItem(this.require(id), reason);
  }

  /** Shared quarantine implementation operating on an already-resolved item. */
  private quarantineItem(
    item: SubmissionQueueItem,
    reason: string
  ): SubmissionQueueItem {
    if (item.status === "quarantined") {
      return item;
    }

    item.status = "quarantined";
    item.quarantinedAt = new Date().toISOString();

    this.logger.error("Oracle submission quarantined as poison message", {
      id: item.id,
      marketId: item.request.marketId,
      oracleAddress: item.request.oracleAddress,
      status: item.status,
      enqueuedAt: item.enqueuedAt,
      attempts: item.attempts,
      lastAttemptAt: item.lastAttemptAt,
      quarantinedAt: item.quarantinedAt,
      reason,
    } satisfies SubmissionQueueLogMeta);

    return item;
  }

  /**
   * Snapshot grouped by status, including quarantined items so operators can
   * size the DLQ/replay work (#1150).
   */
  getSnapshot(): SubmissionQueueSnapshot {
    const countBy = (status: SubmissionStatus) =>
      this.items.filter((item) => item.status === status).length;

    return {
      pending: countBy("pending"),
      submitted: countBy("submitted"),
      failed: countBy("failed"),
      quarantined: countBy("quarantined"),
      items: [...this.items],
    };
  }
}

// ---------------------------------------------------------------------------
// Poison-handling configuration (#1150)
// ---------------------------------------------------------------------------

export interface SubmissionQueueConfig {
  /**
   * Attempts after which an item is quarantined as a poison message.
   * Defaults to `ORACLE_SUBMISSION_POISON_MAX_ATTEMPTS`, then 5.
   */
  maxAttemptsBeforeQuarantine?: number;
  /**
   * Maximum retained (non-quarantined) items. Defaults to
   * `ORACLE_SUBMISSION_QUEUE_MAX_DEPTH`, then 10000.
   */
  maxQueueDepth?: number;
  /**
   * What `enqueue` does when the same `id` arrives with a *different*
   * resolution payload (#1114).
   *
   * - `"throw"` (default, fail-closed): raises the non-retryable
   *   `SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT` (409) and leaves the existing
   *   entry untouched, so a conflicting write is never silently swallowed.
   * - `"return-existing"`: logs the conflict and returns the existing entry
   *   (previous behaviour — the replay is still a no-op, so this never
   *   double-submits).
   */
  idempotencyConflict?: "throw" | "return-existing";
}

export const DEFAULT_MAX_ATTEMPTS_BEFORE_QUARANTINE = 5;
export const DEFAULT_MAX_QUEUE_DEPTH = 10_000;

/** Longest `lastError` retained on an item (hostile-producer bloat guard). */
const MAX_ERROR_LENGTH = 512;

function truncateForLog(value: string): string {
  if (typeof value !== "string") {
    return String(value).slice(0, MAX_ERROR_LENGTH);
  }
  return value.length > MAX_ERROR_LENGTH
    ? `${value.slice(0, MAX_ERROR_LENGTH)}…`
    : value;
}

/**
 * Read a positive-integer env var, falling back to `fallback` for absent,
 * blank, non-integer, or non-positive values — a broken value must never
 * disable the poison guard (fail closed to the safe default).
 */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }

  return value;
}
