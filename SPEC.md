# Project 4 — SyncBridge: a TypeScript integrations service

**Status: SPEC v2.3 — FROZEN by Cynthia on 2026-11-18.** No further design changes without a new review round and Cynthia's explicit unfreeze. Implementation follows the phased milestones and exit gates below.
Changes in v2.3: unified `due_at` semantics + sweeper two-query recovery + aged-event audit channel (F01); connection closing lifecycle with generation checks, so offboarding cannot be raced by in-flight workers (F02); DLQ replay window vs archive TTL resolved — PostgreSQL is the replay evidence of record (F03); bounded single in-flight refresh with lease revalidation, and no claim of provider-side strict single-flight (F04); explicit delete-event branch algorithm (F05); one persisted retry authority (`operation_attempt` + `due_at` in PostgreSQL) for all operation types, BullMQ demoted to rebuildable transport (F06); reconciliation snapshot discipline with confirmed vs provisional findings (F07); stale v1/v2-era sentences removed so each contract appears exactly once (F08); tests tiered Freeze-critical / Core / Extension (F09). Tests now T01–T29.
Changes in v2.2: second-round freeze blockers landed as contracts — refresh runs as claim → external call → CAS save with **no network call inside a DB transaction** (P0-01); sweeper query model with a status GSI, conditional claim, and bounded batches (P0-02); an explicit authentication & object-authorization contract (P0-03); checkpoint + page outcomes in one transaction, cursor-expiry restart, and **absence-based deletion removed from the MVP entirely** (P0-04). P1 items landed: UPSERT three-path rule + outcome idempotency key (P1-05), fetched-version metadata (P1-06), key management (P1-07), global concurrency / retry budget / poison-message pause (P1-08), DLQ replay state CAS (P1-09), explicit scope-cut order (P1-10). P2 items recorded: ADR-001 for the DynamoDB choice (P2-11), CDK stretch service boundaries (P2-12). Acceptance tests merged across both review rounds as T01–T22.
Changes in v2.1: executable contracts for archive TTL vs recovery (N01), the archive↔DLQ event state machine (N02), token-refresh lease fencing (N03), sync snapshot watermark vs record version (N04), unified retry scheduling and rate domains (N05), 404-is-not-a-tombstone (N06), data/privacy caps (N07), and per-milestone exit criteria (N08).
Name: **SyncBridge** (confirmed). One-line positioning: a production-form TypeScript/Node backend that connects a SaaS product to external systems — OAuth connection lifecycle, webhook ingestion, a retrying sync engine, and reconciliation — with a small AWS CDK deployment slice as a stretch milestone.

**Normative-source rule (review round 4, F08)**: the Core design sections below are the single normative contract. The status changelog and the "(review …)" attributions are history explaining how each contract got here; if history and a Core design section ever appear to disagree, the Core design section wins.

Positioning honesty note (review R13): this is a **multi-tenant, single-provider adapter** demonstration. It does not claim a running multi-provider platform; the provider interface is designed so a second adapter is additive, and the README must say exactly that.

## Why this project (JD evidence, 2026-11-18)

Gap analysis across today's two new JDs (Apartment List, Genvis) plus the pending-but-unapplied pool (Cardata, Clover, Solink, RXNT, GitHub, Cisco 2019426, Apostra, Veem, Solace Principal, Cohere, Life360, Fitch, Coalition) ranked the recurring shortboards:

1. **TypeScript/Node backend in production form** — Cardata (NestJS), Genvis (Node microservices), Solink (TS), Fitch, GitHub. EvalForge proved TS full-stack delivery, but its backend was FastAPI; "no production TS backend" is still the standing gap.
2. **AI/ML integrated into a product** (Clover, Coalition, Solace, Apartment List, Life360) — assigned to a later Project 5, not this one.
3. **Serverless / IaC / NoSQL** — Genvis (Lambda, EventBridge, CDK, DynamoDB), Veem (DynamoDB).

SyncBridge targets #1 head-on and folds in #3 as a bounded stretch slice. It also converts Cynthia's real integration experience (trootrax data ingestion, Entmoot's Jira/GitLab connections) into a TypeScript artifact, which is exactly the Cardata Integrations narrative.

## What it is

A multi-tenant integration service for a fictional SaaS product. Tenants connect external accounts via one provider adapter (HR/payroll stand-in, see Mock provider), after which SyncBridge:

- keeps a local mirror of selected external records up to date via **event-driven webhooks + scheduled polling sync**,
- survives real-world failure: expired tokens, provider rate limits, partial failures, duplicated and out-of-order webhooks, worker crashes mid-processing,
- **reconciles** drift between the mirror and the provider on a schedule and repairs the safe classes,
- gives operators a minimal surface: DLQ replay API with audit, plus (stretch) a thin read-only console.

