import { describe, it, expect, beforeEach } from "vitest";
import { PaymentMetricsService } from "./paymentMetrics.js";

describe("PaymentMetricsService", () => {
  let svc: PaymentMetricsService;

  beforeEach(() => {
    svc = new PaymentMetricsService();
  });

  // --- success path ---

  it("starts with zero counts and null fillRate", () => {
    const snap = svc.getSnapshot();
    expect(snap.ordersSubmitted).toBe(0);
    expect(snap.ordersFilled).toBe(0);
    expect(snap.ordersFailed).toBe(0);
    expect(snap.fillRate).toBeNull();
  });

  it("increments ordersSubmitted on each recordSubmitted call", () => {
    svc.recordSubmitted();
    svc.recordSubmitted();
    expect(svc.getSnapshot().ordersSubmitted).toBe(2);
  });

  it("computes fillRate correctly", () => {
    svc.recordSubmitted();
    svc.recordSubmitted();
    svc.recordFilled();
    expect(svc.getSnapshot().fillRate).toBe(0.5);
  });

  it("fillRate is 1.0 when all submitted orders are filled", () => {
    svc.recordSubmitted();
    svc.recordFilled();
    expect(svc.getSnapshot().fillRate).toBe(1);
  });

  // --- failure path ---

  it("increments ordersFailed on recordFailed", () => {
    svc.recordSubmitted();
    svc.recordFailed();
    const snap = svc.getSnapshot();
    expect(snap.ordersFailed).toBe(1);
    expect(snap.ordersSubmitted).toBe(1);
  });

  it("reset clears all counters and sets fillRate back to null", () => {
    svc.recordSubmitted();
    svc.recordFilled();
    svc.recordFailed();
    svc.reset();
    const snap = svc.getSnapshot();
    expect(snap.ordersSubmitted).toBe(0);
    expect(snap.ordersFilled).toBe(0);
    expect(snap.ordersFailed).toBe(0);
    expect(snap.fillRate).toBeNull();
  });

  it("snapshot contains no secrets or private keys", () => {
    svc.recordSubmitted();
    const snap = svc.getSnapshot();
    const keys = Object.keys(snap);
    expect(keys).not.toContain("privateKey");
    expect(keys).not.toContain("userAddress");
    expect(keys).not.toContain("secret");
  });
});
