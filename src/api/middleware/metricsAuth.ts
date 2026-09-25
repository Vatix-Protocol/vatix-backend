import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authorization policy for the Prometheus scrape endpoint (#1130).
 *
 * `/metrics` is deliberately absent from the rate limiter and admission
 * control, because scrapers poll on a fixed short interval — so it must carry
 * its own authz instead of inheriting the global middleware's protection.
 * The endpoint is deny-by-default in production: either a bearer token or an
 * IP allowlist has to be configured, or the process refuses to boot
 * (see `parseApiEnv` in src/env.ts).
 */
export interface MetricsScrapePolicy {
  /** Bearer token every scraper must present. `null` = not configured. */
  token: string | null;
  /**
   * Scraper source addresses, either exact IPs or IPv4 CIDR ranges
   * (`10.0.0.0/8`). Empty = not configured. IPv4-mapped IPv6 addresses
   * (`::ffff:10.0.0.5`) are normalized to IPv4 before matching.
   */
  allowedIps: string[];
  /**
   * When true and neither token nor allowlist is configured, every scrape is
   * denied with `METRICS_AUTH_NOT_CONFIGURED`. This is the defense-in-depth
   * half of the boot check: a process that somehow starts without metrics
   * authz still fails closed rather than exposing metrics.
   */
  requireAuth: boolean;
}

/** Stable denial reasons, safe to label metrics and logs with. */
export type MetricsScrapeDenyReason =
  "missing_token" | "invalid_token" | "ip_not_allowed" | "auth_not_configured";

export interface MetricsScrapeDenied {
  allowed: false;
  reason: MetricsScrapeDenyReason;
  statusCode: 401 | 403;
  /** Stable, machine-readable error code returned in the response body. */
  code: string;
  message: string;
}

export type MetricsScrapeDecision = { allowed: true } | MetricsScrapeDenied;

/**
 * Minimal env shape needed to resolve the scrape policy. Structural rather
 * than `Record<string, string | undefined>` so the Zod-parsed API env can be
 * passed directly (it carries booleans/numbers too), while tests can pass raw
 * string maps.
 */
export interface MetricsScrapeEnvInput {
  NODE_ENV?: string;
  METRICS_SCRAPE_TOKEN?: string;
  METRICS_SCRAPE_ALLOWED_IPS?: string;
  /** Parsed env carries a boolean; hand-written env maps carry the string form. */
  METRICS_REQUIRE_AUTH?: boolean | string;
}

/**
 * Reads the metrics authz policy from a parsed/validated env map.
 * Callers pass the Zod-parsed API env (src/config.ts) so there is exactly one
 * env parser — never `process.env` directly.
 */
export function loadMetricsScrapePolicy(
  env: MetricsScrapeEnvInput
): MetricsScrapePolicy {
  const token = env.METRICS_SCRAPE_TOKEN?.trim() || null;
  const allowedIps = (env.METRICS_SCRAPE_ALLOWED_IPS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const rawFlag =
    typeof env.METRICS_REQUIRE_AUTH === "boolean"
      ? env.METRICS_REQUIRE_AUTH
        ? "true"
        : "false"
      : env.METRICS_REQUIRE_AUTH?.trim().toLowerCase();
  const requireAuth =
    rawFlag === undefined || rawFlag === ""
      ? env.NODE_ENV === "production"
      : rawFlag === "true";

  return { token, allowedIps, requireAuth };
}

/**
 * Constant-time string comparison. Both inputs are hashed first so different
 * lengths cannot be distinguished by timing (timingSafeEqual throws on
 * mismatched lengths).
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Normalizes IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to its IPv4 form. */
function normalizeIp(ip: string): string {
  const lower = ip.trim().toLowerCase();
  return lower.startsWith("::ffff:") ? lower.slice(7) : lower;
}

function ipv4ToInt(ip: string): number | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const octets = ip.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.reduce((acc, octet) => ((acc << 8) + octet) >>> 0, 0) >>> 0;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/** Exact-address or IPv4-CIDR match against the configured allowlist. */
export function ipMatchesAllowlist(
  remoteAddress: string | undefined,
  allowedIps: string[]
): boolean {
  if (!remoteAddress || allowedIps.length === 0) return false;
  const ip = normalizeIp(remoteAddress);
  return allowedIps.some((entry) => {
    const candidate = normalizeIp(entry);
    return candidate.includes("/")
      ? ipv4InCidr(ip, candidate)
      : candidate === ip;
  });
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function deny(
  reason: MetricsScrapeDenyReason,
  statusCode: 401 | 403,
  code: string,
  message: string
): MetricsScrapeDenied {
  return { allowed: false, reason, statusCode, code, message };
}

/**
 * Decides whether a scrape request may read the registry.
 *
 * Order matters: token auth (when configured) is checked before the IP
 * allowlist so a valid token can never be bypassed by source address, and a
 * request that presents no token is rejected before any registry
 * serialization work happens.
 */
export function authorizeMetricsScrape(
  request: { authorization?: string; remoteAddress?: string },
  policy: MetricsScrapePolicy
): MetricsScrapeDecision {
  if (policy.token) {
    const presented = extractBearerToken(request.authorization);
    if (!presented) {
      return deny(
        "missing_token",
        401,
        "METRICS_AUTH_MISSING",
        "Missing bearer token for /metrics"
      );
    }
    if (!safeEqual(presented, policy.token)) {
      return deny(
        "invalid_token",
        401,
        "METRICS_AUTH_INVALID",
        "Invalid bearer token for /metrics"
      );
    }
    return { allowed: true };
  }

  if (policy.allowedIps.length > 0) {
    return ipMatchesAllowlist(request.remoteAddress, policy.allowedIps)
      ? { allowed: true }
      : deny(
          "ip_not_allowed",
          403,
          "METRICS_IP_FORBIDDEN",
          "Source address is not allowed to scrape /metrics"
        );
  }

  if (policy.requireAuth) {
    return deny(
      "auth_not_configured",
      403,
      "METRICS_AUTH_NOT_CONFIGURED",
      "Metrics scraping requires authz; set METRICS_SCRAPE_TOKEN or METRICS_SCRAPE_ALLOWED_IPS"
    );
  }

  return { allowed: true };
}
