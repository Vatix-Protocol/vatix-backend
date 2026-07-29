import { randomBytes } from "crypto";
import { redis } from "../../services/redis.js";

/**
 * Challenge / nonce TTL in seconds.
 * Override via CHALLENGE_TTL_SECONDS (default: 120).
 */
function loadTtlSeconds(): number {
  const raw = process.env.CHALLENGE_TTL_SECONDS;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 120;
}

const NONCE_KEY_PREFIX = "auth:nonce:";

function nonceKey(userAddress: string, nonce: string): string {
  return `${NONCE_KEY_PREFIX}${userAddress}:${nonce}`;
}

export interface Challenge {
  nonce: string;
  expiresAt: number;
  ttlSeconds: number;
}

/**
 * Issue a single-use challenge for a wallet address.
 *
 * The nonce is stored in Redis (shared by every API replica) with a TTL, so a
 * challenge issued by one replica can be consumed exactly once by any replica
 * and disappears on expiry.
 */
export async function issueChallenge(userAddress: string): Promise<Challenge> {
  const ttlSeconds = loadTtlSeconds();
  const nonce = randomBytes(24).toString("base64url");
  await redis.set(nonceKey(userAddress, nonce), "1", ttlSeconds);
  return {
    nonce,
    ttlSeconds,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

/**
 * Atomically consume a previously issued nonce.
 *
 * Returns true only for the first caller: the Redis DEL reply is the number of
 * keys removed, so two concurrent replicas racing on the same nonce produce a
 * single winner. Unknown or expired nonces return false (fail closed).
 */
export async function consumeNonce(
  userAddress: string,
  nonce: string
): Promise<boolean> {
  return redis.delIfExists(nonceKey(userAddress, nonce));
}
