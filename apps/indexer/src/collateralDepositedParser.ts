import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { RawChainEvent } from "./types.js";
import { CollateralDepositedParseError } from "./types.js";
import { safeStringify } from "./safeJson.js";
import type { Telemetry } from "./telemetry.js";
import { amountRawToDecimal } from "./decimalUtils.js";

const COLLATERAL_DEPOSITED_TOPIC = "collateral_deposited";

function isProductionEnv(nodeEnv: string): boolean {
  return nodeEnv === "production";
}

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
  /**
   * Deposit amount in base units (i128, 7 implicit decimal places).
   * e.g. 10_000_000n == 1.0 collateral unit.
   * Use `amountRawToDecimal(amountRaw)` to convert to a Prisma Decimal.
   */
  amountRaw: bigint;
}

function toBigInt(
  value: unknown,
  fieldName: string,
  eventId: string,
  nodeEnv: string
): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) {
    // scValToNative always decodes an i128 ScVal (the contract's collateral
    // amount type) to a bigint, never a plain number. Seeing a number here
    // means the value arrived through a non-i128 path — most likely a
    // fixture or upstream decoder using the wrong scale/width — which is
    // exactly the "wrong scale vs contract 7 decimals" failure mode this
    // guards against. Only tolerate it outside production.
    if (isProductionEnv(nodeEnv)) {
      throw new CollateralDepositedParseError(
        `Field "${fieldName}" decoded as a plain number, not an i128 bigint — ` +
          "refusing to guess the on-chain scale in production",
        eventId
      );
    }
    return BigInt(value);
  }
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
 * Validate `amountRaw` against the same 7-decimal / Decimal(20,8) bounds
 * `decimalUtils.amountRawToDecimal` enforces everywhere else collateral
 * amounts are read. Without this, a value the parser happily returns as a
 * bigint could still be silently out of the scale the rest of the system
 * (UserPosition/CollateralDeposit Decimal columns) assumes for it, and the
 * mismatch would only surface later — e.g. as a DB error or, worse, a
 * silently truncated amount — far from the event that caused it.
 */
function validateCollateralScale(amountRaw: bigint, eventId: string): void {
  if (amountRaw <= 0n) {
    throw new CollateralDepositedParseError(
      `Field "amount" must be a positive i128, got ${amountRaw}`,
      eventId
    );
  }
  try {
    amountRawToDecimal(amountRaw);
  } catch (err) {
    throw new CollateralDepositedParseError(
      `Field "amount" (${amountRaw}) is out of range for the 7-decimal ` +
        `collateral scale: ${err instanceof Error ? err.message : String(err)}`,
      eventId
    );
  }
}

/**
 * Parse a single RawChainEvent into a NormalizedCollateralDeposit.
 *
 * Expected on-chain value: Vec [ account: str, market_id: u32, amount: i128 ]
 *
 * @throws CollateralDepositedParseError on wrong topic, malformed payload,
 *   or an amount that fails the 7-decimal collateral scale validation.
 */
export interface ParseCollateralDepositedOptions {
  telemetry?: Telemetry;
  /** Defaults to `process.env.NODE_ENV`; override in tests only. */
  nodeEnv?: string;
}

export function parseCollateralDepositedEvent(
  event: RawChainEvent,
  options?: ParseCollateralDepositedOptions
): NormalizedCollateralDeposit {
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV ?? "development";

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

  const amountRaw = toBigInt(amount, "amount", event.id, nodeEnv);
  validateCollateralScale(amountRaw, event.id);

  return {
    eventId: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    account,
    marketId: String(marketId),
    amountRaw,
  };
}

/**
 * Parse a batch, skipping non-collateral-deposited events silently.
 */
export function parseCollateralDepositedEvents(
  events: RawChainEvent[],
  options?: ParseCollateralDepositedOptions
): {
  deposits: NormalizedCollateralDeposit[];
  errors: CollateralDepositedParseError[];
} {
  const deposits: NormalizedCollateralDeposit[] = [];
  const errors: CollateralDepositedParseError[] = [];
  const telemetry = options?.telemetry;
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV ?? "development";

  for (const event of events) {
    if (!isCollateralDepositedEvent(event.topicsXdr)) {
      telemetry?.record("indexer.parser.unknown_topics", 1, {
        parser: "collateral_deposited",
        eventId: event.id,
        contractId: event.contractId,
        ledger: String(event.ledger),
      });
      continue;
    }
    try {
      deposits.push(parseCollateralDepositedEvent(event, { telemetry, nodeEnv }));
    } catch (err) {
      telemetry?.record("indexer.parser.invalid_collateral_scale", 1, {
        parser: "collateral_deposited",
        eventId: event.id,
        contractId: event.contractId,
        ledger: String(event.ledger),
      });
      errors.push(
        err instanceof CollateralDepositedParseError
          ? err
          : new CollateralDepositedParseError(String(err), event.id, err)
      );
    }
  }

  return { deposits, errors };
}
