/**
 * Wallet routes — exposes cached Horizon account lookups.
 * Requires a valid API key (x-api-key header).
 *
 * Routes:
 *   GET  /v1/wallet/accounts/:accountId          — return cached account data
 *   POST /v1/wallet/accounts/:accountId/invalidate — evict stale cache entry
 *
 * The invalidation endpoint is intentionally separate so clients (e.g. the
 * indexer after observing a CollateralDeposited event) can evict a stale
 * entry after a funding or trustline change without needing a DELETE verb
 * on the cache path itself.  Both routes require the same API key so they
 * cannot be called by end-users.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { success } from "../middleware/responses.js";
import { ValidationError, NotFoundError } from "../middleware/errors.js";
import { horizonCache } from "../../services/horizonCache.js";

interface GetAccountParams {
  accountId: string;
}

const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

export async function walletRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: GetAccountParams }>(
    "/v1/wallet/accounts/:accountId",
    {
      onRequest: [requireApiKey],
      schema: {
        params: {
          type: "object",
          required: ["accountId"],
          additionalProperties: false,
          properties: { accountId: { type: "string" } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: GetAccountParams }>, reply) => {
      const { accountId } = request.params;

      if (!STELLAR_ACCOUNT_RE.test(accountId)) {
        throw new ValidationError(
          "accountId must be a valid Stellar public key"
        );
      }

      const cached = await horizonCache.get(accountId);
      if (!cached) {
        // Surface a structured hint so callers know the entry simply hasn't
        // been populated yet (or has been evicted), rather than silently
        // returning a generic 404.
        request.log.info(
          { accountId, requestId: request.id },
          "Horizon cache miss — account not in cache"
        );
        throw new NotFoundError(
          `Account ${accountId} not found in Horizon cache. ` +
            `The account may not exist on-chain yet, or the cache entry ` +
            `may have expired (TTL: ${process.env.HORIZON_CACHE_TTL_SECONDS ?? 30}s). ` +
            `Use POST /v1/wallet/accounts/${accountId}/invalidate to force a refresh.`
        );
      }

      request.log.debug(
        { accountId, fetchedAt: cached.fetchedAt, requestId: request.id },
        "Horizon cache hit"
      );

      success(reply, { account: cached, source: "cache" });
    }
  );

  /**
   * POST /v1/wallet/accounts/:accountId/invalidate
   *
   * Evicts the cached Horizon account entry for `accountId`.  The next
   * GET will return a cache-miss and callers should re-populate the cache
   * by fetching fresh data from Horizon and calling `horizonCache.set`.
   *
   * Typical callers:
   *   - Indexer: after observing a CollateralDeposited event for this account
   *   - Settlement worker: after a trustline change is confirmed on-chain
   */
  fastify.post<{ Params: GetAccountParams }>(
    "/v1/wallet/accounts/:accountId/invalidate",
    {
      onRequest: [requireApiKey],
      schema: {
        params: {
          type: "object",
          required: ["accountId"],
          additionalProperties: false,
          properties: { accountId: { type: "string" } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: GetAccountParams }>, reply) => {
      const { accountId } = request.params;

      if (!STELLAR_ACCOUNT_RE.test(accountId)) {
        throw new ValidationError(
          "accountId must be a valid Stellar public key"
        );
      }

      await horizonCache.invalidate(accountId);

      request.log.info(
        { accountId, requestId: request.id },
        "Horizon cache entry evicted"
      );

      success(reply, { invalidated: true, accountId });
    }
  );
}
