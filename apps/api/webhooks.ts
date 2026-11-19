import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { archiveItem, archiveReceipt } from "../../packages/shared/archive";
import { db, lockConnection } from "../../packages/shared/db";
import { parseEvent, verifyWebhook } from "../../packages/shared/events";
import { Caller, deny, Identity, Public } from "./auth";
import { ownConnection } from "./tenants";

@Controller("webhooks")
export class WebhooksController {
  @Post(":id")
  @Public()
  @HttpCode(202)
  async receive(
    @Param("id") id: string,
    @Headers("x-webhook-timestamp") timestamp: string | undefined,
    @Headers("x-webhook-signature") signed: string | undefined,
    @Body() raw: unknown,
  ) {
    if (!Buffer.isBuffer(raw))
      throw new BadRequestException("Expected raw JSON bytes");
    if (!verifyWebhook(id, timestamp ?? "", raw, signed ?? ""))
      throw new UnauthorizedException("Invalid webhook authentication");
    const status = await db.$transaction(async (tx) => {
      const connection = await lockConnection(tx, id);
      if (!connection) return 404;
      if (connection.lifecycle !== "active") {
        await tx.authorizationAudit.create({
          data: {
            actor: "mock-provider",
            object: id,
            reason: "webhook_connection_closed",
          },
        });
        return 410;
      }
      let event;
      try {
        event = parseEvent(JSON.parse(raw.toString("utf8")));
      } catch {
        await tx.authorizationAudit.create({
          data: {
            actor: "mock-provider",
            object: id,
            reason: "invalid_webhook_event",
          },
        });
        return 400;
      }
      await archiveReceipt(connection, event.id, raw);
      return 202;
    });
    if (status !== 202) throw new HttpException("Webhook rejected", status);
    return { accepted: true };
  }
  @Get(":id/events/:eventId")
  async read(
    @Caller() identity: Identity,
    @Param("id") id: string,
    @Param("eventId") eventId: string,
  ) {
    await ownConnection(identity, id);
    if (identity.role !== "operator") {
      await deny(identity, id, "archive_role_denied");
      throw new ForbiddenException();
    }
    const event = await archiveItem(id, eventId);
    if (!event || event.tenant_id !== identity.tenantId)
      throw new NotFoundException();
    await deny(identity, id, "archive_read");
    const { event_id, status, received_at, attempt_count, dlq_id, replay_id } =
      event;
    return { event_id, status, received_at, attempt_count, dlq_id, replay_id };
  }
}
