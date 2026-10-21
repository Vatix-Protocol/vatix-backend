import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";

// Set required env vars before any module imports so parseApiEnv() succeeds.
// These values are not used for real connections — services are mocked below.
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.NODE_ENV ??= "test";

// Mock the prisma service
const mockFindFirst = vi.fn();
vi.mock("../../src/services/prisma.js", () => {
  return {
    getPrismaClient: () => ({
      $queryRaw: async () => {},
      indexerCursor: {
        findFirst: mockFindFirst,
      },
    }),
  };
});

// Prevent the BullMQ Queue constructor from throwing "Queue name cannot
// contain :" when outbox-publisher.ts is transitively imported via orders.ts.
vi.mock("../../src/services/settlement-queue.js", () => ({
  settlementQueue: { add: vi.fn().mockResolvedValue(undefined) },
  settlementQueueName: vi.fn().mockReturnValue("settlement-trades"),
}));

// Prevent real Redis connections during integration tests.
vi.mock("../../src/services/redis.js", () => ({
  redis: {
    setOrderBook: vi.fn().mockResolvedValue(undefined),
    getOrderBook: vi.fn().mockResolvedValue(null),
    checkConnection: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
  },
}));

// Prevent lag-detector from creating a BullMQ Queue at module load
// (admissionControl.ts imports it transitively).
vi.mock("../../src/services/lag-detector.js", () => ({
  lagDetector: {
    isHealthy: vi.fn().mockReturnValue(true),
    getMetrics: vi.fn().mockReturnValue({}),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

describe("Ready Integration Tests", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INDEX_STALENESS_THRESHOLD_MS = "300000";
    app = buildServer({
      logger: false,
      registerTestRoutes: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 503 when no indexer cursor exists yet", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.indexFreshness.status).toBe("stale");
  });

  it("returns 200 when fresh indexer cursor exists", async () => {
    mockFindFirst.mockResolvedValue({
      networkId: "testnet",
      cursorKey: "ingestion",
      cursorValue: "123456",
      updatedAt: new Date(),
    });

    const res = await app.inject({ method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.dependencies.database.status).toBe("ok");
    expect(body.dependencies.indexFreshness.status).toBe("ok");
  });

  it("returns 503 when indexer cursor is stale", async () => {
    mockFindFirst.mockResolvedValue({
      networkId: "testnet",
      cursorKey: "ingestion",
      cursorValue: "123456",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min old
    });

    const res = await app.inject({ method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.dependencies.indexFreshness.status).toBe("stale");
  });

  it("returns 301 redirect for legacy /readiness endpoint", async () => {
    const res = await app.inject({ method: "GET", url: "/readiness" });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe("/v1/ready");
    expect(res.headers.deprecation).toBe("true");
  });

  it("gates test routes when NODE_ENV is production", async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com";

      const prodApp = buildServer({
        logger: false,
        registerTestRoutes: false,
      });
      await prodApp.ready();

      const res = await prodApp.inject({
        method: "GET",
        url: "/test/server-error",
      });
      expect(res.statusCode).toBe(404);

      await prodApp.close();
    } finally {
      process.env.NODE_ENV = originalEnv;
      delete process.env.CORS_ALLOWED_ORIGINS;
    }
  });
});

// ---------------------------------------------------------------------------
// Observability: structured probe logs
// ---------------------------------------------------------------------------

describe("Ready observability — structured probe logs", () => {
  let app: FastifyInstance;
  let logLines: string[];
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    process.env.INDEX_STALENESS_THRESHOLD_MS = "300000";
    app = buildServer({
      logger: false,
      registerTestRoutes: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    logLines = [];
    consoleSpy = vi.spyOn(console, "info").mockImplementation((line) => {
      logLines.push(String(line));
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("emits a structured probe log entry for the failing dependency", async () => {
    // Stale cursor — indexFreshness will be "stale"
    mockFindFirst.mockResolvedValue(null);

    await app.inject({ method: "GET", url: "/v1/ready" });

    // Find probe log entries (component === "ready", event === "probe")
    const probeEntries = logLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(
        (e) => e !== null && e.component === "ready" && e.event === "probe"
      );

    expect(probeEntries.length).toBeGreaterThan(0);

    const indexEntry = probeEntries.find(
      (e: Record<string, unknown>) => e.dependency === "indexFreshness"
    );
    expect(indexEntry).toBeDefined();
    expect(indexEntry.status).toBe("stale");
  });

  it("log entry correlationId matches the response body correlationId", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/v1/ready" });
    const body = res.json();
    const responseCorrelationId: string = body.correlationId;
    expect(responseCorrelationId).toBeTruthy();

    const probeEntries = logLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(
        (e) => e !== null && e.component === "ready" && e.event === "probe"
      );

    expect(probeEntries.length).toBeGreaterThan(0);
    for (const entry of probeEntries) {
      expect(entry.correlationId).toBe(responseCorrelationId);
    }
  });

  it("serialized probe log entry contains no connection-string or hostname substrings", async () => {
    mockFindFirst.mockResolvedValue(null);

    await app.inject({ method: "GET", url: "/v1/ready" });

    const probeLines = logLines.filter((line) => {
      try {
        const e = JSON.parse(line);
        return e.component === "ready" && e.event === "probe";
      } catch {
        return false;
      }
    });

    expect(probeLines.length).toBeGreaterThan(0);

    // Patterns that must never appear in probe log output per the security contract
    const forbidden = [
      /postgresql:\/\//i,
      /postgres:\/\//i,
      /redis:\/\//i,
      /mongodb:\/\//i,
      /password=/i,
      /secret=/i,
      /host=\S+/i,
      /localhost/i,
      /127\.0\.0\.1/,
      /\.internal/i,
    ];

    for (const line of probeLines) {
      for (const pattern of forbidden) {
        expect(line, `Log line must not match ${pattern}: ${line}`).not.toMatch(
          pattern
        );
      }
    }
  });
});
