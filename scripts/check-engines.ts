#!/usr/bin/env tsx
/**
 * Engine parity guard (issue #986).
 *
 * "Dev on 20 vs CI 22 hides breakage." This script is the single check that
 * keeps the toolchain version pinned across every context:
 *
 *   - the running Node.js and pnpm satisfy `engines` in package.json, and
 *   - `.nvmrc`, the `engines.node` floor, and the CI workflow's Node version
 *     all agree on the same Node major.
 *
 * Production/dev split:
 *   - CI (`CI` set) or `NODE_ENV=production`  -> fail-fast, exit 1 on any drift.
 *   - Local dev                              -> warn only, exit 0, so a
 *                                                 contributor on the wrong
 *                                                 Node still gets a nudge
 *                                                 without being blocked.
 *
 * `.npmrc` sets `engine-strict=true`, so `pnpm install` already refuses a
 * mismatched Node/pnpm; this script additionally catches config files that
 * have drifted apart from each other (which `engine-strict` cannot see).
 *
 * @module scripts/check-engines
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface EngineCheckResult {
  ok: boolean;
  errors: string[];
  info: Record<string, unknown>;
}

/** Parse a leading `X.Y.Z` (or `X.Y` / `X`) into a [major, minor, patch] tuple. */
export function parseVersion(raw: string): [number, number, number] {
  const match = raw.trim().match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) throw new Error(`Unparseable version string: "${raw}"`);
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** Minimal `>=X.Y.Z` range check — the only operator `engines` uses here. */
export function satisfiesMinRange(version: string, range: string): boolean {
  const floor = range.match(/>=\s*([\d.]+)/);
  if (!floor) return true; // ranges we don't model are treated as satisfied
  const [vMaj, vMin, vPat] = parseVersion(version);
  const [rMaj, rMin, rPat] = parseVersion(floor[1]);
  if (vMaj !== rMaj) return vMaj > rMaj;
  if (vMin !== rMin) return vMin > rMin;
  return vPat >= rPat;
}

interface CheckInputs {
  packageJson: string;
  nvmrc: string;
  ciWorkflow: string;
  nodeVersion: string; // e.g. "22.4.1"
  pnpmVersion: string | undefined; // e.g. "10.15.0"
}

export function evaluateEngines(inputs: CheckInputs): EngineCheckResult {
  const errors: string[] = [];
  const pkg = JSON.parse(inputs.packageJson) as {
    engines?: { node?: string; pnpm?: string };
  };
  const nodeRange = pkg.engines?.node ?? "";
  const pnpmRange = pkg.engines?.pnpm ?? "";

  const nvmrcMajor = parseVersion(inputs.nvmrc)[0];
  const engineNodeMajor = nodeRange
    ? parseVersion(nodeRange.replace(/[^\d.]/g, "") || "0")[0]
    : NaN;
  const ciNodeMatch = inputs.ciWorkflow.match(
    /node-version(?:-file)?:\s*["']?([^"'\n]+)["']?/
  );
  const ciNodeRaw = ciNodeMatch?.[1]?.trim();
  const ciNodeMajor =
    ciNodeRaw && ciNodeRaw.includes(".nvmrc")
      ? nvmrcMajor // CI reads .nvmrc — parity by construction
      : ciNodeRaw
        ? parseVersion(ciNodeRaw)[0]
        : NaN;

  const runningNodeMajor = parseVersion(inputs.nodeVersion)[0];

  if (Number.isNaN(engineNodeMajor)) {
    errors.push("package.json engines.node is missing or unparseable");
  }
  if (nvmrcMajor !== engineNodeMajor) {
    errors.push(
      `.nvmrc (Node ${nvmrcMajor}) disagrees with package.json engines.node floor (Node ${engineNodeMajor})`
    );
  }
  if (!Number.isNaN(ciNodeMajor) && ciNodeMajor !== nvmrcMajor) {
    errors.push(
      `CI workflow Node major (${ciNodeMajor}) disagrees with .nvmrc (Node ${nvmrcMajor})`
    );
  }
  if (runningNodeMajor !== nvmrcMajor) {
    errors.push(
      `running Node ${inputs.nodeVersion} (major ${runningNodeMajor}) does not match the pinned Node ${nvmrcMajor} — ` +
        `use \`nvm use\` (reads .nvmrc) or your version manager's equivalent`
    );
  }
  if (nodeRange && !satisfiesMinRange(inputs.nodeVersion, nodeRange)) {
    errors.push(
      `running Node ${inputs.nodeVersion} does not satisfy engines.node "${nodeRange}"`
    );
  }
  if (
    pnpmRange &&
    inputs.pnpmVersion &&
    !satisfiesMinRange(inputs.pnpmVersion, pnpmRange)
  ) {
    errors.push(
      `running pnpm ${inputs.pnpmVersion} does not satisfy engines.pnpm "${pnpmRange}"`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    info: {
      nodeRange,
      pnpmRange,
      nvmrcMajor,
      ciNodeMajor: Number.isNaN(ciNodeMajor) ? null : ciNodeMajor,
      runningNode: inputs.nodeVersion,
      runningPnpm: inputs.pnpmVersion ?? null,
    },
  };
}

function detectPnpmVersion(env: NodeJS.ProcessEnv): string | undefined {
  const ua = env.npm_config_user_agent ?? "";
  const match = ua.match(/pnpm\/([\d.]+)/);
  if (match) return match[1];
  return env.PNPM_VERSION || undefined;
}

function log(
  level: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "check-engines",
      message,
      ...meta,
    }) + "\n"
  );
}

export function run(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): number {
  const result = evaluateEngines({
    packageJson: readFileSync(resolve(cwd, "package.json"), "utf8"),
    nvmrc: readFileSync(resolve(cwd, ".nvmrc"), "utf8"),
    ciWorkflow: readFileSync(resolve(cwd, ".github/workflows/ci.yml"), "utf8"),
    nodeVersion: process.versions.node,
    pnpmVersion: detectPnpmVersion(env),
  });

  const failFast =
    Boolean(env.CI && env.CI !== "false") || env.NODE_ENV === "production";

  if (result.ok) {
    log("info", "Engine parity check passed", result.info);
    return 0;
  }

  for (const error of result.errors) {
    log(failFast ? "error" : "warn", error);
  }

  if (failFast) {
    log(
      "error",
      "Engine parity check failed (fail-fast: CI/production)",
      result.info
    );
    return 1;
  }

  log(
    "warn",
    "Engine parity check found drift (warn-only: local dev)",
    result.info
  );
  return 0;
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  process.exit(run());
}
