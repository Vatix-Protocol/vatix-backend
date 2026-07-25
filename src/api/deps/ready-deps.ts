import { getPrismaClient } from "../../services/prisma.js";
import { redis } from "../../services/redis.js";

export function createReadyDeps() {
  return {
    checkDatabase: async () => {
      const prisma = getPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
    },
    checkRedis: async () => {
      const ok = await redis.healthCheck();
      if (!ok) throw new Error("Redis PING did not return PONG");
    },
    getLastIndexedAt: async () => {
      const prisma = getPrismaClient();
      const cursor = await prisma.indexerCursor.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true, cursorValue: true },
      });
      if (!cursor || !cursor.cursorValue) {
        return null;
      }
      return cursor.updatedAt.getTime();
    },
  };
}
