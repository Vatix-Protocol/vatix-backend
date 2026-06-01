import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COMPOSE_PATH = resolve(process.cwd(), "docker-compose.yml");

describe("docker-compose.yml", () => {
  it("file exists and is readable", () => {
    expect(() => readFileSync(COMPOSE_PATH, "utf8")).not.toThrow();
  });

  it("defines postgres and redis services", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toContain("postgres:");
    expect(content).toContain("redis:");
  });

  it("postgres service exposes port 5433", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toContain("5433:5432");
  });

  it("redis service exposes port 6379", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toContain("6379:6379");
  });

  it("defines named volumes for persistence", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toContain("postgres_data:");
    expect(content).toContain("redis_data:");
  });

  it("uses pinned image versions (not latest)", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).not.toMatch(/image:\s+\S+:latest/);
  });
});
