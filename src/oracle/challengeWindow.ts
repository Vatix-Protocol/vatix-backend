export interface ChallengeWindow {
  proposedAt: Date;
  challengeWindowSeconds: number;
  closesAt: Date;
}

export function getChallengeWindow(
  proposedAt: Date,
  challengeWindowSeconds: number,
): ChallengeWindow {
  if (!Number.isFinite(challengeWindowSeconds) || challengeWindowSeconds < 0) {
    throw new RangeError(
      `challengeWindowSeconds must be a non-negative finite number, received ${challengeWindowSeconds}`,
    );
  }

  const closesAt = new Date(
    proposedAt.getTime() + challengeWindowSeconds * 1000,
  );

  return { proposedAt, challengeWindowSeconds, closesAt };
}

export function isChallengeWindowOpen(
  proposedAt: Date,
  challengeWindowSeconds: number,
  now: Date = new Date(),
): boolean {
  const { closesAt } = getChallengeWindow(proposedAt, challengeWindowSeconds);
  return now.getTime() < closesAt.getTime();
}

export function getChallengeWindowRemainingMs(
  proposedAt: Date,
  challengeWindowSeconds: number,
  now: Date = new Date(),
): number {
  const { closesAt } = getChallengeWindow(proposedAt, challengeWindowSeconds);
  return Math.max(0, closesAt.getTime() - now.getTime());
}
