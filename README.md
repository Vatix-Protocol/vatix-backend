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

Coming soon

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
