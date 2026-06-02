import { describe, it, expect, vi, beforeEach } from "vitest";
import { createShutdownHandler, VALID_SHUTDOWN_SIGNALS } from "./shutdown.js";
import type { ShutdownDeps } from "./shutdown.js";

function makeDeps(overrides?: Partial<ShutdownDeps>): ShutdownDeps {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    timer: setInterval(() => {}, 999999),
    disconnectPrisma: vi.fn().mockResolvedValue(undefined),
    exit: vi.fn(),
    ...overrides,
  };
}

describe("createShutdownHandler", () => {
  let deps: ShutdownDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("calls disconnectPrisma and exits 0 on SIGTERM", async () => {
    const shutdown = createShutdownHandler(deps);
    await shutdown("SIGTERM");

    expect(deps.disconnectPrisma).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("calls disconnectPrisma and exits 0 on SIGINT", async () => {
    const shutdown = createShutdownHandler(deps);
    await shutdown("SIGINT");

    expect(deps.disconnectPrisma).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("calls disconnectPrisma and exits 0 on SIGHUP", async () => {
    const shutdown = createShutdownHandler(deps);
    await shutdown("SIGHUP");

    expect(deps.disconnectPrisma).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — second call is a no-op", async () => {
    const shutdown = createShutdownHandler(deps);
    await shutdown("SIGTERM");
    await shutdown("SIGTERM");

    expect(deps.disconnectPrisma).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledOnce();
  });

  it("exits 1 when disconnectPrisma rejects", async () => {
    deps.disconnectPrisma = vi.fn().mockRejectedValue(new Error("db error"));
    const shutdown = createShutdownHandler(deps);
    await shutdown("SIGTERM");

    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.logger.error).toHaveBeenCalledWith(
      "Finalization worker shutdown failed",
      expect.objectContaining({ error: "db error" })
    );
  });

  it.each(["", "   ", "SIGKILL", 42, null, undefined])(
    "ignores invalid signal %j and does not exit",
    async (signal) => {
      const shutdown = createShutdownHandler(deps);
      await shutdown(signal as string);

      expect(deps.disconnectPrisma).not.toHaveBeenCalled();
      expect(deps.exit).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        "Graceful shutdown called with invalid signal",
        expect.objectContaining({ validSignals: [...VALID_SHUTDOWN_SIGNALS] })
      );
    }
  );

  it("logs shutdown initiated and complete on success", async () => {
    const shutdown = createShutdownHandler(deps);
    await shutdown("SIGTERM");

    expect(deps.logger.info).toHaveBeenCalledWith(
      "Finalization worker shutdown initiated",
      expect.objectContaining({ signal: "SIGTERM", status: "initiated" })
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      "Finalization worker shutdown complete",
      expect.objectContaining({ signal: "SIGTERM", status: "complete" })
    );
  });
});
