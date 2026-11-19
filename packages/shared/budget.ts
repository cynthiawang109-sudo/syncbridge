import { Prisma, type Connection } from "@prisma/client";
import { attemptDelay } from "./attempts";
import { ProviderError } from "./provider";
import { telemetry } from "./telemetry";

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
  const [slots] = await tx.$queryRaw<
    { total: bigint; connection: bigint; tenant: bigint }[]
  >`
    SELECT count(*) AS total,
      count(*) FILTER (WHERE c.id = ${connection.id}) AS connection,
      count(*) FILTER (WHERE c.tenant_id = ${connection.tenantId}) AS tenant
    FROM operation_attempt a JOIN connections c ON c.id = a.connection_id
    WHERE a.state = 'claimed' AND a.lease_until > CURRENT_TIMESTAMP
  `;
  return slots.total < 6n && slots.connection < 2n && slots.tenant < 4n;
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
  telemetry("provider_failure", {
    connectionId: connection.id,
    attempt: count,
    dueAtMs: dueAt.getTime(),
    status: error instanceof ProviderError ? error.status : undefined,
  });
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
