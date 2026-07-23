// Global error handler middleware for Fastify
// Single source of truth for all error normalization and logging

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
} from "./errors.js";
import type { ErrorResponse } from "../../types/errors.js";
import { config } from "../../config.js";

function isProduction(): boolean {
  return config.nodeEnv === "production";
}

// Centralized error handler for Fastify
// Catches all unhandled errors and returns consistent error responses
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;

  const isClientError = statusCode >= 400 && statusCode < 500;
  const isServerError = statusCode >= 500;

  // requestId is auto-bound via requestIdLogLabel — no need to repeat it here.
  const logContext = {
    method: request.method,
    path: request.url,
    statusCode,
    message: error.message,
    // Always include stack in logs for server errors regardless of environment
    ...(isServerError && { stack: error.stack }),
  };

  if (isClientError) {
    request.log.warn(logContext, "Client request error");
  } else if (isServerError) {
    request.log.error(logContext, "Unhandled request error");
  }

  // Build error response — hide internals in production
  let errorMessage = error.message;
  if (isProduction() && isServerError) {
    errorMessage = "Internal server error";
  }

  const envelope: ErrorResponse = {
    code:
      error instanceof AppError
        ? error.code
        : statusCode >= 500
          ? "internal_error"
          : String(statusCode),
    message: errorMessage,
    error: errorMessage,
    requestId: request.id,
    statusCode,
    // Include stack trace in response body only outside production
    ...(!isProduction() && isServerError && { stack: error.stack }),
  };

  // Attach field-level details as metadata for ValidationError
  if (error instanceof ValidationError && error.fields) {
    (envelope as ErrorResponse & { metadata?: unknown }).metadata = {
      fields: error.fields,
    };
  }

  reply.status(statusCode).send(envelope);
}
