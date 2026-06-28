import { describe, it, expect } from "vitest";
import { computeConcentrationScore } from "./concentration.js";

describe("computeConcentrationScore", () => {
  it("returns score = 0 for an empty portfolio", () => {
    const result = computeConcentrationScore([]);
    expect(result.score).toBe(0);
    expect(result.totalExposure).toBe(0);
    expect(result.isHighConcentration).toBe(false);
  });

  it("returns score = 0 when all positions have zero exposure", () => {
    const result = computeConcentrationScore([
      { marketId: "m1", yesShares: 50, noShares: 50 },
      { marketId: "m2", yesShares: 0, noShares: 0 },
    ]);
    expect(result.score).toBe(0);
  });

  it("returns score = 10000 for a single fully concentrated position", () => {
    const result = computeConcentrationScore([
      { marketId: "m1", yesShares: 100, noShares: 0 },
    ]);
    expect(result.score).toBe(10_000);
    expect(result.isHighConcentration).toBe(true);
  });

  it("returns score = 2500 for four equal-weight positions", () => {
    const positions = Array.from({ length: 4 }, (_, i) => ({
      marketId: `m${i}`,
      yesShares: 100,
      noShares: 0,
    }));
    const result = computeConcentrationScore(positions);
    expect(result.score).toBe(2_500);
  });

  it("returns score = 10000 for two equal-weight positions with default threshold 2500, flagged as high", () => {
    const result = computeConcentrationScore([
      { marketId: "m1", yesShares: 100, noShares: 0 },
      { marketId: "m2", yesShares: 100, noShares: 0 },
    ]);
    expect(result.score).toBe(5_000);
    expect(result.isHighConcentration).toBe(true);
  });

  it("uses absolute net exposure (yesShares - noShares)", () => {
    const long = computeConcentrationScore([
      { marketId: "m1", yesShares: 200, noShares: 100 },
    ]);
    const short = computeConcentrationScore([
      { marketId: "m1", yesShares: 100, noShares: 200 },
    ]);
    expect(long.score).toBe(short.score);
    expect(long.totalExposure).toBe(100);
    expect(short.totalExposure).toBe(100);
  });

  it("respects a custom threshold", () => {
    const result = computeConcentrationScore(
      [{ marketId: "m1", yesShares: 100, noShares: 0 }],
      5000
    );
    expect(result.threshold).toBe(5000);
    expect(result.isHighConcentration).toBe(true);
  });

  it("does not flag as high concentration when score is below threshold", () => {
    const positions = Array.from({ length: 10 }, (_, i) => ({
      marketId: `m${i}`,
      yesShares: 100,
      noShares: 0,
    }));
    const result = computeConcentrationScore(positions, 2500);
    expect(result.score).toBe(1_000);
    expect(result.isHighConcentration).toBe(false);
  });

  it("each position weight sums to ~1", () => {
    const positions = [
      { marketId: "m1", yesShares: 300, noShares: 0 },
      { marketId: "m2", yesShares: 100, noShares: 0 },
      { marketId: "m3", yesShares: 100, noShares: 0 },
    ];
    const result = computeConcentrationScore(positions);
    const total = result.positions.reduce((s, p) => s + p.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});
