# SyncBridge — Codex Kickoff

**Read this file, then execute ONLY the "MVP-A" section below. Stop and report when MVP-A is done. Do not start MVP-B or Hardening.**

## What this project is

SyncBridge is a multi-tenant TypeScript/NestJS integrations service (portfolio project). The full frozen design lives in `SPEC.md` in this repo root — **SPEC v2.3, frozen 2026-11-18**. Read it before writing code. Its Core design sections are the normative contract; if anything in this kickoff appears to conflict with SPEC.md, SPEC.md wins and you should flag the conflict in your report.

Key invariants you must not dilute (all defined precisely in SPEC.md):

- At-least-once processing, effectively-once persistent effects. Never claim exactly-once anywhere.
- Token refresh is three-phase: short-tx lease claim (lease generation increment) → provider call outside any transaction → short-tx version-CAS save. One in-flight refresh per connection, bounded timeout, lease revalidated before and after the call. Ambiguous rotation outcome → observable `needs_reauth`, never a retry loop.
- Mirror writes use the version-conditional UPSERT with exactly three paths (greater applies; equal + same hash no-ops; equal + different hash records a conflict; lower is dropped as stale), committed in one PG transaction with the outcome row.
- Tenant identity comes only from verified JWT claims; workers take tenant from the database row, never from job payloads.
- Mock data is 100% synthetic. No real personal data, no real secrets anywhere (dev keys come from environment).

## Repo layout (create as needed)

- `apps/api` — NestJS HTTP app.
- `apps/worker` — BullMQ worker entrypoint (same codebase family; a separate app in the monorepo is fine).
- `apps/mock-provider` — the mock provider service (Fastify or NestJS).
- `packages/` — shared code (Prisma client, crypto, config) as needed.
- Monorepo via pnpm workspaces (or npm workspaces if pnpm is unavailable). TypeScript `strict: true` everywhere.
- `docker-compose.yml` — postgres, redis, api, worker, mock-provider. (DynamoDB Local arrives in MVP-B; do not add it yet.)
- `SPEC.md`, `README.md`, `docs/ADR-001-dynamodb-vs-pg-inbox.md` (one page, per SPEC P2-11 — write it in MVP-A).

## MVP-A scope (days 1–4 in SPEC terms)

1. **Scaffold**: monorepo, lint/format, test runner (Vitest or Jest — your choice, be consistent), Docker Compose bringing the whole stack up clean.
2. **Prisma schema + migrations** for the MVP-A subset of the SPEC data model: `tenants`, `connections` (incl. lifecycle status + generation, encrypted token fields + key version, token_version, refresh lease generation), `external_records` (unique (connection_id, resource_type, external_id), version, payload_hash, tombstone flag), `sync_runs`, `sync_record_outcomes` (unique (run_id, record_key, operation_identity)), `operation_attempt` (unique operation key, attempt count, due_at, claim state). DLQ/reconciliation tables may be stubbed in MVP-B, not now.
3. **Auth**: mock signed JWT (issuer/audience/expiry verified); tenant_id + role derived from claims only; object-level authorization on connection endpoints (cross-tenant → 404); unauthenticated → 401.
4. **Tenant + connection CRUD** (tenant-scoped), connection lifecycle states present (`active`/`closing`/`deleted` + generation), though the full closing protocol is exercised in later phases.
5. **Mock provider v1**: OAuth2 authorization server (authorization code + PKCE, `state` + redirect-URI validation, refresh-token rotation, revocable tokens); employees list/get with cursor pagination **and snapshot token** support; rate-limit behavior (429 + `Retry-After` in both delta-seconds and HTTP-date forms) behind a toggle.
6. **OAuth connect flow** in the API against the mock provider: PKCE, encrypted token storage (envelope encryption via a local key-provider abstraction, key version recorded), the three-phase refresh with fencing per SPEC, error classification (`invalid_grant` → `needs_reauth` + pause; transient → bounded backoff; permanent 4xx → connection error).
7. **Manual sync** for employees (full + incremental trigger): per (connection, resource) single active run; checkpoint + page outcomes committed in the same transaction; cursor advances only after the page is durable; snapshot-token reads for full sync; version-conditional UPSERT for every record.
8. **Tests (MVP-A exit set)** — against real PostgreSQL/Redis from Compose, not mocks of them:
   - Token lifecycle: connect → proactive refresh → reactive refresh on 401 (one refresh + one retry).
   - Concurrent refresh: N workers hit 401 simultaneously → exactly one committed refresh result; late holder's CAS fails and discards (SPEC T03).
   - Provider rotated but local save fails → observable `needs_reauth`, no further refresh attempts (SPEC T22).
   - Encryption at rest: stored ciphertext round-trips; the DB contains no plaintext tokens.
   - Cross-tenant isolation: cross-tenant read/write on connections and records returns nothing/404; tampered JWT → 401; forged tenant claim mismatch → 403 (SPEC T19, MVP-A portion).
   - Pagination: failure on page 2 → checkpoint does not advance past un-persisted records; resume completes correctly (SPEC T05, MVP-A portion).
9. **README**: what the project is (multi-tenant, single-provider adapter demo — honest positioning per SPEC), how to run it, and the MVP-A demo path. Every claim in the README must map to a test or a demo step.

## Exit criteria for MVP-A (all must hold before you report done)

- `docker compose up` from a clean checkout brings the stack up; migrations apply cleanly.
- The full test suite passes.
- A scripted end-to-end happy path runs: create tenant → connect mock provider via OAuth → manual full sync of employees → mirror rows present with correct versions.
- Git history is clean, incremental commits (no single mega-commit), working tree clean at the end.

## Working rules

- All code, comments, docs, and commit messages in English.
- Commit after each numbered scope item (or smaller) with a clear message.
- If a SPEC contract seems impossible or contradictory as written, stop that item, implement the rest, and report the conflict explicitly — do not silently weaken an invariant.
- Do not add DynamoDB, webhooks, DLQ, reconciliation, payruns, or a frontend in MVP-A. They have their own phases and kickoffs.
- When done, write a short completion report as your final message: what was built, test results (names + pass/fail), the demo path output, any SPEC conflicts or deviations, and the final commit hash.
