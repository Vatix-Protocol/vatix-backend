import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { admissionControl } from "./admissionControl.js";
import { lagDetector } from "../../services/lag-detector.js";

const mockRequest = (url: string, method: string = "POST"): FastifyRequest => ({
  url,
  method,
} as FastifyRequest);

const mockReply = (): FastifyReply => ({
  status: vi.fn().mockReturnThis(),
  header: vi.fn().mockReturnThis(),
  send: vi.fn().mockResolvedValue(undefined),
} as any);

vi.mock("../../services/lag-detector.js", () => ({
  lagDetector: {
    getMetrics: vi.fn(),
  },
}));

describe("admissionControl middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should allow requests when not shedding", async () => {
    const request = mockRequest("/v1/orders");
    const reply = mockReply();

    vi.mocked(lagDetector.getMetrics).mockResolvedValue({
      settlementQueueDepth: 100,
      outboxUnpublishedCount: 0,
      totalLag: 100,
      shedding: false,
      timestamp: Date.now(),
    });

    await admissionControl(request, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("should reject requests with 503 when shedding", async () => {
    const request = mockRequest("/v1/orders");
    const reply = mockReply();

    vi.mocked(lagDetector.getMetrics).mockResolvedValue({
      settlementQueueDepth: 2000,
      outboxUnpublishedCount: 500,
      totalLag: 2250,
      shedding: true,
      timestamp: Date.now(),
    });

    await admissionControl(request, reply);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.header).toHaveBeenCalledWith("Retry-After", "30");
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "matching_backpressured",
        retryAfterSeconds: 30,
      })
    );
  });

  it("should skip admission control for cancellations", async () => {
    const request = mockRequest("/v1/orders/123/cancel", "DELETE");
    const reply = mockReply();

    vi.mocked(lagDetector.getMetrics).mockResolvedValue({
      settlementQueueDepth: 2000,
      outboxUnpublishedCount: 500,
      totalLag: 2250,
      shedding: true,
      timestamp: Date.now(),
    });

    await admissionControl(request, reply);

    // Should NOT reject
    expect(reply.status).not.toHaveBeenCalled();
  });

  it("should skip admission control for POST cancel", async () => {
    const request = mockRequest("/v1/orders/123/cancel", "POST");
    const reply = mockReply();

    vi.mocked(lagDetector.getMetrics).mockResolvedValue({
      settlementQueueDepth: 2000,
      outboxUnpublishedCount: 500,
      totalLag: 2250,
      shedding: true,
      timestamp: Date.now(),
    });

    await admissionControl(request, reply);

    // Should NOT reject
    expect(reply.status).not.toHaveBeenCalled();
  });

  it("should skip admission control for admin operations", async () => {
    const request = mockRequest("/admin/markets/123/status", "PATCH");
    const reply = mockReply();

    vi.mocked(lagDetector.getMetrics).mockResolvedValue({
      settlementQueueDepth: 2000,
      outboxUnpublishedCount: 500,
      totalLag: 2250,
      shedding: true,
      timestamp: Date.now(),
    });

    await admissionControl(request, reply);

    // Should NOT reject
    expect(reply.status).not.toHaveBeenCalled();
  });

  it("should include lag details in rejection response", async () => {
    const request = mockRequest("/v1/orders");
    const reply = mockReply();

    vi.mocked(lagDetector.getMetrics).mockResolvedValue({
      settlementQueueDepth: 1500,
      outboxUnpublishedCount: 300,
      totalLag: 1650,
      shedding: true,
      timestamp: Date.now(),
    });

    await admissionControl(request, reply);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "matching_backpressured",
        details: {
          settlementQueueDepth: 1500,
          outboxUnpublishedCount: 300,
          totalLag: 1650,
        },
      })
    );
  });
});
