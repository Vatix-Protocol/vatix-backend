import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getChallengeWindow, isChallengeWindowOpen } from "./challengeWindow";

const WINDOW_SECONDS = 3600; // 1 hour for test clarity

describe("getChallengeWindow", () => {
  it("sets opensAt equal to proposedAt", () => {
    const proposedAt = new Date("2026-01-01T00:00:00.000Z");
    const { opensAt } = getChallengeWindow(proposedAt, WINDOW_SECONDS);
    expect(opensAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("sets closesAt to proposedAt + windowSeconds", () => {
    const proposedAt = new Date("2026-01-01T00:00:00.000Z");
    const { closesAt } = getChallengeWindow(proposedAt, WINDOW_SECONDS);
    expect(closesAt.toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });

  it("does not mutate the proposedAt argument", () => {
    const proposedAt = new Date("2026-01-01T00:00:00.000Z");
    const original = proposedAt.getTime();
    getChallengeWindow(proposedAt, WINDOW_SECONDS);
    expect(proposedAt.getTime()).toBe(original);
  });
});

describe("isChallengeWindowOpen", () => {
  const proposedAt = new Date("2026-01-01T00:00:00.000Z");

  it("returns true at the exact open time (inclusive lower bound)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(isChallengeWindowOpen(proposedAt, WINDOW_SECONDS, now)).toBe(true);
  });

  it("returns true during the window", () => {
    const now = new Date("2026-01-01T00:30:00.000Z"); // 30 min in
    expect(isChallengeWindowOpen(proposedAt, WINDOW_SECONDS, now)).toBe(true);
  });

  it("returns false at the exact close time (exclusive upper bound)", () => {
    const now = new Date("2026-01-01T01:00:00.000Z"); // exactly at close
    expect(isChallengeWindowOpen(proposedAt, WINDOW_SECONDS, now)).toBe(false);
  });

  it("returns false after the window has closed", () => {
    const now = new Date("2026-01-01T02:00:00.000Z"); // 1 hour after close
    expect(isChallengeWindowOpen(proposedAt, WINDOW_SECONDS, now)).toBe(false);
  });

  it("returns false before the window opens", () => {
    const now = new Date("2025-12-31T23:59:59.999Z"); // 1 ms before open
    expect(isChallengeWindowOpen(proposedAt, WINDOW_SECONDS, now)).toBe(false);
  });

  it("defaults now to the current UTC time", () => {
    // Proposed far in the future — window cannot be open yet
    const futureProposedAt = new Date(Date.now() + 86400 * 1000);
    expect(isChallengeWindowOpen(futureProposedAt, WINDOW_SECONDS)).toBe(false);
  });
});

describe("isChallengeWindowOpen with configured window duration", () => {
  it("respects a 24-hour window (86400 s)", () => {
    const proposedAt = new Date("2026-01-01T00:00:00.000Z");
    const withinWindow = new Date("2026-01-01T23:59:59.999Z");
    const afterWindow = new Date("2026-01-02T00:00:00.000Z");

    expect(isChallengeWindowOpen(proposedAt, 86400, withinWindow)).toBe(true);
    expect(isChallengeWindowOpen(proposedAt, 86400, afterWindow)).toBe(false);
  });
});
