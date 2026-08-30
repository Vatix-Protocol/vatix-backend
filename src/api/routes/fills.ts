import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { fillsResumeService } from "../../services/fills-resume.js";
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
  /** Explicit resume cursor (stream ID or ISO timestamp), used when a client cannot set
   *  request headers (e.g. EventSource does not expose Last-Event-ID on the
   *  initial connect). Ignored if the Last-Event-ID header is present. */
  after?: string;
}

/**
 * Resolves the cursor a reconnecting client should resume from, so fills
 * that occurred during a disconnect gap are not silently dropped.
 *
 * Browsers' native EventSource automatically resends the last received
 * event's `id:` field as the `Last-Event-ID` header on reconnect, so that
 * takes priority. The `?after=` query param is a fallback for clients that
 * can't set headers. Falls back to `null` (caller should use "now") for a
 * fresh connection or an unparseable cursor.
 */
export function parseResumeCursor(
  lastEventIdHeader: string | string[] | undefined,
  afterQuery: string | undefined
): string | null {
  const raw = Array.isArray(lastEventIdHeader)
    ? lastEventIdHeader[0]
    : (lastEventIdHeader ?? afterQuery);

  if (!raw) return null;

  // Use fillsResumeService to parse cursor (supports stream ID and ISO format)
  return fillsResumeService.parseCursor(raw);
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
            after: { type: "string" },
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

      // Parse resume cursor from Last-Event-ID header or ?after= query
      const rawCursor = parseResumeCursor(
        request.headers["last-event-id"],
        request.query.after
      );

      // If client provided a cursor, check for gaps
      if (rawCursor) {
        const gap = await fillsResumeService.detectGap(rawCursor);

        if (gap.hasGap) {
          // Return 410 Gone with recovery guidance
          request.log.warn(
            { wallet, cursor: rawCursor, reason: gap.reason },
            "Fill stream cursor stale or trimmed"
          );

          return reply.status(410).send({
            error: "stream_gap",
            message:
              "Requested resume cursor is stale or has been trimmed from the stream.",
            reason: gap.reason,
            suggestedCursor: gap.suggestedCursor,
            guidance:
              "Reconnect without Last-Event-ID to get current fills, or use suggestedCursor to catch up.",
          });
        }
      }

      // Determine starting cursor: use provided cursor or start from now
      let currentCursor = rawCursor ?? `${Date.now()}-0`;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // Disable proxy buffering (nginx) so events flush immediately.
        "X-Accel-Buffering": "no",
      });

      const sendEvent = (event: string, data: unknown, id?: string) => {
        const idLine = id ? `id: ${id}\n` : "";
        reply.raw.write(
          `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        );
      };

      // Send connected event with bounds info for client reference
      const bounds = await fillsResumeService.getReplayBounds(wallet);
      sendEvent("connected", {
        wallet,
        cursor: currentCursor,
        minCursor: bounds.minCursor,
        maxCursor: bounds.maxCursor,
        recordCount: bounds.recordCount,
      });

      // On reconnect with cursor, replay bounded window of missed fills
      if (rawCursor && rawCursor !== currentCursor) {
        try {
          const { trades: replayed } =
            await fillsResumeService.getTradesAfterCursor(
              wallet,
              rawCursor,
              100
            );

          if (replayed.length > 0) {
            sendEvent("replay_start", { count: replayed.length });

            for (const trade of replayed) {
              const event: OrderFillEvent = {
                tradeId: trade.tradeId,
                marketId: trade.marketId,
                outcome: trade.outcome,
                side: trade.side,
                orderId: trade.orderId,
                counterpartyAddress: trade.counterpartyAddress,
                price: trade.price,
                quantity: trade.quantity,
                tradedAt: trade.tradedAt.toISOString(),
              };
              sendEvent("order_fill", event, trade.streamId);
            }

            sendEvent("replay_end", { replayed: replayed.length });
            currentCursor = replayed[replayed.length - 1].streamId;
          }
        } catch (error) {
          request.log.error(
            { wallet, cursor: rawCursor, error },
            "Failed to replay fills"
          );
          sendEvent("replay_error", {
            message: "Failed to replay missed fills",
          });
        }
      }

      // Long-poll for new fills
      const poll = async () => {
        try {
          const { trades: fills } =
            await fillsResumeService.getTradesAfterCursor(
              wallet,
              currentCursor,
              100
            );

          for (const fill of fills) {
            const event: OrderFillEvent = {
              tradeId: fill.tradeId,
              marketId: fill.marketId,
              outcome: fill.outcome,
              side: fill.side,
              orderId: fill.orderId,
              counterpartyAddress: fill.counterpartyAddress,
              price: fill.price,
              quantity: fill.quantity,
              tradedAt: fill.tradedAt.toISOString(),
            };
            sendEvent("order_fill", event, fill.streamId);
            currentCursor = fill.streamId;
          }
        } catch (error) {
          request.log.error({ error }, "order fill stream poll failed");
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
