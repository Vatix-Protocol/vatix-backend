import { Decimal } from "@prisma/client/runtime/client.js";
import type { Telemetry } from "./telemetry.js";

/**
 * On-chain collateral amounts are i128 integers with 7 implicit decimal places.
 * e.g. 10_000_000n on-chain == 1.0 collateral unit.
 *
 * This scale matches the `Decimal(20, 8)` columns in the Prisma schema
 * (lockedCollateral, collateralReleased) which store up to 8 fractional digits —
 * more than enough for the 7-decimal on-chain representation.
 */
export const COLLATERAL_SCALE = 7n;
const COLLATERAL_DIVISOR = 10n ** COLLATERAL_SCALE; // 10_000_000n

/** Maximum raw value that fits in Decimal(20, 8) with 7 fractional digits. */
const MAX_RAW = 9_999_999_999_990_000_000n;

/** Largest bigint that survives a bigint -> Number conversion without silent precision loss. */
const MAX_SAFE_SHARE_QUANTITY = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Stable error codes for decimal utils operations.
 * Safe to switch on in clients and dashboards.
 */
export const DECIMAL_UTILS_ERROR_CODES = {
  /** Input value exceeds the Decimal(20, 8) column range. */
  VALUE_OUT_OF_RANGE: "DECIMAL_VALUE_OUT_OF_RANGE",
  /** Input string is not a valid integer. */
  INVALID_INTEGER_STRING: "DECIMAL_INVALID_INTEGER_STRING",
  /** Decimal has more than 7 fractional digits (would truncate on-chain). */
  EXCESS_FRACTIONAL_DIGITS: "DECIMAL_EXCESS_FRACTIONAL_DIGITS",
  /** Share quantity is negative. */
  NEGATIVE_QUANTITY: "DECIMAL_NEGATIVE_QUANTITY",
  /** Share quantity exceeds Number.MAX_SAFE_INTEGER (would lose precision). */
  QUANTITY_EXCEEDS_SAFE_INTEGER: "DECIMAL_QUANTITY_EXCEEDS_SAFE_INTEGER",
  /** Feature flag disabled for money-path operation. */
  FEATURE_DISABLED: "DECIMAL_FEATURE_DISABLED",
} as const;

export type DecimalUtilsErrorCode =
  (typeof DECIMAL_UTILS_ERROR_CODES)[keyof typeof DECIMAL_UTILS_ERROR_CODES];

/**
 * Base error class for decimal utils operations.
 * Carries a stable error code and optional correlation ID for tracing.
 */
export class DecimalUtilsError extends Error {
  readonly code: DecimalUtilsErrorCode;
  readonly correlationId?: string;

  constructor(code: DecimalUtilsErrorCode, message: string, correlationId?: string) {
    super(message);
    this.name = "DecimalUtilsError";
    this.code = code;
    this.correlationId = correlationId;
  }
}

/**
 * Error thrown when a value exceeds the Decimal(20, 8) column range.
 */
export class DecimalValueOutOfRangeError extends DecimalUtilsError {
  constructor(value: bigint | string | Decimal, correlationId?: string) {
    const msg = typeof value === "bigint" || typeof value === "string"
      ? `value ${value} exceeds Decimal(20,8) column range`
      : `value ${value.toString()} exceeds Decimal(20,8) column range`;
    super(DECIMAL_UTILS_ERROR_CODES.VALUE_OUT_OF_RANGE, msg, correlationId);
    this.name = "DecimalValueOutOfRangeError";
  }
}

/**
 * Error thrown when input string is not a valid integer.
 */
export class DecimalInvalidIntegerStringError extends DecimalUtilsError {
  constructor(input: string, correlationId?: string) {
    super(
      DECIMAL_UTILS_ERROR_CODES.INVALID_INTEGER_STRING,
      `invalid integer string "${input}"`,
      correlationId
    );
    this.name = "DecimalInvalidIntegerStringError";
  }
}

/**
 * Error thrown when a decimal has more than 7 fractional digits.
 */
