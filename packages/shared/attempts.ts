import type { Prisma } from "@prisma/client";

export function attemptDelay(attemptCount: number) {
  return attemptCount
    ? 1500 * 2 ** (attemptCount - 1) + Math.floor(Math.random() * 150)
    : 0;
}
export async function pauseAttempts(
  tx: Prisma.TransactionClient,
  connectionId: string,
) {
  await tx.operationAttempt.updateMany({
    where: { connectionId, state: "pending", pausedAt: null },
    data: { pausedAt: new Date() },
  });
}
export async function resumeAttempts(
  tx: Prisma.TransactionClient,
  connectionId: string,
) {
  const pending = await tx.operationAttempt.findMany({
    where: { connectionId, state: "pending", pausedAt: { not: null } },
  });
  const now = Date.now();
  for (const attempt of pending) {
    if (!attempt.pausedAt) continue;
    const paused = attempt.pausedAt.getTime();
    await tx.operationAttempt.update({
      where: { key: attempt.key },
      data: {
        pausedAt: null,
        createdAt: new Date(attempt.createdAt.getTime() + now - paused),
        dueAt: new Date(
          now +
            Math.max(
              attemptDelay(attempt.attemptCount),
              attempt.dueAt.getTime() - paused,
            ),
        ),
      },
    });
  }
}
