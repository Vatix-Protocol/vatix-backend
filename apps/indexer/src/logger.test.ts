import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "./logger.js";

/**
 * Logger redaction hardening (#1138).
 *
 * These tests pin three failure modes that previously leaked or crashed:
 *   1. Envelope forging — `meta` overwriting `ts`/`level`/`message`.
 *   2. Secrets in the free-text `message`, which key-based redaction missed.
 *   3. Unserializable meta (cycles) throwing out of the logger.
 */
describe("createLogger redaction (#1138)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Parse the single line the logger emitted. */
  const emitted = (spy = logSpy): Record<string, unknown> =>
    JSON.parse(String(spy.mock.calls[0][0]));

  describe("envelope integrity", () => {
    it("does not let meta forge the log level", () => {
      createLogger("debug").info("legit message", {
        level: "error",
        message: "spoofed",
        ts: "1999-01-01T00:00:00.000Z",
      });

      const line = emitted();
      expect(line.level).toBe("info");
      expect(line.message).toBe("legit message");
      expect(line.ts).not.toBe("1999-01-01T00:00:00.000Z");
    });

    it("preserves the forged values under meta instead of dropping them", () => {
      createLogger("debug").info("legit", { level: "error" });

      expect(emitted().meta).toEqual({ level: "error" });
    });

    it("leaves non-colliding meta at the top level", () => {
      createLogger("debug").info("batch done", { archivedCount: 5 });

      const line = emitted();
      expect(line.archivedCount).toBe(5);
      expect(line.meta).toBeUndefined();
    });

    it("merges with an existing meta key rather than clobbering it", () => {
      createLogger("debug").info("x", { meta: { a: 1 }, level: "error" });

      expect(emitted().meta).toEqual({ a: 1, level: "error" });
    });
  });

  describe("message redaction", () => {
    it("redacts a password embedded in a connection URL in the message", () => {
      createLogger("debug").info(
        "connect failed for redis://admin:sup3rs3cret@cache.internal:6379"
      );

      const line = emitted();
      expect(line.message).not.toContain("sup3rs3cret");
      expect(line.message).toContain("[REDACTED]");
      // Non-secret context must survive so the line is still actionable.
      expect(line.message).toContain("cache.internal:6379");
    });

    it("redacts a bearer token in the message", () => {
      createLogger("debug").info(
        "upstream rejected Authorization: Bearer abc123xyz"
      );

      expect(String(emitted().message)).not.toContain("abc123xyz");
    });

    it("redacts key=value secrets in the message", () => {
      createLogger("debug").info(
        "startup failed password=hunter2 api_key=abcd1234"
      );

      const message = String(emitted().message);
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("abcd1234");
    });

    it("leaves ordinary operational text intact", () => {
      createLogger("debug").info(
        "Archived market mkt_123 stream 1699999999999-0 hash 9f2b1c"
      );

      expect(emitted().message).toBe(
        "Archived market mkt_123 stream 1699999999999-0 hash 9f2b1c"
      );
    });
  });

  describe("never throws on adversarial meta", () => {
    it("handles a circular meta object without throwing", () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      expect(() =>
        createLogger("debug").info("circular", circular)
      ).not.toThrow();
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it("still redacts secrets inside a circular object", () => {
      const circular: Record<string, unknown> = { password: "hunter2" };
      circular.self = circular;

      createLogger("debug").info("circular", circular);

      const output = String(logSpy.mock.calls[0][0]);
      expect(output).not.toContain("hunter2");
    });

    it("handles a self-referencing array", () => {
      const arr: unknown[] = [1];
      arr.push(arr);

      expect(() =>
        createLogger("debug").info("cyclic array", { arr })
      ).not.toThrow();
    });

    it("handles a getter that throws", () => {
      const hostile = {
        get boom() {
          throw new Error("getter exploded");
        },
      };

      expect(() =>
        createLogger("debug").info(
          "hostile",
          hostile as Record<string, unknown>
        )
      ).not.toThrow();
    });
  });

  describe("level filtering", () => {
    it("suppresses records below the configured threshold", () => {
      createLogger("warn").info("should not appear");

      expect(logSpy).not.toHaveBeenCalled();
    });

    it("routes error records to stderr", () => {
      createLogger("error").error("boom");

      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });
});
