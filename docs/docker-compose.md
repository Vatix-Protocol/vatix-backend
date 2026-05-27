# Docker Compose Setup for Vatix Backend

This guide explains how to use Docker Compose to set up the required services for the Vatix backend.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

## Services

- **PostgreSQL** (database)
- **Redis** (cache)

## Setup Steps

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

3. **Start Docker services:**

   ```bash
   docker compose up -d
   ```
   This will start PostgreSQL (on port 5433) and Redis (on port 6379).

4. **Initialize the database:**

   ```bash
   pnpm prisma:generate
   pnpm prisma:migrate dev
   ```

5. **Run the backend:**

   ```bash
   pnpm dev
   ```

## Stopping Services

To stop and remove containers:

```bash
docker compose down
```

## Useful Commands

- View running containers:
  ```bash
  docker compose ps
  ```
- View logs:
  ```bash
  docker compose logs
  ```
- Stop services:
  ```bash
  docker compose down
  ```

---

For more details, see the main [README.md](../README.md).
