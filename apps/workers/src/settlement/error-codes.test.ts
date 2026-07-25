import { describe, it, expect } from "vitest";
import {
  classifySettlementError,
  annotateError,
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
    const err = new Error(
      "settle_trade not confirmed after 30s: hash=abc123"
    );
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