export class DecimalExcessFractionalDigitsError extends DecimalUtilsError {
  constructor(value: Decimal | string | number, correlationId?: string) {
    const str = value instanceof Decimal ? value.toString() : String(value);
    super(
      DECIMAL_UTILS_ERROR_CODES.EXCESS_FRACTIONAL_DIGITS,
      `value ${str} has more than ${COLLATERAL_SCALE} fractional digits`,
      correlationId
    );
    this.name = "DecimalExcessFractionalDigitsError";
  }
}

/**
 * Error thrown when a share quantity is negative.
 */
export class DecimalNegativeQuantityError extends DecimalUtilsError {
  constructor(value: bigint | string, correlationId?: string) {
    super(
      DECIMAL_UTILS_ERROR_CODES.NEGATIVE_QUANTITY,
      `quantity must not be negative, got ${value}`,
      correlationId
    );
    this.name = "DecimalNegativeQuantityError";
  }
}

/**
 * Error thrown when a share quantity exceeds Number.MAX_SAFE_INTEGER.
 */
export class DecimalQuantityExceedsSafeIntegerError extends DecimalUtilsError {
  constructor(value: bigint | string, correlationId?: string) {
    super(
      DECIMAL_UTILS_ERROR_CODES.QUANTITY_EXCEEDS_SAFE_INTEGER,
      `quantity ${value} exceeds Number.MAX_SAFE_INTEGER (${MAX_SAFE_SHARE_QUANTITY}) and cannot be converted without precision loss`,
      correlationId
    );
    this.name = "DecimalQuantityExceedsSafeIntegerError";
  }
}

/**
 * Error thrown when a money-path operation is disabled via feature flag.
 */
export class DecimalFeatureDisabledError extends DecimalUtilsError {
  constructor(operation: string, correlationId?: string) {
    super(
      DECIMAL_UTILS_ERROR_CODES.FEATURE_DISABLED,
      `decimal utils operation "${operation}" is disabled by feature flag`,
      correlationId
    );
    this.name = "DecimalFeatureDisabledError";
  }
}

/**
 * Feature flag configuration for decimal utils money-path operations.
 * All flags default to enabled (true) for backward compatibility.
 * Set to false to disable the corresponding operation (fail-closed).
 */
export interface DecimalUtilsFeatureFlags {
  /** Enable amountRawToDecimal conversion (collateral deposit indexing). */
  amountRawToDecimal: boolean;
  /** Enable decimalToAmountRaw conversion (on-chain calls from stored values). */
  decimalToAmountRaw: boolean;
  /** Enable sharesRawToInt conversion (trade/order quantity processing). */
  sharesRawToInt: boolean;
}

/**
 * Default feature flags - all enabled.
 * Override via config or environment for kill-switch behavior.
 */
export const DEFAULT_DECIMAL_UTILS_FEATURE_FLAGS: DecimalUtilsFeatureFlags = {
  amountRawToDecimal: true,
  decimalToAmountRaw: true,
  sharesRawToInt: true,
};

/**
 * Options for decimal utils operations.
 */
export interface DecimalUtilsOptions {
  /** Correlation ID for request tracing and log correlation. */
  correlationId?: string;
  /** Optional telemetry instance for metrics recording. */
  telemetry?: Telemetry;
  /** Optional feature flags for kill-switch control. */
  featureFlags?: Partial<DecimalUtilsFeatureFlags>;
}

/**
 * Merge provided feature flags with defaults.
 */
function getFeatureFlags(flags?: Partial<DecimalUtilsFeatureFlags>): DecimalUtilsFeatureFlags {
  return {
    ...DEFAULT_DECIMAL_UTILS_FEATURE_FLAGS,
    ...flags,
  };
}

/**
 * Check feature flag and throw if disabled (fail-closed).
 */
function checkFeatureFlag(
  flagName: keyof DecimalUtilsFeatureFlags,
  flags: DecimalUtilsFeatureFlags,
  correlationId?: string
): void {
  if (!flags[flagName]) {
    throw new DecimalFeatureDisabledError(flagName, correlationId);
  }
}

