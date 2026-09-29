import { REDACTED } from "./logRedactor.js";

/**
 * Secret-free error reporting for health/readiness probes.
 *
 * Probe endpoints are unauthenticated by design (kubelet and load balancers
 * cannot present credentials), so **anything** they return is public. Driver
 * and client errors routinely embed the very values we must never publish:
 *
 *   - Prisma / node-postgres: `Can't reach database server at
 *     \`postgres://vatix:s3cr3t@db.internal:5432/vatix\``
 *   - ioredis: `connect ECONNREFUSED 10.0.0.5:6379`
 *   - Fetch/HTTP clients: `request to https://user:token@rpc.example failed`
 *
 * Passing those messages straight through a probe leaks credentials and
 * internal topology to anyone who can reach the port. This module reduces a
 * caught error to a short, stable, secret-free summary so probe payloads stay
 * safe to expose, while the raw error is still available for server-side logs.
 */

/** Stable, secret-free error codes for probe responses. */
export const PROBE_ERROR_CODES = {
  /** A dependency could not be reached or the check failed. */
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  /** A dependency check exceeded its deadline. */
  PROBE_TIMEOUT: "PROBE_TIMEOUT",
  /** No data has been indexed yet, so freshness cannot be established. */
  NO_DATA: "NO_DATA",
  /** The most recent indexed data is older than the staleness threshold. */
  STALE: "STALE",
} as const;

export type ProbeErrorCode =
  (typeof PROBE_ERROR_CODES)[keyof typeof PROBE_ERROR_CODES];

/**
 * Patterns whose matched text is replaced with {@link REDACTED} before a
 * message is surfaced. Ordered most-specific first; the scheme-based patterns
 * subsume the bare host:port form.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // scheme://user:password@host — the full DSN form, credentials included.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@[^\s]*/gi,
  // scheme://token@host — e.g. https://<token>@rpc.example
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@[^\s]*/gi,
  // scheme://host[:port][/path] — no credentials, but still internal topology.
  /\b(?:postgres|postgresql|mysql|redis|rediss|mongodb(?:\+srv)?):\/\/[^\s]*/gi,
  // Bare host:port pairs, e.g. `ECONNREFUSED 10.0.0.5:6379`.
  /\b\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}\b/g,
  // Bare internal DNS names with an explicit service port.
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|svc|cluster\.local):\d{1,5}\b/gi,
  // `key=value` / `key: value` pairs for well-known secret-bearing keys.
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|auth|bearer)\s*[=:]\s*[^\s,;'"&]+/gi,
  // Bare JWTs and Stellar secret seeds (S...).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bS[A-Z2-7]{55}\b/g,
];

/** Upper bound on the sanitized message so a driver stack trace cannot flood a response. */
const MAX_SUMMARY_LENGTH = 200;

/**
 * Reduce a caught value to a short, secret-free string safe to place in a
 * probe HTTP response. Never returns an empty string — callers can rely on a
 * non-empty summary. Non-Error values (`"timeout"`, `{}`, `null`) are handled
 * so a dependency that rejects with a bare string cannot bypass sanitization.
 */
export function sanitizeProbeMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err === null || err === undefined
          ? ""
          : Object.prototype.toString.call(err);

  // Start from the raw message so every pattern is applied in turn — replacing
  // into an empty accumulator would leave only the final pattern's result.
  let summary = raw;
  for (const pattern of SECRET_PATTERNS) {
    summary = summary.replace(pattern, REDACTED);
  }

  // Collapse whitespace introduced by redaction and strip control characters
  // so the value stays a single-line, log/JSON-safe string.
  summary = summary.replace(/[\r\n\t]+/g, " ").trim();

  if (summary.length > MAX_SUMMARY_LENGTH) {
    summary = `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
  }

  // Nothing useful survived sanitization (or there was nothing to begin with):
  // fall back to a fixed, dependency-agnostic summary so the probe response
  // is never empty and never echoes the raw value.
  return summary.length > 0
    ? summary
    : PROBE_ERROR_CODES.DEPENDENCY_UNAVAILABLE;
}

/**
 * Classify a caught error into a stable {@link ProbeErrorCode} without
 * inspecting the message for secrets. Timeouts are detected by code/name so
 * the classification itself cannot leak message contents.
 */
export function classifyProbeError(err: unknown): ProbeErrorCode {
  if (isTimeoutError(err)) {
    return PROBE_ERROR_CODES.PROBE_TIMEOUT;
  }
  return PROBE_ERROR_CODES.DEPENDENCY_UNAVAILABLE;
}

function isTimeoutError(err: unknown): boolean {
  const candidate = err as { code?: unknown; name?: unknown } | null;
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const code = candidate.code;
  const name = candidate.name;
  return (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "PROBE_TIMEOUT" ||
    name === "TimeoutError"
  );
}
