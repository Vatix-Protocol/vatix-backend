import { describe, it, expect } from "vitest";
import {
  classifySettlementError,
  annotateError,
  isRetryable,
} from "./error-codes.js";

describe("classifySettlementError", () => {
  it("classifies ECONNRESET as STELLAR_RPC_UNAVAILABLE (transient)", () => {
    const err = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_RPC_UNAVAILABLE");
    expect(info.status).toBe("transient");
  });

  it("classifies ECONNREFUSED as STELLAR_RPC_UNAVAILABLE (transient)", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_RPC_UNAVAILABLE");
    expect(info.status).toBe("transient");
  });

  it("classifies ETIMEDOUT as STELLAR_RPC_TIMEOUT (transient)", () => {
    const err = Object.assign(new Error("request timed out"), {
      code: "ETIMEDOUT",
    });
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_RPC_TIMEOUT");
    expect(info.status).toBe("transient");
  });

  it("classifies on-chain tx failure as STELLAR_TX_FAILED (fatal)", () => {
    const err = new Error(
      "settle_trade transaction failed on-chain: hash=abc123"
    );
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_TX_FAILED");
    expect(info.status).toBe("fatal");
  });

  it("classifies submission error as STELLAR_TX_FAILED (fatal)", () => {
    const err = new Error(
      "settle_trade submission failed: status=ERROR hash=abc123"
    );
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_TX_FAILED");
    expect(info.status).toBe("fatal");
  });

  it("classifies not-confirmed as STELLAR_TX_NOT_CONFIRMED (transient)", () => {
    const err = new Error("settle_trade not confirmed after 30s: hash=abc123");
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_TX_NOT_CONFIRMED");
    expect(info.status).toBe("transient");
  });

  it("classifies non-Error values as UNKNOWN (transient)", () => {
    const info = classifySettlementError("string error");
    expect(info.code).toBe("UNKNOWN");
    expect(info.status).toBe("transient");
  });

  it("classifies socket hang up by message as STELLAR_RPC_UNAVAILABLE", () => {
    const err = new Error("socket hang up");
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_RPC_UNAVAILABLE");
  });

  // ── #778: Soroban / Horizon-specific failure codes ─────────────────────────

  it("classifies tx_insufficient_fee as STELLAR_TX_INSUFFICIENT_FEE (transient/retryable)", () => {
    const err = new Error("Transaction rejected: tx_insufficient_fee");
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_TX_INSUFFICIENT_FEE");
    expect(info.status).toBe("transient");
    expect(isRetryable(info)).toBe(true);
  });

  it("classifies 'fee is too low' as STELLAR_TX_INSUFFICIENT_FEE", () => {
    const err = new Error("fee is too low: expected 100 got 50");
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_TX_INSUFFICIENT_FEE");
  });

  it("classifies op_underfunded as STELLAR_TX_INSUFFICIENT_FUNDS (fatal)", () => {
    const err = new Error("op_underfunded: account balance too low");
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_TX_INSUFFICIENT_FUNDS");
    expect(info.status).toBe("fatal");
    expect(isRetryable(info)).toBe(false);
  });

  it("classifies tx_insufficient_balance as STELLAR_TX_INSUFFICIENT_FUNDS (fatal)", () => {
    const err = new Error("tx_insufficient_balance");
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_TX_INSUFFICIENT_FUNDS");
    expect(info.status).toBe("fatal");
  });

  it("classifies tx_bad_seq as STELLAR_TX_BAD_SEQUENCE (transient/retryable)", () => {
    const err = new Error("tx_bad_seq: sequence number mismatch");
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_TX_BAD_SEQUENCE");
    expect(info.status).toBe("transient");
    expect(isRetryable(info)).toBe(true);
  });

  it("classifies tx_bad_auth as STELLAR_TX_BAD_AUTH (fatal)", () => {
    const err = new Error("tx_bad_auth: signature verification failed");
    const info = classifySettlementError(err);
    expect(info.code).toBe("STELLAR_TX_BAD_AUTH");
    expect(info.status).toBe("fatal");
    expect(isRetryable(info)).toBe(false);
  });

  it("classifies wasm trap as SOROBAN_CONTRACT_ERROR (fatal)", () => {
    const err = new Error("wasm trap: unreachable instruction executed");
    const info = classifySettlementError(err);
    expect(info.code).toBe("SOROBAN_CONTRACT_ERROR");
    expect(info.status).toBe("fatal");
    expect(isRetryable(info)).toBe(false);
  });

  it("classifies invoke_host_function error as SOROBAN_CONTRACT_ERROR (fatal)", () => {
    const err = new Error("invoke_host_function failed: contract error");
    const info = classifySettlementError(err);
    expect(info.code).toBe("SOROBAN_CONTRACT_ERROR");
    expect(info.status).toBe("fatal");
  });

  it("classifies HTTP 429 as HORIZON_RATE_LIMITED (transient/retryable)", () => {
    const err = new Error("Request failed with status code 429");
    const info = classifySettlementError(err);
    expect(info.code).toBe("HORIZON_RATE_LIMITED");
    expect(info.status).toBe("transient");
    expect(isRetryable(info)).toBe(true);
  });

  it("classifies 'rate limit exceeded' as HORIZON_RATE_LIMITED", () => {
    const err = new Error("rate limit exceeded — retry after 60s");
    const info = classifySettlementError(err);
    expect(info.code).toBe("HORIZON_RATE_LIMITED");
  });

  // ── #778: unknown defaults to safe (transient/retryable) bucket ────────────

  it("classifies a completely unknown error as UNKNOWN (transient) — the safe bucket", () => {
    const err = new Error("some totally unexpected internal failure");
    const info = classifySettlementError(err);
    expect(info.code).toBe("UNKNOWN");
    expect(info.status).toBe("transient");
    expect(isRetryable(info)).toBe(true);
  });
});

