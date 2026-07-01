# Indexer Module

## Purpose

Handles ledger/event ingestion and indexing.

## Responsibilities

- Consume blockchain or event streams
- Normalize and store data

## Notes

Must remain isolated from API request/response logic.

## Further reading

- [Ledger cursor](../../docs/indexer-ledger-cursor.md) — how the indexer tracks its position in the Stellar blockchain and recovers after restarts.
