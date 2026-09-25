import { loadConfig, EnvValidationError } from './config.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Fail-closed: log only variable names and stable error codes, never values.
      logger.error('[env] refusing to boot: invalid configuration', {
        code: err.code,
        variable: err.variable,
      });
      process.exit(1);
    }
    throw err;
  }

  // Boot proceeds only with a fully validated, fail-closed configuration.
  await start(config);
}

async function start(config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  // Existing startup wiring continues here using the validated config.
  logger.info('[indexer] configuration validated successfully', {
    networkPassphrase: config.sorobanNetworkPassphrase,
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
  });
}

main().catch((err) => {
  logger.error('[boot] fatal error', {
    message: err instanceof Error ? err.message : 'unknown',
  });
  process.exit(1);
}