/**
 * Record a metric via telemetry if available.
 */
function recordMetric(
  telemetry: Telemetry | undefined,
  metric: string,
  value: number,
  tags?: Record<string, string>
): void {
  if (telemetry) {
    telemetry.record(metric, value, tags);
  }
}

/**
 * Convert a raw on-chain collateral amount (i128 integer, 7 implicit decimals)
 * to a Prisma Decimal suitable for DB columns typed Decimal(20, 8).
 *
 * @param raw - bigint or decimal-string representation of the i128 amount
 * @param options - Optional correlation ID, telemetry, and feature flags
 * @throws DecimalValueOutOfRangeError when value exceeds Decimal(20, 8) range
 * @throws DecimalInvalidIntegerStringError when raw is not a valid integer string
 * @throws DecimalFeatureDisabledError when feature flag is disabled
 *
 * @example
 *   amountRawToDecimal(10_000_000n)  // => Decimal("1.0000000")
 *   amountRawToDecimal("500000000")  // => Decimal("50.0000000")
 */
export function amountRawToDecimal(
  raw: bigint | string,
  options: DecimalUtilsOptions = {}
): Decimal {
  const { correlationId, telemetry, featureFlags } = options;
  const flags = getFeatureFlags(featureFlags);
  const startTime = performance.now();

  checkFeatureFlag("amountRawToDecimal", flags, correlationId);

  let value: bigint;

  if (typeof raw === "bigint") {
    value = raw;
  } else {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      const error = new DecimalInvalidIntegerStringError(raw, correlationId);
      recordMetric(telemetry, "decimal_utils.amountRawToDecimal.error", 1, {
        error_code: error.code,
      });
      throw error;
    }
    value = BigInt(trimmed);
  }

  const absValue = value < 0n ? -value : value;
  if (absValue > MAX_RAW) {
    const error = new DecimalValueOutOfRangeError(value, correlationId);
    recordMetric(telemetry, "decimal_utils.amountRawToDecimal.error", 1, {
      error_code: error.code,
    });
    throw error;
  }

  // Perform integer division and remainder to build the decimal string
  // without floating-point loss.
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const intPart = abs / COLLATERAL_DIVISOR;
  const fracPart = abs % COLLATERAL_DIVISOR;
  // Zero-pad fractional part to COLLATERAL_SCALE digits
  const fracStr = fracPart.toString().padStart(Number(COLLATERAL_SCALE), "0");

  const result = new Decimal(`${sign}${intPart}.${fracStr}`);

  recordMetric(telemetry, "decimal_utils.amountRawToDecimal.success", 1, {
    has_correlation_id: correlationId ? "true" : "false",
  });
  recordMetric(telemetry, "decimal_utils.amountRawToDecimal.duration_ms", performance.now() - startTime, {
    has_correlation_id: correlationId ? "true" : "false",
  });

  return result;
}

/**
 * Inverse of `amountRawToDecimal`: convert a Decimal(20,8) collateral value
 * back into its raw on-chain i128 representation (bigint, 7 implicit
 * decimals). Needed anywhere a DB/API decimal amount must round-trip back
 * onto the chain (e.g. building a contract call from a stored value).
 *
 * @param value - Decimal, string, or number to convert
 * @param options - Optional correlation ID, telemetry, and feature flags
 * @throws DecimalExcessFractionalDigitsError when value has > 7 fractional digits
 * @throws DecimalValueOutOfRangeError when value exceeds Decimal(20, 8) range
 * @throws DecimalFeatureDisabledError when feature flag is disabled
 */
