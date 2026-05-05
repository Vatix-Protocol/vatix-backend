export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_INDEX: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private level: LogLevel;
  private prefix: string;

  constructor(prefix = "", level?: LogLevel) {
    if (level) {
      this.level = level;
    } else {
      const env = process.env.LOG_LEVEL;
      if (env && LOG_LEVELS.includes(env as LogLevel)) {
        this.level = env as LogLevel;
      } else {
        if (env) {
          process.stderr.write(
            `Invalid LOG_LEVEL "${env}", falling back to "info"\n`
          );
        }
        this.level = "info";
      }
    }
    this.prefix = prefix;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_INDEX[level] >= LEVEL_INDEX[this.level];
  }

  private format(msg: string): string {
    return this.prefix ? `[${this.prefix}] ${msg}` : msg;
  }

  debug(msg: string): void {
    if (this.shouldLog("debug")) console.debug(this.format(msg));
  }

  info(msg: string): void {
    if (this.shouldLog("info")) console.info(this.format(msg));
  }

  warn(msg: string): void {
    if (this.shouldLog("warn")) console.warn(this.format(msg));
  }

  error(msg: string): void {
    if (this.shouldLog("error")) console.error(this.format(msg));
  }

  child(childPrefix: string): Logger {
    const combined = this.prefix
      ? `${this.prefix}:${childPrefix}`
      : childPrefix;
    return new Logger(combined, this.level);
  }
}

export const log = (...args: unknown[]) => {
  console.log("[shared]", ...args);
};
