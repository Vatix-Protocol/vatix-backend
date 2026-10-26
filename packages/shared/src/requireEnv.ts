import { logger as defaultLogger, type ILogger } from "./logger";

export interface RequireEnvOptions {
  env?: Record<string, string | undefined>;
  logger?: Pick<ILogger, "error">;
  exit?: (code: number) => void;
}

export function requireEnv(
  keys: string[],
  options: RequireEnvOptions = {}
): void {
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const missing = keys.filter((key) => {
    const value = env[key];
    return value === undefined || value === "";
  });

  if (missing.length === 0) {
    return;
  }

  logger.error("Missing required environment variables", {
    message: "Missing required environment variables",
    missing,
    count: missing.length,
  });

  exit(1);
}
