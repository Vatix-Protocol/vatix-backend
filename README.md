# Vatix Backend

Backend services for the Vatix prediction market protocol on Stellar.

## Overview

This repository contains the core backend infrastructure for Vatix, including:

- **REST API**: Market data, user positions, and trade history
- **CLOB Engine**: Central Limit Order Book for order matching
- **Event Indexer**: Blockchain event monitoring and database indexing
- **Oracle Service**: Real-world outcome resolution
- **WebSocket Server**: Real-time market updates

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **API Framework**: Fastify
- **Database**: PostgreSQL with Prisma ORM
- **Cache**: Redis (ioredis)
- **Blockchain**: Stellar SDK
- **Testing**: Vitest

## Project Status

🚧 **Early Stage** - Core infrastructure in progress. We're actively looking for contributors!

## Getting Started

### Prerequisites
- Node.js 18+ (20+ recommended)
- pnpm 8+ (`npm install -g pnpm`)
- Docker & Docker Compose

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/vatix-protocol/vatix-backend.git
cd vatix-backend
```

2. **Install dependencies**
```bash
pnpm install
```

3. **Set up environment variables**
```bash
cp .env.example .env
# The defaults should work for local development
```

4. **Start local services (PostgreSQL + Redis)**
```bash
docker compose up -d
```

5. **Set up the database**
```bash
# Generate Prisma Client
pnpm prisma:generate

# Run migrations 
pnpm prisma:migrate dev
```

6. **Run development server**
```bash
pnpm dev
```

The API will be available at `http://localhost:3000`

### Verify Setup

Visit `http://localhost:3000/health` - you should see:
```json
{"status":"ok","service":"vatix-backend"}
```

## Project Structure
```
src/
├── api/              # Fastify REST endpoints and routes
│   ├── routes/       # API route handlers
│   └── middleware/   # Request/response middleware
├── matching/         # CLOB engine - order matching logic
├── indexer/          # Stellar blockchain event listener
├── oracle/           # Market resolution service
├── services/         # Shared utilities (database, cache, signing)
└── types/            # TypeScript type definitions

prisma/
├── schema.prisma     # Database schema definition
├── migrations/       # Database migrations
└── seed.ts          # Sample data for testing

tests/               # Test files
```

## Development

### Available Scripts
```bash
# Development
pnpm dev              # Start dev server with hot reload
pnpm build            # Build for production
pnpm start            # Run production build

# Database
pnpm prisma:generate  # Generate Prisma Client
pnpm prisma:migrate   # Run database migrations
pnpm prisma:studio    # Open Prisma Studio (database GUI)
pnpm prisma:seed      # Seed database with sample data

# Testing
pnpm test             # Run tests
pnpm test:ui          # Run tests with UI
pnpm test:coverage    # Run tests with coverage report

# Docker
docker compose up -d       # Start PostgreSQL + Redis
docker compose down        # Stop and remove containers
docker compose logs -f     # View container logs
```

### Making Changes

1. **Database changes**: Edit `prisma/schema.prisma` and run migrations
2. **API changes**: Add/modify routes in `src/api/routes/`
3. **Business logic**: Add services in `src/services/` or matching logic in `src/matching/`
4. **Always add tests**: Every feature should have corresponding tests

## Architecture Overview

### Data Flow
```
User Request
    ↓
Fastify API (validation, auth)
    ↓
Business Logic (matching engine, services)
    ↓
Prisma Client ←→ PostgreSQL
    ↓
Response
```

### Key Components

**CLOB Engine** (`src/matching/`)
- Order book data structure
- Price-time priority matching
- Partial fill logic
- Position-based accounting

**API Layer** (`src/api/`)
- RESTful endpoints
- WebSocket connections
- Authentication/authorization
- Request validation

**Services** (`src/services/`)
- Database queries (Prisma)
- Redis caching
- Stellar blockchain interaction
- Oracle data fetching
- Cryptographic signing

**Indexer** (`src/indexer/`)
- Listen for Stellar contract events
- Index on-chain data
- Update database state

## Database Schema

The database uses Prisma ORM with PostgreSQL. Key tables:

- **markets**: Prediction market metadata
- **orders**: User orders in the CLOB
- **user_positions**: User positions with position-based accounting

See `prisma/schema.prisma` for the complete schema definition.

## Testing

We use Vitest for testing. Tests should cover:

- Unit tests for business logic
- Integration tests for API endpoints
- Database tests for Prisma models
- E2E tests for critical flows

Run tests before submitting PRs:
```bash
pnpm test
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:
- How to pick an issue
- Code style guidelines
- PR submission process
- Testing requirements

## API Documentation

API documentation will be available at `/docs` once implemented. For now, see the route files in `src/api/routes/` for endpoint definitions.

## Environment Variables

Key environment variables (see `.env.example`):
```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/vatix

# Redis
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Oracle
ORACLE_SECRET_KEY=your_secret_key_here
```

## Troubleshooting

**"Port 5433 already in use"**
- Another PostgreSQL instance is running
- Change the port in `docker-compose.yml` and update `DATABASE_URL`

**"Cannot connect to database"**
- Ensure Docker containers are running: `docker compose ps`
- Check DATABASE_URL matches your Docker setup

**"Prisma Client not generated"**
- Run `pnpm prisma:generate`
- Ensure `prisma/schema.prisma` exists

**"Module not found"**
- Delete `node_modules` and `pnpm-lock.yaml`
- Run `pnpm install` again

## Resources

- [Vatix Protocol Specification](https://github.com/vatix-protocol/vatix-docs)
- [Stellar Documentation](https://developers.stellar.org)
- [Prisma Documentation](https://www.prisma.io/docs)
- [Fastify Documentation](https://www.fastify.io/docs)

## License

MIT License - see [LICENSE](LICENSE) for details

---

Part of the [Vatix Protocol](https://github.com/vatix-protocol)