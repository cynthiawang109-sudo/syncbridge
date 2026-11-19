import {
  eraseConnectionArchive,
  hasConnectionArchive,
  ARCHIVE_LEASE_MS,
} from "../../packages/shared/archive";
import { db, lockConnection } from "../../packages/shared/db";
import { revokeToken } from "../../packages/shared/provider";
import { readTokens } from "../../packages/shared/tokens";
import { WORK_LEASE } from "../../packages/shared/budget";

export async function closeConnections(now = Date.now()) {
  const items = await db.connection.findMany({
    where: {
      lifecycle: "closing",
      OR: [{ cleanupAt: null }, { cleanupAt: { lte: new Date(now) } }],
    },
    orderBy: { id: "asc" },
    take: 20,
  });
  for (const entry of items) {
    if (!entry.cleanupAt && entry.encryptedTokens) {
      await revokeToken(readTokens(entry).refresh_token);
    }
    await eraseConnectionArchive(entry.id, entry.tenantId);
    if (await hasConnectionArchive(entry.id)) continue;
    await db.$transaction(async (tx) => {
      const current = await lockConnection(tx, entry.id);
      if (
        current?.lifecycle !== "closing" ||
        current.generation !== entry.generation ||
        current.cleanupAt?.getTime() !== entry.cleanupAt?.getTime()
      )
        return;
      await tx.syncRecordOutcome.deleteMany({
        where: { connectionId: entry.id },
      });
      await tx.webhookOutcome.deleteMany({ where: { connectionId: entry.id } });
      await tx.externalRecord.deleteMany({ where: { connectionId: entry.id } });
      if (await tx.externalRecord.count({ where: { connectionId: entry.id } }))
        return;
      await tx.connection.update({
        where: { id: entry.id },
        data: {
          cleanupAt:
            entry.cleanupAt ??
            new Date(now + Math.max(ARCHIVE_LEASE_MS, WORK_LEASE)),
          lifecycle: entry.cleanupAt ? "deleted" : "closing",
          tokenStatus: "disconnected",
          encryptedTokens: null,
          keyVersion: null,
          oauthStateHash: null,
          oauthVerifier: null,
          oauthExpiresAt: null,
          tokenExpiresAt: null,
          refreshLeaseUntil: null,
        },
      });
      await tx.authorizationAudit.create({
        data: {
          actor: "offboarding",
          object: entry.id,
          reason: entry.cleanupAt
            ? "closing_verified_after_lease"
            : "closing_verified_initial",
        },
      });
    });
  }
}
