# ADR-001 DynamoDB archive versus a PostgreSQL inbox/outbox

**Status** Accepted in SPEC v2.3. The archive enters the implementation in MVP-B.

## Context

SyncBridge needs durable receipt, event-ID deduplication, recovery when dispatch fails, and bounded recovery queries. The raw delivery and the PostgreSQL mirror have different retention and processing responsibilities. The mirror is the source of record for the service's persistent effects.

## Decision

Use a DynamoDB webhook archive with a conditional insert on the connection and event ID. Retain the envelope-encrypted raw delivery. Discover due pending and expired leased items using bounded status-index queries and claim against the primary item using a conditional update. Audit aged non-terminal items to cover delayed or missed index discovery. Set TTL only on terminal items.

Keep versioned mirror writes and outcomes in PostgreSQL transactions. Use PostgreSQL for retry authority and durable replay evidence. BullMQ transports jobs that can be rebuilt. The archive records receipt and projects processing state.

## Trade-offs

A PostgreSQL inbox and outbox could keep receipt, deduplication, retry state, and dispatch intent in one database. That would reduce the number of failure boundaries and the operational burden. DynamoDB makes conditional event deduplication and indexed recovery modeling explicit, which is a goal of this project.

The stores have no shared transaction. A successful archive insert followed by a failed enqueue requires redispatch. A PostgreSQL commit followed by a failed archive status update requires redelivery and idempotent effects. If the dead-letter transaction commits first, recovery attaches the durable PostgreSQL reference to the archive item. Replay can proceed from PostgreSQL after the archive item expires. Each path needs fault-injection coverage and an observable recovery signal.
