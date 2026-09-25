/**
 * Unit tests for admission control — global and per-market shedding (issues #881, #967).
 *
 * #967: Per-market shedding isolates a toxic market so other markets remain
 * available. This file tests both the global fail-closed path and the new
 * per-market shedding path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import {
  admissionControl,
  updateMarketShedState,
  getShedMarkets,
  clearShedMarkets,
} from "../src/api/middleware/admissionControl.js";
import * as lagDetectorModule from "../src/services/lag-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReply() {
  const sendSpy = vi.fn();
  const headerSpy = vi.fn().mockReturnThis();
  const statusSpy = vi.fn().mockReturnThis();
  return {
    status: statusSpy,
    header: headerSpy,
    send: sendSpy,
    _sendSpy: sendSpy,
    _headerSpy: headerSpy,
    _statusSpy: statusSpy,
  };
}

function makeRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    method: "POST",
    url: "/v1/orders",
    body: null,
    headers: {},
    ...overrides,
  } as unknown as FastifyRequest;
}

// ---------------------------------------------------------------------------
// Global fail-closed tests (existing behaviour, kept as regression guard)
// ---------------------------------------------------------------------------

describe("Admission Control: global fail-closed on probe error", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearShedMarkets();
    delete process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearShedMarkets();
  });

  it("fails closed (sheds traffic) when lag detector probe errors in production", async () => {
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockRejectedValueOnce(
      new Error("Redis connection failed")
    );

    const reply = makeReply();
    await admissionControl(makeRequest(), reply as unknown as FastifyReply);

    expect(reply._statusSpy).toHaveBeenCalledWith(503);
    expect(reply._sendSpy).toHaveBeenCalled();
    const body = reply._sendSpy.mock.calls[0][0];
    expect(body.error).toBe("lag_detector_probe_failed");
  });

  it("allows traffic when probe succeeds and global lag is low", async () => {
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockResolvedValueOnce(
      {
        settlementQueueDepth: 100,
        outboxUnpublishedCount: 10,
        totalLag: 110,
        shedding: false,
        timestamp: Date.now(),
      }
    );

    const reply = makeReply();
    await admissionControl(makeRequest(), reply as unknown as FastifyReply);

    expect(reply._sendSpy).not.toHaveBeenCalled();
  });

  it("sheds traffic globally when probe reports high lag", async () => {
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockResolvedValueOnce(
      {
        settlementQueueDepth: 2000,
        outboxUnpublishedCount: 100,
        totalLag: 2150,
        shedding: true,
        timestamp: Date.now(),
      }
    );

    const reply = makeReply();
    await admissionControl(makeRequest(), reply as unknown as FastifyReply);

    expect(reply._statusSpy).toHaveBeenCalledWith(503);
    const body = reply._sendSpy.mock.calls[0][0];
    expect(body.error).toBe("matching_backpressured");
  });

  it("allows cancellations even when probe errors", async () => {
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockRejectedValueOnce(
      new Error("Redis connection failed")
    );

    const reply = makeReply();
    await admissionControl(
      makeRequest({ method: "DELETE", url: "/v1/orders/123" }),
      reply as unknown as FastifyReply
    );

    expect(reply._sendSpy).not.toHaveBeenCalled();
    expect(reply._statusSpy).not.toHaveBeenCalled();
  });

  it("allows admin operations even when probe errors", async () => {
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockRejectedValueOnce(
      new Error("Redis connection failed")
    );

    const reply = makeReply();
    await admissionControl(
      makeRequest({ method: "POST", url: "/v1/admin/markets" }),
      reply as unknown as FastifyReply
    );

    expect(reply._sendSpy).not.toHaveBeenCalled();
    expect(reply._statusSpy).not.toHaveBeenCalled();
  });

  it("allows probe errors in non-production (warn, do not shed)", async () => {
    process.env.NODE_ENV = "development";
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockRejectedValueOnce(
      new Error("Redis connection failed")
    );

    const reply = makeReply();
    await admissionControl(makeRequest(), reply as unknown as FastifyReply);

    // Should NOT shed in dev
    expect(reply._sendSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-market shedding tests (issue #967)
// ---------------------------------------------------------------------------

describe("Admission Control: per-market shedding (issue #967)", () => {
  const MARKET_A = "market-uuid-aaaa";
  const MARKET_B = "market-uuid-bbbb";

  beforeEach(() => {
    vi.restoreAllMocks();
    clearShedMarkets();
    process.env.NODE_ENV = "production";
    // Default: global probe reports healthy
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockResolvedValue({
      settlementQueueDepth: 50,
      outboxUnpublishedCount: 0,
      totalLag: 50,
      shedding: false,
      timestamp: Date.now(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearShedMarkets();
  });

  it("updateMarketShedState adds a market when lag >= PER_MARKET_SHED_THRESHOLD", () => {
    process.env.PER_MARKET_SHED_THRESHOLD = "100";
    updateMarketShedState(MARKET_A, 150);
    expect(getShedMarkets().has(MARKET_A)).toBe(true);
  });

  it("updateMarketShedState does not add a market below the threshold", () => {
    process.env.PER_MARKET_SHED_THRESHOLD = "100";
    updateMarketShedState(MARKET_A, 80);
    expect(getShedMarkets().has(MARKET_A)).toBe(false);
  });

  it("updateMarketShedState removes a market when lag <= PER_MARKET_RECOVERY_THRESHOLD", () => {
    process.env.PER_MARKET_SHED_THRESHOLD = "100";
    process.env.PER_MARKET_RECOVERY_THRESHOLD = "50";
    updateMarketShedState(MARKET_A, 150); // enter shedding
    expect(getShedMarkets().has(MARKET_A)).toBe(true);
    updateMarketShedState(MARKET_A, 30); // recover
    expect(getShedMarkets().has(MARKET_A)).toBe(false);
  });

  it("sheds orders for a market in the shed set (body.marketId path)", async () => {
    updateMarketShedState(MARKET_A, 99999); // force into shed set by high lag
    process.env.PER_MARKET_SHED_THRESHOLD = "1"; // ensure threshold met

    // Re-add manually since threshold affects updateMarketShedState
    clearShedMarkets();
    // Directly add to set via updateMarketShedState with threshold=1
    process.env.PER_MARKET_SHED_THRESHOLD = "1";
    updateMarketShedState(MARKET_A, 2);

    const request = makeRequest({
      body: { marketId: MARKET_A, userAddress: "G" + "A".repeat(55) } as any,
    });
    const reply = makeReply();

    await admissionControl(request, reply as unknown as FastifyReply);

    expect(reply._statusSpy).toHaveBeenCalledWith(503);
    const body = reply._sendSpy.mock.calls[0][0];
    expect(body.error).toBe("market_backpressured");
    expect(body.details.marketId).toBe(MARKET_A);
  });

  it("allows requests for non-shed markets when one market is shed", async () => {
    process.env.PER_MARKET_SHED_THRESHOLD = "1";
    updateMarketShedState(MARKET_A, 2); // only A is shed

    const request = makeRequest({
      body: { marketId: MARKET_B, userAddress: "G" + "A".repeat(55) } as any,
    });
    const reply = makeReply();

    await admissionControl(request, reply as unknown as FastifyReply);

    // Market B should pass through (global probe is healthy)
    expect(reply._sendSpy).not.toHaveBeenCalled();
  });

  it("getShedMarkets returns a snapshot (not the live mutable set)", () => {
    process.env.PER_MARKET_SHED_THRESHOLD = "1";
    updateMarketShedState(MARKET_A, 2);
    const snapshot = getShedMarkets();
    // Mutating the snapshot must not affect internal state
    (snapshot as Set<string>).add("ghost-market");
    expect(getShedMarkets().has("ghost-market")).toBe(false);
  });

  it("clearShedMarkets empties the shed set", () => {
    process.env.PER_MARKET_SHED_THRESHOLD = "1";
    updateMarketShedState(MARKET_A, 2);
    expect(getShedMarkets().size).toBe(1);
    clearShedMarkets();
    expect(getShedMarkets().size).toBe(0);
  });

  it("shed market is bypassed for cancellations (DELETE)", async () => {
    process.env.PER_MARKET_SHED_THRESHOLD = "1";
    updateMarketShedState(MARKET_A, 2);

    const request = makeRequest({
      method: "DELETE",
      url: `/v1/orders/order-xyz`,
      body: { marketId: MARKET_A } as any,
    });
    const reply = makeReply();

    await admissionControl(request, reply as unknown as FastifyReply);

    expect(reply._sendSpy).not.toHaveBeenCalled();
  });
});
