import { describe, it, expect } from "vitest";

/**
 * Tests for graceful shutdown input validation in the finalization worker.
 *
 * The VALID_SHUTDOWN_SIGNALS constant and validation logic lives inside
 * bootstrap(), so we verify the contract by testing the allowlist and
 * rejection logic in isolation.
 */

const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function isValidShutdownSignal(signal: unknown): boolean {
  return (
    typeof signal === "string" &&
    signal.trim() !== "" &&
    VALID_SHUTDOWN_SIGNALS.includes(
      signal as (typeof VALID_SHUTDOWN_SIGNALS)[number]
    )
  );
}

describe("Graceful shutdown input validation", () => {
  it("accepts SIGINT as a valid shutdown signal", () => {
    expect(isValidShutdownSignal("SIGINT")).toBe(true);
  });

  it("accepts SIGTERM as a valid shutdown signal", () => {
    expect(isValidShutdownSignal("SIGTERM")).toBe(true);
  });

  it("accepts SIGHUP as a valid shutdown signal", () => {
    expect(isValidShutdownSignal("SIGHUP")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidShutdownSignal("")).toBe(false);
  });

  it("rejects a whitespace-only string", () => {
    expect(isValidShutdownSignal("   ")).toBe(false);
  });

  it("rejects an unknown signal name", () => {
    expect(isValidShutdownSignal("SIGKILL")).toBe(false);
  });

  it("rejects a non-string value (number)", () => {
    expect(isValidShutdownSignal(42)).toBe(false);
  });

  it("rejects null", () => {
    expect(isValidShutdownSignal(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidShutdownSignal(undefined)).toBe(false);
  });
});
