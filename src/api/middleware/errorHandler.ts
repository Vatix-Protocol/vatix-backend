// Global error handler middleware for Fastify
// Single source of truth for all error normalization and logging

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ValidationError, AppError } from "./errors.js";
import type { ErrorEnvelope } from "../../types/errors.js";

const isProduction = () => process.env.NODE_ENV === "production";

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

  const logContext = {
    requestId: request.id,
    method: request.method,
    url: request.url,
    statusCode,
    error: error.message,
    // Always include stack in logs for server errors regardless of environment
    ...(isServerError && { stack: error.stack }),
  };

  if (isClientError) {
    request.log.warn(logContext, "Client error");
  } else if (isServerError) {
    request.log.error(logContext, "Server error");
  }

  // Build error response — hide internals in production
  let errorMessage = error.message;
  if (isProduction() && isServerError) {
    errorMessage = "Internal server error";
  }

  const envelope: ErrorEnvelope = {
    code:
      "statusCode" in error
        ? String((error as { code?: string }).code ?? statusCode)
        : String(statusCode),
    message: errorMessage,
    statusCode,
    // Include stack trace in response body only outside production
    ...(!isProduction() && isServerError && { stack: error.stack }),
  };

  // Attach field-level details as metadata for ValidationError
  if (error instanceof ValidationError && error.fields) {
    (envelope as ErrorEnvelope & { metadata?: unknown }).metadata = {
      fields: error.fields,
    };
  }

  reply.status(statusCode).send(envelope);
}