## Mock provider (in-repo, part of the deliverable)

Real third parties are out of scope. Ship **one mock provider service** (`apps/mock-provider`, also NestJS or plain Fastify) exposing two resource types (employees, payruns) with deliberately realistic behaviors, each toggleable per test:

- OAuth2 authorization server behavior (authorization code + PKCE, refresh-token rotation, revocable tokens),
- REST list/get with cursor pagination and rate-limit headers (429 + `Retry-After`),
- webhook emission on record changes, HMAC-signed, with a chaos panel/toggles: duplicate delivery, out-of-order delivery, 5xx bursts, latency injection, silent record mutation (to create drift for reconciliation).

The mock is a test instrument and demo counterpart, labelled as such in the README — never presented as a real integration.

## Stack

- **NestJS + TypeScript (strict)** API and worker (same codebase, two entrypoints: HTTP app and BullMQ worker process).
- **PostgreSQL** via **Prisma** (confirmed over TypeORM) — system of record: tenants, connections, tokens, sync state, DLQ. Concurrency-critical paths may use explicit transactions / raw SQL inside Prisma.
- **Redis + BullMQ** for sync jobs, webhook processing, retries with exponential backoff + jitter.
- **DynamoDB** for the raw webhook event archive (append-only, keyed by connection + event id, with a processing-status attribute) — the NoSQL modeling exhibit.
- **AWS CDK (TypeScript)** deployment slice — **stretch milestone only** (see Milestones): Fargate service (API + worker), ALB, RDS PostgreSQL (smallest class), ElastiCache Redis, DynamoDB table, EventBridge schedule for reconciliation. Demonstrated once, costed, torn down (SafeLens pattern). Redis-on-Fargate is not presented as a production-equivalent choice.
- Local development and CI: Docker Compose (api, worker, mock-provider, postgres, redis, DynamoDB Local).
- Ops surface: DLQ replay + status APIs are core; any console is a thin read-only page set (connections, sync runs, DLQ, reconciliation reports) built only in the stretch phase. No design work.

## Core design (the invariants that matter)

### Delivery guarantee (review R1, R2)

The delivery contract is stated explicitly, not implied:

- **At-least-once processing, effectively-once persistent effects.** No claim of exactly-once execution anywhere in the README or code comments.
- Webhook path: verify HMAC → **conditional write to DynamoDB** (event id unique per connection, status `pending`) → return 202 → a **recoverable dispatcher/sweeper** scans for `pending` events not yet enqueued (or enqueued but never started past a staleness threshold) and (re-)enqueues them into BullMQ. The queue is derived, rebuildable state; the archive is the source of truth for what was received.
- Worker path: PostgreSQL transaction performs a **conditional UPSERT** of the mirror record plus the outcome row; uniqueness and version checks (below) make a re-execution after crash-after-commit a no-op at the DB level. After commit, the worker marks the archive event `processed`; that status update is itself retryable/compensable by the sweeper (an event stuck in `leased` past its lease expiry is re-driven, and idempotent DB effects make that safe).

### Archive event state machine & DLQ ownership (review round 3, N01, N02)

One explicit state machine governs every archived event across DynamoDB, BullMQ, and PostgreSQL. No component claims cross-store atomicity; instead, each cross-store step has a named compensation rule, and the sweeper is the converger.

