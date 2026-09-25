export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_INDEX: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class LoggerValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "LoggerValidationError";
  }
}

function validateMsg(msg: unknown): asserts msg is string {
  if (typeof msg !== "string") {
    throw new LoggerValidationError(
      `Log message must be a string, got: ${typeof msg}`
    );
  }
}

function validatePrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== "string") {
    throw new LoggerValidationError(
      `Logger prefix must be a string, got: ${typeof prefix}`
    );
  }
}

function validateLogLevel(level: unknown): asserts level is LogLevel {
  if (level !== undefined && !LOG_LEVELS.includes(level as LogLevel)) {
    throw new LoggerValidationError(`Invalid log level: ${String(level)}`);
  }
}

export interface ILogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(childPrefix: string): ILogger;
}

export class Logger implements ILogger {
  private level: LogLevel;
  private prefix: string;

  constructor(prefix = "", level?: LogLevel) {
    validatePrefix(prefix);
    if (level !== undefined) {
      validateLogLevel(level);
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

  debug(msg: string, _meta?: Record<string, unknown>): void {
    validateMsg(msg);
    if (this.shouldLog("debug")) console.debug(this.format(msg));
  }

  info(msg: string, _meta?: Record<string, unknown>): void {
    validateMsg(msg);
    if (this.shouldLog("info")) console.info(this.format(msg));
  }

  warn(msg: string, _meta?: Record<string, unknown>): void {
    validateMsg(msg);
    if (this.shouldLog("warn")) console.warn(this.format(msg));
  }

  error(msg: string, _meta?: Record<string, unknown>): void {
    validateMsg(msg);
    if (this.shouldLog("error")) console.error(this.format(msg));
  }

  child(childPrefix: string): Logger {
    validatePrefix(childPrefix);
    const combined = this.prefix
      ? `${this.prefix}:${childPrefix}`
      : childPrefix;
    return new Logger(combined, this.level);
  }
}

export const log = (
  msg: string,
  fields: Record<string, unknown> = {}
): void => {
  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      component: "shared",
      message: msg,
      ...fields,
    })
  );
};
