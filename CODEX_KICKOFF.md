# SyncBridge — Codex Kickoff: Stretch (CDK deploy + read-only console)

**Read this file, then execute ONLY the Stretch scope below. MVP-A, MVP-B, and Hardening are complete and accepted — do not redo them, and do not break their tests. Stop and report when Stretch is done. This is the final phase.**

## Governing documents

`SPEC.md` in this repo root is the frozen normative contract (SPEC v2.3, frozen 2026-11-18). Stretch items per SPEC: the CDK deployment slice with per-service boundaries (P2-12), and the thin read-only ops console. If anything here appears to conflict with SPEC.md, SPEC.md wins and you flag the conflict in your report.

## Preflight (do this first, before writing CDK code)

1. Check AWS access from this machine: `aws sts get-caller-identity` (and note the account + region; default to `ca-central-1` unless the account is clearly set up elsewhere — record which you used).
2. **If no valid AWS credentials exist, STOP.** Do not create accounts, keys, or users. Report exactly what is missing and end the run — the console portion (below) may still be completed and reported separately.
3. Produce a pre-deploy cost estimate for the stack below at demo scale (smallest instance classes, single AZ, no NAT gateway if avoidable — use public subnets with security groups, or document why not) and write it into `docs/cdk-deploy.md` **before** deploying. The expected order of magnitude is a few dollars for a same-day deploy + teardown. If the estimate exceeds ~US$25 for the demonstration window, stop and report instead of deploying.

## Scope

1. **CDK stack (TypeScript, `infra/` in this repo)** — exactly the SPEC boundaries:
   - **API Fargate service** behind an ALB (health check on the API's health endpoint).
   - **Worker Fargate service**, separate service, **no ALB**.
   - RDS PostgreSQL (smallest class, single AZ, demo-grade backup retention = 0/1 day), ElastiCache Redis (smallest node), DynamoDB table with the status GSI (on-demand billing), EventBridge schedule that invokes the API's enqueue endpoint for reconciliation (no extra Lambda unless you document why it is required).
   - Secrets (DB credentials, JWT signing key, token-encryption key, webhook secrets) via Secrets Manager / SSM — never plaintext in task definitions or code.
   - The mock provider runs as a third Fargate service in the demo stack so the deployed demo is self-contained (it is a demo counterpart, labelled as such).
   - All resources tagged `project=syncbridge`, `ephemeral=true`.
2. **Demonstrated deploy**: `cdk synth` + `cdk diff` clean and committed as outputs in `docs/cdk-deploy.md`; deploy once; run a smoke pass against the deployed ALB endpoint (health → OAuth connect against the deployed mock → one sync → one webhook → mirror check); record the transcript and the actual cost incurred (from the AWS console/cost explorer if available, else the estimate) in `docs/cdk-deploy.md`.
3. **Teardown in the same run**: `cdk destroy`, then a residual-resource check (list any syncbridge-tagged resources still present — RDS snapshots, log groups, ECR images, secrets) and delete/document them. The deliverable is the demonstrated, torn-down artifact — nothing stays running.
4. **Read-only ops console**: the thinnest possible server-rendered pages served by the API app (no separate frontend build): connections list, sync run history, DLQ list, reconciliation run reports. Read-only — no replay or mutation actions in the UI (replay stays API-only per SPEC). Same JWT auth + tenant scoping + role checks as the API (viewer role is the intended audience). No design work; semantic HTML and a table layout are fine.

## Tests / verification

- All existing tests (MVP-A + MVP-B + Hardening, 34) still pass locally; console endpoints covered by tenant-scope/viewer-role tests in the same style.
- `cdk synth` succeeds in CI-less local run; the smoke transcript and teardown verification are committed under `docs/`.
- T17 discipline still holds: clean checkout → Compose up → full suite green (the CDK work must not disturb the local path).

## Exit criteria

- `docs/cdk-deploy.md` contains: preflight identity/region, cost estimate, synth/diff summary, smoke transcript, actual cost, teardown + residual check results. **Or**, if preflight failed, a precise report of what is missing (console still delivered).
- Console pages live behind auth, tenant-scoped, read-only, covered by tests.
- Incremental commits per scope item; working tree clean at the end.

## Working rules

- All code, comments, docs, commit messages in English.
- Never commit AWS credentials, account IDs in code (docs may record the region and instance classes; mask the account ID), or secrets of any kind.
- If a SPEC contract seems impossible or contradictory, stop that item, finish the rest, and report the conflict explicitly.
- Final message = completion report: preflight result, what was built, deploy/smoke/teardown outcome with costs, test results, SPEC conflicts/deviations, final commit hash.