- **States**: `pending` (archived, not yet claimed) → `leased` (claimed by the sweeper/dispatcher or a worker; carries `lease_token`, `lease_expires_at`, `attempt_count`, `next_attempt_at`) → terminal: `processed` | `dead_lettered`. A lease that expires without a terminal write returns the event to `pending` with `attempt_count` incremented.
- **DLQ ownership**: when retries are exhausted, the worker creates the PostgreSQL `dead_letters` row **first**, keyed by a unique (connection_id, event_id / record key) constraint so a repeated failure path cannot mint duplicate DLQ entries; the archive event then transitions to `dead_lettered` carrying the DLQ row id as a queryable reference. If the process dies between the two writes, the sweeper reconciles: an event in `leased` past expiry whose DLQ reference exists is marked `dead_lettered`; one without is re-driven. Manual replay from the DLQ writes back the replay outcome reference onto the archive event — the archive's terminal state after a successful replay is `processed` with the replay attempt recorded, never a second DLQ row.
- **TTL / retention gate (N01)**: the archive is the source of truth for what was received, so **only terminal events (`processed`, `dead_lettered`) ever receive a TTL**, set to retention expiry (default 30 days) at the moment they reach the terminal state. `pending` / `leased` / awaiting-retry events carry no TTL and cannot silently expire. A monitoring check alerts on any non-terminal event older than the recovery window (default 24 h); a cleanup job is gated to terminal states only and its scan asserts this. DynamoDB TTL deletion is asynchronous — it is a retention mechanism, never an immediate-deletion promise (see Privacy).
- **Sweeper query model (review round 2, P0-02)**: the archive's primary key (connection_id, event_id) serves per-connection lookups, **not** recovery scans. Recovery runs on a **GSI keyed by processing status with `next_attempt_at` as the sort key** (status-bucket partitions if volume demands), so "due for (re-)drive" is a bounded query, never a table scan — an unbounded scan is explicitly not the implementation. Claiming is a **conditional update** (status + lease_token must still match), batches are size-capped, and multiple sweeper instances compete safely on the same conditional write. There is no reliable "enqueued but never started" signal from the queue, so recovery decisions are made from archive state (status + lease expiry + next_attempt_at) alone.
- **One `due_at` for every state (review round 4, F01)**: claimability is defined uniformly — for `pending` events, `due_at = next_attempt_at`; for `leased` events, `due_at = max(lease_expires_at, next_attempt_at)`. The sweeper runs **two** bounded GSI queries (due `pending`; expired `leased`) and then claims against the primary table with a CAS on (status, lease generation, due condition). The GSI is eventually consistent, so it is a discovery aid, never the guarantee: the primary-table CAS is the guarantee, and a **periodic audit of aged non-terminal events** (anything non-terminal older than the recovery window) is the repair channel for anything the index missed or delayed. Status and due-time updates are written so the GSI projection stays consistent with the primary item.

### Token lifecycle (review R4)

- Authorization code + PKCE, with `state` and redirect-URI validation. Access/refresh tokens encrypted at rest (envelope encryption via a local key-provider abstraction); the stored ciphertext records its **key version**.
- Refresh is proactive (before expiry) and reactive (on 401, at most one controlled refresh + one retry of the original call).
- **Single-flight is distributed, not per-process**: refresh is coordinated through the connection row in PostgreSQL — a lease claim and a version-CAS save (three-phase flow, below) — so multiple workers collapse to one effective refresh and no stale token overwrites a newer one. No long-lived lock is held across the provider call.
- **Lease fencing (review round 3, N03)**: holding the lock is not enough — a refresh lease carries a monotonically increasing **lease generation**. The token write is accepted only if (token_version, lease_generation) still match the row at commit time. If a lease expires and a second worker refreshes first, the late holder's CAS fails: it **discards its refresh result and re-reads** the stored tokens rather than overwriting. The unrecoverable window is named explicitly: if the provider rotated the refresh token but the local commit failed, the stored token may be dead — the connection then surfaces an observable `needs_reauth` state (status + metric + console/API visibility), never a silent retry loop.
- **No network call inside a database transaction (review round 2, P0-01)**: refresh runs in three phases — (1) a **short transaction** claims the refresh lease (row lock + lease generation increment); (2) the provider refresh call happens **outside any transaction**, holding no DB lock and no pooled connection; (3) a **short transaction** saves the result by version-CAS and releases the lease. This spec does not claim lossless recovery from the rotated-but-unsaved window: that path lands in `needs_reauth` with an operator-visible reason, which is the honest ceiling for rotating refresh tokens.
- **Local fencing cannot fence the provider (review round 4, F04)**: generation-CAS stops a stale worker from overwriting local state, but it cannot stop that worker's in-flight provider call from rotating the token provider-side, possibly invalidating the winner's saved token. Mitigations are contractual, not absolute: at most **one in-flight refresh per connection**, with a **bounded timeout** shorter than the lease; the lease is re-validated immediately before the call starts and again when it returns, and an expired-lease result is never committed. If the outcome is ambiguous — the provider may have rotated and it cannot be determined which refresh token is live — the connection goes to `needs_reauth`. This spec explicitly does **not** promise strict provider-side single-flight or zero manual re-authorization.
- Error classification drives state: `invalid_grant` (revoked/expired refresh token) → connection moves to `needs_reauth`, its syncs pause, no retry storm. Transient failures (5xx, network) → bounded backoff. Permanent 4xx / insufficient scope → surfaced as a connection error, not retried.

### Webhook ingestion (review R3, R9)

