import type { FastifyRequest, FastifyReply } from "fastify";
import { unauthorized, forbidden } from "./responses.js";
import { getPrismaClient } from "../../services/prisma.js";
import { AdminIdentityService } from "../../services/admin-identity.js";
import { config } from "../../config.js";
import { createLogger } from "../../../apps/indexer/src/logger.js";

const Roles = { ADMIN: "admin" } as const;
const logger = createLogger(process.env.LOG_LEVEL as any);

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    unauthorized(reply);
    return;
  }

  const credential = authHeader.slice(7);
  const requestId =
    (request.headers["x-request-id"] as string) || "unknown";

  try {
    const prisma = getPrismaClient();
    const identityService = new AdminIdentityService(prisma);

    // In production, the identity store must be configured and reachable.
    // Fail fast rather than silently allowing access.
    const hasIdentities = await prisma.adminIdentity.findFirst({
      where: { active: true },
    });

    if (
      config.nodeEnv === "production" &&
      !hasIdentities
    ) {
      logger.error(
        { requestId },
        "Admin identity store not configured in production"
      );
      forbidden(reply, `Role '${Roles.ADMIN}' required`);
      return;
    }

    // Try identity-based auth first. Extract identity name from credential format:
    // Format: "identity_name:credential" (e.g., "alice:secret123")
    const [identityName, ...credentialParts] = credential.split(":");
    const credentialValue = credentialParts.join(":");

    if (!identityName || !credentialValue) {
      logger.info(
        { requestId },
        "Admin auth attempt with invalid credential format"
      );
      forbidden(reply, `Role '${Roles.ADMIN}' required`);
      return;
    }

    // validateCredential uses bcrypt.compare which performs timing-safe comparison
    const isValid = await identityService.validateCredential(
      identityName,
      credentialValue
    );

    if (!isValid) {
      logger.warn(
        { requestId, identityName },
        "Admin auth attempt failed: invalid or revoked identity"
      );
      forbidden(reply, `Role '${Roles.ADMIN}' required`);
      return;
    }

    logger.info({ requestId, identityName }, "Admin auth successful");
    (request as any).adminIdentity = identityName;
  } catch (error) {
    logger.error(
      { requestId, error: String(error) },
      "Admin auth error"
    );
    forbidden(reply, `Role '${Roles.ADMIN}' required`);
    return;
  }
}

