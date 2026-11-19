import { validateSnapshotPage } from "../../packages/shared/snapshots";
import { randomUUID } from "node:crypto";
import { Prisma, type OperationAttempt, type SyncRun } from "@prisma/client";
import {
  allowClaim,
  errorEvidence,
  expired,
  failureDue,
  MAX_AGE,
  recordAttempt,
  resetFailures,
  WORK_LEASE,
} from "../../packages/shared/budget";
import { telemetry } from "../../packages/shared/telemetry";
import { pauseAttempts } from "../../packages/shared/attempts";
import { isResource } from "../../packages/shared/events";
import { upsertMirror } from "../../packages/shared/mirror";
import { db, lockConnection } from "../../packages/shared/db";
import {
  Employee,
  Page,
  ProviderError,
  fetchPage,
} from "../../packages/shared/provider";
import {
  ConnectionUnavailable,
  withAccess,
} from "../../packages/shared/tokens";

async function claim(key: string, generation?: number) {
  const target = await db.operationAttempt.findUnique({
    where: { key },
    include: { run: { select: { connectionId: true } } },
  });
  if (!target?.run) return;
  const connectionId = target.run.connectionId;
  return db.$transaction(async (tx) => {
    const connection = await lockConnection(tx, connectionId);
    if (
      connection?.lifecycle !== "active" ||
      connection.tokenStatus !== "connected"
    )
      return;
    const attempt = await tx.operationAttempt.findUnique({
      where: { key },
      include: { run: true },
    });
    if (
      !attempt?.run ||
      attempt.run.generation !== connection.generation ||
      (generation !== undefined && generation !== connection.generation) ||
      (attempt.run.status !== "queued" && attempt.run.status !== "running") ||
      !isDue(attempt)
    )
      return;
    if (!(await allowClaim(tx, connection))) return;
    if (attempt.run.status === "queued")
      await tx.syncRun.update({
        where: { id: attempt.run.id },
        data: { status: "running" },
      });
    if (expired(attempt)) {
      await tx.operationAttempt.update({
        where: { key },
        data: { state: "failed", claimToken: null, leaseUntil: null },
      });
      await tx.syncRun.update({
        where: { id: attempt.run.id },
        data: {
          status: attempt.run.page ? "partial" : "failed",
          error: "attempt_budget_exhausted",
        },
      });
      await pageDeadLetter(
        tx,
        attempt,
        attempt.run,
        connection.tenantId,
        "attempt_budget_exhausted",
      );
      return;
    }
    const next = await tx.operationAttempt.update({
      where: { key },
      data: {
        state: "claimed",
        attemptCount: { increment: 1 },
        claimToken: randomUUID(),
        leaseUntil: new Date(Date.now() + WORK_LEASE),
      },
    });
    await recordAttempt(tx, next.key, next.attemptCount, "started");
    return { ...next, run: attempt.run };
  });
}
function isDue(attempt: {
  state: string;
  dueAt: Date;
  leaseUntil: Date | null;
}) {
  const now = Date.now();
  return (
    attempt.dueAt.getTime() <= now &&
    (attempt.state === "pending" ||
      (attempt.state === "claimed" &&
        !!attempt.leaseUntil &&
        attempt.leaseUntil.getTime() <= now))
  );
}
type Claim = NonNullable<Awaited<ReturnType<typeof claim>>>;
async function ownClaim(
  tx: Prisma.TransactionClient,
  claim: Claim,
  requireConnected: boolean,
) {
  const connection = await lockConnection(tx, claim.run.connectionId);
  if (
    connection?.lifecycle !== "active" ||
    connection.generation !== claim.run.generation ||
    (requireConnected && connection.tokenStatus !== "connected")
  )
    return false;
  return !!(await tx.operationAttempt.findFirst({
    where: {
      key: claim.key,
      state: "claimed",
      claimToken: claim.claimToken,
      leaseUntil: { gt: new Date() },
      run: { status: "running", page: claim.run.page },
    },
  }));
}
async function writeRecord(
  tx: Prisma.TransactionClient,
  claim: Claim,
  row: Employee,
) {
  const connectionId = claim.run.connectionId;
  const resourceType = claim.run.resourceType;
  const outcome = await upsertMirror(tx, connectionId, resourceType, row);
  await tx.syncRecordOutcome.create({
    data: {
      runId: claim.run.id,
      recordKey: row.id,
      operationIdentity: claim.key,
      version: row.version,
      connectionId,
      resourceType,
      ...outcome,
    },
  });
}
async function commitPage(claim: Claim, page: Page) {
  await db.$transaction(async (tx) => {
    if (!(await ownClaim(tx, claim, true))) return;
    for (const row of page.items) await writeRecord(tx, claim, row);
    await tx.operationAttempt.update({
      where: { key: claim.key },
      data: { state: "done", claimToken: null, leaseUntil: null },
    });
    await recordAttempt(tx, claim.key, claim.attemptCount, "processed");
    if (!page.cursor)
      telemetry("sync_finished", {
        connectionId: claim.run.connectionId,
        syncRunId: claim.run.id,
        durationMs: Date.now() - claim.run.createdAt.getTime(),
      });
    await resetFailures(tx, claim.run.connectionId);
    if (claim.replayId && claim.deadLetterId) {
      await tx.replayAudit.update({
        where: { id: claim.replayId },
        data: { result: "resolved" },
      });
      await tx.deadLetter.update({
        where: { id: claim.deadLetterId },
        data: { state: "resolved" },
      });
    }
    const nextPage = claim.run.page + 1;
    await tx.syncRun.update({
      where: { id: claim.run.id },
      data: {
        page: nextPage,
        cursor: page.cursor,
        snapshot: page.snapshot,
        watermark: page.watermark,
        status: page.cursor ? "running" : "succeeded",
        error: null,
      },
    });
    if (page.cursor) {
      await tx.operationAttempt.create({
        data: {
          key: claim.run.id + "-" + nextPage,
          runId: claim.run.id,
          connectionId: claim.run.connectionId,
          generation: claim.run.generation,
        },
      });
    } else {
      const field =
        claim.run.resourceType === "payruns" ? "payrunWatermark" : "watermark";
      await tx.connection.updateMany({
        where: {
          id: claim.run.connectionId,
          [field]: { lt: page.watermark },
        },
        data: { [field]: page.watermark },
      });
    }
  });
}
async function finishError(claim: Claim, error: unknown) {
  await db.$transaction(async (tx) => {
    if (!(await ownClaim(tx, claim, false))) return;
    const connection = await tx.connection.findUniqueOrThrow({
      where: { id: claim.run.connectionId },
    });
    const paused =
      error instanceof ConnectionUnavailable &&
      connection.tokenStatus === "needs_reauth";
    const providerError = error instanceof ProviderError ? error : undefined;
    const reason = paused
      ? "needs_reauth"
      : (providerError?.reason ??
        (error instanceof ConnectionUnavailable
          ? "connection_error"
          : "local_processing_error"));
    const due = paused
      ? claim.dueAt
      : await failureDue(tx, connection, claim.attemptCount, error);
    const retry =
      (providerError?.retryable ||
        (!providerError && !(error instanceof ConnectionUnavailable))) &&
      !expired(claim) &&
      due.getTime() < claim.createdAt.getTime() + MAX_AGE;
    await tx.operationAttempt.update({
      where: { key: claim.key },
      data: {
        state: paused || retry ? "pending" : "failed",
        dueAt: paused ? claim.dueAt : due,
        pausedAt: paused ? new Date() : null,
        claimToken: null,
        leaseUntil: null,
      },
    });
    if (paused || connection.failureStreak >= 11)
      await pauseAttempts(tx, connection.id);
    await recordAttempt(tx, claim.key, claim.attemptCount, reason, error);
    if (!paused && !retry)
      await pageDeadLetter(
        tx,
        claim,
        claim.run,
        connection.tenantId,
        reason,
        error,
      );
    await tx.syncRun.update({
      where: { id: claim.run.id },
      data: {
        error: reason,
        status:
          paused || retry
            ? "running"
            : reason !== "snapshot_expired" && claim.run.page
              ? "partial"
              : "failed",
      },
    });
  });
}
export async function processPage(key: string, generation?: number) {
  const attempt = await claim(key, generation);
  if (!attempt) return;
  const { run } = attempt;
  telemetry("sync_page_started", {
    connectionId: run.connectionId,
    syncRunId: run.id,
    queueLagMs: Math.max(0, Date.now() - attempt.dueAt.getTime()),
    attempt: attempt.attemptCount,
  });
  const query = new URLSearchParams({ since: String(run.since) });
  if (run.cursor) query.set("cursor", run.cursor);
  if (run.snapshot) query.set("snapshot", run.snapshot);
  try {
    if (!isResource(run.resourceType))
      throw new ProviderError(400, "invalid_resource");
    const resource = run.resourceType;
    const page = await withAccess(run.connectionId, run.generation, (token) =>
      fetchPage(resource, token, query),
    );
    validateSnapshotPage(page, attempt.run);
    await commitPage(attempt, page);
  } catch (error) {
    await finishError(attempt, error);
  }
}
export function duePages() {
  return db.$queryRaw<Array<{ key: string; generation: number }>>`
    SELECT key, generation FROM (
      SELECT a.key, c.generation, a.due_at,
        row_number() OVER (PARTITION BY c.tenant_id ORDER BY a.due_at, a.key) AS tenant_position
      FROM operation_attempt a
      JOIN sync_runs r ON r.id = a.run_id
      JOIN connections c ON c.id = r.connection_id
      WHERE a.due_at <= CURRENT_TIMESTAMP
        AND (a.state = 'pending' OR (a.state = 'claimed' AND a.lease_until <= CURRENT_TIMESTAMP))
        AND r.status IN ('queued','running') AND r.generation = c.generation
        AND c.lifecycle = 'active' AND c.token_status = 'connected' AND c.paused_reason IS NULL
        AND (c.rate_until IS NULL OR c.rate_until <= CURRENT_TIMESTAMP)
    ) ready ORDER BY tenant_position, due_at LIMIT 50
  `;
}
async function pageDeadLetter(
  tx: Prisma.TransactionClient,
  attempt: OperationAttempt,
  run: SyncRun,
  tenantId: string,
  reason: string,
  error?: unknown,
) {
  if (attempt.deadLetterId && attempt.replayId) {
    await tx.deadLetter.update({
      where: { id: attempt.deadLetterId },
      data: { state: "reopened" },
    });
    await tx.replayAudit.update({
      where: { id: attempt.replayId },
      data: { result: "reopened" },
    });
  } else {
    await tx.deadLetter.upsert({
      where: {
        connectionId_operationKey: {
          connectionId: run.connectionId,
          operationKey: attempt.key,
        },
      },
      update: {},
      create: {
        connectionId: run.connectionId,
        tenantId,
        operationKey: attempt.key,
        runId: run.id,
        reason,
        payload: {
          resource: run.resourceType,
          cursor: run.cursor,
          snapshot: run.snapshot,
          page: run.page,
        },
        providerError: errorEvidence(error),
      },
    });
  }
}
