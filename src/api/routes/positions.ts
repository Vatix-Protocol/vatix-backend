import { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma";

export default async function positionsRouter(server: FastifyInstance) {
  server.get("/user/:address", async (request, reply) => {
    const { address } = request.params as { address: string };
    const prisma = getPrismaClient();

    if (!/^G[A-Z0-9]{55}$/.test(address)) {
      return reply.code(400).send({
        error: "Bad Request",
        message: "Invalid Stellar address format",
      });
    }

    const positions = await prisma.userPosition.findMany({
      where: { userAddress: address },
      include: { market: true },
    });

    const results = positions.map((p) => ({
      ...p,
      potentialPayout: Math.max(p.yesShares, p.noShares),
    }));

    return results;
  });
}
