import { describe, it, expect } from 'vitest';
import { Mutex } from './mutex.js';

/**
 * Create a promise with externally accessible resolve/reject handles.
 * Used to control exactly when a queued callback is allowed to proceed.
 */
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Yield to the microtask queue so pending promise continuations can run.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Mutex', () => {
  it('returns the value from a single callback', async () => {
    const mutex = new Mutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });

  it('serialises two callers', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const first = mutex.run(async () => {
      order.push('first-start');
      await tick();
      order.push('first-end');
    });

    const second = mutex.run(async () => {
      order.push('second-start');
      await tick();
      order.push('second-end');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('serialises three callers', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const calls = [1, 2, 3].map((n) =>
      mutex.run(async () => {
        order.push(`start-${n}`);
        await tick();
        order.push(`end-${n}`);
      }),
    );

    await Promise.all(calls);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  });

  it('releases the mutex when a callback throws', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const result = await mutex.run(async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('keeps two mutexes independent', async () => {
    const a = new Mutex();
    const b = new Mutex();
    const order: string[] = [];

    const blocker = deferred();
    const first = a.run(async () => {
      order.push('a-start');
      await blocker.promise;
      order.push('a-end');
    });

    const second = b.run(async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await second;
    expect(order).toEqual(['a-start', 'b-start', 'b-end']);

    blocker.resolve();
    await first;
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });

  it('propagates return values through a queue', async () => {
    const mutex = new Mutex();

    const first = mutex.run(async () => 'one');
    const second = mutex.run(async () => 'two');
    const third = mutex.run(async () => 'three');

    const results = await Promise.all([first, second, third]);
    expect(results).toEqual(['one', 'two', 'three']);
  });

  it('handles a throwing first call followed by a successful second call', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.run(async () => {
        throw new Error('first-fails');
      }),
    ).rejects.toThrow('first-fails');

    const result = await mutex.run(async () => 'second-ok');
    expect(result).toBe('second-ok');
  });

  it('runs queued callers in order when the first holder rejects', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const firstBlocker = deferred();
    const secondBlocker = deferred();
    const thirdBlocker = deferred();

    const first = mutex.run(async () => {
      order.push('first-start');
      await firstBlocker.promise;
      order.push('first-end');
      return 'first';
    });

    const second = mutex.run(async () => {
      order.push('second-start');
      await secondBlocker.promise;
      order.push('second-end');
      return 'second';
    });

    const third = mutex.run(async () => {
      order.push('third-start');
      await thirdBlocker.promise;
      order.push('third-end');
      return 'third';
    });

    // All three calls are queued before any blocker is settled.
    await tick();
    expect(order).toEqual(['first-start']);

    // Reject the first holder; the queued callers must still run.
    firstBlocker.reject(new Error('first-rejects'));
    await tick();

    secondBlocker.resolve();
    await tick();

    thirdBlocker.resolve();

    const results = await Promise.allSettled([first, second, third]);

    expect(order).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
      'third-start',
      'third-end',
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'rejected' });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'second' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'third' });

    // The mutex is free afterwards.
    const after = await mutex.run(async () => 'after');
    expect(after).toBe('after');
  });

  it('does not strand the tail when a mid-queue holder rejects', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const firstBlocker = deferred();
    const secondBlocker = deferred();
    const thirdBlocker = deferred();

    const first = mutex.run(async () => {
      order.push('first-start');
      await firstBlocker.promise;
      order.push('first-end');
      return 'first';
    });

    const second = mutex.run(async () => {
      order.push('second-start');
      await secondBlocker.promise;
      order.push('second-end');
      return 'second';
    });

    const third = mutex.run(async () => {
      order.push('third-start');
      await thirdBlocker.promise;
      order.push('third-end');
      return 'third';
    });

    await tick();
    expect(order).toEqual(['first-start']);

    // Let the first holder finish successfully.
    firstBlocker.resolve();
    await tick();
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);

    // Reject the middle holder; the tail must still run.
    secondBlocker.reject(new Error('second-rejects'));
    await tick();

    thirdBlocker.resolve();

    const results = await Promise.allSettled([first, second, third]);

    expect(order).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
      'third-start',
      'third-end',
    ]);

    expect(results[0]).toEqual({ status: 'fulfilled', value: 'first' });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'third' });

    // The mutex accepts a new callback immediately after the mid-queue rejection.
    const after = await mutex.run(async () => 'after');
    expect(after).toBe('after');
  });
});
