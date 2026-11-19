import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  NotFoundException,
  Param,
  Post,
  SetMetadata,
} from "@nestjs/common";
import { db, lockConnection } from "../../packages/shared/db";
import { Caller, deny, Identity } from "./auth";

const REPLAY_WINDOW = 90 * 86400000;
@Controller("dead-letters")
export class DeadLettersController {
  @Get()
  list(@Caller() identity: Identity) {
    return db.deadLetter.findMany({
      where: { tenantId: identity.tenantId },
      select: {
        id: true,
        connectionId: true,
        eventId: true,
        runId: true,
        state: true,
        reason: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Get(":entryId")
  async read(@Caller() identity: Identity, @Param("entryId") id: string) {
    const entry = await db.deadLetter.findFirst({
      where: { id, tenantId: identity.tenantId },
      include: { audits: true },
    });
    if (!entry) {
      await deny(identity, id, "dead_letter_unavailable");
      throw new NotFoundException();
    }
    const { payload, providerError, ...info } = entry;
    return identity.role === "operator"
      ? { ...info, payload, providerError }
      : info;
  }
  @Post(":entryId/replay")
  @SetMetadata("authorize_in_handler", true)
  async replay(@Caller() identity: Identity, @Param("entryId") id: string) {
    const entry = await db.deadLetter.findUnique({ where: { id } });
    if (!entry) {
      await deny(identity, id, "replay_unavailable");
      throw new NotFoundException();
    }
    const result = await db.$transaction(async (tx) => {
      const connection = await lockConnection(tx, entry.connectionId);
      const current = await tx.deadLetter.findUnique({ where: { id } });
      if (!current) return { status: 404 };
      const audit = async (result: string) =>
        (
          await tx.replayAudit.create({
            data: { deadLetterId: id, actor: identity.actor, result },
          })
        ).id;
      if (
        entry.tenantId !== identity.tenantId ||
        connection?.tenantId !== identity.tenantId
      ) {
        await audit("denied_tenant");
        return { status: 404 };
      }
      if (identity.role !== "operator") {
        await audit("denied_role");
        return { status: 403 };
      }
      if (Date.now() - current.createdAt.getTime() >= REPLAY_WINDOW) {
        await audit("denied_expired");
        return { status: 410 };
      }
      if (
        connection.lifecycle !== "active" ||
        connection.tokenStatus !== "connected" ||
        connection.pausedReason
      ) {
        await audit("denied_connection");
        return { status: 409 };
      }
      let run = null;
      if (entry.runId) {
        const source = await tx.syncRun.findUnique({
          where: { id: entry.runId },
        });
        if (!source) {
          await audit("denied_evidence");
          return { status: 409 };
        }
        const active = await tx.syncRun.findFirst({
          where: {
            connectionId: connection.id,
            resourceType: source.resourceType,
            status: { in: ["queued", "running"] },
          },
        });
        if (active) {
          await audit("denied_active_run");
          return { status: 409 };
        }
        run = source;
      }
      const claimed = await tx.deadLetter.updateMany({
        where: { id, state: { in: ["open", "reopened"] } },
        data: { state: "replay_queued" },
      });
      if (!claimed.count) {
        await audit("denied_state");
        return { status: 409 };
      }
      const replayId = await audit("queued");
      const next =
        run &&
        (await tx.syncRun.create({
          data: {
            connectionId: connection.id,
            resourceType: run.resourceType,
            generation: connection.generation,
            mode: run.mode,
            since: run.since,
            cursor: run.error === "snapshot_expired" ? null : run.cursor,
            snapshot: run.error === "snapshot_expired" ? null : run.snapshot,
            watermark: run.error === "snapshot_expired" ? null : run.watermark,
            page: run.error === "snapshot_expired" ? 0 : run.page,
          },
        }));
      await tx.operationAttempt.create({
        data: {
          key: "replay-" + replayId,
          connectionId: connection.id,
          generation: connection.generation,
          eventId: entry.eventId,
          runId: next?.id,
          deadLetterId: id,
          evidence: entry.payload ?? undefined,
          replayId,
        },
      });
      return { status: 201, replayId };
    });
    if (result.status !== 201)
      await deny(identity, id, "replay_rejected_" + result.status);
    if (result.status === 404) throw new NotFoundException();
    if (result.status === 403) throw new ForbiddenException();
    if (result.status === 410)
      throw new GoneException("Replay retention expired");
    if (result.status === 409)
      throw new ConflictException("Replay unavailable");
    return { replayId: result.replayId };
  }
}
