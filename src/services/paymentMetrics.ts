/**
 * PaymentMetricsService — in-process counters for the payment/order flow.
 *
 * Tracks order submissions, fills, and failures so they can be scraped or
 * logged without touching external infrastructure. Follows the same snapshot
 * pattern as InternalIndexerMetricsService.
 *
 * No user addresses, prices, or private keys are stored — only aggregate counts.
 */

import {
  paymentOrdersSubmittedTotal,
  paymentOrdersFilledTotal,
  paymentOrdersFailedTotal,
} from './metrics.js';

export interface PaymentMetricsSnapshot {
  ordersSubmitted: number;
  ordersFilled: number;
  ordersFailed: number;
  /**
   * Ratio of filled to submitted, or null when no orders have been submitted.
   * Clamped to the range [0, 1] via `Math.min(1, ordersFilled / ordersSubmitted)`
   * so that fills recorded without a matching submission (e.g. replays or
   * settlement-driven fills) cannot produce a nonsensical ratio above 1.
   */
  fillRate: number | null;
}

export class PaymentMetricsService {
  private ordersSubmitted = 0;
  private ordersFilled = 0;
  private ordersFailed = 0;

  recordSubmitted(): void {
    this.ordersSubmitted += 1;
    paymentOrdersSubmittedTotal.inc();
  }

  recordFilled(): void {
    this.ordersFilled += 1;
    paymentOrdersFilledTotal.inc();
  }

  recordFailed(): void {
    this.ordersFailed += 1;
    paymentOrdersFailedTotal.inc();
  }

  getSnapshot(): PaymentMetricsSnapshot {
    return {
      ordersSubmitted: this.ordersSubmitted,
      ordersFilled: this.ordersFilled,
      ordersFailed: this.ordersFailed,
      fillRate:
        this.ordersSubmitted > 0
          ? Math.min(1, this.ordersFilled / this.ordersSubmitted)
          : null,
    };
  }

  /**
   * Reset all in-process counters — useful in tests or after a flush.
   * Note: the Prometheus counters are process-lifetime counters and are
   * intentionally NOT reset here.
   */
  reset(): void {
    this.ordersSubmitted = 0;
    this.ordersFilled = 0;
    this.ordersFailed = 0;
  }
}

export const paymentMetrics = new PaymentMetricsService();