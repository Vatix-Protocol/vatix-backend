import { randomUUID } from "crypto";
import type { FastifyReply } from "fastify";

export interface AuthErrorResponse {
  error: string;
  code: string;
  statusCode: number;
}

/**
 * Standard success response envelope for all API endpoints.
 *
 * @template T - The type of the response payload
 *
 * @property success   - Always `true`; signals a successful response
 * @property data      - The response payload
 * @property requestId - UUID v4 generated per-request for traceability
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
    requestId: randomUUID(),
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
