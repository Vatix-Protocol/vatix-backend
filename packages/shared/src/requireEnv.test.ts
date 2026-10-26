import { describe, it, expect, vi } from "vitest";
import { requireEnv } from "./requireEnv.js";

function makeLogger() {
  return { error: vi.fn() };
}

describe("requireEnv", () => {
  it("does not exit when all required keys are present", () => {
    const exit = vi.fn();
    const logger = makeLogger();

    requireEnv(["FOO", "BAR"], {
      env: { FOO: "hello", BAR: "world" },
      logger,
      exit,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("exits with code 1 when a single key is missing", () => {
    const exit = vi.fn();
    const logger = makeLogger();

    requireEnv(["MISSING_KEY"], { env: {}, logger, exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Missing required environment variables",
      { missing: ["MISSING_KEY"], count: 1 }
    );
  });

  it("exits with code 1 when multiple keys are missing", () => {
    const exit = vi.fn();
    const logger = makeLogger();

    requireEnv(["KEY_A", "KEY_B", "KEY_C"], {
      env: { KEY_A: "present" },
      logger,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Missing required environment variables",
      { missing: ["KEY_B", "KEY_C"], count: 2 }
    );
  });

  it("reports exactly which keys are missing with structured fields", () => {
    const exit = vi.fn();
    const logger = makeLogger();

    requireEnv(["PRESENT", "ABSENT_ONE", "ABSENT_TWO"], {
      env: { PRESENT: "value" },
      logger,
      exit,
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, fields] = logger.error.mock.calls[0];
    expect(message).toBe("Missing required environment variables");
    expect(fields).toEqual({
      missing: ["ABSENT_ONE", "ABSENT_TWO"],
      count: 2,
    });
  });

  it("treats an empty-string value as missing", () => {
    const exit = vi.fn();
    const logger = makeLogger();

    requireEnv(["EMPTY_KEY"], { env: { EMPTY_KEY: "" }, logger, exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Missing required environment variables",
      { missing: ["EMPTY_KEY"], count: 1 }
    );
  });

  it("treats a whitespace-only value as missing", () => {
    const exit = vi.fn();
    const logger = makeLogger();

    requireEnv(["BLANK_KEY"], { env: { BLANK_KEY: "   " }, logger, exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Missing required environment variables",
      { missing: ["BLANK_KEY"], count: 1 }
    );
  });

  it("does not exit when the key list is empty", () => {
    const exit = vi.fn();
    const logger = makeLogger();

    requireEnv([], { env: {}, logger, exit });

    expect(exit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
