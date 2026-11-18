import { afterAll, afterEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile, fork } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { db } from "../packages/shared/db";
import { Envelope } from "../packages/shared/crypto";
import { ProviderError, fetchEmployees } from "../packages/shared/provider";
import { accessFor, readTokens, withAccess } from "../packages/shared/tokens";
import {
  authorize,
  createConnection,
  identity,
  json,
  mock,
  poll,
  records,
  request,
  trigger,
  waitRun,
} from "../scripts/scenario.mjs";

type Faults = Record<string, string | number | boolean>;
async function faults(body: Faults) {
  const res = await fetch(mock + "/__test/faults", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}
async function stats() {
  return (await (await fetch(mock + "/__test/stats")).json()) as {
    refreshCalls: number;
    listCalls: number;
  };
}
async function connected() {
  const connection = await createConnection();
  await authorize(connection);
  return connection;
}
const rowOf = (id: string) =>
  db.connection.findUniqueOrThrow({ where: { id } });
const page = (token: string) => fetchEmployees(token, new URLSearchParams());
afterEach(() => faults({}));
afterAll(() => db.$disconnect());

describe("MVP-A integration against Compose", () => {
  test("OAuth state, PKCE, proactive refresh, and one reactive 401 retry", async () => {
    const connection = await createConnection();
    expect(
      (await request("/oauth/callback?code=invalid&state=" + "A".repeat(43)))
        .status,
    ).toBe(400);
    const initial = await authorize(connection);
    expect(initial.tokenStatus).toBe("connected");
    expect(initial.tokenVersion).toBe(1);
    await db.connection.update({
      where: { id: connection.id },
      data: { tokenExpiresAt: new Date(0) },
    });
    const proactive = await accessFor(connection.id, 0);
    expect(proactive.version).toBe(2);
    const before = (await stats()).refreshCalls;
    await faults({ expireAccess: true });
    let attempts = 0;
    const result = await withAccess(connection.id, 0, (token) => {
      attempts++;
      return page(token);
    });
    expect(result.items).toHaveLength(2);
    expect(attempts).toBe(2);
    expect((await stats()).refreshCalls - before).toBe(1);
    await expect(
      withAccess(connection.id, 0, async () => {
        throw new ProviderError(401, "test_401");
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect((await stats()).refreshCalls - before).toBe(2);
  });

  test("T03 independent consumers hit 401 and share one committed refresh", async () => {
    const connection = await connected();
    await faults({ expireAccess: true, refreshDelayMs: 400 });
    const before = (await stats()).refreshCalls;
    const path = resolve("tests/refresh-consumer.mjs");
    const consumers = Array.from({ length: 4 }, () =>
      fork(path, [connection.id], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      }),
    );
    const completions = consumers.map(
      (child) =>
        new Promise<number | null>((resolve) => child.once("exit", resolve)),
    );
    try {
      await Promise.all(
        consumers.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once("message", (message) =>
                message === "rejected"
                  ? resolve()
                  : reject(new Error("Unexpected consumer message")),
              );
              child.once("exit", () =>
                reject(new Error("Consumer exited before barrier")),
              );
            }),
        ),
      );
      for (const child of consumers) child.send("release");
      expect(await Promise.all(completions)).toEqual([0, 0, 0, 0]);
    } finally {
      for (const child of consumers) if (child.exitCode === null) child.kill();
    }
    expect((await stats()).refreshCalls - before).toBe(1);
    expect(await rowOf(connection.id)).toMatchObject({
      tokenVersion: 2,
      refreshGeneration: 1,
    });
  });

  test("T12 an expired holder discards a successful response", async () => {
    const connection = await connected();
    await faults({ refreshDelayMs: 750, rotateBeforeDelay: true });
    const before = (await stats()).refreshCalls;
    const late = accessFor(connection.id, 0, 1).catch(
      (error: Error) => error.message,
    );
    await poll(async () => (await stats()).refreshCalls > before);
    await db.connection.update({
      where: { id: connection.id },
      data: { refreshLeaseUntil: new Date(0) },
    });
    expect(await late).toBe("needs_reauth");
    expect(await rowOf(connection.id)).toMatchObject({
      tokenVersion: 1,
      tokenStatus: "needs_reauth",
    });
  });

  test("T12 a late successful holder re-reads the replacement holder's committed tokens", async () => {
    const connection = await connected();
    const spare = await connected();
    const candidate = readTokens(await rowOf(spare.id));
    await faults({ refreshDelayMs: 1200, rotateBeforeDelay: true });
    const before = (await stats()).refreshCalls;
    const late = accessFor(connection.id, 0, 1);
    try {
      await poll(async () => (await stats()).refreshCalls > before);
      await faults({});
      // Supply a second valid provider family so both calls can return success
      // while the same PG token version remains the subject of the CAS.
      await db.connection.update({
        where: { id: connection.id },
        data: {
          ...new Envelope().encrypt(candidate, connection.id),
          refreshLeaseUntil: new Date(0),
        },
      });
      const winner = await accessFor(connection.id, 0, 1);
      expect(await late).toEqual(winner);
      expect(await rowOf(connection.id)).toMatchObject({
        tokenVersion: 2,
        refreshGeneration: 2,
        tokenStatus: "connected",
      });
      expect((await stats()).refreshCalls - before).toBe(2);
      expect((await page(winner.tokens.access_token)).items).toHaveLength(2);
    } finally {
      await late.catch(() => undefined);
    }
  });

  test.each([
    [{ refreshStatus: 503 }, "connected"],
    [{ refreshStatus: 403 }, "error"],
    [{ revokeRefresh: true }, "needs_reauth"],
  ] as const)(
    "refresh classification for %j yields %s",
    async (fault, expected) => {
      const connection = await connected();
      await db.connection.update({
        where: { id: connection.id },
        data: { tokenExpiresAt: new Date(0) },
      });
      await faults(fault);
      const before = (await stats()).refreshCalls;
      const run = await trigger(connection);
      if (expected === "connected") {
        const retry = await poll(async () => {
          const current = await db.operationAttempt.findUnique({
            where: { key: run.id + "-0" },
          });
          return current?.state === "pending" && current.attemptCount === 1
            ? current
            : undefined;
        });
        expect(retry.dueAt.getTime()).toBeGreaterThan(Date.now());
        expect((await waitRun(connection, run.id)).status).toBe("succeeded");
        expect((await stats()).refreshCalls - before).toBe(2);
      } else {
        await poll(
          async () => (await rowOf(connection.id)).tokenStatus === expected,
        );
        await expect(accessFor(connection.id, 0, 1)).rejects.toThrow(expected);
        expect((await stats()).refreshCalls - before).toBe(1);
      }
      expect((await rowOf(connection.id)).tokenStatus).toBe(expected);
    },
  );

  test("a transport failure before dispatch is retryable without pausing the connection", async () => {
    const connection = await connected();
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    await new Promise<void>((done, fail) =>
      server.close((error) => (error ? fail(error) : done())),
    );
    if (!address || typeof address === "string")
      throw new Error("Fixture needs a TCP port");

    const task = `
      const { db } = require("./dist/packages/shared/db.js");
      const { accessFor } = require("./dist/packages/shared/tokens.js");
      accessFor(process.argv[1], 0, 1).then(
        () => { process.exitCode = 1; },
        error => console.log(error.reason, error.retryable),
      ).finally(() => db.$disconnect());
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["-e", task, connection.id],
      {
        env: {
          ...process.env,
          PROVIDER_URL: `http://127.0.0.1:${address.port}`,
        },
        timeout: 8000,
      },
    );
    expect(stdout.trim()).toBe("provider_unreachable true");
    expect(await rowOf(connection.id)).toMatchObject({
      tokenVersion: 1,
      tokenStatus: "connected",
      refreshLeaseUntil: null,
    });
  });

  test("T22 a PostgreSQL write failure after rotation pauses the sync and blocks further refresh", async () => {
    const connection = await connected();
    await db.connection.update({
      where: { id: connection.id },
      data: { tokenExpiresAt: new Date(0) },
    });
    const tag = "test_save_" + randomUUID().replaceAll("-", "");
    await db.$executeRawUnsafe(`
      CREATE FUNCTION ${tag}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${connection.id}' AND NEW.token_version > OLD.token_version THEN RAISE EXCEPTION 'test write failure'; END IF;
        RETURN NEW;
      END $$`);
    try {
      await db.$executeRawUnsafe(
        `CREATE TRIGGER ${tag} BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION ${tag}()`,
      );
      const before = (await stats()).refreshCalls;
      const run = await trigger(connection);
      await poll(
        async () =>
          (await db.syncRun.findUnique({ where: { id: run.id } }))?.error ===
          "needs_reauth",
      );
      expect(
        await json(`/connections/${connection.id}`, connection.token),
      ).toMatchObject({
        tokenStatus: "needs_reauth",
        tokenError: "rotated_token_save_failed",
        tokenVersion: 1,
      });
      await expect(accessFor(connection.id, 0, 1)).rejects.toThrow(
        "needs_reauth",
      );
      expect((await stats()).refreshCalls - before).toBe(1);
    } finally {
      await db.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${tag} ON connections`,
      );
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${tag}()`);
    }
    await authorize(connection);
    expect(
      (await waitRun(connection, (await trigger(connection)).id)).status,
    ).toBe("succeeded");
  });

  test.each([true, false])(
    "T26 ambiguous timeout converges to needs_reauth (rotate before delay = %s)",
    async (rotateBeforeDelay) => {
      const connection = await connected();
      await faults({ refreshDelayMs: 1800, rotateBeforeDelay });
      const before = (await stats()).refreshCalls;
      const results = await Promise.allSettled([
        accessFor(connection.id, 0, 1),
        accessFor(connection.id, 0, 1),
      ]);
      expect(
        results.every(
          (result) =>
            result.status === "rejected" &&
            result.reason.message === "needs_reauth",
        ),
      ).toBe(true);
      await sleep(400);
      expect(await rowOf(connection.id)).toMatchObject({
        tokenVersion: 1,
        tokenStatus: "needs_reauth",
      });
      expect((await stats()).refreshCalls - before).toBe(1);
    },
  );

  test("envelope ciphertext round-trips without persisting plaintext tokens", async () => {
    const connection = await connected();
    const row = await rowOf(connection.id);
    const tokens = readTokens(row);
    expect(row.keyVersion).toBe(process.env.ENVELOPE_KEY_VERSION ?? "local-v1");
    expect(row.encryptedTokens).toContain("wrappedKey");
    expect(JSON.stringify(row)).not.toContain(tokens.access_token);
    expect(JSON.stringify(row)).not.toContain(tokens.refresh_token);
    expect((await page(tokens.access_token)).items).toHaveLength(2);
  });

  test("T19 JWT verification and tenant-scoped connection and mirror access", async () => {
    const connection = await connected();
    const other = await createConnection();
    await waitRun(connection, (await trigger(connection)).id);
    const path = `/connections/${connection.id}`;
    expect((await request(path)).status).toBe(401);
    const parts = connection.token.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    expect((await request(path, parts.join("."))).status).toBe(401);
    expect((await request(path, other.token)).status).toBe(404);
    expect(
      (await request(path, other.token, "PATCH", { name: "forbidden" })).status,
    ).toBe(404);
    expect((await request(path + "/records", other.token)).status).toBe(404);
    expect(
      (await request(path + "/sync", other.token, "POST", { mode: "full" }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(path, connection.token, "PATCH", {
          tenant_id: other.id,
          name: "forbidden",
        })
      ).status,
    ).toBe(403);
    expect(
      (await json("/connections", other.token)).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([other.id]);
    const tenant = (await json("/tenant", connection.token)).id;
    expect(
      (await request(path, identity(tenant, "viewer"), "DELETE")).status,
    ).toBe(403);
    expect(await records(connection)).toHaveLength(5);
  });

  test("T05 page 2 failure leaves page 1 checkpoint intact and resumes once", async () => {
    const connection = await connected();
    await faults({ failPage: 2 });
    const [run, duplicate] = await Promise.all([
      trigger(connection),
      trigger(connection),
    ]);
    expect(duplicate.id).toBe(run.id);
    const pending = await poll(async () => {
      const current = await db.operationAttempt.findUnique({
        where: { key: run.id + "-1" },
        include: { run: true },
      });
      return current?.state === "pending" && current.attemptCount === 1
        ? current
        : undefined;
    });
    expect(pending.run).toMatchObject({
      page: 1,
      status: "running",
      error: "provider_http_error",
    });
    expect(pending.run.cursor).toBeTruthy();
    expect(await records(connection)).toHaveLength(2);
    expect(await db.syncRecordOutcome.count({ where: { runId: run.id } })).toBe(
      2,
    );
    const recovered = await waitRun(connection, run.id);
    expect(recovered).toMatchObject({
      status: "succeeded",
      page: 3,
      _count: { outcomes: 5 },
    });
    expect(await records(connection)).toHaveLength(5);
    const incremental = await waitRun(
      connection,
      (await trigger(connection, "incremental")).id,
    );
    expect(incremental).toMatchObject({
      status: "succeeded",
      since: 5,
      page: 1,
      _count: { outcomes: 0 },
    });
  });

  test("T13 expired snapshot fails the interrupted run and a fresh trigger traverses from page 1", async () => {
    const connection = await connected();
    await faults({ failPage: 2 });
    const original = await trigger(connection);
    await poll(async () => {
      const row = await db.operationAttempt.findUnique({
        where: { key: original.id + "-1" },
      });
      return row?.state === "pending" && row.attemptCount === 1;
    });
    await faults({ expireSnapshot: true });
    expect(await waitRun(connection, original.id)).toMatchObject({
      status: "failed",
      error: "snapshot_expired",
      page: 1,
      _count: { outcomes: 2 },
    });
    const fresh = await trigger(connection);
    expect(fresh.id).not.toBe(original.id);
    expect(await waitRun(connection, fresh.id)).toMatchObject({
      status: "succeeded",
      page: 3,
      _count: { outcomes: 5 },
    });
    expect(
      await db.syncRecordOutcome.count({
        where: { runId: fresh.id, result: "unchanged" },
      }),
    ).toBe(2);
  });

  test.each(["delta", "date"])(
    "429 honors Retry-After (%s)",
    async (rateLimit) => {
      const connection = await connected();
      await faults({ rateLimit });
      const start = Date.now();
      const run = await trigger(connection);
      const deferred = await poll(async () => {
        const row = await db.operationAttempt.findUnique({
          where: { key: run.id + "-0" },
        });
        return row?.state === "pending" && row.attemptCount === 1
          ? row
          : undefined;
      });
      expect(deferred.dueAt.getTime() - start).toBeGreaterThanOrEqual(1000);
      await sleep(300);
      expect(
        await db.operationAttempt.findUnique({ where: { key: run.id + "-0" } }),
      ).toMatchObject({ attemptCount: 1 });
      expect((await waitRun(connection, run.id)).status).toBe("succeeded");
    },
  );
});
