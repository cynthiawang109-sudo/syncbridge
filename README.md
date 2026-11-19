# SyncBridge

SyncBridge is a multi-tenant, single-provider adapter demo for a fictional SaaS integrations service. The in-repo mock provider is a test instrument with synthetic employee and payrun data. The provider interface is designed so a second adapter is additive.

The service connects tenants over S256 PKCE OAuth and mirrors employees and payruns through full and incremental syncs and signed webhooks. PostgreSQL stores mirror writes, outcomes, retry attempts, and dead-letter evidence. DynamoDB retains encrypted webhook receipts. BullMQ and Redis carry rebuildable jobs. Processing is at least once, with effectively-once persistent effects.

## Run locally

Use Docker Compose v2 and Node.js 22.12 or newer. Run from the repository root.

```sh
docker compose up --build -d --wait
npm ci
npm run generate
npm test
```

The NestJS API applies Prisma migrations and initializes the DynamoDB table before becoming ready. The API and mock provider listen on loopback ports 4300 and 4301. PostgreSQL, Redis, and DynamoDB Local listen on loopback ports 45432, 46379, and 4800 for integration tests. Compose supplies public local fixtures for signing and encryption. The environment accepts `JWT_SECRET`, a base64-encoded 32-byte `ENVELOPE_KEY`, and `WEBHOOK_KEY`. A previous webhook key verifies until the epoch-millisecond time in `WEBHOOK_PREVIOUS_UNTIL` when `WEBHOOK_PREVIOUS_KEY` is set.

## Demos

```sh
npm run demo
npm run demo:recovery
npm run demo:mvp-b
npm run lint
```

- `demo` connects to the mock provider and verifies all five employee IDs and versions after three pages.
- `demo:recovery` injects a 503 on page two, verifies that the checkpoint holds at page one, and verifies the same run completes.
- `demo:mvp-b` syncs employees and payruns, delivers duplicate and out-of-order webhooks, kills the local worker during a provider fetch, restarts it and waits for lease recovery, then replays a dead letter as an operator. Run it against a dedicated local Compose stack.
- The integration suite verifies tenant and role authorization, OAuth rotation and ambiguous failures, retry timing, archive encryption and TTL, fetched-version ordering and deletes, DLQ replay and audit, and lifecycle fencing during offboarding.

The API accepts signed JSON webhooks at `POST /webhooks/:connectionId`. It returns 202 for accepted and duplicate receipts, 400 for a malformed event, 401 for invalid or stale authentication, 413 above 256 KiB, and 410 after closing starts. The HMAC input is the epoch-millisecond timestamp, a period, and the exact body bytes. Operators can inspect archive status with `GET /webhooks/:connectionId/events/:eventId`. Operators can queue a replay with `POST /dead-letters/:entryId/replay` within 90 days. Terminal archive events retain a 30-day TTL. A poison-message pause is visible on the connection and can be cleared by its operator via `POST /connections/:connectionId/resume`.

## Architecture decision

The archive retains received deliveries for recovery. PostgreSQL records business state and persistent effects. The stores converge through compensating steps without a cross-store transaction. [ADR-001](docs/ADR-001-dynamodb-vs-pg-inbox.md)
