# SyncBridge — Codex Kickoff: MVP-B

**Read this file, then execute ONLY the MVP-B scope below. MVP-A is complete and accepted — do not redo it, and do not break its tests. Stop and report when MVP-B is done. Do not start Hardening (reconciliation) or Stretch.**

## Governing documents

`SPEC.md` in this repo root is the frozen normative contract (SPEC v2.3, frozen 2026-11-18). Everything below is a scope selection from it, not a replacement. If anything here appears to conflict with SPEC.md, SPEC.md wins and you flag the conflict in your report.

The contracts MVP-B must implement exactly as specified (section names in SPEC.md): Delivery guarantee; Archive event state machine & DLQ ownership (incl. TTL gate, sweeper query model, unified `due_at`); Webhook ingestion (incl. 404 rule and the delete-branch algorithm); Fetched-version semantics; Sync engine retry classification; One retry clock + the persisted `operation_attempt` authority; Global budget / poison-message pause; Dead-letter queue (incl. replay CAS and replay-outlives-archive); Authentication & authorization (replay authorization + audit); Data & privacy caps (archive encryption, 256 KB cap, log redaction).

## MVP-B scope

1. **DynamoDB Local** joins Docker Compose. Implement the `webhook_events` archive exactly per SPEC data model: PK connection_id / SK event_id, encrypted raw body, received_at, processing status, lease_token / lease_expires_at / attempt_count / next_attempt_at, DLQ reference; GSI on status + next_attempt_at; TTL attribute set **only** on terminal states.
2. **Webhook ingress** (API): raw-byte HMAC verification with constant-time comparison **before** parsing; body size cap 256 KB → 413; timestamp/replay window; dual-secret rotation window; defined rejection codes; no sensitive headers in logs or archive. Conditional archive write (duplicate event id → no second item) → 202 → asynchronous processing only.
3. **Sweeper / dispatcher**: two bounded GSI queries (due `pending`; expired `leased` per the unified `due_at` definition), primary-table conditional claim (status + lease generation), batch caps, safe multi-instance competition, and the periodic aged-non-terminal audit that re-drives anything the index missed. The queue is derived state; BullMQ's own backoff is **not** a scheduling authority — jobs fire at the persisted `due_at` from `operation_attempt`, and early-fired jobs defer.
4. **Webhook processing** (worker): fetch-current by ID; ordering by the **fetched snapshot's version** under the three-path version UPSERT; record `event_id` / `event_version` / `fetched_version` metadata; event coalescing per record allowed with metadata preserved; the **delete-branch algorithm** exactly as specified (versioned delete → direct tombstone; non-delete 404 → bounded `unresolved`; unversioned delete → reject + report); connection lifecycle/generation verified in the commit path (closing/deleted connections abort writes).
5. **DLQ**: `dead_letters` + attempt history in PostgreSQL; non-retryable failures and exhausted retries land here with the provider error payload preserved; **replay API** with the `open → replay_queued → resolved | reopened` state CAS (exactly one active replay), operator-role-only, full audit (actor, time, result, denied attempts); replay reads its evidence from PostgreSQL and tolerates a missing archive item (`archive_absent` in audit).
6. **Payruns**: second resource type end-to-end on the mock provider (list/get + pagination + snapshot, webhooks, sync), reusing — not duplicating — the employees pipeline.
7. **Mock provider chaos toggles** (per-test switchable): duplicate webhook delivery, out-of-order delivery, 5xx bursts, latency injection, webhook delivery with tampered signature (for negative tests), silent record mutation (the toggle ships now; its reconciliation consumer arrives in Hardening).
8. **Offboarding closing protocol** exercised end-to-end per SPEC (F02): CAS to `closing` + generation bump, 410 + audit for inbound webhooks, stale-generation jobs become no-ops, staged deletion, verification scan repeated after the longest lease TTL.

## Tests (MVP-B exit set — all against real Compose dependencies)

Freeze-critical: **T01** (archive ok, enqueue fails → sweeper recovers, no duplicate effect), **T02** (commit then crash before ack → no duplicate write/outcome), **T10** (sweeper halted past retry horizon → events intact and recovered; cleanup gate deletes nothing non-terminal), **T11** (crash between DLQ create and archive mark, both directions → converges, no duplicate DLQ), **T18** (two sweepers race one stale event + concurrent worker completion → no state regression), **T23** (leased `due_at` mismatch + stale GSI → still recovered exactly once in effect), **T24** (offboarding race: closing after fetch, before commit + webhook retry → no resurrection, defined rejection + audit).

Core: **T04** (V3/V1/V2 same timestamps → V3 wins; equal version different hash → conflict path), **T06** (429/5xx/invalid_grant/permanent-4xx classification + delays), **T07** (DLQ replay success, duplicate replay idempotent, cross-tenant replay rejected + audited), **T09** (tampered signature, expired timestamp, oversized body, old secret in rotation → defined rejections, no leaks), **T16** (log + archive scan finds no token/sensitive-field leakage), **T20** (event V2 fetches V4 → V4 applied, metadata correct), **T21** (two operators, one DLQ entry → one active replay, both attempts audited), **T25** (replay during/after archive TTL → proceeds from PG, `archive_absent` audited), **T27** (delete-branch: versioned delete + 404 → tombstone; update + transient 404 → no deletion; late V5 → rejected), **T28** (sync page, webhook, and repair operations all schedule via persisted `operation_attempt`/`due_at`; duplicates collapse; restart mid-backoff keeps the budget).

All MVP-A tests must still pass. (T08/T29 are Extension tier — Hardening. Do not build reconciliation in this phase.)

## Exit criteria

- `docker compose up` from a clean checkout brings the full stack (now including DynamoDB Local) up healthy; migrations apply cleanly.
- Full test suite (MVP-A + MVP-B sets) green.
- A scripted demo runs: connect → sync employees + payruns → duplicate + out-of-order webhooks converge → kill a worker mid-processing → sweeper recovers → force a record to DLQ → operator replay resolves it.
- Incremental commits per scope item; working tree clean at the end.

## Working rules

- All code, comments, docs, commit messages in English.
- If a SPEC contract seems impossible or contradictory, stop that item, finish the rest, and report the conflict explicitly — never silently weaken an invariant.
- No reconciliation, no CDK, no console UI in this phase.
- Final message = completion report: what was built, test results (names + pass/fail), demo output, SPEC conflicts/deviations, final commit hash.
