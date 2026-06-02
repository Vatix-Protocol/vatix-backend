import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateDockerComposeConfig } from "../src/types/docker-compose.js";

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

describe("validateDockerComposeConfig", () => {
  it("returns 400 on null input", () => {
    try {
      validateDockerComposeConfig(null);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
    }
  });

  it("returns 400 on non-object input", () => {
    try {
      validateDockerComposeConfig("not-an-object");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
    }
  });

  it("returns 400 when services is missing", () => {
    try {
      validateDockerComposeConfig({});
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
    }
  });

  it("returns 400 when services is not an object", () => {
    try {
      validateDockerComposeConfig({ services: "invalid" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
    }
  });

  it("returns 400 when services is an array", () => {
    try {
      validateDockerComposeConfig({ services: [] });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
    }
  });

  it("accepts a valid config with services object", () => {
    const config = validateDockerComposeConfig({
      version: "3.8",
      services: { app: { image: "node:20" } },
    });
    expect(config.services).toBeDefined();
  });
});
