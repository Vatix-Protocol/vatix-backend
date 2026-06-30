# Docker Compose Setup for Vatix Backend

This guide explains how to use Docker Compose to run the Vatix backend — either
just the data layer (for host-run development) or the fully containerized stack.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

## Services

| Service               | Profiles                                | Container name              | Notes                               |
| --------------------- | --------------------------------------- | --------------------------- | ----------------------------------- |
| `postgres`            | _(default)_                             | `vatix-postgres`            | PostgreSQL 16                       |
| `redis`               | _(default)_                             | `vatix-redis`               | Redis 7 — caching + job queues      |
| `api`                 | `app`, `api`                            | `vatix-backend`             | Fastify HTTP API, port 3000         |
| `indexer`             | `app`, `indexer`                        | `vatix-indexer`             | Stellar event indexer               |
| `finalization-worker` | `app`, `workers`, `finalization-worker` | `vatix-finalization-worker` | Resolution finalization loop        |
| `oracle-worker`       | `app`, `workers`, `oracle-worker`       | `vatix-oracle-worker`       | Oracle submission queue consumer    |
| `settlement-worker`   | `app`, `workers`, `settlement-worker`   | `vatix-settlement-worker`   | Trade settlement queue consumer     |
| `migrate`             | `tools`, `migrate`                      | `vatix-migrate`             | One-off `prisma migrate deploy` job |

Container names match the ones referenced in
[`docs/runbooks/incident-runbook.md`](runbooks/incident-runbook.md), so
commands like `docker logs vatix-indexer` work as documented there.

`postgres` and `redis` have no `profiles:` entry, so they always start by
default — this preserves the original host-run development workflow below.
Every application process lives behind a profile so you opt in explicitly.

## Option A — Data layer only (host-run development)

This is the original workflow: run infra in containers, run the app processes
on the host with `tsx`.

1. **Clone the repository and install dependencies:**

   ```bash
   git clone https://github.com/vatix-protocol/vatix-backend.git
   cd vatix-backend
   pnpm install
   ```

2. **Copy environment variables:**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` if needed (see `.env.example` for details).

3. **Start the data layer:**

   ```bash
   docker compose up -d
   ```

   This starts PostgreSQL (on port 5433) and Redis (on port 6379). No app
   profile is requested, so only `postgres` and `redis` come up.

4. **Initialize the database:**

   ```bash
   pnpm prisma:generate
   pnpm prisma:migrate dev
   ```

5. **Run the backend processes on the host:**

   ```bash
   pnpm dev                          # API
   pnpm indexer:dev                  # Indexer
   pnpm workers:finalization:dev     # Finalization worker
   pnpm workers:oracle:dev           # Oracle worker
   ```

## Option B — Full containerized stack

Build and run every process as a container, using the `Dockerfile` at the repo
root, which defines one build `--target` per process.

1. **Copy environment variables** (same as above):

   ```bash
   cp .env.example .env
   ```

2. **Run database migrations** before starting the app processes for the
   first time:

   ```bash
   docker compose --profile migrate up --build migrate
   ```

3. **Start everything:**

   ```bash
   docker compose --profile app up -d --build
   ```

   This builds and starts `postgres`, `redis`, `api`, `indexer`,
   `finalization-worker`, and `oracle-worker`.

   To run a subset, use the matching profile instead of `app`, e.g.:

   ```bash
   docker compose --profile api up -d --build      # postgres + redis + api only
   docker compose --profile workers up -d --build  # postgres + redis + both workers
   ```

Inside the compose network, app containers reach Postgres/Redis via the
service DNS names `postgres` and `redis` (not the host-mapped `localhost:5433`
/ `localhost:6379` from `.env.example`) — `docker-compose.yml` overrides
`DATABASE_URL` and `REDIS_URL` per service for this reason. Every other
variable (API keys, Stellar config, log levels, etc.) is read from your local
`.env` via `env_file`.

## Stopping Services

```bash
docker compose --profile app down   # stop infra + app containers
docker compose down                 # stop infra only
```

Add `-v` to also remove the `postgres_data` / `redis_data` volumes.

## Useful Commands

- View running containers:
  ```bash
  docker compose ps
  ```
- View logs for a specific process:
  ```bash
  docker compose logs -f api
  docker logs vatix-indexer --tail 100 --follow
  ```
- Rebuild a single service after a code change:
  ```bash
  docker compose --profile app up -d --build api
  ```

## Graceful shutdown

Every process registers `SIGINT`/`SIGTERM` handlers (see
[Graceful Shutdown](graceful-shutdown.md)), and the Dockerfile sets
`STOPSIGNAL SIGTERM`, so `docker compose stop` / `docker stop <container>`
triggers the same clean shutdown path used for `Ctrl+C` in local development.

---

For more details, see the main [README.md](../README.md) and
[Deployment Runbook](deployment-runbook.md).
