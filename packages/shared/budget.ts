import { Prisma, type Connection } from "@prisma/client";
import { attemptDelay } from "./attempts";
import { ProviderError } from "./provider";

export const MAX_ATTEMPTS = 4;
export const MAX_AGE = 10 * 60000;
export const WORK_LEASE = 30000;
export function expired(attempt: { attemptCount: number; createdAt: Date }) {
  return (
    attempt.attemptCount >= MAX_ATTEMPTS ||
    Date.now() - attempt.createdAt.getTime() >= MAX_AGE
  );
}
export async function allowClaim(
  tx: Prisma.TransactionClient,
  connection: Connection,
) {
  if (
    connection.pausedReason ||
    (connection.rateUntil?.getTime() ?? 0) > Date.now()
  )
    return false;
  await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(725139)) AS budget`;
  const groups = await tx.operationAttempt.groupBy({
    by: ["connectionId"],
    where: { state: "claimed", leaseUntil: { gt: new Date() } },
    _count: { _all: true },
  });
  return (
    groups.reduce((sum, group) => sum + group._count._all, 0) < 6 &&
    (groups.find((group) => group.connectionId === connection.id)?._count
      ._all ?? 0) < 2
  );
}
export function errorEvidence(
  error: unknown,
): Prisma.InputJsonValue | undefined {
  const payload = error instanceof ProviderError ? error.payload : undefined;
  return payload == null
    ? undefined
    : (JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue);
}
export async function recordAttempt(
  tx: Prisma.TransactionClient,
  key: string,
  attempt: number,
  result: string,
  error?: unknown,
) {
  const providerError = errorEvidence(error);
  await tx.attemptHistory.upsert({
    where: { operationKey_attempt: { operationKey: key, attempt } },
    create: { operationKey: key, attempt, result, providerError },
    update: { result, providerError },
  });
}
export async function failureDue(
  tx: Prisma.TransactionClient,
  connection: Connection,
  count: number,
  error: unknown,
) {
  const retryAfter = error instanceof ProviderError ? error.retryAfter : 0;
  const rateStreak =
    error instanceof ProviderError && error.status === 429
      ? connection.rateStreak + 1
      : 0;
  const delay = Math.max(
    retryAfter,
    attemptDelay(count),
    rateStreak >= 2 ? Math.min(30000, 3000 * 2 ** (rateStreak - 2)) : 0,
  );
  const dueAt = new Date(Date.now() + delay);
  const failureStreak = connection.failureStreak + 1;
  await tx.connection.update({
    where: { id: connection.id },
    data: {
      failureStreak,
      rateStreak,
      rateUntil: rateStreak >= 2 ? dueAt : null,
      pausedReason: failureStreak >= 12 ? "poison_message_rate" : undefined,
    },
  });
  return dueAt;
}
export async function resetFailures(tx: Prisma.TransactionClient, id: string) {
  await tx.connection.update({
    where: { id },
    data: { failureStreak: 0, rateStreak: 0, rateUntil: null },
  });
}
