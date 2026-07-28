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
 * Retryable vs fatal classification (#778):
 *   - transient  → retryable: yes. Transient network/RPC issues, tx not yet confirmed.
 *   - fatal      → retryable: no. On-chain failures that will not self-heal.
 *   - invalid_input → retryable: no. Bad payload — retrying won't fix it.
 *
 * Unknown errors default to "transient" (retryable) — the safe bucket.
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
  | "STELLAR_TX_INSUFFICIENT_FEE"
  | "STELLAR_TX_INSUFFICIENT_FUNDS"
  | "STELLAR_TX_BAD_SEQUENCE"
  | "STELLAR_TX_BAD_AUTH"
  | "SOROBAN_CONTRACT_ERROR"
  | "HORIZON_RATE_LIMITED"
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

/**
 * Returns true when a classified error should be retried by the queue worker.
 * Unknown errors default to retryable (the safe bucket — #778 acceptance).
 */
export function isRetryable(info: SettlementErrorInfo): boolean {
  return info.status === "transient";
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
  /**
   * The submitted transaction's fee was below the network's base fee.
   * Retryable — worker should resubmit with a higher fee.
   */
  STELLAR_TX_INSUFFICIENT_FEE: {
    code: "STELLAR_TX_INSUFFICIENT_FEE",
    status: "transient",
    message: "Transaction rejected: fee below network minimum (tx_insufficient_fee)",
  },
  /**
   * The source account does not have enough XLM to cover the transaction fee
   * plus minimum balance. Fatal — manual intervention needed.
   */
  STELLAR_TX_INSUFFICIENT_FUNDS: {
    code: "STELLAR_TX_INSUFFICIENT_FUNDS",
    status: "fatal",
    message: "Transaction rejected: source account has insufficient funds (op_underfunded / tx_insufficient_balance)",
  },
  /**
   * Account sequence number mismatch — likely a race between concurrent
   * submissions. Retryable — worker should refresh account and resubmit.
   */
  STELLAR_TX_BAD_SEQUENCE: {
    code: "STELLAR_TX_BAD_SEQUENCE",
    status: "transient",
    message: "Transaction rejected: account sequence number mismatch (tx_bad_seq)",
  },
  /**
   * Signature validation failure. Fatal — signing key is wrong or revoked.
   */
  STELLAR_TX_BAD_AUTH: {
    code: "STELLAR_TX_BAD_AUTH",
    status: "fatal",
    message: "Transaction rejected: signature validation failed (tx_bad_auth)",
  },
  /**
   * Soroban contract invocation returned an error code (trap, panic, or
   * explicit contract Error type). Fatal — a retry will produce the same
   * contract-level rejection unless the contract state changes.
   */
  SOROBAN_CONTRACT_ERROR: {
    code: "SOROBAN_CONTRACT_ERROR",
    status: "fatal",
    message: "Soroban contract invocation failed with a contract error",
  },
  /**
   * Horizon or RPC gateway returned HTTP 429 Too Many Requests.
   * Retryable — back off and retry.
   */
  HORIZON_RATE_LIMITED: {
    code: "HORIZON_RATE_LIMITED",
    status: "transient",
    message: "Horizon/RPC rate limit exceeded (HTTP 429)",
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
 *
 * Unknown errors default to the "transient" (retryable) safe bucket (#778).
 */
export function classifySettlementError(
  error: unknown,
  context?: { phase?: string }
): SettlementErrorInfo {
  if (!(error instanceof Error)) return ERROR_REGISTRY.UNKNOWN;

  const msg = error.message.toLowerCase();
  const code = (error as NodeJS.ErrnoException).code ?? "";

  // ── Horizon rate limiting ──────────────────────────────────────────────────
  if (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  ) {
    return { ...ERROR_REGISTRY.HORIZON_RATE_LIMITED, message: error.message };
  }

  // ── RPC connectivity failures ──────────────────────────────────────────────
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

  // ── Timeouts ───────────────────────────────────────────────────────────────
  if (
    code === "ETIMEDOUT" ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("etimedout")
  ) {
    return { ...ERROR_REGISTRY.STELLAR_RPC_TIMEOUT, message: error.message };
  }

  // ── Soroban/Horizon: fee below minimum ────────────────────────────────────
  if (
    msg.includes("tx_insufficient_fee") ||
    msg.includes("insufficient fee") ||
    msg.includes("fee is too low") ||
    msg.includes("fee too low")
  ) {
    return { ...ERROR_REGISTRY.STELLAR_TX_INSUFFICIENT_FEE, message: error.message };
  }

  // ── Soroban/Horizon: insufficient funds ───────────────────────────────────
  if (
    msg.includes("op_underfunded") ||
    msg.includes("tx_insufficient_balance") ||
    msg.includes("insufficient funds") ||
    msg.includes("insufficient balance") ||
    msg.includes("underfunded")
  ) {
    return { ...ERROR_REGISTRY.STELLAR_TX_INSUFFICIENT_FUNDS, message: error.message };
  }

  // ── Soroban/Horizon: sequence number mismatch ─────────────────────────────
  if (
    msg.includes("tx_bad_seq") ||
    msg.includes("bad sequence") ||
    msg.includes("sequence number") ||
    msg.includes("sequence mismatch")
  ) {
    return { ...ERROR_REGISTRY.STELLAR_TX_BAD_SEQUENCE, message: error.message };
  }

  // ── Soroban/Horizon: auth / signature failure ─────────────────────────────
  if (
    msg.includes("tx_bad_auth") ||
    msg.includes("bad auth") ||
    msg.includes("signature") ||
    msg.includes("authorization failed")
  ) {
    return { ...ERROR_REGISTRY.STELLAR_TX_BAD_AUTH, message: error.message };
  }

  // ── Soroban contract errors (trap / panic / explicit Error enum) ──────────
  if (
    msg.includes("contract error") ||
    msg.includes("wasm trap") ||
    msg.includes("invoke_host_function") ||
    msg.includes("soroban_error") ||
    msg.includes("contracterrortypewasmerror") ||
    msg.includes("contracterrortypecontract")
  ) {
    return { ...ERROR_REGISTRY.SOROBAN_CONTRACT_ERROR, message: error.message };
  }

  // ── Transaction failures ───────────────────────────────────────────────────
  if (
    msg.includes("settle_trade transaction failed on-chain") ||
    msg.includes("settle_trade submission failed")
  ) {
    return { ...ERROR_REGISTRY.STELLAR_TX_FAILED, message: error.message };
  }

  // ── Not confirmed ──────────────────────────────────────────────────────────
  if (msg.includes("not confirmed after") || msg.includes("settle_trade not confirmed")) {
    return { ...ERROR_REGISTRY.STELLAR_TX_NOT_CONFIRMED, message: error.message };
  }

  // ── Invalid payload ────────────────────────────────────────────────────────
  if (
    msg.includes("invalid payload") ||
    msg.includes("missing field") ||
    context?.phase === "validation"
  ) {
    return { ...ERROR_REGISTRY.INVALID_PAYLOAD, message: error.message };
  }

  // ── Missing config ─────────────────────────────────────────────────────────
  if (
    msg.includes("stellar config") ||
    msg.includes("rpc url") ||
    msg.includes("contract id") ||
    context?.phase === "bootstrap"
  ) {
    return { ...ERROR_REGISTRY.MISSING_STELLAR_CONFIG, message: error.message };
  }

  // Unknown defaults to transient (safe bucket — #778 acceptance criteria)
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
  (actual as any).settlementErrorRetryable = isRetryable(info);
  return actual;
}
