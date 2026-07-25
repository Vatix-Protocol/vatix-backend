/**
 * dbReadiness — thin wrapper around getPrismaClient for use in the
 * readiness probe. Isolated here so it can be mocked in unit tests
 * without touching the full Prisma singleton.
 *
 * No secrets or PII are surfaced; errors expose only the message string.
 */
import { getPrismaClient } from "./prisma.js";

export async function checkDbReadiness(): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.$queryRaw`SELECT 1`;
}
