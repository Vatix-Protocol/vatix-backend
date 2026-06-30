import type { FastifyRequest, FastifyReply } from "fastify";
import { unauthorized, forbidden } from "./responses.js";

const Roles = { ADMIN: "admin" } as const;

// Enforces the ADMIN role. Expects Authorization: Bearer <ADMIN_TOKEN>.
// ADMIN_TOKEN is set via environment variable.
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
    forbidden(reply, `Role '${Roles.ADMIN}' required`);
    return;
  }

  done();
}
