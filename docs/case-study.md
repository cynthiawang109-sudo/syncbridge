# SyncBridge case study

SyncBridge models a SaaS integrations backend with a synthetic HR and payroll provider. The service supports multiple tenants and one provider adapter. The fault-recovery demo exercises the full path from authorization to drift repair.

## Delivery and recovery

The first review made the delivery contract explicit (R1/R2). A webhook acknowledgement confirms a DynamoDB receipt. BullMQ delivery can repeat, and PostgreSQL commits the mirror effect and operation outcome together. A worker can therefore die before acknowledging its lease and recover with the same durable effect.

The second review replaced unbounded recovery scans with indexed discovery and conditional lease claims (P0-02). The third and fourth reviews added terminal-only TTL, PostgreSQL-first dead-letter evidence, a unified due time, and an aged-event audit for delayed index visibility (N01/N02 and F01/F03/F06). The archive retains receipts. PostgreSQL owns retries, replay evidence, and mirror writes. [ADR-001](ADR-001-dynamodb-vs-pg-inbox.md) records the trade-off against a single PostgreSQL inbox and outbox.

## Refresh and stale writers

The refresh design evolved from a distributed lease to three phases (R4, P0-01, N03, F04). A short transaction claims the lease. The provider request runs outside the transaction. Another short transaction accepts a response only while the connection, token version, and lease generation still match. The provider can rotate after a local timeout or failed save. Ambiguous outcomes surface as `needs_reauth` and pause provider work.

Record versions order application (P1-05/P1-06). A newer version applies, an equal version with the same hash leaves the mirror stable, and an equal version with a different hash records a conflict. Older versions are stale. Webhooks fetch the current snapshot and retain both event and fetched versions. An explicit versioned delete writes a tombstone (F05). Closing a connection increments its generation and fences operations before revocation and cleanup (F02).

## Snapshot discipline

A cursor checkpoint advances with its page outcomes (P0-04 and N04). Reconciliation uses the same snapshot-token traversal (F07). An invalidated snapshot leaves provisional observations, and the worker can queue repairs only when a transaction confirms a completed traversal. Missing-local and stale findings use the shared version-conditional write and recheck connection generation inside the repair transaction. Remote absence and conflicts remain visible for human review.

The [demo transcript](hardening-demo.txt) records the crash, provider rate limit, replay, and safe-repair steps. The [README](../README.md) maps these claims to the integration suite and demo.