- Verify HMAC over the **raw request bytes** with a constant-time comparison, before parsing. Enforce a body size limit, a timestamp/replay window, and support **secret rotation** (current + previous secret both verify during a rotation window). Rejections have defined status codes; sensitive headers are never written to logs or the archive.
- Idempotency by provider event id at the archive layer (conditional write), and effectively-once effects at the DB layer (below).
- **Ordering rule, per (connection, resource_type, external_id)**: the provider's monotonically increasing `version` decides. An incoming change applies only if its version is strictly greater than the stored version; equal version with a different payload hash is recorded as a **conflict** (not silently overwritten); lower version is dropped as stale. `updated_at` is informational only — never the ordering key (timestamps can tie or skew).
- Preferred processing: a webhook is a *trigger* — the worker fetches the current entity by ID from the provider and applies that snapshot under the version rule, rather than trusting a possibly stale event payload.
- **Fetched-version semantics (review round 2, P1-06)**: ordering uses the **fetched snapshot's version**, which may be newer than the event's version (event V2, fetch returns V4 → V4 is applied). Each processed event records `event_id`, `event_version`, and `fetched_version` as observable metadata. The event is marked applied only when its fetched snapshot (or a newer one already applied) is durably written; coalescing several pending events for the same record into one fetch is allowed, with each event's metadata preserved.
- **Deletion policy**: a provider delete event writes a **tombstone** (record marked deleted with its version) rather than a hard delete, under the same version rule. Polling sync and reconciliation never infer deletion from absence — **absence-based deletion is not implemented in the MVP** (see Reconciliation); the versioned delete event is the only deletion path.
- **A 404 is not a tombstone (review round 3, N06)**: when a webhook triggers a fetch-current and the provider returns 404, that may be eventual consistency, not deletion. A bare 404 sends the record to a bounded-retry `unresolved` path; a tombstone is written **only** from an explicit delete event carrying a monotonic version (or an equivalent versioned tombstone API). A late update with a lower version than the tombstone is dropped by the version rule as usual.
- **Delete-branch algorithm (review round 4, F05)**: the two rules above combine into one explicit branch — (1) an event that **is** a versioned delete applies the tombstone directly by version-UPSERT, without depending on a fetch (a fetch may be used as an optional second check, and its 404 changes nothing); (2) a **non-delete** event whose fetch returns 404 goes to the `unresolved` bounded-retry path; (3) a delete event **without** a version is rejected and reported, never inferred from a 404.

### Sync engine (review R5)

- Per (connection, resource_type), **at most one active sync run** at a time (uniqueness enforced in DB); overlapping triggers coalesce.
- Runs follow a state machine (`queued → running → succeeded | partial | failed`) with only legal transitions permitted; per-record outcomes are recorded in the same transaction as the record write.
- **Checkpoint semantics**: the pagination cursor/checkpoint for a run advances only after the page's records are durably written. A failure on page N leaves the checkpoint at page N−1; resuming continues from there — no record is skipped because a later page succeeded. The checkpoint write and that page's record outcomes commit in the **same PostgreSQL transaction** (review round 2, P0-04).
- **Snapshot watermark vs record version (review round 3, N04)**: run-level mutex does not order webhook writes, so **all write sources** (webhook processing, polling sync, reconciliation repair) apply the same version-conditional UPSERT — a sync run can never overwrite a newer webhook-applied version with an older page result. A full sync reads against a provider **snapshot token** (the mock issues one; pages fetched under it are a consistent snapshot). "Full sync succeeded" means exactly "the snapshot was fully traversed", nothing more; if the snapshot cursor is invalidated mid-run, the run fails/restarts — it never reports `succeeded`. The run records its snapshot watermark separately from per-record versions.
- Retry classification: retryable = 429 (honor `Retry-After`), 5xx, network — capped exponential backoff + jitter, with per-connection concurrency and retry ceilings. Non-retryable = validation 4xx → straight to DLQ with the provider's error payload preserved.
- **One retry clock (review round 3, N05)**: BullMQ retries, sweeper re-drives, and 429 handling all obey a single source of truth — the `next_attempt_at` computed once by the failure classifier and stored on the archive event / job record. Neither the sweeper nor the queue may run an item before its `next_attempt_at`. Sweeper claims and queue jobs carry a **stable operation key** (connection + event/record + operation class), so duplicate enqueues collapse instead of multiplying executions. Rate domains are explicit: per-connection and per-provider concurrency caps; `Retry-After` is parsed in both forms (delta-seconds and HTTP-date); a per-connection circuit breaker opens after consecutive 429s with a capped maximum backoff; caps are per-tenant-fair — one tenant's 429 storm must not starve other tenants' queues.
- **The retry authority is a persisted PG record for every operation type (review round 4, F06)**: polling sync pages and reconciliation runs have no DynamoDB event, so the single clock lives in PostgreSQL as an `operation_attempt` row (unique operation key, attempt count, `due_at`, claim state) created for **all** operation types — webhook processing, sync pages, reconciliation repairs. The DynamoDB archive fields are a projection of that record for webhook-originated work, not a second authority. **BullMQ is transport only**: its built-in backoff is disabled as a scheduling authority — jobs are enqueued (or re-enqueued by the sweeper) at the persisted `due_at`, and a job that fires early re-checks `due_at` and defers. Pausing a connection freezes its `due_at` progression; resuming recomputes from the stored attempt state. Maximum attempt count and maximum age are enforced on the `operation_attempt` row.
- **Global budget (review round 2, P1-08)**: on top of per-connection caps there is a global worker concurrency limit, a maximum attempt count and maximum age per job (exhaustion → DLQ or terminal state, never infinite requeue), and a **poison-message pause**: a connection whose failure rate crosses a threshold is paused and surfaced, instead of burning the global budget. A connection in `needs_reauth` produces no further provider requests until re-authorized.

