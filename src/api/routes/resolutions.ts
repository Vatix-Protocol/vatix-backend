import type { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { verifyStellarSignature } from "../middleware/stellarAuth.js";
import { challengeResolutionCandidate } from "../../../apps/workers/src/finalization/challenge.js";
import {
  isChallengeWindowOpen,
  getChallengeWindow,
} from "../../oracle/challengeWindow.js";

const CHALLENGE_WINDOW_SECONDS =
  Number(process.env.ORACLE_CHALLENGE_WINDOW_SECONDS) || 86400;

interface ChallengeResolutionBody {
  evidence?: string;
}

interface ChallengeResolutionResponse {
  candidateId: string;
  marketId: string;
  status: string;
  message: string;
}

/**
 * POST /resolutions/:id/challenge — file a dispute against a proposed resolution.
 *
 * Requires Stellar signature auth. Transitions the candidate from PROPOSED to
 * CHALLENGED if the challenge window is still open. Returns 400 if the window
 * is closed, 404 if the candidate doesn't exist, 409 if it's already finalized
 * or challenged.
 */
export async function resolutionsRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  fastify.post<{
    Params: { id: string };
    Body: ChallengeResolutionBody;
    Reply: ChallengeResolutionResponse;
  }>(
    "/resolutions/:id/challenge",
    {
      preHandler: [verifyStellarSignature],
      schema: {
        body: {
          type: "object",
          properties: {
            evidence: { type: "string" },
          },
        },
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              candidateId: { type: "string" },
              marketId: { type: "string" },
              status: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: candidateId } = request.params;
      const { evidence } = request.body;

      try {
        // Fetch the candidate to check its state and challenge window
        const candidate = await prisma.resolutionCandidate.findUnique({
          where: { id: candidateId },
          select: {
            id: true,
            marketId: true,
            status: true,
            createdAt: true,
          },
        });

        if (!candidate) {
          reply.status(404).send({
            candidateId,
            marketId: "",
            status: "NOT_FOUND",
            message: `ResolutionCandidate ${candidateId} not found`,
          });
          return;
        }

        // Validate challenge window is still open
        if (!isChallengeWindowOpen(candidate.createdAt, CHALLENGE_WINDOW_SECONDS)) {
          const window = getChallengeWindow(
            candidate.createdAt,
            CHALLENGE_WINDOW_SECONDS
          );
          reply.status(400).send({
            candidateId: candidate.id,
            marketId: candidate.marketId,
            status: "WINDOW_CLOSED",
            message: `Challenge window closed. Window was open from ${window.opensAt.toISOString()} to ${window.closesAt.toISOString()}`,
          });
          return;
        }

        // Get the actor from the signed request (userAddress)
        const actor = (request as any).userAddress || "unknown";

        // Challenge the candidate
        const result = await challengeResolutionCandidate(
          prisma,
          request.log,
          candidateId,
          actor
        );

        request.log.info("Resolution challenged via API", {
          candidateId: result.candidateId,
          marketId: result.marketId,
          actor,
          evidence: evidence ? "provided" : "none",
        });

        reply.status(201).send({
          candidateId: result.candidateId,
          marketId: result.marketId,
          status: result.status,
          message: `Resolution ${candidateId} has been challenged`,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // Map known error types
        if (err.name === "ChallengeNotFoundError") {
          reply.status(404).send({
            candidateId,
            marketId: "",
            status: "NOT_FOUND",
            message: err.message,
          });
          return;
        }

        if (err.name === "IllegalChallengeTransitionError") {
          reply.status(409).send({
            candidateId,
            marketId: "",
            status: "ILLEGAL_TRANSITION",
            message: err.message,
          });
          return;
        }

        // Re-throw for global error handler
        throw err;
      }
    }
  );
}
