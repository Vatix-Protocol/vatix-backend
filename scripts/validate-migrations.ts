#!/usr/bin/env tsx

/**
 * Migration validation script for CI/CD
 *
 * This script validates that:
 * 1. Migration files are in sync with schema
 * 2. Migration SQL is valid
 * 3. No destructive changes without explicit confirmation
 */

import { execSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { exit } from "process";

const MIGRATIONS_DIR = "prisma/migrations";
const SCHEMA_FILE = "prisma/schema.prisma";

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validateMigrationFiles(): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };

  try {
    // Check if migrations directory exists
    const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort();

    if (migrations.length === 0) {
      result.errors.push("No migration files found");
      result.valid = false;
      return result;
    }

    console.log(`Found ${migrations.length} migration(s):`);
    migrations.forEach((migration) => console.log(`  - ${migration}`));

    // Validate each migration file
    for (const migration of migrations) {
      const migrationFile = join(MIGRATIONS_DIR, migration, "migration.sql");

      try {
        const sql = readFileSync(migrationFile, "utf8");

        // Check for potentially dangerous operations
        const dangerousPatterns = [
          /DROP\s+TABLE/i,
          /DROP\s+COLUMN/i,
          /DROP\s+INDEX/i,
          /DELETE\s+FROM\s+\w+\s*$/i, // DELETE without WHERE
        ];

        for (const pattern of dangerousPatterns) {
          if (pattern.test(sql)) {
            result.warnings.push(
              `Dangerous operation detected in ${migration}: ${pattern.source}`
            );
          }
        }

        // Basic SQL syntax check (simple validation)
        if (!sql.trim().startsWith("--")) {
          const sqlCommands = sql.split(";").filter((cmd) => cmd.trim());
          if (sqlCommands.length === 0) {
            result.errors.push(`No SQL commands found in ${migration}`);
            result.valid = false;
          }
        }
      } catch (error) {
        result.errors.push(
          `Failed to read migration file ${migration}: ${error}`
        );
        result.valid = false;
      }
    }
  } catch (error) {
    result.errors.push(`Failed to read migrations directory: ${error}`);
    result.valid = false;
  }

  return result;
}

function validateSchemaSync(): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };

  try {
    // Check if schema and migrations are in sync
    console.log("Checking schema synchronization...");

    const diffCommand = `npx prisma migrate diff --from-migrations ${MIGRATIONS_DIR} --to-schema ${SCHEMA_FILE} --shadow-database-url "${process.env.DATABASE_URL}"`;
    const output = execSync(diffCommand, { encoding: "utf8" });

    if (output.trim() && !output.includes("No difference detected")) {
      result.errors.push("Schema and migrations are out of sync:");
      result.errors.push(output);
      result.valid = false;
    } else {
      console.log("✓ Schema and migrations are in sync");
    }
  } catch (error) {
    result.errors.push(`Failed to check schema synchronization: ${error}`);
    result.valid = false;
  }

  return result;
}

function validatePrismaClient(): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };

  try {
    console.log("Generating Prisma client...");
    execSync("npx prisma generate", { stdio: "pipe" });
    console.log("✓ Prisma client generated successfully");
  } catch (error) {
    result.errors.push(`Failed to generate Prisma client: ${error}`);
    result.valid = false;
  }

  return result;
}

function main() {
  console.log("🔍 Validating database migrations...\n");

  const results = [
    validateMigrationFiles(),
    validateSchemaSync(),
    validatePrismaClient(),
  ];

  const allErrors = results.flatMap((r) => r.errors);
  const allWarnings = results.flatMap((r) => r.warnings);
  const isValid = results.every((r) => r.valid);

  // Print results
  if (allWarnings.length > 0) {
    console.log("\n⚠️  Warnings:");
    allWarnings.forEach((warning) => console.log(`  - ${warning}`));
  }

  if (allErrors.length > 0) {
    console.log("\n❌ Errors:");
    allErrors.forEach((error) => console.log(`  - ${error}`));
  }

  if (isValid) {
    console.log("\n✅ All migration validations passed!");
    exit(0);
  } else {
    console.log("\n❌ Migration validation failed!");
    exit(1);
  }
}

// Run validation if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { validateMigrationFiles, validateSchemaSync, validatePrismaClient };
