import type { FastifyReply, FastifyRequest } from "fastify";
import { unauthorized, forbidden, serviceUnavailable, internalError } from "./responses.js";
import type { AdminIdentityService } from "../../services/admin-identity.js";

export interface AdminGuardDeps {
  identityService: AdminIdentityService;
  isProduction: boolean;
}

/**
 * Fastify preHandler that enforces admin authentication and authorization
 * for all /v1/admin/* routes.
 *
 * Status code semantics:
 * - 401: missing/non-Bearer Authorization header, malformed credential
 *   format, or failed credential validation (caller is not authenticated).
 * - 403: caller is authenticated but is not permitted (no active
 *   AdminIdentity rows in production).
 * - 503: the identity store is unavailable (fail-closed, not a client error).
 * - 500: unexpected error while evaluating the guard.
 */
export function requireAdmin(deps: AdminGuardDeps) {
  return async function adminGuard(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      unauthorized(reply);
      return;
    }

    const token = authHeader.slice("Bearer ".length);
    const separatorIndex = token.indexOf(":");

    if (separatorIndex === -1) {
      unauthorized(reply);
      return;
    }

    const identityName = token.slice(0, separatorIndex);
    const credentialValue = token.slice(separatorIndex + 1);

    if (!identityName || !credentialValue) {
      unauthorized(reply);
      return;
    }

    try {
      const isValid = await deps.identityService.validateCredential(
        identityName,
        credentialValue
      );

      if (!isValid) {
        unauthorized(reply);
        return;
      }

      if (deps.isProduction) {
        const activeAdmins = await deps.identityService.listActiveAdmins();
        if (activeAdmins.length === 0) {
          // Fail closed: a production deployment with no active AdminIdentity
          // rows is a misconfiguration, not a client error.
          serviceUnavailable(
            reply,
            "Admin access is not configured for this deployment"
          );
          return;
        }
      }

      // Authenticated and permitted.
    } catch (error) {
      request.log.error(
        { err: error, requestId: request.id },
        "adminGuard: identity check failed"
      );
      internalError(reply);
    }
  };
}
