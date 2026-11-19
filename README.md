# SyncBridge

SyncBridge is a **multi-tenant, single-provider adapter demo** for a fictional SaaS integrations service. The in-repo mock provider uses synthetic employee and payrun data. The provider interface is designed so a second adapter is additive.

A tenant connects through OAuth with S256 PKCE. Full and incremental syncs checkpoint each page in PostgreSQL. Signed webhooks are acknowledged after DynamoDB archives the encrypted receipt. A sweeper recovers missed work and BullMQ transports jobs. PostgreSQL owns retry timing, versioned mirror writes, and durable dead-letter evidence. Delivery is at least once, with effectively-once persistent effects. The archive and mirror have separate responsibilities, and cross-store recovery uses compensation. See the [case study](docs/case-study.md) and [ADR-001](docs/ADR-001-dynamodb-vs-pg-inbox.md).

## Run and verify

Use Docker Compose v2 and Node.js 22.12 or newer. Run from the repository root with the local demo credentials, or supply matching `JWT_SECRET`, `ENVELOPE_KEY` (base64-encoded 32 bytes), and `WEBHOOK_KEY` settings to Compose and the scripts.

```sh
docker compose up --build -d --wait
npm ci
npm run generate
npm test
npm run lint
node scripts/demo-hardening.mjs
```

Compose exposes the API on loopback port 4300, the mock provider on 4301, PostgreSQL on 45432, Redis on 46379, and DynamoDB Local on 4800. Tests and the demo use these real dependencies. The demo uses a dedicated local stack because it kills and restarts the worker. It makes no calls to external providers. See the [verified demo transcript](docs/hardening-demo.txt).

## API and operator workflow

- `POST /connections/:id/sync` accepts `mode` (`full` or `incremental`) and `resourceType` (`employees` or `payruns`).
- `POST /webhooks/:id` authenticates the epoch-millisecond timestamp, a period, and the exact body bytes. Accepted and duplicate deliveries return 202. Malformed events return 400, invalid or expired authentication 401, bodies above 256 KiB 413, and signed deliveries to closing connections 410. `WEBHOOK_PREVIOUS_KEY` remains valid until `WEBHOOK_PREVIOUS_UNTIL` in epoch milliseconds.
- `POST /dead-letters/:entryId/replay` requires an operator. Terminal archive receipts have a 30-day TTL. The replay window is 90 days and uses PostgreSQL evidence when the receipt is absent. `POST /connections/:id/resume` clears an operator-visible poison-message pause.
- `POST /connections/:id/reconciliation` accepts `resourceType` and requires an operator. The worker also schedules one traversal per eligible connection and resource each hour. Read the report at `GET /connections/:id/reconciliation/:runId`. Reports classify missing-local, missing-remote, stale, and conflicted rows. A completed snapshot confirms findings. Only confirmed missing-local and stale findings queue repairs. Partial findings are provisional. Remote absence and conflicts are reported for review.
- Authenticated `GET /metrics` returns tenant-scoped status for operators and viewers. The current and preceding 59 minutes provide queue-lag and completed sync-duration samples, observed request counts and 429 rate, and refresh errors. The response also includes persisted retry counts and current unresolved DLQ depth.

## Traceability

| Claim                                                                                                | Named test or demo step                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Clean Compose startup, migrations, and real-dependency verification                                  | T17 phase gate and the Hardening transcript                                                                                      |
| Tenant-scoped JWT authorization, operator actions, and read-only viewers                             | T19 JWT and mirror access, T07/T21 replay denials, T08 report authorization                                                      |
| S256 PKCE, encrypted tokens, distributed refresh fencing, and ambiguous rotation handling            | OAuth lifecycle, envelope ciphertext round-trip, T03, T12, T22, T26                                                              |
| Both resources support full and incremental sync with durable page checkpoints                       | T05 page recovery, shared payrun pipeline, Hardening demo initial sync                                                           |
| Raw signed ingress, rotation window, body cap, encrypted receipts, and log redaction                 | T09/T16 raw authentication and leak scan                                                                                         |
| Archive-first delivery, rebuildable BullMQ, fenced recovery, and stable effects                      | T01/T02/T10/T11/T18/T23 archive and crash recovery, Hardening worker-kill step                                                   |
| Versions and fetched snapshots drive application, conflict reporting, and explicit tombstones        | T04/T20 fetched versions and T27 delete branch                                                                                   |
| PostgreSQL drives bounded retries, provider 429 delays, and poison pause                             | T06 provider classification, both Retry-After formats, poison pause/resume, T28 restart checks, Hardening two-response 429 burst |
| Audited DLQ replay works after archive expiry with a separate replay window                          | T07/T21 replay race and authorization, T25 absent archive and replay expiry, Hardening replay audit                              |
| Closing generations fence in-flight writes and cleanup is verified twice                             | T24 offboarding race and Hardening generation-change repair test                                                                 |
| Scheduled and manual reconciliation classifies drift and repairs only safe confirmed findings        | T08 confirmed drift, T29 invalidated snapshot, scheduled reconciliation test, Hardening silent mutation step                     |
| Tenant-scoped operational metrics expose lag, duration, retries, 429s, refresh errors, and DLQ depth | Scheduled reconciliation and metrics test, refresh lifecycle cases, Hardening 429 and DLQ verification                           |
