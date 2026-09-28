/**
 * DLQ replay runbook ↔ CLI parity (issue #1136).
 *
 * "Ops replay the wrong store and lose a message." The raw-stream replay CLI
 * only re-enqueues queues that have a live Redis stream behind them; a
 * BullMQ-backed queue such as `settlement` is skipped fail-closed. These tests
 * fail if:
 *   - the CLI's own usage text advertises a queue it refuses to replay, or
 *   - the runbook walks an operator through replaying `settlement` (or a queue
 *     name that does not exist) with the raw-stream CLI, or
 *   - the runbook stops cross-linking the full operator contract.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveReplayStreamKey } from "../../scripts/replay-dlq.lib.js";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const script = read("scripts/replay-dlq.ts");
const runbook = read("docs/queue-consumer.md");
const dlqDoc = read("docs/dead-letter-log.md");

/** The DLQ queues the runbook must account for, replayable or skipped. */
const KNOWN_QUEUES = ["oracle-submission", "settlement"];

describe("replay:dlq usage text", () => {
  const usage = script.slice(
    script.indexOf("* Usage:"),
    script.indexOf("* Exit codes:")
  );

  it("documents a queue the CLI can replay, never a skipped one", () => {
    const documented = [...usage.matchAll(/--queue ([A-Za-z0-9:_-]+)/g)].map(
      (m) => m[1]
    );
    expect(documented.length).toBeGreaterThan(0);
    for (const queue of documented) {
      expect(
        resolveReplayStreamKey(queue, "vatix:"),
        `--queue ${queue} has no live stream behind it and would be skipped`
      ).toBeDefined();
    }
  });

  it("points BullMQ-backed operators at pnpm dlq", () => {
    expect(script).toContain("pnpm dlq");
  });
});

describe("docs/queue-consumer.md replay guidance", () => {
  it("never instructs a raw-stream replay of a skipped queue", () => {
    for (const match of runbook.matchAll(
      /replay:dlq[^\n]*--queue ([A-Za-z0-9:_-]+)/g
    )) {
      expect(
        resolveReplayStreamKey(match[1], "vatix:"),
        `docs/queue-consumer.md replays "${match[1]}", which the CLI skips`
      ).toBeDefined();
    }
  });

  it("routes settlement to pnpm dlq and links the operator contract", () => {
    expect(runbook).toContain("pnpm dlq");
    expect(runbook).toContain("dead-letter-log.md#");
    for (const queue of KNOWN_QUEUES) {
      expect(runbook).toContain(queue);
    }
  });

  it("keeps docs/dead-letter-log.md as the replay target table", () => {
    expect(dlqDoc).toContain("oracle:submissions");
    expect(dlqDoc).toContain("pnpm replay:dlq");
  });
});
