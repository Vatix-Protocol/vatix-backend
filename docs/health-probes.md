# Health Probes: Liveness vs Readiness

This document outlines the design and configuration of health check probes for the Vatix backend.

## Overview

We expose two main endpoints to monitor the state of the API server:

1. **Liveness Probe** (`GET /v1/health`)
   - **Goal:** Determine if the application process is running and responding to HTTP requests.
   - **Behavior:** Returns `200 OK` (with state `ok` or `degraded`). It performs lightweight checks like DB reachability, but if the database is down it returns `degraded` with status `200` to prevent Kubernetes from restarting a healthy API container during temporary DB network blips.
   - **Action on Failure:** Container restart.

2. **Readiness Probe** (`GET /v1/ready`)
   - **Goal:** Determine if the application is fully capable of serving user traffic.
   - **Behavior:** Returns `200 OK` if the database is reachable and the index freshness is under the staleness threshold. Returns `503 Service Unavailable` if the database is unreachable or the indexer has stalled.
   - **Action on Failure:** Stop routing traffic to the container (remove it from the load balancer pool). Do **not** restart the container.

### Workers Health Probes

Worker processes serve their own health server (`apps/workers/src/health-server.ts`,
started via `startHealthServer(logger, port)`, port from `WORKERS_HEALTH_PORT`)
exposing `GET /live` and `GET /ready`, checked independently of the API's
`/v1/health` and `/v1/ready`. **Do not point a worker's liveness probe at the
API's `/v1/health`** — that reports the API process's state, not the
worker's, and a wedged worker with a healthy API will never be restarted.

#### Workers Liveness Probe (`GET /live`)

- **Goal:** Determine if the worker process itself is running and its event loop is responsive.
- **Behavior:** Always returns `200 OK` with `live: true`. Performs **no** dependency checks (no DB, no Redis) — liveness must be independent of downstream services, or a transient Redis/DB blip causes k8s to restart worker pods, which can drop in-flight settlement/oracle jobs mid-processing.
- **Action on Failure:** Container restart.

#### Workers Readiness Probe (`GET /ready`)

- **Goal:** Determine if a queue consumer worker is able to reach its dependencies — Postgres and Redis (the queue/stream backend the consumer reads from). A worker that can't reach Redis can't consume or dead-letter jobs, so it should stop receiving traffic/orchestration signals even while the process itself is alive.
- **Behavior:** Runs `SELECT 1` against Postgres and `redis.healthCheck()` (a `PING`) against Redis. Returns `200 OK` with `ready: true` only when both succeed. Returns `503 Service Unavailable` with `ready: false` if either dependency fails, with the failing dependency's `status` set to `"error"` and an `error` message attached.
- **Response shape:**
  ```json
  {
    "ready": true,
    "service": "vatix-workers",
    "timestamp": "2026-07-28T00:00:00.000Z",
    "dependencies": {
      "database": { "status": "ok" },
      "redis": { "status": "ok" }
    }
  }
  ```
- **Action on Failure:** Stop routing traffic/orchestration signals to the worker (remove it from its pool). Do **not** restart the container — a Redis outage is external and restarting won't fix it.

Both routes echo an `x-request-id` response header (from the request header if supplied, otherwise a generated id) so readiness failures can be correlated with worker logs; failures are logged via `request.log.warn` with the request id and dependency error messages only — never connection strings or credentials.

#### Kubernetes example (workers)

```yaml
livenessProbe:
  httpGet:
    path: /live
    port: $WORKERS_HEALTH_PORT
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet:
    path: /ready
    port: $WORKERS_HEALTH_PORT
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 3
```

---

## Configuration Reference

### Kubernetes

In your Kubernetes Deployment manifest, configure the container probes as follows:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vatix-backend
spec:
  template:
    spec:
      containers:
        - name: vatix-backend
          image: vatix-backend:latest
          ports:
            - containerPort: 3000
          livenessProbe:
            httpGet:
              path: /v1/health
              port: 3000
            initialDelaySeconds: 15
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /v1/ready
              port: 3000
            initialDelaySeconds: 20
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
```

### Docker Compose

In a Docker Compose environment, you can configure a healthcheck using the liveness endpoint:

```yaml
services:
  api:
    image: vatix-backend:latest
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/v1/health"]
      interval: 10s
      timeout: 2s
      retries: 3
      start_period: 15s
```
