export interface PositionInput {
  marketId: string;
  yesShares: number;
  noShares: number;
}

export interface PositionWeight {
  marketId: string;
  netExposure: number;
  share: number;
}

export interface ConcentrationResult {
  /** Herfindahl-Hirschman Index scaled to 10 000. 0 = perfectly spread, 10 000 = fully concentrated. */
  score: number;
  positions: PositionWeight[];
  totalExposure: number;
  isHighConcentration: boolean;
  threshold: number;
}

/**
 * Compute a Herfindahl-style concentration score for a set of open positions.
 *
 * Each position's weight is its absolute net exposure (|yesShares - noShares|)
 * as a fraction of the total portfolio exposure.  The HHI is the sum of squared
 * weights, scaled to 10 000.
 *
 * Returns score = 0 when the portfolio has no exposure.
 */
export function computeConcentrationScore(
  positions: PositionInput[],
  threshold = 2500
): ConcentrationResult {
  const weighted = positions.map((p) => ({
    marketId: p.marketId,
    netExposure: Math.abs(p.yesShares - p.noShares),
  }));

  const totalExposure = weighted.reduce((s, p) => s + p.netExposure, 0);

  if (totalExposure === 0) {
    return {
      score: 0,
      positions: weighted.map((p) => ({ ...p, share: 0 })),
      totalExposure: 0,
      isHighConcentration: false,
      threshold,
    };
  }

  const positionsWithShares: PositionWeight[] = weighted.map((p) => ({
    ...p,
    share: p.netExposure / totalExposure,
  }));

  const score = Math.round(
    positionsWithShares.reduce((s, p) => s + p.share * p.share * 10_000, 0)
  );

  return {
    score,
    positions: positionsWithShares,
    totalExposure,
    isHighConcentration: score >= threshold,
    threshold,
  };
}
