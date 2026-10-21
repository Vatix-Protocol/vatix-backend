import { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError, ContractError } from "./errors.js";
import {
  MarketTransitionError,
  MARKET_INVALID_TRANSITION_CODE,
} from "@vatix/shared/marketLifecycle.js";

interface ErrorResponse {
  error: string;
  code: string;
  requestId: string;
  statusCode: number;
  fields?: Record<string, string>;
}

function resolveStatusCode(error: FastifyError | Error): number {
  if (error instanceof MarketTransitionError) {
    return 409;
  }
  if (error instanceof ContractError) {
    return 400;
  }
  if (error instanceof AppError) {
    return error.statusCode;
  }
  const statusCode = (error as FastifyError).statusCode;
  if (typeof statusCode === "number") {
    return statusCode;
  }
  return 500;
}

function resolveCode(error: FastifyError | Error): string {
  if (error instanceof MarketTransitionError) {
    return MARKET_INVALID_TRANSITION_CODE;
  }
  if (error instanceof AppError) {
    return error.code;
  }
  const code = (error as FastifyError).code;
  if (typeof code === "string" && code.length > 0) {
    return code;
  }
  return "INTERNAL_ERROR";
}

/**
 * Whether error.message is authored by the API layer and safe to expose to
 * clients. Only AppError subclasses (and explicitly handled classes) qualify;
 * arbitrary upstream messages (Prisma, Stellar SDK, etc.) must not leak.
 */
function isSafeToExpose(error: FastifyError | Error): boolean {
  return error instanceof AppError || error instanceof MarketTransitionError;
}

export async function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const statusCode = resolveStatusCode(error);
  const code = resolveCode(error);
  const isClientError = statusCode >= 400 && statusCode < 500;

  const logPayload = {
    err: error,
    reqId: request.id,
    statusCode,
    code,
  };

  if (isClientError) {
    request.log.warn(logPayload, error.message);
  } else {
    request.log.error(logPayload, error.message);
  }

  const isProduction = process.env.NODE_ENV === "production";
  const message =
    isProduction && !isSafeToExpose(error)
      ? isClientError
        ? "Invalid request"
        : "Internal server error"
      : error.message;

  const body: ErrorResponse = {
    error: message,
    code,
    requestId: request.id,
    statusCode,
  };

  if (error instanceof AppError && error.metadata) {
    body.fields = error.metadata;
  }

  reply.status(statusCode).send(body);
}
