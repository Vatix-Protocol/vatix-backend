import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EventFetcher,
  EventFetcherConfigError,
  CursorStallError,
} from "./eventFetcher.js";
import type { Telemetry } from "./telemetry.js";

const makeEvent = (ledger: number, id = `evt-${ledger}`) => ({
  id,
  ledger,
  ledgerClosedAt: "2024-01-01T00:00:00Z",
  contractId: "CTEST",
  type: "contract",
  pagingToken: `token-${id}`,
  value: { xdr: "AAAAAA==" },
  topic: [{ xdr: "BBBBBB==" }],
});

function makeMockServer(pages: ReturnType<typeof makeEvent>[][]) {
  let call = 0;
  return {
    getEvents: vi.fn(async () => {
      const events = pages[call] ?? [];
      call++;
      return { events, latestLedger: 100 };
    }),
  };
}

function makeFetcher(mockServer: any, telemetry: Telemetry) {
  const fetcher = new EventFetcher(
    { rpcUrl: "https://rpc.example.com", contractId: "CTEST" },
    telemetry
  );
  injectMockRpc(fetcher, mockServer);
  return fetcher;
}

function injectMockRpc(fetcher: EventFetcher, mockServer: any) {
  (fetcher as any).server = mockServer;
  (fetcher as any).transport = {
    execute: async (fn: (url: string) => Promise<unknown>) =>
      fn("https://rpc.example.com"),
    getActiveEndpoint: () => "https://rpc.example.com",
  };
}

