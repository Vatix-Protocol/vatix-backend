/**
 * Oracle health routes (#1116)
 *
 *
 * Two distinct probes, deliberately separated (see docs/health-probes.md):
 *
 *   - `GET /health`       — liveness. Always 200 while the process is running
 *                           and the HTTP server is up. It touches **no**
 *                           dependency, so a DB/Redis blip never makes an
 *                           orchestrator restart a healthy oracle (restarting
 *                           mid-poll can drop an in-flight resolution).
 *   - `GET /health/ready` — readiness. Runs the critical-dependency checks
 *                           (Postgres + Redis — the oracle's only durable and
 *                           queue transports) and returns **503**
 *                           (`DEPENDENCY_UNAVAILABLE`) when any is unavailable,
 *                           so automation is withheld until they recover.
 *                           Fail-closed: a not-ready oracle must not be treated
 *                           as able to enqueue or submit.
 *
 * Security posture:
 *   - Probe output is a fixed shape of `"ok" | "unavailable"` only. Dependency
 *     error messages, connection strings, hostnames and credentials are never
 *     returned or logged — probes are unauthenticated by convention, so they
 *     must never leak internals.
 *   - Every response carries a correlation id (echoed from `x-correlation-id`
 *     when present) so a probe hit can be stitched to logs.
 *   - Each dependency check is bounded by a timeout, so a hung database cannot
 *     hang the probe (and with it the orchestrator's health checks).
 *   - When `ORACLE_HEALTH_TOKEN` is set, `/health/ready` requires a matching
 *     `x-health-token` header (constant-time compare) and answers 401
 *     `UNAUTHORIZED` otherwise — deny-by-default for the privileged surface.
 *     Liveness stays open so kubelet can always reach it.
 *
 * @module apps/oracle/routes/health
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "crypto";

/** Stable error codes for probe responses (#1116). */
export const ORACLE_HEALTH_ERROR_CODES = {
  /** At least one critical dependency is unavailable. */
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  /** A required probe token was missing or wrong. */
  UNAUTHORIZED: "UNAUTHORIZED",
} as const;

export type OracleHealthErrorCode =
  (typeof ORACLE_HEALTH_ERROR_CODES)[keyof typeof ORACLE_HEALTH_ERROR_CODES];

/** Per-dependency probe outcome. Deliberately coarse — never a reason string. */
export type DependencyStatus = "ok" | "unavailable";

/** Minimal logger surface; keeps this module free of a logging dependency. */
export interface HealthLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

/** A single critical dependency probe. Resolves when reachable, rejects otherwise. */
export interface DependencyProbe {
  /** Stable, non-sensitive identifier, e.g. "database" or "redis". */
  name: string;
  check: () => Promise<unknown>;
}

/** Liveness payload. Contains no dependency or secret material. */
export interface HealthResponse {
  status: "ok";
  service: string;
  uptime: number;
  timestamp: string;
  correlationId: string;
}

/** Readiness payload. */
export interface ReadinessResponse {
  status: "ok" | "degraded";
  service: string;
  timestamp: string;
  correlationId: string;
  dependencies: Record<string, DependencyStatus>;
  code?: OracleHealthErrorCode;
}
/**
 * Options for {@link healthRoutes}. Every dependency is injectable so the
 * routes are testable without a live Postgres/Redis, and so a deployment can
 * substitute a different client.
 */
export interface HealthRoutesOptions {
  /** Probes run on readiness. Defaults to Postgres + Redis. */
  probes?: DependencyProbe[];
  /** Per-probe timeout in milliseconds. Defaults to 2000. */
  probeTimeoutMs?: number;
  /** Service name reported in the payload. Defaults to `vatix-oracle`. */
  serviceName?: string;
  /** Optional shared secret required on `/health/ready` (see module docs). */
  requiredToken?: string;
  /** Optional structured logger. */
  logger?: HealthLogger;
}

/** Default per-probe timeout — a probe must never hang the health server. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/** Default service name. */
export const DEFAULT_ORACLE_SERVICE_NAME = "vatix-oracle";

