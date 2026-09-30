# Changelog

All notable changes to the Vatix Protocol monorepo are documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changelog discipline is enforced for every PR — see
[CONTRIBUTING.md](CONTRIBUTING.md#changelog-discipline) for what to log, when,
and in what format.

## [Unreleased]

### Added

- Indexer: Gap detector fixture tests in `apps/indexer/src/gap-detection.fixture.test.ts` covering cursor jumps, backfill re-fetching, idempotency, metrics increments, and fail-closed thresholds (#1199).
- pnpm workspace boundaries: every workspace package now has a `package.json` with a `name` field (`@vatix/api`, `@vatix/shared`, `@vatix/db`).
- Cross-package imports use package names (`@vatix/shared`) instead of relative paths to `packages/`.
- `tests/config/workspace-boundaries.test.ts` enforces workspace boundary rules in CI.
- `packages/shared/package.json` declares `exports` for all public modules.
- CONTRIBUTING.md, docs/architecture.md, docs/testing.md, and SECURITY.md updated with workspace boundary documentation.
- Indexer: `MarketCreated` event parsing in `apps/indexer/src/marketCreatedParser.ts`.
- Indexer: ingestion pipeline wiring in `apps/indexer/src/ingestion.ts`.
- Indexer: oracle resolution path in `apps/indexer/src/resolutionParser.ts`.
- Indexer: idempotency guard for concurrent/replayed ingestion in `apps/indexer/src/idempotency.ts`.
- Indexer: ops-safe metrics for money-path events in `apps/indexer/src/metrics.ts`.
- Backend: distinct liveness (`/health`) and readiness (`/ready`) probes with a
typed response contract and stable error codes (`OK`,
`DEPENDENCY_UNAVAILABLE`, `DEPENDENCY_TIMEOUT`).

### Changed

- Readiness now fails **closed** (`503`) when any critical dependency (DB,
  Redis, RPC) is unreachable, and treats unknown/unconfigured dependencies as
  unavailable (deny-by-default).

### Fixed

- Probe responses and logs no longer risk leaking connection strings,
  credentials, hostnames, or internal addresses; only dependency name and a
  coarse status are emitted.

### Security

- Readiness is deny-by-default so a misconfigured deploy fails closed rather
  than serving traffic.
- Probe outcomes are emitted as structured logs/metrics keyed by dependency
  name and status, with a correlation id for cross-referencing.

## [0.1.0] - 2024-01-01

### Added

- Initial monorepo scaffold for the Vatix Protocol (`vatix-backend` package
  focus).

[Unreleased]: https://github.com/vatix-protocol/vatix-protocol/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vatix-protocol/vatix-protocol/releases/tag/v0.1.0
