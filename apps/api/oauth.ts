import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { Caller, Identity, Public } from "./auth";
import { connectionView, ownConnection } from "./tenants";
import { db } from "../../packages/shared/db";
import { resumeAttempts } from "../../packages/shared/attempts";
import {
  browserProvider,
  callback,
  tokenRequest,
} from "../../packages/shared/provider";
import { tokenData } from "../../packages/shared/tokens";
const hash = (input: string) =>
  createHash("sha256").update(input).digest("base64url");
@Controller()
export class OAuthController {
  @Post("connections/:id/authorize")
  @Header("Cache-Control", "no-store")
  async authorize(@Caller() identity: Identity, @Param("id") id: string) {
    const connection = await ownConnection(identity, id);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const result = await db.connection.updateMany({
      where: {
        id,
        tenantId: identity.tenantId,
        lifecycle: "active",
        generation: connection.generation,
      },
      data: {
        oauthStateHash: hash(state),
        oauthVerifier: verifier,
        oauthExpiresAt: new Date(Date.now() + 300000),
      },
    });
    if (!result.count) throw new ConflictException();
    const url = new URL("/authorize", browserProvider);
    url.search = new URLSearchParams({
      state,
      client_id: "syncbridge",
      response_type: "code",
      scope: "employees:read payruns:read",
      redirect_uri: callback,
      code_challenge_method: "S256",
      code_challenge: hash(verifier),
    }).toString();
    return { authorizationUrl: url.toString() };
  }
  @Public()
  @Get("oauth/callback")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async complete(@Query("state") state: unknown, @Query("code") code: unknown) {
    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      !/^[\w-]{43}$/.test(state)
    )
      throw new BadRequestException();
    const oauthStateHash = hash(state);
    const row = await db.connection.findUnique({ where: { oauthStateHash } });
    if (!row?.oauthVerifier || row.lifecycle !== "active")
      throw new BadRequestException("Invalid OAuth state");
    const used = await db.connection.updateMany({
      where: {
        id: row.id,
        oauthStateHash,
        oauthExpiresAt: { gt: new Date() },
        lifecycle: "active",
        generation: row.generation,
      },
      data: { oauthStateHash: null, oauthVerifier: null, oauthExpiresAt: null },
    });
    if (!used.count) throw new BadRequestException("Invalid OAuth state");
    let data;
    try {
      data = tokenData(
        row.id,
        await tokenRequest({
          grant_type: "authorization_code",
          code,
          code_verifier: row.oauthVerifier,
          redirect_uri: callback,
        }),
      );
    } catch {
      throw new BadGatewayException("OAuth exchange failed");
    }
    return db.$transaction(async (tx) => {
      const saved = await tx.connection.updateMany({
        where: {
          id: row.id,
          tenantId: row.tenantId,
          lifecycle: "active",
          generation: row.generation,
          tokenVersion: row.tokenVersion,
          refreshGeneration: row.refreshGeneration,
          refreshLeaseUntil: null,
        },
        data,
      });
      if (!saved.count)
        throw new ConflictException("Connection changed during OAuth exchange");
      if (!row.pausedReason) await resumeAttempts(tx, row.id);
      return tx.connection.findUniqueOrThrow({
        where: { id: row.id },
        select: connectionView,
      });
    });
  }
}
