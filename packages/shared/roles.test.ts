import { describe, expect, it } from 'vitest';

import { KNOWN_ROLES, Roles, isRole } from './roles';

describe('isRole', () => {
  it('returns true for every known role', () => {
    for (const role of Object.values(Roles)) {
      expect(isRole(role)).toBe(true);
    }
  });

  it('returns false for wrong-case, empty, null, undefined, and non-string inputs', () => {
    expect(isRole('ADMIN')).toBe(false);
    expect(isRole('')).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole({ role: Roles.ADMIN })).toBe(false);
  });
});

describe('KNOWN_ROLES', () => {
  it('contains exactly the values of Roles', () => {
    expect(KNOWN_ROLES).toEqual(Object.values(Roles));
  });
});
