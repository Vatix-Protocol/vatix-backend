export interface Telemetry {
  record(metric: string, value: number, tags?: Record<string, string>): void;
}

export const consoleTelemetry: Telemetry = {
  record(metric, value, tags) {
    const tagStr = tags ? ` ${JSON.stringify(tags)}` : "";
    console.log(`[telemetry] ${metric}=${value}${tagStr}`);
  },
};
