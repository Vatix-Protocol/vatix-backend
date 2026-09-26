import {
  redactMeta,
  redactText,
} from "../../../packages/shared/src/logRedactor.js";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(childPrefix: string): Logger;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Envelope fields owned by the logger. A `meta` key matching one of these is
 * **not** allowed to overwrite it.
 *
 * Without this, any caller passing attacker-influenced data could forge the log
 * record: `logger.info("legit", { level: "error", message: "spoofed" })`
 * emitted a line whose severity and text were entirely caller-controlled,
 * corrupting alerting and any log-based incident response. Collisions are
 * namespaced under `meta` instead of silently dropped.
 */
const RESERVED_KEYS = ["ts", "level", "message", "component"] as const;

function splitReservedKeys(
  safeMeta: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!safeMeta) return undefined;

  const collisions: Record<string, unknown> = {};
  let hasCollision = false;

  for (const [k, v] of Object.entries(safeMeta)) {
    if ((RESERVED_KEYS as readonly string[]).includes(k)) {
      collisions[k] = v;
      hasCollision = true;
    }
  }

  if (!hasCollision) return safeMeta;

  // Copy without the colliding keys, then re-attach them namespaced so no
  // information is lost and nothing is silently dropped.
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(safeMeta)) {
    if (!(RESERVED_KEYS as readonly string[]).includes(k)) {
      result[k] = v;
    }
  }
  result.meta = { ...(safeMeta.meta as object | undefined), ...collisions };
  return result;
}

function stringifyLogPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

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
      // The message is caller-controlled text that commonly embeds URLs, tokens
      // and error strings, so it gets the same redaction as `meta`. Redacting
      // only `meta` left secrets in the free-text field fully exposed.
      message: redactText(message),
    };
    // Redact first, then move any envelope-key collisions under `meta` so
    // caller data can never forge the timestamp, level, or message.
    const safeMeta = splitReservedKeys(redactMeta(meta));
    const payload = safeMeta ? { ...base, ...safeMeta } : base;

    // A logger must never throw: callers log from catch blocks and error
    // handlers, where a throw would mask the original failure and can take down
    // a long-running worker. Unserializable meta (circular refs, exotic getters)
    // degrades to a minimal, still-redacted line.
    let line: string;
    try {
      line = stringifyLogPayload(payload);
    } catch {
      line = JSON.stringify({
        ts: base.ts,
        level: logLevel,
        message: base.message,
        logSerializationError: true,
      });
    }

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
    child: (_childPrefix: string) => createLogger(level),
  };
}
