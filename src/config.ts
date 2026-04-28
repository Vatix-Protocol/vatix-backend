/**
 * API config — re-exports the shared typed config loader.
 * Import `getConfig()` or `loadConfig()` from here for API-layer use.
 */
export { loadConfig, getConfig, resetConfig } from "../../packages/shared/src/config.js";
export type { AppConfig } from "../../packages/shared/src/config.js";

// Convenience accessor kept for backwards compatibility.
import { getConfig } from "../../packages/shared/src/config.js";

export const config = {
  get oracle() {
    return getConfig().oracle;
  },
} as const;
