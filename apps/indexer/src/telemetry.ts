export interface Span {
  end(tags?: Record<string, string>): void;
}

export interface Telemetry {
  record(metric: string, value: number, tags?: Record<string, string>): void;
  /** Starts a span for a named stage; call `.end()` when the stage completes. */
  startSpan(name: string, tags?: Record<string, string>): Span;
}

export const consoleTelemetry: Telemetry = {
  record(metric, value, tags) {
    const tagStr = tags ? ` ${JSON.stringify(tags)}` : "";
    console.log(`[telemetry] ${metric}=${value}${tagStr}`);
  },
  startSpan(name, startTags) {
    const startedAt = performance.now();
    return {
      end(endTags) {
        const durationMs = performance.now() - startedAt;
        const tags = { ...startTags, ...endTags };
        const tagStr = Object.keys(tags).length
          ? ` ${JSON.stringify(tags)}`
          : "";
        console.log(
          `[telemetry] span ${name} duration_ms=${durationMs.toFixed(2)}${tagStr}`
        );
      },
    };
  },
};
