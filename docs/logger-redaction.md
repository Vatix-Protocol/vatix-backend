Redaction of sensitive fields is centralized in `packages/shared/src/logRedactor.ts`,
which the indexer's `createLogger` (`apps/indexer/src/logger.ts`) builds on.

## Redaction

### Key-based (`redactObject` / `redactMeta`)

Any key matching `SENSITIVE_KEYS` (case-insensitive) has its value replaced with
`[REDACTED]`, recursively through nested objects and arrays. The input is never
mutated — a new object is returned.

### Text-based (`redactText`)

Key-based redaction is blind to secrets interpolated into the free-text
`message`, which is common at call sites like
``logger.info(`connect failed for ${redisUrl}`)``. `redactText` scrubs:

| Shape                  | Example                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| URL userinfo           | `redis://admin:hunter2@cache:6379` → `redis://admin:[REDACTED]@cache:6379` |
| key=value / key: value | `password=hunter2` → `password=[REDACTED]`                                 |
| Auth schemes           | `Authorization: Bearer abc.def` → `Authorization: Bearer [REDACTED]`       |

Patterns are anchored to known credential markers so operational context
(market ids, stream ids, hashes) survives — over-scrubbing would make the logs
useless during an incident. Prefer `redactRedisUrl()` from `redis-tls.ts` when
you have a URL and want to log it directly; `redactText` is the safety net for
messages assembled from several parts.

## Fail-closed guarantees

Redaction is designed so that adversarial or malformed input can never cause a
secret to be emitted:

- **Depth limit** — beyond `MAX_REDACTION_DEPTH` (10) a value is replaced with
  `[REDACTED:TRUNCATED]`, _not_ passed through. Returning the raw value (the
  previous behavior) silently disabled redaction exactly where a secret was
  most likely to be buried.
- **Cycles** — a value already on the current path is truncated, so circular
  references terminate instead of recursing. The guard tracks the current path,
  not everything visited, so the same object may still appear in sibling
  branches and be redacted normally.
- **Hostile getters** — a property getter that throws is caught per-property and
  recorded as `[REDACTED:TRUNCATED]`.

## Log record integrity

`ts`, `level`, `message` and `component` are owned by the logger. A `meta` key
matching one of these is moved under `meta` rather than overwriting the
envelope, so caller-supplied data cannot forge a record's severity, timestamp or
text. Colliding values are preserved (nothing is silently dropped).

The logger also never throws: unserializable metadata degrades to a minimal line
marked `logSerializationError: true`. Callers log from `catch` blocks, where a
throw would mask the original failure and can take down a long-running worker.

closes #1138
