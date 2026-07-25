/**
 * Tests for BullMQSubmissionQueue / createOracleSubmissionWorker's Redis
 * connection error handling.
 *
 * BullMQ's Queue and Worker are EventEmitters that forward Redis connection
 * errors as "error" events. Node's default EventEmitter behavior for an
 * "error" event with no listener is to throw, crashing the process on the
 * next transient Redis blip. These tests verify an "error" listener is
 * registered so that no longer happens.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal EventEmitter stand-in (rather than importing Node's `events`)
// so this stays self-contained inside vi.hoisted, whose callback runs before
// any of this file's own imports are evaluated.
const { mockQueueInstances, mockWorkerInstances, MockQueue, MockWorker } =
  vi.hoisted(() => {
    const queueInstances: any[] = [];
    const workerInstances: any[] = [];

    class MinimalEmitter {
      private listeners: Record<string, Array<(...args: any[]) => void>> = {};
      on(event: string, listener: (...args: any[]) => void) {
        (this.listeners[event] ??= []).push(listener);
        return this;
      }
      emit(event: string, ...args: any[]) {
        for (const listener of this.listeners[event] ?? []) listener(...args);
        return (this.listeners[event]?.length ?? 0) > 0;
      }
      listenerCount(event: string) {
        return this.listeners[event]?.length ?? 0;
      }
    }

    class HoistedMockQueue extends MinimalEmitter {
      getJob = vi.fn();
      add = vi.fn();
      close = vi.fn();
      constructor() {
        super();
        queueInstances.push(this);
      }
    }

    class HoistedMockWorker extends MinimalEmitter {
      close = vi.fn();
      constructor() {
        super();
        workerInstances.push(this);
      }
    }

    return {
      mockQueueInstances: queueInstances,
      mockWorkerInstances: workerInstances,
      MockQueue: HoistedMockQueue,
      MockWorker: HoistedMockWorker,
    };
  });

vi.mock("bullmq", () => ({
  Queue: MockQueue,
  Worker: MockWorker,
}));

vi.mock("../shared/queue-config.js", () => ({
  DEFAULT_JOB_OPTIONS: {},
  redisConnectionFromEnv: () => ({ host: "localhost", port: 6379 }),
}));

import {
  BullMQSubmissionQueue,
  createOracleSubmissionWorker,
} from "./bullmq-submission-queue.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("BullMQSubmissionQueue error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueInstances.length = 0;
    mockWorkerInstances.length = 0;
  });

  it("registers an error listener on the underlying Queue", () => {
    new BullMQSubmissionQueue(mockLogger as any);

    expect(mockQueueInstances).toHaveLength(1);
    expect(mockQueueInstances[0].listenerCount("error")).toBeGreaterThan(0);
  });

  it("logs instead of throwing when the Queue emits an error", () => {
    new BullMQSubmissionQueue(mockLogger as any);

    const emit = () =>
      mockQueueInstances[0].emit("error", new Error("connection reset"));

    expect(emit).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Oracle submission queue connection error",
      { error: "connection reset" }
    );
  });
});

describe("createOracleSubmissionWorker error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueInstances.length = 0;
    mockWorkerInstances.length = 0;
  });

  it("registers an error listener on the underlying Worker", () => {
    createOracleSubmissionWorker(async () => {}, mockLogger as any);

    expect(mockWorkerInstances).toHaveLength(1);
    expect(mockWorkerInstances[0].listenerCount("error")).toBeGreaterThan(0);
  });

  it("logs instead of throwing when the Worker emits an error", () => {
    createOracleSubmissionWorker(async () => {}, mockLogger as any);

    const emit = () =>
      mockWorkerInstances[0].emit("error", new Error("ECONNRESET"));

    expect(emit).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Oracle submission worker connection error",
      { error: "ECONNRESET" }
    );
  });
});
