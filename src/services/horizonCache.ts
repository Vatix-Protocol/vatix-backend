/**
 * HorizonCacheService
 * Caches Stellar Horizon account lookups briefly (30 s) so wallet, payment,
 * and custody flows avoid hammering the Horizon HTTP API on every request.
 *
 * Design notes:
 * - Uses the existing RedisService singleton; no new dependencies.
 * - Returns null on cache-miss so callers can fall through to Horizon.
 * - Secrets (signing keys) are never stored — only the public account JSON.
 */

import { redis } from "./redis.js";

const HORIZON_ACCOUNT_TTL = 30; // seconds

export interface HorizonAccountData {
  accountId: string;
  sequence: string;
  balances: Array<{ asset_type: string; asset_code?: string; balance: string }>;
  fetchedAt: number;
}

function cacheKey(accountId: string): string {
  return `horizon:account:${accountId}`;
}

function isValidAccountId(accountId: string): boolean {
  // Stellar public keys start with 'G' and are 56 characters
  return typeof accountId === "string" && /^G[A-Z2-7]{55}$/.test(accountId);
}

export class HorizonCacheService {
  async get(accountId: string): Promise<HorizonAccountData | null> {
    if (!isValidAccountId(accountId)) return null;
    const raw = await redis.get(cacheKey(accountId));
    if (!raw) return null;
    return JSON.parse(raw) as HorizonAccountData;
  }

  async set(accountId: string, data: HorizonAccountData): Promise<void> {
    if (!isValidAccountId(accountId)) return;
    await redis.set(cacheKey(accountId), JSON.stringify(data), HORIZON_ACCOUNT_TTL);
  }

  async invalidate(accountId: string): Promise<void> {
    if (!isValidAccountId(accountId)) return;
    await redis.del(cacheKey(accountId));
  }
}

export const horizonCache = new HorizonCacheService();
