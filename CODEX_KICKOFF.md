# SyncBridge — Codex Kickoff: Hardening

**Read this file, then execute ONLY the Hardening scope below. MVP-A and MVP-B are complete and accepted — do not redo them, and do not break their tests. Stop and report when Hardening is done. Do not start Stretch (CDK / console).**

## Governing documents

`SPEC.md` in this repo root is the frozen normative contract (SPEC v2.3, frozen 2026-11-18). This kickoff selects the Hardening phase from it. If anything here appears to conflict with SPEC.md, SPEC.md wins and you flag the conflict in your report.

The contracts this phase must implement exactly as specified: Reconciliation (incl. snapshot discipline, confirmed vs provisional findings, safe-class-only auto-repair, generation check before any repair write); Observability & limits; the per-phase exit criteria (clean Compose startup, real-dependency tests, recorded/scripted fault-recovery demo).

## Hardening scope

1. **Reconciliation job** (scheduled trigger + manual trigger, per connection + resource type):
   - Reads the provider through the **same snapshot-token mechanism** as full sync; diffs mirror vs provider by id + version/payload hash; classifies findings as `missing_locally`, `missing_remotely`, `stale`, `conflicted`.
   - Findings from a completed stable snapshot traversal are `confirmed`; anything from a partial or invalidated traversal is `provisional` only, is labelled as such in the report, and can never drive a repair.
   - **Auto-repair is limited to `missing_locally` and `stale`**, executed through the same version-conditional UPSERT as every other writer, and only after verifying the connection's lifecycle status + generation in the commit path. `missing_remotely` is reported, never deleted (the MVP has no absence-based deletion). `conflicted` is reported for human review, never auto-resolved.
   - Persists `reconciliation_runs` and `reconciliation_findings`; emits a per-run report (API-readable, tenant-scoped, role-checked like everything else).
   - Repairs schedule through the persisted `operation_attempt` / `due_at` authority, like all other operations.
2. **Observability pass**: structured metrics/logging for queue lag, sync run duration, retry counts, DLQ depth, 429 rate, token refresh errors — exposed via a simple authenticated metrics/status endpoint (no UI). All log sinks honor the existing redaction list; a leak scan stays in the test suite.
3. **End-to-end fault-recovery demo** (single script, Compose, offline, deterministic): connect mock provider → full sync of employees + payruns → duplicate and out-of-order webhooks → worker killed mid-processing → 429 burst with `Retry-After` → sweeper recovery → one record forced to DLQ → operator replay → silent mutation injected at the provider → reconciliation run detects and safely repairs the drift → final state verified (mirror versions, DLQ empty, findings report, audit trail). The script prints a step-by-step transcript and fails loudly on any assertion.
4. **README + case study finalization**: README tells the whole project story with the honest positioning (multi-tenant, single-provider adapter demo); every claim maps to a named test or a demo step — add a traceability table (claim → test/demo). Case study (in `docs/`): the design decisions and their review history in brief — at-least-once/effectively-once, archive-first + sweeper, three-phase refresh fencing, version-ordered application, snapshot discipline — and ADR-001 cross-referenced.

## Tests (Hardening exit set — all against real Compose dependencies)

- **T08**: silent mutation at the provider → reconciliation detects the drift and safely repairs `stale`/`missing_locally`; a record missing remotely is reported as a finding only — no deletion path exists to trigger.
- **T29**: provider adds/moves records mid-traversal → no `missing_remotely` is published as `confirmed` from the unstable traversal, and no repair acts on `provisional` findings.
- Repair safety: a repair attempted against a connection that entered `closing` mid-run aborts on the generation check and is reported, not written.
- **T17 re-run as the phase gate**: from a clean checkout, `docker compose up` + the full test suite (MVP-A + MVP-B + Hardening) + the end-to-end demo script all run green.

All MVP-A and MVP-B tests must still pass.

## Exit criteria

- Full suite green from a clean checkout; Compose stack healthy including DynamoDB Local.
- The end-to-end demo script runs green and its transcript is committed under `docs/` (or linked from the README).
- README traceability table complete: no claim without a test or demo step.
- Incremental commits per scope item; working tree clean at the end.

## Working rules

- All code, comments, docs, commit messages in English.
- If a SPEC contract seems impossible or contradictory, stop that item, finish the rest, and report the conflict explicitly — never silently weaken an invariant.
- No CDK, no console UI, no second provider in this phase.
- Final message = completion report: what was built, test results (names + pass/fail), demo transcript summary, SPEC conflicts/deviations, final commit hash.
