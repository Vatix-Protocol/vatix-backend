# Vatix Backend

Backend services for the Vatix prediction market protocol on Stellar.

## Overview

This repository contains the core backend infrastructure for Vatix, including:

- **REST API**: Market data, user positions, and trade history
- **Event Indexer**: Blockchain event monitoring and database indexing
- **Oracle Service**: Real-world outcome resolution
- **WebSocket Server**: Real-time market updates

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **API Framework**: Fastify
- **Database**: PostgreSQL
- **Blockchain**: Stellar SDK
- **Real-time**: Socket.io

## Project Status

🚧 **Early Stage** - Architecture and initial setup in progress

## Planned Features

- RESTful API for market queries
- Blockchain event indexing
- Real-time price feeds
- Oracle integration for market resolution
- User portfolio tracking

## Getting Started

### Prerequisites
- Node.js 18+ (20+ recommended)
- pnpm 8+ (`npm install -g pnpm`)
- Docker & Docker Compose

### Installation

1. Clone the repository
```bash
git clone https://github.com/vatix-protocol/vatix-backend.git
cd vatix-backend
```

2. Install dependencies
```bash
pnpm install
```

3. Set up environment variables
```bash
cp .env.example .env
```

4. Start local services (PostgreSQL + Redis)
```bash
docker compose up -d
```

5. Run development server
```bash
pnpm dev
```

The API will be available at `http://localhost:3000`

## Architecture
```
Backend Services
├── API Layer (REST + WebSockets)
├── Indexer (Blockchain → Database)
├── Oracle (Outcome Resolution)
└── Database (PostgreSQL)
```

## Contributing

Contribution guidelines coming soon. For now, check out [vatix-docs](https://github.com/vatix-protocol/vatix-docs) for project information.

## License

MIT License