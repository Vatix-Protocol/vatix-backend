export interface StartupHealthInput {
  cursor: string | null;
  networkId: string;
  cursorKey: string;
  /** process.env.DATABASE_URL — required for the indexer to persist cursor/events. */
  databaseUrl: string | undefined;
}

export interface StartupHealthResult {
  status: 200 | 400;
  valid: boolean;
  errors: string[];
}

export function checkStartupHealth(
  input: StartupHealthInput
): StartupHealthResult {
  const errors: string[] = [];

  if (!input.databaseUrl || input.databaseUrl.trim() === "") {
    errors.push("Missing required environment variable: DATABASE_URL");
  }

  if (!input.networkId || input.networkId.trim() === "") {
    errors.push("networkId must not be empty");
  }

  if (!input.cursorKey || input.cursorKey.trim() === "") {
    errors.push("cursorKey must not be empty");
  }

  if (input.cursor !== null) {
    const seq = Number(input.cursor);
    if (!Number.isFinite(seq) || seq < 0 || !Number.isInteger(seq)) {
      errors.push(
        `cursor must be a non-negative integer, got: ${JSON.stringify(input.cursor)}`
      );
    }
  }

  if (errors.length > 0) {
    return { status: 400, valid: false, errors };
  }

  return { status: 200, valid: true, errors: [] };
}

// ─── Live dependency readiness (#947) ────────────────────────────────────────
//
// `checkStartupHealth` above is pure config-shape validation — it never
// touches the network. It cannot catch "DATABASE_URL is well-formed but
// Postgres isn't accepting connections yet" or "Horizon/Soroban RPC is
// unreachable", both of which let the poller start against a dependency
// that isn't actually ready and poison the cursor (e.g. commit a cursor
// past ledgers it never really fetched because of a bad/partial RPC
// response). `checkLiveDependencies` performs real I/O probes instead.

export interface DependencyProbe {
  /** Short, log-friendly name, e.g. "database" or "horizon". */
  name: string;
  check: () => Promise<void>;
}

export interface LiveDependencyCheckOptions {
  nodeEnv: string;
  /** Retries per probe before giving up. Default 5. */
  retries?: number;
  /** Delay between retries, in ms. Default 1000. */
  retryDelayMs?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Run the live probe even outside production (e.g. an explicit ops check). */
  force?: boolean;
}

export interface LiveDependencyResult {
  ready: boolean;
  /** True when the check was skipped entirely (non-production, not forced). */
  skipped: boolean;
  errors: string[];
}

const DEFAULT_LIVE_CHECK_RETRIES = 5;
const DEFAULT_LIVE_CHECK_RETRY_DELAY_MS = 1000;

/**
 * Confirms every dependency probe (DB, Horizon/RPC, ...) actually succeeds
 * before the caller starts polling.
 *
 * Retries with a fixed delay to tolerate ordinary startup jitter (DB or
 * Horizon still coming up during a coordinated deploy), but never waits
 * forever — after `retries` attempts a still-failing probe is reported as
 * not ready so the caller can fail fast instead of guessing.
 *
 * Production/dev split (no silent off-chain fallback in production): in
 * `production` this always runs and a failure must be treated as fatal by
 * the caller. Outside production it is skipped by default — unit/CI runs
 * must not require a live DB/Horizon — mirroring the offline-dev allowance
 * documented for Stellar config in docs/environment_variables.md. Pass
 * `force: true` to run it anyway (e.g. a local smoke test).
 */
export async function checkLiveDependencies(
  probes: DependencyProbe[],
  options: LiveDependencyCheckOptions
): Promise<LiveDependencyResult> {
  const isProduction = options.nodeEnv === "production";
  if (!isProduction && !options.force) {
    return { ready: true, skipped: true, errors: [] };
  }

  const retries = options.retries ?? DEFAULT_LIVE_CHECK_RETRIES;
  const retryDelayMs =
    options.retryDelayMs ?? DEFAULT_LIVE_CHECK_RETRY_DELAY_MS;
  const sleepFn =
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const errors: string[] = [];

  for (const probe of probes) {
    let lastError: unknown;
    let ready = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await probe.check();
        ready = true;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await sleepFn(retryDelayMs);
        }
      }
    }

    if (!ready) {
      const message =
        lastError instanceof Error ? lastError.message : String(lastError);
      errors.push(`${probe.name} is not ready: ${message}`);
    }
  }

  return { ready: errors.length === 0, skipped: false, errors };
}
