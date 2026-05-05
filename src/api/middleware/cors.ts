import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

/**
 * CORS configuration.
 *
 * Allowed origins are driven by the CORS_ALLOWED_ORIGINS environment variable
 * (comma-separated list). Falls back to a restrictive default that only permits
 * the same origin in production and localhost:3000 in development/test.
 *
 * Examples:
 *   CORS_ALLOWED_ORIGINS=https://app.vatix.io,https://staging.vatix.io
 */
function getAllowedOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (raw && raw.trim() !== "") {
    return raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }

  // Restrictive defaults
  if (process.env.NODE_ENV === "production") {
    return []; // No cross-origin access unless explicitly configured
  }

  return ["http://localhost:3000", "http://localhost:5173"];
}

export const corsPlugin = fp(async (fastify: FastifyInstance) => {
  const allowedOrigins = getAllowedOrigins();

  await fastify.register(cors, {
    origin: (origin, callback) => {
      // Same-origin requests (no Origin header) are always allowed
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(
          new Error(`Origin '${origin}' not allowed by CORS policy`),
          false
        );
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
    credentials: true,
    preflight: true,
    strictPreflight: false,
  });
});
