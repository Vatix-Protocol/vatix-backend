/**
 * Market-Created Event Parser
 *
 * Validates and normalizes raw market-created events into a canonical shape.
 */

import {
  isInitialStatus,
  isMarketStatus,
  MARKET_QUESTION_MAX_LENGTH,
} from "../../packages/shared/src/marketLifecycle.js";

export interface RawMarketCreatedEvent {
  id: string;
  question: string;
  endTime: number | string;
  oracleAddress: string;
  status?: string;
  [key: string]: unknown;
}

export interface NormalizedMarketCreatedEvent {
  id: string;
  question: string;
  endTime: string;
  oracleAddress: string;
  status: string;
  rawPayload: RawMarketCreatedEvent;
}

export type ParseResult =
  | { success: true; data: NormalizedMarketCreatedEvent }
  | { success: false; error: string };

const ORACLE_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

function normalizeEndTime(value: number | string): string | null {
  if (typeof value === "number") {
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toISOString();
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (value.trim() !== "" && !Number.isNaN(numeric)) {
      const date = new Date(numeric * 1000);
      if (Number.isNaN(date.getTime())) {
        return null;
      }
      return date.toISOString();
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toISOString();
  }

  return null;
}

export function parseMarketCreatedEvent(
  raw: RawMarketCreatedEvent
): ParseResult {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { success: false, error: "Invalid event: expected an object" };
  }

  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    return { success: false, error: "Invalid event: missing or invalid id" };
  }

  if (typeof raw.question !== "string" || raw.question.trim() === "") {
    return {
      success: false,
      error: "Invalid event: missing or invalid question",
    };
  }

  if (raw.question.length > MARKET_QUESTION_MAX_LENGTH) {
    return {
      success: false,
      error: `Invalid event: question exceeds maximum length of ${MARKET_QUESTION_MAX_LENGTH} characters`,
    };
  }

  if (raw.endTime === undefined || raw.endTime === null) {
    return {
      success: false,
      error: "Invalid event: missing or invalid endTime",
    };
  }

  const endTime = normalizeEndTime(raw.endTime);
  if (endTime === null) {
    return {
      success: false,
      error: "Invalid event: missing or invalid endTime",
    };
  }

  if (
    typeof raw.oracleAddress !== "string" ||
    !ORACLE_ADDRESS_REGEX.test(raw.oracleAddress)
  ) {
    return {
      success: false,
      error: "Invalid oracle address format",
    };
  }

  let status = "ACTIVE";
  if (raw.status !== undefined && raw.status !== null) {
    const normalized = String(raw.status).toUpperCase();
    if (isInitialStatus(normalized)) {
      status = normalized;
    } else if (isMarketStatus(normalized)) {
      status = "ACTIVE";
    }
  }

  return {
    success: true,
    data: {
      id: raw.id,
      question: raw.question,
      endTime,
      oracleAddress: raw.oracleAddress,
      status,
      rawPayload: raw,
    },
  };
}
