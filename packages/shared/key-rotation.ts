import { db } from "./db";
import { Envelope, LocalKeyProvider } from "./crypto";
import { Tokens } from "./provider";

const keys = new LocalKeyProvider();
const envelope = new Envelope(keys);
let after: string | undefined;
export async function rewrapTokenBatch() {
  const rows = await db.connection.findMany({
    where: {
      id: { gt: after },
      lifecycle: "active",
      keyVersion: { not: keys.currentVersion },
      encryptedTokens: { not: null },
    },
    orderBy: { id: "asc" },
    take: 25,
  });
  after = rows.length === 25 ? rows[24].id : undefined;
  for (const row of rows) {
    if (!row.keyVersion || !row.encryptedTokens) continue;
    try {
      const value = envelope.decrypt<Tokens>(
        row.encryptedTokens,
        row.keyVersion,
        row.id,
      );
      await db.connection.updateMany({
        where: {
          id: row.id,
          lifecycle: "active",
          generation: row.generation,
          keyVersion: row.keyVersion,
          encryptedTokens: row.encryptedTokens,
        },
        data: envelope.encrypt(value, row.id),
      });
    } catch {
      console.error(
        JSON.stringify({ event: "token_rewrap_failed", connectionId: row.id }),
      );
    }
  }
}
