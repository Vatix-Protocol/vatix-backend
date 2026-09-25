/**
 * Shared BullMQ job options and queue-name helpers for all queues
 * (settlement + oracle submission).
 *
 * Unified retry / backoff / DLQ configuration — ADR 001.
 * Single source of truth for queue names — #779.
 * Single source of truth for Redis connection auth/TLS options — #1131.
 *
 * @module packages/shared/src/queue-config
 */
import { readFileSync } from "node:fs";
import type { JobsOptions } from "bullmq";

/**
 * Stable Redis connection error codes (#1131). Operators and tests match on
 * these; the messages are advisory. See docs/queue-consumer.md.
 */
export const REDIS_CONFIG_ERROR_CODES = {
  /** REDIS_URL is unset in production. */
  REDIS_URL_REQUIRED: "REDIS_URL_REQUIRED",
  /** REDIS_TLS_REQUIRED=true but TLS is not enabled. */
  REDIS_TLS_REQUIRED: "REDIS_TLS_REQUIRED",
  /** TLS scheme and flag contradict each other, or the flag is not boolean. */
  REDIS_TLS_CONFLICT: "REDIS_TLS_CONFLICT",
  /** REDIS_TLS_CA_FILE points at an unreadable path. */
  REDIS_TLS_CA_UNREADABLE: "REDIS_TLS_CA_UNREADABLE",
  /** A Redis ACL username was supplied without a password. */
  REDIS_AUTH_INCOMPLETE: "REDIS_AUTH_INCOMPLETE",
} as const;

export type RedisConfigErrorCode =
  (typeof REDIS_CONFIG_ERROR_CODES)[keyof typeof REDIS_CONFIG_ERROR_CODES];

/**
 * Thrown when Redis connection options cannot be resolved safely. Carries a
 * stable `code` and never includes a password or CA file contents.
 */
export class RedisConfigError extends Error {
  readonly code: RedisConfigErrorCode;

  constructor(code: RedisConfigErrorCode, message: string) {
    super(message);
    this.name = "RedisConfigError";
    this.code = code;
  }
}

/**
 * Job options for the settlement queue (on-chain trade settlement).
 *
 * - attempts:         3 retries before moving to DLQ
 * - backoff:          exponential, starting at 1 s (1 s, 2 s, 4 s …)
 * - removeOnComplete: keep the last 100 completed jobs for observability
 * - removeOnFail:     false — retain ALL failed jobs as DLQ so they can be
 *                     inspected and replayed without data loss
 */
export const SETTLEMENT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
};

/**
 * Job options for the oracle submission queue (Stellar contract calls
 * that finalize market resolution). Oracle submissions are more transient
 * failure-prone (RPC rate limits, ledger congestion) than settlement, so
 * they get more attempts with a shorter initial backoff to keep resolution
 * latency low without hammering the RPC endpoint.
 *
 * - attempts:         8 retries before moving to DLQ
 * - backoff:          exponential, starting at 500 ms (500 ms, 1 s, 2 s …)
 * - removeOnComplete: keep the last 100 completed jobs for observability
 * - removeOnFail:     false — retain ALL failed jobs as DLQ so they can be
 *                     inspected and replayed without data loss
 */
export const ORACLE_SUBMISSION_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: "exponential", delay: 500 },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
};

/**
 * @deprecated Use {@link SETTLEMENT_JOB_OPTIONS} or
 * {@link ORACLE_SUBMISSION_JOB_OPTIONS} explicitly. Kept as an alias to
 * SETTLEMENT_JOB_OPTIONS for backward compatibility with existing callers;
 * do not add new usages of this export since a single shared default is
 * exactly the bug this module fixes (#issue: queue-config backoff split).
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = SETTLEMENT_JOB_OPTIONS;

/**
 * Returns the fully-qualified BullMQ queue name for the settlement worker.
 *
 * Format: `${REDIS_KEY_PREFIX}${SETTLEMENT_QUEUE_NAME}`
 *
 * Evaluated at call-time so tests can override env vars without module-cache
 * complications.
 */
export function settlementQueueName(): string {
  const name = process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
  const prefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
  return `${prefix}${name}`;
}

