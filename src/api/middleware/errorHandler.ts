// Error handler middleware for Fastify

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ContractError,
  MatchingUnavailableError,
  ServiceUnavailableError,
} from "./errors.js";
import type { ErrorResponse } from "../../types/errors.js";
import { createErrorEnvelope } from "../../../packages/shared/src/errors.js";
import { config } from "../../config.js";

function resolveCode(error: Error, statusCode: number): string {
  if (error instanceof ValidationError) return "VALIDATION_ERROR";
  if (error instanceof NotFoundError) return "NOT_FOUND";
  if (error instanceof UnauthorizedError) return "UNAUTHORIZED";
  if (error instanceof ForbiddenError) return "FORBIDDEN";
  if (error instanceof MatchingUnavailableError) return "MATCHING_UNAVAILABLE";
  if (error instanceof ServiceUnavailableError) return "SERVICE_UNAVAILABLE";
  if (error instanceof ContractError || error.name === "ContractError") return "CONTRACT_ERROR";
  if (error instanceof AppError) return error.code;
  if (statusCode >= 500) return "INTERNAL_ERROR";
  return "BAD_REQUEST";
}

// Centralized error handler for Fastify
// Catches all unhandled errors and returns consistent error responses
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Determine status code
  let statusCode = 500;
  if ("statusCode" in error && typeof error.statusCode === "number") {
    statusCode = error.statusCode;
  } else if (error instanceof ContractError || error.name === "ContractError") {
    statusCode = 400;
  }

  // Determine if it's a client error (4xx) or server error (5xx)
  const isClientError = statusCode >= 400 && statusCode < 500;
  const isServerError = statusCode >= 500;

  // Get request ID for tracking
  const requestId = request.id;

  // Log error with appropriate level
  const logContext = {
    requestId,
    method: request.method,
    url: request.url,
    statusCode,
    error: error.message,
  };

  if (isClientError) {
    // Client errors are expected (bad input, not found, etc.)
    request.log.warn(logContext, "Client error");
  } else if (isServerError) {
    // Server errors are unexpected and need investigation
    request.log.error(
      {
        ...logContext,
        stack: error.stack,
      },
      "Server error"
    );
  }

  // Build error response
  let errorMessage = error.message;

  // hide internal error details in prod
  if (process.env.NODE_ENV === "production" && isServerError) {
    errorMessage = "Internal server error";
  }

  const response: ErrorResponse = createErrorEnvelope({
    message: errorMessage,
    code: resolveCode(error, statusCode),
    requestId,
    statusCode,
    fields:
      error instanceof ValidationError && error.fields
        ? error.fields
        : undefined,
  });

  // Send error response
  reply.status(statusCode).send(response);
}
