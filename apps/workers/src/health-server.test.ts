import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "node:net";
import { createHealthServer } from "./health-server";

function createLoggerStub() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("createHealthServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a negative port before constructing Fastify", async () => {
    const logger = createLoggerStub();

    await expect(
      createHealthServer({ port: -1, logger: logger as never }),
    ).rejects.toThrow(/-1/);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects a non-finite port (%s) before constructing Fastify",
    async (port) => {
      const logger = createLoggerStub();

      await expect(
        createHealthServer({ port, logger: logger as never }),
      ).rejects.toThrow(String(port));

      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it("starts on an ephemeral port when port is 0 and serves /live", async () => {
    const logger = createLoggerStub();
    const app = await createHealthServer({ port: 0, logger: logger as never });

    try {
      const address = app.server.address();
      expect(address).not.toBeNull();
      expect(typeof address).toBe("object");
      const port = (address as { port: number }).port;
      expect(port).toBeGreaterThan(0);

      const response = await app.inject({ method: "GET", url: "/live" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("logs an error containing the port and rethrows when listen fails", async () => {
    const logger = createLoggerStub();

    // Occupy a port so the health server cannot bind to it.
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const address = blocker.address();
    const busyPort = (address as { port: number }).port;

    try {
      await expect(
        createHealthServer({ port: busyPort, logger: logger as never }),
      ).rejects.toThrow();

      expect(logger.error).toHaveBeenCalledTimes(1);
      const [entry] = logger.error.mock.calls[0];
      expect(entry).toMatchObject({ port: busyPort });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
