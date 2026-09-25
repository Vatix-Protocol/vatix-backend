export interface ChainEvent {
  blockNumber: number;
  txHash: string;
  data: unknown;
}

export interface EventFetcher {
  fetchEvents(fromBlock: number, toBlock: number): Promise<ChainEvent[]>;
}

export class RpcEventFetcher implements EventFetcher {
  constructor(private readonly rpcUrl: string) {}

  async fetchEvents(fromBlock: number, toBlock: number): Promise<ChainEvent[]> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getLogs",
        params: [
          {
            fromBlock: `0x${fromBlock.toString(16)}`,
            toBlock: `0x${toBlock.toString(16)}`,
          },
        ],
        id: 1,
      }),
    });

    if (!response.ok) {
      throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { result?: unknown[]; error?: { message: string } };

    if (body.error) {
      throw new Error(`RPC error: ${body.error.message}`);
    }

    return (body.result ?? []).map((log, i) => ({
      blockNumber: fromBlock + i,
      txHash: String((log as Record<string, unknown>).transactionHash ?? ""),
      data: log,
    }));
  }
}
