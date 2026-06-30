import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateDockerComposeConfig } from "../src/types/docker-compose.js";

const COMPOSE_PATH = resolve(process.cwd(), "docker-compose.yml");
const DOCKERFILE_PATH = resolve(process.cwd(), "Dockerfile");

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

  it("defines a service for every backend process", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toContain("api:");
    expect(content).toContain("indexer:");
    expect(content).toContain("finalization-worker:");
    expect(content).toContain("oracle-worker:");
  });

  it("gates application services behind profiles, leaving postgres/redis on by default", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toMatch(/profiles:\s*\[\s*"app",\s*"api"\s*\]/);
    expect(content).toMatch(/profiles:\s*\[\s*"app",\s*"indexer"\s*\]/);

    const postgresBlock = content.slice(
      content.indexOf("\n  postgres:"),
      content.indexOf("\n  redis:")
    );
    expect(postgresBlock).not.toContain("profiles:");
  });

  it("builds app services from the root Dockerfile with a matching --target", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toContain("target: api");
    expect(content).toContain("target: indexer");
    expect(content).toContain("target: finalization-worker");
    expect(content).toContain("target: oracle-worker");
  });

  it("names containers to match docs/runbooks/incident-runbook.md references", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toContain("container_name: vatix-backend");
    expect(content).toContain("container_name: vatix-indexer");
    expect(content).toContain("container_name: vatix-postgres");
    expect(content).toContain("container_name: vatix-redis");
    expect(content).toContain("container_name: vatix-settlement-worker");
    expect(content).toContain("container_name: vatix-finalization-worker");
    expect(content).toContain("container_name: vatix-oracle-worker");
  });

  it("overrides DATABASE_URL/REDIS_URL to use in-network service DNS names", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toContain(
      "postgresql://postgres:postgres@postgres:5432/vatix"
    );
    expect(content).toContain("redis://redis:6379");
  });

  it("defines a one-off migrate service that is not part of the default or app profiles", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    expect(content).toContain("migrate:");
    expect(content).toMatch(/profiles:\s*\[\s*"tools",\s*"migrate"\s*\]/);
  });
});

describe("Dockerfile", () => {
  it("file exists and is readable", () => {
    expect(() => readFileSync(DOCKERFILE_PATH, "utf8")).not.toThrow();
  });

  it("defines a build target for every backend process", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).toMatch(/FROM .+ AS api/);
    expect(content).toMatch(/FROM .+ AS indexer/);
    expect(content).toMatch(/FROM .+ AS finalization-worker/);
    expect(content).toMatch(/FROM .+ AS oracle-worker/);
  });

  it("sets STOPSIGNAL SIGTERM for graceful shutdown", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).toContain("STOPSIGNAL SIGTERM");
  });

  it("runs as a non-root user in the runtime image", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).toMatch(/USER vatix/);
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
