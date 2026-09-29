/**
 * Integration test (issue #1136): the raw-stream DLQ replay must actually
 * deliver a message to the stream the live consumer reads — and must never
 * delete a message it cannot deliver.
 *
 * `tests/replay-dlq.test.ts` covers the pure helpers. This file drives the
 * *real* `scripts/replay-dlq.ts` execution path as a subprocess against a live
 * Redis, seeding entries with exactly the field set `logDeadLetter()` writes.
 *
 * Both regressions below were reproduced on the pre-fix code:
 *   1. the replay wrote the payload flattened into top-level stream fields, so
 *      the consumer's `JSON.parse(fields.payload)` threw and the message was
 *      unreadable;
 *   2. it derived the target as `${KEY_PREFIX}${queue}` (i.e.
 *      `vatix:oracle-submission`) while `RedisSubmissionQueue` consumes
 *      `vatix:oracle:submissions`, so the message was stranded even though the
 *      CLI reported `replayed: 1`.
 * In both cases the DLQ entry was `XDEL`ed, silently losing the message.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import Redis from "ioredis";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "../..");
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const PREFIX = "itest:replay-dlq:";
const DLQ_PREFIX = `${PREFIX}dead-letter:`;
const ORACLE_DLQ = `${DLQ_PREFIX}oracle-submission`;
const SETTLEMENT_DLQ = `${DLQ_PREFIX}settlement`;
/** The stream RedisSubmissionQueue.enqueue()/dequeue() actually use. */
const ORACLE_LIVE = `${PREFIX}oracle:submissions`;

let redis: Redis;

/** Seed a DLQ entry with exactly the fields logDeadLetter() writes. */
async function seedDeadLetter(
  stream: string,
  queue: string,
  payload: Record<string, unknown>
): Promise<void> {
  await redis.xadd(
    stream,
    "*",
    "messageId",
    "sub-1",
    "queue",
    queue,
    "reason",
    "boom",
    "payloadType",
    "object",
    "payload",
    JSON.stringify(payload),
    "payloadHash",
    "h",
    "duplicate",
    "false",
    "errorCode",
    "ORACLE_TX_FAILED",
    "classification",
    "fatal",
    "timestamp",
    new Date().toISOString()
  );
}

function parseLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
}

/** Run the real CLI and return its parsed stdout + exit code. */
async function runCli(
  args: string[]
): Promise<{ code: number; lines: Record<string, unknown>[] }> {
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["tsx", "scripts/replay-dlq.ts", ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          REDIS_URL,
          REDIS_KEY_PREFIX: PREFIX,
          NODE_ENV: "development",
        },
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    return { code: 0, lines: parseLines(stdout) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, lines: parseLines(e.stdout ?? "") };
  }
}

/** Parse a stream entry's flat field array the way the real consumer does. */
function entryToFields(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out[fields[i]] = fields[i + 1];
  }
  return out;
}

