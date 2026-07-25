import Fastify, { type FastifyInstance } from "fastify";
import { errorHandler } from "../../../src/api/middleware/errorHandler.js";
import { clearRateLimitStores } from "../../../src/api/middleware/rateLimiter.js";

export interface BuildTestAppOptions {
  /** Route plugin(s) to register, each under /v1 prefix */
  plugins: Array<(fastify: FastifyInstance) => Promise<void>>;
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

  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);

  for (const plugin of opts.plugins) {
    await app.register(plugin, { prefix: "/v1" });
  }

  await app.ready();
  return app;
}

/** Call in beforeEach to prevent rate-limit bleed between tests. */
export function resetRateLimits(): void {
  clearRateLimitStores();
}
