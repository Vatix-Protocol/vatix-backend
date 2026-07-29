/**
 * Metrics for admission control and lag tracking
 * Exported to Prometheus for monitoring
 */

let ordersShedTotal = 0;
let currentLagGauge = 0;
let shedStateGauge = 0;

/**
 * Increment total orders shed
 */
export function incrementOrdersShed(count: number = 1): void {
  ordersShedTotal += count;
}

/**
 * Set current lag gauge
 */
export function setCurrentLag(lag: number): void {
  currentLagGauge = lag;
}

/**
 * Set shed state gauge (0 = not shedding, 1 = shedding)
 */
export function setShedState(shedding: boolean): void {
  shedStateGauge = shedding ? 1 : 0;
}

/**
 * Get current metrics for export
 */
export function getMetrics() {
  return {
    orders_shed_total: ordersShedTotal,
    current_lag_gauge: currentLagGauge,
    shed_state_gauge: shedStateGauge,
  };
}

/**
 * Reset metrics (for testing)
 */
export function resetMetrics(): void {
  ordersShedTotal = 0;
  currentLagGauge = 0;
  shedStateGauge = 0;
}
