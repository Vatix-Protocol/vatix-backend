import { describe, it, expect, vi } from "vitest";
import {
  DlqUsageError,
  assertSafeQueueFilter,
  discoverDlqStreams,
  fieldsToRecord,
  payloadToStreamFields,
  replayDeadLetters,
  toDeadLetterEntry,
  type RedisLike,
} from "./stream-dlq-replay.js";

const DLQ_PREFIX = "vatix:dead-letter:";
const KEY_PREFIX = "vatix:";

interface FakeRedisOptions {
  /** stream key -> entries */
  streams?: Record<string, Array<[string, string[]]>>;
  /** Cursors to return from SCAN, one page per call. */
  scanPages?: Array<[string, string[]]>;
  xaddError?: Error;
  xdelError?: Error;
}

function fakeRedis(opts: FakeRedisOptions = {}) {
  const calls = {
    scan: [] as unknown[][],
    xadd: [] as Array<{ key: string; fields: string[] }>,
    xdel: [] as Array<{ key: string; ids: string[] }>,
  };
  const streams = { ...(opts.streams ?? {}) };

  const redis: RedisLike = {
    async scan(cursor, ...args) {
      calls.scan.push([cursor, ...args]);
      if (opts.scanPages) return opts.scanPages.shift()!;
      return cursor === "0" ? ["0", Object.keys(streams)] : ["0", []];
    },
    async xrange(key) {
      return streams[key] ?? [];
    },
    async xadd(key, _id, ...fields) {
      if (opts.xaddError) throw opts.xaddError;
      calls.xadd.push({ key, fields });
      return "1-0";
    },
    async xdel(key, ...ids) {
      if (opts.xdelError) throw opts.xdelError;
      calls.xdel.push({ key, ids });
      return ids.length;
    },
  };

  return { redis, calls, streams };
}

const PAYLOAD_FIELDS = [
  "messageId",
  "msg-1",
  "reason",
  "boom",
  "payload",
  JSON.stringify({ tradeId: "t-1" }),
];

describe("assertSafeQueueFilter", () => {
  it("accepts ordinary queue names", () => {
    expect(() => assertSafeQueueFilter("settlement")).not.toThrow();
    expect(() => assertSafeQueueFilter("oracle-submissions")).not.toThrow();
    expect(() => assertSafeQueueFilter(undefined)).not.toThrow();
  });

  it("rejects glob and control characters (adversarial input)", () => {
    for (const bad of ["*", "settle*", "settle?ment", "a b", "a\nb", "a[b]"]) {
      expect(() => assertSafeQueueFilter(bad)).toThrow(DlqUsageError);
    }
  });

  it("rejects an over-long queue name", () => {
    expect(() => assertSafeQueueFilter("a".repeat(129))).toThrow(DlqUsageError);
  });
});

describe("fieldsToRecord", () => {
  it("JSON-parses the payload field and leaves the rest as strings", () => {
    expect(fieldsToRecord(PAYLOAD_FIELDS)).toEqual({
      messageId: "msg-1",
      reason: "boom",
      payload: { tradeId: "t-1" },
    });
  });

  it("falls back to the raw string for an unparseable payload", () => {
    expect(fieldsToRecord(["payload", "{oops"]).payload).toBe("{oops");
  });

  it("ignores a dangling key with no value", () => {
    expect(fieldsToRecord(["payload", "{}", "messageId"])).toEqual({
      payload: {},
    });
  });
});

describe("toDeadLetterEntry", () => {
  it("normalizes a well-formed record", () => {
    expect(toDeadLetterEntry("1-0", PAYLOAD_FIELDS, "settlement")).toEqual({
      entryId: "1-0",
      queue: "settlement",
      originalMessageId: "msg-1",
      reason: "boom",
      payload: { tradeId: "t-1" },
    });
  });

  it("drops a scalar payload (nothing replayable)", () => {
    expect(
      toDeadLetterEntry("2-0", ["payload", "not-an-object"], "settlement")
        .payload
    ).toBeUndefined();
  });
});

describe("payloadToStreamFields", () => {
  it("flattens an object to string field pairs", () => {
    expect(payloadToStreamFields({ tradeId: "t-1", amount: 5 })).toEqual([
      "tradeId",
      "t-1",
      "amount",
      "5",
    ]);
  });

  it("returns an empty list for non-object payloads", () => {
    expect(payloadToStreamFields(undefined)).toEqual([]);
    expect(payloadToStreamFields("str")).toEqual([]);
    expect(payloadToStreamFields({})).toEqual([]);
  });
});

