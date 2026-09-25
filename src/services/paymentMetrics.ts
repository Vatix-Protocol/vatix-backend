/**
 * PaymentMetricsService — in-process counters for the payment/order flow.
 *
 * Tracks order submissions, fills, and failures so they can be scraped or
 * logged without touching external infrastructure. Follows the same snapshot
 * pattern as InternalIndexerMetricsService.
 *
 * No user addresses, prices, or private keys are stored — only aggregate counts.
 */

export interface PaymentMetricsSnapshot {
  ordersSubmitted: number;
  ordersFilled: number;
  ordersFailed: number;
  /** Ratio of filled to submitted, or null when no orders have been submitted. */
  fillRate: number | null;
}

export class PaymentMetricsService {
  private ordersSubmitted = 0;
  private ordersFilled = 0;
  private ordersFailed = 0;

  recordSubmitted(): void {
    this.ordersSubmitted += 1;
  }

  recordFilled(): void {
    this.ordersFilled += 1;
  }

  recordFailed(): void {
    this.ordersFailed += 1;
  }

  getSnapshot(): PaymentMetricsSnapshot {
    return {
      ordersSubmitted: this.ordersSubmitted,
      ordersFilled: this.ordersFilled,
      ordersFailed: this.ordersFailed,
      fillRate:
        this.ordersSubmitted > 0
          ? this.ordersFilled / this.ordersSubmitted
          : null,
    };
  }

  /** Reset all counters — useful in tests or after a flush. */
  reset(): void {
    this.ordersSubmitted = 0;
    this.ordersFilled = 0;
    this.ordersFailed = 0;
  }
}

export const paymentMetrics = new PaymentMetricsService();
