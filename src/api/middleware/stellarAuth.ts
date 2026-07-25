import type { FastifyRequest, FastifyReply } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { unauthorized } from "./responses.js";

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Builds the canonical UTF-8 message buffer that a user must sign when placing
 * an order.  Keys are sorted alphabetically so the serialisation is deterministic
 * regardless of how the caller constructs the object.
 */
export function buildSignableMessage(fields: {
  marketId: string;
  outcome: string;
  price: number;
  quantity: number;
  side: string;
  timestamp: number;
  userAddress: string;
}): Buffer {
  const payload = JSON.stringify({
    marketId: fields.marketId,
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
 * Fastify preHandler hook that enforces Stellar wallet ownership before an order
 * is processed.
 *
 * Required headers:
 *   x-signature  – base64-encoded Ed25519 signature of the canonical message
 *   x-timestamp  – milliseconds since Unix epoch (string); must be within ±5 min
 *
 * The canonical message is built from the parsed request body fields combined
 * with the timestamp from the header, so a replay of an identical body with a
 * stale timestamp is rejected even if the signature itself was once valid.
 *
 * Returns HTTP 401 for any authentication failure; delegates all other
 * validation to the route handler.
 */
export function verifyStellarSignature(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const rawSig = request.headers["x-signature"];
  const rawTs = request.headers["x-timestamp"];

  if (!rawSig || typeof rawSig !== "string") {
    unauthorized(reply, "Missing x-signature header");
    return;
  }

  if (!rawTs || typeof rawTs !== "string") {
    unauthorized(reply, "Missing x-timestamp header");
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

  done();
}
