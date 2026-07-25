import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { FastifyCorsOptions } from "@fastify/cors";
import { loadBaseConfig } from "../../../../packages/shared/src/config.js";
import {
  resolveCorsAllowedOrigins,
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
 */
export const indexerCorsPlugin = fp(async (fastify: FastifyInstance) => {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as NodeEnv;
  const allowedOrigins = getIndexerAllowedOrigins(
    nodeEnv,
    process.env.CORS_ALLOWED_ORIGINS
  );

  const corsConfig: CorsConfig = {
    origin: (origin, callback) => {
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
