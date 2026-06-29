import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { FastifyCorsOptions } from "@fastify/cors";

export interface CorsOriginConfig {
  origin: NonNullable<FastifyCorsOptions["origin"]>;
}

export interface CorsConfig {
  origin: CorsOriginConfig["origin"];
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders?: string[];
  credentials: boolean;
  preflight: boolean;
  strictPreflight: boolean;
}

/**
 * CORS configuration.
 *
 * Allowed origins are driven by the CORS_ALLOWED_ORIGINS environment variable
 * (comma-separated list). Falls back to a restrictive default that only permits
 * the same origin in production and localhost:3000 in development/test.
 *
 * Examples:
 *   CORS_ALLOWED_ORIGINS=https://app.vatix.io,https://staging.vatix.io
 *
 * In production, every configured origin MUST use the https:// scheme.
 * HTTP origins in production are rejected at startup to prevent accidental
 * mixed-content or insecure cross-origin access.
 */
function getAllowedOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  const isProduction = process.env.NODE_ENV === "production";

  if (raw && raw.trim() !== "") {
    const origins = raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);

    if (isProduction) {
      const insecure = origins.filter((o) => !o.startsWith("https://"));
      if (insecure.length > 0) {
        throw new Error(
          `CORS misconfiguration: all origins must use https:// in production. ` +
            `Insecure origin(s): ${insecure.join(", ")}`
        );
      }
    }

    return origins;
  }

  // Restrictive defaults
  if (isProduction) {
    return []; // No cross-origin access unless explicitly configured
  }

  return ["http://localhost:3000", "http://localhost:5173"];
}

export const corsPlugin = fp(async (fastify: FastifyInstance) => {
  const allowedOrigins = getAllowedOrigins();

  const corsConfig: CorsConfig = {
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
  };

  await fastify.register(cors, corsConfig);
});
