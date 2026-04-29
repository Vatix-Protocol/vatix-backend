import type { FastifyRequest, FastifyReply } from "fastify";
import { unauthorized } from "./responses.js";

const API_KEY_HEADER = "x-api-key";

/**
 * Validates the X-API-Key header against the API_KEY environment variable.
 * Missing or invalid keys return 401.
 *
 * To support key rotation in a future iteration, API_KEY may be extended to
 * a comma-separated list of valid keys.
 */
export function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const configuredKey = process.env.API_KEY;
  const providedKey = request.headers[API_KEY_HEADER];

  if (!providedKey || typeof providedKey !== "string") {
    unauthorized(reply, "Missing API key");
    return;
  }

  if (!configuredKey || providedKey !== configuredKey) {
    unauthorized(reply, "Invalid API key");
    return;
  }

  done();
}