export function decimalToAmountRaw(
  value: Decimal | string | number,
  options: DecimalUtilsOptions = {}
): bigint {
  const { correlationId, telemetry, featureFlags } = options;
  const flags = getFeatureFlags(featureFlags);
  const startTime = performance.now();

  checkFeatureFlag("decimalToAmountRaw", flags, correlationId);

  const decimal = value instanceof Decimal ? value : new Decimal(value);
  const scaled = decimal.mul(COLLATERAL_DIVISOR.toString());

  if (!scaled.isInteger()) {
    const error = new DecimalExcessFractionalDigitsError(value, correlationId);
    recordMetric(telemetry, "decimal_utils.decimalToAmountRaw.error", 1, {
      error_code: error.code,
    });
    throw error;
  }

  const raw = BigInt(scaled.toFixed(0));
  const absRaw = raw < 0n ? -raw : raw;
  if (absRaw > MAX_RAW) {
    const error = new DecimalValueOutOfRangeError(value, correlationId);
    recordMetric(telemetry, "decimal_utils.decimalToAmountRaw.error", 1, {
      error_code: error.code,
    });
    throw error;
  }

  recordMetric(telemetry, "decimal_utils.decimalToAmountRaw.success", 1, {
    has_correlation_id: correlationId ? "true" : "false",
  });
  recordMetric(telemetry, "decimal_utils.decimalToAmountRaw.duration_ms", performance.now() - startTime, {
    has_correlation_id: correlationId ? "true" : "false",
  });

  return raw;
}

/**
 * Convert a raw on-chain trade/order quantity into a validated JS integer
 * share count.
 *
 * Unlike collateral and price, on-chain share quantities are **not**
 * fixed-point scaled — a prediction-market share is a discrete, whole unit,
 * matching the plain-integer `quantity` used throughout the CLOB
 * (`src/matching`) and the `Int` `yesShares`/`noShares` columns on
 * `UserPosition`. So this performs no division — its job is to make the
 * bigint -> Number boundary explicit and safe instead of an unchecked
 * `Number(raw)`, which silently loses precision past
 * `Number.MAX_SAFE_INTEGER` and silently accepts negative/fractional input.
 *
 * NOTE: `vatix-contract/test-vectors/share-math.json` (the on-chain
 * contract's own share-math fixtures) is not vendored into this repository,
 * so this conversion is verified here by property/round-trip fuzzing over
 * the documented invariants rather than against the contract's own
 * fixtures. If/when that file becomes available, wire it into
 * `decimalUtils.test.ts` directly.
 *
 * @param raw - bigint or string representation of the share quantity
 * @param options - Optional correlation ID, telemetry, and feature flags
 * @throws DecimalNegativeQuantityError when quantity is negative
 * @throws DecimalQuantityExceedsSafeIntegerError when quantity > MAX_SAFE_INTEGER
 * @throws DecimalInvalidIntegerStringError when raw is not a valid integer string
 * @throws DecimalFeatureDisabledError when feature flag is disabled
 */
export function sharesRawToInt(
  raw: bigint | string,
  options: DecimalUtilsOptions = {}
): number {
  const { correlationId, telemetry, featureFlags } = options;
  const flags = getFeatureFlags(featureFlags);
  const startTime = performance.now();

  checkFeatureFlag("sharesRawToInt", flags, correlationId);

  let value: bigint;

  if (typeof raw === "bigint") {
    value = raw;
  } else {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      const error = new DecimalInvalidIntegerStringError(raw, correlationId);
      recordMetric(telemetry, "decimal_utils.sharesRawToInt.error", 1, {
        error_code: error.code,
      });
      throw error;
    }
    value = BigInt(trimmed);
  }

  if (value < 0n) {
    const error = new DecimalNegativeQuantityError(value, correlationId);
    recordMetric(telemetry, "decimal_utils.sharesRawToInt.error", 1, {
      error_code: error.code,
    });
    throw error;
  }

  if (value > MAX_SAFE_SHARE_QUANTITY) {
    const error = new DecimalQuantityExceedsSafeIntegerError(value, correlationId);
    recordMetric(telemetry, "decimal_utils.sharesRawToInt.error", 1, {
      error_code: error.code,
    });
    throw error;
  }

  recordMetric(telemetry, "decimal_utils.sharesRawToInt.success", 1, {
    has_correlation_id: correlationId ? "true" : "false",
  });
  recordMetric(telemetry, "decimal_utils.sharesRawToInt.duration_ms", performance.now() - startTime, {
    has_correlationId: correlationId ? "true" : "false",
  });

  return Number(value);
}