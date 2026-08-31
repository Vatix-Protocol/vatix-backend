#!/usr/bin/env tsx
/**
 * BullMQ Dead-Letter Queue Admin CLI — issue #953.
 *
 * Operator path for poison jobs that exhausted their retries and now sit in
 * the BullMQ `failed` set of the settlement / oracle queues (which run with
 * `removeOnFail: false`). Without this the only path was `redis-cli`.
 *
 * Usage:
 *   pnpm dlq stats     --queue settlement
 *   pnpm dlq list      --queue oracle [--limit 50]
 *   pnpm dlq retry     --queue settlement --job <jobId>
 *   pnpm dlq retry-all --queue settlement [--limit 50] [--dry-run] [--yes]
 *   pnpm dlq discard   --queue oracle --job <jobId> [--yes]
 *
 * `retry-all` and `discard` mutate production state; in NODE_ENV=production
 * they refuse to run without `--yes` (fail-fast confirmation). `--dry-run`
 * previews `retry-all` and never needs `--yes`.
 *
 * This is separate from `scripts/replay-dlq.ts`, which drains the older raw
 * `vatix:dead-letter:*` Redis streams written for non-retryable poison
 * messages.
 *
 * @module scripts/dlq
 */
import { randomUUID } from "crypto";
import {
  BullmqDlq,
  DLQ_QUEUES,
  isDlqQueue,
  resolveDlqQueueName,
  type DlqQueue,
} from "../apps/workers/src/consumers/bullmq-dlq.js";

type Command = "stats" | "list" | "retry" | "retry-all" | "discard";
const COMMANDS: readonly Command[] = [
  "stats",
  "list",
  "retry",
  "retry-all",
  "discard",
];
const MUTATING: ReadonlySet<Command> = new Set<Command>([
  "retry",
  "retry-all",
  "discard",
]);

const correlationId = randomUUID();

function log(
  level: "info" | "warn" | "error",
  message: string,
  meta: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "dlq-cli",
      correlationId,
      message,
      ...meta,
    })
  );
}

interface Args {
  command: Command;
  queue: DlqQueue;
  jobId?: string;
  limit?: number;
  dryRun: boolean;
  yes: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command as Command)) {
    throw new UsageError(
      `First argument must be one of: ${COMMANDS.join(", ")}`
    );
  }

  let queue: string | undefined;
  let jobId: string | undefined;
  let limit: number | undefined;
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--queue") {
      queue = rest[++i];
    } else if (arg === "--job") {
      jobId = rest[++i];
    } else if (arg === "--limit") {
      const n = parseInt(rest[++i] ?? "", 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new UsageError("--limit must be a positive integer");
      }
      limit = n;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  if (!queue || !isDlqQueue(queue)) {
    throw new UsageError(
      `--queue is required and must be one of: ${DLQ_QUEUES.join(", ")}`
    );
  }

  if ((command === "retry" || command === "discard") && !jobId) {
    throw new UsageError(`${command} requires --job <jobId>`);
  }

  return { command: command as Command, queue, jobId, limit, dryRun, yes };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nodeEnv = process.env.NODE_ENV ?? "development";

  // Production confirmation gate for state-mutating commands (dry-run exempt).
  const mutatesNow =
    MUTATING.has(args.command) &&
    !(args.command === "retry-all" && args.dryRun);
  if (mutatesNow && nodeEnv === "production" && !args.yes) {
    log("error", "Refusing to mutate the DLQ in production without --yes", {
      command: args.command,
      queue: args.queue,
    });
    process.exit(2);
  }

  const dlq = BullmqDlq.forQueue(args.queue);
  const queueName = resolveDlqQueueName(args.queue);

  log("info", "DLQ command started", {
    command: args.command,
    queue: args.queue,
    queueName,
    nodeEnv,
  });

  try {
    switch (args.command) {
      case "stats": {
        const stats = await dlq.stats();
        log("info", "DLQ stats", { queue: args.queue, ...stats });
        break;
      }
      case "list": {
        const entries = await dlq.list({ limit: args.limit });
        for (const e of entries) {
          log("info", "DLQ entry", {
            jobId: e.jobId,
            name: e.name,
            attemptsMade: e.attemptsMade,
            failedReason: e.failedReason,
            ageMs: Date.now() - e.timestamp,
          });
        }
        log("info", "DLQ list complete", {
          queue: args.queue,
          count: entries.length,
        });
        break;
      }
      case "retry": {
        await dlq.retry(args.jobId!);
        log("info", "DLQ job re-queued", {
          queue: args.queue,
          jobId: args.jobId,
        });
        break;
      }
      case "discard": {
        await dlq.discard(args.jobId!);
        log("warn", "DLQ job discarded permanently", {
          queue: args.queue,
          jobId: args.jobId,
        });
        break;
      }
      case "retry-all": {
        const result = await dlq.retryAll({
          limit: args.limit,
          dryRun: args.dryRun,
        });
        log("info", "DLQ retry-all complete", {
          queue: args.queue,
          scanned: result.scanned,
          retried: result.retried.length,
          failed: result.failed.length,
          dryRun: result.dryRun,
          failures: result.failed,
        });
        if (result.failed.length > 0) process.exitCode = 1;
        break;
      }
    }
  } finally {
    await dlq.close();
  }
}

void main().catch((error) => {
  if (error instanceof UsageError) {
    log("error", "Usage error", { detail: error.message });
    process.exit(2);
  }
  log("error", "DLQ command failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
