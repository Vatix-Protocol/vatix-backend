import { describe, expect, it } from 'vitest';
import { validateDockerComposeConfig } from './docker-compose';

function expectBadRequest(fn: () => unknown, key: string): void {
  try {
    fn();
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain(key);
    return;
  }
  throw new Error('Expected validateDockerComposeConfig to throw');
}

describe('validateDockerComposeConfig', () => {
  it('rejects a null service entry', () => {
    expectBadRequest(
      () => validateDockerComposeConfig({ services: { api: null } }),
      'api',
    );
  });

  it('rejects a string service entry', () => {
    expectBadRequest(
      () => validateDockerComposeConfig({ services: { api: 'nope' } }),
      'api',
    );
  });

  it('rejects an array service entry', () => {
    expectBadRequest(
      () => validateDockerComposeConfig({ services: { api: [] } }),
      'api',
    );
  });

  it('rejects a service with non-array ports', () => {
    expectBadRequest(
      () => validateDockerComposeConfig({ services: { api: { ports: '80' } } }),
      'api',
    );
  });

  it('rejects a service with non-array volumes', () => {
    expectBadRequest(
      () => validateDockerComposeConfig({ services: { api: { volumes: 'data' } } }),
      'api',
    );
  });

  it('rejects a service with invalid environment', () => {
    expectBadRequest(
      () => validateDockerComposeConfig({ services: { api: { environment: 42 } } }),
      'api',
    );
  });

  it('rejects a service with invalid depends_on', () => {
    expectBadRequest(
      () => validateDockerComposeConfig({ services: { api: { depends_on: 42 } } }),
      'api',
    );
  });

  it('returns a valid config with multiple services unchanged', () => {
    const config = {
      version: '3.8',
      services: {
        api: { image: 'node:20', ports: ['3000:3000'] },
        db: { image: 'postgres:16' },
      },
    };

    expect(validateDockerComposeConfig(config)).toBe(config);
  });
});
