# Oracle Signing Key Rotation Without Downtime

## Overview

This guide explains how to rotate oracle signing keys without interrupting market operations. The strategy maintains continuous signing capability while transitioning to new keys.

## Prerequisites

- Access to deployment infrastructure and secrets management
- New Stellar keypair generated and tested
- Current oracle worker process stable and healthy
- Monitoring/alerting systems operational

## Step 1: Generate and Test New Key

1. **Generate new keypair** (off-chain in secure environment):

```bash
# Using Stellar SDK (TypeScript example)
import { Keypair } from "@stellar/stellar-sdk";
const newKeypair = Keypair.random();
console.log("Public Key:", newKeypair.publicKey());
console.log("Secret Key:", newKeypair.secret());  // Keep secure!
```

2. **Test the new key** in a staging environment:

```bash
# Deploy staging worker with new ORACLE_SECRET_KEY
export ORACLE_SECRET_KEY="S..." # new secret key
pnpm workers:oracle:start

# Verify it signs correctly
# Check logs for successful signatures
```

## Step 2: Deploy New Key in Parallel

1. **Update deployment configuration** with new key (keep old key accessible):

```bash
# Store new key in secrets manager (AWS Secrets Manager, Vault, etc.)
aws secretsmanager update-secret \
  --secret-id vatix/oracle-keys \
  --secret-string '{"current":"S...","next":"S..."}'
```

2. **Deploy new worker instances** with new key:

```bash
# Do NOT immediately restart all workers
# Instead, do a canary deployment:
# - Deploy 1 worker with new key
# - Monitor for 5-10 minutes
# - Check: signature validity, submission success rate, latency
```

3. **Gradually roll out** new key to remaining workers:

```bash
# Rolling deployment (e.g., every 5 minutes)
for worker in worker-1 worker-2 worker-3; do
  kubectl set env deployment/$worker ORACLE_SECRET_KEY="S..." # new key
  kubectl rollout status deployment/$worker
  sleep 300  # wait 5 minutes before next worker
done
```

## Step 3: Update On-Chain References

1. **Register new public key** with on-chain contract (if required):

```bash
# Submit transaction to authorize new oracle address
# Exact mechanism depends on your contract design
# May require multi-sig approval or timelock
```

2. **Verify authorization** before retiring old key:

```bash
# Check contract state to confirm new key is authorized
# Ensure old key remains valid during transition
```

## Step 4: Monitor During Transition

### Key Metrics to Watch

1. **Submission Success Rate**:
   - Should remain >99%
   - Alert if drops below 98%

```bash
# Query recent submissions
SELECT 
  status,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / (
    SELECT COUNT(*) FROM oracle_reports 
    WHERE created_at > now() - interval '1 hour'
  ), 2) as percentage
FROM oracle_reports
WHERE created_at > now() - interval '1 hour'
GROUP BY status
ORDER BY count DESC;
```

2. **Submission Latency**:
   - Tail latency should not increase
   - P95 < 30 seconds recommended

```bash
# Query latency percentiles
SELECT
  percentile_cont(0.5) WITHIN GROUP (ORDER BY (created_at - enqueued_at)) as p50_latency,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (created_at - enqueued_at)) as p95_latency,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY (created_at - enqueued_at)) as p99_latency
FROM oracle_reports
WHERE created_at > now() - interval '1 hour';
```

3. **Error Types**:
   - Monitor dead-lettered messages
   - Check for signature verification failures

```bash
# Check dead-letter queue
redis-cli -u $REDIS_URL XRANGE oracle:dead-letter - +
```

### Log Monitoring

Watch for:
- Signature verification errors: `Invalid signature`
- Key loading errors: `ORACLE_SECRET_KEY not found`
- Submission failures: `submission processing failed`

## Step 5: Retire Old Key (After Stable Period)

1. **Wait for stable period**: 
   - Minimum 24-48 hours with new key in production
   - Zero errors related to signing
   - Confirm no in-flight submissions using old key

2. **Remove old key from secrets**:

```bash
# Update secrets to only contain new key
aws secretsmanager update-secret \
  --secret-id vatix/oracle-keys \
  --secret-string '{"current":"S..."}'
```

3. **Remove old key from on-chain authorization** (if supported):

```bash
# Submit revocation transaction if contract supports key removal
# Ensure new key is sole authorized oracle address
```

4. **Verify old key removal**:

```bash
# Confirm no workers reference old key
kubectl get pods -o jsonpath='{.items[*].spec.containers[*].env[?(@.name=="ORACLE_SECRET_KEY")].value}' | tr ' ' '\n' | sort -u
```

## Rollback Procedure

If issues occur during rotation:

1. **Immediate Action** (first 5 minutes):
   - Revert new key deployment
   - Resume using old key

```bash
# Rollback workers to old key
kubectl rollout undo deployment/oracle-workers
```

2. **Post-Incident**:
   - Investigate what went wrong
   - Check logs for error patterns
   - Test in staging again before retry

3. **Minimal Impact During Rollback**:
   - In-flight submissions continue with current key
   - Brief spike in latency expected (few seconds)
   - No market downtime (oracle is auxiliary)

## Troubleshooting

### Signature Verification Failures

```
ERROR: Submission verification failed
```

**Cause**: Worker still using old key or key mismatch  
**Fix**:
1. Verify ORACLE_SECRET_KEY is correctly set
2. Restart worker: `kubectl rollout restart deployment/oracle-workers`
3. Check logs: `kubectl logs -f deployment/oracle-workers`

### Workers Not Starting After Key Update

```
ERROR: ORACLE_SECRET_KEY not found in environment variables
```

**Cause**: Secrets not properly propagated  
**Fix**:
1. Verify secret exists: `aws secretsmanager get-secret-value --secret-id vatix/oracle-keys`
2. Check environment variable binding: `kubectl describe pod <pod-name>`
3. Restart with manual key injection: `export ORACLE_SECRET_KEY=... && pnpm workers:oracle:start`

### Submission Latency Spike

**Investigation**:
1. Check Redis queue depth: `redis-cli -u $REDIS_URL XINFO STREAM oracle:submissions`
2. Check worker logs: `kubectl logs -f deployment/oracle-workers`
3. Check consumer lag: `redis-cli -u $REDIS_URL XINFO GROUPS oracle:submissions`

**Resolution**:
- Scale workers if queue is backing up
- Check for network connectivity issues
- Verify on-chain contract is responsive

## Key Rotation Schedule

### Recommended Frequency

- **Security critical**: Every 90 days (or after suspected compromise)
- **Routine rotation**: Every 6-12 months
- **Post-incident**: Immediately after security event

### Planning

1. Schedule rotation during low-traffic period (e.g., weekend)
2. Ensure full team availability for monitoring
3. Pre-stage staging environment with new key
4. Prepare rollback procedures
5. Brief on-call team on changes
