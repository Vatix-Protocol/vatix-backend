export interface ArchivedEventResult {
  marketId: string;
  streamId: string;
  status: "archived" | "skipped" | "error";
  errorMessage?: string;
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
}
