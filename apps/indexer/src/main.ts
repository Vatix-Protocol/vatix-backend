import { validateEnv, EnvValidationError } from "./env";
import {
  checkStartupHealth,
  checkLiveDependencies,
} from "./startupHealth";
import { buildIndexerHttpServer } from "./httpServer";
import type { DependencyProbe } from "./startupHealth";

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
  const env = process.env;

  // Feature flag: the indexer's HTTP server is opt-in so the default
  // off-chain event-ingestion role stays HTTP-free.  When disabled the
  // process runs headless (polling only) and the kill-switch is a
  // single env var flip — no code change, no redeploy.
  const httpEnabled = env.INDEXER_HTTP_ENABLED === "true";
  if (!httpEnabled) {
    console.log("[boot] INDEXER_HTTP_ENABLED not set; skipping HTTP server");
    return;
  }

  // Startup health gate — fail-closed before the HTTP server binds.
  // Validates config shape (cursor, networkId, cursorKey, databaseUrl)
  // so the indexer never starts with a malformed cursor that would
  // poison the ingestion pipeline.
  const startupResult = checkStartupHealth({
    cursor: env.INDEXER_CURSOR ?? null,
    networkId: env.SOROBAN_NETWORK_PASSPHRASE ?? "",
    cursorKey: env.INDEXER_CURSOR_KEY ?? "ingestion",
    databaseUrl: env.DATABASE_URL,
  });

  if (!startupResult.valid) {
    for (const error of startupResult.errors) {
      console.error(`[startup-health] ${error}`);
    }
    console.error("[startup-health] refusing to boot: invalid configuration");
    process.exit(1);
  }

  // Optional live dependency probes (DB, Horizon/RPC) — only run in
  // production or when INDEXER_HTTP_FORCE_LIVE_CHECK=true so that
  // local dev and CI are not blocked by a missing DB.
  const forceLiveCheck = env.INDEXER_HTTP_FORCE_LIVE_CHECK === "true";
  const probes: DependencyProbe[] = [];

  if (env.DATABASE_URL) {
    probes.push({
      name: "database",
      check: async () => {
        // Placeholder — real probe would run a lightweight query
        // (e.g. SELECT 1) against the Postgres connection string.
        // The check is injected by the caller so the indexer module
        // stays free of hard-coded driver imports.
        throw new Error("database probe not configured");
      },
    });
  }

  if (probes.length > 0) {
    const liveResult = await checkLiveDependencies(probes, {
      nodeEnv: process.env.NODE_ENV ?? "development",
      force: forceLiveCheck,
    });

    if (!liveResult.ready) {
      for (const error of liveResult.errors) {
        console.error(`[startup-health] ${error}`);
      }
      console.error(
        "[startup-health] refusing to boot: dependencies not ready",
      );
      process.exit(1);
    }
  }

  // HTTP server starts only after startup health and live dependency
  // checks pass — fail-closed at every gate.
  const app = await buildIndexerHttpServer();
  const port = env.INDEXER_HTTP_PORT ? parseInt(env.INDEXER_HTTP_PORT, 10) : 3000;
  await app.listen({ port });
  console.log(`[boot] indexer HTTP server listening on port ${port}`);
}

main().catch((err) => {
  console.error("[boot] fatal error", err instanceof Error ? err.message : "unknown");
  process.exit(1);
});
