import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { issueChallenge } from "../middleware/nonceStore.js";
import { unauthorized } from "../middleware/responses.js";

interface ChallengeBody {
  userAddress: string;
}

interface ChallengeResponse {
  nonce: string;
  expiresAt: string;
  ttlSeconds: number;
}

/**
 * Challenge issuance for Stellar wallet auth.
 *
 * The returned nonce must be echoed in the `x-nonce` header and included in the
 * signed payload of the next mutating request; it is single-use and expires
 * after `ttlSeconds`.
 */
export async function authRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: ChallengeBody; Reply: ChallengeResponse }>(
    "/auth/challenge",
    {
      schema: {
        body: {
          type: "object",
          required: ["userAddress"],
          properties: {
            userAddress: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { userAddress } = request.body;

      try {
        Keypair.fromPublicKey(userAddress);
      } catch {
        unauthorized(reply, "Invalid userAddress");
        return;
      }

      const challenge = await issueChallenge(userAddress);

      reply.status(201).send({
        nonce: challenge.nonce,
        expiresAt: new Date(challenge.expiresAt).toISOString(),
        ttlSeconds: challenge.ttlSeconds,
      });
    }
  );
}
