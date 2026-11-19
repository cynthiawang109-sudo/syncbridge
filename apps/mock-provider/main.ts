import Fastify, { FastifyReply } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import {
  isResource,
  parseEvent,
  signature,
  webhookSecret,
  type ProviderEvent,
  type Resource,
} from "../../packages/shared/events";
import type { Employee } from "../../packages/shared/provider";
import { setTimeout as sleep } from "node:timers/promises";

const app = Fastify({ logger: false });
const redirectUri =
  process.env.CALLBACK_URL ?? "http://localhost:4300/oauth/callback";
const clientId = "syncbridge";
const pageSize = 2;
const employees: Employee[] = [
  { id: "synthetic-01", name: "Aster Example", version: 1, revision: 1 },
  { id: "synthetic-02", name: "Birch Example", version: 2, revision: 2 },
  { id: "synthetic-03", name: "Cedar Example", version: 1, revision: 3 },
  { id: "synthetic-04", name: "Dune Example", version: 3, revision: 4 },
  { id: "synthetic-05", name: "Elm Example", version: 1, revision: 5 },
];
const baseEmployees = employees.map((row) => ({ ...row }));
const payruns: Employee[] = [
  {
    id: "synthetic-pay-01",
    name: "Fixture pay period one",
    version: 1,
    revision: 1,
    amount: 12345,
  },
  {
    id: "synthetic-pay-02",
    name: "Fixture pay period two",
    version: 2,
    revision: 2,
    amount: 23456,
  },
  {
    id: "synthetic-pay-03",
    name: "Fixture pay period three",
    version: 1,
    revision: 3,
    amount: 34567,
  },
];
const basePayruns = payruns.map((row) => ({ ...row }));
const resources = { employees, payruns };
const revisions = { employees: 5, payruns: 3 };
type Grant = { challenge: string; expires: number };
type Session = { family: string; expires: number };
type Snapshot = {
  rows: Employee[];
  resource: Resource;
  watermark: number;
  expires: number;
};
type Cursor = { snapshot: string; offset: number; expires: number };
const grants = new Map<string, Grant>();
const refresh = new Map<string, Session>();
const retired = new Map<string, Session>();
const access = new Map<string, Session>();
const snapshots = new Map<string, Snapshot>();
const cursors = new Map<string, Cursor>();
type Faults = {
  rateLimit?: "delta" | "date";
  failPage?: number;
  expireAccess?: boolean;
  revokeRefresh?: boolean;
  refreshDelayMs?: number;
  refreshStatus?: 403 | 503;
  rotateBeforeDelay?: boolean;
  accessLifetime?: number;
  expireSnapshot?: boolean;
  duplicate?: boolean;
  outOfOrder?: boolean;
  burst?: number;
  latencyMs?: number;
  failGet?: 400 | 404 | 503;
  tamper?: boolean;
  silent?: boolean;
  resetData?: boolean;
};
let faults: Faults = {};
let refreshCalls = 0;
let listCalls = 0;
let getCalls = 0;
async function resourceFault(reply: FastifyReply) {
  if (faults.latencyMs) await sleep(Math.min(3500, faults.latencyMs));
  if (rateLimited(reply)) return true;
  if ((faults.burst ?? 0) > 0) {
    faults.burst!--;
    reply.code(503).send({ error: "synthetic_burst" });
    return true;
  }
  return false;
}
function issue(family: string) {
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  const expiresIn = faults.accessLifetime ?? 900;
  access.set(accessToken, { family, expires: Date.now() + expiresIn * 1000 });
  refresh.set(refreshToken, { family, expires: Date.now() + 86400000 });
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: "employees:read payruns:read",
  };
}
function validAccess(header?: string) {
  return (
    (access.get(header?.replace(/^Bearer /, "") ?? "")?.expires ?? 0) >
    Date.now()
  );
}
function rateLimited(reply: FastifyReply) {
  if (!faults.rateLimit) return false;
  const retryAfter =
    faults.rateLimit === "delta"
      ? "1"
      : new Date(Math.ceil(Date.now() / 1000) * 1000 + 1000).toUTCString();
  delete faults.rateLimit;
  reply
    .header("Retry-After", retryAfter)
    .code(429)
    .send({ error: "rate_limited" });
  return true;
}
function removeExpired<T extends { expires: number }>(map: Map<string, T>) {
  for (const [key, value] of map)
    if (value.expires <= Date.now()) map.delete(key);
}
const sweep = setInterval(() => {
  removeExpired(grants);
  removeExpired(access);
  removeExpired(refresh);
  removeExpired(retired);
  removeExpired(snapshots);
  removeExpired(cursors);
}, 60000);
sweep.unref();
app.get<{ Querystring: Record<string, string> }>("/authorize", (req, reply) => {
  const q = req.query;
  if (
    q.client_id !== clientId ||
    q.redirect_uri !== redirectUri ||
    q.response_type !== "code" ||
    q.code_challenge_method !== "S256" ||
    !/^[\w-]{43}$/.test(q.code_challenge ?? "") ||
    !/^[\w-]{43}$/.test(q.state ?? "") ||
    q.scope !== "employees:read payruns:read"
  )
    return reply.code(400).send({ error: "invalid_request" });
  const code = randomUUID();
  grants.set(code, {
    challenge: q.code_challenge,
    expires: Date.now() + 60000,
  });
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", q.state);
  return reply
    .header("cache-control", "no-store")
    .redirect(callback.toString());
});
app.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "string" },
  (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body.toString())));
  },
);
app.post<{ Body: Record<string, string> }>("/token", async (req, reply) => {
  reply.header("cache-control", "no-store");
  const form = req.body ?? {};
  if (form.client_id !== clientId)
    return reply.code(400).send({ error: "invalid_client" });
  if (form.grant_type === "authorization_code") {
    const grant = grants.get(form.code);
    const challenge = createHash("sha256")
      .update(form.code_verifier ?? "")
      .digest("base64url");
    if (
      !grant ||
      grant.expires <= Date.now() ||
      grant.challenge !== challenge ||
      form.redirect_uri !== redirectUri
    ) {
      return reply.code(400).send({ error: "invalid_grant" });
    }
    grants.delete(form.code);
    return issue(randomUUID());
  }
  if (form.grant_type !== "refresh_token")
    return reply.code(400).send({ error: "unsupported_grant_type" });
  refreshCalls++;
  if (faults.refreshStatus === 403 || faults.refreshStatus === 503) {
    const status = faults.refreshStatus;
    delete faults.refreshStatus;
    return reply.code(status).send({ error: "test_refresh_failure" });
  }
  const { refreshDelayMs, rotateBeforeDelay } = faults;
  const rotate = () => {
    const session = refresh.get(form.refresh_token);
    if (!session || session.expires <= Date.now()) return null;
    refresh.delete(form.refresh_token);
    retired.set(form.refresh_token, session);
    for (const [token, value] of access)
      if (value.family === session.family) access.delete(token);
    return issue(session.family);
  };
  const early = rotateBeforeDelay ? rotate() : null;
  if (refreshDelayMs)
    await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
  return (
    (rotateBeforeDelay ? early : rotate()) ??
    reply.code(400).send({ error: "invalid_grant" })
  );
});
app.post<{ Body: Record<string, string> }>("/revoke", (req) => {
  const token = req.body?.token;
  const family =
    refresh.get(token)?.family ??
    access.get(token)?.family ??
    retired.get(token)?.family;
  if (family) {
    for (const [key, value] of refresh)
      if (value.family === family) refresh.delete(key);
    for (const [key, value] of access)
      if (value.family === family) access.delete(key);
  }
  return {};
});
app.get<{ Params: { resource: string; id: string } }>(
  "/:resource/:id",
  async (req, reply) => {
    const resource = req.params.resource;
    if (!isResource(resource))
      return reply.code(404).send({ error: "not_found" });
    if (!validAccess(req.headers.authorization))
      return reply.code(401).send({ error: "invalid_token" });
    getCalls++;
    if (await resourceFault(reply)) return reply;
    if (faults.failGet) {
      const status = faults.failGet;
      delete faults.failGet;
      return reply.code(status).send({ error: "synthetic_get_failure" });
    }
    return (
      resources[resource].find((row) => row.id === req.params.id) ??
      reply.code(404).send({ error: "not_found" })
    );
  },
);
app.get<{
  Params: { resource: string };
  Querystring: { snapshot?: string; cursor?: string; since?: string };
}>("/:resource", async (req, reply) => {
  const resource = req.params.resource;
  if (!isResource(resource))
    return reply.code(404).send({ error: "not_found" });
  if (!validAccess(req.headers.authorization))
    return reply.code(401).send({ error: "invalid_token" });
  listCalls++;
  if (await resourceFault(reply)) return reply;
  const q = req.query;
  const cursor = q.cursor && cursors.get(q.cursor);
  if (
    q.cursor &&
    (!cursor || cursor.snapshot !== q.snapshot || cursor.expires <= Date.now())
  ) {
    return reply.code(409).send({ error: "snapshot_expired" });
  }
  const offset = cursor ? cursor.offset : 0;
  if (faults.failPage === offset / pageSize + 1) {
    delete faults.failPage;
    return reply.code(503).send({ error: "temporary_failure" });
  }
  const token = q.snapshot ?? randomUUID();
  let snapshot = snapshots.get(token);
  if (!q.snapshot) {
    const since = Number(q.since ?? 0);
    if (!Number.isSafeInteger(since) || since < 0)
      return reply.code(400).send({ error: "invalid_since" });
    snapshot = {
      rows: resources[resource]
        .filter((row) => row.revision > since)
        .map((row) => ({ ...row })),
      resource,
      watermark: revisions[resource],
      expires: Date.now() + 300000,
    };
    snapshots.set(token, snapshot);
  }
  if (
    !snapshot ||
    snapshot.resource !== resource ||
    snapshot.expires <= Date.now()
  )
    return reply.code(409).send({ error: "snapshot_expired" });
  const next = offset + pageSize < snapshot.rows.length ? randomUUID() : null;
  if (next)
    cursors.set(next, {
      snapshot: token,
      offset: offset + pageSize,
      expires: snapshot.expires,
    });
  return {
    items: snapshot.rows.slice(offset, offset + pageSize),
    cursor: next,
    snapshot: token,
    watermark: snapshot.watermark,
  };
});
app.get("/health", () => ({ ok: true }));
app.get("/__test/stats", () => ({ refreshCalls, listCalls, getCalls }));
app.patch<{ Body: Faults }>("/__test/faults", (req) => {
  faults = req.body;
  if (faults.resetData) {
    employees.splice(0, employees.length, ...baseEmployees);
    payruns.splice(0, payruns.length, ...basePayruns);
    revisions.employees = 5;
    revisions.payruns = 3;
    snapshots.clear();
    cursors.clear();
  }
  if (faults.expireAccess) access.clear();
  if (faults.revokeRefresh) refresh.clear();
  if (faults.expireSnapshot) snapshots.clear();
  return { ok: true };
});