describe("EventFetcher", () => {
  let telemetry: Telemetry;
  let recorded: Array<{
    metric: string;
    value: number;
    tags?: Record<string, string>;
  }>;

  beforeEach(() => {
    recorded = [];
    telemetry = {
      record: (m, v, t) => recorded.push({ metric: m, value: v, tags: t }),
    };
  });

  it("returns events within the ledger window", async () => {
    const server = makeMockServer([
      [makeEvent(10), makeEvent(20), makeEvent(30)],
    ]);
    const fetcher = makeFetcher(server, telemetry);

    const result = await fetcher.fetchByLedgerWindow({
      startLedger: 10,
      endLedger: 20,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.ledger)).toEqual([10, 20]);
  });

  it("paginates until no cursor remains", async () => {
    const page1 = [makeEvent(10, "a"), makeEvent(11, "b")];
    const page2 = [makeEvent(12, "c")];
    const server = makeMockServer([page1, page2]);
    page1[1].pagingToken = "cursor-next";

    const fetcher = new EventFetcher(
      { rpcUrl: "https://rpc.example.com", contractId: "CTEST", pageLimit: 2 },
      telemetry
    );
    injectMockRpc(fetcher, server);

    const result = await fetcher.fetchByLedgerWindow({
      startLedger: 10,
      endLedger: 12,
    });

    expect(result.events).toHaveLength(3);
    expect(server.getEvents).toHaveBeenCalledTimes(2);
  });

  it("retries on transient error then succeeds", async () => {
    const mockServer = {
      getEvents: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
        )
        .mockResolvedValueOnce({ events: [makeEvent(5)], latestLedger: 10 }),
    };

    const fetcher = new EventFetcher(
      {
        rpcUrl: "https://rpc.example.com",
        contractId: "CTEST",
        retryDelayMs: 0,
      },
      telemetry
    );
    injectMockRpc(fetcher, mockServer);

    const result = await fetcher.fetchByLedgerWindow({
      startLedger: 5,
      endLedger: 5,
    });

    expect(result.events).toHaveLength(1);
    expect(mockServer.getEvents).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on transient error", async () => {
    const err = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const mockServer = { getEvents: vi.fn().mockRejectedValue(err) };

    const fetcher = new EventFetcher(
      {
        rpcUrl: "https://rpc.example.com",
        contractId: "CTEST",
        maxRetries: 2,
        retryDelayMs: 0,
      },
      telemetry
    );
    injectMockRpc(fetcher, mockServer);

    await expect(
      fetcher.fetchByLedgerWindow({ startLedger: 1, endLedger: 5 })
    ).rejects.toThrow("socket hang up");

    expect(mockServer.getEvents).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("throws immediately on non-transient error", async () => {
    const mockServer = {
      getEvents: vi.fn().mockRejectedValue(new Error("bad request")),
    };

    const fetcher = makeFetcher(mockServer, telemetry);

    await expect(
      fetcher.fetchByLedgerWindow({ startLedger: 1, endLedger: 5 })
    ).rejects.toThrow("bad request");

    expect(mockServer.getEvents).toHaveBeenCalledTimes(1);
  });

  it("emits telemetry with fetched event count", async () => {
    const server = makeMockServer([[makeEvent(1), makeEvent(2)]]);
    const fetcher = makeFetcher(server, telemetry);

    await fetcher.fetchByLedgerWindow({ startLedger: 1, endLedger: 2 });

    const summary = recorded.find((r) => r.metric === "indexer.events.fetched");
    expect(summary).toBeDefined();
    expect(summary!.value).toBe(2);
    expect(summary!.tags).toMatchObject({ startLedger: "1", endLedger: "2" });
  });

  describe("RPC disconnect backoff (Issue #710)", () => {
    it("resets consecutiveDisconnections on successful fetch", async () => {
      const server = makeMockServer([[makeEvent(1)]]);
      const fetcher = makeFetcher(server, telemetry);
      (fetcher as any).consecutiveDisconnections = 3;

      await fetcher.fetchByLedgerWindow({ startLedger: 1, endLedger: 1 });

      expect((fetcher as any).consecutiveDisconnections).toBe(0);
    });

    it("increments consecutiveDisconnections on transient error", async () => {
      const err = Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      });
      const mockServer = {
        getEvents: vi.fn().mockRejectedValue(err),
      };
      const fetcher = makeFetcher(mockServer, telemetry);
      (fetcher as any).config.maxRetries = 1;
      (fetcher as any).config.retryDelayMs = 0;

      await expect(
        fetcher.fetchByLedgerWindow({ startLedger: 1, endLedger: 5 })
      ).rejects.toThrow();

      // 1 initial + 1 retry = 2 failures total, should increment by 2
      expect((fetcher as any).consecutiveDisconnections).toBe(2);
    });

    it("does not increment consecutiveDisconnections on non-transient error", async () => {
      const mockServer = {
        getEvents: vi.fn().mockRejectedValue(new Error("bad request")),
      };
      const fetcher = makeFetcher(mockServer, telemetry);

      await expect(
        fetcher.fetchByLedgerWindow({ startLedger: 1, endLedger: 5 })
      ).rejects.toThrow();

      expect((fetcher as any).consecutiveDisconnections).toBe(0);
    });

    it("applies extended backoff when consecutiveDisconnections exceeds threshold", async () => {
      vi.useFakeTimers();

      try {
        const err = Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        });
        const mockServer = {
          getEvents: vi.fn().mockRejectedValue(err),
        };
        const fetcher = makeFetcher(mockServer, telemetry);
        (fetcher as any).config.maxRetries = 0;
        (fetcher as any).config.retryDelayMs = 0;
        (fetcher as any).config.fetchTimeoutMs = 0;
        // Set consecutive disconnections above threshold
        (fetcher as any).consecutiveDisconnections = 5;

        // Attach rejection handler before advancing timers so a fast failure
        // cannot surface as an unhandled rejection between settle and await.
        const fetchPromise = fetcher
          .fetchByLedgerWindow({
            startLedger: 1,
            endLedger: 5,
          })
          .catch(() => undefined);

        // Advance past the DISCONNECTED_BACKOFF_MS (10_000ms) sleep so the
        // fetch proceeds, fails, and the promise settles.
        await vi.advanceTimersByTimeAsync(10_001);
        await fetchPromise;

        const backoffMetric = recorded.find(
          (r) => r.metric === "indexer.rpc.disconnected_backoff"
        );
        expect(backoffMetric).toBeDefined();
        expect(backoffMetric!.tags?.consecutiveDisconnections).toBe("5");
      } finally {
        vi.useRealTimers();
      }
    });

    it("telemetry records disconnection events", async () => {
      const err = Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      });
      const mockServer = {
        getEvents: vi.fn().mockRejectedValue(err),
      };
      const fetcher = makeFetcher(mockServer, telemetry);
      (fetcher as any).config.maxRetries = 0;
      (fetcher as any).config.retryDelayMs = 0;

      await expect(
        fetcher.fetchByLedgerWindow({ startLedger: 1, endLedger: 5 })
      ).rejects.toThrow();

      const disconnectionMetric = recorded.find(
        (r) => r.metric === "indexer.rpc.disconnection"
      );
      expect(disconnectionMetric).toBeDefined();
      expect(disconnectionMetric!.tags?.consecutive).toBe("1");
    });

    it("exposes consecutive disconnections via getConsecutiveDisconnections()", () => {
      const server = makeMockServer([[makeEvent(1)]]);
      const fetcher = makeFetcher(server, telemetry);
      expect(fetcher.getConsecutiveDisconnections()).toBe(0);
      (fetcher as any).consecutiveDisconnections = 7;
      expect(fetcher.getConsecutiveDisconnections()).toBe(7);
    });
  });

  describe("per-page fetch timeout", () => {
    it("aborts a hanging getEvents call after fetchTimeoutMs and treats it as transient", async () => {
      vi.useFakeTimers();
      try {
        const mockServer = {
          getEvents: vi.fn(
            () =>
              new Promise<never>(() => {
                /* never resolves — simulates a hung RPC */
              })
          ),
        };

        const fetcher = new EventFetcher(
          {
            rpcUrl: "https://rpc.example.com",
            contractId: "CTEST",
            fetchTimeoutMs: 5_000,
            maxRetries: 0,
            retryDelayMs: 0,
          },
          telemetry
        );
        injectMockRpc(fetcher, mockServer);

        const fetchPromise = fetcher
          .fetchByLedgerWindow({ startLedger: 1, endLedger: 5 })
          .catch((e) => e);

        await vi.advanceTimersByTimeAsync(5_001);
        const result = await fetchPromise;

        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });

    it("records a transient disconnection metric on timeout", async () => {
      vi.useFakeTimers();
      try {
        const mockServer = {
          getEvents: vi.fn(
            () =>
              new Promise<never>(() => {
                /* never resolves */
              })
          ),
        };

        const fetcher = new EventFetcher(
          {
            rpcUrl: "https://rpc.example.com",
            contractId: "CTEST",
            fetchTimeoutMs: 3_000,
            maxRetries: 0,
            retryDelayMs: 0,
          },
          telemetry
        );
        injectMockRpc(fetcher, mockServer);

        const fetchPromise = fetcher
          .fetchByLedgerWindow({ startLedger: 1, endLedger: 5 })
          .catch(() => {});

        await vi.advanceTimersByTimeAsync(3_001);
        await fetchPromise;

        const disconnectionMetric = recorded.find(
          (r) => r.metric === "indexer.rpc.disconnection"
        );
        expect(disconnectionMetric).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips the timeout when fetchTimeoutMs is 0", async () => {
      const server = makeMockServer([[makeEvent(1)]]);
      const fetcher = new EventFetcher(
        {
          rpcUrl: "https://rpc.example.com",
          contractId: "CTEST",
          fetchTimeoutMs: 0,
        },
        telemetry
      );
      injectMockRpc(fetcher, server);

      const result = await fetcher.fetchByLedgerWindow({
        startLedger: 1,
        endLedger: 1,
      });
      expect(result.events).toHaveLength(1);
    });
  });
});
