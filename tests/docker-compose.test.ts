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
    expect(content).toMatch(/profiles:\s*\[\s*"app",\s*"full",\s*"api"\s*\]/);
    expect(content).toMatch(
      /profiles:\s*\[\s*"app",\s*"full",\s*"indexer"\s*\]/
    );

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

  it("gives every workers-profile service its own healthcheck", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    const servicesSection = content.slice(content.indexOf("\nservices:"));

    for (const [service, nextService] of [
      ["finalization-worker", "oracle-worker"],
      ["oracle-worker", "settlement-worker"],
      ["settlement-worker", "migrate"],
    ] as const) {
      const start = servicesSection.indexOf(`\n  ${service}:`);
      const end = servicesSection.indexOf(`\n  ${nextService}:`);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const block = servicesSection.slice(start, end);
      expect(block).toContain("healthcheck:");
      expect(block).toMatch(/CMD-SHELL/);
      expect(block).toMatch(/\/proc\/1\/cmdline/);
    }
  });
});

describe("docs/docker-compose.md", () => {
  const DOC_PATH = resolve(process.cwd(), "docs/docker-compose.md");

  /** Service name -> container name, parsed straight out of docker-compose.yml. */
  function composeServices(): Array<[string, string]> {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    const services: Array<[string, string]> = [];
    const body = content.slice(content.indexOf("\nservices:"));

    for (const line of body.split("\n")) {
      const service = line.match(/^ {2}([a-z][a-z0-9-]*):$/);
      if (service) {
        services.push([service[1], ""]);
        continue;
      }
      const container = line.match(/^ {4}container_name:\s*(\S+)/);
      if (container && services.length > 0) {
        services[services.length - 1][1] = container[1];
      }
    }
    return services;
  }

  // #1119: the services table drifted from docker-compose.yml, which is how a
  // contributor ends up waiting on a profile that does not exist. Deriving the
  // expectation from the compose file itself means any new service must be
  // documented or this test fails.
  it("documents every service that docker-compose.yml defines", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    for (const [service, containerName] of composeServices()) {
      expect(
        doc,
        `docs/docker-compose.md is missing the "${service}" service row`
      ).toContain(`\`${service}\``);
      expect(
        doc,
        `docs/docker-compose.md is missing container name "${containerName}"`
      ).toContain(`\`${containerName}\``);
    }
  });

  it("documents each service's profiles as compose declares them", () => {
    const content = readFileSync(COMPOSE_PATH, "utf8");
    const doc = readFileSync(DOC_PATH, "utf8");
    const servicesSection = content.slice(content.indexOf("\nservices:"));

    for (const line of servicesSection.split("\n")) {
      const service = line.match(/^ {2}([a-z][a-z0-9-]*):$/);
      if (!service) continue;

      const start = servicesSection.indexOf(line);
      const block = servicesSection.slice(start, start + 400);
      const profiles = block.match(/^ {4}profiles:\s*\[(.*)\]/);
      if (!profiles) continue;

      const declared = profiles[1]
        .split(",")
        .map((p) => p.trim().replace(/"/g, ""))
        .filter(Boolean);

      // The doc table lists profiles in the same order compose declares them.
      const row = doc
        .split("\n")
        .find((l) => l.startsWith(`| \`${service[1]}\``));
      expect(row, `no doc table row for "${service[1]}"`).toBeDefined();

      const cells = row!.split("|").map((c) => c.trim());
      const profileCell = cells[2];
      for (const profile of declared) {
        expect(
          profileCell,
          `doc profiles cell for "${service[1]}" omits profile "${profile}"`
        ).toContain(`\`${profile}\``);
      }
    }
  });

  it("points at the upstream repository with its real owner casing", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    // GitHub redirects the lowercase form, but it 404s for anyone reading the
    // rendered page and looking for the canonical URL.
    expect(doc).not.toContain("github.com/vatix-protocol/vatix-backend");
    if (doc.includes("github.com/")) {
      expect(doc).toMatch(/github\.com\/Vatix-Protocol\/vatix-backend/);
    }
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

  // #1120: a trailing `chown -R` writes a second full copy of the tree into a
  // new layer, leaving root-owned originals in the image history. Copying with
  // ownership set keeps one layer and no root-owned copy.
  it("sets ownership on COPY rather than chowning the tree afterwards", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).not.toMatch(/RUN chown -R/);

    const copyLines = content
      .split("\n")
      .filter((line) => line.startsWith("COPY "));
    const appCopies = copyLines.filter((line) => line.includes("--from="));
    expect(appCopies.length).toBeGreaterThan(0);
    for (const line of appCopies) {
      expect(line).toContain("--chown=vatix:vatix");
    }
  });

  // Only the api target has an HTTP surface, so it is the only one that can be
  // probed over HTTP. It must probe liveness (/v1/health), not readiness: a
  // Postgres blip would otherwise restart a healthy API.
  it("defines a HEALTHCHECK on the api target only, probing liveness", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    const healthchecks = content.match(/^HEALTHCHECK /gm) ?? [];
    expect(healthchecks).toHaveLength(1);

    const block = content.slice(content.indexOf("FROM runtime AS api"));
    expect(block).toMatch(/^HEALTHCHECK /m);
    // Only the instruction line matters; the surrounding comment explains why
    // readiness is not probed.
    const healthcheck =
      block.match(/^HEALTHCHECK[\s\S]*?CMD \[.*$/m)?.[0] ?? "";
    expect(healthcheck).toContain("/v1/health");
    expect(healthcheck).not.toContain("/v1/ready");

    // Every later target must inherit no healthcheck from it.
    for (const target of [
      "indexer",
      "oracle",
      "finalization-worker",
      "oracle-worker",
      "settlement-worker",
    ]) {
      const stage = content.slice(content.indexOf(`FROM runtime AS ${target}`));
      expect(stage).not.toMatch(/^HEALTHCHECK /m);
    }
  });

  // The api container is the one compose waits on for postgres/redis via a
  // healthy-dependency condition; the rest use their own PID-1 healthchecks.
  it("keeps the api healthcheck aligned with compose's service name", () => {
    const compose = readFileSync(COMPOSE_PATH, "utf8");
    const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");

    const apiBlock = compose.slice(
      compose.indexOf("\n  api:"),
      compose.indexOf("\n  indexer:")
    );
    expect(apiBlock).toContain("target: api");
    expect(dockerfile).toContain("FROM runtime AS api");
  });

  // Reproducible builds: an unpinned pnpm lets two builds of the same commit
  // install different releases, so a supply-chain diff can't be reasoned about.
  it("pins pnpm through corepack instead of floating", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    expect(content).toContain("corepack enable");
    expect(content).toMatch(/corepack prepare pnpm@\d+ --activate/);

    // The pin must stay on the major the repo declares in engines.
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8")
    ) as { engines: { pnpm: string } };
    const floor = pkg.engines.pnpm.match(/>=\s*(\d+)/)?.[1];
    expect(floor).toBeDefined();
    expect(content).toContain(`corepack prepare pnpm@${floor} --activate`);
  });

  // The prod install used to abort at `prepare: husky install` — husky is a
  // devDependency that `--prod` omits, so the shell could not find the binary
  // and every runtime image failed to build. Lock the fix in.
  it("builds the production dependency install without the husky prepare hook", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");

    const stage = content.slice(content.indexOf("FROM base AS prod-deps"));
    const install = stage.match(
      /pnpm install --frozen-lockfile --prod[^\n]*/
    )?.[0];
    expect(install).toBeDefined();
    expect(install).toContain("--ignore-scripts");

    // Skipping scripts must not skip the native-binary builds Prisma and
    // esbuild depend on.
    expect(stage).toMatch(/pnpm rebuild .*(@prisma\/client|@prisma\/engines)/);
    expect(stage).toMatch(/pnpm rebuild .*esbuild/);

    // The `deps`/`build` stages must keep normal script execution so the
    // generated Prisma client is produced with its engines. Scoped to the
    // instruction line, since the prod-deps comment quotes the flag.
    const depsStage = content.slice(
      content.indexOf("FROM base AS deps"),
      content.indexOf("FROM base AS prod-deps")
    );
    const depsInstall = depsStage.match(
      /pnpm install --frozen-lockfile[^\n]*/
    )?.[0];
    expect(depsInstall).toBeDefined();
    expect(depsInstall).not.toContain("--ignore-scripts");
    expect(depsInstall).not.toContain("--prod");
  });

  // PID 1 must stay the entrypoint: worker healthchecks identify liveness by
  // grepping /proc/1/cmdline, so an init shim would mark every worker unhealthy.
  it("does not wrap the entrypoint in an init shim", () => {
    const content = readFileSync(DOCKERFILE_PATH, "utf8");
    // Instruction lines only — the Dockerfile's comments name these tools to
    // explain why they are deliberately absent.
    const instructions = content
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .join("\n");

    expect(instructions).not.toMatch(/ENTRYPOINT/i);
    expect(instructions).not.toMatch(/tini|dumb-init/i);
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