app.post<{
  Body: {
    connectionId: string;
    events: ProviderEvent[];
    changes?: Array<{ resource: Resource; row: Employee }>;
  };
}>("/__test/events", async (req, reply) => {
  const { connectionId, events, changes = [] } = req.body;
  if (
    !/^[a-zA-Z0-9_-]{1,120}$/.test(connectionId) ||
    !Array.isArray(events) ||
    events.length > 25 ||
    !Array.isArray(changes) ||
    changes.length > 25
  ) {
    return reply.code(400).send({ error: "invalid_fixture" });
  }
  const validated = events.map((event) => parseEvent(event));
  for (const { resource, row } of changes) {
    if (
      !isResource(resource) ||
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      !Number.isInteger(row.version) ||
      row.version < 1
    ) {
      return reply.code(400).send({ error: "invalid_fixture" });
    }
    const rows = resources[resource];
    const saved = { ...row, revision: ++revisions[resource] };
    const index = rows.findIndex((current) => current.id === row.id);
    if (index < 0) rows.push(saved);
    else rows[index] = saved;
  }
  const statuses: number[] = [];
  if (!faults.silent) {
    const target = process.env.WEBHOOK_TARGET ?? "http://api:3000";
    if (faults.outOfOrder) validated.reverse();
    for (const event of validated) {
      const raw = Buffer.from(JSON.stringify(event));
      for (let attempt = 0; attempt < (faults.duplicate ? 2 : 1); attempt++) {
        const timestamp = Date.now().toString();
        const signed = faults.tamper
          ? "0".repeat(64)
          : signature(webhookSecret(connectionId)!, timestamp, raw).toString(
              "hex",
            );
        const result = await fetch(target + "/webhooks/" + connectionId, {
          method: "POST",
          body: raw,
          signal: AbortSignal.timeout(6000),
          headers: {
            "content-type": "application/json",
            "x-webhook-timestamp": timestamp,
            "x-webhook-signature": signed,
          },
        });
        statuses.push(result.status);
      }
    }
  }
  return { statuses };
});
void app.listen({ port: 3001, host: "0.0.0.0" });
