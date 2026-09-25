/**
 * Redis TLS / auth resolution tests (#1131).
 *
 * The invariants worth locking down:
 *   - TLS is never silently disabled: a rediss:// URL or REDIS_TLS=true turns
 *     it on, and REDIS_TLS_REQUIRED=true fails closed when it is off.
 *   - Contradictory config (rediss:// + REDIS_TLS=false) is rejected instead of
 *     guessed, and a username without a password never connects.
 *   - Credentials and secrets never appear in the redacted endpoint used for
 *     logs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REDIS_CONFIG_ERROR_CODES,
  RedisConfigError,
  redactRedisUrl,
  redisAuthFromEnv,
  redisAuthFromUrl,
  redisConnectionFromEnv,
  redisTlsFromEnv,
} from "./queue-config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RedisConfigError);
    expect((err as RedisConfigError).code).toBe(code);
    return;
  }
  throw new Error(`expected a RedisConfigError with code ${code}`);
}

describe("redisTlsFromEnv (#1131)", () => {
  it("returns undefined for a plaintext URL with no flag", () => {
    expect(redisTlsFromEnv("redis://localhost:6379", {})).toBeUndefined();
  });

  it("enables TLS for a rediss:// URL", () => {
    expect(redisTlsFromEnv("rediss://cache.internal:6380", {})).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("enables TLS when REDIS_TLS=true even for a redis:// URL", () => {
    expect(
      redisTlsFromEnv("redis://cache.internal:6379", { REDIS_TLS: "true" })
    ).toEqual({ rejectUnauthorized: true });
  });

  it("fails closed when REDIS_TLS_REQUIRED=true but TLS is off", () => {
    expectCode(
      () =>
        redisTlsFromEnv("redis://cache.internal:6379", {
          REDIS_TLS_REQUIRED: "true",
        }),
      REDIS_CONFIG_ERROR_CODES.REDIS_TLS_REQUIRED
    );
  });

  it("rejects REDIS_TLS=false combined with a rediss:// URL", () => {
    expectCode(
      () =>
        redisTlsFromEnv("rediss://cache.internal:6380", {
          REDIS_TLS: "false",
        }),
      REDIS_CONFIG_ERROR_CODES.REDIS_TLS_CONFLICT
    );
  });

  it("rejects a non-boolean REDIS_TLS value", () => {
    expectCode(
      () => redisTlsFromEnv("redis://localhost:6379", { REDIS_TLS: "yes" }),
      REDIS_CONFIG_ERROR_CODES.REDIS_TLS_CONFLICT
    );
  });

  it("only disables certificate verification when explicitly configured", () => {
    expect(
      redisTlsFromEnv("rediss://cache.internal:6380", {
        REDIS_TLS_REJECT_UNAUTHORIZED: "false",
      })
    ).toEqual({ rejectUnauthorized: false });
  });

  it("pins the CA bundle from REDIS_TLS_CA_CERT", () => {
    expect(
      redisTlsFromEnv("rediss://cache.internal:6380", {
        REDIS_TLS_CA_CERT: "-----BEGIN CERTIFICATE-----",
      })
    ).toEqual({
      rejectUnauthorized: true,
      ca: "-----BEGIN CERTIFICATE-----",
    });
  });

  it("reads the CA bundle from REDIS_TLS_CA_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "vatix-redis-ca-"));
    const caPath = join(dir, "ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nFILE-CA\n");
    try {
      expect(
        redisTlsFromEnv("rediss://cache.internal:6380", {
          REDIS_TLS_CA_FILE: caPath,
        })
      ).toEqual({
        rejectUnauthorized: true,
        ca: "-----BEGIN CERTIFICATE-----\nFILE-CA\n",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the CA file path is unreadable", () => {
    const missing = join(tmpdir(), "vatix-does-not-exist-ca.pem");
    expectCode(
      () =>
        redisTlsFromEnv("rediss://cache.internal:6380", {
          REDIS_TLS_CA_FILE: missing,
        }),
      REDIS_CONFIG_ERROR_CODES.REDIS_TLS_CA_UNREADABLE
    );
  });
});

describe("redisAuthFromEnv / redisAuthFromUrl (#1131)", () => {
  it("falls back to the credentials embedded in the URL", () => {
    expect(redisAuthFromEnv({}, "user:pass")).toEqual({
      username: "user",
      password: "pass",
    });
  });

  it("treats a password-only URL segment as the default user's password", () => {
    expect(redisAuthFromEnv({}, ":pass")).toEqual({ password: "pass" });
  });

  it("lets explicit env credentials override the URL", () => {
    expect(
      redisAuthFromEnv(
        { REDIS_USERNAME: "rotated", REDIS_PASSWORD: "new" },
        "old:old"
      )
    ).toEqual({ username: "rotated", password: "new" });
  });

  it("fails closed on a username without a password", () => {
    expectCode(
      () => redisAuthFromEnv({ REDIS_USERNAME: "acl-user" }, ""),
      REDIS_CONFIG_ERROR_CODES.REDIS_AUTH_INCOMPLETE
    );
  });

  it("URL-decodes credentials from the connection URL", () => {
    expect(
      redisAuthFromUrl("rediss://acl%2Duser:p%40ss@cache.internal:6380", {})
    ).toEqual({ username: "acl-user", password: "p@ss" });
  });

  it("still applies env credentials when the URL carries none", () => {
    expect(
      redisAuthFromUrl("rediss://cache.internal:6380", {
        REDIS_USERNAME: "svc",
        REDIS_PASSWORD: "secret",
      })
    ).toEqual({ username: "svc", password: "secret" });
  });
});

describe("redactRedisUrl (#1131)", () => {
  it("removes the password so it is safe to log", () => {
    const redacted = redactRedisUrl(
      "rediss://svc:sup3r-secret@cache.internal:6380"
    );
    expect(redacted).not.toContain("sup3r-secret");
    expect(redacted).toContain("cache.internal:6380");
    expect(redacted).toContain("***");
  });

  it("returns a placeholder for an unparseable value", () => {
    expect(redactRedisUrl("not a url")).toBe("***");
  });
});

describe("redisConnectionFromEnv (#1131)", () => {
  it("folds TLS and ACL credentials into the connection options", () => {
    process.env.REDIS_URL = "rediss://acl-user:pass@cache.internal:6380";
    expect(redisConnectionFromEnv()).toEqual({
      host: "cache.internal",
      port: 6380,
      username: "acl-user",
      password: "pass",
      tls: { rejectUnauthorized: true },
    });
  });

  it("keeps the plaintext shape unchanged when TLS is not configured", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    delete process.env.REDIS_TLS;
    expect(redisConnectionFromEnv()).toEqual({
      host: "localhost",
      port: 6379,
    });
  });

  it("fails closed in production when REDIS_URL is unset", () => {
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "production";
    expectCode(
      () => redisConnectionFromEnv(),
      REDIS_CONFIG_ERROR_CODES.REDIS_URL_REQUIRED
    );
  });
});
