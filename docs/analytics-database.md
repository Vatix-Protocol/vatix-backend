# Analytics Database Connection (#743, #979)

The admin analytics endpoints (e.g. `GET /v1/admin/analytics/summary`) run
heavy aggregate queries. They use a **separate, read-only Prisma client**
(`src/services/analytics-prisma.ts`) so those queries do not compete with the
matching / OLTP path for connections on the primary database.

## Configuration

| Env var                        | Default | Purpose                                                                                    |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| `ANALYTICS_DATABASE_URL`       | _unset_ | Connection string for the analytics client. Point at a **dedicated read replica**.         |
| `ANALYTICS_DATABASE_POOL_SIZE` | `5`     | Max connections in the `pg.Pool` backing the analytics client. Independent of the primary. |

`DATABASE_POOL_SIZE` (default `10`) bounds the **primary** pool and is
unchanged by this feature.

## Production vs. dev split (#979)

- **`NODE_ENV=production`** — `ANALYTICS_DATABASE_URL` is **required** and must
  be **distinct** from `DATABASE_URL`. If it is unset or equal to the primary
  URL, `getAnalyticsPrismaClient()` throws `AnalyticsDatabaseConfigError` on
  first use (fail-fast). Rationale: sharing the primary connection pool for
  analytics is exactly the starvation failure mode this guard exists to
  prevent — a burst of expensive analytics queries could consume enough
  connections to make the matching path fail to acquire one, silently
  dropping trades/resolutions.
- **Other environments** — the analytics client falls back to `DATABASE_URL`
  so local dev and CI work without provisioning a replica. The pool is still
  capped at `ANALYTICS_DATABASE_POOL_SIZE`, and a structured `warn` log line
  (`component: "analytics-prisma"`) records the fallback.

## Sizing guidance

Keep `ANALYTICS_DATABASE_POOL_SIZE` well below the replica's
`max_connections` divided by the number of API instances. The default of `5`
is deliberately small: analytics traffic is low-QPS and latency-tolerant, so
a handful of connections per instance is plenty, and a low cap contains the
blast radius of a runaway report.

## Observability

Client initialization emits one structured log line with `correlationId`,
`usingReplica`, `poolMaxConnections`, and `nodeEnv`. The connection string is
never logged.
