import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { FastifyCorsOptions } from "@fastify/cors";
import { loadBaseConfig } from "../../../../packages/shared/src/config.js";
import {
  resolveCorsAllowedOrigins,
  isOriginAllowed,
  type NodeEnv,
} from "../../../../packages/shared/src/cors.js";

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
 * Resolves indexer CORS origins using the same policy as the public API.
 */
export function getIndexerAllowedOrigins(
  nodeEnv: NodeEnv,
  rawCors?: string
): string[] {
  return resolveCorsAllowedOrigins(nodeEnv, rawCors);
}

/**
 * CORS plugin for indexer HTTP surfaces (read-only market routes).
 * Uses the shared origin policy so browser clients see consistent behaviour.
 *
 * Ops-safe: never logs the raw origin value (adversarial input) — only
 * a boolean allowed signal and a stable correlation id when available.
 */
export const indexerCorsPlugin = fp(async (fastify: FastifyInstance) => {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as NodeEnv;
  const allowedOrigins = getIndexerAllowedOrigins(
    nodeEnv,
    process.env.CORS_ALLOWED_ORIGINS
  );

  // Deny wildcard combined with credentials fail-closed:
  // Access-Control-Allow-Origin: * must NEVER be combined with Access-Control-Allow-Credentials: true.
  if (allowedOrigins.includes("*") || allowedOrigins.some((o) => o.includes("*"))) {
    throw new Error(
      "CORS misconfiguration: wildcard origin '*' cannot be combined with credentials: true"
    );
  }

  // Fail-closed in production: an empty allowlist means no cross-origin
  // browser request can succeed — which is the intended deny-by-default.
  if (nodeEnv === "production" && allowedOrigins.length === 0) {
    fastify.log.warn(
      "CORS deny-by-default active in production — no origins allowed; " +
        "set CORS_ALLOWED_ORIGINS to explicitly permit browser clients"
    );
  }

  const corsConfig: CorsConfig = {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      // Explicitly reject wildcard origin requests when credentials are true
      if (origin === "*" || origin.includes("*")) {
        fastify.log.warn(
          { originAllowed: false, reason: "WILDCARD_WITH_CREDENTIALS" },
          "CORS wildcard origin denied when credentials are enabled"
        );
        callback(
          new Error("Wildcard origin '*' is not allowed when credentials are enabled"),
          false
        );
        return;
      }

      const allowed = isOriginAllowed(origin, allowedOrigins);
      if (allowed) {
        fastify.log.debug(
          { originAllowed: true },
          "CORS origin allowed (origin value redacted)"
        );
        callback(null, true);
      } else {
        fastify.log.warn(
          { originAllowed: false },
          "CORS origin rejected (origin value redacted)"
        );
        callback(new Error("Origin not allowed by CORS policy"), false);
      }
    },
    methods: ["GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
    credentials: true,
    preflight: true,
    strictPreflight: false,
  };

  await fastify.register(cors, corsConfig);
});

/** Verifies indexer CORS policy matches loadBaseConfig() for the same env. */
export function verifyIndexerCorsMatchesBaseConfig(
  env: Record<string, string | undefined>
) {
  const base = loadBaseConfig(env);
  const nodeEnv = (env.NODE_ENV ?? "development") as NodeEnv;
  const indexerOrigins = getIndexerAllowedOrigins(
    nodeEnv,
    env.CORS_ALLOWED_ORIGINS
  );
  return {
    matches: indexerOrigins.join() === base.corsAllowedOrigins.join(),
    indexerOrigins,
    apiOrigins: base.corsAllowedOrigins,
  };
}
