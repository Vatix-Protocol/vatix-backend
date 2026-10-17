export const Roles = {
  ADMIN: 'admin',
} as const;

export type Role = (typeof Roles)[keyof typeof Roles];

export const KNOWN_ROLES: readonly Role[] = Object.values(Roles);

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (KNOWN_ROLES as readonly string[]).includes(value);
}
