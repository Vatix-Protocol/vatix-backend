# Dead Letter Log Format Specification for SIEM

## Overview
Standardized JSON schema and structured logging format for dead letter queues (DLQ) to ensure predictable ingestion, alerting, and correlation across Security Information and Event Management (SIEM) systems.

## Schema Specification
- `timestamp`: ISO-8601 UTC timestamp
- `event_id`: Unique UUIDv4 identifier
- `service`: Originating service name
- `error_code`: Canonical failure classification
- `payload`: Sanitized failure context and metadata
- `retry_count`: Execution attempt threshold tracking

## Operational Runbook
1. Parse error envelope via SIEM log collector.
2. Filter by `error_code` severity threshold.
3. Trigger automated incident response workflows.
