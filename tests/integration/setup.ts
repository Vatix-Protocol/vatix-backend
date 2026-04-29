import { execSync } from "child_process";
import { Client } from "pg";

const TEST_DB_NAME = "vatix_integration_test";
const BASE_URL =
  process.env.DATABASE_URL?.replace(/\/[^/]+$/, "") ??
  "postgresql://postgres:postgres@localhost:5433";
const TEST_DB_URL = `${BASE_URL}/${TEST_DB_NAME}`;

export async function setup() {
  // Create isolated test database
  const client = new Client({ connectionString: `${BASE_URL}/postgres` });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
  await client.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  await client.end();

  // Run migrations against the isolated DB
  execSync("pnpm prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: "pipe",
  });

  process.env.DATABASE_URL = TEST_DB_URL;
}

export async function teardown() {
  // Drop the isolated test database to clean all test data
  const client = new Client({ connectionString: `${BASE_URL}/postgres` });
  await client.connect();
  await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}'`
  );
  await client.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
  await client.end();
}