### Dead-letter queue (review R6)

- Failed records land in DLQ with reason, payload, and attempt history.
- **Delivery dedup ≠ operation replay**: a DLQ entry has its own execution/attempt identity, independent of the webhook event-id dedup. Replay re-enters the normal pipeline for records that never succeeded; the effectively-once DB rules still apply, so a replay of an already-applied record is a no-op, and a duplicate replay is safe.
- Replay is an explicit operator action, never automatic. Every replay records **actor, time, and result** (audit row). Replay validates tenant scope (see Multi-tenancy).
- **Replay claim is a state CAS (review round 2, P1-09)**: a DLQ entry moves `open → replay_queued → resolved | reopened` by conditional update, so two operators (or a double-click) produce exactly **one** active replay execution, with its own attempt id. Failed replays and authorization-denied attempts are recorded on the entry, not just in logs. Replay requires the operator role; viewers are read-only.
- **Replay outlives the archive (review round 4, F03)**: `dead_lettered` archive items carry the 30-day terminal TTL, but the **PostgreSQL DLQ entry and its attempt history are the durable evidence of record for replay** — the archive is not. Replay therefore works from PG state alone; the replayable window is the DLQ retention window (defined separately from, and longer than, archive TTL). At replay start the worker performs a liveness check on the archive item: if it still exists, the replay outcome is written back to it; if TTL or cleanup already removed it, the replay proceeds and the audit records `archive_absent` — the system never claims an archive state sync it did not perform. A replay attempted beyond the DLQ retention window is refused with a deterministic error, not a silent no-op.

### Reconciliation (review R7)

- **Source of truth is one-directional: the provider.** The local mirror is read-only with respect to truth; reconciliation never pushes local state to the provider.
- The scheduled job diffs mirror vs provider (by id + version/hash) and classifies drift: `missing_locally`, `missing_remotely`, `stale`, `conflicted`.
- **Snapshot discipline (review round 4, F07)**: reconciliation reads the provider through the **same snapshot-token mechanism** as full sync. Findings from a completed, stable snapshot traversal are `confirmed`; anything observed without a completed snapshot (partial run, invalidated cursor) is published only as `provisional` and can never drive a repair or a deletion claim. Repairs pass through the same version-conditional UPSERT as every other writer **and** verify the connection's lifecycle generation (see Offboarding) before committing — a repair never writes into a closing or deleted connection.
- **Auto-repair is limited to the safe classes**: `missing_locally` and `stale` are repaired through the same write path as sync. `missing_remotely` is **reported, not deleted** — and per review round 2 (P0-04), **absence-based deletion is not implemented in the MVP at all**: the only deletion path is an explicit, versioned provider delete event producing a tombstone. `conflicted` is reported for human review, never auto-resolved. Every run emits a per-run report. The mock's silent-mutation toggle exists to prove detection + safe repair.

### Multi-tenancy discipline (review R8)

- `tenant_id` is carried and validated in **every** context: API requests, worker job payloads, DLQ replay, archive keys, and console/API reads. Connections belong to tenants; every query is tenant-scoped.
- A minimal role model applies to the operator surface (operator vs tenant viewer).
- Negative tests prove cross-tenant read, write, and replay all return nothing / are rejected.

### Authentication & authorization (review round 2, P0-03)

Tenant-scoping is not authentication. The API's trust boundary is explicit, at development-grade realism:

- **Identity source**: requests carry a signed mock JWT (issuer + audience verified, expiry enforced). `tenant_id` and `role` are derived **only from verified token claims** — a client-supplied tenant field is never trusted, and supplying one that disagrees with the token is a 403.
- **Object-level authorization**: every connection, DLQ entry, archive read, and replay is checked against the caller's tenant and role on the server side. Cross-tenant object access returns 404 (non-enumerable) or 403; unauthenticated requests return 401.
- **Worker trust boundary**: job payloads carry only object IDs, never authority. The worker **re-loads the connection from PostgreSQL and takes the tenant from the database row**; a forged or tampered job payload cannot move work across tenants.
- **Audit**: denied replays and authorization failures are audit-logged with actor, object, and reason.

