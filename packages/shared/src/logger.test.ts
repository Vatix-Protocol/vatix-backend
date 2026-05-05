import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger, LOG_LEVELS } from "./logger.js";

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
