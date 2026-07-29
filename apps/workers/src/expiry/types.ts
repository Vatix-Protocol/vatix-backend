export interface ExpiryCandidateResult {
  marketId: string;
  status: "expired" | "errored" | "skipped";
  ordersCount: number;
  collateralReleased: number;
  errorMessage?: string;
}

export interface ExpiryJobResult {
  totalCandidates: number;
  expiredCount: number;
  erroredCount: number;
  skippedCount: number;
  candidates: ExpiryCandidateResult[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
