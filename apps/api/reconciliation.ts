import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { db } from "../../packages/shared/db";
import { isResource } from "../../packages/shared/events";
import { requestReconciliation } from "../../packages/shared/reconciliation";
import { Caller, deny, type Identity } from "./auth";

@Controller("connections/:id/reconciliation")
export class ReconciliationController {
  private async ensureTenant(id: string, identity: Identity) {
    if (
      !(await db.connection.findFirst({
        where: { id, tenantId: identity.tenantId },
        select: { id: true },
      }))
    ) {
      await deny(identity, id, "reconciliation_connection_unavailable");
      throw new NotFoundException();
    }
  }
  @Post()
  async start(
    @Param("id") id: string,
    @Caller() identity: Identity,
    @Body("resourceType") resource: unknown,
  ) {
    if (!isResource(resource))
      throw new BadRequestException("Invalid resource");
    await this.ensureTenant(id, identity);
    const run = await db.$transaction((tx) =>
      requestReconciliation(tx, id, resource, identity.tenantId),
    );
    if (!run) throw new ConflictException("Connection cannot reconcile");
    return run;
  }
  @Get()
  async list(@Param("id") id: string, @Caller() identity: Identity) {
    await this.ensureTenant(id, identity);
    return db.reconciliationRun.findMany({
      where: { connectionId: id, connection: { tenantId: identity.tenantId } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }
  @Get(":runId")
  async report(
    @Param("id") id: string,
    @Param("runId") runId: string,
    @Caller() identity: Identity,
    @Query("after") after?: string,
  ) {
    const run = await db.reconciliationRun.findFirst({
      where: {
        id: runId,
        connectionId: id,
        connection: { tenantId: identity.tenantId },
      },
      include: {
        findings: {
          where: { externalId: after ? { gt: after } : undefined },
          orderBy: { externalId: "asc" },
          take: 101,
        },
      },
    });
    if (!run) {
      await deny(identity, runId, "reconciliation_run_unavailable");
      throw new NotFoundException();
    }
    const { findings, ...report } = run;
    return {
      ...report,
      findings: findings.slice(0, 100),
      next: findings.length > 100 ? findings[99].externalId : null,
    };
  }
}
