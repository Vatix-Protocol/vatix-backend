import { describe, it, expect } from 'vitest';
import * as middleware from './index.js';

describe('api/middleware barrel', () => {
  it('exports the admin guard as a function', () => {
    expect(middleware.requireAdmin).toBeDefined();
    expect(typeof middleware.requireAdmin).toBe('function');
  });

  it('exports the error handler as a function', () => {
    expect(middleware.errorHandler).toBeDefined();
    expect(typeof middleware.errorHandler).toBe('function');
  });

  it('exports the response helpers as functions', () => {
    expect(typeof middleware.sendSuccess).toBe('function');
    expect(typeof middleware.sendError).toBe('function');
    expect(typeof middleware.sendCreated).toBe('function');
    expect(typeof middleware.sendNoContent).toBe('function');
  });

  it('exports the request id helper as a function', () => {
    expect(middleware.requestId).toBeDefined();
    expect(typeof middleware.requestId).toBe('function');
  });

  it('exports the stellar auth helpers as functions', () => {
    expect(typeof middleware.buildSignableMessage).toBe('function');
    expect(typeof middleware.verifyStellarSignature).toBe('function');
  });

  it('exports the OrderBook class', () => {
    expect(middleware.OrderBook).toBeDefined();
    expect(typeof middleware.OrderBook).toBe('function');
  });
});
