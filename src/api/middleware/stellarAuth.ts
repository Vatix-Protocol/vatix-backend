import type { FastifyRequest, FastifyReply } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { unauthorized } from "./responses.js";
import { consumeNonce } from "./nonceStore.js";

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Builds the canonical UTF-8 message buffer that a user must sign when placing
 * an order.  Keys are sorted alphabetically so the serialisation is deterministic
 * regardless of how the caller constructs the object.
 */
export function buildSignableMessage(fields: {
  marketId: string;
  nonce: string;
  outcome: string;
  price: number;
  quantity: number;
  side: string;
  timestamp: number;
  userAddress: string;
}): Buffer {
  const payload = JSON.stringify({
    marketId: fields.marketId,
    nonce: fields.nonce,
    outcome: fields.outcome,
    price: fields.price,
    quantity: fields.quantity,
    side: fields.side,
    timestamp: fields.timestamp,
    userAddress: fields.userAddress,
  });
  return Buffer.from(payload, "utf8");
}

/**
 * Builds the canonical UTF-8 message buffer for order cancellation.
 * Uses the same nonce and timestamp validation rules as order placement (ADR 002).
 */
export function buildCancellationMessage(fields: {
  orderId: string;
  nonce: string;
  timestamp: number;
  userAddress: string;
}): Buffer {
  const payload = JSON.stringify({
    nonce: fields.nonce,
    orderId: fields.orderId,
    timestamp: fields.timestamp,
    userAddress: fields.userAddress,
  });
  return Buffer.from(payload, "utf8");
}

/**
 * Fastify preHandler hook that enforces Stellar wallet ownership before an order
 * is processed.
 *
 * Required headers:
 *   x-signature  – base64-encoded Ed25519 signature of the canonical message
 *   x-timestamp  – milliseconds since Unix epoch (string); must be within ±5 min
 *   x-nonce      – single-use nonce issued by POST /v1/auth/challenge
 *
 * The canonical message is built from the parsed request body fields combined
 * with the timestamp and nonce from the headers, so a replay of an identical
 * body with a stale timestamp is rejected even if the signature itself was once
 * valid.  The nonce lives in shared Redis and is consumed atomically, so the
 * same signed payload cannot be replayed against another API replica.
 *
 * Returns HTTP 401 for any authentication failure; delegates all other
 * validation to the route handler.
 */
export async function verifyStellarSignature(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const rawSig = request.headers["x-signature"];
  const rawTs = request.headers["x-timestamp"];
  const rawNonce = request.headers["x-nonce"];

  if (!rawSig || typeof rawSig !== "string") {
    unauthorized(reply, "Missing x-signature header");
    return;
  }

  if (!rawTs || typeof rawTs !== "string") {
    unauthorized(reply, "Missing x-timestamp header");
    return;
  }

  if (!rawNonce || typeof rawNonce !== "string") {
    unauthorized(reply, "Missing x-nonce header");
    return;
  }

  const timestamp = Number(rawTs);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    unauthorized(reply, "Invalid x-timestamp header");
    return;
  }

  if (Math.abs(Date.now() - timestamp) > TIMESTAMP_TOLERANCE_MS) {
    unauthorized(reply, "Request timestamp is expired");
    return;
  }

  // Body is guaranteed to be parsed and schema-validated before preHandler runs.
  const body = request.body as {
    marketId?: string;
    userAddress?: string;
    side?: string;
    outcome?: string;
    price?: number;
    quantity?: number;
  } | null;

  const userAddress = body?.userAddress;
  if (!userAddress) {
    unauthorized(reply, "Missing userAddress in request body");
    return;
  }

  try {
    const keypair = Keypair.fromPublicKey(userAddress);
    const message = buildSignableMessage({
      marketId: body?.marketId ?? "",
      nonce: rawNonce,
      outcome: body?.outcome ?? "",
      price: body?.price ?? 0,
      quantity: body?.quantity ?? 0,
      side: body?.side ?? "",
      timestamp,
      userAddress,
    });
    const sigBytes = Buffer.from(rawSig, "base64");
    const isValid = keypair.verify(message, sigBytes);

    if (!isValid) {
      unauthorized(reply, "Signature verification failed");
      return;
    }
  } catch {
    unauthorized(reply, "Invalid signature or userAddress");
    return;
  }

  // Consume the nonce only after the signature is proven valid, so an attacker
  // cannot burn a legitimate challenge with a forged request.
  let consumed = false;
  try {
    consumed = await consumeNonce(userAddress, rawNonce);
  } catch {
    unauthorized(reply, "Nonce store unavailable");
    return;
  }

  if (!consumed) {
    unauthorized(reply, "Nonce is unknown, expired or already used");
    return;
  }
}

/**
 * Fastify preHandler hook for verifying Stellar wallet ownership on order cancellation.
 *
 * Required headers:
 *   x-signature  – base64-encoded Ed25519 signature of the cancellation message
 *   x-timestamp  – milliseconds since Unix epoch (string); must be within ±5 min
 *   x-nonce      – single-use nonce issued by POST /v1/auth/challenge
 *
 * The signed message includes: orderId, nonce, timestamp, userAddress (from body).
 * Returns HTTP 401 for any authentication failure.
 */
export async function verifyStellarCancellationSignature(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const rawSig = request.headers["x-signature"];
  const rawTs = request.headers["x-timestamp"];
  const rawNonce = request.headers["x-nonce"];

  if (!rawSig || typeof rawSig !== "string") {
    unauthorized(reply, "Missing x-signature header");
    return;
  }

  if (!rawTs || typeof rawTs !== "string") {
    unauthorized(reply, "Missing x-timestamp header");
    return;
  }

  if (!rawNonce || typeof rawNonce !== "string") {
    unauthorized(reply, "Missing x-nonce header");
    return;
  }

  const timestamp = Number(rawTs);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    unauthorized(reply, "Invalid x-timestamp header");
    return;
  }

  if (Math.abs(Date.now() - timestamp) > TIMESTAMP_TOLERANCE_MS) {
    unauthorized(reply, "Request timestamp is expired");
    return;
  }

  const body = request.body as {
    userAddress?: string;
  } | null;

  const userAddress = body?.userAddress;
  if (!userAddress) {
    unauthorized(reply, "Missing userAddress in request body");
    return;
  }

  const orderId = request.params?.id;
  if (!orderId) {
    unauthorized(reply, "Missing orderId in request path");
    return;
  }

  try {
    const keypair = Keypair.fromPublicKey(userAddress);
    const message = buildCancellationMessage({
      orderId,
      nonce: rawNonce,
      timestamp,
      userAddress,
    });
    const sigBytes = Buffer.from(rawSig, "base64");
    const isValid = keypair.verify(message, sigBytes);

    if (!isValid) {
      unauthorized(reply, "Signature verification failed");
      return;
    }
  } catch {
    unauthorized(reply, "Invalid signature or userAddress");
    return;
  }

  let consumed = false;
  try {
    consumed = await consumeNonce(userAddress, rawNonce);
  } catch {
    unauthorized(reply, "Nonce store unavailable");
    return;
  }

  if (!consumed) {
    unauthorized(reply, "Nonce is unknown, expired or already used");
    return;
  }
}
