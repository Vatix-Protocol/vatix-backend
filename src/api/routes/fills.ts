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

interface FillStreamQuerystring {
  /** Explicit resume cursor (ISO timestamp), used when a client cannot set
   *  request headers (e.g. EventSource does not expose Last-Event-ID on the
   *  initial connect). Ignored if the Last-Event-ID header is present. */
  since?: string;
}

/**
 * Resolves the cursor a reconnecting client should resume from, so fills
 * that occurred during a disconnect gap are not silently dropped.
 *
 * Browsers' native EventSource automatically resends the last received
 * event's `id:` field as the `Last-Event-ID` header on reconnect, so that
 * takes priority. The `?since=` query param is a fallback for clients that
 * can't set headers. Falls back to `null` (caller should use "now") for a
 * fresh connection or an unparseable cursor.
 */
export function parseResumeCursor(
  lastEventIdHeader: string | string[] | undefined,
  sinceQuery: string | undefined
): Date | null {
  const raw = Array.isArray(lastEventIdHeader)
    ? lastEventIdHeader[0]
    : (lastEventIdHeader ?? sinceQuery);

  if (!raw) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  fastify.get<{ Params: FillStreamParams; Querystring: FillStreamQuerystring }>(
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
        querystring: {
          type: "object",
          properties: {
            since: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: FillStreamParams;
        Querystring: FillStreamQuerystring;
      }>,
      reply
    ) => {
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

      let since =
        parseResumeCursor(
          request.headers["last-event-id"],
          request.query.since
        ) ?? new Date();

      const sendEvent = (event: string, data: unknown, id?: string) => {
        const idLine = id ? `id: ${id}\n` : "";
        reply.raw.write(
          `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        );
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
          sendEvent("order_fill", event, fill.tradedAt.toISOString());
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
