import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Logger,
  LoggerValidationError,
  LOG_LEVELS,
} from "../packages/shared/src/logger.js";

afterEach(() => vi.restoreAllMocks());

describe("Logger (shared)", () => {
  it("exports the four standard log levels", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
  });

  it("logs at info level by default", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = new Logger("test", "info");
    logger.info("hello");
    logger.debug("hidden");
    expect(console.info).toHaveBeenCalledOnce();
    expect(console.debug).not.toHaveBeenCalled();
  });

  it("includes prefix in output", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = new Logger("myservice", "info");
    logger.info("started");
    expect(
      (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0]
    ).toContain("[myservice]");
  });

  it("child logger composes prefix", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const parent = new Logger("api", "warn");
    const child = parent.child("auth");
    child.warn("token expired");
    expect(
      (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
    ).toContain("api:auth");
  });

  it("throws LoggerValidationError with statusCode 400 for non-string message", () => {
    const logger = new Logger("", "debug");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => logger.info(42 as any)).toThrow(LoggerValidationError);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger.info(null as any);
    } catch (err) {
      expect((err as LoggerValidationError).statusCode).toBe(400);
    }
  });

  it("throws LoggerValidationError for invalid log level", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new Logger("", "verbose" as any)).toThrow(
      LoggerValidationError
    );
  });
});
