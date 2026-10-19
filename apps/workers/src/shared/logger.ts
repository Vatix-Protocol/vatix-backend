import { Logger } from "@vatix/shared/logger.js";
import { redactLogFields } from "@vatix/shared/logRedactor.js";

export type WorkerLogLevel = "debug" | "info" | "warn" | "error";

export interface WorkerLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<WorkerLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(level: string): WorkerLogLevel {
  const lowered = level.toLowerCase();
  if (lowered in LEVEL_ORDER) {
    return lowered as WorkerLogLevel;
  }
  return "info";
}

/**
 * Builds a worker logger that honours the configured log level and applies the
 * shared redaction rules so log records have a consistent shape across workers.
 */
export function createWorkerLogger(
  component: string,
  level: string
): WorkerLogger {
  const threshold = LEVEL_ORDER[normalizeLevel(level)];
  const logger = new Logger(component);

  const emit = (
    recordLevel: WorkerLogLevel,
    message: string,
    fields?: Record<string, unknown>
  ): void => {
    if (LEVEL_ORDER[recordLevel] < threshold) {
      return;
    }
    const redacted = fields ? redactLogFields(fields) : undefined;
    logger[recordLevel](message, redacted);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
