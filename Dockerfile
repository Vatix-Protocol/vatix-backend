# syntax=docker/dockerfile:1.7
#
# Multi-stage, multi-target Dockerfile for every Vatix backend process.
#
# This repo ships TypeScript that is executed directly via `tsx` (see
# package.json scripts) rather than a pre-bundled dist/. The "build" stage
# below installs dependencies and generates the Prisma client so the
# native query engine matches this image's OS/libc; the runtime stages
# copy that prepared app + a production-only node_modules and run the
# TypeScript entrypoint directly. See docs/docker-compose.md for usage and
# docs/architecture.md for service boundaries.
#
# Build a specific process with:
#   docker build --target api -t vatix-backend-api .
#   docker build --target indexer -t vatix-indexer .
#   docker build --target finalization-worker -t vatix-finalization-worker .
#   docker build --target oracle-worker -t vatix-oracle-worker .
#   docker build --target settlement-worker -t vatix-settlement-worker .

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------------------
# base — shared OS layer with pnpm enabled via corepack
#
# pnpm is pinned to the major the repo declares in `engines` (>=10) rather than
# floating to whatever corepack last saw. Without a pin, two builds of the same
# commit can install different pnpm releases and produce different images,
# which makes a supply-chain diff impossible to reason about. CI uses
# pnpm/action-setup with `version: 10`, so this keeps the image and CI aligned.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate
# The unprivileged `vatix` user is created once here so every stage that runs
# application code can drop root, not just `runtime`. The one-off `migrate` and
# `load-test` stages run app code too and were still root before this moved up
# (#1120). Build-time stages below intentionally stay root: `pnpm install` and
# `prisma generate` write into /app before any ownership is set.
RUN groupadd --system --gid 1001 vatix \
    && useradd --system --uid 1001 --gid vatix --no-create-home vatix

# ---------------------------------------------------------------------------
# deps — full install (including devDependencies) so the Prisma CLI is
# available to generate the client in the "build" stage below.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# prod-deps — production-only install for the runtime image. Keeps tooling
# (vitest, prettier, husky, the prisma CLI, etc.) out of shipped images.
#
# `prepare: husky install` runs on every install and fails here because husky is
# a devDependency that `--prod` deliberately omits — the build died with
# "husky: not found" before ever reaching the runtime stages. `HUSKY=0` does not
# help: husky's own guard never executes, because the shell cannot find the
# binary in the first place.
#
# So the install skips scripts and then rebuilds only the packages whose
# install scripts produce native binaries. `--ignore-scripts` on its own would
# ship a Prisma query engine and esbuild binary that were never fetched; the
# targeted `pnpm rebuild` keeps those working while leaving husky (and every
# other dev-only hook) out of the image.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts \
    && pnpm rebuild @prisma/engines @prisma/client prisma esbuild

# ---------------------------------------------------------------------------
# build — generate the Prisma client against the full source tree.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm prisma:generate

# ---------------------------------------------------------------------------
# migrate — one-off Prisma migration runner. Needs the full `deps` install
# (the Prisma CLI is a devDependency) and the generated client from "build".
# ---------------------------------------------------------------------------
FROM build AS migrate
# Migrations execute DDL against the live database, so this container runs
# unprivileged like every other one: a container escape during a migration must
# not start from uid 0. `migrate deploy` only reads prisma/schema.prisma and
# writes nothing into the image, so ownership of the copied tree is left as-is
# and only the schema is made readable by the runtime user.
RUN chown vatix:vatix /app/prisma /app/prisma/schema.prisma \
    && chown -R vatix:vatix /app/prisma/migrations
USER vatix
CMD ["pnpm", "prisma:deploy"]

