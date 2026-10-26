// Custom error classes for Vatix Backend
// Each class carries a stable `code` used in the API error envelope.

import { MARKET_INVALID_TRANSITION_CODE } from "@vatix/shared/marketLifecycle.js";

export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  fields?: Record<string, string>;

  constructor(message: string, fields?: Record<string, string>) {
    super(message, 400, "validation_error");
    this.fields = fields;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(message, 404, "not_found");
  }
}

export class MarketNotFoundError extends AppError {
  constructor(marketId: string) {
    super(`Market with ID ${marketId} not found`, 404, "market_not_found");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized") {
    super(message, 401, "unauthorized");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403, "forbidden");
  }
}

export class PreconditionFailedError extends AppError {
  constructor(
    message = "Precondition failed: resource has been modified since the supplied ETag"
  ) {
    super(message, 412, "precondition_failed");
  }
}

export class InvalidMarketTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(
      `Illegal market transition ${from} -> ${to}`,
      409,
      MARKET_INVALID_TRANSITION_CODE
    );
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable") {
    super(message, 503, "service_unavailable");
  }
}

export class OrderConflictError extends AppError {
  constructor(message = "Order was concurrently modified; please retry") {
    super(message, 409, "order_conflict");
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(
    message = "Idempotency-Key was already used with a different request payload"
  ) {
    super(message, 409, "IDEMPOTENCY_CONFLICT");
  }
}

export class MatchingUnavailableError extends AppError {
  constructor(
    message = "This instance does not currently hold the matching leader lease"
  ) {
    super(message, 503, "matching_unavailable");
  }
}

export class MarketNotActiveError extends AppError {
  constructor(marketId: string, status: string) {
    super(
      `Market ${marketId} is ${status.toLowerCase()}, orders cannot be placed`,
      409,
      "market_not_active"
    );
  }
}

export class MarketExpiredError extends AppError {
  constructor(marketId: string, endTime: Date) {
    super(
      `Market ${marketId} ended at ${endTime.toISOString()}; new orders and matches are rejected`,
      409,
      "market_expired"
    );
  }
}

export class ContractError extends AppError {
  constructor(
    message = "Contract execution failed",
    statusCode = 400,
    code = "contract_error"
  ) {
    super(message, statusCode, code);
  }
}

/**
 * Returns true when `error.message` is authored by the API layer and therefore
 * safe to expose to clients. Only AppError subclasses (ValidationError,
 * NotFoundError, UnauthorizedError, ForbiddenError, MatchingUnavailableError,
 * ServiceUnavailableError, etc.) qualify; arbitrary upstream errors (Prisma,
 * Stellar SDK, ContractError built from upstream text) must not leak.
 */
export function isClientSafeErrorMessage(error: unknown): boolean {
  return error instanceof AppError;
}