### Observability & limits (review R10)

Minimum metrics/logging from MVP-B onward: queue lag, sync run duration, retry counts, DLQ depth, 429 rate, token refresh errors. Structured logs carry connection id, sync run id, and event id — never tokens or sensitive headers.

### Data & privacy caps (review round 3, N07)

The resources are payroll-adjacent, so the design treats payloads as sensitive even though every byte of test data is fictional:

- **Mock data is 100% synthetic** — invented names, salaries, and identifiers; no real personal data in fixtures, seeds, or demos.
- **Archive minimization**: the raw webhook body is stored envelope-encrypted; events above the size cap (default 256 KB) are rejected with **413** before archiving. Retention for terminal events defaults to 30 days (see TTL gate); reads of the archive are role-gated (operator role only) and access is audit-logged.
- **Log redaction**: authorization headers, signature headers, token fields, and salary-bearing payload fields are on an explicit redaction list for all log sinks; a test scans emitted logs and archive samples for leaks (T16).
- **Offboarding is a closing protocol, not a delete statement (review round 4, F02)**: connections have a lifecycle (`active → closing → deleted`) and a monotonic **generation** number. Offboarding runs in order: (1) CAS the connection to `closing` and bump its generation — from this moment, new webhooks for the connection are rejected with a defined response (410) and audit-logged, and no new syncs, claims, or replays are accepted; (2) invalidate outstanding BullMQ jobs and worker leases for the connection (jobs carry the generation; a stale-generation job is a no-op); (3) **every worker verifies (connection status, generation) inside its commit path** — a write whose generation no longer matches is aborted, so an in-flight fetch can never resurrect mirror or archive rows after deletion; (4) revoke at the provider (mock), delete mirror records and archive items; (5) verify by scan, repeated after the longest lease TTL, so verification covers the full in-flight window rather than a single instant.
- **Key management (review round 2, P1-07)**: the key-provider abstraction has a named local implementation (key from environment / file with restricted permissions in dev; KMS in the CDK stretch). Keys are versioned; rotation re-encrypts lazily on next write and eagerly for tokens via a background pass; key material never appears in logs, and the redaction list covers it.

## Data model (sketch, with constraints — review R11)

`tenants`, `connections` (tenant, provider, lifecycle status + generation, encrypted tokens + key version, scopes, token_expires_at, token_version for CAS, refresh lease generation), `external_records` (connection, resource_type, external_id, version, payload_hash, payload, tombstone flag, last_synced_at — **unique (connection_id, resource_type, external_id)**), `sync_runs` (with a partial-unique constraint enforcing one active run per connection+resource), `sync_record_outcomes` (FK to run + record; **unique (run_id, record_key, operation_identity)** so a crash-replayed page cannot duplicate outcomes — review round 2, P1-05), `dead_letters` (with attempt history + replay audit + replay state), `reconciliation_runs`, `reconciliation_findings`. The mirror UPSERT has exactly three version paths, executed atomically in one PG transaction together with the outcome and any conflict-audit row: incoming version **>** stored → apply; **=** stored with equal payload hash → no-op; **=** with different hash → record conflict, do not overwrite; **<** stored → drop as stale (P1-05). DynamoDB: `webhook_events` (PK connection_id, SK event_id, raw body (encrypted), received_at, processing status + lease_token / lease_expires_at / attempt_count / next_attempt_at, DLQ reference; TTL attribute set **only** on terminal states, per the TTL gate in the state-machine section); connection offboarding defines archive + mirror cleanup.

## Milestones (phased per review §05; ~8–12 days total, stretch excluded from the committed estimate)

