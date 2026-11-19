import { Prisma } from "@prisma/client";
import { db, lockConnection } from "./db";
import { type Resource } from "./events";

export const reconciliationInterval = 60 * 60 * 1000;
export async function requestReconciliation(
  tx: Prisma.TransactionClient,
  id: string,
  resource: Resource,
  tenantId?: string,
  scheduled = false,
) {
  const connection = await lockConnection(tx, id);
  if (
    !connection ||
    (tenantId !== undefined && connection.tenantId !== tenantId) ||
    connection.lifecycle !== "active" ||
    connection.tokenStatus !== "connected" ||
    connection.pausedReason
  )
    return;
  const scheduleField =
    resource === "employees" ? "reconcileEmployeesAt" : "reconcilePayrunsAt";
  if (scheduled && connection[scheduleField].getTime() > Date.now()) return;
  await tx.connection.update({
    where: { id },
    data: { [scheduleField]: new Date(Date.now() + reconciliationInterval) },
  });
  const active = await tx.reconciliationRun.findFirst({
    where: { connectionId: id, resourceType: resource, status: "traversing" },
  });
  if (active) return active;
  const run = await tx.reconciliationRun.create({
    data: {
      connectionId: id,
      resourceType: resource,
      generation: connection.generation,
      trigger: scheduled ? "scheduled" : "manual",
    },
  });
  await tx.operationAttempt.create({
    data: {
      key: "reconcile-" + run.id + "-0",
      connectionId: id,
      generation: run.generation,
      reconciliationId: run.id,
    },
  });
  return run;
}

export async function abortReconciliation(
  tx: Prisma.TransactionClient,
  connectionId: string,
) {
  await tx.reconciliationRun.updateMany({
    where: { connectionId, status: "traversing" },
    data: {
      status: "provisional",
      reason: "connection_closing",
      finishedAt: new Date(),
    },
  });
  await tx.reconciliationFinding.updateMany({
    where: { run: { connectionId }, repairStatus: "queued" },
    data: { repairStatus: "aborted", repairResult: "generation_changed" },
  });
  await tx.reconciliationObservation.deleteMany({
    where: { run: { connectionId } },
  });
  await tx.operationAttempt.updateMany({
    where: { connectionId, reconciliationId: { not: null } },
    data: { evidence: Prisma.DbNull },
  });
}

export async function scheduleReconciliation() {
  const now = new Date();
  for (const [resource, field] of [
    ["employees", "reconcileEmployeesAt"],
    ["payruns", "reconcilePayrunsAt"],
  ] as const) {
    const due = await db.connection.findMany({
      where: {
        lifecycle: "active",
        tokenStatus: "connected",
        pausedReason: null,
        [field]: { lte: now },
      },
      orderBy: { [field]: "asc" },
      take: 20,
      select: { id: true },
    });
    for (const { id } of due)
      await db.$transaction((tx) =>
        requestReconciliation(tx, id, resource, undefined, true),
      );
  }
}
