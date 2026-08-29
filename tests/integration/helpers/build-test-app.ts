import Fastify, { type FastifyInstance } from "fastify";
import { errorHandler } from "../../../src/api/middleware/errorHandler.js";
import { clearRateLimitStores } from "../../../src/api/middleware/rateLimiter.js";
import { leaderLease } from "../../../src/matching/leader-lease.js";

export interface BuildTestAppOptions {
  /** Route plugin(s) to register, each under /v1 prefix */
  plugins: Array<(fastify: FastifyInstance) => Promise<void>>;
  /**
   * Exercise the production single-writer path instead of the lease-bypassed
   * default (issue #991).
   *
   * When `true`, `MATCHING_LEASE_ENFORCED` is forced to `"true"` for the
   * lifetime of the app and the real Redis-backed matching leader lease is
   * acquired before the app becomes ready, so route handlers run the same
   * `leaderLease.isLeader()` gate that guards matching in production. If the
   * lease cannot be acquired (Redis unreachable, or another holder owns it)
   * this fails fast rather than silently falling back to a lease-disabled
   * app. The lease is released and the previous env value restored on
   * `app.close()`.
   *
   * When `false`/omitted, behaviour is unchanged: the app relies on the
   * ambient `MATCHING_LEASE_ENFORCED` value (`"false"` in the default test
   * setup).
   */
  enableLease?: boolean;
}

/**
 * Builds a minimal Fastify test app with the real error handler and the
 * given route plugins registered under /v1. Sets API_KEY and ADMIN_TOKEN
 * env vars if not already present so auth guards resolve predictably.
 */
export async function buildTestApp(
  opts: BuildTestAppOptions
): Promise<FastifyInstance> {
  process.env.API_KEY ??= "test-api-key";
  process.env.ADMIN_TOKEN ??= "test-admin-token";

  const leaseEnabled = opts.enableLease ?? false;
  const previousLeaseEnforced = process.env.MATCHING_LEASE_ENFORCED;

  if (leaseEnabled) {
    process.env.MATCHING_LEASE_ENFORCED = "true";
    await leaderLease.start();
    if (!leaderLease.isLeader()) {
      await leaderLease.release();
      restoreLeaseEnv(previousLeaseEnforced);
      throw new Error(
        "buildTestApp({ enableLease: true }) could not acquire the matching " +
          "leader lease — is Redis reachable and the lease free?"
      );
    }
  }

  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);

  for (const plugin of opts.plugins) {
    await app.register(plugin, { prefix: "/v1" });
  }

  if (leaseEnabled) {
    app.addHook("onClose", async () => {
      await leaderLease.release();
      restoreLeaseEnv(previousLeaseEnforced);
    });
  }

  await app.ready();
  return app;
}

function restoreLeaseEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.MATCHING_LEASE_ENFORCED;
  } else {
    process.env.MATCHING_LEASE_ENFORCED = previous;
  }
}

/** Call in beforeEach to prevent rate-limit bleed between tests. */
export function resetRateLimits(): void {
  clearRateLimitStores();
}
