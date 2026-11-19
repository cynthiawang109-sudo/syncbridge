import { randomUUID } from "node:crypto";
import {
  Prisma,
  type OperationAttempt,
  type ReconciliationRun,
  type Connection,
} from "@prisma/client";
import { db, lockConnection } from "../../packages/shared/db";
import { isResource } from "../../packages/shared/events";
import {
  allowClaim,
  expired,
  failureDue,
  MAX_AGE,
  recordAttempt,
  resetFailures,
  WORK_LEASE,
} from "../../packages/shared/budget";
import { pauseAttempts } from "../../packages/shared/attempts";
import {
  fetchPage,
  ProviderError,
  type Employee,
  type Page,
} from "../../packages/shared/provider";
import {
  ConnectionUnavailable,
  withAccess,
} from "../../packages/shared/tokens";
import { mirrorPayload, upsertMirror } from "../../packages/shared/mirror";
import { validateSnapshotPage } from "../../packages/shared/snapshots";
import { telemetry } from "../../packages/shared/telemetry";

export function dueReconciliation() {
  return db.$queryRaw<Array<{ key: string; generation: number }>>`
    SELECT key, generation FROM (
      SELECT a.key, a.generation, a.due_at,
        row_number() OVER (PARTITION BY c.tenant_id ORDER BY a.due_at, a.key) AS tenant_position
      FROM operation_attempt a JOIN connections c ON c.id = a.connection_id
      WHERE a.reconciliation_id IS NOT NULL AND a.due_at <= CURRENT_TIMESTAMP
        AND (a.state = 'pending' OR (a.state = 'claimed' AND a.lease_until <= CURRENT_TIMESTAMP))
        AND a.generation = c.generation AND c.lifecycle = 'active' AND c.token_status = 'connected'
        AND c.paused_reason IS NULL AND (c.rate_until IS NULL OR c.rate_until <= CURRENT_TIMESTAMP)
    ) ready ORDER BY tenant_position, due_at LIMIT 30
  `;
}
type Claim = OperationAttempt & { reconciliation: ReconciliationRun };
async function claim(key: string, generation: number) {
  const target = await db.operationAttempt.findUnique({ where: { key } });
  if (!target?.connectionId || !target.reconciliationId) return;
  const id = target.connectionId;
  return db.$transaction(async (tx) => {
    const connection = await lockConnection(tx, id);
    if (
      connection?.lifecycle !== "active" ||
      connection.generation !== generation ||
      connection.tokenStatus !== "connected"
    )
      return;
    const current = await tx.operationAttempt.findUnique({
      where: { key },
      include: { reconciliation: true },
    });
    if (
      !current?.reconciliation ||
      current.generation !== generation ||
      current.reconciliation.generation !== generation ||
      current.dueAt.getTime() > Date.now() ||
      (current.state !== "pending" &&
        !(
          current.state === "claimed" &&
          (current.leaseUntil?.getTime() ?? Infinity) <= Date.now()
        ))
    )
      return;
    if (!(await allowClaim(tx, connection))) return;
    if (expired(current)) {
      await fail(
        tx,
        { ...current, reconciliation: current.reconciliation },
        "attempt_budget_exhausted",
      );
      return;
    }
    const next = await tx.operationAttempt.update({
      where: { key },
      data: {
        state: "claimed",
        claimToken: randomUUID(),
        leaseUntil: new Date(Date.now() + WORK_LEASE),
        attemptCount: { increment: 1 },
      },
    });
    await recordAttempt(tx, key, next.attemptCount, "started");
    return { ...next, reconciliation: current.reconciliation };
  });
}
async function withClaim(
  claim: Claim,
  use: (tx: Prisma.TransactionClient, connection: Connection) => Promise<void>,
) {
  await db.$transaction(async (tx) => {
    const connection = await lockConnection(
      tx,
      claim.reconciliation.connectionId,
    );
    if (
      connection?.lifecycle !== "active" ||
      connection.generation !== claim.generation
    )
      return;
    const current = await tx.operationAttempt.findFirst({
      where: {
        key: claim.key,
        state: "claimed",
        claimToken: claim.claimToken,
        leaseUntil: { gt: new Date() },
      },
    });
    if (!current) return;
    await use(tx, connection);
  });
}
async function finish(
  tx: Prisma.TransactionClient,
  claim: Claim,
  result: string,
) {
  await tx.operationAttempt.update({
    where: { key: claim.key },
    data: {
      state: "done",
      claimToken: null,
      leaseUntil: null,
      evidence: Prisma.DbNull,
    },
  });
  await recordAttempt(tx, claim.key, claim.attemptCount, result);
}
async function fail(
  tx: Prisma.TransactionClient,
  claim: Claim,
  reason: string,
  error?: unknown,
) {
  await tx.operationAttempt.update({
    where: { key: claim.key },
    data: {
      state: "failed",
      claimToken: null,
      leaseUntil: null,
      evidence: Prisma.DbNull,
    },
  });
  await recordAttempt(tx, claim.key, claim.attemptCount, reason, error);
  const runId = claim.reconciliation.id;
  if (claim.repairRecordId) {
    await tx.reconciliationFinding.update({
      where: { runId_externalId: { runId, externalId: claim.repairRecordId } },
      data: { repairStatus: "failed", repairResult: reason },
    });
  } else {
    await tx.reconciliationRun.updateMany({
      where: { id: runId, status: "traversing" },
      data: { status: "provisional", reason, finishedAt: new Date() },
    });
    await tx.reconciliationObservation.deleteMany({ where: { runId } });
  }
}
async function onError(claim: Claim, error: unknown) {
  await withClaim(claim, async (tx, connection) => {
    const paused = connection.tokenStatus === "needs_reauth";
    const providerError = error instanceof ProviderError ? error : undefined;
    const reason =
      providerError?.reason ??
      (error instanceof ConnectionUnavailable
        ? "connection_error"
        : "local_processing_error");
    const retryable =
      providerError?.retryable ?? !(error instanceof ConnectionUnavailable);
    const dueAt = paused
      ? claim.dueAt
      : await failureDue(tx, connection, claim.attemptCount, error);
    if (
      !paused &&
      (!retryable ||
        expired(claim) ||
        dueAt.getTime() >= claim.createdAt.getTime() + MAX_AGE)
    ) {
      await fail(tx, claim, reason, error);
    } else {
      await tx.operationAttempt.update({
        where: { key: claim.key },
        data: { state: "pending", dueAt, claimToken: null, leaseUntil: null },
      });
      await recordAttempt(
        tx,
        claim.key,
        claim.attemptCount,
        paused ? "needs_reauth" : reason,
        error,
      );
    }
    if (paused || connection.failureStreak >= 11)
      await pauseAttempts(tx, connection.id);
  });
}
async function classify(
  tx: Prisma.TransactionClient,
  run: ReconciliationRun,
  complete: boolean,
  ids: string[],
) {
  const confidence = complete ? "confirmed" : "provisional";
  if (complete)
    await tx.reconciliationFinding.deleteMany({ where: { runId: run.id } });
  if (!complete && !ids.length) return;
  await tx.$executeRaw`
    INSERT INTO reconciliation_findings (run_id, external_id, classification, confidence, mirror_version, provider_version)
    SELECT ${run.id}, o.external_id,
      CASE WHEN m.external_id IS NULL THEN 'missing_locally'
           WHEN m.version < o.version THEN 'stale' ELSE 'conflicted' END,
      ${confidence}, m.version, o.version
    FROM reconciliation_observations o
    LEFT JOIN external_records m ON m.connection_id = ${run.connectionId}
      AND m.resource_type = ${run.resourceType} AND m.external_id = o.external_id
    WHERE o.run_id = ${run.id} ${complete ? Prisma.empty : Prisma.sql`AND o.external_id IN (${Prisma.join(ids)})`} AND
      (m.external_id IS NULL OR m.version <> o.version OR m.payload_hash <> o.hash)
  `;
  if (!complete) return;
  await tx.$executeRaw`
    INSERT INTO reconciliation_findings (run_id, external_id, classification, confidence, mirror_version)
    SELECT ${run.id}, m.external_id, 'missing_remotely', 'confirmed', m.version
    FROM external_records m WHERE m.connection_id = ${run.connectionId} AND m.resource_type = ${run.resourceType}
      AND NOT m.tombstone AND NOT EXISTS (SELECT 1 FROM reconciliation_observations o
        WHERE o.run_id = ${run.id} AND o.external_id = m.external_id)
  `;
  // Publish evidence and the repair intent in the same transaction as confirmation.
  await tx.$executeRaw`
    INSERT INTO operation_attempt (key, connection_id, generation, reconciliation_id, repair_record_id, evidence)
    SELECT 'repair-' || f.run_id || '-' || md5(f.external_id), ${run.connectionId}, ${run.generation}, f.run_id, f.external_id, o.evidence
    FROM reconciliation_findings f JOIN reconciliation_observations o ON o.run_id=f.run_id AND o.external_id=f.external_id
    WHERE f.run_id=${run.id} AND f.confidence='confirmed' AND f.classification IN ('missing_locally','stale')
  `;
  await tx.reconciliationFinding.updateMany({
    where: {
      runId: run.id,
      confidence: "confirmed",
      classification: { in: ["missing_locally", "stale"] },
    },
    data: { repairStatus: "queued" },
  });
  await tx.reconciliationObservation.deleteMany({ where: { runId: run.id } });
}
async function commitPage(claim: Claim, page: Page) {
  const run = claim.reconciliation;
  await withClaim(claim, async (tx, connection) => {
    const current = await tx.reconciliationRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    if (
      current.status !== "traversing" ||
      current.page !== run.page ||
      connection.tokenStatus !== "connected"
    )
      return;
    if (page.items.length) {
      const written = await tx.reconciliationObservation.createMany({
        data: page.items.map((row) => ({
          runId: run.id,
          externalId: row.id,
          version: row.version,
          hash: mirrorPayload(row).hash,
          evidence: {
            id: row.id,
            name: row.name,
            version: row.version,
            revision: row.revision ?? 0,
            ...(row.amount === undefined ? {} : { amount: row.amount }),
          },
        })),
        skipDuplicates: true,
      });
      if (written.count !== page.items.length)
        throw new ProviderError(409, "snapshot_expired");
    }
    await classify(
      tx,
      run,
      !page.cursor,
      page.items.map((row) => row.id),
    );
    await tx.reconciliationRun.update({
      where: { id: run.id },
      data: {
        snapshot: page.snapshot,
        watermark: page.watermark,
        cursor: page.cursor,
        page: { increment: 1 },
        status: page.cursor ? "traversing" : "confirmed",
        finishedAt: page.cursor ? null : new Date(),
      },
    });
    if (page.cursor)
      await tx.operationAttempt.create({
        data: {
          key: "reconcile-" + run.id + "-" + (run.page + 1),
          connectionId: run.connectionId,
          generation: run.generation,
          reconciliationId: run.id,
        },
      });
    await resetFailures(tx, connection.id);
    await finish(tx, claim, "processed");
  });
}
async function repair(claim: Claim) {
  const run = claim.reconciliation;
  const id = claim.repairRecordId!;
  await withClaim(claim, async (tx, connection) => {
    const finding = await tx.reconciliationFinding.findFirst({
      where: {
        runId: run.id,
        externalId: id,
        confidence: "confirmed",
        repairStatus: "queued",
        classification: { in: ["missing_locally", "stale"] },
        run: { status: "confirmed", generation: connection.generation },
      },
    });
    const record = claim.evidence as unknown as Employee | null;
    if (
      !finding ||
      !record ||
      record.id !== id ||
      finding.providerVersion !== record.version
    ) {
      await fail(tx, claim, "repair_evidence_unavailable");
      return;
    }
    const outcome = await upsertMirror(
      tx,
      connection.id,
      run.resourceType,
      record,
    );
    await tx.reconciliationFinding.update({
      where: { runId_externalId: { runId: run.id, externalId: id } },
      data: {
        repairStatus: outcome.result === "applied" ? "applied" : "skipped",
        repairResult: outcome.result,
      },
    });
    await finish(tx, claim, outcome.result);
  });
}
export async function processReconciliation(key: string, generation: number) {
  const op = await claim(key, generation);
  if (!op) return;
  const run = op.reconciliation;
  telemetry("reconciliation_operation_started", {
    connectionId: run.connectionId,
    reconciliationId: run.id,
    attempt: op.attemptCount,
    queueLagMs: Math.max(0, Date.now() - op.dueAt.getTime()),
  });
  try {
    if (op.repairRecordId) {
      await repair(op);
      return;
    }
    const resource = run.resourceType;
    if (!isResource(resource)) throw new ProviderError(400, "invalid_resource");
    const query = new URLSearchParams({ since: "0" });
    if (run.snapshot) query.set("snapshot", run.snapshot);
    if (run.cursor) query.set("cursor", run.cursor);
    const page = await withAccess(run.connectionId, generation, (token) =>
      fetchPage(resource, token, query),
    );
    validateSnapshotPage(page, { ...run, since: 0 });
    await commitPage(op, page);
  } catch (error) {
    await onError(op, error);
  }
}