- **MVP-A (days 1–4)**: monorepo scaffold, Prisma schema + migrations, tenant + connection CRUD, OAuth connect flow against the mock provider (PKCE, encrypted storage, distributed single-flight refresh with rotation), mock provider v1 (auth + employees list/get + pagination + rate limits), manual trigger for full/incremental sync of employees. Tests: token lifecycle incl. concurrent refresh, encryption-at-rest round trip, cross-tenant isolation.
- **MVP-B (days 5–8)**: webhook ingress (raw-byte HMAC verify, DynamoDB archive with pending status, sweeper/dispatcher, async processing, version-rule ordering + tombstones), sync engine hardening (checkpoint semantics, retry policy, DLQ + replay API with audit), payruns as second resource type, chaos toggles on the mock. Tests T01–T09 (below).
- **Hardening (days 9–12)**: reconciliation (report + safe-class repair only), sweeper recovery demonstration, metrics/logging pass, one end-to-end failure-recovery demo script (compose-based, offline), README + case study.
- **Stretch (only if the above is green)**: minimal CDK deploy + teardown with cost notes; thin read-only ops console; recorded demo. CDK boundaries are defined per service, not as one generic "Fargate service" (review round 2, P2-12): an **API Fargate service** behind the ALB and a separate **worker Fargate service** with no ALB; EventBridge schedules invoke the API's enqueue endpoint (no extra Lambda unless justified); the stack records a cost ceiling, and teardown ends with a residual-resource check.
- **ADR-001 (review round 2, P2-11)**: the repo carries a one-page architecture decision record for "DynamoDB archive vs PostgreSQL inbox/outbox" — the honest trade: NoSQL modeling evidence and append-only conditional dedup, paid for with cross-store compensation paths. The README states plainly that archive and mirror are different responsibilities and no cross-store strong transaction is claimed.

The original v1 estimate of 7–10 days for the full scope is superseded: with the P0 contracts actually tested, 8–12 days is the honest range for MVP-A + MVP-B + Hardening, and CDK/console sit outside it. Per review round 3 (N08), **8–12 days is a target, not a guarantee**: the mandatory deliverable is the *verifiable core loop* — OAuth + single-resource paginated sync + idempotent webhook + sweeper + one end-to-end fault-recovery demo. Payruns, full reconciliation, and the wider chaos matrix advance through risk gates, not calendar pressure. **Scope-cut order is fixed in advance (review round 2, P1-10)**: if time tightens, cut in this order — payruns second resource → chaos toggles beyond the tested set → reconciliation auto-repair (report-only ships instead). The P0 fault-injection tests are never the thing cut. **Exit criteria for every phase**: `docker compose up` brings the whole stack up clean; the phase's integration tests run against real dependencies (PostgreSQL, Redis, DynamoDB Local — not mocks of them) and pass; the phase's fault-recovery demo is recorded or scripted end-to-end.

## Testing bar

Every invariant above has a named test, in the EvalForge style: hand-built fixtures against the mock provider's chaos toggles, not mocks of the service's own internals. A claim in the README must map to a test or a demo step. Acceptance tests (from the review, adopted):

- **T01** archive write succeeds, enqueue fails → sweeper re-drives → mirror ends correct; same event produces no duplicate DB effect.
- **T02** DB commit succeeds, worker dies before ack → reprocessing does not duplicate the record write or the outcome.
- **T03** two workers hit 401 concurrently → exactly one refresh result survives; no stale token overwrite.
- **T04** out-of-order versions V3, V1, V2 with identical timestamps → final record is V3; equal version + different hash follows the conflict policy.
- **T05** page 2 of a paginated sync fails → checkpoint does not skip un-persisted records; resume completes page by page.
- **T06** 429 with `Retry-After`, 5xx, `invalid_grant`, permanent 4xx → classification and delays match the contract.
- **T07** DLQ replay succeeds; duplicate replay is idempotent; cross-tenant replay is rejected and audited.
- **T08** silent mutation → reconciliation detects and safely repairs; a record missing remotely is reported as a finding only — the MVP has no absence-based deletion path to trigger.
- **T09** tampered signature, expired timestamp, oversized body, old secret during rotation → defined rejections, no sensitive data in logs.

Acceptance tests added in v2.1 (third-round review):

- **T10** sweeper halted beyond the normal retry horizon → non-terminal archive events are still present, tracked, and recover successfully on restart; the cleanup gate deletes nothing non-terminal.
- **T11** crash between PG DLQ creation and archive status write (and the mirror-image crash) → sweeper converges the pair; no duplicate DLQ rows, no infinite re-drive.
- **T12** refresh lease fencing: worker A's lease expires, worker B refreshes and commits, then A's provider call returns → A's write is CAS-rejected and discarded; simulated provider-rotated-but-locally-unsaved case lands in observable `needs_reauth`.
- **T13** full sync reads page 1, a V5 webhook lands, then stale page data with V3 arrives → final record is V5; snapshot cursor invalidated mid-run → run fails/restarts, never `succeeded`.
- **T14** fetch-current returns a transient 404, then the entity reappears → no tombstone; explicit delete V6 then late update V5 → tombstone stays at V6.
- **T15** duplicate enqueues + parallel sweepers → no request storm; consecutive 429s still honor `Retry-After` (both delta-seconds and HTTP-date forms); other tenants' work is not starved.
- **T16** oversized event → 413; log + archive scan finds no token or sensitive-field leakage; offboarding flow deletes mirror + archive and verifies by scan.
- **T17** from a clean checkout, `docker compose up` + the integration suite + the fault-recovery demo script all run green (per-phase exit gate).

