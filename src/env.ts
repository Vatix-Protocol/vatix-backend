import { z } from "zod";

export type ApiNodeEnv = z.infer<typeof apiEnvSchema>["NODE_ENV"];

const emptyToUndefined = (value: unknown) =>
  value === "" || value === undefined ? undefined : value;

const postgresUrlSchema = z
  .string({
    required_error: "Missing required environment variable: DATABASE_URL",
  })
  .min(1, "Missing required environment variable: DATABASE_URL")
  .superRefine((raw, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "DATABASE_URL is not a valid URL (expected format: postgresql://user:pass@host:port/db)",
      });
      return;
    }

    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `DATABASE_URL must use the postgresql:// or postgres:// scheme, got: ${JSON.stringify(parsed.protocol)}`,
      });
    }

    if (!parsed.hostname) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DATABASE_URL must include a hostname",
      });
    }
  });

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
  return result.data;
}
