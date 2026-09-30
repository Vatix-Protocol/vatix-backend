#!/usr/bin/env tsx

/**
 * Production migration deploy guard (issue #1121).
 *
 * `prisma migrate deploy` is the only migration command safe for production,
 * but running it through a bare `pnpm prisma:deploy` alias leaves the operator
 * with no guard rails: a missing/invalid `DATABASE_URL`, an accidentally
 * destructive `migrate dev`/`db push`, or a leaked connection string in the
 * deploy logs.
 *
 * This wrapper is deny-by-default:
 *
 *   - `DATABASE_URL` must be set and must be a PostgreSQL URL (the prod
 *     database is always Postgres; sqlite/file URLs are rejected).
 *   - Destructive commands (`dev`, `db push`, `db push --force`,
 *     `migrate reset`, `migrate resolve --applied`) are refused, so a stray
 *     argument can never widen the blast radius of a deploy.
 *   - The connection string is redacted before anything is printed — no
 *     credentials in CI logs (scheme/host/database are kept so an operator can
 *     confirm which database was migrated).
 *   - A non-zero exit from Prisma fails the deploy (exit 1), so orchestrators
 *     never roll out app containers against a half-migrated schema.
 *
 * Rollback: run the previous image/commit's `prisma:deploy` after a
 * forward-fix migration. See docs/migration-rollback.md.
 *
 * @module scripts/deploy-migrations
 */

import { execFileSync } from "node:child_process";

export const SAFE_COMMANDS = ["deploy", "status"] as const;
export type SafeCommand = (typeof SAFE_COMMANDS)[number];

export const BLOCKED_COMMANDS = ["dev", "reset", "push", "studio"] as const;

export interface DeployEnvCheck {
  ok: boolean;
  errors: string[];
  /** Redacted DATABASE_URL, safe to print. Never contains credentials. */
  redactedUrl: string | null;
}

/**
 * Redacts credentials and host from a Postgres connection string so deploy
 * logs identify the target (scheme + database) without leaking secrets.
 */
export function redactDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hasCredentials = url.username !== "" || url.password !== "";
    const host = url.hostname || "unknown-host";
    return `${url.protocol}//${hasCredentials ? "***@" : ""}${host}/${url.pathname.replace(/^\//, "")}`;
  } catch {
    // Not parseable as a URL — do not echo the raw value, it may contain a
    // password. Report only its length so operators can spot a truncated env.
    return "<unparseable DATABASE_URL, redacted>";
  }
}

/**
 * Validates the environment before a migration deploy. Pure and exported so
 * unit tests can cover every fail-closed branch without a live database.
 */
export function checkDeployEnv(
  env: Record<string, string | undefined>
): DeployEnvCheck {
  const errors: string[] = [];
  const databaseUrl = env.DATABASE_URL;

  if (!databaseUrl || databaseUrl.trim() === "") {
    errors.push(
      "DATABASE_URL is not set — refusing to deploy migrations (fail-closed)"
    );
    return { ok: false, errors, redactedUrl: null };
  }

  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    errors.push(
      "DATABASE_URL must be a postgresql:// connection string in production; " +
        "sqlite/file URLs are rejected to protect the prod database"
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    redactedUrl: redactDatabaseUrl(databaseUrl),
  };
}

/**
 * Rejects anything that is not an explicitly safe read/apply command so a
 * stray `pnpm prisma:deploy dev --name x` cannot destroy data.
 */
export function assertSafeCommand(args: string[]): void {
  for (const arg of args) {
    const command = arg.trim().toLowerCase();
    if ((BLOCKED_COMMANDS as readonly string[]).includes(command)) {
      throw new Error(
        `Refusing to run 'prisma migrate ${command}' through prisma:deploy — ` +
          "production deploys only accept 'deploy' and 'status' " +
          `(blocked: ${BLOCKED_COMMANDS.join(", ")}). ` +
          "Use 'prisma migrate dev' locally against a dev database only."
      );
    }
    if (command.startsWith("db")) {
      throw new Error(
        `Refusing to run 'prisma ${command}' through prisma:deploy — ` +
          "schema pushes bypass migration history. Use 'prisma migrate deploy'."
      );
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  assertSafeCommand(args);

  const check = checkDeployEnv(process.env);
  if (!check.ok) {
    for (const error of check.errors) {
      console.error(`✖ ${error}`);
    }
    process.exit(1);
  }

  const command = args[0] ?? "deploy";
  if (!(SAFE_COMMANDS as readonly string[]).includes(command)) {
    console.error(
      `✖ Unknown command '${command}'. prisma:deploy only accepts: ${SAFE_COMMANDS.join(", ")}`
    );
    process.exit(1);
  }

  // Only the redacted target is logged — never the raw connection string.
  console.log(`▶ Applying Prisma migrations to ${check.redactedUrl} …`);

  try {
    execFileSync("npx", ["prisma", "migrate", command], {
      stdio: "inherit",
      env: process.env,
    });
  } catch {
    // Prisma already printed the failure via stdio:inherit. Do not add the
    // command line or the URL here — keep the deploy log secret-free.
    console.error(
      "✖ prisma migrate failed — aborting deploy. App containers must NOT be " +
        "rolled out against a partially migrated schema. See " +
        "docs/migration-rollback.md"
    );
    process.exit(1);
  }

  console.log("✓ Prisma migrations applied successfully");
}

// Run only when invoked directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
