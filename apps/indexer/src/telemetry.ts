export interface Span {
  end(tags?: Record<string, string>): void;
}

export interface Telemetry {
  record(metric: string, value: number, tags?: Record<string, string>): void;
  /** Starts a span for a named stage; call `.end()` when the stage completes. */
  startSpan(name: string, tags?: Record<string, string>): Span;
}

/**
 * Redacts sensitive fields from telemetry tags to prevent PII leakage.
 * Keys are matched case-insensitively against a known set of sensitive field names.
 */
const REDACTED = "[REDACTED]";

const SENSITIVE_TELEMETRY_KEYS: ReadonlySet<string> = new Set([
  // User / account identifiers
  "traderaddress",
  "counterpartyaddress",
  "account",
  "account_id",
  "oracleaddress",
  "address",
  "user",
  "userid",
  "user_id",
  "wallet",
  "walletaddress",
  "wallet_address",
  "stellaraddress",
  "stellar_address",
  "publickey",
  "public_key",
  // Auth / identity
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "apikey",
  "api_key",
  "x-api-key",
  "authorization",
  "auth",
  // Cookies / sessions
  "cookie",
  "set-cookie",
  "session",
  "sessionid",
  "session_id",
  // Cryptographic material
  "privatekey",
  "private_key",
  "secretkey",
  "secret_key",
  "signingkey",
  "signing_key",
  "mnemonic",
  "seed",
  "keypair",
  // Network / infra
  "x-auth-token",
  "x-user-token",
  "connectionstring",
  "connection_string",
  "databaseurl",
  "database_url",
  "db_url",
  "redis_url",
  "redisurl",
  // PII
  "ssn",
  "creditcard",
  "credit_card",
  "cvv",
  "pin",
  // Event identifiers that may contain user data
  "eventid",
  "event_id",
]);

function isSensitiveTelemetryKey(key: string): boolean {
  return SENSITIVE_TELEMETRY_KEYS.has(key.toLowerCase());
}

function redactTags(tags: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!tags) return undefined;
  const redacted: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    redacted[k] = isSensitiveTelemetryKey(k) ? REDACTED : v;
  }
  return redacted;
}

export const consoleTelemetry: Telemetry = {
  record(metric, value, tags) {
    const safeTags = redactTags(tags);
    const tagStr = safeTags ? ` ${JSON.stringify(safeTags)}` : "";
    console.log(`[telemetry] ${metric}=${value}${tagStr}`);
  },
  startSpan(name, startTags) {
    const startedAt = performance.now();
    const safeStartTags = redactTags(startTags);
    return {
      end(endTags) {
        const durationMs = performance.now() - startedAt;
        const safeEndTags = redactTags(endTags);
        const tags = { ...safeStartTags, ...safeEndTags };
        const tagStr = Object.keys(tags).length ? ` ${JSON.stringify(tags)}` : "";
        console.log(
          `[telemetry] span ${name} duration_ms=${durationMs.toFixed(2)}${tagStr}`
        );
      },
    };
  },
};