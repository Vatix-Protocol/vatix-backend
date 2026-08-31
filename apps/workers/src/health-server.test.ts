import { describe, it, expect, vi } from "vitest";
import { startHealthServer } from "./health-server.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: unknown) {
    return this;
  }),
};

describe("startHealthServer", () => {
  it("rejects a negative or non-finite port instead of silently binding to a default", async () => {
    await expect(startHealthServer(mockLogger as any, -1)).rejects.toThrow(
      /WORKERS_HEALTH_PORT must be >= 0/
    );
    await expect(startHealthServer(mockLogger as any, NaN)).rejects.toThrow();
  });

  it("starts and serves /live and /ready on the given port", async () => {
    const app = await startHealthServer(mockLogger as any, 0);
    try {
      const live = await app.inject({ method: "GET", url: "/live" });
      expect(live.statusCode).toBe(200);

      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect([200, 503]).toContain(ready.statusCode);
    } finally {
      await app.close();
    }
  });
});
