/**
 * Async mutex for serialising concurrent operations on a shared resource.
 *
 * JavaScript is single-threaded, but async functions yield at every `await`,
 * creating race windows when multiple callers operate on the same in-memory
 * order book concurrently. This mutex closes that window by ensuring only one
 * `run()` callback executes at a time per Mutex instance.
 *
 * Implementation — promise-chain queue:
 *   - `tail` points to the promise that resolves when the current holder
 *     finishes (or immediately if idle).
 *   - Each new caller captures the current tail as its predecessor, then
 *     replaces tail with a fresh promise it will resolve when done.
 *   - The `finally` block always calls `release()`, so a throwing callback
 *     never leaves the mutex permanently locked.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Acquire the mutex, run `fn`, then release.
   * Callers queue automatically: the second call waits for the first,
   * the third waits for the second, and so on.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;

    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}
