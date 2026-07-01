/**
 * Unit tests for Market-Created Event Parser
 *
 * Covers valid payloads, invalid/malformed payloads, and edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  parseMarketCreatedEvent,
  type RawMarketCreatedEvent,
} from "./market-created-parser.js";

describe("parseMarketCreatedEvent", () => {
  const validEvent: RawMarketCreatedEvent = {
    id: "market-001",
    question: "Will BTC reach $100k by end of 2026?",
    endTime: 1893456000, // Unix timestamp in seconds
    oracleAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    status: "ACTIVE",
  };

  describe("valid payloads", () => {
    it("should parse a valid market creation event", () => {
      const result = parseMarketCreatedEvent(validEvent);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.id).toBe("market-001");
      expect(result.data!.question).toBe(
        "Will BTC reach $100k by end of 2026?"
      );
      expect(result.data!.status).toBe("ACTIVE");
      expect(result.data!.oracleAddress).toBe(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      );
    });

    it("should convert numeric endTime to ISO-8601 string", () => {
      const result = parseMarketCreatedEvent(validEvent);

      expect(result.success).toBe(true);
      expect(result.data!.endTime).toBe(
        new Date(1893456000 * 1000).toISOString()
      );
    });

    it("should accept string endTime in ISO-8601 format", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        endTime: "2026-12-31T23:59:59.000Z",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(true);
      expect(result.data!.endTime).toBe("2026-12-31T23:59:59.000Z");
    });

    it("should default status to ACTIVE when not provided", () => {
      const { status, ...eventWithoutStatus } = validEvent;
      const result = parseMarketCreatedEvent(eventWithoutStatus);

      expect(result.success).toBe(true);
      expect(result.data!.status).toBe("ACTIVE");
    });

    it("should normalize status to uppercase", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        status: "active",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(true);
      expect(result.data!.status).toBe("ACTIVE");
    });

    it("should accept RESOLVED status", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        status: "RESOLVED",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(true);
      expect(result.data!.status).toBe("RESOLVED");
    });

    it("should accept CANCELLED status", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        status: "CANCELLED",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(true);
      expect(result.data!.status).toBe("CANCELLED");
    });

    it("should preserve original payload in rawPayload field", () => {
      const result = parseMarketCreatedEvent(validEvent);

      expect(result.success).toBe(true);
      expect(result.data!.rawPayload).toBeDefined();
      expect(result.data!.rawPayload.id).toBe("market-001");
      expect(result.data!.rawPayload.question).toBe(
        "Will BTC reach $100k by end of 2026?"
      );
    });

    it("should preserve extra unknown fields in rawPayload", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        extraField: "some-value",
        blockNumber: 12345,
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(true);
      expect(result.data!.rawPayload.extraField).toBe("some-value");
      expect(result.data!.rawPayload.blockNumber).toBe(12345);
    });
  });

  describe("invalid / malformed payloads", () => {
    it("should fail when id is missing", () => {
      const { id, ...eventWithoutId } = validEvent;
      const result = parseMarketCreatedEvent(eventWithoutId);

      expect(result.success).toBe(false);
      expect(result.error).toContain("id");
    });

    it("should fail when id is not a string", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        id: 123 as unknown as string,
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain("id");
    });

    it("should fail when question is missing", () => {
      const { question, ...eventWithoutQuestion } = validEvent;
      const result = parseMarketCreatedEvent(eventWithoutQuestion);

      expect(result.success).toBe(false);
      expect(result.error).toContain("question");
    });

    it("should fail when question is empty string", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        question: "",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain("question");
    });

    it("should fail when endTime is missing", () => {
      const { endTime, ...eventWithoutEndTime } = validEvent;
      const result = parseMarketCreatedEvent(eventWithoutEndTime);

      expect(result.success).toBe(false);
      expect(result.error).toContain("endTime");
    });

    it("should fail when endTime is an invalid string", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        endTime: "not-a-date",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain("endTime");
    });

    it("should fail when oracleAddress is missing", () => {
      const { oracleAddress, ...eventWithoutOracle } = validEvent;
      const result = parseMarketCreatedEvent(eventWithoutOracle);

      expect(result.success).toBe(false);
      expect(result.error).toContain("oracleAddress");
    });

    it("should fail when oracleAddress has invalid format", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        oracleAddress: "invalid-address",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid oracle address format");
    });

    it("should fail when oracleAddress is too short", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        oracleAddress: "GSHORT",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid oracle address format");
    });

    it("should fail gracefully on null input", () => {
      const result = parseMarketCreatedEvent(
        null as unknown as RawMarketCreatedEvent
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should fail gracefully on undefined input", () => {
      const result = parseMarketCreatedEvent(
        undefined as unknown as RawMarketCreatedEvent
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("should handle endTime as a numeric string", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        endTime: "1893456000",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(true);
      expect(result.data!.endTime).toBe(
        new Date(1893456000 * 1000).toISOString()
      );
    });

    it("should default to ACTIVE for unknown status values", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        status: "UNKNOWN_STATUS",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(true);
      expect(result.data!.status).toBe("ACTIVE");
    });

    it("should trim whitespace from oracleAddress", () => {
      const event: RawMarketCreatedEvent = {
        ...validEvent,
        oracleAddress:
          "  GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  ",
      };
      const result = parseMarketCreatedEvent(event);

      expect(result.success).toBe(true);
      expect(result.data!.oracleAddress).toBe(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      );
    });
  });
});
