/**
 * Unit tests for the raw-stream DLQ replay CLI helpers (issue #1136).
 *
 * Pins the fail-closed argument parsing, the production mutation gate, and the
 * payload-redaction logic that operator safety and log hygiene depend on —
 * without requiring a live Redis connection.
 */
import { describe, it, expect } from "vitest";
import {
  DEDUPE_KEY_SUBPREFIX,
  QUEUE_NAME_PATTERN,
  UsageError,
  assertQueueFilter,
  computePayloadHash,
  fieldsToRecord,
  isDedupKey,
  isReplayablePayload,
  resolveReplayStreamKey,
  toReplayFields,
  mutationAllowed,
  parseReplayArgs,
  payloadLogFields,
} from "../scripts/replay-dlq.lib.js";

describe("parseReplayArgs", () => {
  it("defaults to replaying everything, non-dry, no confirmation", () => {
    expect(parseReplayArgs([])).toEqual({
      queueFilter: undefined,
      limit: Number.POSITIVE_INFINITY,
      dryRun: false,
      yes: false,
    });
  });

  it("parses --queue, --limit, --dry-run and --yes", () => {
    expect(
      parseReplayArgs([
        "--queue",
        "settlement",
        "--limit",
        "10",
        "--dry-run",
        "--yes",
      ])
    ).toEqual({
      queueFilter: "settlement",
      limit: 10,
      dryRun: true,
      yes: true,
    });
  });

  it("accepts -y as the yes alias", () => {
    expect(parseReplayArgs(["-y"]).yes).toBe(true);
  });

  it("rejects unknown arguments instead of silently ignoring them", () => {
    expect(() => parseReplayArgs(["--force"])).toThrow(UsageError);
    expect(() => parseReplayArgs(["replay-all"])).toThrow(/Unknown argument/);
  });

  it("rejects --queue without a value", () => {
    expect(() => parseReplayArgs(["--queue"])).toThrow(/--queue requires/);
  });

  it("rejects queue names that could inject SCAN glob metacharacters", () => {
    expect(() => parseReplayArgs(["--queue", "dead-letter:*"])).toThrow(
      UsageError
    );
    expect(() => parseReplayArgs(["--queue", "sett?ement"])).toThrow(
      UsageError
    );
    expect(() => parseReplayArgs(["--queue", "a[b"])).toThrow(UsageError);
    expect(() => parseReplayArgs(["--queue", ""])).toThrow(UsageError);
    expect(() => parseReplayArgs(["--queue", "evil;drop"])).toThrow(UsageError);
  });

  it("accepts documented queue aliases", () => {
    for (const queue of [
      "settlement",
      "oracle",
      "submission",
      "settlement:dlq",
    ]) {
      expect(QUEUE_NAME_PATTERN.test(queue)).toBe(true);
      expect(parseReplayArgs(["--queue", queue]).queueFilter).toBe(queue);
    }
  });

  it("rejects malformed limits fail-closed instead of defaulting to unlimited", () => {
    expect(() => parseReplayArgs(["--limit", "0"])).toThrow(/positive integer/);
    expect(() => parseReplayArgs(["--limit", "-5"])).toThrow(
      /positive integer/
    );
    expect(() => parseReplayArgs(["--limit", "abc"])).toThrow(
      /positive integer/
    );
    expect(() => parseReplayArgs(["--limit", "1.5"])).toThrow(
      /positive integer/
    );
    expect(() => parseReplayArgs(["--limit"])).toThrow(/positive integer/);
  });
});

describe("mutationAllowed (production confirmation gate)", () => {
  it("allows mutating runs outside production", () => {
    expect(mutationAllowed("development", false, false)).toBe(true);
    expect(mutationAllowed("test", false, false)).toBe(true);
  });

  it("blocks mutating runs in production without --yes", () => {
    expect(mutationAllowed("production", false, false)).toBe(false);
  });

  it("allows mutating runs in production with --yes", () => {
    expect(mutationAllowed("production", false, true)).toBe(true);
  });

  it("never blocks --dry-run because it mutates nothing", () => {
    expect(mutationAllowed("production", true, false)).toBe(true);
  });
});

