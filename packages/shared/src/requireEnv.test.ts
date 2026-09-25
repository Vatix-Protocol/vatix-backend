import { describe, it, expect, vi, afterEach } from "vitest";
import { requireEnv } from "./requireEnv.js";

describe("requireEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not exit when all required keys are present", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() =>
      requireEnv(["FOO", "BAR"], { FOO: "hello", BAR: "world" })
    ).not.toThrow();

    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with code 1 when a single key is missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => requireEnv(["MISSING_KEY"], {})).toThrow(
      "process.exit called"
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when multiple keys are missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() =>
      requireEnv(["KEY_A", "KEY_B", "KEY_C"], { KEY_A: "present" })
    ).toThrow("process.exit called");

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("outputs a structured JSON log with appropriate fields and lists exactly which keys are missing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() =>
      requireEnv(["PRESENT", "ABSENT_ONE", "ABSENT_TWO"], {
        PRESENT: "value",
      })
    ).toThrow();

    const rawMessage: string = errorSpy.mock.calls[0][0];
    const parsed = JSON.parse(rawMessage);

    expect(parsed).toHaveProperty("ts");
    expect(parsed.level).toBe("error");
    expect(parsed.message).toBe("Missing required environment variables");
    expect(parsed.missing).toEqual(["ABSENT_ONE", "ABSENT_TWO"]);
    expect(parsed.count).toBe(2);
  });

  it("outputs structured log with count=1 when only one key is missing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => requireEnv(["MISSING_KEY"], {})).toThrow();

    const rawMessage: string = errorSpy.mock.calls[0][0];
    const parsed = JSON.parse(rawMessage);

    expect(parsed).toHaveProperty("ts");
    expect(parsed.level).toBe("error");
    expect(parsed.message).toBe("Missing required environment variables");
    expect(parsed.missing).toEqual(["MISSING_KEY"]);
    expect(parsed.count).toBe(1);
  });

  it("treats an empty-string value as missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => requireEnv(["EMPTY_KEY"], { EMPTY_KEY: "" })).toThrow(
      "process.exit called"
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("treats a whitespace-only value as missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => requireEnv(["BLANK_KEY"], { BLANK_KEY: "   " })).toThrow(
      "process.exit called"
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not exit when the key list is empty", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => requireEnv([], {})).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });
});
