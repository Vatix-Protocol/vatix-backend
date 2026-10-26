import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'hono';
import {
  bodyLimit,
  resolveBodyLimitBytes,
  DEFAULT_BODY_LIMIT_BYTES,
} from './cors';

/**
 * Unit tests locking the body-limit policy defined in ./cors.ts (issue #1355).
 *
 * The security-relevant branches are: a forged/understated `content-length`
 * header must not bypass the limit, and a request with no `content-length`
 * must still be measured against the real payload. The rejection log must
 * never leak body contents.
 */

function makeContext(opts: {
  method?: string;
  body?: Uint8Array;
  contentLength?: string;
  correlationId?: string;
}): { c: Context; next: ReturnType<typeof vi.fn> } {
  const headers = new Headers();
  if (opts.contentLength !== undefined) {
    headers.set('content-length', opts.contentLength);
  }
  if (opts.correlationId !== undefined) {
    headers.set('x-correlation-id', opts.correlationId);
  }

  const request = new Request('http://localhost/tx', {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body,
  });

  const next = vi.fn(async () => undefined);
  const c = { req: { raw: request } } as unknown as Context;
  return { c, next };
}

describe('bodyLimit middleware', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('rejects when the declared content-length exceeds the limit', async () => {
    const { c, next } = makeContext({
      body: new Uint8Array(10),
      contentLength: '2048',
    });

    const res = await bodyLimit({ maxBytes: 1024 })(c, next);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(413);
    const json = await res!.json();
    expect(json.error.code).toBe('BODY_TOO_LARGE');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an understated content-length when the real body is oversized', async () => {
    const { c, next } = makeContext({
      body: new Uint8Array(4096),
      contentLength: '10',
      correlationId: 'corr-123',
    });

    const res = await bodyLimit({ maxBytes: 1024 })(c, next);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(413);
    const json = await res!.json();
    expect(json.error.code).toBe('BODY_TOO_LARGE');
    expect(next).not.toHaveBeenCalled();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.event).toBe('body_limit_rejected');
    expect(logged.code).toBe('BODY_TOO_LARGE');
    expect(logged.maxBytes).toBe(1024);
    expect(logged.actualBytes).toBe(4096);
    expect(logged.correlationId).toBe('corr-123');
    // The log must not contain any request body content.
    expect(JSON.stringify(logged)).not.toContain('\u0000');
    expect(Object.keys(logged).sort()).toEqual(
      ['actualBytes', 'code', 'correlationId', 'event', 'maxBytes'].sort(),
    );
  });

  it('rejects an oversized body when no content-length is present', async () => {
    const { c, next } = makeContext({ body: new Uint8Array(4096) });

    const res = await bodyLimit({ maxBytes: 1024 })(c, next);

    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(413);
    const json = await res!.json();
    expect(json.error.code).toBe('BODY_TOO_LARGE');
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through a body exactly at the limit', async () => {
    const { c, next } = makeContext({
      body: new Uint8Array(1024),
      contentLength: '1024',
    });

    const res = await bodyLimit({ maxBytes: 1024 })(c, next);

    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('skips %s requests', async (method) => {
    const { c, next } = makeContext({
      method,
      body: new Uint8Array(4096),
      contentLength: '4096',
    });

    const res = await bodyLimit({ maxBytes: 1024 })(c, next);

    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('resolveBodyLimitBytes', () => {
  it('falls back to the default for undefined', () => {
    expect(resolveBodyLimitBytes(undefined)).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });

  it('falls back to the default for a blank string', () => {
    expect(resolveBodyLimitBytes('')).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(resolveBodyLimitBytes('   ')).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });

  it('falls back to the default for a non-numeric value', () => {
    expect(resolveBodyLimitBytes('abc')).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });

  it('falls back to the default for zero', () => {
    expect(resolveBodyLimitBytes('0')).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });

  it('falls back to the default for a negative value', () => {
    expect(resolveBodyLimitBytes('-5')).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });

  it('returns a valid positive value', () => {
    expect(resolveBodyLimitBytes('2048')).toBe(2048);
  });
});