describe("isRetryable", () => {
  it("returns true for transient status", () => {
    expect(
      isRetryable({
        code: "STELLAR_RPC_UNAVAILABLE",
        status: "transient",
        message: "",
      })
    ).toBe(true);
    expect(
      isRetryable({
        code: "STELLAR_TX_NOT_CONFIRMED",
        status: "transient",
        message: "",
      })
    ).toBe(true);
    expect(
      isRetryable({ code: "UNKNOWN", status: "transient", message: "" })
    ).toBe(true);
  });

  it("returns false for fatal status", () => {
    expect(
      isRetryable({ code: "STELLAR_TX_FAILED", status: "fatal", message: "" })
    ).toBe(false);
    expect(
      isRetryable({ code: "STELLAR_TX_BAD_AUTH", status: "fatal", message: "" })
    ).toBe(false);
    expect(
      isRetryable({
        code: "SOROBAN_CONTRACT_ERROR",
        status: "fatal",
        message: "",
      })
    ).toBe(false);
    expect(
      isRetryable({
        code: "STELLAR_TX_INSUFFICIENT_FUNDS",
        status: "fatal",
        message: "",
      })
    ).toBe(false);
    expect(
      isRetryable({
        code: "MISSING_STELLAR_CONFIG",
        status: "fatal",
        message: "",
      })
    ).toBe(false);
  });

  it("returns false for invalid_input status", () => {
    expect(
      isRetryable({
        code: "INVALID_PAYLOAD",
        status: "invalid_input",
        message: "",
      })
    ).toBe(false);
  });
});

describe("annotateError", () => {
  it("attaches settlementErrorCode and settlementErrorStatus to the error", () => {
    const original = new Error("RPC unavailable");
    const annotated = annotateError(original, {
      code: "STELLAR_RPC_UNAVAILABLE",
      status: "transient",
      message: "Stellar RPC endpoint is unreachable",
    });

    expect((annotated as any).settlementErrorCode).toBe(
      "STELLAR_RPC_UNAVAILABLE"
    );
    expect((annotated as any).settlementErrorStatus).toBe("transient");
    expect(annotated.message).toBe("RPC unavailable");
  });

  it("attaches settlementErrorRetryable flag", () => {
    const err = new Error("transient");
    const annotated = annotateError(err, {
      code: "STELLAR_RPC_TIMEOUT",
      status: "transient",
      message: "timed out",
    });
    expect((annotated as any).settlementErrorRetryable).toBe(true);

    const fatalAnnotated = annotateError(new Error("fatal"), {
      code: "STELLAR_TX_FAILED",
      status: "fatal",
      message: "failed",
    });
    expect((fatalAnnotated as any).settlementErrorRetryable).toBe(false);
  });

  it("wraps non-Error values in a new Error", () => {
    const annotated = annotateError("raw string", {
      code: "UNKNOWN",
      status: "transient",
      message: "unexpected",
    });

    expect(annotated).toBeInstanceOf(Error);
    expect(annotated.message).toBe("raw string");
    expect((annotated as any).settlementErrorCode).toBe("UNKNOWN");
  });
});
