/**
 * Challenge window utilities for oracle resolution candidates.
 *
 * All timestamps are UTC. The challenge window opens at proposedAt and
 * closes at proposedAt + challengeWindowSeconds.
 */

export interface ChallengeWindow {
  opensAt: Date;
  closesAt: Date;
}

/**
 * Compute the challenge window for a resolution candidate.
 *
 * @param proposedAt - UTC timestamp when the candidate was proposed.
 * @param challengeWindowSeconds - Duration of the window in seconds.
 */
export function getChallengeWindow(
  proposedAt: Date,
  challengeWindowSeconds: number
): ChallengeWindow {
  const opensAt = new Date(proposedAt.getTime());
  const closesAt = new Date(proposedAt.getTime() + challengeWindowSeconds * 1000);
  return { opensAt, closesAt };
}

/**
 * Returns true if the challenge window is still open at the given UTC time.
 *
 * @param proposedAt - UTC timestamp when the candidate was proposed.
 * @param challengeWindowSeconds - Duration of the window in seconds.
 * @param now - Current UTC time (defaults to Date.now()).
 */
export function isChallengeWindowOpen(
  proposedAt: Date,
  challengeWindowSeconds: number,
  now: Date = new Date()
): boolean {
  const { opensAt, closesAt } = getChallengeWindow(proposedAt, challengeWindowSeconds);
  return now >= opensAt && now < closesAt;
}
