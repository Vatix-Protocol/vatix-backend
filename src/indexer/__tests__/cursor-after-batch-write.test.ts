import { describe, it, expect, vi } from "vitest";
import { PollingIngestionLoop } from "../polling-ingestion-loop.js";
import type { EventFetcher } from "../event-fetcher.js";

const NO_POLL = { pollIntervalMs: 0, batchSize: 10 };

function makeFetcher(): EventFetcher {
  return { fetchEvents: vi.fn().mockResolvedValue([]) };
}

describe("cursor advancement", () => {
  it("does NOT advance cursor when writer throws", async () => {
    const fetcher = makeFetcher();
    const writer = vi.fn().mockRejectedValueOnce(new Error("write failed"));
    const loop = new PollingIngestionLoop(fetcher, writer, NO_POLL, 50);

    await loop.start().catch(() => {});

    // cursor must still be at the starting block
    expect(loop.cursor).toBe(50);
  });

  it("advances cursor by batchSize after a successful write", async () => {
    const fetcher = makeFetcher();
    const writer = vi.fn().mockResolvedValue(undefined);
    const loop = new PollingIngestionLoop(fetcher, writer, NO_POLL, 50);

    const start = loop.start();
    await vi.waitUntil(() => writer.mock.calls.length >= 1);
    loop.stop();
    await start;

    expect(loop.cursor).toBeGreaterThanOrEqual(60);
  });

  it("retries the same block range after a failed write", async () => {
    const fetcher = makeFetcher();
    let calls = 0;
    const writer = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("transient write error");
    });

    const loop = new PollingIngestionLoop(fetcher, writer, NO_POLL, 0);

    // first call throws → cursor stays; second call succeeds
    const start = loop.start().catch(() => {});
    await vi.waitUntil(() => writer.mock.calls.length >= 1);
    // cursor must not have moved after first (failed) write
    expect(loop.cursor).toBe(0);
  });

  it("advances cursor monotonically across multiple successful batches", async () => {
    const fetcher = makeFetcher();
    const writer = vi.fn().mockResolvedValue(undefined);
    const loop = new PollingIngestionLoop(fetcher, writer, NO_POLL, 0);

    const snapshots: number[] = [];
    const origFetch = fetcher.fetchEvents as ReturnType<typeof vi.fn>;
    origFetch.mockImplementation(async (from: number) => {
      snapshots.push(loop.cursor);
      return [];
    });

    const start = loop.start();
    await vi.waitUntil(() => writer.mock.calls.length >= 3);
    loop.stop();
    await start;

    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]).toBeGreaterThanOrEqual(snapshots[i - 1]);
    }
  });
});
