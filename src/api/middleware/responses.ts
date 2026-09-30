import { randomUUID } from "crypto";
import type { FastifyReply } from "fastify";
import { createErrorEnvelope } from "../../../packages/shared/src/errors.js";
import type { ErrorEnvelope } from "../../../packages/shared/src/errors.js";

/**
 * @deprecated Use `ErrorEnvelope` from `../../types/errors.js` instead. This
 * alias is the pre-envelope shape (`{ error, code, statusCode }`) and lacks the
 * `message` and `requestId` fields the standard now requires.
 */
export interface AuthErrorResponse {
  error: string;
  code: string;
  statusCode: number;
}

/** @deprecated Use `ErrorEnvelope` instead — see `AuthErrorResponse`. */
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

/**
 * Sends the standard API error envelope (#1124).
 *
 * Every error response — whether thrown and mapped by `errorHandler` or sent
 * directly by an authz/dependency guard — must have the same shape, so a client
 * can parse failures with one code path:
 *
 * ```json
 * {
 *   "code": "UNAUTHORIZED",
 *   "message": "Unauthorized",
 *   "error": "Unauthorized",
 *   "statusCode": 401,
 *   "requestId": "<correlation id>"
 * }
 * ```
 *
 * `requestId` is taken from the request (the same id echoed on the
 * `x-request-id` header and in the structured logs), so an authz denial is
 * traceable the same way a thrown error is. `error` mirrors `message` for
 * backwards compatibility with clients written against the older shape.
 */
function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string
): void {
  const body: ErrorEnvelope = createErrorEnvelope({
    code,
    message,
    statusCode,
    // Fall back to a generated id only for a reply not bound to a request, so
    // the field is never absent — a client must always be able to quote it.
    requestId: reply.request?.id ?? randomUUID(),
  });
  reply.status(statusCode).send(body);
}

export function unauthorized(
  reply: FastifyReply,
  message = "Unauthorized"
): void {
  sendError(reply, 401, "UNAUTHORIZED", message);
}

export function forbidden(reply: FastifyReply, message = "Forbidden"): void {
  sendError(reply, 403, "FORBIDDEN", message);
}

export function matchingUnavailable(
  reply: FastifyReply,
  message = "This instance does not currently hold the matching leader lease"
): void {
  sendError(reply, 503, "MATCHING_UNAVAILABLE", message);
}

export function serviceUnavailable(
  reply: FastifyReply,
  message = "Service temporarily unavailable"
): void {
  sendError(reply, 503, "SERVICE_UNAVAILABLE", message);
}
