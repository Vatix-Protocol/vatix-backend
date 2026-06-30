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
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
WORKDIR /app
RUN corepack enable

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
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

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
RUN groupadd --system --gid 1001 vatix \
    && useradd --system --uid 1001 --gid vatix --no-create-home vatix
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=build /app/packages ./packages
# Copy apps source but exclude the tsconfig (CI-only, not needed at runtime).
# We copy individual subdirectories so apps/tsconfig.json is never included.
COPY --from=build /app/apps/indexer ./apps/indexer
COPY --from=build /app/apps/oracle ./apps/oracle
COPY --from=build /app/apps/workers ./apps/workers
COPY --from=build /app/apps/api ./apps/api
RUN chown -R vatix:vatix /app
USER vatix
# Docker/Kubernetes send SIGTERM to PID 1 on stop; entrypoints in every
# process register SIGTERM/SIGINT handlers (see docs/graceful-shutdown.md).
STOPSIGNAL SIGTERM

# ---------------------------------------------------------------------------
# api — HTTP API (Fastify), entrypoint src/index.ts
# ---------------------------------------------------------------------------
FROM runtime AS api
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/index.ts"]

# ---------------------------------------------------------------------------
# indexer — Stellar event indexer, entrypoint apps/indexer/src/main.ts
# ---------------------------------------------------------------------------
FROM runtime AS indexer
CMD ["node_modules/.bin/tsx", "apps/indexer/src/main.ts"]

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
