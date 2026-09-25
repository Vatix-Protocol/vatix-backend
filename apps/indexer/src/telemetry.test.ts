import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { consoleTelemetry } from "./telemetry.js";

describe("Telemetry PII Redaction", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it("redacts sensitive fields in record tags", () => {
    consoleTelemetry.record("indexer.test.metric", 42, {
      traderAddress: "GABC1234",
      counterpartyAddress: "GXYZ5678",
      account: "GUSER123",
      oracleAddress: "GORACLE",
      eventId: "evt-123",
      token: "secret-token",
      contractId: "CTEST",
      ledger: "42",
      parser: "trade",
    });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const loggedStr = consoleLogSpy.mock.calls[0][0];
    expect(loggedStr).toContain("[telemetry] indexer.test.metric=42");

    // Parse the JSON tag object logged
    const jsonPart = loggedStr.substring(loggedStr.indexOf("{"));
    const parsedTags = JSON.parse(jsonPart);

    expect(parsedTags.traderAddress).toBe("[REDACTED]");
    expect(parsedTags.counterpartyAddress).toBe("[REDACTED]");
    expect(parsedTags.account).toBe("[REDACTED]");
    expect(parsedTags.oracleAddress).toBe("[REDACTED]");
    expect(parsedTags.eventId).toBe("[REDACTED]");
    expect(parsedTags.token).toBe("[REDACTED]");

    // Non-sensitive tags must remain intact
    expect(parsedTags.contractId).toBe("CTEST");
    expect(parsedTags.ledger).toBe("42");
    expect(parsedTags.parser).toBe("trade");
  });

  it("redacts sensitive fields case-insensitively", () => {
    consoleTelemetry.record("indexer.test.case", 1, {
      TRADERADDRESS: "GABC",
      account_id: "G123",
      API_KEY: "secret123",
    });

    const loggedStr = consoleLogSpy.mock.calls[0][0];
    const jsonPart = loggedStr.substring(loggedStr.indexOf("{"));
    const parsedTags = JSON.parse(jsonPart);

    expect(parsedTags.TRADERADDRESS).toBe("[REDACTED]");
    expect(parsedTags.account_id).toBe("[REDACTED]");
    expect(parsedTags.API_KEY).toBe("[REDACTED]");
  });

  it("redacts sensitive fields in spans (startSpan and span.end)", () => {
    const span = consoleTelemetry.startSpan("indexer.ingestion.fetch", {
      contractId: "CTEST",
      traderAddress: "GABC",
    });

    span.end({
      eventId: "evt-999",
      eventCount: "5",
    });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const loggedStr = consoleLogSpy.mock.calls[0][0];
    const jsonPart = loggedStr.substring(loggedStr.indexOf("{"));
    const parsedTags = JSON.parse(jsonPart);

    expect(parsedTags.contractId).toBe("CTEST");
    expect(parsedTags.traderAddress).toBe("[REDACTED]");
    expect(parsedTags.eventId).toBe("[REDACTED]");
    expect(parsedTags.eventCount).toBe("5");
  });
});
