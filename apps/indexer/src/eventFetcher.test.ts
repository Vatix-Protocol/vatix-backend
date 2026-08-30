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
  // Inject mock server
  (fetcher as any).server = mockServer;
  return fetcher;
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
    (fetcher as any).server = server;

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
    (fetcher as any).server = mockServer;

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
    (fetcher as any).server = mockServer;

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

  it("backs off and recovers on a 429 rate-limit response", async () => {
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    const mockServer = {
      getEvents: vi
        .fn()
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValueOnce({ events: [makeEvent(7)], latestLedger: 10 }),
    };

    const fetcher = new EventFetcher(
      { rpcUrl: "https://rpc.example.com", contractId: "CTEST" },
      telemetry
    );
    (fetcher as any).server = mockServer;

    const result = await fetcher.fetchByLedgerWindow({
      startLedger: 7,
      endLedger: 7,
    });

    expect(result.events).toHaveLength(1);
    expect(mockServer.getEvents).toHaveBeenCalledTimes(2);
    expect(recorded.some((r) => r.metric === "indexer.rpc.rate_limited")).toBe(
      true
    );
  });

  it("throws once rate-limit retries are exhausted (does not stall the cursor forever)", async () => {
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    const mockServer = { getEvents: vi.fn().mockRejectedValue(rateLimitErr) };

    const fetcher = new EventFetcher(
      { rpcUrl: "https://rpc.example.com", contractId: "CTEST" },
      telemetry
    );
    (fetcher as any).server = mockServer;

    await expect(
      fetcher.fetchByLedgerWindow({ startLedger: 1, endLedger: 5 })
    ).rejects.toThrow("Too Many Requests");

    expect(
      recorded.some((r) => r.metric === "indexer.rpc.rate_limited_exhausted")
    ).toBe(true);
  });

  it("throws CursorStallError when the same paging cursor keeps repeating", async () => {
    const stuckEvent = makeEvent(1, "stuck");
    stuckEvent.pagingToken = "same-token";
    const mockServer = {
      getEvents: vi.fn().mockResolvedValue({
        events: [stuckEvent],
        latestLedger: 10,
      }),
    };

    const fetcher = new EventFetcher(
      { rpcUrl: "https://rpc.example.com", contractId: "CTEST", pageLimit: 1 },
      telemetry
    );
    (fetcher as any).server = mockServer;

    await expect(
      fetcher.fetchByLedgerWindow({ startLedger: 1, endLedger: 5 })
    ).rejects.toThrow(CursorStallError);
  });

  describe("production configuration guardrails", () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it("fails fast in production when rpcUrl is not https", () => {
      process.env.NODE_ENV = "production";
      expect(
        () =>
          new EventFetcher({
            rpcUrl: "http://localhost:8000",
            contractId: "CTEST",
          })
      ).toThrow(EventFetcherConfigError);
    });

    it("fails fast in production when contractId is missing", () => {
      process.env.NODE_ENV = "production";
      expect(
        () =>
          new EventFetcher({
            rpcUrl: "https://rpc.example.com",
            contractId: "",
          })
      ).toThrow(EventFetcherConfigError);
    });

    it("allows relaxed config outside production", () => {
      process.env.NODE_ENV = "test";
      expect(
        () =>
          new EventFetcher({
            rpcUrl: "http://localhost:8000",
            contractId: "CTEST",
          })
      ).not.toThrow();
    });
  });
});
