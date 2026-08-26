/**
 * Unit tests for admission control fail-closed behavior.
 * Verifies that admission control fails closed (sheds traffic) on lag probe errors.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { admissionControl } from "../src/api/middleware/admissionControl.js";
import * as lagDetectorModule from "../src/services/lag-detector.js";

describe("Admission Control: fail-closed on probe error", () => {
  let mockRequest: Partial<FastifyRequest>;
  let mockReply: Partial<FastifyReply>;
  let sendSpy: ReturnType<typeof vi.fn>;
  let headerSpy: ReturnType<typeof vi.fn>;
  let statusSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendSpy = vi.fn();
    headerSpy = vi.fn().mockReturnThis();
    statusSpy = vi.fn().mockReturnThis();

    mockRequest = {
      method: "POST",
      url: "/v1/orders",
    } as Partial<FastifyRequest>;

    mockReply = {
      status: statusSpy,
      header: headerSpy,
      send: sendSpy,
    } as Partial<FastifyReply>;
  });

  it("fails closed (sheds traffic) when lag detector probe errors", async () => {
    // Simulate a Redis connection error during lag probe
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockRejectedValueOnce(
      new Error("Redis connection failed")
    );

    await admissionControl(
      mockRequest as FastifyRequest,
      mockReply as FastifyReply
    );

    // Should have called status(503) to indicate shedding
    expect(statusSpy).toHaveBeenCalledWith(503);
    // Should have sent an error response
    expect(sendSpy).toHaveBeenCalled();
    const sentData = sendSpy.mock.calls[0][0];
    expect(sentData.error).toBe("lag_detector_probe_failed");
  });

  it("allows traffic when probe succeeds and lag is low", async () => {
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockResolvedValueOnce({
      settlementQueueDepth: 100,
      outboxUnpublishedCount: 10,
      totalLag: 110,
      shedding: false,
      timestamp: Date.now(),
    });

    await admissionControl(
      mockRequest as FastifyRequest,
      mockReply as FastifyReply
    );

    // Should NOT have sent any response (middleware allows request through)
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sheds traffic when probe succeeds and lag is high", async () => {
    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockResolvedValueOnce({
      settlementQueueDepth: 2000,
      outboxUnpublishedCount: 100,
      totalLag: 2150,
      shedding: true,
      timestamp: Date.now(),
    });

    await admissionControl(
      mockRequest as FastifyRequest,
      mockReply as FastifyReply
    );

    // Should have called status(503) for high lag
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(sendSpy).toHaveBeenCalled();
    const sentData = sendSpy.mock.calls[0][0];
    expect(sentData.error).toBe("matching_backpressured");
  });

  it("allows cancellations even when probe errors", async () => {
    mockRequest = {
      method: "DELETE",
      url: "/v1/orders/123",
    } as Partial<FastifyRequest>;

    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockRejectedValueOnce(
      new Error("Redis connection failed")
    );

    await admissionControl(
      mockRequest as FastifyRequest,
      mockReply as FastifyReply
    );

    // Should NOT have sent response for cancellation
    expect(sendSpy).not.toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("allows admin operations even when probe errors", async () => {
    mockRequest = {
      method: "POST",
      url: "/v1/admin/markets",
    } as Partial<FastifyRequest>;

    vi.spyOn(lagDetectorModule.lagDetector, "getMetrics").mockRejectedValueOnce(
      new Error("Redis connection failed")
    );

    await admissionControl(
      mockRequest as FastifyRequest,
      mockReply as FastifyReply
    );

    // Should NOT have sent response for admin operation
    expect(sendSpy).not.toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
  });
});
