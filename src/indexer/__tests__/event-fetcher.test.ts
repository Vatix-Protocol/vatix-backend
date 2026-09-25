import { describe, it, expect, vi, afterEach } from "vitest";
import { RpcEventFetcher } from "../event-fetcher.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RpcEventFetcher", () => {
  it("calls fetch with correct JSON-RPC payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const fetcher = new RpcEventFetcher("http://localhost:8545");
    await fetcher.fetchEvents(100, 199);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8545");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.method).toBe("eth_getLogs");
    expect((body.params as unknown[][])[0]).toMatchObject({
      fromBlock: "0x64",
      toBlock: "0xc7",
    });
  });

  it("returns mapped ChainEvent list from RPC result", async () => {
    const mockLog = { transactionHash: "0xdeadbeef", extra: true };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: [mockLog] }),
    }));

    const fetcher = new RpcEventFetcher("http://localhost:8545");
    const events = await fetcher.fetchEvents(5, 5);

    expect(events).toHaveLength(1);
    expect(events[0].blockNumber).toBe(5);
    expect(events[0].txHash).toBe("0xdeadbeef");
    expect(events[0].data).toEqual(mockLog);
  });

  it("throws when RPC response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    }));

    const fetcher = new RpcEventFetcher("http://localhost:8545");
    await expect(fetcher.fetchEvents(0, 9)).rejects.toThrow("RPC request failed: 503");
  });

  it("throws on RPC-level error in response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { message: "rate limited" } }),
    }));

    const fetcher = new RpcEventFetcher("http://localhost:8545");
    await expect(fetcher.fetchEvents(0, 9)).rejects.toThrow("RPC error: rate limited");
  });
});