Acceptance tests added in v2.2 (second-round review; its T10–T17 numbering overlapped round 3's, so the non-duplicates are merged here as T18–T22 — round-2 T13/T14/T16 are covered by T13/T04/T15 above):

- **T18** two sweeper instances race the same stale event while a worker completes it concurrently → conditional writes and the lease prevent any state regression or duplicate effect.
- **T19** tampered JWT → 401; a viewer-role caller attempts DLQ replay → denied and audit-logged; a forged worker job payload naming another tenant → the worker's DB-derived tenant makes the forgery a no-op.
- **T20** webhook event V2 triggers a fetch that returns V4 → the applied version is V4, and the event's metadata records event_version=2 / fetched_version=4.
- **T21** two operators replay the same DLQ entry at the same moment → exactly one active replay execution exists; both attempts (granted and rejected) appear in the audit trail.
- **T22** provider refresh succeeds and rotates, then the local save fails → connection lands in observable `needs_reauth`; no further refresh attempts are made against the dead token.

Acceptance tests added in v2.3 (fourth-round review), with the tiering required by F09 — **Freeze-critical** tests gate the MVP-A/B exit criteria; **Core** tests gate Hardening; **Extension** tests cover stretch-adjacent scope. Tier assignments: Freeze-critical — T01, T02, T03, T10, T11, T12, T18, T19, T22, T23, T24, T26. Core — T04, T05, T06, T07, T09, T13, T14, T15, T16, T17, T20, T21, T25, T27, T28. Extension — T08, T29. If reconciliation degrades to report-only under the scope-cut order, T08/T29 degrade with it and the README must not claim auto-repair.

- **T23** a `leased` event whose `next_attempt_at` differs from its `lease_expires_at` times out while two sweepers compete and the GSI read is stale → the event is still recovered exactly once in effect, via primary-table CAS and/or the aged-event audit channel.
- **T24** offboarding begins after a worker's provider fetch but before its PG commit, while a webhook retry arrives → after closing, no mirror or archive write lands; inbound events get the defined rejection + audit; cleanup converges and stays clean after the lease window.
- **T25** DLQ replay runs while the archive item hits TTL expiry / is already gone → replay proceeds from PG evidence, audit is complete with `archive_absent` recorded, and nothing claims an archive sync that did not happen.
- **T26** worker A's refresh call times out locally but executes at the provider; worker B takes the lease and refreshes → under both provider arrival orders the system converges: either one valid token set, or an observable `needs_reauth`; never an infinite refresh loop.
- **T27** explicit delete V6 with a 404 fetch → V6 tombstone immediately; ordinary update with a transient 404 → no deletion; late V5 update after the tombstone → rejected by the version rule.
- **T28** a paginated sync operation, a webhook operation, and a reconciliation repair all schedule through persisted `operation_attempt`/`due_at` → duplicate enqueues collapse, nothing executes before `due_at`, and a restart mid-backoff resumes with the attempt budget intact.
- **T29** the provider adds/moves records mid-reconciliation-traversal → no `missing_remotely` is published as confirmed from an unstable traversal, and no repair acts on provisional findings.

## Explicitly out of scope

Real third-party providers; a second provider adapter; Kubernetes; GraphQL (REST only); a polished frontend; multi-region; billing; user-facing (end-customer) UI; automatic deletion or conflict auto-resolution; complex RBAC; Go (deliberate standing avoidance); Project 5's AI-serving concerns.

## Decisions (v1 open questions, resolved in v2 per review recommendation — pending Cynthia's freeze)

1. Name: **SyncBridge** — kept.
2. ORM: **Prisma** — with explicit transactions/raw SQL where concurrency control requires it.
3. CDK slice: **stretch milestone**, not MVP.
4. Mock provider: **one service, two resource types** (employees in MVP-A, payruns added in MVP-B).

## Interview story it buys

"I built the integrations layer of a SaaS product in TypeScript: OAuth token lifecycle with distributed single-flight refresh, webhook processing that is at-least-once with effectively-once effects — archive-first ingestion with a recovery sweeper, version-ordered application with tombstones — a sync engine with explicit failure classes and checkpointed pagination, and scheduled reconciliation that detects drift and repairs only the safe classes." Every clause maps to Cardata's JD (sync / webhooks / retries / reconciliation / OAuth) and Genvis's (Node microservices, AWS serverless-adjacent, IaC as stretch).
