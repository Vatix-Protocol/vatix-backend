import type { FastifyReply } from "fastify";

export interface AuthErrorResponse {
  error: string;
  code: string;
  statusCode: number;
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
}

export function success<T>(reply: FastifyReply, data: T, statusCode = 200): void {
  const body: SuccessResponse<T> = {
    success: true,
    data,
  };
  reply.status(statusCode).send(body);
}

export function unauthorized(reply: FastifyReply, message = "Unauthorized"): void {
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
