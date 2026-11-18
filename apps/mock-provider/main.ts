import Fastify, { FastifyReply } from "fastify";
import { createHash, randomUUID } from "node:crypto";

const app = Fastify({ logger: false });
const redirectUri =
  process.env.CALLBACK_URL ?? "http://localhost:4300/oauth/callback";
const clientId = "syncbridge";
const pageSize = 2;
const employees = [
  { id: "synthetic-01", name: "Aster Example", version: 1, revision: 1 },
  { id: "synthetic-02", name: "Birch Example", version: 2, revision: 2 },
  { id: "synthetic-03", name: "Cedar Example", version: 1, revision: 3 },
  { id: "synthetic-04", name: "Dune Example", version: 3, revision: 4 },
  { id: "synthetic-05", name: "Elm Example", version: 1, revision: 5 },
];
type Grant = { challenge: string; expires: number };
type Session = { family: string; expires: number };
type Snapshot = { rows: typeof employees; watermark: number; expires: number };
type Cursor = { snapshot: string; offset: number; expires: number };
const grants = new Map<string, Grant>();
const refresh = new Map<string, Session>();
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
};
let faults: Faults = {};
let refreshCalls = 0;
let listCalls = 0;
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
    scope: "employees:read",
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
    q.scope !== "employees:read"
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
  const family = refresh.get(token)?.family ?? access.get(token)?.family;
  if (family) {
    for (const [key, value] of refresh)
      if (value.family === family) refresh.delete(key);
    for (const [key, value] of access)
      if (value.family === family) access.delete(key);
  }
  return {};
});
app.get<{ Params: { id: string } }>("/employees/:id", (req, reply) => {
  if (!validAccess(req.headers.authorization))
    return reply.code(401).send({ error: "invalid_token" });
  if (rateLimited(reply)) return reply;
  return (
    employees.find((row) => row.id === req.params.id) ??
    reply.code(404).send({ error: "not_found" })
  );
});
app.get<{
  Querystring: { snapshot?: string; cursor?: string; since?: string };
}>("/employees", (req, reply) => {
  if (!validAccess(req.headers.authorization))
    return reply.code(401).send({ error: "invalid_token" });
  listCalls++;
  if (rateLimited(reply)) return reply;
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
      rows: employees.filter((row) => row.revision > since),
      watermark: employees.length,
      expires: Date.now() + 300000,
    };
    snapshots.set(token, snapshot);
  }
  if (!snapshot || snapshot.expires <= Date.now())
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
app.get("/__test/stats", () => ({ refreshCalls, listCalls }));
app.patch<{ Body: Faults }>("/__test/faults", (req) => {
  faults = req.body;
  if (faults.expireAccess) access.clear();
  if (faults.revokeRefresh) refresh.clear();
  if (faults.expireSnapshot) snapshots.clear();
  return { ok: true };
});
void app.listen({ port: 3001, host: "0.0.0.0" });
