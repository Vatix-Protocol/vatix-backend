import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { cors } from './cors';

/**
 * Unit tests locking the CORS policy defined in ./cors.ts (issue #1196).
 *
 * These tests pin the observable contract of the middleware so that any
 * change to the policy (allowed origin, methods, headers, preflight handling)
 * fails CI rather than silently shipping a weaker policy.
 */

function buildApp() {
  const app = new Hono();
  app.use('*', cors());
  app.get('/health', (c) => c.json({ ok: true }));
  app.post('/tx', (c) => c.json({ ok: true }));
  return app;
}

describe('cors middleware', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('sets the allow-origin header on simple requests', async () => {
    const app = buildApp();
    const res = await app.request('/health', {
      headers: { Origin: 'https://app.vatix.io' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('sets the allow-origin header even when Origin is absent', async () => {
    const app = buildApp();
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('advertises the allowed methods', async () => {
    const app = buildApp();
    const res = await app.request('/health', {
      headers: { Origin: 'https://app.vatix.io' },
    });

    expect(res.headers.get('Access-Control-Allow-Methods')).toBe(
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
  });

  it('advertises the allowed headers', async () => {
    const app = buildApp();
    const res = await app.request('/health', {
      headers: { Origin: 'https://app.vatix.io' },
    });

    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type, Authorization, X-Correlation-Id, X-Request-Id',
    );
  });

  it('does not enable credentials by default', async () => {
    const app = buildApp();
    const res = await app.request('/health', {
      headers: { Origin: 'https://app.vatix.io' },
    });

    // Wildcard origin is incompatible with credentialed requests; the policy
    // must not advertise credentials unless the origin is explicitly echoed.
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('answers preflight OPTIONS with 204 and no body', async () => {
    const app = buildApp();
    const res = await app.request('/tx', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.vatix.io',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, authorization',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(await res.text()).toBe('');
  });

  it('does not invoke downstream handlers for preflight requests', async () => {
    const app = new Hono();
    const handler = vi.fn((c) => c.json({ ok: true }));
    app.use('*', cors());
    app.post('/tx', handler);

    const res = await app.request('/tx', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.vatix.io' },
    });

    expect(res.status).toBe(204);
    expect(handler).not.toHaveBeenCalled();
  });

  it('still applies the policy to unknown origins (fail-closed wildcard)', async () => {
    const app = buildApp();
    const res = await app.request('/health', {
      headers: { Origin: 'https://evil.example.com' },
    });

    // The policy is a public wildcard: unknown origins are not echoed back,
    // and no per-origin allowlist is implied. Locking this prevents an
    // accidental switch to reflecting arbitrary origins.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe(
      'https://evil.example.com',
    );
  });

  it('does not reflect an untrusted origin on preflight', async () => {
    const app = buildApp();
    const res = await app.request('/tx', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe(
      'https://evil.example.com',
    );
  });

  it('tolerates malformed Origin values without throwing', async () => {
    const app = buildApp();
    const res = await app.request('/health', {
      headers: { Origin: 'not a valid origin' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('passes non-preflight requests through to downstream handlers', async () => {
    const app = buildApp();
    const res = await app.request('/tx', {
      method: 'POST',
      headers: { Origin: 'https://app.vatix.io', 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: '1' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
