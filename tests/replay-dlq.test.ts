/**
 * Unit tests for the raw-stream DLQ replay CLI helpers (issue #1136).
 *
 * Pins the fail-closed argument parsing, the production mutation gate, and the
 * payload-redaction logic that operator safety and log hygiene depend on —
 * without requiring a live Redis connection.
 */
import { describe, it, expect } from "vitest";
import {
  QUEUE_NAME_PATTERN,
  UsageError,
  computePayloadHash,
  fieldsToRecord,
  isReplayablePayload,
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
