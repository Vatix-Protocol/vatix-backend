import { describe, it, expect, beforeEach } from "vitest";
import { PaymentMetricsService } from "./paymentMetrics.js";
import {
  paymentOrdersSubmittedTotal,
  paymentOrdersFilledTotal,
  paymentOrdersFailedTotal,
} from "./metrics.js";

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

  it("clamps fillRate to 1 when fills exceed submissions", () => {
    svc.recordSubmitted();
    svc.recordFilled();
    svc.recordFilled();
    const snap = svc.getSnapshot();
    expect(snap.ordersFilled).toBe(2);
    expect(snap.ordersSubmitted).toBe(1);
    expect(snap.fillRate).toBe(1);
  });

  it("clamps fillRate to 1 when fills are recorded with no submissions", () => {
    svc.recordFilled();
    svc.recordFilled();
    const snap = svc.getSnapshot();
    expect(snap.ordersSubmitted).toBe(0);
    expect(snap.fillRate).toBeNull();
  });

  it("fillRate is null when ordersSubmitted is 0 even after recordFilled", () => {
    svc.recordFilled();
    expect(svc.getSnapshot().fillRate).toBeNull();
  });

  // --- prometheus counters ---

  it("increments the Prometheus submitted counter on recordSubmitted", () => {
    const before = paymentOrdersSubmittedTotal.get();
    svc.recordSubmitted();
    expect(paymentOrdersSubmittedTotal.get()).toBe(before + 1);
  });

  it("increments the Prometheus filled counter on recordFilled", () => {
    const before = paymentOrdersFilledTotal.get();
    svc.recordFilled();
    expect(paymentOrdersFilledTotal.get()).toBe(before + 1);
  });

  it("increments the Prometheus failed counter on recordFailed", () => {
    const before = paymentOrdersFailedTotal.get();
    svc.recordFailed();
    expect(paymentOrdersFailedTotal.get()).toBe(before + 1);
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