describe("fieldsToRecord", () => {
  it("pairs flat stream fields into a record", () => {
    expect(fieldsToRecord(["messageId", "m-1", "reason", "boom"])).toEqual({
      messageId: "m-1",
      reason: "boom",
    });
  });

  it("parses a JSON payload", () => {
    const record = fieldsToRecord(["payload", '{"tradeId":"t-1"}']);
    expect(record.payload).toEqual({ tradeId: "t-1" });
  });

  it("keeps a non-JSON payload as the raw string", () => {
    expect(fieldsToRecord(["payload", "not-json"]).payload).toBe("not-json");
  });
});

describe("payload redaction helpers", () => {
  const payload = { secret: "hunter2", tradeId: "t-1" };

  it("hashes payloads deterministically", () => {
    expect(computePayloadHash(payload)).toBe(
      computePayloadHash({ ...payload })
    );
    expect(computePayloadHash(payload)).not.toBe(
      computePayloadHash({ secret: "other" })
    );
    expect(computePayloadHash(payload)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("exposes only payloadType and payloadHash — never the payload", () => {
    const fields = payloadLogFields(payload);
    expect(fields).toEqual({
      payloadType: "object",
      payloadHash: computePayloadHash(payload),
    });
    expect(JSON.stringify(fields)).not.toContain("hunter2");
  });

  it("classifies null payloads", () => {
    expect(payloadLogFields(null).payloadType).toBe("null");
  });
});

describe("isReplayablePayload", () => {
  it("accepts non-empty plain objects", () => {
    expect(isReplayablePayload({ tradeId: "t-1" })).toBe(true);
  });

  it("rejects primitives, arrays, null and empty objects fail-closed", () => {
    expect(isReplayablePayload(null)).toBe(false);
    expect(isReplayablePayload(undefined)).toBe(false);
    expect(isReplayablePayload("raw-string")).toBe(false);
    expect(isReplayablePayload(42)).toBe(false);
    expect(isReplayablePayload([])).toBe(false);
    expect(isReplayablePayload({})).toBe(false);
  });
});

// The --queue filter is interpolated into a Redis SCAN MATCH pattern, so it is
// validated before use; scripts/replay-dlq.ts relies on this helper (#1136).
describe("assertQueueFilter", () => {
  it("accepts an absent filter (means: all queues)", () => {
    expect(() => assertQueueFilter(undefined)).not.toThrow();
  });

  it("accepts plain queue names, including the documented aliases", () => {
    for (const queue of ["settlement", "oracle", "vatix:settlement", "q-1_2"]) {
      expect(() => assertQueueFilter(queue)).not.toThrow();
    }
  });

  it("rejects SCAN glob metacharacters that would widen the sweep", () => {
    for (const queue of ["*", "settle*", "settle?", "[a-z]*", "a b", ""]) {
      expect(() => assertQueueFilter(queue)).toThrow(UsageError);
    }
  });

  it("never echoes the rejected filter into the message", () => {
    expect(() => assertQueueFilter("*")).toThrow(/got: invalid value/);
  });
});

// ---------------------------------------------------------------------------
// Round-trip fidelity (#1136).
//
// These are regressions for two defects that made `pnpm replay:dlq` silently
// destroy messages: it wrote the payload flattened into top-level stream
// fields and derived the target key as `${KEY_PREFIX}${queue}`, while the live
// consumer reads `JSON.parse(fields.payload)` off a *differently named* stream.
// Both were proven against a live Redis before being fixed.
// ---------------------------------------------------------------------------
describe("toReplayFields", () => {
  it("writes the payload under a `payload` field, as the live producer does", () => {
    const payload = { marketId: "m-1", attempts: 3 };
    expect(toReplayFields(payload)).toEqual([
      "payload",
      JSON.stringify(payload),
      "payloadHash",
      computePayloadHash(payload),
    ]);
  });

  it("keeps the payload JSON parseable by the consumer's JSON.parse(fields.payload)", () => {
    const payload = { marketId: "m-1", nested: { a: 1 } };
    const fields = Object.fromEntries(
      toReplayFields(payload).reduce<string[][]>((acc, v, i, arr) => {
        if (i % 2 === 0) acc.push([v]);
        else acc[acc.length - 1].push(v);
        return acc;
      }, [])
    );
    expect(() => JSON.parse(fields.payload as string)).not.toThrow();
    expect(JSON.parse(fields.payload as string)).toEqual(payload);
  });

  it("no longer flattens payload keys into top-level stream fields", () => {
    const fields = toReplayFields({ marketId: "m-1" });
    const keys = fields.filter((_, i) => i % 2 === 0);
    expect(keys).not.toContain("marketId");
    expect(keys).toContain("payload");
  });
});

describe("resolveReplayStreamKey", () => {
  it("maps the oracle DLQ stream to the stream the submission queue reads", () => {
    // logDeadLetter() writes queue "oracle-submission" (submission-worker.ts);
    // RedisSubmissionQueue consumes `oracle:submissions` (STREAM_BASENAME).
    expect(resolveReplayStreamKey("oracle-submission", "vatix:")).toBe(
      "vatix:oracle:submissions"
    );
  });

  it("honours a custom key prefix", () => {
    expect(resolveReplayStreamKey("oracle-submission", "staging:")).toBe(
      "staging:oracle:submissions"
    );
  });

  it("returns undefined for the BullMQ-backed settlement queue", () => {
    // `settlement` is a BullMQ queue (settlement-trades), not a stream: there
    // is no stream to write to, and the operator path is `pnpm dlq` (#953).
    expect(resolveReplayStreamKey("settlement", "vatix:")).toBeUndefined();
  });

  it("returns undefined for an unknown queue rather than inventing a key", () => {
    expect(resolveReplayStreamKey("mystery", "vatix:")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dedupe-mark exclusion (#1136).
//
// `logDeadLetter()` writes a dedupe mark at
// `{prefix}dead-letter:dedupe:{queue}:{payloadHash}` on EVERY dead-letter,
// before the stream entry. `SCAN MATCH {prefix}dead-letter:*` returns those
// string keys alongside the real streams, and `XRANGE` on a string key fails
// with WRONGTYPE — so an unqualified `pnpm replay:dlq` aborted with exit 1
// before replaying a single entry, on any Redis that had ever failed a job.
// ---------------------------------------------------------------------------
describe("isDedupKey", () => {
  const PREFIX = "vatix:";
  const DLQ_PREFIX = `${PREFIX}dead-letter:`;

  it("flags the dedupe marks that logDeadLetter writes", () => {
    expect(
      isDedupKey(
        `${DLQ_PREFIX}${DEDUPE_KEY_SUBPREFIX}settlement:abc123`,
        DLQ_PREFIX
      )
    ).toBe(true);
  });

  it("does not flag a real dead-letter stream", () => {
    expect(isDedupKey(`${DLQ_PREFIX}oracle-submission`, DLQ_PREFIX)).toBe(
      false
    );
    expect(isDedupKey(`${DLQ_PREFIX}settlement`, DLQ_PREFIX)).toBe(false);
  });

  it("matches the exact key shape written by checkAndMarkDuplicate", () => {
    // dead-letter.ts: `${prefix}dead-letter:dedupe:${queue}:${payloadHash}`
    expect(DEDUPE_KEY_SUBPREFIX).toBe("dedupe:");
    expect(
      isDedupKey(
        `${PREFIX}dead-letter:${DEDUPE_KEY_SUBPREFIX}oracle-submission:${"f".repeat(64)}`,
        DLQ_PREFIX
      )
    ).toBe(true);
  });

  it("does not flag a queue whose name merely starts with 'dedupe'", () => {
    // A queue literally named `dedupe-x` is still a stream; only the
    // `dedupe:` sub-namespace segment marks a non-replayable key.
    expect(isDedupKey(`${DLQ_PREFIX}dedupe-x`, DLQ_PREFIX)).toBe(false);
  });

  it("scopes the check to the configured DLQ prefix", () => {
    expect(
      isDedupKey(`${PREFIX}dead-letter:dedupe:q:h`, `${PREFIX}dead-letter:`)
    ).toBe(true);
    expect(isDedupKey("other:dead-letter:dedupe:q:h", DLQ_PREFIX)).toBe(false);
  });
});
