import { describe, it, expect } from "vitest";
import {
  isOriginAllowed,
  normalizeOrigin,
  resolveCorsAllowedOrigins,
} from "./cors.js";

describe("resolveCorsAllowedOrigins", () => {
  it("returns localhost defaults in development when unset", () => {
    expect(resolveCorsAllowedOrigins("development", undefined)).toEqual([
      "http://localhost:3000",
      "http://localhost:5173",
    ]);
  });

  it("returns no origins in production when unset", () => {
    expect(resolveCorsAllowedOrigins("production", undefined)).toEqual([]);
  });

  it("parses comma-separated overrides", () => {
    expect(
      resolveCorsAllowedOrigins(
        "production",
        "https://app.vatix.io,https://staging.vatix.io"
      )
    ).toEqual(["https://app.vatix.io", "https://staging.vatix.io"]);
  });

  // ── #1122: wildcard / malformed origins ────────────────────────────────────
  describe("wildcard rejection (#1122)", () => {
    it("throws on a '*' origin in production", () => {
      expect(() => resolveCorsAllowedOrigins("production", "*")).toThrow(
        /rejected in production/
      );
    });

    it("throws when '*' is mixed with explicit origins in production", () => {
      expect(() =>
        resolveCorsAllowedOrigins("production", "https://app.vatix.io,*")
      ).toThrow(/rejected in production/);
    });

    it("throws on an opaque 'null' origin in production", () => {
      expect(() => resolveCorsAllowedOrigins("production", "null")).toThrow(
        /rejected in production/
      );
    });

    it("drops '*' outside production rather than honouring it", () => {
      expect(
        resolveCorsAllowedOrigins("development", "*,http://localhost:3000")
      ).toEqual(["http://localhost:3000"]);
    });
  });

  describe("malformed origin entries (#1122)", () => {
    it("drops entries carrying a path, query, or fragment", () => {
      expect(
        resolveCorsAllowedOrigins(
          "production",
          "https://app.vatix.io/admin,https://staging.vatix.io/?x=1,https://ok.vatix.io"
        )
      ).toEqual(["https://ok.vatix.io"]);
    });

    it("drops unparseable entries in non-production", () => {
      expect(
        resolveCorsAllowedOrigins(
          "development",
          "app.vatix.io,http://localhost:3000"
        )
      ).toEqual(["http://localhost:3000"]);
    });

    it("fails closed on a scheme-less entry in production (https rule wins)", () => {
      // A scheme-less entry cannot be an https origin, so production refuses
      // the whole allowlist rather than guessing the scheme.
      expect(() =>
        resolveCorsAllowedOrigins(
          "production",
          "app.vatix.io,https://ok.vatix.io"
        )
      ).toThrow(/must use https:\/\//);
    });

    it("normalizes case and trailing slashes", () => {
      expect(
        resolveCorsAllowedOrigins("production", "https://App.Vatix.IO/")
      ).toEqual(["https://app.vatix.io"]);
    });
  });
});

describe("normalizeOrigin (#1122)", () => {
  it("lowercases the host and strips a trailing slash", () => {
    expect(normalizeOrigin("https://App.Vatix.IO/")).toBe(
      "https://app.vatix.io"
    );
  });

  it("preserves an explicit port", () => {
    expect(normalizeOrigin("http://localhost:5173")).toBe(
      "http://localhost:5173"
    );
  });

  it("returns null for wildcard, null, empty, and unparseable input", () => {
    expect(normalizeOrigin("*")).toBeNull();
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizeOrigin("  ")).toBeNull();
    expect(normalizeOrigin("app.vatix.io")).toBeNull();
  });

  it("returns null for non-http(s) schemes", () => {
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
  });

  it("returns null for entries with a path, query, or fragment", () => {
    expect(normalizeOrigin("https://app.vatix.io/admin")).toBeNull();
    expect(normalizeOrigin("https://app.vatix.io?a=1")).toBeNull();
    expect(normalizeOrigin("https://app.vatix.io#x")).toBeNull();
  });
});

describe("isOriginAllowed (#1122)", () => {
  const allowed = ["https://app.vatix.io", "http://localhost:3000"];

  it("matches an exact allowlist entry", () => {
    expect(isOriginAllowed("https://app.vatix.io", allowed)).toBe(true);
  });

  it("matches despite cosmetic differences on either side", () => {
    expect(isOriginAllowed("https://app.vatix.io/", allowed)).toBe(true);
    expect(
      isOriginAllowed("https://APP.VATIX.IO", ["https://App.Vatix.IO/"])
    ).toBe(true);
  });

  it("denies an unlisted origin", () => {
    expect(isOriginAllowed("https://evil.example", allowed)).toBe(false);
  });

  it("denies a suffix/prefix near-miss (no wildcard matching)", () => {
    expect(isOriginAllowed("https://app.vatix.io.evil.example", allowed)).toBe(
      false
    );
    expect(
      isOriginAllowed("https://evil.example/https://app.vatix.io", allowed)
    ).toBe(false);
    expect(isOriginAllowed("https://sub.app.vatix.io", allowed)).toBe(false);
  });

  it("denies every origin when the allowlist is empty (deny-by-default)", () => {
    expect(isOriginAllowed("https://app.vatix.io", [])).toBe(false);
  });

  it("denies adversarial origin values", () => {
    expect(isOriginAllowed("*", allowed)).toBe(false);
    expect(isOriginAllowed("null", allowed)).toBe(false);
    expect(isOriginAllowed("", allowed)).toBe(false);
  });
});
