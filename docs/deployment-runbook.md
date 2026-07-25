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

## If Something Goes Wrong

See the [Incident Response Runbook](./runbooks/incident-runbook.md) for
service-specific triage steps (indexer lag, DB outages, RPC outages, etc.).

## References

- [Docker Compose Setup](docker-compose.md)
- [Migration Rollback Procedure](./migration-rollback.md)
- [Incident Response Runbook](./runbooks/incident-runbook.md)
- [Graceful Shutdown](graceful-shutdown.md)
- [Architecture Overview](architecture.md)
