import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { Caller, deny, Identity } from "./auth";
import { db } from "../../packages/shared/db";
export const connectionView = {
  id: true,
  tenantId: true,
  name: true,
  provider: true,
  lifecycle: true,
  generation: true,
  tokenStatus: true,
  tokenError: true,
  tokenVersion: true,
} as const;
export function nameOf(body: unknown) {
  const name = (body as { name?: unknown } | undefined)?.name;
  if (typeof name !== "string" || !name.trim() || name.length > 120)
    throw new BadRequestException("Invalid name");
  return name.trim();
}
export async function ownConnection(identity: Identity, id: string) {
  const connection = await db.connection.findFirst({
    where: {
      id,
      tenantId: identity.tenantId,
      lifecycle: { not: "deleted" },
      tenant: { deletedAt: null },
    },
    select: connectionView,
  });
  if (!connection) {
    await deny(identity, id, "connection_unavailable");
    throw new NotFoundException();
  }
  return connection;
}
@Controller()
export class TenantsController {
  @Post("tenant")
  async createTenant(@Caller() identity: Identity, @Body() body: unknown) {
    const result = await db.tenant.createMany({
      data: { id: identity.tenantId, name: nameOf(body) },
      skipDuplicates: true,
    });
    if (!result.count) throw new ConflictException();
    return this.readTenant(identity);
  }
  @Get("tenant")
  async readTenant(@Caller() identity: Identity) {
    const tenant = await db.tenant.findFirst({
      where: { id: identity.tenantId, deletedAt: null },
    });
    if (!tenant) throw new NotFoundException();
    return tenant;
  }
  @Patch("tenant")
  async updateTenant(@Caller() identity: Identity, @Body() body: unknown) {
    const result = await db.tenant.updateMany({
      where: { id: identity.tenantId, deletedAt: null },
      data: { name: nameOf(body) },
    });
    if (!result.count) throw new NotFoundException();
    return this.readTenant(identity);
  }
  @Delete("tenant")
  async deleteTenant(@Caller() identity: Identity) {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${identity.tenantId} FOR UPDATE`;
      const existing = await tx.connection.count({
        where: { tenantId: identity.tenantId, lifecycle: { not: "deleted" } },
      });
      if (existing) throw new ConflictException("Delete connections first");
      const result = await tx.tenant.updateMany({
        where: { id: identity.tenantId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (!result.count) throw new NotFoundException();
    });
    return { deleted: true };
  }
  @Post("connections")
  async createConnection(@Caller() identity: Identity, @Body() body: unknown) {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${identity.tenantId} FOR UPDATE`;
      if (
        !(await tx.tenant.findFirst({
          where: { id: identity.tenantId, deletedAt: null },
        }))
      )
        throw new NotFoundException();
      return tx.connection.create({
        data: { tenantId: identity.tenantId, name: nameOf(body) },
        select: connectionView,
      });
    });
  }
  @Get("connections")
  listConnections(@Caller() identity: Identity) {
    return db.connection.findMany({
      where: {
        tenantId: identity.tenantId,
        lifecycle: { not: "deleted" },
        tenant: { deletedAt: null },
      },
      select: connectionView,
    });
  }
  @Get("connections/:id")
  readConnection(@Caller() identity: Identity, @Param("id") id: string) {
    return ownConnection(identity, id);
  }
  @Patch("connections/:id")
  async updateConnection(
    @Caller() identity: Identity,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    await ownConnection(identity, id);
    const result = await db.connection.updateMany({
      where: { id, tenantId: identity.tenantId, lifecycle: "active" },
      data: { name: nameOf(body) },
    });
    if (!result.count) throw new ConflictException();
    return ownConnection(identity, id);
  }
  @Delete("connections/:id")
  async deleteConnection(
    @Caller() identity: Identity,
    @Param("id") id: string,
  ) {
    await ownConnection(identity, id);
    await db.connection.updateMany({
      where: { id, tenantId: identity.tenantId, lifecycle: "active" },
      data: { lifecycle: "closing", generation: { increment: 1 } },
    });
    await db.connection.updateMany({
      where: { id, tenantId: identity.tenantId, lifecycle: "closing" },
      data: {
        lifecycle: "deleted",
        encryptedTokens: null,
        keyVersion: null,
        oauthStateHash: null,
        oauthVerifier: null,
        tokenStatus: "disconnected",
      },
    });
    return { deleted: true };
  }
  @Get("connections/:id/records")
  async records(@Caller() identity: Identity, @Param("id") id: string) {
    await ownConnection(identity, id);
    return db.externalRecord.findMany({
      where: {
        connectionId: id,
        connection: { tenantId: identity.tenantId, lifecycle: "active" },
      },
      orderBy: { externalId: "asc" },
    });
  }
}