describe("discoverDlqStreams", () => {
  it("paginates SCAN to completion and dedupes + sorts", async () => {
    const { redis } = fakeRedis({
      scanPages: [
        ["7", ["vatix:dead-letter:oracle", "vatix:dead-letter:settlement"]],
        ["0", ["vatix:dead-letter:settlement"]],
      ],
    });
    const keys = await discoverDlqStreams(redis, DLQ_PREFIX);
    expect(keys).toEqual([
      "vatix:dead-letter:oracle",
      "vatix:dead-letter:settlement",
    ]);
  });

  it("builds a filtered pattern from a safe queue name", async () => {
    const { redis, calls } = fakeRedis();
    await discoverDlqStreams(redis, DLQ_PREFIX, "settlement");
    expect(calls.scan[0][2]).toBe("vatix:dead-letter:settlement");
  });

  it("rejects an unsafe queue filter before touching Redis", async () => {
    const { redis, calls } = fakeRedis();
    await expect(discoverDlqStreams(redis, DLQ_PREFIX, "*")).rejects.toThrow(
      DlqUsageError
    );
    expect(calls.scan).toHaveLength(0);
  });
});

describe("replayDeadLetters", () => {
  it("replays an entry and then deletes it from the DLQ (append-before-delete)", async () => {
    const { redis, calls } = fakeRedis({
      streams: { [`${DLQ_PREFIX}settlement`]: [["1-0", PAYLOAD_FIELDS]] },
    });

    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
    });

    expect(summary.replayed).toBe(1);
    expect(summary.scanned).toBe(1);
    expect(summary.failures).toEqual([]);
    expect(calls.xadd).toEqual([
      { key: "vatix:settlement", fields: ["tradeId", "t-1"] },
    ]);
    expect(calls.xdel).toEqual([
      { key: `${DLQ_PREFIX}settlement`, ids: ["1-0"] },
    ]);
  });

  it("mutates nothing on a dry run", async () => {
    const { redis, calls } = fakeRedis({
      streams: { [`${DLQ_PREFIX}settlement`]: [["1-0", PAYLOAD_FIELDS]] },
    });

    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
      dryRun: true,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.replayed).toBe(1);
    expect(calls.xadd).toHaveLength(0);
    expect(calls.xdel).toHaveLength(0);
  });

  it("keeps the entry in the DLQ when the append fails (fail-closed)", async () => {
    const { redis, calls } = fakeRedis({
      streams: { [`${DLQ_PREFIX}settlement`]: [["1-0", PAYLOAD_FIELDS]] },
      xaddError: new Error("redis down"),
    });

    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
    });

    expect(summary.replayed).toBe(0);
    expect(summary.failures).toEqual([
      { entryId: "1-0", queue: "settlement", error: "redis down" },
    ]);
    expect(calls.xdel).toHaveLength(0);
  });

  it("reports a delete failure after a successful append (no silent loss)", async () => {
    const { redis } = fakeRedis({
      streams: { [`${DLQ_PREFIX}settlement`]: [["1-0", PAYLOAD_FIELDS]] },
      xdelError: new Error("XDEL failed"),
    });

    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
    });

    expect(summary.replayed).toBe(0);
    expect(summary.failures[0].error).toBe("XDEL failed");
  });

  it("continues past a failing entry and reports every failure", async () => {
    const { redis } = fakeRedis({
      streams: {
        [`${DLQ_PREFIX}settlement`]: [
          ["1-0", PAYLOAD_FIELDS],
          ["2-0", PAYLOAD_FIELDS],
        ],
      },
    });
    const xadd = vi
      .spyOn(redis, "xadd")
      .mockRejectedValueOnce(new Error("transient"));

    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
    });

    expect(summary.failures).toHaveLength(1);
    expect(summary.replayed).toBe(1);
    expect(xadd).toHaveBeenCalledTimes(2);
  });

  it("skips entries with no replayable payload instead of losing them", async () => {
    const { redis, calls } = fakeRedis({
      streams: {
        [`${DLQ_PREFIX}settlement`]: [
          ["1-0", ["messageId", "msg-1", "payload", "oops"]],
        ],
      },
    });

    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
    });

    expect(summary.skipped).toBe(1);
    expect(summary.replayed).toBe(0);
    expect(calls.xdel).toHaveLength(0);
  });

  it("honours the entry limit", async () => {
    const { redis } = fakeRedis({
      streams: {
        [`${DLQ_PREFIX}settlement`]: [
          ["1-0", PAYLOAD_FIELDS],
          ["2-0", PAYLOAD_FIELDS],
          ["3-0", PAYLOAD_FIELDS],
        ],
      },
    });

    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
      limit: 2,
    });

    expect(summary.replayed).toBe(2);
  });

  it("returns an empty summary when no DLQ streams exist", async () => {
    const { redis } = fakeRedis({ streams: {} });
    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
    });
    expect(summary).toMatchObject({
      streams: [],
      scanned: 0,
      replayed: 0,
      skipped: 0,
      failures: [],
    });
  });

  it("refuses to build a live key from a discovered unsafe stream suffix", async () => {
    const { redis, calls } = fakeRedis({
      scanPages: [["0", ["vatix:dead-letter:evil key"]]],
    });

    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
    });

    expect(calls.xadd).toHaveLength(0);
    expect(summary.failures[0].queue).toBe("evil key");
  });
});
