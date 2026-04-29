/**
 * API server config — thin re-export of the shared config loader.
 *
 * Loaded once at startup; the frozen object is passed to routes/middleware
 * rather than reading process.env directly.
 */
export type { NodeEnv, BaseConfig as Config } from "../packages/shared/src/config.js";
export { loadBaseConfig } from "../packages/shared/src/config.js";

export const config = loadBaseConfig();
