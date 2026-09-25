import type { EventFetcher, ChainEvent } from "./event-fetcher.js";

export interface IngestionConfig {
  pollIntervalMs: number;
  batchSize: number;
}

export type EventHandler = (events: ChainEvent[]) => Promise<void>;

export class PollingIngestionLoop {
  private running = false;
  private currentBlock: number;

  constructor(
    private readonly fetcher: EventFetcher,
    private readonly onEvents: EventHandler,
    private readonly config: IngestionConfig,
    startBlock: number = 0
  ) {
    this.currentBlock = startBlock;
  }

  get cursor(): number {
    return this.currentBlock;
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const toBlock = this.currentBlock + this.config.batchSize - 1;
      const events = await this.fetcher.fetchEvents(this.currentBlock, toBlock);
      await this.onEvents(events);
      this.currentBlock = toBlock + 1;
      if (this.running) {
        await this.sleep(this.config.pollIntervalMs);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
