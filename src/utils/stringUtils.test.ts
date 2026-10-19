import { describe, it, expect } from "vitest";
import {
  capitalise,
  toTitleCase,
  truncate,
  maskEmail,
  maskPhone,
  slugify,
} from "./stringUtils";

describe("stringUtils", () => {
  describe("capitalise", () => {
    it("capitalises the first character", () => {
      expect(capitalise("hello")).toBe("Hello");
    });

    it("returns empty string unchanged", () => {
      expect(capitalise("")).toBe("");
    });
  });

  describe("toTitleCase", () => {
    it("title-cases each word", () => {
      expect(toTitleCase("hello world")).toBe("Hello World");
    });
  });

  describe("truncate", () => {
    it("truncates with default ellipsis", () => {
      expect(truncate("Hello, world!", 8)).toBe("Hello, …");
    });

    it("truncates with custom ellipsis", () => {
      expect(truncate("Hello, world!", 8, "...")).toBe("Hello...");
    });

    it("returns the string unchanged when within limit", () => {
      expect(truncate("Hi", 10)).toBe("Hi");
    });

    it("returns empty string for maxLen of 0", () => {
      expect(truncate("Hello", 0)).toBe("");
    });

    it("returns empty string for negative maxLen", () => {
      expect(truncate("Hello", -5)).toBe("");
    });

    it("returns empty string for NaN maxLen", () => {
      expect(truncate("Hello", NaN)).toBe("");
    });

    it("returns empty string for Infinity maxLen", () => {
      expect(truncate("Hello", Infinity)).toBe("");
    });

    it("normalises fractional maxLen", () => {
      expect(truncate("Hello", 8.9).length).toBeLessThanOrEqual(8);
    });

    it("slices ellipsis to maxLen when ellipsis is longer", () => {
      expect(truncate("Hello", 1, "...")).toBe(".");
    });
  });

  describe("maskEmail", () => {
    it("masks the local part", () => {
      expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    });
  });

  describe("maskPhone", () => {
    it("masks all but the last four digits", () => {
      expect(maskPhone("+15551234567")).toBe("***4567");
    });
  });

  describe("slugify", () => {
    it("produces a url-friendly slug", () => {
      expect(slugify("Hello, World!")).toBe("hello-world");
    });
  });
});
