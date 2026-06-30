export interface ChainEvent {
  blockNumber: number;
  txHash: string;
  data: unknown;
}

export interface EventFetcher {
  fetchEvents(fromBlock: number, toBlock: number): Promise<ChainEvent[]>;
}
