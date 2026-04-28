import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ValidationError, AppError } from "./errors.js";
import type { ErrorEnvelope } from "../../types/errors.js";

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
  };

  if (isClientError) {
    request.log.warn(logContext, "Client error");
  } else if (isServerError) {
    request.log.error({ ...logContext, stack: error.stack }, "Server error");
  }

  // Derive stable code: prefer AppError.code, fall back to Fastify's error code,
  // then a generic sentinel.
  let code =
    error instanceof AppError
      ? error.code
      : ("code" in error && typeof error.code === "string" && error.code) ||
        "internal_error";

  // Human-readable message — scrub internals in production
  let message = error.message;
  if (isServerError && process.env.NODE_ENV === "production") {
    message = "An unexpected error occurred. Please try again later.";
    code = "internal_error";
  }

  const envelope: ErrorEnvelope = {
    code,
    message,
    statusCode,
    requestId: request.id,
  };

  // Attach field-level details as metadata for ValidationError
  if (error instanceof ValidationError && error.fields) {
    envelope.metadata = { fields: error.fields };
  }

  reply.status(statusCode).send(envelope);
}