describe("raw-stream DLQ replay — real execution path (#1136)", () => {
  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    const keys = await redis.keys(`${PREFIX}*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  it("delivers a replayed message to the stream the oracle consumer reads", async () => {
    const payload = {
      marketId: "m-1",
      oracleAddress: "GA7XION5HT3IMJXJDVTZJNOY4JXXKAQK4FTL2KJ4D5CE2P7TCCPXWLLQ",
      attempts: 3,
    };
    await seedDeadLetter(ORACLE_DLQ, "oracle-submission", payload);

    const { code, lines } = await runCli(["--queue", "oracle-submission"]);

    expect(code).toBe(0);
    const done = lines.find(
      (l) => l.message === "DLQ replay completed"
    ) as Record<string, unknown>;
    expect(done.replayed).toBe(1);

    // Must land on the stream the live consumer reads — not a key derived
    // from the DLQ name.
    const live = await redis.xrange(ORACLE_LIVE, "-", "+");
    expect(live).toHaveLength(1);

    // The consumer's own parse must succeed and yield the original payload.
    const fields = entryToFields(live[0][1]);
    expect(() => JSON.parse(fields.payload)).not.toThrow();
    expect(JSON.parse(fields.payload)).toEqual(payload);

    // Only removed once safely on the live stream.
    expect(await redis.xlen(ORACLE_DLQ)).toBe(0);
  });

  it("does not strand the message on a key the consumer never reads", async () => {
    await seedDeadLetter(ORACLE_DLQ, "oracle-submission", { marketId: "m-2" });
    await runCli(["--queue", "oracle-submission"]);

    expect(await redis.exists(`${PREFIX}oracle-submission`)).toBe(0);
    expect(await redis.xlen(ORACLE_LIVE)).toBe(1);
  });

  it("keeps the entry in the DLQ when no live stream backs the queue", async () => {
    // `settlement` is BullMQ-backed; there is no stream to replay into.
    await seedDeadLetter(SETTLEMENT_DLQ, "settlement", { tradeId: "t-1" });

    const { lines } = await runCli(["--queue", "settlement"]);
    const skipped = lines.find(
      (l) => l.message === "No live stream backs this dead-letter queue"
    );
    expect(skipped).toBeDefined();

    // Fail-closed: still there for an operator.
    expect(await redis.xlen(SETTLEMENT_DLQ)).toBe(1);
    // ...and no bogus stream was invented.
    expect(await redis.exists(`${PREFIX}settlement`)).toBe(0);
  });

  it("preserves an entry with a non-replayable payload instead of dropping it", async () => {
    // payload is a JSON array: not representable, must stay in the DLQ.
    await redis.xadd(
      ORACLE_DLQ,
      "*",
      "messageId",
      "sub-2",
      "queue",
      "oracle-submission",
      "reason",
      "boom",
      "payload",
      JSON.stringify([1, 2, 3])
    );

    await runCli(["--queue", "oracle-submission"]);

    expect(await redis.xlen(ORACLE_DLQ)).toBe(1);
    expect(await redis.xlen(ORACLE_LIVE)).toBe(0);
  });

  it("--dry-run leaves both the DLQ and the live stream untouched", async () => {
    await seedDeadLetter(ORACLE_DLQ, "oracle-submission", { marketId: "m-3" });

    const { code } = await runCli([
      "--queue",
      "oracle-submission",
      "--dry-run",
    ]);

    expect(code).toBe(0);
    expect(await redis.xlen(ORACLE_DLQ)).toBe(1);
    expect(await redis.xlen(ORACLE_LIVE)).toBe(0);
  });

  // Regression: `logDeadLetter()` writes a dedupe mark at
  // `{prefix}dead-letter:dedupe:{queue}:{payloadHash}` on every dead-letter,
  // and that key is a plain STRING. `SCAN MATCH {prefix}dead-letter:*` returns
  // it alongside the real streams, so the CLI used to call XRANGE on it, get
  // WRONGTYPE, and abort the whole run with exit 1 — an unqualified replay
  // could never recover anything on a Redis that had ever failed a job (#1136).
  it("replays the real stream even when a dedupe mark sits in the same namespace", async () => {
    await seedDeadLetter(ORACLE_DLQ, "oracle-submission", { marketId: "m-4" });
    await redis.set(
      `${DLQ_PREFIX}dedupe:oracle-submission:${"a".repeat(64)}`,
      "1",
      "EX",
      3600
    );

    const { code, lines } = await runCli(["--queue", "oracle-submission"]);

    expect(code).toBe(0);
    const done = lines.find(
      (l) => l.message === "DLQ replay completed"
    ) as Record<string, unknown>;
    expect(done.replayed).toBe(1);

    expect(await redis.xlen(ORACLE_LIVE)).toBe(1);
    // The dedupe mark is left alone: it is bookkeeping, not a message.
    expect(
      await redis.exists(
        `${DLQ_PREFIX}dedupe:oracle-submission:${"a".repeat(64)}`
      )
    ).toBe(1);
  });

  // The same collision applies to a fully unqualified `pnpm replay:dlq`, which
  // sweeps every queue — the default an operator reaches for during an incident.
  it("an unqualified replay is not broken by dedupe marks from another queue", async () => {
    await seedDeadLetter(ORACLE_DLQ, "oracle-submission", { marketId: "m-5" });
    await redis.set(
      `${DLQ_PREFIX}dedupe:settlement:${"b".repeat(64)}`,
      "1",
      "EX",
      3600
    );

    const { code, lines } = await runCli([]);

    expect(code).toBe(0);
    const done = lines.find(
      (l) => l.message === "DLQ replay completed"
    ) as Record<string, unknown>;
    expect(done.replayed).toBe(1);
    expect(await redis.xlen(ORACLE_LIVE)).toBe(1);
  });
});
