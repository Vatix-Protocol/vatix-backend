import type { FastifyRequest, FastifyReply } from "fastify";
import { createHash, timingSafeEqual } from "crypto";
import { unauthorized } from "./responses.js";

const API_KEY_HEADER = "x-api-key";

/**
 * Validates the X-API-Key header against configured keys using constant-time comparison.
 * Supports multiple concurrent keys for zero-downtime rotation via API_KEY env var.
 *
 * Format: comma-separated list of valid keys (e.g., "current-key:rotation-old-key")
 * Only the first key (before ':') is the current key; keys after ':' are valid during rotation.
 *
 * Missing or invalid keys return 401. Comparison uses crypto.timingSafeEqual to prevent
 * timing attacks.
 */
function timingSafeCompare(a: string, b: string): boolean {
  // Hash both inputs to fixed-length SHA-256 digests before the constant-time
  // comparison. A raw length check would short-circuit timingSafeEqual for
  // inputs of different lengths and leak key-length information via timing.
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

export function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const configuredKeys = process.env.API_KEY;
  const providedKey = request.headers[API_KEY_HEADER];

  if (!providedKey || typeof providedKey !== "string") {
    unauthorized(reply, "Missing API key");
    return;
  }

  if (!configuredKeys) {
    unauthorized(reply, "Invalid API key");
    return;
  }

  // Support multiple keys: split by ':' to allow old+new keys during rotation
  const validKeys = configuredKeys.split(":");

  let isValid = false;
  for (const validKey of validKeys) {
    if (timingSafeCompare(providedKey, validKey.trim())) {
      isValid = true;
      break;
    }
  }

  if (!isValid) {
    unauthorized(reply, "Invalid API key");
    return;
  }

  done();
}
