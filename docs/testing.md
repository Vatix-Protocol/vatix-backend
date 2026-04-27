# Testing Guide

This document provides comprehensive instructions for running and writing tests in the vatix-backend project.

## Overview

The vatix-backend uses **Vitest** as the testing framework, which provides fast unit testing with excellent TypeScript support and built-in coverage reporting.

## Test Structure

```
tests/
├── setup.ts                 # Global test setup and utilities
├── helpers/
│   └── test-database.ts     # Database testing utilities
├── integration/
│   ├── markets.test.ts      # Markets endpoint integration tests
│   └── positions.test.ts    # Positions endpoint integration tests
└── sample.test.ts           # Sample test demonstrating setup
```

## Test Types

### Unit Tests
- Test individual functions and components in isolation
- Use mocks for external dependencies
- Fast execution, suitable for TDD

### Integration Tests
- Test API endpoints with real database
- Use test database with deterministic fixtures
- Slower but more comprehensive testing

## Running Tests

### Basic Commands

```bash
# Run all tests
npm test
# or
pnpm test

# Run tests in watch mode
npm run dev
# or
pnpm dev

# Run tests once (no watch)
npm run test:run
# or
pnpm test:run

# Run tests with coverage
npm run test:coverage
# or
pnpm test:coverage

# Run tests with UI
npm run test:ui
# or
pnpm test:ui
```

### Running Specific Tests

```bash
# Run specific test file
npm test markets.test.ts

# Run tests matching pattern
npm test -- --grep "markets"

# Run tests in specific directory
npm test tests/integration/
```

## Test Configuration

The test configuration is in `vitest.config.ts`:

- **Environment**: Node.js
- **Pool**: Forks (for proper process isolation)
- **Coverage**: V8 provider with 80% thresholds
- **Setup**: Global setup file for test utilities
- **Timeouts**: 30s test timeout, 10s hook timeout

## Database Testing

### Test Database Setup

Tests use a dedicated test database with automatic cleanup:

```typescript
import { testUtils } from "../setup.js";

// Create test data
const market = await testUtils.createTestMarket();
const position = await testUtils.createTestPosition(market.id, wallet);
```

### Database Utilities

- `testUtils.createTestMarket()` - Create test market
- `testUtils.createTestPosition()` - Create test position  
- `testUtils.createTestOrder()` - Create test order
- `testUtils.generateStellarAddress()` - Generate valid address
- `testUtils.assertDecimalEqual()` - Fixed-precision assertions

### Test Isolation

- Database is cleaned before each test
- Advisory locks serialize database tests
- Each test gets fresh data

## Writing Tests

### Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { testUtils } from "../setup.js";

describe("Feature Name", () => {
  beforeEach(async () => {
    // Setup before each test
  });

  afterEach(async () => {
    // Cleanup after each test
  });

  it("should do something", async () => {
    // Arrange
    const testData = await testUtils.createTestMarket();

    // Act
    const result = await someFunction(testData.id);

    // Assert
    expect(result).toBeDefined();
    expect(result.status).toBe("ACTIVE");
  });
});
```

### Best Practices

1. **Use descriptive test names** - "should return 400 for invalid input"
2. **Follow AAA pattern** - Arrange, Act, Assert
3. **Test one thing per test** - Single assertion per test when possible
4. **Use helpers for setup** - Leverage `testUtils` for common operations
5. **Mock external services** - Use mocks for third-party APIs
6. **Test edge cases** - Empty data, invalid inputs, error conditions

### Integration Tests

For API endpoint testing:

```typescript
import Fastify from "fastify";
import { describe, it, expect } from "vitest";

describe("API Endpoint", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(routes);
  });

  afterAll(async () => {
    await app.close();
  });

  it("should return correct response", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/endpoint",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("data");
  });
});
```

## Coverage

### Coverage Configuration

Coverage is configured with 80% thresholds for:
- Branches
- Functions  
- Lines
- Statements

### Viewing Coverage Reports

```bash
# Generate coverage report
npm run test:coverage

# View HTML report (opens in browser)
open coverage/index.html
```

### Coverage Exclusions

The following are excluded from coverage:
- Test files (`**/*.test.ts`, `**/*.spec.ts`)
- Test directories (`tests/`)
- Scripts (`scripts/`)
- Coverage reports (`coverage/`)

## Test Data Management

### Deterministic Fixtures

Tests use deterministic fixtures for stable outcomes:

```typescript
// Generate consistent test data
const testWallet = testUtils.generateStellarAddress("GTEST");
const testMarket = await testUtils.createTestMarket({
  question: "Predictable test question",
  endTime: new Date("2026-12-31T23:59:59Z"),
});
```

### Data Cleanup

Database is automatically cleaned between tests:

```typescript
// Automatic cleanup in beforeEach
beforeEach(async () => {
  await cleanDatabase();
});
```

## Mock Testing

### Mocking Dependencies

```typescript
import { vi } from "vitest";

// Mock entire module
vi.mock("../../services/prisma.js", () => ({
  getPrismaClient: () => mockPrismaClient,
}));

// Mock specific function
const mockFunction = vi.fn();
vi.mock("../../module", () => ({
  functionName: mockFunction,
}));
```

### Mock Assertions

```typescript
// Verify mock was called
expect(mockFunction).toHaveBeenCalled();
expect(mockFunction).toHaveBeenCalledWith(expectedArgs);

// Clear mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});
```

## Performance Testing

### Test Performance

Vitest provides built-in performance tracking:

```typescript
import { bench } from "vitest";

bench("function performance", () => {
  // Function to benchmark
  expensiveFunction();
});
```

## Continuous Integration

### CI Test Configuration

Tests run in CI with:

```yaml
# From .github/workflows/ci.yml
- name: Run tests
  run: pnpm test
  env:
    DATABASE_URL: postgresql://postgres:postgres@localhost:5432/vatix
    REDIS_URL: redis://localhost:6379
    NODE_ENV: test

- name: Run tests with coverage
  run: pnpm test:coverage
  env:
    DATABASE_URL: postgresql://postgres:postgres@localhost:5432/vatix
    REDIS_URL: redis://localhost:6379
    NODE_ENV: test
```

### Coverage Upload

Coverage reports are automatically uploaded to Codecov.

## Troubleshooting

### Common Issues

1. **Database connection errors**
   - Check `DATABASE_URL` environment variable
   - Ensure PostgreSQL is running
   - Verify test database exists

2. **Test timeouts**
   - Increase timeout in `vitest.config.ts`
   - Check for infinite loops or hanging promises

3. **Mock issues**
   - Clear mocks in `beforeEach`
   - Verify mock configuration
   - Check module path resolution

4. **Coverage issues**
   - Check exclusion patterns
   - Verify thresholds are realistic
   - Ensure all code paths are tested

### Debugging Tests

```bash
# Run tests with debugger
node --inspect-brk node_modules/.bin/vitest

# Run specific test with logging
DEBUG=* npm test -- specific-test.test.ts
```

## Best Practices Summary

1. **Write tests first** (TDD when possible)
2. **Keep tests fast** - Use mocks for external dependencies
3. **Test edge cases** - Don't just test happy paths
4. **Use descriptive names** - Test should document behavior
5. **Maintain test independence** - Tests shouldn't depend on each other
6. **Review coverage reports** - Aim for meaningful coverage, not just metrics
7. **Update tests with code** - Keep tests in sync with implementation
