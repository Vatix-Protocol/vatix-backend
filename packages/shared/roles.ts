/**
 * Authorization role constants.
 *
 * Roles (MVP):
 *   ADMIN — full access to operational and protected endpoints.
 *           Verified via Bearer token (ADMIN_TOKEN env var).
 *
 * Add new roles here as the platform grows. Never use raw strings for
 * role checks — always reference these constants.
 */
export const Roles = {
  ADMIN: "admin",
} as const;

export type Role = (typeof Roles)[keyof typeof Roles];
