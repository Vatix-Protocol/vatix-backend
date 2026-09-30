import { validateEnv, EnvValidationError } from "./env.js";
import {
  checkStartupHealth,
  checkLiveDependencies,
} from "./startupHealth.js";
import { buildIndexerHttpServer } from "./httpServer.js";
import type { DependencyProbe } from "./startupHealth.js";
import {
  loadIndexerHaConfig,
  IndexerLeaderLease,
  type IndexerHaConfig,
} from "./haCoordinator.js";

let leaderLease: IndexerLeaderLease | null = null;
let httpServer: Awaited<ReturnType<typeof buildIndexerHttpServer>> | null = null;

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
  const haConfig: IndexerHaConfig = loadIndexerHaConfig(env);

  // Startup health gate — fail-closed before the HTTP server binds or ingestion starts.
  // Validates config shape (cursor, networkId, cursorKey, databaseUrl)
  // so the indexer never starts with a malformed cursor that would
  // poison the ingestion pipeline.
  const cursorKey = haConfig.shardPlan.cursorKey;
  const startupResult = checkStartupHealth({
    cursor: env.INDEXER_CURSOR ?? null,
    networkId: env.SOROBAN_NETWORK_PASSPHRASE ?? "",
    cursorKey,
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

  // HA Leader Election & Shard Coordination (#1167)
  if (haConfig.enabled) {
    console.log(
      `[ha] initializing indexer HA coordinator: shard ${haConfig.shardPlan.shardId}/${haConfig.shardPlan.totalShards}, cursorKey=${cursorKey}`
    );
    leaderLease = new IndexerLeaderLease(haConfig);
    await leaderLease.start({
      onAcquired: (token) => {
        console.log(
          `[ha] elected leader for shard ${haConfig.shardPlan.shardId} (fencing token: ${token}); ingestion active`
        );
      },
      onLost: (reason) => {
        console.warn(
          `[ha] lost leader lease for shard ${haConfig.shardPlan.shardId} (${reason}); demoting to standby`
        );
      },
    });
  } else {
    console.log(
      `[ha] HA leader election disabled; running standalone ingestion on shard ${haConfig.shardPlan.shardId}`
    );
  }

  // Feature flag: the indexer's HTTP server is opt-in so the default
  // off-chain event-ingestion role stays HTTP-free. When disabled the
  // process runs headless (polling only) and the kill-switch is a
  // single env var flip — no code change, no redeploy.
  const httpEnabled = env.INDEXER_HTTP_ENABLED === "true";
  if (httpEnabled) {
    httpServer = await buildIndexerHttpServer();
    const port = env.INDEXER_HTTP_PORT ? parseInt(env.INDEXER_HTTP_PORT, 10) : 3000;
    await httpServer.listen({ port });
    console.log(`[boot] indexer HTTP server listening on port ${port}`);
  } else {
    console.log("[boot] INDEXER_HTTP_ENABLED not set; skipping HTTP server");
  }

  // Graceful shutdown registration
  const shutdown = async (signal: string) => {
    console.log(`[shutdown] received ${signal}, shutting down indexer cleanly...`);
    if (leaderLease) {
      await leaderLease.release();
    }
    if (httpServer) {
      await httpServer.close();
    }
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

export { main, start };

// Only invoke automatically when run directly as CLI
if (process.argv[1] && process.argv[1].endsWith("main.ts")) {
  main().catch((err) => {
    console.error("[boot] fatal error", err instanceof Error ? err.message : "unknown");
    process.exit(1);
  });
}
