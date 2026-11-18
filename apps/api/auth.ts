import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  SetMetadata,
  createParamDecorator,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { verify } from "jsonwebtoken";
import { db } from "../../packages/shared/db";
export type Identity = {
  tenantId: string;
  role: "operator" | "viewer";
  actor: string;
};
type Request = {
  headers: Record<string, string | undefined>;
  params: Record<string, string>;
  query: unknown;
  body: unknown;
  url: string;
  identity: Identity;
};
export const Public = () => SetMetadata("public", true);
export const Caller = createParamDecorator(
  (_, context: ExecutionContext) =>
    context.switchToHttp().getRequest<Request>().identity,
);
export function operator(identity: Identity) {
  if (identity.role !== "operator") throw new ForbiddenException();
}
export async function deny(identity: Identity, object: string, reason: string) {
  await db.authorizationAudit.create({
    data: { actor: identity.actor, object, reason },
  });
}
function hasMismatch(value: unknown, tenantId: string): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, field]) =>
    ["tenant_id", "tenantId"].includes(key)
      ? field !== tenantId
      : hasMismatch(field, tenantId),
  );
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext) {
    if (this.reflector.get<boolean>("public", context.getHandler()))
      return true;
    const request = context.switchToHttp().getRequest<Request>();
    const secret = process.env.JWT_SECRET;
    try {
      const bearer = /^Bearer (\S+)$/i.exec(
        request.headers.authorization ?? "",
      );
      if (!bearer || !secret) throw new Error();
      const claims = verify(bearer[1], secret, {
        algorithms: ["HS256"],
        issuer: "syncbridge-local",
        audience: "syncbridge",
      });
      if (
        typeof claims === "string" ||
        typeof claims.tenant_id !== "string" ||
        !claims.tenant_id ||
        typeof claims.sub !== "string" ||
        typeof claims.exp !== "number" ||
        !["operator", "viewer"].includes(claims.role)
      )
        throw new Error();
      request.identity = {
        tenantId: claims.tenant_id,
        role: claims.role,
        actor: claims.sub,
      };
    } catch {
      await db.authorizationAudit.create({
        data: {
          actor: "anonymous",
          object: context.getHandler().name,
          reason: "invalid_identity",
        },
      });
      throw new UnauthorizedException();
    }
    const identity = request.identity;
    const object = request.params.id ?? context.getHandler().name;
    if (
      [request.query, request.body].some((value) =>
        hasMismatch(value, identity.tenantId),
      ) ||
      (request.headers["x-tenant-id"] !== undefined &&
        request.headers["x-tenant-id"] !== identity.tenantId)
    ) {
      await deny(identity, object, "tenant_mismatch");
      throw new ForbiddenException();
    }
    if (
      ![
        "readTenant",
        "listConnections",
        "readConnection",
        "records",
        "readRun",
      ].includes(context.getHandler().name) &&
      identity.role !== "operator"
    ) {
      await deny(identity, object, "insufficient_role");
      throw new ForbiddenException();
    }
    return true;
  }
}
