import { randomUUID } from "crypto";
import type { FastifyReply } from "fastify";

export interface AuthErrorResponse {
  error: string;
  code: string;
  statusCode: number;
}

export type ApiErrorResponse = AuthErrorResponse;

/**
 * Standard success response envelope for all API endpoints.
 *
 * @template T - The type of the response payload
 *
 * @property success   - Always `true`; signals a successful response
 * @property data      - The response payload
 * @property requestId - The correlation id for this request, taken from
 *   `reply.request.id` so it matches the `x-request-id` response header and
 *   the `requestId` field in every structured log line for the same request.
 *   A random UUID is only generated as a fallback for replies that are not
 *   bound to a request.
 * @property timestamp - ISO-8601 UTC timestamp of when the response was produced
 */
export interface SuccessResponse<T> {
  success: true;
  data: T;
  requestId: string;
  timestamp: string;
}

export function success<T>(
  reply: FastifyReply,
  data: T,
  statusCode = 200
): void {
  const body: SuccessResponse<T> = {
    success: true,
    data,
    // Echo the request id resolved by the requestId middleware. Minting a
    // fresh UUID here would give the body, the response header, and the
    // request logs three different correlation ids for the same request.
    requestId: reply.request?.id ?? randomUUID(),
    timestamp: new Date().toISOString(),
  };
  reply.status(statusCode).send(body);
}

export function unauthorized(
  reply: FastifyReply,
  message = "Unauthorized"
): void {
  const body: AuthErrorResponse = {
    error: message,
    code: "UNAUTHORIZED",
    statusCode: 401,
  };
  reply.status(401).send(body);
}

export function forbidden(reply: FastifyReply, message = "Forbidden"): void {
  const body: AuthErrorResponse = {
    error: message,
    code: "FORBIDDEN",
    statusCode: 403,
  };
  reply.status(403).send(body);
}

export function matchingUnavailable(
  reply: FastifyReply,
  message = "This instance does not currently hold the matching leader lease"
): void {
  const body: ApiErrorResponse = {
    error: message,
    code: "MATCHING_UNAVAILABLE",
    statusCode: 503,
  };
  reply.status(503).send(body);
}

export function serviceUnavailable(
  reply: FastifyReply,
  message = "Service temporarily unavailable"
): void {
  const body: ApiErrorResponse = {
    error: message,
    code: "SERVICE_UNAVAILABLE",
    statusCode: 503,
  };
  reply.status(503).send(body);
}