# ---------------------------------------------------------------------------
# runtime — common runtime base: app source + generated Prisma client +
# production node_modules, running as a non-root user.
#
# apps/tsconfig.json is intentionally NOT copied: it is a dev/CI-only
# typecheck config (noEmit + allowImportingTsExtensions) and is not used
# by the tsx runtime entrypoints. Excluding it keeps the runtime image lean
# and avoids confusion between the typecheck config and runtime behavior.
# See: docs/architecture.md, #606.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# The `vatix` user is created in `base`; see the note there for why it is not
# re-created per-stage.
# Every COPY is --chown'd rather than fixing ownership afterwards with a
# recursive `chown`: a trailing `chown -R` writes a second full copy of the tree
# into a new layer, so the root-owned originals stay in the image history and
# the layer is twice the size. Copying with ownership set keeps a single layer
# and leaves no root-owned copy of the source or node_modules behind.
COPY --from=prod-deps --chown=vatix:vatix /app/node_modules ./node_modules
COPY --from=build --chown=vatix:vatix /app/package.json ./package.json
COPY --from=build --chown=vatix:vatix /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=vatix:vatix /app/src ./src
COPY --from=build --chown=vatix:vatix /app/packages ./packages
# Copy apps source but exclude the tsconfig (CI-only, not needed at runtime).
# We copy individual subdirectories so apps/tsconfig.json is never included.
COPY --from=build --chown=vatix:vatix /app/apps/indexer ./apps/indexer
COPY --from=build --chown=vatix:vatix /app/apps/oracle ./apps/oracle
COPY --from=build --chown=vatix:vatix /app/apps/workers ./apps/workers
COPY --from=build --chown=vatix:vatix /app/apps/api ./apps/api
USER vatix
# Docker/Kubernetes send SIGTERM to PID 1 on stop; entrypoints in every
# process register SIGTERM/SIGINT handlers (see docs/graceful-shutdown.md).
#
# PID 1 is deliberately the entrypoint itself and not a tini/dumb-init wrapper:
# the worker healthchecks in docker-compose.yml identify liveness by grepping
# /proc/1/cmdline for the entrypoint path, so an init shim in front of it would
# report every worker unhealthy. Node reaps its own children here, and the
# shutdown path relies on PID 1 receiving SIGTERM directly.
STOPSIGNAL SIGTERM

# ---------------------------------------------------------------------------
# api — HTTP API (Fastify), entrypoint src/index.ts
# ---------------------------------------------------------------------------
FROM runtime AS api
EXPOSE 3000
# Liveness for the one target with an HTTP surface. Probes the *liveness*
# route (/v1/health), never /v1/ready: readiness reflects dependency health,
# so failing this check on a Postgres blip would restart an otherwise healthy
# API and turn a degraded dependency into an outage.
#
# Uses node's own fetch rather than curl/wget, which the slim base image does
# not ship. Fails closed on any non-2xx, connection error, or timeout.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "const u='http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health';const c=new AbortController();const t=setTimeout(()=>c.abort(),4000);fetch(u,{signal:c.signal}).then(r=>{clearTimeout(t);process.exit(r.ok?0:1)}).catch(()=>{clearTimeout(t);process.exit(1)})"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]

# ---------------------------------------------------------------------------
# indexer — Stellar event indexer, entrypoint apps/indexer/src/main.ts
# ---------------------------------------------------------------------------
FROM runtime AS indexer
CMD ["node_modules/.bin/tsx", "apps/indexer/src/main.ts"]

# ---------------------------------------------------------------------------
# oracle — oracle poller, entrypoint apps/oracle/main.ts
# ---------------------------------------------------------------------------
FROM runtime AS oracle
CMD ["node_modules/.bin/tsx", "apps/oracle/main.ts"]

# ---------------------------------------------------------------------------
# finalization-worker — resolution finalization loop
# ---------------------------------------------------------------------------
FROM runtime AS finalization-worker
CMD ["node_modules/.bin/tsx", "apps/workers/src/finalization/main.ts"]

# ---------------------------------------------------------------------------
# oracle-worker — oracle submission queue consumer
# ---------------------------------------------------------------------------
FROM runtime AS oracle-worker
CMD ["node_modules/.bin/tsx", "apps/workers/src/oracle/main.ts"]

# ---------------------------------------------------------------------------
# settlement-worker — Redis-stream settlement queue consumer
# ---------------------------------------------------------------------------
FROM runtime AS settlement-worker
CMD ["node_modules/.bin/tsx", "apps/workers/src/settlement/consumer.ts"]

# ---------------------------------------------------------------------------
# load-test — one-off local order-placement load test (LOCAL ONLY; see the
# header in scripts/load-test-orders.ts and the load-testing section of
# docs/docker-compose.md).
#
# compose pointed this service at the `build` target, which declares no USER
# and so ran the load generator as root. This stage keeps the full `build`
# tree (tsx + the script, which `runtime` does not carry) and then drops root
# like every other code-executing target.
# ---------------------------------------------------------------------------
FROM build AS load-test
USER vatix
CMD ["node_modules/.bin/tsx", "scripts/load-test-orders.ts"]
