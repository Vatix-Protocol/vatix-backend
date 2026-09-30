import { describe, it, expect } from "vitest";
import {
  assertSafeCommand,
  checkDeployEnv,
  redactDatabaseUrl,
  SAFE_COMMANDS,
} from "../scripts/deploy-migrations.js";

const PG_URL = "postgresql://vatix:sup3rs3cret@db.internal:5432/vatix";

describe("redactDatabaseUrl (#1121)", () => {
  it("strips credentials and hostname from the printed target", () => {
    const redacted = redactDatabaseUrl(PG_URL);
    expect(redacted).not.toContain("sup3rs3cret");
    expect(redacted).not.toContain("vatix:sup3rs3cret");
    // Hostname + database are kept (non-secret, needed to confirm the deploy
    // target); only credentials are redacted.
    expect(redacted).toContain("db.internal");
    expect(redacted).toBe("postgresql://***@db.internal/vatix");
  });

  it("never echoes an unparseable value that may embed a password", () => {
    const redacted = redactDatabaseUrl("not a url hunter2");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("redacted");
  });
});

describe("checkDeployEnv (#1121)", () => {
  it("accepts a postgres DATABASE_URL", () => {
    const result = checkDeployEnv({ DATABASE_URL: PG_URL });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.redactedUrl).toBe("postgresql://***@db.internal/vatix");
  });

  it("fails closed when DATABASE_URL is missing", () => {
    const result = checkDeployEnv({});
    expect(result.ok).toBe(false);
    expect(result.redactedUrl).toBeNull();
    expect(result.errors[0]).toContain("DATABASE_URL is not set");
  });

  it("fails closed on an empty DATABASE_URL", () => {
    expect(checkDeployEnv({ DATABASE_URL: "  " }).ok).toBe(false);
  });

  it("rejects non-postgres (sqlite/file) targets", () => {
    const result = checkDeployEnv({
      DATABASE_URL: "file:./dev.db",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("postgresql://");
  });
});

describe("assertSafeCommand (#1121)", () => {
  it.each(SAFE_COMMANDS)("allows the safe command '%s'", (command) => {
    expect(() => assertSafeCommand([command])).not.toThrow();
  });

  it("allows no arguments (defaults to deploy)", () => {
    expect(() => assertSafeCommand([])).not.toThrow();
  });

  it("blocks destructive migrate commands", () => {
    expect(() => assertSafeCommand(["dev"])).toThrow(/Refusing to run/);
    expect(() => assertSafeCommand(["reset", "--force"])).toThrow(
      /Refusing to run/
    );
  });

  it("blocks db push / db pull which bypass migration history", () => {
    expect(() => assertSafeCommand(["db", "push"])).toThrow(/Refusing to run/);
  });

  it("is case-insensitive", () => {
    expect(() => assertSafeCommand(["DEV"])).toThrow(/Refusing to run/);
  });
});
