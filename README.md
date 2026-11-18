# SyncBridge

SyncBridge is a multi-tenant, single-provider adapter demo for a fictional SaaS integrations service. The in-repo mock provider is a test instrument with synthetic employee data. The provider interface is designed so a second adapter is additive.

MVP-A connects a tenant to the mock provider over OAuth with S256 PKCE. It mirrors employees through manual full and incremental syncs. PostgreSQL stores the mirror, page checkpoints, and retry attempts. BullMQ and Redis carry rebuildable page jobs. Processing is at least once, with effectively-once persistent effects.

## Run locally

Use Docker Compose v2 and Node.js 22.12 or newer. From the repository root, run:

```sh
docker compose up --build -d --wait
npm ci
npm run generate
```

Compose starts PostgreSQL, Redis, the NestJS API, the BullMQ worker, and the Fastify mock provider. The API applies Prisma migrations before it starts. The API and mock provider listen on loopback ports 4300 and 4301. PostgreSQL is available on loopback port 45432 for the integration suite. Compose supplies public demo-only signing and encryption fixtures. To use your own values, set `JWT_SECRET` and a base64-encoded 32-byte `ENVELOPE_KEY` in the environment used by Compose and the local scripts.

## Demo and verification

```sh
npm run demo
npm run demo:recovery
npm test
npm run lint
```

- `demo` provisions a tenant and connection using a signed mock JWT, follows the OAuth redirect, runs a full employee sync, and verifies all five mirror IDs and versions after three pages.
- `demo:recovery` injects a one-shot 503 on page two. It checks that page one and its two outcomes remain durable, then verifies that the same run completes with five mirror records and five outcomes.
- The Compose integration suite verifies tenant isolation and JWT rejection, envelope encryption at rest, proactive refresh and the single 401 retry, concurrent refresh and stale-holder fencing, ambiguous rotation and reauthorization, persisted delays with both `Retry-After` formats, snapshot expiry, and incremental sync.

## Architecture decision

The archive and mirror have different responsibilities. The archive retains received deliveries for recovery. PostgreSQL records business state and persistent effects. The planned stores converge through compensating steps without a cross-store transaction. [ADR-001](docs/ADR-001-dynamodb-vs-pg-inbox.md)
