# Contributing to Vatix Backend

Thank you for your interest in contributing to Vatix! This guide will help you get started.

## Table of Contents

- [Getting Started](#getting-started)
- [Finding Issues to Work On](#finding-issues-to-work-on)
- [Development Workflow](#development-workflow)
- [Code Guidelines](#code-guidelines)
- [Testing Requirements](#testing-requirements)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Database Changes](#database-changes)
- [Getting Help](#getting-help)

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
```bash
   git clone https://github.com/YOUR_USERNAME/vatix-backend.git
   cd vatix-backend
```
3. **Set up the project** following the [README](README.md)
4. **Create a branch** for your work:
```bash
   git checkout -b feature/your-feature-name
```

## Finding Issues to Work On

Browse [open issues](https://github.com/vatix-protocol/vatix-backend/issues) and look for:

- **Complexity tags**: Easy, Medium, Hard
- **Labels**: `good first issue`, `help wanted`, `bug`, `feature`
- **Dependencies**: Check if the issue depends on others being completed first

**Before starting work:**
1. Comment on the issue saying you'd like to work on it
2. Wait for a maintainer to assign it to you
3. Ask questions if anything is unclear

## Development Workflow

### 1. Set Up Your Environment
```bash
# Install dependencies
pnpm install

# Start database and Redis
docker compose up -d

# Generate Prisma Client (if schema exists)
pnpm prisma:generate

# Run migrations (if migrations exist)
pnpm prisma:migrate

# Start dev server
pnpm dev
```

### 2. Make Your Changes

- Write clean, readable code
- Follow the existing code structure
- Add comments for complex logic
- Keep functions small and focused

### 3. Write Tests

**Every feature must include tests.** Add test files next to your implementation:
```
src/
├── services/
│   ├── database.ts
│   └── database.test.ts  ← Test file
```

Run tests frequently:
```bash
pnpm test
```

### 4. Commit Your Changes

Use clear, descriptive commit messages:
```bash
# Good commits
git commit -m "feat: add order validation logic"
git commit -m "fix: handle null values in position calculation"
git commit -m "test: add tests for order matching engine"

# Bad commits
git commit -m "update stuff"
git commit -m "fixes"
```

**Commit message format:**
- `feat:` - New feature
- `fix:` - Bug fix
- `test:` - Adding tests
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `chore:` - Maintenance tasks

## Code Guidelines

### TypeScript

- **Use strict typing** - Avoid `any`
- **Define interfaces** for function parameters and return values
- **Export types** from `src/types/index.ts` for reuse
```typescript
// Good
interface CreateOrderParams {
  marketId: string;
  side: OrderSide;
  price: number;
}

async function createOrder(params: CreateOrderParams): Promise<Order> {
  // ...
}

// Bad
async function createOrder(marketId: any, side: any, price: any): Promise<any> {
  // ...
}
```

### Code Style

- **Use meaningful variable names**
```typescript
  // Good
  const activeMarkets = await getActiveMarkets();
  
  // Bad
  const x = await getActiveMarkets();
```

- **Keep functions small** - One function should do one thing
- **Avoid deep nesting** - Extract nested logic into separate functions
- **Add comments for complex logic** - But prefer self-documenting code

### File Organization

- One main export per file
- Related functions in the same file
- Test files next to implementation files
- Group related functionality in directories
```
src/matching/
├── engine.ts          # Main matching engine
├── engine.test.ts     # Engine tests
├── orderbook.ts       # Order book data structure
├── orderbook.test.ts  # Order book tests
└── validation.ts      # Order validation
```

## Testing Requirements

### What to Test

1. **Happy paths** - Normal, expected behavior
2. **Edge cases** - Boundary conditions, empty inputs
3. **Error cases** - Invalid inputs, database errors
4. **Integration** - Multiple components working together

### Test Structure
```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('Order Validation', () => {
  beforeEach(() => {
    // Setup before each test
  });

  it('should accept valid orders', () => {
    const order = { price: 0.5, quantity: 100 };
    expect(validateOrder(order)).toBe(true);
  });

  it('should reject orders with invalid price', () => {
    const order = { price: 1.5, quantity: 100 };
    expect(() => validateOrder(order)).toThrow();
  });
});
```

### Running Tests
```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test src/matching/engine.test.ts

# Run with UI
pnpm test:ui

# Run with coverage
pnpm test:coverage
```

**All tests must pass before submitting a PR.**

## Submitting a Pull Request

### Before Submitting

- [ ] All tests pass (`pnpm test`)
- [ ] Code follows style guidelines
- [ ] Added tests for new functionality
- [ ] Updated documentation if needed
- [ ] No console.logs or debug code
- [ ] Prisma Client regenerated if schema changed (`pnpm prisma:generate`)

### PR Description Template
```markdown
## Description
Brief description of what this PR does

## Related Issue
Closes #123

## Changes Made
- Added order validation logic
- Created validation tests
- Updated error handling

## Testing
- [ ] Unit tests added
- [ ] Integration tests added
- [ ] Manual testing completed
```

### PR Process

1. **Push your branch** to your fork
2. **Create a Pull Request** on GitHub
3. **Link the related issue** in the PR description
4. **Wait for review** from maintainers
5. **Address feedback** if requested
6. **Merge** once approved!

## Database Changes

### Adding/Modifying Models

1. **Edit** `prisma/schema.prisma`:
```prisma
   model Market {
     id          String   @id @default(uuid())
     question    String
     endTime     DateTime
     status      MarketStatus
     // ... other fields
   }
```

2. **Create migration**:
```bash
   pnpm prisma:migrate dev --name add_market_table
```

3. **Generate Prisma Client**:
```bash
   pnpm prisma:generate
```

4. **Test the changes**:
```bash
   pnpm test
```

### Migration Best Practices

- Name migrations descriptively: `add_orders_table`, `add_status_index`
- Never edit existing migrations
- Test migrations with both `up` and `down`
- Include migration in your PR

## Getting Help

### Questions?

- **Comment on the issue** you're working on

### Stuck?

Don't spend hours stuck! Ask for help early:
1. Describe what you're trying to do
2. Share what you've tried
3. Include error messages
4. Provide code snippets

### Code Review Feedback

- Reviews help improve code quality
- Don't take feedback personally
- Ask questions if feedback is unclear
- Make requested changes promptly

## Recognition

Contributors are recognized in:
- GitHub contributor list
- Project README (for significant contributions)
- Release notes

Thank you for contributing to Vatix!