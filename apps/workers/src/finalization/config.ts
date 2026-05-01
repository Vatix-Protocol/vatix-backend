export interface FinalizationConfig {
  intervalMs: number;
  challengeWindowSeconds: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function loadFinalizationConfig(
  env: NodeJS.ProcessEnv = process.env
): FinalizationConfig {
  const intervalMs = Number(env.FINALIZATION_INTERVAL_MS ?? 60_000);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error("FINALIZATION_INTERVAL_MS must be a number >= 1000");
  }

  const challengeWindowSeconds = Number(
    env.FINALIZATION_CHALLENGE_WINDOW_SECONDS ?? 3600
  );
  if (!Number.isFinite(challengeWindowSeconds) || challengeWindowSeconds < 0) {
    throw new Error(
      "FINALIZATION_CHALLENGE_WINDOW_SECONDS must be a non-negative number"
    );
  }

  const logLevel = (env.FINALIZATION_LOG_LEVEL ??
    "info") as FinalizationConfig["logLevel"];
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(
      "FINALIZATION_LOG_LEVEL must be one of debug|info|warn|error"
    );
  }

  return { intervalMs, challengeWindowSeconds, logLevel };
}