/**
 * Returns the BullMQ queue name for the oracle submission worker.
 *
 * The oracle submission queue intentionally omits the key prefix because the
 * BullMQ Worker is scoped to the oracle service and does not share a Redis
 * keyspace with the settlement worker.
 *
 * Evaluated at call-time so tests can override env vars without module-cache
 * complications.
 */
export function submissionQueueName(): string {
  return process.env.SUBMISSION_QUEUE_NAME ?? "oracle-submissions";
}

/**
 * Build a Redis connection config from the environment.
 *
 * In production, falling back to localhost when REDIS_URL is unset is a
 * silent misconfiguration: the queue would connect to a Redis instance that
 * almost certainly isn't the production broker, and jobs (settlement,
 * oracle submissions) would appear to enqueue successfully while never
 * reaching a worker that processes real trades. Fail fast instead so the
 * process crashes at startup rather than silently dropping production
 * trades/resolutions.
 */
export function redisConnectionFromEnv(): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: { rejectUnauthorized: boolean; ca?: string };
} {
  if (!process.env.REDIS_URL && process.env.NODE_ENV === "production") {
    throw new RedisConfigError(
      REDIS_CONFIG_ERROR_CODES.REDIS_URL_REQUIRED,
      "REDIS_URL is required in production (NODE_ENV=production) — refusing to fall back to localhost:6379 for queue connections"
    );
  }

  const raw = process.env.REDIS_URL ?? "redis://localhost:6379";
  // Strip scheme, split auth@hostport
  const noScheme = raw.replace(/^rediss?:\/\//, "");
  const atIdx = noScheme.lastIndexOf("@");
  const hostPort = atIdx >= 0 ? noScheme.slice(atIdx + 1) : noScheme;
  const authPart = atIdx >= 0 ? noScheme.slice(0, atIdx) : "";
  const [host, portStr] = hostPort.split(":");
  const auth = redisAuthFromEnv(process.env, authPart);
  const tls = redisTlsFromEnv(raw, process.env);

  return {
    host: host || "localhost",
    port: Number(portStr) || 6379,
    ...(auth.username ? { username: auth.username } : {}),
    ...(auth.password ? { password: auth.password } : {}),
    ...(tls ? { tls } : {}),
  };
}

/**
 * Strips credentials from a Redis URL so it can be logged safely
 * (e.g. `rediss://***@cache.internal:6380`). Returns `"***"` when the input is
 * not parseable — callers must never fall back to logging the raw value.
 */
export function redactRedisUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    // URL serialization appends "/" for an empty path; strip it so the
    // output is stable for dashboards and alert fingerprints.
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "***";
  }
}

/**
 * Resolves Redis ACL credentials from `REDIS_USERNAME`/`REDIS_PASSWORD`,
 * falling back to the credentials embedded in REDIS_URL. Explicit env vars
 * win, so an operator can rotate a password without editing the URL.
 *
 * Fail-closed: a username without a password is rejected — otherwise the
 * handshake would either fall back to the default user or fail at request
 * time instead of at boot.
 *
 * @param env     Environment map (process.env, or a stub in tests).
 * @param urlAuth The `user:pass` segment parsed out of REDIS_URL, if any.
 */
