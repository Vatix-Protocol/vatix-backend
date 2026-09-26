/**
 * Oracle health server (#1116)
 *
 * A minimal, opt-in HTTP surface that exposes the oracle's liveness and
 * readiness probes (`apps/oracle/routes/health.ts`) so an orchestrator can
 * observe the oracle. Deny-by-default: the server does **not** start unless
 * `ORACLE_HEALTH_PORT` is set, so no new external surface appears by accident.
 * When `NODE_ENV=production`, a non-loopback bind address requires
 * `ORACLE_HEALTH_TOKEN` — otherwise the probe surface would be unauthenticated
 * on a routable network.
 *
 * The server exposes nothing but probes: no config, no keys, no queue dumps.
 *
 * @module apps/oracle/health-server
 */

import fastify, { type FastifyInstance } from "fastify";
import { healthRoutes, type HealthRoutesOptions } from "./routes/health.js";

/** Default per-probe timeout for the standalone health server. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/** Whether a bind address only accepts local connections. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Resolve the health-server bind options from the environment, or `null` when
 * the feature is disabled (no `ORACLE_HEALTH_PORT`).
 *
 * @throws {Error} when the port is not a valid TCP port, or when production
 *   would bind a routable address without a token.
 */
export function resolveHealthServerOptions(
  env: Record<string, string | undefined> = process.env
): { host: string; port: number; requiredToken?: string } | null {
  const rawPort = env.ORACLE_HEALTH_PORT?.trim();
  if (!rawPort) {
    return null; // Opt-in only — no accidental new external surface.
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `ORACLE_HEALTH_PORT must be an integer between 1 and 65535, got: ${JSON.stringify(rawPort)}`
    );
  }

  const host = env.ORACLE_HEALTH_HOST?.trim() || "127.0.0.1";
  const requiredToken = env.ORACLE_HEALTH_TOKEN?.trim() || undefined;

  if (
    env.NODE_ENV === "production" &&
    !isLoopbackHost(host) &&
    !requiredToken
  ) {
    throw new Error(
      "Refusing to expose the oracle health server on a non-loopback address in production without ORACLE_HEALTH_TOKEN. Bind to 127.0.0.1 or set a token."
    );
  }

  return { host, port, ...(requiredToken ? { requiredToken } : {}) };
}

/** Build (but do not listen on) the oracle health server. */
export async function buildHealthServer(
  options: HealthRoutesOptions = {}
): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  await app.register(healthRoutes, {
    probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    ...options,
  });
  return app;
}

export interface StartedHealthServer {
  app: FastifyInstance;
  close: () => Promise<void>;
}

/**
 * Start the health server if `ORACLE_HEALTH_PORT` is configured, otherwise
 * return `undefined` (feature disabled). Never throws for a disabled server,
 * so a deployment without probes behaves exactly as before.
 */
export async function startHealthServer(
  options: HealthRoutesOptions = {},
  env: Record<string, string | undefined> = process.env
): Promise<StartedHealthServer | undefined> {
  const resolved = resolveHealthServerOptions(env);
  if (!resolved) {
    return undefined;
  }

  const app = await buildHealthServer({
    ...options,
    requiredToken: options.requiredToken ?? resolved.requiredToken,
  });

  await app.listen({ host: resolved.host, port: resolved.port });

  return {
    app,
    close: async () => {
      await app.close();
    },
  };
}
