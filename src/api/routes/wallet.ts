/**
 * Wallet routes — exposes cached Horizon account lookups.
 * Requires a valid API key (x-api-key header).
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
        throw new NotFoundError(`Account not found in cache: ${accountId}`);
      }

      success(reply, { account: cached, source: "cache" });
    }
  );
}
