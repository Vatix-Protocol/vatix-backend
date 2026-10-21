import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GapDetector,
  type GapDetectorConfig,
  type GapPagingConfig,
} from "./gapDetector.js";
import { WebhookUrlError } from "./webhookUrlPolicy.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal fetch-like stub. Records every call so tests can assert that no
 * real outbound request is made and that the paging payload carries no
 * secret material.
 */
function makeFetchStub() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response("ok", { status: 200 });
  });
  return { fetchImpl, calls };
}

function baseConfig(overrides: Partial<GapDetectorConfig> = {}): GapDetectorConfig {
  return {
    gapPauseThreshold: 0,
    backfillMaxLedgers: 100,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    nodeEnv: "production",
    ...overrides,
  };
}

function pagingConfig(overrides: Partial<GapPagingConfig> = {}): GapPagingConfig {
  return {
    webhookUrl: "https://alerts.example.com/hooks/gap",
    persistenceCyclesBeforePage: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GapDetector paging path", () => {
  let fetchStub: ReturnType<typeof makeFetchStub>;

  beforeEach(() => {
    fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub.fetchImpl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not page before persistenceCyclesBeforePage consecutive cycles", async () => {
    const detector = new GapDetector(
      baseConfig({ pagingConfig: pagingConfig({ persistenceCyclesBeforePage: 3 }) })
    );

    // Two cycles below the threshold: no page.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await detector.recordGapCycle({ gapStartLedger: 100, gapEndLedger: 110 });
    }

    expect(fetchStub.fetchImpl).not.toHaveBeenCalled();
  });

  it("pages exactly once when the threshold is reached", async () => {
    const detector = new GapDetector(
      baseConfig({ pagingConfig: pagingConfig({ persistenceCyclesBeforePage: 3 }) })
    );

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await detector.recordGapCycle({ gapStartLedger: 100, gapEndLedger: 110 });
    }
    expect(fetchStub.fetchImpl).not.toHaveBeenCalled();

    // Third consecutive cycle hits the threshold: exactly one page.
    await detector.recordGapCycle({ gapStartLedger: 100, gapEndLedger: 110 });
    expect(fetchStub.fetchImpl).toHaveBeenCalledTimes(1);

    // A further cycle does not re-page for the same persistent gap.
    await detector.recordGapCycle({ gapStartLedger: 100, gapEndLedger: 110 });
    expect(fetchStub.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not include secret material in the paging payload", async () => {
    const detector = new GapDetector(
      baseConfig({ pagingConfig: pagingConfig({ persistenceCyclesBeforePage: 1 }) })
    );

    await detector.recordGapCycle({ gapStartLedger: 100, gapEndLedger: 110 });

    expect(fetchStub.fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.calls[0];
    const body = typeof init?.body === "string" ? init.body : "";
    expect(body).not.toMatch(/secret|token|password|authorization/i);
  });

  describe("SSRF rejection in production", () => {
    const privateHosts = [
      "http://127.0.0.1/hooks/gap",
      "http://10.0.0.5/hooks/gap",
      "http://169.254.169.254/hooks/gap",
    ];

    it.each(privateHosts)(
      "rejects %s with WebhookUrlError when allowPrivateNetwork is not set",
      async (webhookUrl) => {
        const detector = new GapDetector(
          baseConfig({
            nodeEnv: "production",
            pagingConfig: pagingConfig({
              webhookUrl,
              persistenceCyclesBeforePage: 1,
            }),
          })
        );

        await expect(
          detector.recordGapCycle({ gapStartLedger: 100, gapEndLedger: 110 })
        ).rejects.toBeInstanceOf(WebhookUrlError);
        expect(fetchStub.fetchImpl).not.toHaveBeenCalled();
      }
    );

    it.each(privateHosts)(
      "permits %s when allowPrivateNetwork is true",
      async (webhookUrl) => {
        const detector = new GapDetector(
          baseConfig({
            nodeEnv: "production",
            pagingConfig: pagingConfig({
              webhookUrl,
              persistenceCyclesBeforePage: 1,
              allowPrivateNetwork: true,
            }),
          })
        );

        await detector.recordGapCycle({ gapStartLedger: 100, gapEndLedger: 110 });
        expect(fetchStub.fetchImpl).toHaveBeenCalledTimes(1);
      }
    );
  });

  it("rejects a malformed webhook URL before any fetch is attempted", async () => {
    const detector = new GapDetector(
      baseConfig({
        pagingConfig: pagingConfig({
          webhookUrl: "not a url",
          persistenceCyclesBeforePage: 1,
        }),
      })
    );

    await expect(
      detector.recordGapCycle({ gapStartLedger: 100, gapEndLedger: 110 })
    ).rejects.toBeInstanceOf(WebhookUrlError);
    expect(fetchStub.fetchImpl).not.toHaveBeenCalled();
  });
});
