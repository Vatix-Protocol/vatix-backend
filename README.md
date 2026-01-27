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
pnpm test             # Run tests
pnpm test:ui          # Tests with UI

# Database
pnpm prisma:studio    # Database GUI
pnpm prisma:seed      # Load sample data

# Docker
docker compose up -d       # Start PostgreSQL + Redis
docker compose down        # Stop containers
```

## Project Structure

```
src/
├── api/          # REST endpoints & middleware
├── matching/     # CLOB order matching engine
├── services/     # Database, Redis, signing
└── types/        # TypeScript definitions

prisma/
├── schema.prisma # Database schema
└── migrations/   # Database migrations
```

## Environment Variables

See `.env.example` for all options. Key variables:

- `DATABASE_URL` - PostgreSQL connection
- `REDIS_URL` - Redis connection
- `ORACLE_SECRET_KEY` - Oracle signing key (generate with `pnpm generate:keypair`)

## License

MIT License

---

Part of the [Vatix Protocol](https://github.com/vatix-protocol)
