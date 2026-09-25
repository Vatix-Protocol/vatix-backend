import { describe, it, expect, vi } from "vitest";
import { Mutex } from "./mutex.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a promise and a function to resolve it externally. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Flushes the microtask queue so promise continuations can run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Mutex", () => {
  it("runs a single callback and returns its value", async () => {
    const mutex = new Mutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });

  it("serialises concurrent calls — second waits for first to finish", async () => {
    const mutex = new Mutex();
    const log: string[] = [];

    const { promise: blocker, resolve: unblock } = deferred();

    // First call: holds the mutex until `unblock()` is called.
    const first = mutex.run(async () => {
      log.push("first:start");
      await blocker;
      log.push("first:end");
    });

    // Second call: queues behind the first.
    const second = mutex.run(async () => {
      log.push("second:start");
    });

    // Let microtasks settle — first should have started, second is waiting.
    await tick();
    expect(log).toEqual(["first:start"]);

    // Release the first caller.
    unblock();
    await Promise.all([first, second]);

    expect(log).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("releases the mutex even when the callback throws", async () => {
    const mutex = new Mutex();
    const log: string[] = [];

    await expect(
      mutex.run(async () => {
        log.push("threw");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // Mutex must be free: the next call should run immediately.
    await mutex.run(async () => {
      log.push("after-throw");
    });

    expect(log).toEqual(["threw", "after-throw"]);
  });

  it("queues three callers in order", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const blockers = [deferred(), deferred(), deferred()];

    const runners = blockers.map((b, i) =>
      mutex.run(async () => {
        await b.promise;
        order.push(i);
      })
    );

    // Unblock each in sequence and verify ordering.
    blockers[0].resolve();
    await tick();
    blockers[1].resolve();
    await tick();
    blockers[2].resolve();
    await Promise.all(runners);

    expect(order).toEqual([0, 1, 2]);
  });

  it("two independent mutexes do not block each other", async () => {
    const mutexA = new Mutex();
    const mutexB = new Mutex();
    const log: string[] = [];

    const { promise: blockerA, resolve: unblockA } = deferred();

    const a = mutexA.run(async () => {
      await blockerA;
      log.push("A");
    });

    // mutexB is independent — it should run without waiting for A.
    const b = mutexB.run(async () => {
      log.push("B");
    });

    await tick();
    expect(log).toContain("B"); // B ran while A was blocked
    expect(log).not.toContain("A");

    unblockA();
    await Promise.all([a, b]);
    expect(log).toContain("A");
  });

  it("propagates the callback return value through a queue", async () => {
    const mutex = new Mutex();
    const { promise: blocker, resolve: unblock } = deferred();

    // First call holds the lock.
    const first = mutex.run(async () => {
      await blocker;
      return "from-first";
    });

    // Second call is queued.
    const second = mutex.run(async () => "from-second");

    unblock();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe("from-first");
    expect(r2).toBe("from-second");
  });

  it("handles a throwing first call followed by a successful second call", async () => {
    const mutex = new Mutex();

    const first = mutex.run(async () => {
      throw new Error("first failed");
    });

    const second = mutex.run(async () => "ok");

    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Per-book mutex registry — mirrors the pattern used in MatchingService
// ---------------------------------------------------------------------------

/** Minimal replica of the Map<key, Mutex> registry in MatchingService. */
class BookMutexRegistry {
  private mutexes: Map<string, Mutex> = new Map();

  getOrCreate(key: string): Mutex {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(key, mutex);
    }
    return mutex;
  }
}

describe("per-book mutex registry (pattern used by MatchingService)", () => {
  it("creates independent mutexes for different book keys", () => {
    const registry = new BookMutexRegistry();

    const mutexA = registry.getOrCreate("market-A:YES");
    const mutexB = registry.getOrCreate("market-B:YES");

    expect(mutexA).toBeInstanceOf(Mutex);
    expect(mutexB).toBeInstanceOf(Mutex);
    expect(mutexA).not.toBe(mutexB);
  });

  it("returns the same mutex instance for the same book key", () => {
    const registry = new BookMutexRegistry();

    const key = "market-X:NO";
    expect(registry.getOrCreate(key)).toBe(registry.getOrCreate(key));
  });

  it("YES and NO books for the same market get separate mutexes", () => {
    const registry = new BookMutexRegistry();

    const yes = registry.getOrCreate("market-X:YES");
    const no = registry.getOrCreate("market-X:NO");

    expect(yes).not.toBe(no);
  });

  it("concurrent operations on the same key are serialised, different keys run in parallel", async () => {
    const registry = new BookMutexRegistry();
    const log: string[] = [];

    const { promise: blocker, resolve: unblock } = deferred();

    // Two operations on the SAME key — second must wait for first.
    const sameA = registry.getOrCreate("market-X:YES").run(async () => {
      await blocker;
      log.push("sameA");
    });
    const sameB = registry.getOrCreate("market-X:YES").run(async () => {
      log.push("sameB");
    });

    // One operation on a DIFFERENT key — should not be blocked.
    const other = registry.getOrCreate("market-Y:YES").run(async () => {
      log.push("other");
    });

    await tick();

    // `other` must be done; `sameB` must still be waiting.
    expect(log).toContain("other");
    expect(log).not.toContain("sameA");
    expect(log).not.toContain("sameB");

    unblock();
    await Promise.all([sameA, sameB, other]);

    expect(log).toEqual(["other", "sameA", "sameB"]);
  });
});
