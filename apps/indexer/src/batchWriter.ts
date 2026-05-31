import type { NormalizedTrade, NormalizedResolution } from "./types.js";

export type BatchRecord =
  | { kind: "trade"; data: NormalizedTrade }
  | { kind: "resolution"; data: NormalizedResolution };

export interface BatchWriteError {
  record: BatchRecord;
  error: string;
}

export interface BatchWriteResult {
  written: number;
  skipped: number;
  errors: BatchWriteError[];
}

export interface BatchWriter {
  write(records: BatchRecord[]): Promise<BatchWriteResult>;
  flush(): Promise<void>;
}
