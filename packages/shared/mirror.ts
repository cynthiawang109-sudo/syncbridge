import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Employee } from "./provider";

export async function upsertMirror(
  tx: Prisma.TransactionClient,
  connectionId: string,
  resourceType: string,
  row: Employee,
  tombstone = false,
) {
  const payload = JSON.stringify(
    tombstone
      ? { id: row.id, version: row.version, deleted: true }
      : {
          id: row.id,
          name: row.name,
          version: row.version,
          ...(row.amount === undefined ? {} : { amount: row.amount }),
        },
  );
  const hash = createHash("sha256").update(payload).digest("hex");
  const applied = await tx.$queryRaw<{ version: number }[]>`
    INSERT INTO external_records (connection_id, resource_type, external_id, version, payload_hash, payload, tombstone, last_synced_at)
    VALUES (${connectionId}, ${resourceType}, ${row.id}, ${row.version}, ${hash}, ${payload}::jsonb, ${tombstone}, CURRENT_TIMESTAMP)
    ON CONFLICT (connection_id, resource_type, external_id)
    DO UPDATE SET version=excluded.version, payload_hash=excluded.payload_hash, payload=excluded.payload,
      tombstone=excluded.tombstone, last_synced_at=excluded.last_synced_at
    WHERE external_records.version < excluded.version
    RETURNING version`;
  if (applied.length) return { result: "applied", conflictHash: null };
  const current = await tx.externalRecord.findUniqueOrThrow({
    where: {
      connectionId_resourceType_externalId: {
        connectionId,
        resourceType,
        externalId: row.id,
      },
    },
  });
  const result =
    current.version > row.version
      ? "stale"
      : current.payloadHash === hash
        ? "unchanged"
        : "conflict";
  return { result, conflictHash: result === "conflict" ? hash : null };
}
