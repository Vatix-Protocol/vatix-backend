import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { FastifyCorsOptions } from "@fastify/cors";
import { resolveCorsAllowedOrigins } from "../../../packages/shared/src/cors.js";
import type { NodeEnv } from "../../../packages/shared/src/cors.js";

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

function getAllowedOrigins(): string[] {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as NodeEnv;
  // resolveCorsAllowedOrigins throws in production if any origin is not https://
  const origins = resolveCorsAllowedOrigins(nodeEnv, process.env.CORS_ALLOWED_ORIGINS);

  // Fail-fast in production: credentials=true with an empty allowlist would
  // mean no browser can ever make a credentialed cross-origin request — which
  // is almost certainly a misconfiguration rather than intentional lockdown.
  // Operators must explicitly set CORS_ALLOWED_ORIGINS in production.
  if (nodeEnv === "production" && origins.length === 0) {
    throw new Error(
      "CORS misconfiguration: CORS_ALLOWED_ORIGINS must be set in production " +
        "when credentials are enabled. Set it to your frontend origin(s), e.g.: " +
        "CORS_ALLOWED_ORIGINS=https://app.vatix.io"
    );
  }

  return origins;
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
