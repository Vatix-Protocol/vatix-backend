export interface ArchivedEventResult {
  marketId: string;
  streamId: string;
  status: "archived" | "skipped" | "error";
  errorMessage?: string;
}

export interface RetentionResult {
  /** Rows actually deleted. */
  purgedCount: number;
  /** True when retention is disabled (kill-switch off); nothing was deleted. */
  disabled: boolean;
  /** Markets that contributed deleted rows. */
  marketCount: number;
  /** Cutoff applied, when retention is enabled. */
  cutoff?: string;
}

export interface AuditArchiverJobResult {
  totalEvents: number;
  archivedCount: number;
  skippedCount: number;
  erroredCount: number;
  events: ArchivedEventResult[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  archiveLagMs?: number;
  /** Retention purge outcome for this run. */
  retention?: RetentionResult;
}
