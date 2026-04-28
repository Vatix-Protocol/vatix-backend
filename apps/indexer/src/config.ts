/**
 * Indexer config — thin wrapper around the shared typed config loader.
 */
import { loadConfig as loadSharedConfig } from "../../../packages/shared/src/config.js";

export type { AppConfig as IndexerConfig } from "../../../packages/shared/src/config.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return loadSharedConfig(env).indexer;
}
