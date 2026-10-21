import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fastify from 'fastify';
import { cors, resolveAllowedOrigins, parseAllowedOrigins } from './cors.js';

/**
 * Unit tests locking the CORS policy defined in ./cors.ts (issue #1196, #1289).
 *
 * These tests pin the observable contract of the middleware so that any
 * change to the policy (allowed origin, methods, headers, preflight handling)
 * fails CI rather than silently shipping a weaker policy.
 *
 * Uses Fastify's built-in inject() API — no external HTTP call required.
 */

function buildApp(options?: Parameters<typeof cors>[0]) {
  const app = fastify({ logger: false });
  const corsMiddleware = cors(options);

  // Register the cors handler as a global hook.
  app.addHook('onRequest', async (req, reply) => {
    const result = await corsMiddleware(req, reply);
    // cors() returns the reply when it short-circuits OPTIONS;
    // returning undefined lets Fastify continue to the route handler.
    return result;
  });

  app.get('/health', async (_req, reply) => {
    return reply.status(200).send({ ok: true });
  });

  app.post('/tx', async (_req, reply) => {
    return reply.status(200).send({ ok: true });
  });

  return app;
}

// ---------------------------------------------------------------------------
// resolveAllowedOrigins / parseAllowedOrigins unit tests
// ---------------------------------------------------------------------------

describe('resolveAllowedOrigins', () => {
  afterEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  it('returns [] when env var is unset', () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    expect(resolveAllowedOrigins(undefined)).toEqual([]);
  });

  it('returns [] for an empty string', () => {
    expect(resolveAllowedOrigins('')).toEqual([]);
  });

  it('returns [] for a whitespace-only string', () => {
    expect(resolveAllowedOrigins('   ')).toEqual([]);
  });

  it('parses a single origin', () => {
    expect(resolveAllowedOrigins('https://app.vatix.io')).toEqual([
      'https://app.vatix.io',
    ]);
  });

  it('parses multiple origins, trimming whitespace', () => {
    expect(
      resolveAllowedOrigins(
        ' https://app.vatix.io , https://admin.vatix.io ',
      ),
    ).toEqual(['https://app.vatix.io', 'https://admin.vatix.io']);
  });

  it('drops empty entries between commas', () => {
    expect(
      resolveAllowedOrigins('https://app.vatix.io,,https://admin.vatix.io'),
    ).toEqual(['https://app.vatix.io', 'https://admin.vatix.io']);
  });
});

describe('parseAllowedOrigins', () => {
  it('returns [] for undefined', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it('returns [] for empty string', () => {
    expect(parseAllowedOrigins('')).toEqual([]);
  });

  it('returns [] for whitespace-only', () => {
    expect(parseAllowedOrigins('   \t  ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cors() middleware – wildcard (no allowlist) mode
// ---------------------------------------------------------------------------

describe('cors middleware — wildcard mode (no allowlist)', () => {
  it('sets Access-Control-Allow-Origin: * on simple requests', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.vatix.io' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('sets Access-Control-Allow-Origin: * even when Origin is absent', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('advertises the allowed methods', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.vatix.io' },
    });

    expect(res.headers['access-control-allow-methods']).toBe(
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
  });

  it('advertises the allowed headers', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.vatix.io' },
    });

    expect(res.headers['access-control-allow-headers']).toBe(
      'Content-Type, Authorization, X-Correlation-Id, X-Request-Id',
    );
  });

  it('does not enable credentials in wildcard mode (incompatible with *)', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.vatix.io' },
    });

    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers preflight OPTIONS with 204 and CORS headers', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/tx',
      headers: {
        origin: 'https://app.vatix.io',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain(
      'Authorization',
    );
    expect(res.body).toBe('');
  });

  it('does not invoke downstream handlers for preflight requests', async () => {
    const app = fastify({ logger: false });
    const handler = vi.fn(async (_req: unknown, reply: { status: (n: number) => { send: (d: unknown) => unknown } }) =>
      reply.status(200).send({ ok: true })
    );
    const corsMiddleware = cors();
    app.addHook('onRequest', async (req, reply) => {
      return corsMiddleware(req, reply);
    });
    app.post('/tx', handler);

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/tx',
      headers: { origin: 'https://app.vatix.io' },
    });

    expect(res.statusCode).toBe(204);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not reflect an unknown origin (wildcard, not echo)', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'https://evil.example.com',
    );
  });

  it('passes non-preflight requests through to downstream handlers', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/tx',
      headers: {
        origin: 'https://app.vatix.io',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount: '1' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// cors() middleware — allowlist mode
// ---------------------------------------------------------------------------

describe('cors middleware — allowlist mode', () => {
  const allowedOrigins = ['https://app.vatix.io', 'https://admin.vatix.io'];

  it('echoes a listed origin in Access-Control-Allow-Origin', async () => {
    const app = buildApp({ allowedOrigins });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.vatix.io' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://app.vatix.io',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('sets Vary: Origin when in allowlist mode', async () => {
    const app = buildApp({ allowedOrigins });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.vatix.io' },
    });

    expect(res.headers['vary']).toBe('Origin');
  });

  it('omits Access-Control-Allow-Origin for a non-allowlisted origin', async () => {
    const app = buildApp({ allowedOrigins });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('omits Access-Control-Allow-Origin when Origin is absent', async () => {
    const app = buildApp({ allowedOrigins });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never emits Access-Control-Allow-Origin: * in allowlist mode', async () => {
    const app = buildApp({ allowedOrigins });

    // Listed origin
    const res1 = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.vatix.io' },
    });
    expect(res1.headers['access-control-allow-origin']).not.toBe('*');

    // Unlisted origin
    const res2 = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res2.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('echoes a listed origin on preflight with 204', async () => {
    const app = buildApp({ allowedOrigins });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/tx',
      headers: {
        origin: 'https://admin.vatix.io',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://admin.vatix.io',
    );
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.body).toBe('');
  });

  it('omits Access-Control-Allow-Origin on preflight for non-allowlisted origin', async () => {
    const app = buildApp({ allowedOrigins });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/tx',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.body).toBe('');
  });

  it('does not invoke downstream handlers for preflight requests in allowlist mode', async () => {
    const app = fastify({ logger: false });
    const handler = vi.fn(async (_req: unknown, reply: { status: (n: number) => { send: (d: unknown) => unknown } }) =>
      reply.status(200).send({ ok: true })
    );
    const corsMiddleware = cors({ allowedOrigins });
    app.addHook('onRequest', async (req, reply) => {
      return corsMiddleware(req, reply);
    });
    app.post('/tx', handler);

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/tx',
      headers: { origin: 'https://app.vatix.io' },
    });

    expect(res.statusCode).toBe(204);
    expect(handler).not.toHaveBeenCalled();
  });

  it('Vary: Origin is set even when origin is absent in allowlist mode', async () => {
    const app = buildApp({ allowedOrigins });
    const res = await app.inject({ method: 'GET', url: '/health' });

    // Vary must be set regardless so caches don't serve one response for all origins.
    expect(res.headers['vary']).toBe('Origin');
  });
});
