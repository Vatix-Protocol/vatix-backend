import { describe, it, expect } from "vitest";
import { validateDatabaseUrl } from "./test-database";

describe("Test Database Utilities", () => {
  describe("validateDatabaseUrl", () => {
    it("should accept valid postgresql:// URLs", () => {
      expect(
        validateDatabaseUrl("postgresql://user:pass@localhost:5432/dbname")
      ).toBe(true);
    });

    it("should accept valid postgres:// URLs", () => {
      expect(
        validateDatabaseUrl("postgres://user:pass@localhost:5432/dbname")
      ).toBe(true);
    });

    it("should accept URLs with default port", () => {
      expect(
        validateDatabaseUrl("postgresql://user:pass@localhost/dbname")
      ).toBe(true);
    });

    it("should reject empty strings", () => {
      expect(validateDatabaseUrl("")).toBe(false);
    });

    it("should reject whitespace-only strings", () => {
      expect(validateDatabaseUrl("   ")).toBe(false);
    });

    it("should reject non-string inputs (number)", () => {
      expect(validateDatabaseUrl(123)).toBe(false);
    });

    it("should reject non-string inputs (object)", () => {
      expect(validateDatabaseUrl({})).toBe(false);
    });

    it("should reject non-string inputs (null)", () => {
      expect(validateDatabaseUrl(null)).toBe(false);
    });

    it("should reject non-string inputs (undefined)", () => {
      expect(validateDatabaseUrl(undefined)).toBe(false);
    });

    it("should reject invalid URL format", () => {
      expect(validateDatabaseUrl("not a url")).toBe(false);
    });

    it("should reject URLs with invalid scheme (http)", () => {
      expect(validateDatabaseUrl("http://localhost:5432/dbname")).toBe(false);
    });

    it("should reject URLs with invalid scheme (https)", () => {
      expect(validateDatabaseUrl("https://localhost:5432/dbname")).toBe(false);
    });

    it("should reject URLs missing hostname", () => {
      expect(validateDatabaseUrl("postgresql://:pass@/dbname")).toBe(false);
    });

    it("should return false (400-equivalent) for invalid input types and formats", () => {
      const invalidInputs = [
        null,
        undefined,
        123,
        true,
        {},
        [],
        "",
        "   ",
        "not-a-url",
        "http://example.com",
      ];

      invalidInputs.forEach((input) => {
        expect(validateDatabaseUrl(input)).toBe(false);
      });
    });
  });
});
