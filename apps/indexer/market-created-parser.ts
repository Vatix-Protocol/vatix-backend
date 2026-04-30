/**
 * Market-Created Event Parser
 *
 * Parses and normalizes market creation events into the internal model.
 * Stores the original payload for debugging purposes.
 *
 * @module apps/indexer/market-created-parser
 */

import type { MarketStatus } from "../../src/types/index.js";

/**
 * Raw market creation event as received from the blockchain/oracle.
 */
export interface RawMarketCreatedEvent {
  /** Unique market identifier */
  id?: string;
  /** Market question/prediction prompt */
  question?: string;
  /** Unix timestamp (seconds) when the market closes */
  endTime?: number | string;
  /** Stellar oracle address (56-char base32) */
  oracleAddress?: string;
  /** Initial market status */
  status?: string;
  /** Any additional raw fields from the source */
  [key: string]: unknown;
}

/**
 * Normalized internal representation of a market creation event.
 */
export interface MarketCreatedEvent {
  /** Unique market identifier */
  id: string;
  /** Market question/prediction prompt */
  question: string;
  /** ISO-8601 timestamp when the market closes */
  endTime: string;
  /** Stellar oracle address (56-char base32) */
  oracleAddress: string;
  /** Initial market status (defaults to ACTIVE) */
  status: MarketStatus;
  /** Original raw payload preserved for debugging */
  rawPayload: Record<string, unknown>;
}

/**
 * Result of parsing a market creation event.
 */
export interface ParseResult<T> {
  /** Whether parsing succeeded */
  success: boolean;
  /** Parsed event on success */
  data?: T;
  /** Error message on failure */
  error?: string;
}

/**
 * Parse and normalize a raw market creation event into the internal model.
 *
 * @param rawEvent - The raw event payload from the blockchain/oracle
 * @returns ParseResult containing either the normalized event or an error
 */
export function parseMarketCreatedEvent(
  rawEvent: RawMarketCreatedEvent
): ParseResult<MarketCreatedEvent> {
  try {
    // Validate required fields
    if (!rawEvent.id || typeof rawEvent.id !== "string") {
      return {
        success: false,
        error: "Missing or invalid required field: id",
      };
    }

    if (!rawEvent.question || typeof rawEvent.question !== "string") {
      return {
        success: false,
        error: "Missing or invalid required field: question",
      };
    }

    if (rawEvent.endTime === undefined || rawEvent.endTime === null) {
      return {
        success: false,
        error: "Missing required field: endTime",
      };
    }

    if (!rawEvent.oracleAddress || typeof rawEvent.oracleAddress !== "string") {
      return {
        success: false,
        error: "Missing or invalid required field: oracleAddress",
      };
    }

    // Validate oracle address format (Stellar: G + 55 alphanumeric chars)
    const oracleAddress = rawEvent.oracleAddress.trim();
    if (!/^G[A-Z0-9]{55}$/i.test(oracleAddress)) {
      return {
        success: false,
        error: `Invalid oracle address format: ${oracleAddress}`,
      };
    }

    // Normalize endTime to ISO-8601 string
    let endTime: string;
    if (typeof rawEvent.endTime === "number") {
      endTime = new Date(rawEvent.endTime * 1000).toISOString();
    } else if (typeof rawEvent.endTime === "string") {
      // Check if the string is a numeric timestamp (all digits)
      const numericTimestamp = /^\d+$/.test(rawEvent.endTime);
      if (numericTimestamp) {
        endTime = new Date(Number(rawEvent.endTime) * 1000).toISOString();
      } else {
        const parsed = new Date(rawEvent.endTime);
        if (isNaN(parsed.getTime())) {
          return {
            success: false,
            error: `Invalid endTime format: ${rawEvent.endTime}`,
          };
        }
        endTime = parsed.toISOString();
      }
    } else {
      return {
        success: false,
        error: `Unsupported endTime type: ${typeof rawEvent.endTime}`,
      };
    }

    // Normalize status
    const validStatuses: MarketStatus[] = ["ACTIVE", "RESOLVED", "CANCELLED"];
    const rawStatus = rawEvent.status?.toUpperCase() ?? "ACTIVE";
    const status: MarketStatus = validStatuses.includes(
      rawStatus as MarketStatus
    )
      ? (rawStatus as MarketStatus)
      : "ACTIVE";

    // Preserve original payload for debugging (excluding sensitive fields)
    const { ...rawPayload } = rawEvent;

    return {
      success: true,
      data: {
        id: rawEvent.id,
        question: rawEvent.question,
        endTime,
        oracleAddress,
        status,
        rawPayload,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown parsing error";
    return {
      success: false,
      error: `Unexpected error during parsing: ${message}`,
    };
  }
}
