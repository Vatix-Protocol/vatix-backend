# Deployment Runbook

This runbook covers standard deployment procedures for the vatix-backend service.

## Services

vatix-backend deploys as four independent containers built from the same root
[`Dockerfile`](../Dockerfile), one `--target` per process, plus the shared
PostgreSQL and Redis data layer. See [docs/docker-compose.md](docker-compose.md)
for the full service/profile reference and [docs/architecture.md](architecture.md)
for how the processes relate to each other.

| Process             | Image target          | Depends on      |
| ------------------- | --------------------- | --------------- |
| API                 | `api`                 | Postgres, Redis |
| Indexer             | `indexer`             | Postgres        |
| Finalization worker | `finalization-worker` | Postgres        |
| Oracle worker       | `oracle-worker`       | Postgres, Redis |

## Standard Deployment

1. **Build images** for the commit being deployed (one build per process,
   sharing Docker layer cache):

   ```bash
   docker compose build api indexer finalization-worker oracle-worker
   ```

2. **Run database migrations** before rolling out new app containers:

   ```bash
   docker compose --profile migrate up --build migrate
   ```

   The `migrate` service runs `prisma migrate deploy` and exits — it is not a
   long-running process. Confirm it exits with status `0` before proceeding.

3. **Roll out the app containers:**

   ```bash
   docker compose --profile app up -d
   ```

4. **Verify health** of each service:

   ```bash
   curl -f http://localhost:3000/v1/health
   curl -f http://localhost:3000/v1/ready
   docker compose ps
   ```

   `/v1/health` confirms the API process and its DB connection are up.
   `/v1/ready` additionally checks indexer freshness — see
   [src/api/routes/ready.ts](../src/api/routes/ready.ts).

5. **Tail logs** during rollout to catch startup failures early:

   ```bash
   docker compose logs -f api indexer finalization-worker oracle-worker
   ```

## Rolling Back

1. Re-deploy the previous image tag/commit for the affected service(s):

   ```bash
   docker compose --profile app up -d --build api   # example: API only
   ```

2. If the rollback is due to a bad migration, follow the
   [Migration Rollback Procedure](./migration-rollback.md) first — schema
   rollbacks must happen before old application code is rolled back in, since
   old code is not guaranteed to be forward-compatible with a newer schema.

## Stopping a Deployment

```bash
docker compose --profile app down
```

This stops the app containers; `postgres` and `redis` keep running unless you
also drop the default profile (`docker compose down`).

## Graceful Shutdown

All processes handle `SIGTERM`/`SIGINT` and the Dockerfile sets
`STOPSIGNAL SIGTERM`, so `docker stop` / `docker compose stop` triggers a clean
shutdown (in-flight work completes, DB/Redis connections close) rather than a
hard kill. See [Graceful Shutdown](graceful-shutdown.md) for the implementation
pattern and per-process timeout configuration
(`WORKERS_SHUTDOWN_TIMEOUT_MS` in `.env.example`).

## Scaling the API / Matching Leader Lease

The API container is safe to run at more than one replica for HTTP
throughput, **but only one replica may match orders at a time.** Each API
process competes for a Redis-backed leader lease with a monotonic fencing
token (`src/matching/leader-lease.ts`); only the current holder hydrates
order books and accepts `POST /v1/orders`. See
[Architecture — Order placement](architecture.md#order-placement) for how
this fits into the request path.

- **Non-leader behavior**: instances that do not hold the lease still serve
  everything else normally (health/ready probes, market/position/fill reads,
  order cancellation) — only order _placement_ is gated. A non-leader
  returns `503` with error code `matching_unavailable` for `POST
/v1/orders`. This is expected and does not indicate an unhealthy pod; do
  not configure liveness/readiness probes to key off this response.
- **Failover time**: the lease TTL and heartbeat interval are configurable
  via `MATCHING_LEASE_TTL_MS` (default `15000`) and
  `MATCHING_LEASE_RENEW_INTERVAL_MS` (default `5000`). After the leader is
  killed ungracefully (crash, OOM), expect matching to be unavailable
  cluster-wide for up to `MATCHING_LEASE_TTL_MS` while the lease expires and
  a standby acquires it. A graceful shutdown (`SIGTERM`) releases the lease
  immediately so a standby can take over without waiting out the TTL.
- **Monitoring**: scrape `vatix_matching_leader` (gauge, 1 on the current
  holder / 0 everywhere else) and `vatix_matching_lease_renew_failures_total`
  (counter) from `GET /metrics` on every replica. Alert if:
  - No replica reports `vatix_matching_leader == 1` for longer than a couple
    of lease TTLs (matching is stuck unavailable cluster-wide).
  - More than one replica reports `vatix_matching_leader == 1`
    simultaneously (would indicate a fencing bug — treat as a production
    incident, not a metrics glitch).
  - A rising rate of `vatix_matching_lease_renew_failures_total` on the
    current holder (at risk of an imminent, possibly avoidable, handover).
- **Read replicas**: any replica may safely serve `GET` endpoints (markets,
  positions, fills, order book depth) regardless of lease status — those
  reads go through PostgreSQL/Redis cache, not the in-memory book, so they
  stay correct even on a non-leader. Only the _authoritative_ in-memory book
  used for matching is lease-gated; a non-leader proactively drops its
  in-memory books on lease loss rather than risk serving stale depth as
  authoritative.

## If Something Goes Wrong

See the [Incident Response Runbook](./runbooks/incident-runbook.md) for
service-specific triage steps (indexer lag, DB outages, RPC outages, etc.).

## References

- [Docker Compose Setup](docker-compose.md)
- [Migration Rollback Procedure](./migration-rollback.md)
- [Incident Response Runbook](./runbooks/incident-runbook.md)
- [Graceful Shutdown](graceful-shutdown.md)
- [Architecture Overview](architecture.md)
- [Metrics](metrics.md)
