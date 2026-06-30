import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { RawChainEvent } from "./types.js";
import { CollateralDepositedParseError } from "./types.js";
import { safeStringify } from "./safeJson.js";

const COLLATERAL_DEPOSITED_TOPIC = "collateral_deposited";

function decodeScVal(xdrBase64: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(xdrBase64, "base64"));
}

function formatDecodedValue(value: unknown): string {
  return JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current
  );
}

function isCollateralDepositedEvent(topicsXdr: string[]): boolean {
  if (topicsXdr.length === 0) return false;
  try {
    return decodeScVal(topicsXdr[0]) === COLLATERAL_DEPOSITED_TOPIC;
  } catch {
    return false;
  }
}

/**
 * Normalized collateral deposit record.
 *
 * Contract emits a 3-element Vec:
 *   [account: ScvString, market_id: ScvU32, amount: ScvI128]
 */
export interface NormalizedCollateralDeposit {
  eventId: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  /** Stellar account that deposited collateral. */
  account: string;
  /** Numeric market identifier (u32 cast to string for DB compat). */
  marketId: string;
  /** Deposit amount in base units (i128). */
  amountRaw: bigint;
}

function toBigInt(value: unknown, fieldName: string, eventId: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value))
    return BigInt(value);
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      /* fall through */
    }
  }
  throw new CollateralDepositedParseError(
    `Field "${fieldName}" cannot be converted to bigint: ${String(value)}`,
    eventId
  );
}

/**
 * Parse a single RawChainEvent into a NormalizedCollateralDeposit.
 *
 * Expected on-chain value: Vec [ account: str, market_id: u32, amount: i128 ]
 *
 * @throws CollateralDepositedParseError on wrong topic or malformed payload.
 */
export function parseCollateralDepositedEvent(
  event: RawChainEvent
): NormalizedCollateralDeposit {
  if (!isCollateralDepositedEvent(event.topicsXdr)) {
    throw new CollateralDepositedParseError(
      `Event topic is not "${COLLATERAL_DEPOSITED_TOPIC}"`,
      event.id
    );
  }

  let decoded: unknown;
  try {
    decoded = decodeScVal(event.valueXdr);
  } catch (err) {
    throw new CollateralDepositedParseError(
      "Failed to decode event value XDR",
      event.id,
      err
    );
  }

  if (!Array.isArray(decoded) || decoded.length < 3) {
    throw new CollateralDepositedParseError(
      `collateral_deposited payload must be a 3-element tuple, got: ${formatDecodedValue(decoded)}`,
      event.id
    );
  }

  const [account, marketId, amount] = decoded;

  if (typeof account !== "string") {
    throw new CollateralDepositedParseError(
      `Field "account" must be a string, got ${typeof account}`,
      event.id
    );
  }

  return {
    eventId: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    account,
    marketId: String(marketId),
    amountRaw: toBigInt(amount, "amount", event.id),
  };
}

/**
 * Parse a batch, skipping non-collateral-deposited events silently.
 */
export function parseCollateralDepositedEvents(events: RawChainEvent[]): {
  deposits: NormalizedCollateralDeposit[];
  errors: CollateralDepositedParseError[];
} {
  const deposits: NormalizedCollateralDeposit[] = [];
  const errors: CollateralDepositedParseError[] = [];

  for (const event of events) {
    if (!isCollateralDepositedEvent(event.topicsXdr)) continue;
    try {
      deposits.push(parseCollateralDepositedEvent(event));
    } catch (err) {
      errors.push(
        err instanceof CollateralDepositedParseError
          ? err
          : new CollateralDepositedParseError(String(err), event.id, err)
      );
    }
  }

  return { deposits, errors };
}
