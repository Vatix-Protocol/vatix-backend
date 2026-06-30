import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_EXAMPLE_PATH = resolve(process.cwd(), ".env.example");

describe(".env.example settlement queue documentation", () => {
  const content = readFileSync(ENV_EXAMPLE_PATH, "utf8");

  it("defines a dedicated Settlement Queue section", () => {
    expect(content).toMatch(/#\s*Settlement Queue/);
  });

  it("documents SETTLEMENT_QUEUE_NAME with default settlement-trades", () => {
    expect(content).toMatch(/SETTLEMENT_QUEUE_NAME=settlement-trades/);
    expect(content).toMatch(/Default:\s*settlement-trades/);
  });

  it("documents REDIS_KEY_PREFIX interaction for the settlement queue key", () => {
    expect(content).toMatch(/REDIS_KEY_PREFIX.*SETTLEMENT_QUEUE_NAME/s);
  });

  it("documents optional on-chain settlement env vars", () => {
    expect(content).toContain("SETTLEMENT_CONTRACT_ID=");
    expect(content).toContain("STELLAR_SECRET_KEY=");
  });

  it("does not duplicate SETTLEMENT_QUEUE_NAME assignment", () => {
    const assignmentLines = content
      .split("\n")
      .filter((line) => line.startsWith("SETTLEMENT_QUEUE_NAME="));
    expect(assignmentLines).toHaveLength(1);
  });
});
