# Trading Orders API

A REST API for submitting trading orders in a prediction market system. The system handles order validation, matching, database persistence, and Redis caching to provide a complete order management solution.

## Project Structure

```
src/
├── api/
│   └── routes/           # Fastify route handlers
│       ├── index.ts      # Route registration
│       └── orders.ts     # Orders endpoint
├── interfaces/           # Service interfaces
│   └── services.ts       # All service interface definitions
├── types/               # TypeScript type definitions
│   ├── models.ts        # Core data models
│   └── requests.ts      # Request/response types
├── test/                # Test utilities
│   ├── setup.ts         # Jest configuration
│   └── generators.ts    # Property-based test generators
└── index.ts             # Application entry point

prisma/
└── schema.prisma        # Database schema definition
```

## Core Components

### Data Models

- **Order**: Trading order with price, quantity, and status
- **Trade**: Executed trade between two orders
- **Position**: User position in a market outcome
- **Market**: Prediction market with multiple outcomes
- **OrderBook**: Current buy/sell orders for a market

### Service Interfaces

- **OrderController**: Main orchestrator for order submission
- **OrderValidator**: Validates orders against business rules
- **MatchingEngine**: Matches orders and generates trades
- **OrderBookCache**: Redis-based order book management
- **DatabaseManager**: Prisma-based database operations
- **PositionManager**: Calculates and updates user positions
- **SigningService**: Generates cryptographic receipts
- **AuthHandler**: Handles authentication and user extraction

## API Endpoints

### POST /orders

Submit a new trading order.

**Request Body:**

```json
{
  "marketId": "string",
  "side": "buy" | "sell",
  "outcome": "string",
  "price": number (optional for market orders),
  "quantity": number
}
```

**Headers:**

- `x-user-address`: User's address for authentication

**Response:**

```json
{
  "success": boolean,
  "orderId": "string",
  "receipt": {
    "orderId": "string",
    "timestamp": "ISO date",
    "orderDetails": {...},
    "trades": [...],
    "signature": "string",
    "publicKey": "string"
  },
  "trades": [...]
}
```

## Development Setup

1. Install dependencies:

```bash
npm install
```

2. Set up environment variables:

```bash
cp .env.example .env
# Edit .env with your configuration
```

3. Set up database:

```bash
npx prisma generate
npx prisma migrate dev
```

4. Run tests:

```bash
npm test
```

5. Start development server:

```bash
npm run dev
```

## Testing

The project uses a dual testing approach:

### Unit Tests

- Test specific examples and edge cases
- Located alongside source files with `.test.ts` suffix
- Use Jest testing framework

### Property-Based Tests

- Test universal properties across randomized inputs
- Use fast-check library for property testing
- Minimum 100 iterations per property test
- Validate correctness properties from design document

### Test Commands

```bash
npm test              # Run all tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Generate coverage report
```

## Architecture

The system follows a layered architecture:

1. **API Layer**: HTTP request/response handling, authentication
2. **Business Logic Layer**: Order validation, matching logic
3. **Data Layer**: Database operations, cache management
4. **External Services**: Signing service for receipts

All operations are wrapped in database transactions to ensure atomicity and consistency.

## Requirements Traceability

This implementation satisfies the following requirements:

- 1.1, 2.1, 4.1, 5.1: Core interfaces and project structure
- Additional requirements will be implemented in subsequent tasks

## Next Steps

1. Implement authentication middleware (Task 2)
2. Implement order validation logic (Task 3)
3. Implement Redis order book cache (Task 4)
4. Continue with remaining components as per implementation plan
