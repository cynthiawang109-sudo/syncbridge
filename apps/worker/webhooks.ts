import { createHash, randomUUID } from "node:crypto";
import { Prisma, type OperationAttempt } from "@prisma/client";
import {
  archiveAudit,
  archiveItem,
  claimArchive,
  dueEvents,
  expireArchiveItem,
  openReceipt,
  projectArchive,
  type ArchiveItem,
} from "../../packages/shared/archive";
import { db, lockConnection } from "../../packages/shared/db";
import { parseEvent, type ProviderEvent } from "../../packages/shared/events";
import { fetchRecord, ProviderError } from "../../packages/shared/provider";
import {
  ConnectionUnavailable,
  withAccess,
} from "../../packages/shared/tokens";
import { pauseAttempts } from "../../packages/shared/attempts";
import { telemetry } from "../../packages/shared/telemetry";
import { upsertMirror } from "../../packages/shared/mirror";
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
import { createQueue, type PageJob } from "../../packages/shared/queue";

export function eventKey(
  item: Pick<ArchiveItem, "connection_id" | "event_id">,
) {
  return (
    "hook-" +
    createHash("sha256")
      .update(item.connection_id + ":" + item.event_id)
      .digest("hex")
  );
}
async function fencedArchive<T>(item: ArchiveItem, write: () => Promise<T>) {
  return db.$transaction(async (tx) => {
    const connection = await lockConnection(tx, item.connection_id);
    if (
      connection?.lifecycle !== "active" ||
      connection.generation !== item.generation ||
      connection.tenantId !== item.tenant_id
    )
      return;
    return write();
  });
}
function project(
  item: ArchiveItem,
  update: Parameters<typeof projectArchive>[1],
) {
  return fencedArchive(item, () => projectArchive(item, update));
}
async function converge(item: ArchiveItem, operation: OperationAttempt) {
  if (operation.state === "done" || operation.state === "failed") {
    return project(item, {
      status: operation.state === "done" ? "processed" : "dead_lettered",
      due: operation.dueAt.getTime(),
      attempt: operation.attemptCount,
      dlq: operation.deadLetterId ?? undefined,
    });
  }
  if (
    operation.dueAt.getTime() > Date.now() ||
    (operation.state === "pending" &&
      item.status === "leased" &&
      item.attempt_count !== operation.attemptCount)
  ) {
    return project(item, {
      status: "pending",
      due: operation.dueAt.getTime(),
      attempt: operation.attemptCount,
    });
  }
  return false;
}
export async function dispatchArchiveItem(
  item: ArchiveItem,
  queue: ReturnType<typeof createQueue>,
) {
  if (item.due_at > Date.now()) return;
  const operation = await db.$transaction(async (tx) => {
    const connection = await lockConnection(tx, item.connection_id);
    if (
      connection?.lifecycle !== "active" ||
      connection.tenantId !== item.tenant_id ||
      connection.generation !== item.generation
    )
      return;
    return tx.operationAttempt.upsert({
      where: { key: eventKey(item) },
      update: {},
      create: {
        key: eventKey(item),
        connectionId: connection.id,
        generation: connection.generation,
        eventId: item.event_id,
        dueAt: new Date(item.received_at),
        evidence: parseEvent(JSON.parse(openReceipt(item).toString("utf8"))),
      },
    });
  });
  if (!operation) return;
  if (await converge(item, operation)) return;
  const connection = await db.connection.findUniqueOrThrow({
    where: { id: item.connection_id },
  });
  if (
    connection.tokenStatus !== "connected" ||
    connection.pausedReason ||
    (connection.rateUntil?.getTime() ?? 0) > Date.now()
  )
    return;
  if (
    operation.state === "claimed" &&
    (operation.leaseUntil?.getTime() ?? 0) > Date.now()
  )
    return;
  const leased = await fencedArchive(item, () => claimArchive(item));
  if (leased) {
    await queue.add(
      "webhook",
      {
        operationKey: operation.key,
        generation: item.generation,
        leaseToken: leased.lease_token,
      },
      { jobId: operation.key + "-" + leased.lease_generation },
    );
  }
}
let auditCursor: Record<string, unknown> | undefined;
const indexCursors: Partial<
  Record<"pending" | "leased", Record<string, unknown>>
