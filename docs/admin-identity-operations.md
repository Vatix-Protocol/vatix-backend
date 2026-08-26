# Admin Identity Operations Runbook

Admin credentials are managed via the `AdminIdentity` database model, replacing the previous single shared `ADMIN_TOKEN` approach. Each admin identity is independently revocable, rotatable, and auditable.

## Overview

- **AdminIdentity**: Per-admin credentials stored in the database with bcrypt-hashed credentials.
- **AdminIdentityAuditLog**: Durable audit trail recording all identity operations (create, rotate, revoke).
- **Credential format**: `identity_name:credential` (e.g., `alice:secret123`).
- **Bearer token**: `Authorization: Bearer alice:secret123`.

## Provisioning a New Admin Identity

Use the `AdminIdentityService` to create a new identity programmatically:

```typescript
import { getPrismaClient } from "src/services/prisma";
import { AdminIdentityService } from "src/services/admin-identity";

const prisma = getPrismaClient();
const service = new AdminIdentityService(prisma);

await service.createIdentity(
  "alice",
  "generate-strong-random-credential-here",
  "provisioning-system"
);
```

Alternatively, directly insert into the database (ensure credential is bcrypt hashed):

```sql
INSERT INTO admin_identities (
  id, name, credential_hash, active, created_at
)
VALUES (
  gen_random_uuid(),
  'alice',
  '$2b$12$...',  -- bcrypt hash of credential
  true,
  now()
);
```

## Rotating an Admin's Credential

When an admin's credential is suspected compromised or rotated on schedule:

```typescript
const service = new AdminIdentityService(prisma);
await service.rotateCredential(
  "alice",
  "new-strong-random-credential",
  "admin:bob"  // Actor performing the rotation
);
```

The old credential becomes invalid immediately; the new credential takes effect.

## Revoking an Admin Identity

Revoke an identity if an admin is offboarded or their credentials are compromised:

```typescript
const service = new AdminIdentityService(prisma);
await service.revokeIdentity(
  "alice",
  "admin:bob",
  "Offboarding per company policy"
);
```

Revoked identities cannot authenticate, even if the credential is correct.

## Production Behavior

In `NODE_ENV=production`:
- The identity store must be configured and reachable.
- A missing or empty identity store causes immediate authentication failure (fail-closed).
- No silent fallback to the deprecated `ADMIN_TOKEN` variable.

## Auditing Admin Actions

Query the audit log to review all admin identity operations:

```sql
SELECT * FROM admin_identity_audit_logs
ORDER BY created_at DESC
LIMIT 10;
```

Each log entry records:
- **action**: CREATE | ROTATE | REVOKE
- **actor**: Who performed the action (system name or admin identity)
- **reason**: Optional justification (e.g., offboarding reason)
- **created_at**: When the action occurred

## Migration from Static ADMIN_TOKEN

If you have a legacy `ADMIN_TOKEN` environment variable:

1. Create admin identities for each admin using the provisioning steps above.
2. Distribute new credentials (in `identity_name:credential` format) to each admin via secure channels.
3. Remove or deprecate the `ADMIN_TOKEN` environment variable.
4. Verify all admins can authenticate with their new identities.

## Break-Glass Access

Break-glass operations (halt, cancel-all, resume) remain protected by dual-control via `AdminApprovalToken`, not by admin identity credentials. Break-glass requires:

1. First admin initiates the action (any authenticated admin).
2. A second admin approves within a 15-minute window using the generated approval token.

This is an explicit, audited path separate from ordinary rotatable admin identities.

## Example: Testing Admin Auth Locally

In development, provision a test admin:

```bash
# Start the API in development mode
npm run dev

# In another terminal, create a test identity via Prisma Studio or migration script
# Or use a test fixture that calls AdminIdentityService.createIdentity
```

Then authenticate requests:

```bash
curl -H "Authorization: Bearer alice:secret123" \
     http://localhost:3000/admin/markets
```
