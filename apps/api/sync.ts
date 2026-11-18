import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { db, lockConnection } from "../../packages/shared/db";
import { Caller, Identity, deny } from "./auth";
import { ownConnection } from "./tenants";

@Controller("connections/:id/sync")
export class SyncController {
  @Post()
  async trigger(
    @Caller() identity: Identity,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const mode = (body as { mode?: unknown } | undefined)?.mode;
    if (mode !== "full" && mode !== "incremental")
      throw new BadRequestException("Invalid sync mode");
    await ownConnection(identity, id);
    return db.$transaction(async (tx) => {
      const connection = await lockConnection(tx, id);
      if (
        connection?.tenantId !== identity.tenantId ||
        connection.lifecycle !== "active" ||
        connection.tokenStatus !== "connected"
      ) {
        throw new ConflictException("Connection cannot sync");
      }
      const active = await tx.syncRun.findFirst({
        where: {
          connectionId: id,
          resourceType: "employees",
          status: { in: ["queued", "running"] },
        },
      });
      if (active) return active;
      const run = await tx.syncRun.create({
        data: {
          connectionId: id,
          mode,
          generation: connection.generation,
          since: mode === "incremental" ? connection.watermark : 0,
        },
      });
      await tx.operationAttempt.create({
        data: { key: run.id + "-0", runId: run.id },
      });
      return run;
    });
  }
  @Get(":runId")
  async readRun(
    @Caller() identity: Identity,
    @Param("id") id: string,
    @Param("runId") runId: string,
  ) {
    await ownConnection(identity, id);
    const run = await db.syncRun.findFirst({
      where: {
        id: runId,
        connectionId: id,
        connection: { tenantId: identity.tenantId, lifecycle: "active" },
      },
      include: { _count: { select: { outcomes: true } } },
    });
    if (!run) {
      await deny(identity, runId, "sync_run_unavailable");
      throw new NotFoundException();
    }
    return run;
  }
}