export function redisAuthFromEnv(
  env: Record<string, string | undefined>,
  urlAuth = ""
): { username?: string; password?: string } {
  const separator = urlAuth.indexOf(":");
  const urlUsername = separator >= 0 ? urlAuth.slice(0, separator) : "";
  const urlPassword = separator >= 0 ? urlAuth.slice(separator + 1) : urlAuth;

  const username = env.REDIS_USERNAME?.trim() || urlUsername || undefined;
  const password = env.REDIS_PASSWORD ?? (urlPassword || undefined);

  if (username && !password) {
    throw new RedisConfigError(
      REDIS_CONFIG_ERROR_CODES.REDIS_AUTH_INCOMPLETE,
      "REDIS_USERNAME is set without REDIS_PASSWORD — refusing to connect with incomplete Redis ACL credentials"
    );
  }

  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/**
 * Resolves Redis ACL credentials for a client whose connection is built from
 * `REDIS_URL` (ioredis, bullmq). URL credentials are decoded and then handed
 * to {@link redisAuthFromEnv} so explicit `REDIS_USERNAME`/`REDIS_PASSWORD`
 * env vars still win. An unparseable URL is not fatal here — the client will
 * fail on connect with a clearer error, and env credentials can still apply.
 */
export function redisAuthFromUrl(
  redisUrl: string,
  env: Record<string, string | undefined>
): { username?: string; password?: string } {
  let urlAuth = "";
  try {
    const parsed = new URL(redisUrl);
    const user = parsed.username ? decodeURIComponent(parsed.username) : "";
    const pass = parsed.password ? decodeURIComponent(parsed.password) : "";
    if (user || pass) urlAuth = `${user}:${pass}`;
  } catch {
    // Deliberately ignored: an unparseable URL is rejected at connect time.
  }
  return redisAuthFromEnv(env, urlAuth);
}

/**
 * Resolves Redis TLS settings from the environment (#1131).
 *
 * - `REDIS_TLS=true` forces TLS even for a `redis://` URL; a `rediss://` URL
 *   implies TLS on its own.
 * - `REDIS_TLS=false` alongside a `rediss://` URL is rejected: the scheme and
 *   the flag disagree, and guessing which one was meant is how a plaintext
 *   connection ends up pointed at a TLS-only endpoint.
 * - `REDIS_TLS_REQUIRED=true` makes the requirement explicit — boot fails
 *   closed if TLS ends up disabled.
 * - `REDIS_TLS_REJECT_UNAUTHORIZED=false` is supported for private-CA
 *   deployments but only when set explicitly (never implied).
 * - `REDIS_TLS_CA_FILE` / `REDIS_TLS_CA_CERT` pin the CA bundle used to
 *   verify the server certificate.
 *
 * Returns `undefined` when TLS is off, so callers can spread the result into
 * connection options without a conditional.
 */
export function redisTlsFromEnv(
  redisUrl: string,
  env: Record<string, string | undefined>
): { rejectUnauthorized: boolean; ca?: string } | undefined {
  const schemeIsTls = /^rediss:\/\//i.test(redisUrl);
  const flag = env.REDIS_TLS?.trim().toLowerCase();

  if (
    flag !== undefined &&
    flag !== "" &&
    flag !== "true" &&
    flag !== "false"
  ) {
    throw new RedisConfigError(
      REDIS_CONFIG_ERROR_CODES.REDIS_TLS_CONFLICT,
      'REDIS_TLS must be "true" or "false"'
    );
  }

  if (flag === "false" && schemeIsTls) {
    throw new RedisConfigError(
      REDIS_CONFIG_ERROR_CODES.REDIS_TLS_CONFLICT,
      "REDIS_TLS=false conflicts with a rediss:// REDIS_URL — remove one of them so the TLS intent is unambiguous"
    );
  }

  const required = ["true", "1"].includes(
    env.REDIS_TLS_REQUIRED?.trim().toLowerCase() ?? ""
  );
  const enabled = schemeIsTls || flag === "true";

  if (required && !enabled) {
    throw new RedisConfigError(
      REDIS_CONFIG_ERROR_CODES.REDIS_TLS_REQUIRED,
      "REDIS_TLS_REQUIRED=true but TLS is not enabled — use a rediss:// REDIS_URL or set REDIS_TLS=true"
    );
  }

  if (!enabled) return undefined;

  const caFile = env.REDIS_TLS_CA_FILE?.trim();
  const caCert = env.REDIS_TLS_CA_CERT?.trim();
  let ca: string | undefined;
  if (caFile) {
    try {
      ca = readFileSync(caFile, "utf8");
    } catch {
      // The path (not the file contents) is safe to surface.
      throw new RedisConfigError(
        REDIS_CONFIG_ERROR_CODES.REDIS_TLS_CA_UNREADABLE,
        `REDIS_TLS_CA_FILE could not be read: ${caFile}`
      );
    }
  } else if (caCert) {
    ca = caCert;
  }

  const rejectUnauthorized =
    env.REDIS_TLS_REJECT_UNAUTHORIZED?.trim().toLowerCase() !== "false";

  return { rejectUnauthorized, ...(ca ? { ca } : {}) };
}
