import { getPrismaClient } from "../../services/prisma.js";

export function createReadyDeps() {
  return {
    checkDatabase: async () => {
      const prisma = getPrismaClient();
      await prisma.$queryRaw`SELECT 1`;
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
