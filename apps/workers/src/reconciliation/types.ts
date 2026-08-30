export interface ReconciliationResult {
  reconciledCount: number;
  driftCount: number;
  recoveredCount: number;
  duration: number;
}

export interface ReconciliationJobResult {
  success: boolean;
  totalMarkets: number;
  completedMarkets: number;
  failedMarkets: number;
  aggregateStats: {
    reconciledCount: number;
    driftCount: number;
    recoveredCount: number;
  };
  duration: number;
}
