import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup } from "node:dns/promises";
import { GapDetector, type GapPagingConfig } from "./gapDetector.js";
import {
  WEBHOOK_URL_ERROR_CODES,
  WebhookUrlError,
} from "./webhookUrlPolicy.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { BatchWriter } from "./batchWriter.js";
import type { InternalIndexerMetricsService } from "./metrics.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

// #1160 — SSRF hardening of the persistent-gap paging webhook.

const SECRET_URL = "https://hooks.example.com/services/T0KEN-SECRET";

function makeDeps() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ILogger;
  const metrics = {
    incrementGapDetected: vi.fn(),
    incrementBackfillLedgers: vi.fn(),
    incrementGapBackfillOutcome: vi.fn(),
    incrementGapPagingWebhook: vi.fn(),
  } as unknown as InternalIndexerMetricsService;
  const fetcher = {
    fetchByLedgerWindow: vi
      .fn()
      .mockResolvedValue({ events: [], latestLedger: 1000 }),
  } as unknown as EventFetcher;
  const writer: BatchWriter = {
    write: vi.fn().mockResolvedValue({ written: 0, skipped: 0, errors: [] }),
    flush: vi.fn().mockResolvedValue(undefined),
  };
  return { logger, metrics, fetcher, writer };
}

function makeDetector(
  paging: Partial<GapPagingConfig> = {},
  nodeEnv = "production"
) {
  const deps = makeDeps();
  const detector = new GapDetector(
    {
      gapPauseThreshold: 0,
      backfillMaxLedgers: 500,
      contractId: "CTEST",
      nodeEnv,
      pagingConfig: {
        webhookUrl: SECRET_URL,
        persistenceCyclesBeforePage: 1,
        ...paging,
      },
    },
    deps.fetcher,
    deps.writer,
    deps.metrics,
    deps.logger
  );
  return { detector, ...deps };
}

/** Every string passed to any logger method, for secret-leak assertions. */
function loggedText(logger: ILogger): string {
  return JSON.stringify(
    (["debug", "info", "warn", "error"] as const).map(
      (level) => (logger[level] as ReturnType<typeof vi.fn>).mock.calls
    )
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ] as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GapDetector paging webhook SSRF guard (#1160)", () => {
  describe("startup validation", () => {
    it.each([
      [
        "http://hooks.example.com/page",
        WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_INSECURE_SCHEME,
      ],
      [
        "https://169.254.169.254/latest",
        WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_PRIVATE_HOST,
      ],
      [
        "https://localhost/page",
        WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_PRIVATE_HOST,
      ],
      [
        "https://u:p@hooks.example.com/",
        WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_EMBEDDED_CREDENTIALS,
      ],
      ["file:///etc/passwd", WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_INVALID],
    ])("fails fast in production on %s", (webhookUrl, code) => {
      expect(() => makeDetector({ webhookUrl })).toThrow(
        expect.objectContaining({ code })
      );
    });

    it("rejects embedded credentials outside production too", () => {
      expect(() =>
        makeDetector({ webhookUrl: "https://u:p@hooks.example.com/" }, "test")
      ).toThrow(WebhookUrlError);
    });

    it("accepts a private receiver only with allowPrivateNetwork", () => {
      expect(() =>
        makeDetector({
          webhookUrl: "https://alertmanager.internal.svc:9093/hook",
          allowPrivateNetwork: true,
        })
      ).not.toThrow();
      expect(() =>
        makeDetector({
          webhookUrl: "https://10.0.0.7/hook",
          allowPrivateNetwork: true,
        })
      ).not.toThrow();
    });
  });

  describe("send-time guard", () => {
    it("sends with redirects refused and a timeout, and counts it", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const { detector, metrics } = makeDetector();

      await detector.runBackfill(100, 110);

      expect(lookup).toHaveBeenCalledWith("hooks.example.com", {
        all: true,
        verbatim: true,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        SECRET_URL,
        expect.objectContaining({
          method: "POST",
          redirect: "error",
          signal: expect.any(AbortSignal),
        })
      );
      expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledWith("sent");
    });

    it("blocks the send when the host resolves to a private address", async () => {
      vi.mocked(lookup).mockResolvedValue([
        { address: "10.0.0.5", family: 4 },
      ] as never);
      const { detector, metrics, logger } = makeDetector();

      const result = await detector.runBackfill(100, 110);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledWith("blocked");
      expect(logger.error).toHaveBeenCalledWith(
        "Gap paging webhook blocked by SSRF policy",
        expect.objectContaining({
          event: "indexer.gap.paging.blocked",
          code: WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_PRIVATE_HOST,
          correlationId: result.correlationId,
        })
      );
    });

    it("does not re-resolve when private receivers are allowed", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const { detector } = makeDetector({ allowPrivateNetwork: true });

      await detector.runBackfill(100, 110);

      expect(lookup).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("records DNS failures, timeouts and refused redirects as failed without throwing", async () => {
      fetchMock.mockRejectedValue(
        new TypeError("fetch failed: redirect mode is set to error")
      );
      const { detector, metrics } = makeDetector();

      await expect(detector.runBackfill(100, 110)).resolves.toMatchObject({
        paused: false,
      });
      expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledWith("failed");
    });

    it("counts a non-2xx answer as http_error", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 });
      const { detector, metrics } = makeDetector();

      await detector.runBackfill(100, 110);

      expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledWith(
        "http_error"
      );
    });

    it("never logs the webhook URL or its token", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 });
      const { detector, logger } = makeDetector();

      await detector.runBackfill(100, 110);

      expect(logger.warn).toHaveBeenCalledWith(
        "Gap paging webhook returned non-2xx status",
        expect.objectContaining({ status: 500 })
      );
      expect(loggedText(logger)).not.toContain("T0KEN-SECRET");
      expect(loggedText(logger)).not.toContain("hooks.example.com");
    });
  });
});
