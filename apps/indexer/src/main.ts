import { validateEnv, EnvValidationError } from './env';

async function main(): Promise<void> {
  let env;
  try {
    env = validateEnv(process.env);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Fail-closed: log only variable names and stable error codes, never values.
      for (const issue of err.issues) {
        console.error(`[env] ${issue.code} ${issue.name}`);
      }
      console.error('[env] refusing to boot: invalid configuration');
      process.exit(1);
    }
    throw err;
  }

  // Boot proceeds only with a fully validated, fail-closed configuration.
  await start(env);
}

async function start(env: ReturnType<typeof validateEnv>): Promise<void> {
  // Existing startup wiring continues here using the validated env.
}

main().catch((err) => {
  console.error('[boot] fatal error', err instanceof Error ? err.message : 'unknown');
  process.exit(1);
});
