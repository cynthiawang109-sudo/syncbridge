import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db, lockConnection } from "../../packages/shared/db";
import {
  Employee,
  Page,
  ProviderError,
  fetchEmployees,
} from "../../packages/shared/provider";
import {
  ConnectionUnavailable,
  withAccess,
} from "../../packages/shared/tokens";

const MAX_ATTEMPTS = 4;
const MAX_AGE = 10 * 60 * 1000;
const LEASE = 30000;
const activeRuns = ["queued", "running"] as const;

function expired(attempt: { attemptCount: number; createdAt: Date }) {
  return (
    attempt.attemptCount >= MAX_ATTEMPTS ||
    Date.now() - attempt.createdAt.getTime() >= MAX_AGE
  );
}
async function claim(key: string) {
  const target = await db.operationAttempt.findUnique({
    where: { key },
    include: { run: { select: { connectionId: true } } },
  });
  if (!target) return;
  return db.$transaction(async (tx) => {
    const connection = await lockConnection(tx, target.run.connectionId);
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
      !attempt ||
      attempt.run.generation !== connection.generation ||
      (attempt.run.status !== "queued" && attempt.run.status !== "running") ||
      !isDue(attempt)
    )
      return;
    if (attempt.run.status === "queued")
      await tx.syncRun.update({
        where: { id: attempt.runId },
        data: { status: "running" },
      });
    if (expired(attempt)) {
      await tx.operationAttempt.update({
        where: { key },
        data: { state: "failed", claimToken: null, leaseUntil: null },
      });
      await tx.syncRun.update({
        where: { id: attempt.runId },
        data: {
          status: attempt.run.page ? "partial" : "failed",
          error: "attempt_budget_exhausted",
        },
      });
      return;
    }
    return tx.operationAttempt.update({
      where: { key },
      data: {
        state: "claimed",
        attemptCount: { increment: 1 },
        claimToken: randomUUID(),
        leaseUntil: new Date(Date.now() + LEASE),
      },
      include: { run: true },
    });
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
  const payload = JSON.stringify({
    id: row.id,
    name: row.name,
    version: row.version,
  });
  const hash = createHash("sha256").update(payload).digest("hex");
  const applied = await tx.$queryRaw<{ version: number }[]>`
    INSERT INTO external_records (connection_id, resource_type, external_id, version, payload_hash, payload, tombstone, last_synced_at)
    VALUES (${connectionId}, ${resourceType}, ${row.id}, ${row.version}, ${hash}, ${payload}::jsonb, false, CURRENT_TIMESTAMP)
    ON CONFLICT (connection_id, resource_type, external_id)
    DO UPDATE SET version=excluded.version, payload_hash=excluded.payload_hash, payload=excluded.payload,
      tombstone=excluded.tombstone, last_synced_at=excluded.last_synced_at
    WHERE external_records.version < excluded.version
    RETURNING version`;
  let result = "applied";
  if (!applied.length) {
    const current = await tx.externalRecord.findUniqueOrThrow({
      where: {
        connectionId_resourceType_externalId: {
          connectionId,
          resourceType,
          externalId: row.id,
        },
      },
    });
    result =
      current.version > row.version
        ? "stale"
        : current.payloadHash === hash
          ? "unchanged"
          : "conflict";
  }
  await tx.syncRecordOutcome.create({
    data: {
      runId: claim.runId,
      recordKey: row.id,
      operationIdentity: claim.key,
      version: row.version,
      connectionId,
      resourceType,
      result,
      conflictHash: result === "conflict" ? hash : null,
    },
  });
}
function validatePage(page: Page, claim: Claim) {
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 100 ||
    !page.items.every(
      (row) =>
        row &&
        typeof row.id === "string" &&
        row.id &&
        typeof row.name === "string" &&
        Number.isSafeInteger(row.version) &&
        row.version > 0 &&
        row.version <= 2147483647,
    ) ||
    new Set(page.items.map((row) => row.id)).size !== page.items.length ||
    typeof page.snapshot !== "string" ||
    !page.snapshot ||
    !Number.isSafeInteger(page.watermark) ||
    page.watermark < claim.run.since ||
    page.watermark > 2147483647 ||
    (page.cursor !== null &&
      (typeof page.cursor !== "string" ||
        !page.cursor ||
        page.cursor === claim.run.cursor))
  ) {
    throw new ProviderError(502, "invalid_provider_page");
  }
  if (
    claim.run.snapshot &&
    (page.snapshot !== claim.run.snapshot ||
      page.watermark !== claim.run.watermark)
  ) {
    throw new ProviderError(409, "snapshot_expired");
  }
}
async function commitPage(claim: Claim, page: Page) {
  await db.$transaction(async (tx) => {
    if (!(await ownClaim(tx, claim, true))) return;
    for (const row of page.items) await writeRecord(tx, claim, row);
    await tx.operationAttempt.update({
      where: { key: claim.key },
      data: { state: "done", claimToken: null, leaseUntil: null },
    });
    const nextPage = claim.run.page + 1;
    await tx.syncRun.update({
      where: { id: claim.runId },
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
        data: { key: claim.runId + "-" + nextPage, runId: claim.runId },
      });
    } else {
      await tx.connection.updateMany({
        where: {
          id: claim.run.connectionId,
          watermark: { lt: page.watermark },
        },
        data: { watermark: page.watermark },
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
    const delay = Math.max(
      providerError?.retryAfter ?? 0,
      1500 * 2 ** (claim.attemptCount - 1) + Math.floor(Math.random() * 150),
    );
    const due = new Date(Date.now() + delay);
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
        claimToken: null,
        leaseUntil: null,
      },
    });
    await tx.syncRun.update({
      where: { id: claim.runId },
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
export async function processPage(key: string) {
  const attempt = await claim(key);
  if (!attempt) return;
  const { run } = attempt;
  const query = new URLSearchParams({ since: String(run.since) });
  if (run.cursor) query.set("cursor", run.cursor);
  if (run.snapshot) query.set("snapshot", run.snapshot);
  try {
    const page = await withAccess(run.connectionId, run.generation, (token) =>
      fetchEmployees(token, query),
    );
    validatePage(page, attempt);
    await commitPage(attempt, page);
  } catch (error) {
    await finishError(attempt, error);
  }
}
export function duePages() {
  const now = new Date();
  return db.operationAttempt.findMany({
    where: {
      dueAt: { lte: now },
      OR: [
        { state: "pending" },
        { state: "claimed", leaseUntil: { lte: now } },
      ],
      run: {
        status: { in: [...activeRuns] },
        connection: { lifecycle: "active", tokenStatus: "connected" },
      },
    },
    select: { key: true },
    orderBy: { dueAt: "asc" },
    take: 50,
  });
}
