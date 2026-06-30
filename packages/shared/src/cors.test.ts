import { describe, it, expect } from "vitest";
import { resolveCorsAllowedOrigins } from "./cors.js";

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
});
