import { describe, it, expect, vi } from "vitest";
import { PollingIngestionLoop } from "../polling-ingestion-loop.js";
import type { EventFetcher, ChainEvent } from "../event-fetcher.js";

function makeFetcher(events: ChainEvent[] = []): EventFetcher {
  return { fetchEvents: vi.fn().mockResolvedValue(events) };
}

const NO_POLL = { pollIntervalMs: 0, batchSize: 10 };

describe("PollingIngestionLoop", () => {
  it("calls fetcher with the correct block range", async () => {
    const fetcher = makeFetcher();
    const handler = vi.fn().mockResolvedValue(undefined);
    const loop = new PollingIngestionLoop(fetcher, handler, NO_POLL, 100);

    // run one iteration then stop
    const start = loop.start();
    await vi.waitUntil(() => (fetcher.fetchEvents as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
    loop.stop();
    await start;

    expect(fetcher.fetchEvents).toHaveBeenCalledWith(100, 109);
  });

  it("passes fetched events to the handler", async () => {
    const event: ChainEvent = { blockNumber: 1, txHash: "0xabc", data: {} };
    const fetcher = makeFetcher([event]);
    const handler = vi.fn().mockResolvedValue(undefined);
    const loop = new PollingIngestionLoop(fetcher, handler, NO_POLL, 0);

    const start = loop.start();
    await vi.waitUntil(() => handler.mock.calls.length >= 1);
    loop.stop();
    await start;

    expect(handler).toHaveBeenCalledWith([event]);
  });

  it("advances cursor by batchSize after each iteration", async () => {
    const fetcher = makeFetcher();
    const handler = vi.fn().mockResolvedValue(undefined);
    const loop = new PollingIngestionLoop(fetcher, handler, NO_POLL, 0);

    const start = loop.start();
    await vi.waitUntil(() => handler.mock.calls.length >= 2);
    loop.stop();
    await start;

    expect(loop.cursor).toBeGreaterThanOrEqual(20);
  });

  it("stops processing when stop() is called", async () => {
    const fetcher = makeFetcher();
    const handler = vi.fn().mockResolvedValue(undefined);
    const loop = new PollingIngestionLoop(fetcher, handler, NO_POLL, 0);

    const start = loop.start();
    await vi.waitUntil(() => handler.mock.calls.length >= 1);
    loop.stop();
    await start;

    const callsAfterStop = handler.mock.calls.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(handler.mock.calls.length).toBe(callsAfterStop);
  });
});
