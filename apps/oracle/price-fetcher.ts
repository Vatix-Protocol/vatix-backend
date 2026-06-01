import type { ILogger } from "../../packages/shared/src/logger.js";

export interface PriceFetcherConfig {
  assetId: string;
  timeoutMs: number;
}

export class PriceFetcherValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "PriceFetcherValidationError";
  }
}

export class PriceFetcher {
  constructor(private readonly logger: ILogger, private readonly config: PriceFetcherConfig) {
    if (!config.assetId || typeof config.assetId !== "string") {
      throw new PriceFetcherValidationError("Invalid assetId: must be a non-empty string");
    }
    if (typeof config.timeoutMs !== "number" || config.timeoutMs <= 0 || isNaN(config.timeoutMs)) {
      throw new PriceFetcherValidationError("Invalid timeoutMs: must be a positive number");
    }
  }

  async fetchPrice(): Promise<number> {
    this.logger.info("Initiating price fetch", {
      assetId: this.config.assetId,
      timeoutMs: this.config.timeoutMs,
      timestamp: new Date().toISOString(),
    });

    try {
      // Mock price fetch implementation
      const price = 100.5;
      
      this.logger.info("Price fetch successful", {
        assetId: this.config.assetId,
        price,
        timestamp: new Date().toISOString(),
      });
      
      return price;
    } catch (error) {
      this.logger.error("Price fetch failed", {
        assetId: this.config.assetId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }
}
