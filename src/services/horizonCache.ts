/**
 * HorizonCacheService
 * Caches Stellar Horizon account lookups briefly so wallet, payment,
 * and custody flows avoid hammering the Horizon HTTP API on every request.
 *
 * Design notes:
 * - Uses the existing RedisService singleton; no new dependencies.
 * - Returns null on cache-miss so callers can fall through to Horizon.
 * - Secrets (signing keys) are never stored — only the public account JSON.
 * - TTL is configurable via HORIZON_CACHE_TTL_SECONDS (default: 30).
 *   Set to a shorter value (e.g. 5) after a funding/trustline operation to
 *   avoid stale-account misleading collateral checks.
 * - Explicit invalidate() is exposed so the wallet deposit/trustline handler
 *   can evict the stale entry immediately after on-chain confirmation.
 */

import { redis } from "./redis.js";

/** Load and validate HORIZON_CACHE_TTL_SECONDS from env.
 *  Falls back to 30 s; rejects values outside the safe range [1, 3600]. */
function loadCacheTtl(): number {
  const raw = process.env.HORIZON_CACHE_TTL_SECONDS;
  if (raw === undefined || raw === "") return 30;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw new Error(
      `HORIZON_CACHE_TTL_SECONDS must be an integer between 1 and 3600, got: ${JSON.stringify(raw)}`
    );
  }
  return n;
}

export const HORIZON_ACCOUNT_TTL = loadCacheTtl();

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
    await redis.set(
      cacheKey(accountId),
      JSON.stringify(data),
      HORIZON_ACCOUNT_TTL
    );
  }

  /**
   * Evict a cached account entry immediately.
   *
   * Call this after a funding event or trustline change is confirmed
   * on-chain so the next GET /v1/wallet/accounts/:accountId reflects the
   * updated Horizon state rather than the now-stale cached snapshot.
   */
  async invalidate(accountId: string): Promise<void> {
    if (!isValidAccountId(accountId)) return;
    await redis.del(cacheKey(accountId));
  }
}

export const horizonCache = new HorizonCacheService();
