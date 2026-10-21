import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { validateDatabaseUrl } from "./test-database";

const { connectMock, queryMock, endMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  queryMock: vi.fn(),
  endMock: vi.fn(),
}));

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  return {
    ...actual,
    Client: vi.fn(() => ({
      connect: connectMock,
      query: queryMock,
      end: endMock,
    })),
  };
});

import {
  acquireDatabaseLock,
  cleanDatabase,
  disconnectTestPrisma,
} from "./test-database";

describe("Test Database Utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValue({ rows: [{ acquired: true, unlocked: true }] });
    endMock.mockResolvedValue(undefined);
  });

  describe("cleanDatabase", () => {
    it("deletes every table written by the seed in foreign-key order", async () => {
      const deleted: string[] = [];
      const deleteMany = (table: string) =>
        vi.fn(async () => {
          deleted.push(table);
          return { count: 0 };
        });
      const prisma = {
        trade: { deleteMany: deleteMany("trade") },
        order: { deleteMany: deleteMany("order") },
        userPosition: { deleteMany: deleteMany("userPosition") },
        market: { deleteMany: deleteMany("market") },
      } as unknown as PrismaClient;

      await cleanDatabase(prisma);

      expect(deleted).toEqual(["trade", "order", "userPosition", "market"]);
    });
  });

  describe("database advisory lock", () => {
    it("closes its dedicated connection when lock acquisition fails", async () => {
      queryMock.mockRejectedValueOnce(new Error("lock query failed"));

      await expect(acquireDatabaseLock()).rejects.toThrow("lock query failed");
      expect(endMock).toHaveBeenCalledOnce();
    });

    it("releases the lock when suite setup fails before afterAll cleanup", async () => {
      await expect(
        (async () => {
          await acquireDatabaseLock();
          try {
            throw new Error("suite setup failed");
          } catch (error) {
            await disconnectTestPrisma();
            throw error;
          }
        })()
      ).rejects.toThrow("suite setup failed");

      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(queryMock.mock.calls[1][0]).toContain("pg_advisory_unlock");
      expect(endMock).toHaveBeenCalledOnce();
    });
  });

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
