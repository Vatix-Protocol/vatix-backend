import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { buildSignableMessage } from "../../../src/api/middleware/stellarAuth.js";
import { issueChallenge } from "../../../src/api/middleware/nonceStore.js";
import { testUtils, type TestMarketOverrides } from "../../setup.js";

/** Seeds an ACTIVE test market unless overridden. Thin wrapper around testUtils.createTestMarket. */
export async function seedMarket(overrides: TestMarketOverrides = {}) {
  return testUtils.createTestMarket({ status: "ACTIVE", ...overrides });
}

export interface PlaceOrderInput {
  marketId: string;
  side: "BUY" | "SELL";
  outcome: "YES" | "NO";
  price: number;
  quantity: number;
}

/**
 * Places an order against a Fastify app that has ordersRoutes registered,
 * signing the request with the given keypair. Returns the raw inject response.
 */
export async function placeOrder(
  app: FastifyInstance,
  keypair: Keypair,
  input: PlaceOrderInput
) {
  const userAddress = keypair.publicKey();
  const payload = { ...input, userAddress };
  const timestamp = Date.now();
  const { nonce } = await issueChallenge(userAddress);
  const signature = keypair
    .sign(buildSignableMessage({ ...payload, nonce, timestamp }))
    .toString("base64");

  return app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: {
      "x-signature": signature,
      "x-timestamp": String(timestamp),
      "x-nonce": nonce,
    },
    payload,
  });
}
