# Vatix Backend

Backend services for the Vatix prediction market protocol on Stellar.

## Tech Stack

Node.js • TypeScript • Fastify • PostgreSQL • Prisma • Redis • Stellar SDK

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 8+
- Docker & Docker Compose

### Setup

```bash
# Clone and install
git clone https://github.com/vatix-protocol/vatix-backend.git

cd vatix-backend
pnpm install

# Environment
cp .env.example .env

# Start services
docker compose up -d

# Database setup
pnpm prisma:generate
pnpm prisma:migrate dev

# Run
pnpm dev
```

Visit `http://localhost:3000/health` to verify.

## Development

```bash
# Development
pnpm dev              # Start with hot reload
pnpm build            # Build for production
pnpm start            # Start production build

# Testing
pnpm test             # Run all tests
pnpm test:ui          # Tests with UI
pnpm test:coverage    # Run tests with coverage
pnpm test:run         # Run tests once (no watch)

# Database
pnpm prisma:studio    # Database GUI
pnpm prisma:seed      # Load sample data
pnpm prisma:generate  # Generate Prisma client
pnpm prisma:migrate   # Create and apply migrations
pnpm prisma:deploy    # Deploy migrations (production)
pnpm prisma:validate  # Validate migrations
pnpm prisma:reset     # Reset database (destructive)

# Docker
docker compose up -d       # Start PostgreSQL + Redis
docker compose down        # Stop containers
```

## Project Map

| Module        | Directory                        | Purpose                                                     |
| ------------- | -------------------------------- | ----------------------------------------------------------- |
| **API**       | [`src/`](src/)                   | Fastify HTTP server, CLOB matching engine, middleware       |
| **Indexer**   | [`apps/indexer/`](apps/indexer/) | Polls Stellar for on-chain events and writes to PostgreSQL  |
| **Oracle**    | [`apps/oracle/`](apps/oracle/)   | Fetches external data, signs and submits resolution reports |
| **Workers**   | [`apps/workers/`](apps/workers/) | Queue consumers and scheduled jobs (settlement, expiry)     |
| **Shared DB** | [`packages/db/`](packages/db/)   | Shared Prisma client and migration utilities                |

See [docs/architecture.md](docs/architecture.md) for service boundaries and data flow.

## Project Structure

```
src/
├── api/          # REST endpoints & middleware
├── matching/     # CLOB order matching engine
├── services/     # Database, Redis, signing
└── types/        # TypeScript definitions

tests/
├── setup.ts              # Global test setup and utilities
├── helpers/
│   └── test-database.ts  # Database testing utilities
├── integration/
│   ├── markets.test.ts   # Markets endpoint tests
│   └── positions.test.ts # Positions endpoint tests
└── sample.test.ts        # Sample test demonstrating setup

prisma/
├── schema.prisma # Database schema
├── migrations/   # Database migrations
└── seed.ts       # Database seeding script

scripts/
├── validate-migrations.ts  # Migration validation script
└── generate-keypair.ts     # Stellar keypair generator

apps/
├── indexer/      # Stellar event indexer
├── oracle/       # External data oracle
└── workers/      # Queue consumers and scheduled jobs

docs/
├── testing.md    # Comprehensive testing guide
├── migrations.md # Database migration guide
└── runbooks/
    └── incident-runbook.md  # Incident response procedures
```

## Environment Variables

See `.env.example` for all options. Key variables:

- `DATABASE_URL` - PostgreSQL connection
- `REDIS_URL` - Redis connection
- `ORACLE_SECRET_KEY` - Oracle signing key (generate with `pnpm generate:keypair`)

## Testing

The project includes comprehensive testing setup with Vitest:

- **Unit Tests**: Fast isolated testing with mocks
- **Integration Tests**: API endpoint testing with real database
- **Coverage**: 80% threshold coverage reporting
- **CI Integration**: Automated testing in GitHub Actions

See [docs/testing.md](docs/testing.md) for detailed testing guide.

## Database Migrations

Database schema is managed through Prisma migrations:

- **Migration Tool**: Prisma (already aligned with project stack)
- **Commands**: Create, apply, rollback migrations documented
- **CI Integration**: Migration validation and deployment in CI
- **Validation**: Automated migration checks and SQL validation

See [docs/migrations.md](docs/migrations.md) for detailed migration guide.

## Operations & Incident Response

Comprehensive incident response procedures are documented for common backend issues:

- **Indexer Lag or Stall:** Detection, diagnosis, and recovery steps
- **RPC/Horizon Outage:** Failover procedures and impact mitigation
- **Database Incidents:** Connection issues, query performance, and recovery
- **Redis Failures:** Cache management and service restoration
- **Oracle Resolution Failures:** Manual resolution procedures

See [docs/runbooks/incident-runbook.md](docs/runbooks/incident-runbook.md) for the complete incident response runbook.

## API Endpoints

Key endpoints with comprehensive test coverage:

- `GET /v1/markets` - Market listing with pagination and filtering
- `GET /v1/positions/:wallet` - Wallet position data with PnL calculations

## License

MIT License

---

Part of the [Vatix Protocol](https://github.com/vatix-protocol)
