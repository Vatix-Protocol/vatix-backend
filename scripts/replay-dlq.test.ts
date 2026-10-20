import { describe, expect, it, vi } from "vitest";
import {
  fieldsToRecord,
  parseArgs,
  replayDLQEntry,
} from "./replay-dlq.js";
import type Redis from "ioredis";

describe("replay-dlq argument validation", () => {
  it("uses safe defaults and parses supported options", () => {
    expect(parseArgs([])).toEqual({
      queueFilter: undefined,
      limit: Infinity,
      dryRun: false,
    });
    expect(
      parseArgs(["--queue", "settlement", "--limit", "10", "--dry-run"])
    ).toEqual({
      queueFilter: "settlement",
      limit: 10,
      dryRun: true,
    });
  });

  it.each([
    { args: ["--queue"] },
    { args: ["--queue", "--dry-run"] },
    { args: ["--queue", "unknown"] },
  ])("rejects invalid queue arguments", ({ args }) => {
    expect(() => parseArgs(args)).toThrow();
  });

  it.each([
    { args: ["--limit"] },
    { args: ["--limit", "abc"] },
    { args: ["--limit", "0"] },
    { args: ["--limit", "-5"] },
    { args: ["--limit", "1.5"] },
  ])("rejects invalid limit arguments", ({ args }) => {
    expect(() => parseArgs(args)).toThrow(/--limit/);
  });

  it("rejects unknown arguments rather than silently widening the replay", () => {
    expect(() => parseArgs(["--limt", "10"])).toThrow(/Unknown argument/);
  });
});

describe("replay-dlq entry validation and idempotency", () => {
  it("rejects malformed payload JSON rather than replaying its raw text", () => {
    expect(() =>
      fieldsToRecord(["payload", "{not-json"])
    ).toThrow(/payload is not valid JSON/);
  });

  it("rejects payloads that cannot be enqueued as stream fields", async () => {
    const evalRedis = { eval: vi.fn() } as unknown as Pick<Redis, "eval">;

    await expect(
      replayDLQEntry(
        evalRedis,
        "vatix:dead-letter:settlement",
        "settlement",
        "1-0",
        { payload: "not an object" }
      )
    ).rejects.toThrow(/payload must be a JSON object/);
    expect(evalRedis.eval).not.toHaveBeenCalled();
  });

  it("uses an atomic, deduplicated enqueue-and-delete and requires Redis confirmation", async () => {
    const evalMock = vi.fn(
      async (_script: string, _keyCount: number, ..._args: string[]) =>
        "1710000000000-0"
    );
    const evalRedis = { eval: evalMock } as unknown as Pick<Redis, "eval">;

    await expect(
      replayDLQEntry(
        evalRedis,
        "vatix:dead-letter:settlement",
        "settlement",
        "1700000000000-0",
        { payload: { tradeId: "trade-1" } }
      )
    ).resolves.toBe("1710000000000-0");

    const [script, keyCount, source, target, dedupeKey] =
      evalMock.mock.calls[0];
    expect(keyCount).toBe(3);
    expect(source).toBe("vatix:dead-letter:settlement");
    expect(target).toBe("vatix:settlement");
    expect(dedupeKey).toBe("vatix:dlq-replay:settlement:1700000000000-0");
    const enqueueIndex = script.indexOf("local targetId = redis.call('XADD'");
    const deleteIndex = script.indexOf("redis.call('XDEL'", enqueueIndex);
    expect(enqueueIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(enqueueIndex);
    expect(script).toContain("redis.call('GET', KEYS[3])");
  });

  it("fails when Redis does not return a confirmed target stream ID", async () => {
    const evalRedis = {
      eval: vi.fn(async () => null),
    } as unknown as Pick<Redis, "eval">;

    await expect(
      replayDLQEntry(
        evalRedis,
        "vatix:dead-letter:oracle",
        "oracle",
        "1-0",
        { payload: { marketId: "market-1" } }
      )
    ).rejects.toThrow(/did not confirm/);
  });
});
