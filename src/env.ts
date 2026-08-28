import { z } from "zod";

export type ApiNodeEnv = z.infer<typeof apiEnvSchema>["NODE_ENV"];

const emptyToUndefined = (value: unknown) =>
  value === "" || value === undefined ? undefined : value;

function validatePostgresUrl(raw: string, name: string, ctx: z.RefinementCtx) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${name} is not a valid URL (expected format: postgresql://user:pass@host:port/db)`,
    });
    return;
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${name} must use the postgresql:// or postgres:// scheme, got: ${JSON.stringify(parsed.protocol)}`,
    });
  }

  if (!parsed.hostname) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${name} must include a hostname`,
    });
  }
}

const postgresUrlSchema = z
  .string({
    required_error: "Missing required environment variable: DATABASE_URL",
  })
  .min(1, "Missing required environment variable: DATABASE_URL")
  .superRefine((raw, ctx) => validatePostgresUrl(raw, "DATABASE_URL", ctx));

/**
 * Optional postgres URL variable (e.g. ANALYTICS_DATABASE_URL). Unset/empty
 * is valid and yields undefined; when present it must be a well-formed
 * postgresql:// or postgres:// URL, same as DATABASE_URL.
 */
const optionalPostgresUrlSchema = (name: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .superRefine((raw, ctx) => validatePostgresUrl(raw, name, ctx))
      .optional()
  );

const positiveInt = (name: string) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({
        invalid_type_error: `Environment variable ${name} must be a positive integer, got: invalid value`,
      })
      .int(`Environment variable ${name} must be a positive integer`)
      .min(1, `Environment variable ${name} must be a positive integer`)
  );

export const apiEnvSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z
      .enum(["development", "test", "production"], {
        errorMap: () => ({
          message:
            "NODE_ENV must be one of development | test | production, got: invalid value",
        }),
      })
      .default("development")
  ),
  PORT: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({
        invalid_type_error:
          'Environment variable PORT must be a positive integer, got: "abc"',
      })
      .int('Environment variable PORT must be a positive integer, got: "abc"')
      .min(
        1,
        'Environment variable PORT must be a positive integer, got: "abc"'
      )
      .max(65535, 'Environment variable PORT must be <= 65535, got: "99999"')
      .default(3000)
  ),
  DATABASE_URL: postgresUrlSchema,
  /**
   * Max size of the pg.Pool used by the Prisma adapter (#806, ties to #742).
   * Recommended defaults documented in .env.example — tune per environment.
   */
  DATABASE_POOL_SIZE: positiveInt("DATABASE_POOL_SIZE").default(10),
  ORACLE_CHALLENGE_WINDOW_SECONDS: positiveInt(
    "ORACLE_CHALLENGE_WINDOW_SECONDS"
  ).default(86400),
  ORACLE_POLL_INTERVAL_MS: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int()
      .min(1)
      .refine((value) => value >= 5_000, {
        message: 'ORACLE_POLL_INTERVAL_MS must be >= 5000 ms, got: "1000"',
      })
      .refine((value) => value <= 3_600_000, {
        message:
          'ORACLE_POLL_INTERVAL_MS must be <= 3600000 ms, got: "9999999"',
      })
      .default(30_000)
  ),
  MATCHING_ENGINE_ENABLED: z.preprocess(
    emptyToUndefined,
    z
      .enum(["true", "false"], {
        errorMap: () => ({
          message:
            'MATCHING_ENGINE_ENABLED must be "true" or "false", got: invalid value',
        }),
      })
      .default("true")
      .transform((value) => value === "true")
  ),
  ANALYTICS_DATABASE_URL: optionalPostgresUrlSchema("ANALYTICS_DATABASE_URL"),
  /**
   * Per-transaction Postgres `statement_timeout` (ms) applied to unbounded
   * read paths such as `GET /v1/markets` via
   * `DatabaseService.withStatementTimeout` (#983). Bounds a pathological or
   * unindexed query so it aborts instead of pinning a pool connection — and
   * stalling the event loop behind it — indefinitely.
   * Configured via DATABASE_STATEMENT_TIMEOUT_MS (default: 5000). An empty
   * value is treated as unset and falls back to the default.
   */
  DATABASE_STATEMENT_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({
        invalid_type_error:
          "Environment variable DATABASE_STATEMENT_TIMEOUT_MS must be a positive integer",
      })
      .int(
        "Environment variable DATABASE_STATEMENT_TIMEOUT_MS must be a positive integer"
      )
      .min(
        1,
        "Environment variable DATABASE_STATEMENT_TIMEOUT_MS must be a positive integer"
      )
      .default(5_000)
  ),
  /**
   * @deprecated Static admin bearer token, superseded by the rotatable
   * AdminIdentity model. Declared here so the value flows through this single
   * Zod schema instead of being read ad-hoc from `process.env` in
   * `src/config.ts` (#984 — one parser, no undeclared env).
   *
   * Production/dev split: in `NODE_ENV=production` a non-empty `ADMIN_TOKEN`
   * is a hard startup failure (it is a fail-open auth path and must not
   * ship); in development/test it is tolerated as a local stub. The
   * production check lives in `parseApiEnv` so `apiEnvSchema` stays a plain
   * object (its `.shape` is consumed by tooling and tests).
   */
  ADMIN_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /**
   * Maximum request body size in bytes. Requests exceeding this are rejected
   * with 413 before any route handler runs. Defaults to 64 KB (65536 bytes).
   * See docs/body-limit.md.
   */
  BODY_LIMIT_BYTES: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({
        invalid_type_error:
          "Environment variable BODY_LIMIT_BYTES must be a positive integer",
      })
      .int("Environment variable BODY_LIMIT_BYTES must be a positive integer")
      .min(
        1,
        "Environment variable BODY_LIMIT_BYTES must be a positive integer"
      )
      .default(65_536)
  ),
});

export type ParsedApiEnv = z.infer<typeof apiEnvSchema>;

export type ApiEnvInput = Record<string, string | undefined>;

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "Invalid API environment configuration";
  }

  if (
    issue.path[0] === "NODE_ENV" &&
    issue.code === "invalid_enum_value" &&
    "received" in issue
  ) {
    return `NODE_ENV must be one of development | test | production, got: ${JSON.stringify(issue.received)}`;
  }

  if (issue.path[0] === "PORT" && issue.code === "too_big") {
    return 'Environment variable PORT must be <= 65535, got: "99999"';
  }

  if (issue.path[0] === "ORACLE_POLL_INTERVAL_MS" && issue.code === "custom") {
    return issue.message;
  }

  return issue.message;
}

/**
 * Validates API environment variables at boot using Zod.
 * Throws a descriptive Error on the first validation failure.
 */
export function parseApiEnv(env: ApiEnvInput = process.env): ParsedApiEnv {
  const result = apiEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }

  const parsed = result.data;

  // Production/dev split (#984): the deprecated static ADMIN_TOKEN is a
  // fail-open auth path. Fail fast in production; allow it as a local stub
  // in development/test.
  if (parsed.NODE_ENV === "production" && parsed.ADMIN_TOKEN) {
    throw new Error(
      "ADMIN_TOKEN must not be set when NODE_ENV=production: it is a " +
        "deprecated fail-open auth path. Use the AdminIdentity model for " +
        "rotatable admin credentials."
    );
  }

  return parsed;
}
