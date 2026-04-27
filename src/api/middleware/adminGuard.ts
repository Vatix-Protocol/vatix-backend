import type { FastifyRequest, FastifyReply } from "fastify";
import { unauthorized, forbidden } from "./responses.js";

// Minimal admin token auth: expects Authorization: Bearer <ADMIN_TOKEN>
// ADMIN_TOKEN is set via environment variable
export function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const adminToken = process.env.ADMIN_TOKEN;
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    unauthorized(reply);
    return;
  }

  const token = authHeader.slice(7);

  if (!adminToken || token !== adminToken) {
    forbidden(reply);
    return;
  }

  done();
}
