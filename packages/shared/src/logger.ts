/**
 * Shared logger for API, indexer, and workers.
 *
 * Reads LOG_LEVEL from the environment. Invalid values fall back to "info"
 * with a one-time warning printed to stderr.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLevel(raw: string | undefined): LogLevel {
  if (raw && (LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  if (raw !== undefined && raw !== "") {
    process.stderr.write(
      `[logger] Invalid LOG_LEVEL "${raw}". Valid values: ${LOG_LEVELS.join(", ")}. Falling back to "info".\n`
    );
  }
  return "info";
}

export class Logger {
  private level: LogLevel;
  private readonly prefix: string;

  constructor(prefix = "", level?: LogLevel) {
    this.prefix = prefix ? `[${prefix}] ` : "";
    this.level = level ?? resolveLevel(process.env.LOG_LEVEL);
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
  }

  private format(level: LogLevel, message: string): string {
    return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${this.prefix}${message}`;
  }

  debug(message: string, meta?: unknown): void {
    if (this.shouldLog("debug")) {
      console.debug(this.format("debug", message), ...(meta !== undefined ? [meta] : []));
    }
  }

  info(message: string, meta?: unknown): void {
    if (this.shouldLog("info")) {
      console.info(this.format("info", message), ...(meta !== undefined ? [meta] : []));
    }
  }

  warn(message: string, meta?: unknown): void {
    if (this.shouldLog("warn")) {
      console.warn(this.format("warn", message), ...(meta !== undefined ? [meta] : []));
    }
  }

  error(message: string, meta?: unknown): void {
    if (this.shouldLog("error")) {
      console.error(this.format("error", message), ...(meta !== undefined ? [meta] : []));
    }
  }

  /** Return a child logger with a sub-prefix, inheriting the current level. */
  child(prefix: string): Logger {
    const child = new Logger(this.prefix ? `${this.prefix.slice(1, -2)}:${prefix}` : prefix, this.level);
    return child;
  }
}

/** Default singleton logger. Re-reads LOG_LEVEL on first use. */
export const logger = new Logger();