> = {};
let nextAudit = 0;
export async function sweepWebhooks(
  queue: ReturnType<typeof createQueue>,
  now = Date.now(),
) {
  const [pending, leased] = await Promise.all([
    dueEvents("pending", now, indexCursors.pending),
    dueEvents("leased", now, indexCursors.leased),
  ]);
  indexCursors.pending = pending.cursor;
  indexCursors.leased = leased.cursor;
  for (const item of [...pending.items, ...leased.items])
    await dispatchArchiveItem(item, queue);
  if (now >= nextAudit) {
    const batch = await archiveAudit(auditCursor, now);
    auditCursor = batch.cursor;
    nextAudit = batch.cursor ? now : now + 60000;
    for (const item of batch.items) {
      if (item.status === "pending" || item.status === "leased") {
        console.warn(
          JSON.stringify({
            event: "aged_webhook",
            connectionId: item.connection_id,
            eventId: item.event_id,
          }),
        );
        await dispatchArchiveItem(item, queue);
      } else await expireArchiveItem(item, now);
    }
  }
}
export async function dueReplays() {
  const now = new Date();
  return db.operationAttempt.findMany({
    where: {
      replayId: { not: null },
      runId: null,
      dueAt: { lte: now },
      OR: [
        { state: "pending" },
        { state: "claimed", leaseUntil: { lte: now } },
      ],
    },
    select: { key: true, generation: true },
    orderBy: { dueAt: "asc" },
    take: 25,
  });
}
async function claim(job: PageJob, item: ArchiveItem | undefined) {
  const operation = await db.operationAttempt.findUnique({
    where: { key: job.operationKey },
  });
  if (
    !operation?.connectionId ||
    !operation.eventId ||
    operation.generation !== job.generation ||
    (!operation.replayId && !item)
  )
    return;
  const connectionId = operation.connectionId;
  return db.$transaction(async (tx) => {
    const connection = await lockConnection(tx, connectionId);
    if (
      connection?.lifecycle !== "active" ||
      connection.generation !== operation.generation ||
      connection.tokenStatus !== "connected" ||
      (item && connection.tenantId !== item.tenant_id)
    )
      return;
    const current = await tx.operationAttempt.findUniqueOrThrow({
      where: { key: operation.key },
    });
    if (
      current.dueAt.getTime() > Date.now() ||
      (current.state !== "pending" &&
        !(
          current.state === "claimed" &&
          (current.leaseUntil?.getTime() ?? Infinity) <= Date.now()
        ))
    )
      return;
    if (!(await allowClaim(tx, connection))) return;
    const expires = item?.lease_expires_at ?? Date.now() + WORK_LEASE;
    if (expires <= Date.now()) return;
    const exhausted = expired(current);
    const next = await tx.operationAttempt.update({
      where: { key: current.key },
      data: {
        state: "claimed",
        claimToken: randomUUID(),
        leaseUntil: new Date(expires),
        attemptCount: exhausted ? undefined : { increment: 1 },
      },
    });
    if (!exhausted)
      await recordAttempt(tx, next.key, next.attemptCount, "started");
    return { operation: next, connection, exhausted };
  });
}
async function complete(
  claimed: NonNullable<Awaited<ReturnType<typeof claim>>>,
  event: ProviderEvent,
  record: Awaited<ReturnType<typeof fetchRecord>> | undefined,
  error: unknown,
  archiveAbsent: boolean,
) {
  const { operation } = claimed;
  return db.$transaction(async (tx) => {
    const connection = await lockConnection(tx, claimed.connection.id);
    if (
      connection?.lifecycle !== "active" ||
      connection.generation !== operation.generation
    )
      return;
    const current = await tx.operationAttempt.findFirst({
      where: {
        key: operation.key,
        state: "claimed",
        claimToken: operation.claimToken,
        leaseUntil: { gt: new Date() },
      },
    });
    if (!current) return;
    if (record) {
      const outcome = await upsertMirror(
        tx,
        connection.id,
        event.resource,
        record,
        event.action === "delete",
      );
      await tx.webhookOutcome.create({
        data: {
          operationKey: operation.key,
          connectionId: connection.id,
          eventId: event.id,
          eventVersion: event.version,
          fetchedVersion: event.action === "delete" ? null : record.version,
          ...outcome,
        },
      });
      await recordAttempt(
        tx,
        operation.key,
        operation.attemptCount,
        outcome.result,
      );
      await resetFailures(tx, connection.id);
      if (operation.replayId && operation.deadLetterId) {
        await tx.deadLetter.update({
          where: { id: operation.deadLetterId },
          data: { state: "resolved" },
        });
        await tx.replayAudit.update({
          where: { id: operation.replayId },
          data: { result: "resolved", archiveAbsent },
        });
      }
      return tx.operationAttempt.update({
        where: { key: operation.key },
        data: {
          state: "done",
          claimToken: null,
          leaseUntil: null,
          projectionPending: !!operation.replayId && !archiveAbsent,
        },
      });
    }
    const providerError = error instanceof ProviderError ? error : undefined;
    const connectionError = error instanceof ConnectionUnavailable;
    const reason =
      providerError?.status === 404
        ? "unresolved"
        : (providerError?.reason ??
          (connectionError ? "connection_error" : "local_processing_error"));
    const paused = connection.tokenStatus === "needs_reauth";
    const due = paused
      ? current.dueAt
      : await failureDue(tx, connection, current.attemptCount, error);
    const retry =
      paused ||
      (!claimed.exhausted &&
        !expired(current) &&
        due.getTime() < current.createdAt.getTime() + MAX_AGE &&
        !connectionError &&
        (!providerError ||
          providerError.retryable ||
          providerError.status === 404));
    await recordAttempt(
      tx,
      current.key,
      current.attemptCount,
      paused ? "needs_reauth" : reason,
      error,
    );
    const deadId = retry
      ? null
      : await deadLetter(
          tx,
          current,
          connection.tenantId,
          event,
          reason,
          error,
          archiveAbsent,
        );
    const next = await tx.operationAttempt.update({
      where: { key: current.key },
      data: {
        state: retry ? "pending" : "failed",
        claimToken: null,
        leaseUntil: null,
        dueAt: due,
        pausedAt: paused ? new Date() : null,
        deadLetterId: deadId ?? current.deadLetterId,
        projectionPending: !retry && !!current.replayId && !archiveAbsent,
      },
    });
    if (paused || connection.failureStreak >= 11)
      await pauseAttempts(tx, connection.id);
    return next;
  });
}
async function deadLetter(
  tx: Prisma.TransactionClient,
  operation: OperationAttempt,
  tenantId: string,
  event: ProviderEvent,
  reason: string,
  error: unknown,
  archiveAbsent: boolean,
) {
  if (operation.replayId && operation.deadLetterId) {
    await tx.deadLetter.update({
      where: { id: operation.deadLetterId },
      data: { state: "reopened" },
    });
    await tx.replayAudit.update({
      where: { id: operation.replayId },
      data: { result: "reopened", archiveAbsent },
    });
    return operation.deadLetterId;
  }
  const connectionId = operation.connectionId!;
  const entry = await tx.deadLetter.upsert({
    where: {
      connectionId_operationKey: { connectionId, operationKey: operation.key },
    },
    update: {},
    create: {
      connectionId,
      tenantId,
      operationKey: operation.key,
      eventId: event.id,
      reason,
      payload: event,
      providerError: errorEvidence(error),
    },
  });
  return entry.id;
}
export async function processWebhook(job: PageJob) {
  const operation = await db.operationAttempt.findUnique({
    where: { key: job.operationKey },
  });
  if (!operation?.connectionId || !operation.eventId) return;
  const item = await archiveItem(operation.connectionId, operation.eventId);
  if (
    !operation.replayId &&
    (item?.status !== "leased" || item.lease_token !== job.leaseToken)
  )
    return;
  const claimed = await claim(job, operation.replayId ? undefined : item);
  if (!claimed) return;
  if (operation.replayId)
    await db.replayAudit.update({
      where: { id: operation.replayId },
      data: { result: "running", archiveAbsent: !item },
    });
  const event = parseEvent(operation.evidence);
  telemetry("webhook_started", {
    connectionId: claimed.connection.id,
    eventId: event.id,
    attempt: claimed.operation.attemptCount,
    queueLagMs: Math.max(0, Date.now() - claimed.operation.dueAt.getTime()),
  });
  let record;
  let error;
  try {
    if (claimed.exhausted)
      throw new ProviderError(400, "attempt_budget_exhausted");
    if (event.action === "delete")
      record = {
        id: event.externalId,
        version: event.version,
        name: "",
        revision: 0,
      };
    else
      record = await withAccess(
        claimed.connection.id,
        claimed.connection.generation,
        (token) => fetchRecord(event.resource, event.externalId, token),
      );
    if (
      !record ||
      record.id !== event.externalId ||
      typeof record.name !== "string" ||
      !Number.isInteger(record.version) ||
      record.version < event.version ||
      record.version > 2147483647
    ) {
      record = undefined;
      throw new ProviderError(503, "snapshot_behind_event");
    }
  } catch (cause) {
    error = cause;
  }
  const result = await complete(claimed, event, record, error, !item);
  if (!result) return;
  if (result.replayId) {
    if (result.projectionPending) await projectReplay(result);
  } else if (item) {
    if (result.state === "pending")
      await project(item, {
        status: "pending",
        due: result.dueAt.getTime(),
        attempt: result.attemptCount,
      });
    else await converge(item, result);
  }
}
async function projectReplay(operation: OperationAttempt) {
  if (!operation.connectionId || !operation.eventId || !operation.replayId)
    return;
  const item = await archiveItem(operation.connectionId, operation.eventId);
  if (
    item &&
    item.replay_id !== operation.replayId &&
    !(await project(item, {
      status: operation.state === "done" ? "processed" : "dead_lettered",
      due: operation.dueAt.getTime(),
      attempt: item.attempt_count,
      dlq: operation.deadLetterId ?? undefined,
      replay: operation.replayId,
    }))
  )
    return;
  await db.$transaction(async (tx) => {
    await tx.operationAttempt.update({
      where: { key: operation.key },
      data: { projectionPending: false },
    });
    if (!item)
      await tx.replayAudit.update({
        where: { id: operation.replayId! },
        data: { archiveAbsent: true },
      });
  });
}
export async function projectReplays() {
  const items = await db.operationAttempt.findMany({
    where: { projectionPending: true },
    take: 25,
  });
  for (const item of items) await projectReplay(item);
}
