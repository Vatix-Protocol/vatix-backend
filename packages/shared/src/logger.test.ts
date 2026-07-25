import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger, LoggerValidationError, LOG_LEVELS } from "./logger.js";

describe("LOG_LEVELS", () => {
  it("contains the four standard levels in order", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("Logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => vi.restoreAllMocks());

  it("defaults to info level when LOG_LEVEL is unset", () => {
    const log = new Logger();
    log.debug("hidden");
    log.info("visible");
    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledOnce();
  });

  it("respects an explicit level passed to the constructor", () => {
    const log = new Logger("", "debug");
    log.debug("shown");
    expect(console.debug).toHaveBeenCalledOnce();
  });

  it("reads LOG_LEVEL from process.env", () => {
    process.env.LOG_LEVEL = "warn";
    const log = new Logger();
    log.info("suppressed");
    log.warn("shown");
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
    delete process.env.LOG_LEVEL;
  });

  it("falls back to info and warns on invalid LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "verbose";
    const log = new Logger();
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Invalid LOG_LEVEL")
    );
    log.info("still works");
    expect(console.info).toHaveBeenCalledOnce();
    delete process.env.LOG_LEVEL;
  });

  it("throws LoggerValidationError for invalid constructor prefix", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new Logger(42 as any)).toThrow(LoggerValidationError);
  });

  it("throws LoggerValidationError for invalid explicit log level", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new Logger("api", "verbose" as any)).toThrow(
      LoggerValidationError
    );
  });

  it("includes the prefix in output", () => {
    const log = new Logger("indexer", "info");
    log.info("started");
    expect(
      (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0]
    ).toContain("[indexer]");
  });

  it("child logger inherits level and composes prefix", () => {
    const parent = new Logger("api", "debug");
    const child = parent.child("routes");
    child.debug("hit");
    expect(
      (console.debug as ReturnType<typeof vi.fn>).mock.calls[0][0]
    ).toContain("api:routes");
  });

  it("throws LoggerValidationError for invalid child prefix", () => {
    const parent = new Logger("api", "debug");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => parent.child(123 as any)).toThrow(LoggerValidationError);
  });

  it("suppresses messages below the active level", () => {
    const log = new Logger("", "error");
    log.debug("no");
    log.info("no");
    log.warn("no");
    log.error("yes");
    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
  });
});

describe("Logger input validation", () => {
  it("throws LoggerValidationError with statusCode 400 when msg is not a string", () => {
    const log = new Logger("", "debug");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => log.info(42 as any)).toThrow(LoggerValidationError);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log.info(42 as any);
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400 });
    }
  });

  it("throws for null message", () => {
    const log = new Logger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => log.warn(null as any)).toThrow(LoggerValidationError);
  });

  it("throws for object message", () => {
    const log = new Logger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => log.error({} as any)).toThrow(LoggerValidationError);
  });

  it("throws for undefined message", () => {
    const log = new Logger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => log.debug(undefined as any)).toThrow(LoggerValidationError);
  });

  it("does not throw for valid string messages", () => {
    const log = new Logger("", "debug");
    expect(() => log.debug("ok")).not.toThrow();
    expect(() => log.info("ok")).not.toThrow();
    expect(() => log.warn("ok")).not.toThrow();
    expect(() => log.error("ok")).not.toThrow();
  });
});
