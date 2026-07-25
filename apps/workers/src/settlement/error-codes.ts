/**
 * Structured Error Codes for Settlement Jobs
 *
 * Every settlement job error is tagged with a machine-readable error code so
 * operators and automated tooling can classify failures without parsing
 * human-readable message strings.
 *
 * Each error code carries:
 *   - code:      short uppercase string (e.g. "STELLAR_RPC_UNAVAILABLE")
 *   - status:    HTTP-style category (400 = client, 500 = server / retryable)
 *   - message:   human-readable template
 *   - retryable: whether the job should be retried
 *
 * @module apps/workers/src/settlement/error-codes
 */

/** Machine-readable error code identifier. */
export type SettlementErrorCode =
  | "IDEMPOTENCY_STORE_FAILURE"
  | "STELLAR_RPC_UNAVAILABLE"
  | "STELLAR_RPC_TIMEOUT"
  | "STELLAR_TX_FAILED"
  | "STELLAR_TX_NOT_CONFIRMED"
  | "INVALID_PAYLOAD"
  | "MISSING_STELLAR_CONFIG"
  | "UNKNOWN";

/** Categorisation of the error for observability dashboards. */
export type SettlementErrorStatus = "transient" | "fatal" | "invalid_input";

export interface SettlementErrorInfo {
  code: SettlementErrorCode;
  status: SettlementErrorStatus;
  message: string;
}

const ERROR_REGISTRY: Record<SettlementErrorCode, SettlementErrorInfo> = {
  IDEMPOTENCY_STORE_FAILURE: {
    code: "IDEMPOTENCY_STORE_FAILURE",
    status: "transient",
    message: "Failed to read or write the idempotency lock in Redis",
  },
  STELLAR_RPC_UNAVAILABLE: {
    code: "STELLAR_RPC_UNAVAILABLE",
    status: "transient",
    message: "Stellar RPC endpoint is unreachable or returned an error",
  },
  STELLAR_RPC_TIMEOUT: {
    code: "STELLAR_RPC_TIMEOUT",
    status: "transient",
    message: "Stellar RPC request timed out",
  },
  STELLAR_TX_FAILED: {
    code: "STELLAR_TX_FAILED",
    status: "fatal",
    message: "settle_trade transaction was submitted but failed on-chain",
  },
  STELLAR_TX_NOT_CONFIRMED: {
    code: "STELLAR_TX_NOT_CONFIRMED",
    status: "transient",
    message: "settle_trade transaction was not confirmed within the polling window",
  },
  INVALID_PAYLOAD: {
    code: "INVALID_PAYLOAD",
    status: "invalid_input",
    message: "Settlement job payload is missing or has invalid fields",
  },
  MISSING_STELLAR_CONFIG: {
    code: "MISSING_STELLAR_CONFIG",
    status: "fatal",
    message: "Stellar configuration (RPC URL, contract ID, etc.) is incomplete",
  },
  UNKNOWN: {
    code: "UNKNOWN",
    status: "transient",
    message: "An unexpected error occurred",
  },
};

/**
 * Classify an error thrown during settlement processing into a structured
 * SettlementErrorInfo by inspecting the error message and any attached metadata.
 */
export function classifySettlementError(
  error: unknown,
  context?: { phase?: string }
): SettlementErrorInfo {
  if (!(error instanceof Error)) return ERROR_REGISTRY.UNKNOWN;

  const msg = error.message.toLowerCase();
  const code = (error as NodeJS.ErrnoException).code ?? "";

  // RPC connectivity failures
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("rpc unavailable") ||
    msg.includes("rpc error") ||
    msg.includes("socket hang up") ||
    msg.includes("connection refused")
  ) {
    return { ...ERROR_REGISTRY.STELLAR_RPC_UNAVAILABLE, message: error.message };
  }

  // Timeouts
  if (
    code === "ETIMEDOUT" ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("etimedout")
  ) {
    return { ...ERROR_REGISTRY.STELLAR_RPC_TIMEOUT, message: error.message };
  }

  // Transaction failures
  if (
    msg.includes("settle_trade transaction failed on-chain") ||
    msg.includes("settle_trade submission failed")
  ) {
    return { ...ERROR_REGISTRY.STELLAR_TX_FAILED, message: error.message };
  }

  // Not confirmed
  if (msg.includes("not confirmed after") || msg.includes("settle_trade not confirmed")) {
    return { ...ERROR_REGISTRY.STELLAR_TX_NOT_CONFIRMED, message: error.message };
  }

  // Invalid payload
  if (
    msg.includes("invalid payload") ||
    msg.includes("missing field") ||
    context?.phase === "validation"
  ) {
    return { ...ERROR_REGISTRY.INVALID_PAYLOAD, message: error.message };
  }

  // Missing config
  if (
    msg.includes("stellar config") ||
    msg.includes("rpc url") ||
    msg.includes("contract id") ||
    context?.phase === "bootstrap"
  ) {
    return { ...ERROR_REGISTRY.MISSING_STELLAR_CONFIG, message: error.message };
  }

  return { ...ERROR_REGISTRY.UNKNOWN, message: error.message };
}

/**
 * Wraps a thrown error with structured error-code metadata on the error object
 * itself so that callers (queue-consumer, dead-letter logger) can attach the
 * error code to their structured log fields without needing to import the
 * classifier.
 */
export function annotateError(error: unknown, info: SettlementErrorInfo): Error {
  const actual = error instanceof Error ? error : new Error(String(error));
  (actual as any).settlementErrorCode = info.code;
  (actual as any).settlementErrorStatus = info.status;
  return actual;
}
