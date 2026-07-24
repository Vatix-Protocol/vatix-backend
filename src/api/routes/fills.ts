import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import {
  validateUserAddress,
  STELLAR_PUBLIC_KEY_REGEX,
} from "../../matching/validation.js";
import { ValidationError } from "../middleware/errors.js";
import { heavyReadLimiter } from "../middleware/rateLimiter.js";

/** How often the stream polls for new fills. Default: 2000ms. */
const pollIntervalEnv = process.env.ORDER_FILL_STREAM_POLL_MS;
export const ORDER_FILL_STREAM_POLL_MS = pollIntervalEnv
  ? parseInt(pollIntervalEnv, 10)
  : 2000;

/** Comment ping sent to keep intermediary proxies from closing the connection. */
const HEARTBEAT_INTERVAL_MS = 15000;

interface FillStreamParams {
  wallet: string;
}

export interface OrderFillEvent {
  tradeId: string;
  marketId: string;
  outcome: string;
  side: "BUY" | "SELL";
  orderId: string;
  counterpartyAddress: string;
  price: number;
  quantity: number;
  tradedAt: string;
}

export async function fillsRoutes(fastify: FastifyInstance) {
  const prisma = getPrismaClient();

  // Server-Sent Events stream of order fill notifications for a wallet.
  // Only fills that occur after the client connects are pushed — historical
  // fills are already served by GET /trades/user/:address.
  fastify.get<{ Params: FillStreamParams }>(
    "/wallets/:wallet/fills/stream",
    {
      onRequest: [heavyReadLimiter],
      schema: {
        params: {
          type: "object",
          required: ["wallet"],
          properties: {
            wallet: {
              type: "string",
              pattern: STELLAR_PUBLIC_KEY_REGEX.source,
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: FillStreamParams }>, reply) => {
      const { wallet } = request.params;

      const addressError = validateUserAddress(wallet);
      if (addressError) {
        throw new ValidationError(addressError);
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // Disable proxy buffering (nginx) so events flush immediately.
        "X-Accel-Buffering": "no",
      });

      let since = new Date();

      const sendEvent = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent("connected", { wallet, since: since.toISOString() });

      const poll = async () => {
        let fills;
        try {
          fills = await prisma.trade.findMany({
            where: {
              tradedAt: { gt: since },
              OR: [{ buyerAddress: wallet }, { sellerAddress: wallet }],
            },
            orderBy: { tradedAt: "asc" },
          });
        } catch (error) {
          request.log.error({ error }, "order fill stream poll failed");
          return;
        }

        for (const fill of fills) {
          if (fill.tradedAt > since) since = fill.tradedAt;

          const isBuyer = fill.buyerAddress === wallet;
          const event: OrderFillEvent = {
            tradeId: fill.tradeId,
            marketId: fill.marketId,
            outcome: fill.outcome,
            side: isBuyer ? "BUY" : "SELL",
            orderId: isBuyer ? fill.buyOrderId : fill.sellOrderId,
            counterpartyAddress: isBuyer
              ? fill.sellerAddress
              : fill.buyerAddress,
            price: Number(fill.price),
            quantity: fill.quantity,
            tradedAt: fill.tradedAt.toISOString(),
          };
          sendEvent("order_fill", event);
        }
      };

      const pollTimer = setInterval(() => {
        void poll();
      }, ORDER_FILL_STREAM_POLL_MS);

      const heartbeatTimer = setInterval(() => {
        reply.raw.write(": heartbeat\n\n");
      }, HEARTBEAT_INTERVAL_MS);

      await new Promise<void>((resolve) => {
        request.raw.on("close", () => {
          clearInterval(pollTimer);
          clearInterval(heartbeatTimer);
          resolve();
        });
      });
    }
  );
}