/** Resolves the correlation id for a probe request. */
function correlationIdFor(request: FastifyRequest): string {
  const header = request.headers["x-correlation-id"];
  return typeof header === "string" && header.length > 0
    ? header
    : String(request.id);
}

/** Constant-time token comparison that never throws on length mismatch. */
export function tokensMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Default critical dependencies: Postgres (durable reports) and Redis (queue).
 *
 * The clients are imported lazily so this module has no import-time
 * side effects (no config parsing, no connection) and stays unit-testable
 * without a live environment.
 */
export function defaultDependencyProbes(): DependencyProbe[] {
  return [
    {
      name: "database",
      check: async () => {
        const { getPrismaClient } =
          await import("../../../src/services/prisma.js");
        const prisma = getPrismaClient();
        await prisma.$queryRaw`SELECT 1`;
      },
    },
    {
      name: "redis",
      check: async () => {
        const { redis } = await import("../../../src/services/redis.js");
        await redis.ping();
      },
    },
  ];
}

/**
 * Run every probe concurrently under a per-probe timeout and fail closed: any
 * rejection, thrown error or timeout marks the dependency `"unavailable"`.
 * The underlying error is never surfaced (it can embed connection strings) —
 * only a warn-level log with the dependency name and correlation id.
 */
export async function runDependencyProbes(
  probes: DependencyProbe[],
  timeoutMs: number,
  correlationId: string,
  logger?: HealthLogger
): Promise<Record<string, DependencyStatus>> {
  const results: Record<string, DependencyStatus> = {};

  await Promise.all(
    probes.map(async ({ name, check }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          check(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("probe timeout")),
              timeoutMs
            );
          }),
        ]);
        results[name] = "ok";
      } catch {
        results[name] = "unavailable";
        logger?.warn(
          { correlationId, dependency: name },
          "Oracle readiness dependency unavailable"
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    })
  );

  return results;
}

export async function healthRoutes(
  fastify: FastifyInstance,
  options: HealthRoutesOptions = {}
) {
  const probes = options.probes ?? defaultDependencyProbes();
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const serviceName = options.serviceName ?? DEFAULT_ORACLE_SERVICE_NAME;
  const { requiredToken, logger } = options;

  // Liveness: no dependency access, always 200.
  fastify.get<{ Reply: HealthResponse }>("/health", async (request, reply) => {
    const correlationId = correlationIdFor(request);
    logger?.info({ correlationId, route: "/health" }, "Oracle liveness ok");

    return reply.status(200).send({
      status: "ok" as const,
      service: serviceName,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      correlationId,
    });
  });

  // Readiness: fail closed with 503 when any critical dependency is down.
  fastify.get<{ Reply: ReadinessResponse }>(
    "/health/ready",
    async (request, reply) => {
      const correlationId = correlationIdFor(request);

      if (requiredToken) {
        const provided = request.headers["x-health-token"];
        if (!tokensMatch(provided, requiredToken)) {
          logger?.warn(
            { correlationId, route: "/health/ready" },
            "Oracle readiness probe rejected: missing or invalid token"
          );
          return reply.status(401).send({
            status: "degraded" as const,
            service: serviceName,
            timestamp: new Date().toISOString(),
            correlationId,
            dependencies: {},
            code: ORACLE_HEALTH_ERROR_CODES.UNAUTHORIZED,
          });
        }
      }

      const dependencies = await runDependencyProbes(
        probes,
        probeTimeoutMs,
        correlationId,
        logger
      );
      const ready = Object.values(dependencies).every(
        (status) => status === "ok"
      );

      const log = ready ? logger?.info.bind(logger) : logger?.warn.bind(logger);
      log?.(
        { correlationId, route: "/health/ready", ready, dependencies },
        ready ? "Oracle readiness ok" : "Oracle readiness failed"
      );

      return reply.status(ready ? 200 : 503).send({
        status: ready ? ("ok" as const) : ("degraded" as const),
        service: serviceName,
        timestamp: new Date().toISOString(),
        correlationId,
        dependencies,
        ...(ready
          ? {}
          : { code: ORACLE_HEALTH_ERROR_CODES.DEPENDENCY_UNAVAILABLE }),
      });
    }
  );
}
