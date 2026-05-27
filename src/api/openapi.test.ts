import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openApiSpec, openApiStubHandler } from "./openapi.js";

describe("OpenAPI Stub", () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("exports a valid OpenAPI spec object", () => {
    expect(openApiSpec).toBeDefined();
    expect(typeof openApiSpec).toBe("object");
  });

  it("contains required top-level OpenAPI fields", () => {
    expect(openApiSpec).toHaveProperty("openapi");
    expect(openApiSpec).toHaveProperty("info");
    expect(openApiSpec).toHaveProperty("paths");
  });

  it("has valid openapi version", () => {
    expect(openApiSpec.openapi).toBe("3.0.0");
  });

  it("contains info object with title and version", () => {
    expect(openApiSpec.info).toBeDefined();
    expect(openApiSpec.info).toHaveProperty("title");
    expect(openApiSpec.info).toHaveProperty("version");
    expect(typeof openApiSpec.info.title).toBe("string");
    expect(typeof openApiSpec.info.version).toBe("string");
  });

  it("contains paths object with at least one endpoint", () => {
    expect(openApiSpec.paths).toBeDefined();
    expect(typeof openApiSpec.paths).toBe("object");
    const pathKeys = Object.keys(openApiSpec.paths);
    expect(pathKeys.length).toBeGreaterThan(0);
  });

  it("has expected API endpoints documented", () => {
    expect(openApiSpec.paths).toHaveProperty("/health");
    expect(openApiSpec.paths).toHaveProperty("/markets");
    expect(openApiSpec.paths).toHaveProperty("/orders");
  });

  it("health endpoint is documented with GET method", () => {
    const healthPath = openApiSpec.paths["/health"] as Record<string, unknown>;
    expect(healthPath).toHaveProperty("get");
  });

  it("markets endpoint is documented with GET method", () => {
    const marketsPath = openApiSpec.paths["/markets"] as Record<
      string,
      unknown
    >;
    expect(marketsPath).toHaveProperty("get");
  });

  it("orders endpoint is documented with POST method", () => {
    const ordersPath = openApiSpec.paths["/orders"] as Record<string, unknown>;
    expect(ordersPath).toHaveProperty("post");
  });

  it("each endpoint has a description and tags", () => {
    Object.entries(openApiSpec.paths).forEach(([path, pathItem]) => {
      const methods = Object.keys(pathItem as Record<string, unknown>);
      methods.forEach((method) => {
        const operation = (pathItem as Record<string, Record<string, unknown>>)[
          method
        ];
        expect(operation).toHaveProperty("summary");
        expect(operation).toHaveProperty("description");
      });
    });
  });

  it("contains servers array", () => {
    expect(openApiSpec).toHaveProperty("servers");
    expect(Array.isArray(openApiSpec.servers)).toBe(true);
  });

  it("contains components schema for Error type", () => {
    expect(openApiSpec.components).toBeDefined();
    expect(openApiSpec.components).toHaveProperty("schemas");
    expect(openApiSpec.components?.schemas).toHaveProperty("Error");
  });

  it("returns 400 when required field is missing", async () => {
    server = Fastify({ logger: false });
    server.post("/stub", openApiStubHandler);

    const res = await server.inject({
      method: "POST",
      url: "/stub",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "name is required" });
  });

  it("returns 200 on valid input", async () => {
    server = Fastify({ logger: false });
    server.post("/stub", openApiStubHandler);

    const res = await server.inject({
      method: "POST",
      url: "/stub",
      payload: { name: "test" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});
