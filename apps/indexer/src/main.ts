import { validateEnv, EnvValidationError } from "./env.js";
import { buildIndexerHttpServer } from "./httpServer.js";
import { createLogger } from "./logger.js";

/**
 * Fail-closed env validation error. Carries a stable error code and the
 * offending variable name only — never the value — so it is safe to log.
 */

async function main(): Promise<void> {
  try {
    validateEnv(process.env);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Fail-closed: log only variable names and stable error codes, never values.
      for (const issue of err.issues) {
        console.error(`[env] ${issue.code} ${issue.name}`);
      }
      console.error("[env] refusing to boot: invalid configuration");
      process.exit(1);
    }
    throw err;
  }

  // Boot proceeds only with a fully validated, fail-closed configuration.
  await start();
}

async function start(): Promise<void> {
  const enabled = process.env.INDEXER_HTTP_ENABLED === "true";
  if (!enabled) {
    console.info("[http] indexer HTTP surface disabled (INDEXER_HTTP_ENABLED is not true)");
    return;
  }

  const logger = createLogger((process.env.LOG_LEVEL as any) ?? "info");

  // Warn if neither INDEXER_REQUIRED_PRINCIPAL nor INDEXER_API_KEY is configured.
  // Without an authz gate the HTTP surface is reachable by any origin that passes
  // CORS, which is a security gap for production deployments.
  if (!process.env.INDEXER_REQUIRED_PRINCIPAL && !process.env.INDEXER_API_KEY) {
    logger.warn(
      {},
      "indexer HTTP surface has no authz gate configured — set INDEXER_REQUIRED_PRINCIPAL or INDEXER_API_KEY to restrict access",
    );
  }

  const app = await buildIndexerHttpServer({ logger });
  await app.ready();

  const port = Number(process.env.INDEXER_HTTP_PORT ?? 3001);
  const host = process.env.INDEXER_HTTP_HOST ?? "127.0.0.1";

  await app.listen({ port, host });
  logger.info({ port, host }, "indexer HTTP server listening");
}

main().catch((err) => {
  console.error("[boot] fatal error", err instanceof Error ? err.message : "unknown");
  process.exit(1);
});
