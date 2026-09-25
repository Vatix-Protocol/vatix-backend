/**
 * Tests for the generate-keypair secret-safety policy (issue #989).
 *
 * Verifies that:
 *   1. The script refuses to print the secret seed to stdout in CI /
 *      non-interactive / production contexts (fail-fast).
 *   2. `--out <path>` writes the seed to a 0600 file and never to stdout.
 *   3. Locally (interactive TTY, non-CI) the seed is still printed.
 *   4. No log line ever contains the secret seed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeypair,
  isSecretPrintingUnsafe,
  parseArgs,
  run,
} from "../scripts/generate-keypair.js";

// Anchored forms — for exact-value assertions.
const STELLAR_SECRET_EXACT = /^S[A-Z2-7]{55}$/;
const STELLAR_PUBLIC_EXACT = /^G[A-Z2-7]{55}$/;
// Unanchored forms — for "output contains a seed/key somewhere" assertions.
const STELLAR_SECRET = /S[A-Z2-7]{55}/;
const STELLAR_PUBLIC = /G[A-Z2-7]{55}/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateKeypair()", () => {
  it("returns a well-formed Stellar keypair", () => {
    const { publicKey, secret } = generateKeypair();
    expect(publicKey).toMatch(STELLAR_PUBLIC_EXACT);
    expect(secret).toMatch(STELLAR_SECRET_EXACT);
  });
});

describe("isSecretPrintingUnsafe()", () => {
  it("is unsafe when CI=true", () => {
    expect(isSecretPrintingUnsafe({ CI: "true" }, true)).toBe(true);
  });

  it("is unsafe under GitHub Actions", () => {
    expect(isSecretPrintingUnsafe({ GITHUB_ACTIONS: "true" }, true)).toBe(true);
  });

  it("is unsafe in production regardless of TTY", () => {
    expect(isSecretPrintingUnsafe({ NODE_ENV: "production" }, true)).toBe(true);
  });

  it("is unsafe when stdout is not a TTY", () => {
    expect(isSecretPrintingUnsafe({}, false)).toBe(true);
  });

  it("is safe on an interactive local shell", () => {
    expect(isSecretPrintingUnsafe({ CI: "false" }, true)).toBe(false);
  });
});

describe("parseArgs()", () => {
  it("parses --out / --public-only / --json / --force / --help", () => {
    expect(parseArgs(["--out", "x.env", "--force"])).toMatchObject({
      out: "x.env",
      force: true,
    });
    expect(parseArgs(["--public-only"])).toMatchObject({ publicOnly: true });
    expect(parseArgs(["--json"])).toMatchObject({ json: true });
    expect(parseArgs(["-h"])).toMatchObject({ help: true });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
  });

  it("rejects --out with no value", () => {
    expect(() => parseArgs(["--out"])).toThrow(/--out requires/);
  });
});

describe("run() — CI / non-interactive safety", () => {
  it("throws instead of printing the secret when the context is unsafe", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => run([], { CI: "true" }, false)).toThrow(
      /Refusing to print the Stellar secret seed/i
    );

    const printed = stdout.mock.calls.map((c) => String(c[0])).join("");
    const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).not.toMatch(STELLAR_SECRET);
    expect(logged).not.toMatch(STELLAR_SECRET);
  });

  it("prints only the public key with --public-only in an unsafe context", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    run(["--public-only"], { CI: "true" }, false);

    const printed = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toMatch(STELLAR_PUBLIC);
    expect(printed).not.toMatch(STELLAR_SECRET);
  });

  it("prints the secret on an interactive local shell", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    run([], { CI: "false" }, true);

    const printed = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toMatch(STELLAR_SECRET);
    expect(printed).toContain("ORACLE_SECRET_KEY=");
  });
});

describe("run() — --out file handling", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keypair-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the secret to a 0600 file and keeps it off stdout, even in CI", () => {
    const target = join(dir, "oracle.env");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    run(["--out", target], { CI: "true" }, false);

    expect(existsSync(target)).toBe(true);
    const contents = readFileSync(target, "utf8");
    expect(contents).toMatch(/^ORACLE_SECRET_KEY=S[A-Z2-7]{55}\n$/);
    expect(statSync(target).mode & 0o777).toBe(0o600);

    const printed = stdout.mock.calls.map((c) => String(c[0])).join("");
    const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).not.toMatch(STELLAR_SECRET);
    expect(logged).not.toMatch(STELLAR_SECRET);
    expect(printed).toMatch(STELLAR_PUBLIC);
  });

  it("refuses to overwrite an existing file without --force", () => {
    const target = join(dir, "oracle.env");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    run(["--out", target], { CI: "true" }, false);
    expect(() => run(["--out", target], { CI: "true" }, false)).toThrow(
      /Refusing to overwrite/
    );
    run(["--out", target, "--force"], { CI: "true" }, false);
  });
});
