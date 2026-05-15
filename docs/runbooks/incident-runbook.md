# Incident Response Runbook

This runbook provides step-by-step guidance for responding to common backend incidents in the Vatix Protocol.

**Last Updated:** 2026-04-28  
**Maintainer:** Backend Engineering Team  
**Review Cadence:** Monthly or after each major incident

---

## Table of Contents

- [Severity Classification](#severity-classification)
- [Escalation Procedures](#escalation-procedures)
- [Incident 1: Indexer Lag or Stall](#incident-1-indexer-lag-or-stall)
- [Incident 2: RPC/Horizon Outage](#incident-2-rpchorizon-outage)
- [Incident 3: Database Incident](#incident-3-database-incident)
- [Incident 4: Redis Failure](#incident-4-redis-failure)
- [Incident 5: Oracle Resolution Failure](#incident-5-oracle-resolution-failure)
- [Post-Incident Process](#post-incident-process)
- [Useful Commands & Queries](#useful-commands--queries)
- [Contact & Resources](#contact--resources)

---

## Severity Classification

| Severity | Impact | Response Time | Examples |
|----------|--------|---------------|----------|
| **SEV-1 (Critical)** | Complete service outage, data loss risk, or financial impact | Immediate (< 15 min) | DB down, indexer stopped > 10 min, oracle failure on active market resolution |
| **SEV-2 (High)** | Major feature degradation, partial outage | < 30 min | Indexer lag > 5 min, RPC intermittent failures, high API latency |
| **SEV-3 (Medium)** | Minor feature impairment, non-critical degradation | < 2 hours | Elevated error rates, slow queries, rate limiting issues |
| **SEV-4 (Low)** | Cosmetic issues, minor bugs, monitoring gaps | < 1 business day | Log formatting, non-critical alert misfires |

### Severity Decision Matrix

Ask these questions to classify:
1. **Is user data at risk?** → SEV-1
2. **Are markets unable to resolve?** → SEV-1
3. **Is the API completely down?** → SEV-1
4. **Are >50% of requests failing?** → SEV-2
5. **Is the indexer behind by >5 minutes?** → SEV-2
6. **Are specific endpoints degraded?** → SEV-3

---

## Escalation Procedures

### Immediate Response (All Severities)

1. **Acknowledge** the incident in your monitoring/alerting channel
2. **Assess** severity using the classification matrix above
3. **Declare** the incident with severity level
4. **Assemble** response team based on severity

### Escalation Matrix

| Severity | On-Call Engineer | Engineering Lead | CTO/VP Engineering | Communication |
|----------|------------------|------------------|-------------------|---------------|
| SEV-1 | Immediate | < 15 min | < 30 min | Status page update within 30 min |
| SEV-2 | < 30 min | < 1 hour | If unresolved > 2 hours | Internal team update |
| SEV-3 | < 2 hours | Next business day | If unresolved > 1 day | Team standup mention |
| SEV-4 | Next business day | As needed | Not required | Backlog item |

### Communication Templates

**Initial Incident Declaration:**
```
🚨 INCIDENT DECLARED - [SEV-X]
Service: Vatix Backend
Impact: [Brief description]
Started: [Time UTC]
Investigating: [Engineer name]
Next Update: [Time]
```

**Resolution Announcement:**
```
✅ INCIDENT RESOLVED - [SEV-X]
Service: Vatix Backend
Resolved: [Time UTC]
Duration: [X hours Y minutes]
Root Cause: [Brief summary]
Status: All systems operational
Post-Incident Review: [Scheduled/Not needed]
```

---

## Incident 1: Indexer Lag or Stall

### Symptoms
- Indexer ingestion loop not progressing
- `event_ingested` count not increasing
- Cursor checkpoint not updating
- Markets not appearing in database after on-chain creation
- Trade events missing from order history

### Detection
```sql
-- Check latest ingested event timestamp
SELECT MAX(source_at) as latest_event FROM events;

-- Check indexer cursor state
SELECT * FROM indexer_cursors WHERE cursor_key = 'ingestion';

-- Count events ingested in last hour
SELECT COUNT(*) FROM events 
WHERE source_at > NOW() - INTERVAL '1 hour';
```

### Response Steps

#### Step 1: Assess Current State
```bash
# Check indexer logs
docker logs vatix-indexer --tail 100 --follow

# Check if indexer process is running
docker ps | grep indexer

# Check cursor progression
docker exec -it vatix-postgres psql -U postgres -d vatix -c \
  "SELECT * FROM indexer_cursors WHERE cursor_key = 'ingestion';"
```

#### Step 2: Identify Root Cause

**A. RPC/Horizon Connectivity Issues**
```bash
# Test Horizon connectivity
curl -s https://horizon-testnet.stellar.org | jq .network

# Check indexer config
echo $INDEXER_INGESTION_INTERVAL_MS
echo $STELLAR_HORIZON_URL
```

**B. Database Connection Issues**
```bash
# Test DB connectivity
docker exec -it vatix-postgres pg_isready -U postgres

# Check connection pool status in logs
docker logs vatix-indexer 2>&1 | grep -i "connection\|pool\|error"
```

**C. Cursor Corruption or Invalid State**
```sql
-- Check cursor ledger sequence
SELECT cursor_key, ledger_sequence, updated_at 
FROM indexer_cursors 
WHERE cursor_key = 'ingestion';

-- Compare with current Horizon ledger
-- Visit: https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1
```

#### Step 3: Remediation

**A. Restart Indexer (First Attempt)**
```bash
# Graceful restart
docker restart vatix-indexer

# Monitor recovery
docker logs vatix-indexer --tail 50 --follow
```

**B. Reset Cursor (If Corrupted)**
```sql
-- WARNING: Only if cursor is stuck on invalid ledger
-- Get current ledger from Horizon first
UPDATE indexer_cursors 
SET ledger_sequence = [CURRENT_LEDGER - 100], 
    updated_at = NOW()
WHERE cursor_key = 'ingestion';
```

**C. Manual Event Backfill (If Gap Detected)**
```bash
# Run indexer in catch-up mode (if supported)
# Or manually trigger ingestion cycle
```

#### Step 4: Verification
```sql
-- Confirm events are flowing
SELECT COUNT(*) as events_last_5min 
FROM events 
WHERE source_at > NOW() - INTERVAL '5 minutes';

-- Verify cursor is advancing
SELECT * FROM indexer_cursors WHERE cursor_key = 'ingestion';

-- Check for recent market creations
SELECT * FROM markets ORDER BY created_at DESC LIMIT 5;
```

#### Step 5: Prevention
- [ ] Set up alerting on indexer lag > 2 minutes
- [ ] Monitor cursor checkpoint age
- [ ] Add Horizon health check to indexer loop
- [ ] Implement automatic cursor rollback on RPC errors

---

## Incident 2: RPC/Horizon Outage

### Symptoms
- Indexer fails to fetch ledger data
- Timeouts in event fetching
- `503` or `504` errors from Horizon
- Stale market data
- Oracle unable to verify on-chain state

### Detection
```bash
# Test Horizon endpoint
curl -v https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1

# Check response time
curl -w "@curl-format.txt" -o /dev/null -s https://horizon-testnet.stellar.org/

# Monitor indexer error logs
docker logs vatix-indexer 2>&1 | grep -i "timeout\|error\|503\|504"
```

### Response Steps

#### Step 1: Confirm Outage Scope
```bash
# Test multiple Horizon endpoints
curl -s https://horizon-testnet.stellar.org/ | jq .network
curl -s https://horizon-testnet.stellar.org/accounts?limit=1 | jq -r '._links.self.href'

# Check Stellar network status
# Visit: https://status.stellar.org/
# Check: https://stellarstatus.io/
```

#### Step 2: Assess Impact
- **Indexer:** Will stall until RPC recovers (safe, will resume)
- **API:** Can continue serving cached data
- **Oracle:** May be unable to resolve markets if dependent on live data
- **Trading:** Order matching continues (off-chain), but on-chain settlement delayed

#### Step 3: Mitigation

**A. Switch to Fallback RPC (If Available)**
```bash
# Update environment variable
export STELLAR_HORIZON_URL=https://horizon-fallback.stellar.org

# Restart indexer
docker restart vatix-indexer
```

**B. Enable Graceful Degradation**
```bash
# If supported, enable cached mode
export INDEXER_USE_CACHE=true

# Alert users of degraded service
# Update status page
```

**C. Pause Non-Critical Operations**
```bash
# Pause indexer if RPC completely down
# to prevent error log flooding
docker stop vatix-indexer

# Resume when RPC recovers
docker start vatix-indexer
```

#### Step 4: Monitor Recovery
```bash
# Continuously test RPC
watch -n 5 'curl -s https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1 | jq .[0].sequence'

# Monitor indexer recovery
docker logs vatix-indexer --tail 20 --follow
```

#### Step 5: Post-Recovery
```sql
-- Verify indexer caught up
SELECT 
  MAX(source_at) as latest_event,
  NOW() - MAX(source_at) as lag
FROM events;

-- Check for data gaps
SELECT 
  ledger_sequence,
  LAG(ledger_sequence) OVER (ORDER BY ledger_sequence) as prev_ledger,
  ledger_sequence - LAG(ledger_sequence) OVER (ORDER BY ledger_sequence) as gap
FROM events
ORDER BY ledger_sequence DESC
LIMIT 100;
```

#### Step 6: Prevention
- [ ] Configure multiple RPC endpoints with failover
- [ ] Implement circuit breaker pattern for RPC calls
- [ ] Add RPC health monitoring and alerting
- [ ] Set up Horizon status page webhook alerts

---

## Incident 3: Database Incident

### Symptoms
- Connection pool exhaustion
- Query timeouts (> 30s)
- Deadlocks detected
- High CPU/memory on PostgreSQL
- Prisma errors in application logs
- Failed migrations

### Detection
```bash
# Check PostgreSQL status
docker exec -it vatix-postgres pg_isready -U postgres

# Check container resource usage
docker stats vatix-postgres --no-stream

# Check PostgreSQL logs
docker logs vatix-postgres --tail 100
```

### Response Steps

#### Step 1: Assess Database Health
```sql
-- Check active connections
SELECT count(*) as active_connections, 
       state 
FROM pg_stat_activity 
GROUP BY state;

-- Check for long-running queries
SELECT 
  pid,
  now() - pg_stat_activity.query_start AS duration,
  query,
  state
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '30 seconds'
ORDER BY duration DESC;

-- Check table sizes
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check locks
SELECT 
  blocked_locks.pid AS blocked_pid,
  blocking_locks.pid AS blocking_pid,
  blocked_activity.query AS blocked_query,
  blocking_activity.query AS blocking_query
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

#### Step 2: Immediate Remediation

**A. Connection Pool Exhaustion**
```sql
-- Check pool status
SELECT count(*) FROM pg_stat_activity;

-- Kill idle connections if necessary
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle' 
  AND now() - query_start > interval '5 minutes'
  AND pid != pg_backend_pid();

-- Check application connection pool settings
# In .env: Ensure POOL_SIZE is appropriate
# Default Prisma pool: 5-10 connections
```

**B. Kill Blocking Queries**
```sql
-- Identify the blocking query (from Step 1)
-- Terminate if safe
SELECT pg_terminate_backend([BLOCKING_PID]);

-- WARNING: Only terminate if you understand the impact
-- Never terminate: migration processes, oracle resolution transactions
```

**C. Database Restart (Last Resort)**
```bash
# Graceful shutdown
docker stop vatix-postgres

# Wait for clean shutdown
docker logs vatix-postgres --tail 20

# Start database
docker start vatix-postgres

# Verify recovery
docker exec -it vatix-postgres pg_isready -U postgres

# Restart dependent services
docker restart vatix-backend
docker restart vatix-indexer
```

#### Step 3: Disk Space Issues
```bash
# Check disk usage
docker exec -it vatix-postgres df -h

# Check database size
docker exec -it vatix-postgres psql -U postgres -d vatix -c \
  "SELECT pg_size_pretty(pg_database_size('vatix'));"

# Clean up old data (if appropriate)
# WARNING: Only delete if you have backups and understand retention requirements
DELETE FROM events WHERE source_at < NOW() - INTERVAL '90 days';
VACUUM ANALYZE events;
```

#### Step 4: Corruption or Data Loss
```bash
# Check database integrity
docker exec -it vatix-postgres psql -U postgres -d vatix -c \
  "SELECT * FROM pg_stat_user_tables WHERE n_dead_tup > 0;"

# Restore from backup (if available)
# See: docs/migration-rollback.md
pg_restore -U postgres -d vatix backup_file.dump
```

#### Step 5: Verification
```sql
-- Test basic operations
SELECT COUNT(*) FROM markets;
SELECT COUNT(*) FROM events;
SELECT COUNT(*) FROM indexer_cursors;

-- Check query performance
EXPLAIN ANALYZE SELECT * FROM markets WHERE status = 'active' LIMIT 10;

-- Verify application connectivity
# Check backend logs for Prisma errors
docker logs vatix-backend --tail 50
```

#### Step 6: Prevention
- [ ] Set up connection pool monitoring and alerting
- [ ] Implement query performance monitoring
- [ ] Configure automated backups (daily minimum)
- [ ] Set up disk space alerts (>80% usage)
- [ ] Add dead tuple monitoring and auto-vacuum tuning
- [ ] Implement read replicas for heavy read workloads

---

## Incident 4: Redis Failure

### Symptoms
- Rate limiting not working
- Session/cache errors
- Redis connection timeouts
- `ECONNREFUSED` errors in logs

### Detection
```bash
# Check Redis status
docker exec -it vatix-redis redis-cli ping

# Check Redis logs
docker logs vatix-redis --tail 50

# Check memory usage
docker exec -it vatix-redis redis-cli INFO memory
```

### Response Steps

#### Step 1: Assess Redis Health
```bash
# Test connectivity
docker exec -it vatix-redis redis-cli ping
# Expected: PONG

# Check memory
docker exec -it vatix-redis redis-cli INFO memory | grep used_memory_human

# Check connected clients
docker exec -it vatix-redis redis-cli INFO clients
```

#### Step 2: Restart Redis
```bash
# Graceful restart
docker restart vatix-redis

# Verify recovery
docker exec -it vatix-redis redis-cli ping

# Monitor logs
docker logs vatix-redis --tail 20 --follow
```

#### Step 3: Clear Cache (If Corrupted)
```bash
# WARNING: This will clear all cached data including rate limits
docker exec -it vatix-redis redis-cli FLUSHALL

# Restart backend to reinitialize connections
docker restart vatix-backend
```

#### Step 4: Verify Recovery
```bash
# Test rate limiting
curl http://localhost:3000/v1/markets

# Check backend logs for Redis errors
docker logs vatix-backend 2>&1 | grep -i redis
```

#### Step 5: Prevention
- [ ] Monitor Redis memory usage (alert at >75%)
- [ ] Implement Redis persistence (RDB/AOF)
- [ ] Add connection retry logic in application
- [ ] Consider Redis Cluster for production

---

## Incident 5: Oracle Resolution Failure

### Symptoms
- Market resolution stuck in `challenged` state
- Oracle signing failures
- Resolution candidates not being processed
- Challenge window expiration without resolution

### Detection
```sql
-- Check markets in challenged state
SELECT 
  market_id,
  status,
  resolved_at,
  challenge_ends_at,
  NOW() - challenge_ends_at as time_since_challenge_end
FROM markets
WHERE status IN ('challenged', 'resolving')
ORDER BY challenge_ends_at ASC;

-- Check resolution candidates
SELECT 
  market_id,
  source_type,
  confidence_score,
  created_at
FROM resolution_candidates
ORDER BY created_at DESC
LIMIT 20;
```

### Response Steps

#### Step 1: Assess Oracle State
```bash
# Check oracle service logs
docker logs vatix-backend 2>&1 | grep -i oracle

# Verify oracle signing key is configured
echo $ORACLE_SECRET_KEY

# Test oracle endpoint (if available)
curl http://localhost:3000/v1/oracle/health
```

#### Step 2: Manual Resolution (If Automated Fails)
```sql
-- WARNING: Only use manual resolution as last resort
-- Requires admin access and proper authorization

-- Update market status
UPDATE markets
SET status = 'resolved',
    resolved_at = NOW(),
    outcome = '[YES/NO]'
WHERE market_id = '[MARKET_ID]';

-- Log the manual intervention
INSERT INTO audit_log (
  action, 
  entity_type, 
  entity_id, 
  performed_by, 
  notes
) VALUES (
  'MANUAL_RESOLUTION',
  'market',
  '[MARKET_ID]',
  '[ADMIN_ID]',
  'Manual resolution due to oracle failure. Incident: [INCIDENT-ID]'
);
```

#### Step 3: Verify Resolution
```sql
-- Confirm market status
SELECT market_id, status, resolved_at, outcome 
FROM markets 
WHERE market_id = '[MARKET_ID]';

-- Check positions are settled
SELECT COUNT(*) as unsettled_positions
FROM positions
WHERE market_id = '[MARKET_ID]' 
  AND status != 'settled';
```

#### Step 4: Prevention
- [ ] Implement oracle health monitoring
- [ ] Add fallback oracle providers
- [ ] Set up alerts for markets approaching challenge window expiry
- [ ] Implement automatic retry with exponential backoff
- [ ] Create manual resolution runbook with proper access controls

---

## Post-Incident Process

### Immediate (Within 24 Hours)

1. **Document Timeline**
   - When was the incident detected?
   - What was the root cause?
   - What actions were taken?
   - When was it resolved?

2. **Communicate Resolution**
   - Update status page
   - Notify affected users (if applicable)
   - Internal team debrief

3. **Preserve Evidence**
   - Save relevant logs
   - Export database state snapshots
   - Screenshot monitoring dashboards

### Post-Incident Review (Within 1 Week)

**For SEV-1 and SEV-2 incidents:**

1. **Schedule Review Meeting**
   - Include: On-call engineer, engineering lead, affected teams
   - Duration: 30-60 minutes

2. **Review Template**
   ```markdown
   # Post-Incident Review: [Incident Name]
   
   ## Summary
   - **Date:** [Date]
   - **Severity:** [SEV-X]
   - **Duration:** [X hours Y minutes]
   - **Impact:** [Description]
   
   ## Timeline
   - [Time] - Incident started
   - [Time] - Incident detected
   - [Time] - Response initiated
   - [Time] - Root cause identified
   - [Time] - Fix implemented
   - [Time] - Incident resolved
   
   ## Root Cause
   [Detailed explanation]
   
   ## What Went Well
   - [List]
   
   ## What Could Be Improved
   - [List]
   
   ## Action Items
   - [ ] [Action 1] - Owner: [Name] - Due: [Date]
   - [ ] [Action 2] - Owner: [Name] - Due: [Date]
   
   ## Lessons Learned
   [Key takeaways]
   ```

3. **Implement Improvements**
   - Update runbooks based on learnings
   - Add missing monitoring/alerts
   - Fix identified bugs or gaps
   - Improve automation

### Metrics to Track

- **MTTD:** Mean Time to Detect
- **MTTR:** Mean Time to Resolve
- **Incident Frequency:** By type and severity
- **Runbook Effectiveness:** How often runbooks helped vs. needed deviation

---

## Useful Commands & Queries

### Quick Health Checks
```bash
# All services running
docker ps

# Backend health endpoint
curl http://localhost:3000/health

# Database connectivity
docker exec -it vatix-postgres pg_isready -U postgres

# Redis connectivity
docker exec -it vatix-redis redis-cli ping

# Indexer status
docker logs vatix-indexer --tail 10
```

### Common Database Queries
```sql
-- Latest events
SELECT * FROM events ORDER BY source_at DESC LIMIT 10;

-- Active markets
SELECT COUNT(*) FROM markets WHERE status = 'active';

-- Indexer cursor
SELECT * FROM indexer_cursors;

-- Recent errors in audit log
SELECT * FROM audit_log 
WHERE action LIKE '%ERROR%' 
ORDER BY created_at DESC 
LIMIT 20;

-- Database size
SELECT pg_size_pretty(pg_database_size('vatix'));
```

### Log Analysis
```bash
# Search for errors in last hour
docker logs vatix-backend --since 1h 2>&1 | grep -i error

# Count error frequency
docker logs vatix-backend --since 1h 2>&1 | grep -c error

# Follow specific error pattern
docker logs vatix-backend -f 2>&1 | grep -i "timeout\|connection"

# Export logs for analysis
docker logs vatix-backend --since 2h > backend-logs-$(date +%Y%m%d-%H%M).txt
```

### Performance Diagnostics
```bash
# Check API response times
curl -w "DNS: %{time_namelookup}s\nConnect: %{time_connect}s\nTTFB: %{time_starttransfer}s\nTotal: %{time_total}s\n" \
  -o /dev/null -s http://localhost:3000/v1/markets

# Monitor resource usage
docker stats --no-stream

# Check database query performance
docker exec -it vatix-postgres psql -U postgres -d vatix -c \
  "SELECT * FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;"
```

---

## Contact & Resources

### Internal Contacts

| Role | Name | Contact | Availability |
|------|------|---------|--------------|
| On-Call Engineer | [Rotation] | Slack: #on-call | 24/7 |
| Backend Lead | [Name] | Slack/Email | Business hours + on-call |
| DevOps/SRE | [Name] | Slack/Email | Business hours + on-call |
| CTO | [Name] | Slack/Phone | SEV-1 only |

### External Resources

- **Stellar Network Status:** https://status.stellar.org/
- **Stellar Community Status:** https://stellarstatus.io/
- **PostgreSQL Documentation:** https://www.postgresql.org/docs/
- **Redis Documentation:** https://redis.io/docs/
- **Prisma Documentation:** https://www.prisma.io/docs/

### Monitoring & Alerting

- **Application Metrics:** [Grafana/Prometheus URL]
- **Log Aggregation:** [ELK/Datadog URL]
- **Error Tracking:** [Sentry URL]
- **Status Page:** [Status page URL]
- **Alert Manager:** [PagerDuty/OpsGenie URL]

### Documentation Links

- [Testing Guide](./testing.md)
- [Migration Guide](./migrations.md)
- [Migration Rollback](./migration-rollback.md)
- [Rate Limiting](./rate-limiting.md)
- [Deployment Runbook](./deployment-runbook.md)

---

## Runbook Maintenance

### Review Schedule
- **Monthly:** Review and update all incidents sections
- **After Each Incident:** Add new patterns, update steps based on learnings
- **Quarterly:** Full runbook audit and cleanup

### Update Process
1. Identify outdated or missing information
2. Update relevant sections
3. Test commands and queries in staging environment
4. Submit PR with changes
5. Get review from at least one team member
6. Merge and announce updates in team channel

### Version History

| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2026-04-28 | 1.0 | Initial runbook creation | Backend Team |

---

**Remember:** This runbook is a living document. Keep it updated, test the procedures regularly, and don't hesitate to improve it based on real incident experience.
