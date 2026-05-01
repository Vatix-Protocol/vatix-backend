import { redactMeta } from "../../packages/shared/src/logRedactor.js";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(level: LogLevel): Logger {
  const threshold = LOG_LEVEL_WEIGHT[level];

  const write = (
    logLevel: LogLevel,
    message: string,
    meta?: Record<string, unknown>
  ) => {
    if (LOG_LEVEL_WEIGHT[logLevel] < threshold) {
      return;
    }

    const base = {
      ts: new Date().toISOString(),
      level: logLevel,
      message,
    };
    const safeMeta = redactMeta(meta);
    const payload = safeMeta ? { ...base, ...safeMeta } : base;
    const line = JSON.stringify(payload);

    if (logLevel === "error") {
      console.error(line);
      return;
    }

    console.log(line);
  };

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}
