# Indexer Decimal Utils Precision — Design Note & Invariants

## References
- `apps/indexer/src/decimalUtils.ts`
- `apps/indexer/src/decimalUtils.test.ts`
- `apps/indexer/src/collateralDepositedParser.ts`
- `apps/indexer/src/batchWriter.ts`

---

## Overview

This document specifies the technical design, precision invariants, error handling, telemetry, and security policies for decimal and quantity utilities in `apps/indexer/src/decimalUtils.ts`.

## Precision Invariants

1. **Collateral Scale (7 Decimals)**:
   - On-chain collateral amounts are `i128` integers with 7 implicit decimal places (`COLLATERAL_SCALE = 7n`, divisor `10_000_000n`).
   - `amountRawToDecimal` converts raw bigint/string amounts to Prisma `Decimal(20, 8)` columns (`lockedCollateral`, `collateralReleased`) using integer arithmetic (division and remainder) to eliminate floating-point rounding errors.
   - `decimalToAmountRaw` acts as the precise inverse, ensuring round-trip losslessness and rejecting decimals carrying more than 7 fractional digits (which would otherwise silently truncate on-chain).

2. **Share Quantities**:
   - On-chain share quantities are discrete, whole units (not fixed-point scaled).
   - `sharesRawToInt` converts raw bigint/string quantities to validated JavaScript safe integers (`Number`).
   - Enforces `0 <= quantity <= Number.MAX_SAFE_INTEGER`, rejecting negative quantities, non-integer strings, and values exceeding `MAX_SAFE_INTEGER` to prevent silent precision loss or integer overflow.

3. **Fail-Closed Security & Stable Error Codes**:
   - All conversion functions validate inputs strictly and throw custom subclasses of `DecimalUtilsError` bearing stable error codes (`DECIMAL_VALUE_OUT_OF_RANGE`, `DECIMAL_INVALID_INTEGER_STRING`, `DECIMAL_EXCESS_FRACTIONAL_DIGITS`, `DECIMAL_NEGATIVE_QUANTITY`, `DECIMAL_QUANTITY_EXCEEDS_SAFE_INTEGER`, `DECIMAL_FEATURE_DISABLED`).
   - Supports request correlation IDs for end-to-end auditability and log correlation.

4. **Ops-Safe Metrics & Telemetry**:
   - Success, duration, and error metrics are emitted via the `Telemetry` interface without leaking sensitive inputs or secrets.

5. **Kill-Switch & Feature Flagging**:
   - Each conversion entrypoint is gated by `DecimalUtilsFeatureFlags`, allowing operators to instantly disable specific money-path conversion vectors (fail-closed) in case of an anomaly or migration emergency.
