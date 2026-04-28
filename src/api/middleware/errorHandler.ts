// Global error handler middleware for Fastify
// Single source of truth for all error normalization and logging

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "./errors.js";
import { ErrorResponse } from "../../types/errors.js";

const isProduction = () => process.env.NODE_ENV === "production";

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

  const response: ErrorResponse = {
    error: errorMessage,
    requestId,
    statusCode,
    // Include stack trace in response body only outside production
    ...(!isProduction() && isServerError && { stack: error.stack }),
  };

  // Add field details for ValidationError
  if (error instanceof ValidationError && error.fields) {
    response.fields = error.fields;
  }

  reply.status(statusCode).send(response);
}
