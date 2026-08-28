import { afterEach, describe, expect, it, vi } from "vitest";
import { OracleService } from "./oracle-service.js";
import type {
  ProviderAdapter,
  ProviderResult,
  ResolutionRequest,
} from "./provider-adapter.js";

function adapter(
  source: string,
  resolve: ProviderAdapter["resolve"]
): ProviderAdapter {
  return {
    getSource: () => source,
    healthCheck: vi.fn().mockResolvedValue(false),
    resolve,
  };
}

const request: ResolutionRequest = {
  marketId: "integration-market",
  oracleAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

const result: ProviderResult = {
  outcome: true,
  confidence: 1,
  confidenceMetadata: { score: 1, method: "integration" },
  source: "primary",
  sourceMetadata: { provider: "primary" },
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("OracleService provider boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed in production before invoking the fallback boundary", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fallbackResolve = vi.fn().mockResolvedValue({
      ...result,
      source: "fallback",
    });
    const service = new OracleService({
      primaryAdapter: adapter(
        "primary",
        vi.fn().mockRejectedValue(new Error("primary unavailable"))
      ),
      fallbackAdapter: adapter("fallback", fallbackResolve),
      enableFallback: true,
    });

    await expect(service.resolve(request)).rejects.toThrow(
      "primary unavailable"
    );
    expect(fallbackResolve).not.toHaveBeenCalled();
  });

  it("uses the fallback boundary in development after primary failure", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fallbackResolve = vi.fn().mockResolvedValue({
      ...result,
      source: "fallback",
    });
    const service = new OracleService({
      primaryAdapter: adapter(
        "primary",
        vi.fn().mockRejectedValue(new Error("primary unavailable"))
      ),
      fallbackAdapter: adapter("fallback", fallbackResolve),
      enableFallback: true,
    });

    await expect(service.resolve(request)).resolves.toMatchObject({
      source: "fallback",
    });
    expect(fallbackResolve).toHaveBeenCalledTimes(1);
  });
});
