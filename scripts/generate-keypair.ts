#!/usr/bin/env tsx
/**
 * Generate a Stellar keypair for oracle signing.
 *
 * Secret-safety policy (issue #989)
 * ---------------------------------
 * A Stellar secret seed is a bearer credential: whoever reads it controls the
 * oracle signer. GitHub Actions (and any other CI) persist step logs, so a
 * plain `console.log(secret)` in a workflow step leaks the seed to anyone who
 * can view the run.
 *
 * This script therefore refuses to print the secret seed to stdout when it
 * detects a non-interactive / CI / production context. In that case the seed
 * can only be written to a file (`--out <path>`, created with 0600
 * permissions) so it never lands in a log stream. Locally (interactive TTY,
 * non-CI, non-production) the seed is printed as before for convenience, with
 * an explicit warning.
 *
 * Usage:
 *   pnpm generate:keypair                     # local: prints secret + public key
 *   pnpm generate:keypair -- --out oracle.env # any env: writes secret to file (0600)
 *   pnpm generate:keypair -- --public-only    # only ever prints the public key
 *   pnpm generate:keypair -- --json           # machine-readable public key on stdout
 *
 * @module scripts/generate-keypair
 */

import { Keypair } from "@stellar/stellar-sdk";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GeneratedKeypair {
  publicKey: string;
  secret: string;
}

export interface CliOptions {
  out?: string;
  publicOnly: boolean;
  json: boolean;
  force: boolean;
  help: boolean;
}

/**
 * True when the script is running somewhere its stdout is captured and
 * retained (CI logs) or where printing a live secret is never acceptable
 * (production). In those contexts the secret must go to a file, not stdout.
 */
export function isSecretPrintingUnsafe(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = Boolean(process.stdout.isTTY)
): boolean {
  if (env.CI && env.CI !== "false") return true;
  if (env.GITHUB_ACTIONS && env.GITHUB_ACTIONS !== "false") return true;
  if (env.NODE_ENV === "production") return true;
  if (!isTty) return true;
  return false;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    publicOnly: false,
    json: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--out":
      case "-o":
        options.out = argv[++i];
        if (!options.out) {
          throw new Error("--out requires a file path argument");
        }
        break;
      case "--public-only":
        options.publicOnly = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--force":
      case "-f":
        options.force = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return options;
}

export function generateKeypair(): GeneratedKeypair {
  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey(), secret: keypair.secret() };
}

function log(
  level: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  // Logs go to stderr so `--json` keeps stdout clean and machine-parseable.
  // The secret is never included in a log line.
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "generate-keypair",
      message,
      ...meta,
    }) + "\n"
  );
}

const HELP = `
Generate a Stellar keypair for oracle signing.

Options:
  -o, --out <path>   Write "ORACLE_SECRET_KEY=<seed>" to <path> (created 0600).
                     Required when stdout is captured (CI / non-TTY / production).
      --public-only  Only print the public key; never emit the secret.
      --json         Emit {"publicKey": "..."} on stdout (secret never included).
  -f, --force        Overwrite --out target if it already exists.
  -h, --help         Show this help.

Secret safety: this script refuses to print the secret seed to stdout in CI,
non-interactive shells, or NODE_ENV=production. Use --out to capture it safely.
`;

export function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = Boolean(process.stdout.isTTY)
): void {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const { publicKey, secret } = generateKeypair();
  const secretUnsafe = isSecretPrintingUnsafe(env, isTty);

  if (options.out) {
    const target = resolve(options.out);
    if (existsSync(target) && !options.force) {
      throw new Error(
        `Refusing to overwrite existing file "${target}" (pass --force to override)`
      );
    }
    writeFileSync(target, `ORACLE_SECRET_KEY=${secret}\n`, { mode: 0o600 });
    // writeFileSync only applies `mode` when creating the file; force it for
    // the overwrite case too.
    chmodSync(target, 0o600);
    log("info", "Wrote oracle secret key to file", {
      path: target,
      publicKey,
      mode: "0600",
    });
    process.stdout.write(
      options.json
        ? JSON.stringify({ publicKey, out: target }) + "\n"
        : `Public Key: ${publicKey}\nSecret written to ${target} (chmod 0600). Keep it out of version control.\n`
    );
    return;
  }

  if (options.publicOnly || options.json) {
    process.stdout.write(
      options.json
        ? JSON.stringify({ publicKey }) + "\n"
        : `Public Key: ${publicKey}\n`
    );
    return;
  }

  if (secretUnsafe) {
    log(
      "error",
      "Refusing to print secret seed in a non-interactive / CI / production context",
      {
        publicKey,
        hint: "re-run with --out <path> to write the secret to a 0600 file, or --public-only",
      }
    );
    throw new Error(
      "Refusing to print the Stellar secret seed to stdout in CI / non-interactive / production. " +
        "Re-run with `--out <path>` to write it to a protected file, or `--public-only`."
    );
  }

  process.stdout.write(
    [
      "",
      "Generated Stellar Keypair:",
      "========================",
      `Secret Key: ${secret}`,
      `Public Key: ${publicKey}`,
      "",
      "Add this to your .env file (never commit it):",
      `ORACLE_SECRET_KEY=${secret}`,
      "",
    ].join("\n")
  );
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    log("error", "generate-keypair failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}
