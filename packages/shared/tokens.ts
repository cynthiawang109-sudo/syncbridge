import { setTimeout as sleep } from "node:timers/promises";
import { Connection, Prisma } from "@prisma/client";
import { db, lockConnection } from "./db";
import { Envelope } from "./crypto";
import { telemetry } from "./telemetry";
import {
  ProviderError,
  REFRESH_TIMEOUT,
  Tokens,
  tokenRequest,
} from "./provider";

const envelope = new Envelope();
const LEASE_MS = 5000;
const PROACTIVE_MS = 30000;
export class ConnectionUnavailable extends Error {}
export function tokenData(id: string, tokens: Tokens) {
  return {
    ...envelope.encrypt(tokens, id),
    tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    scopes: tokens.scope.split(" "),
    tokenStatus: "connected" as const,
    tokenError: null,
    tokenVersion: { increment: 1 },
  };
}
export function readTokens(row: Connection) {
  if (!row.encryptedTokens || !row.keyVersion)
    throw new ConnectionUnavailable("disconnected");
  return envelope.decrypt<Tokens>(row.encryptedTokens, row.keyVersion, row.id);
}
function isUsable(
  row: Connection | null,
  generation: number,
): row is Connection & { lifecycle: "active"; tokenStatus: "connected" } {
  return (
    !!row &&
    row.lifecycle === "active" &&
    row.generation === generation &&
    row.tokenStatus === "connected"
  );
}
function fence(row: Connection) {
  return {
    id: row.id,
    generation: row.generation,
    lifecycle: "active" as const,
    tokenStatus: "connected" as const,
    tokenVersion: row.tokenVersion,
    refreshGeneration: row.refreshGeneration,
  };
}
async function stillOwns(row: Connection) {
  return !!(await db.connection.findFirst({
    where: {
      ...fence(row),
      refreshLeaseUntil: { gt: new Date(Date.now() + REFRESH_TIMEOUT) },
    },
  }));
}
async function finishFailure(
  row: Connection,
  status: "needs_reauth" | "error" | "connected",
  reason: string,
) {
  const updated = await db.connection.updateMany({
    where: fence(row),
    data: { tokenStatus: status, tokenError: reason, refreshLeaseUntil: null },
  });
  if (updated.count)
    telemetry(
      "token_refresh_error",
      { connectionId: row.id, status, reason },
      "warn",
    );
  return updated.count > 0;
}
function openUsable(row: Connection) {
  return { tokens: readTokens(row), version: row.tokenVersion };
}
export async function accessFor(
  id: string,
  generation: number,
  rejectedVersion?: number,
) {
  const deadline = Date.now() + LEASE_MS + 1000;
  while (Date.now() < deadline) {
    const claim = await db
      .$transaction(
        async (tx) => {
          const row = await lockConnection(tx, id);
          if (!isUsable(row, generation))
            throw new ConnectionUnavailable(row?.tokenStatus ?? "missing");
          if (
            (rejectedVersion !== undefined &&
              row.tokenVersion !== rejectedVersion) ||
            (rejectedVersion === undefined &&
              (row.tokenExpiresAt?.getTime() ?? 0) > Date.now() + PROACTIVE_MS)
          ) {
            return { ready: row };
          }
          if (
            row.refreshLeaseUntil &&
            row.refreshLeaseUntil.getTime() > Date.now()
          )
            return {};
          return {
            claimed: await tx.connection.update({
              where: { id },
              data: {
                refreshLeaseUntil: new Date(Date.now() + LEASE_MS),
                refreshGeneration: { increment: 1 },
              },
            }),
          };
        },
        { maxWait: 1000 },
      )
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2028" || error.code === "P2024")
        ) {
          return { ready: undefined, claimed: undefined };
        }
        throw error;
      });
    if (claim.ready) return openUsable(claim.ready);
    if (!claim.claimed) {
      await sleep(60);
      continue;
    }
    const row = claim.claimed;
    const stored = readTokens(row);
    if (
      !row.refreshLeaseUntil ||
      row.refreshLeaseUntil.getTime() <= Date.now() + REFRESH_TIMEOUT ||
      !(await stillOwns(row))
    )
      continue;
    let fresh: Tokens;
    try {
      fresh = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: stored.refresh_token,
      });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (
        error.reason === "invalid_grant" ||
        (error.status === 0 && error.reason !== "provider_unreachable")
      ) {
        if (await finishFailure(row, "needs_reauth", error.reason))
          throw new ConnectionUnavailable("needs_reauth");
        continue;
      }
      if (!error.retryable) {
        if (await finishFailure(row, "error", error.reason))
          throw new ConnectionUnavailable("error");
        continue;
      }
      if (await finishFailure(row, "connected", error.reason)) throw error;
      continue;
    }
    try {
      const saved = await db.$transaction(async (tx) => {
        const current = await lockConnection(tx, id);
        if (
          !isUsable(current, generation) ||
          current.tokenVersion !== row.tokenVersion ||
          current.refreshGeneration !== row.refreshGeneration ||
          (current.refreshLeaseUntil?.getTime() ?? 0) <= Date.now()
        )
          return false;
        const result = await tx.connection.updateMany({
          where: { ...fence(row), refreshLeaseUntil: { gt: new Date() } },
          data: { ...tokenData(id, fresh), refreshLeaseUntil: null },
        });
        return result.count === 1;
      });
      if (saved) return { tokens: fresh, version: row.tokenVersion + 1 };
      if (
        await finishFailure(
          row,
          "needs_reauth",
          "refresh_lease_expired_after_rotation",
        )
      )
        throw new ConnectionUnavailable("needs_reauth");
    } catch (error) {
      if (error instanceof ConnectionUnavailable) throw error;
      if (await finishFailure(row, "needs_reauth", "rotated_token_save_failed"))
        throw new ConnectionUnavailable("needs_reauth");
    }
    const winner = await db.connection.findUnique({ where: { id } });
    if (!isUsable(winner, generation))
      throw new ConnectionUnavailable(winner?.tokenStatus ?? "missing");
    if (winner.tokenVersion !== row.tokenVersion) return openUsable(winner);
    // A replacement holder owns the row. Re-read its result rather than persisting our response.
    rejectedVersion = row.tokenVersion;
  }
  throw new ProviderError(503, "refresh_lease_busy");
}
export async function withAccess<T>(
  id: string,
  generation: number,
  call: (token: string) => Promise<T>,
) {
  const first = await accessFor(id, generation);
  try {
    return await call(first.tokens.access_token);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.status !== 401) throw error;
    const next = await accessFor(id, generation, first.version);
    return call(next.tokens.access_token);
  }
}
