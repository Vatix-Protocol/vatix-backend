export interface ExpiryCandidateResult {
  marketId: string;
  status: "expired" | "skipped" | "errored";
  ordersCount: number;
  collateralReleased: number;
  errorMessage?: string;
}

export interface ExpiryJobResult {
  totalCandidates: number;
  expiredCount: number;
  skippedCount: number;
  erroredCount: number;
  /**
   * True when the run stopped early because it exceeded `maxRunMs`,
   * leaving some candidates unprocessed.
   */
  truncated: boolean;
  /**
   * Number of candidates that were left unprocessed because the run was
   * truncated by `maxRunMs`. Zero when the run was not truncated.
   */
  unprocessedCount: number;
  candidates: ExpiryCandidateResult[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
