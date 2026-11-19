import { afterAll, afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { db } from "../packages/shared/db";
import { createQueue } from "../packages/shared/queue";
import { processReconciliation } from "../apps/worker/reconciliation";
import {
  api,
  authorize,
  createConnection,
  identity,
  json,
  poll,
  records,
  request,
  trigger,
  waitRun,
} from "../scripts/scenario.mjs";
import { faults, mutate } from "../scripts/webhook-scenario.mjs";

type Connection = Awaited<ReturnType<typeof createConnection>>;
type Finding = {
  externalId: string;
  classification: string;
  confidence: string;
  repairStatus: string;
  repairResult: string | null;
};
async function connected(sync = true) {
  const connection = await createConnection();
  await authorize(connection);
  if (sync)
    expect(
      (await waitRun(connection, (await trigger(connection)).id)).status,
    ).toBe("succeeded");
  return connection;
}
const route = (connection: Connection) =>
  "/connections/" + connection.id + "/reconciliation";
const start = (connection: Connection, resourceType = "employees") =>
  json(route(connection), connection.token, "POST", { resourceType });
const report = (connection: Connection, id: string) =>
  json(route(connection) + "/" + id, connection.token);
const employee = (
  id: string,
  version: number,
  name = "Synthetic revised record",
) => ({ resource: "employees", row: { id, version, name } });
function compose(...args: string[]) {
  const project = process.env.MVP_B_COMPOSE_PROJECT;
  execFileSync(
    "docker",
    ["compose", ...(project ? ["-p", project] : []), ...args],
    { stdio: "pipe", timeout: 25000 },
  );
}
afterEach(() => faults({ resetData: true }));
afterAll(() => db.$disconnect());

test("T08 confirmed drift repairs stale and missing locally and reports absence and conflicts without writing", async () => {
  const connection = await connected();
  await faults({ silent: true });
  const result = await mutate(
    connection.id,
    [],
    [
      employee("synthetic-01", 7),
      employee("synthetic-new", 1),
      employee("synthetic-02", 2, "Synthetic conflicting payload"),
    ],
    { remove: [{ resource: "employees", externalId: "synthetic-04" }] },
  );
  expect(result.statuses).toEqual([]);
  const run = await start(connection);
  const resultReport = await poll(async () => {
    const row = await report(connection, run.id);
    return row.status === "confirmed" &&
      row.findings.filter((f: Finding) => f.repairStatus === "applied")
        .length === 2
      ? row
      : undefined;
  });
  expect(resultReport.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        externalId: "synthetic-01",
        classification: "stale",
        confidence: "confirmed",
        repairStatus: "applied",
      }),
      expect.objectContaining({
        externalId: "synthetic-new",
        classification: "missing_locally",
        confidence: "confirmed",
        repairStatus: "applied",
      }),
      expect.objectContaining({
        externalId: "synthetic-02",
        classification: "conflicted",
        confidence: "confirmed",
        repairStatus: "none",
      }),
      expect.objectContaining({
        externalId: "synthetic-04",
        classification: "missing_remotely",
        confidence: "confirmed",
        repairStatus: "none",
      }),
    ]),
  );
  expect(
    await db.operationAttempt.count({
      where: { reconciliationId: run.id, repairRecordId: { not: null } },
    }),
  ).toBe(2);
  const mirror = await records(connection);
  expect(mirror).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ externalId: "synthetic-01", version: 7 }),
      expect.objectContaining({ externalId: "synthetic-new", version: 1 }),
      expect.objectContaining({
        externalId: "synthetic-02",
        payload: { id: "synthetic-02", name: "Birch Example", version: 2 },
      }),
      expect.objectContaining({
        externalId: "synthetic-04",
        version: 3,
        tombstone: false,
      }),
    ]),
  );
  const outsider = await connected(false);
  expect(
    (await request(route(connection) + "/" + run.id, outsider.token)).status,
  ).toBe(404);
  const tenant = (await json("/tenant", connection.token)).id;
  const viewer = identity(tenant, "viewer");
  expect(
    (
      await request(route(connection), viewer, "POST", {
        resourceType: "employees",
      })
    ).status,
  ).toBe(403);
  expect((await request(route(connection) + "/" + run.id, viewer)).status).toBe(
    200,
  );
});
test("T29 changing the provider mid-traversal and invalidating its cursor leaves only provisional findings", async () => {
  const connection = await connected();
  await faults({ silent: true, latencyMs: 900 });
  await mutate(connection.id, [], [employee("synthetic-01", 8)]);
  const run = await start(connection);
  await poll(async () => (await report(connection, run.id)).page === 1);
  await mutate(connection.id, [], [employee("synthetic-moved", 1)], {
    remove: [{ resource: "employees", externalId: "synthetic-05" }],
    invalidateSnapshots: true,
  });
  const result = await poll(async () => {
    const row = await report(connection, run.id);
    return row.status === "provisional" ? row : undefined;
  });
  expect(result.reason).toBe("snapshot_expired");
  expect(result.findings).toEqual([
    expect.objectContaining({
      classification: "stale",
      confidence: "provisional",
      repairStatus: "none",
    }),
  ]);
  expect(
    await db.operationAttempt.count({
      where: { reconciliationId: run.id, repairRecordId: { not: null } },
    }),
  ).toBe(0);
  expect(await records(connection)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ externalId: "synthetic-01", version: 1 }),
      expect.objectContaining({ externalId: "synthetic-05", tombstone: false }),
    ]),
  );
});
test("a generation change aborts a queued repair and reports its disposition", async () => {
  const connection = await connected();
  const fixture = "hold_" + randomUUID().replaceAll("-", "");
  if (!/^[a-f0-9-]+$/.test(connection.id))
    throw new Error("Expected a fixture UUID");
  await db.$executeRawUnsafe(`CREATE FUNCTION ${fixture}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.connection_id = '${connection.id}' AND NEW.repair_record_id IS NOT NULL THEN
      NEW.due_at := NOW() + INTERVAL '10 minutes';
    END IF; RETURN NEW; END $$`);
  try {
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${fixture} BEFORE INSERT ON operation_attempt FOR EACH ROW EXECUTE FUNCTION ${fixture}()`,
    );
    await mutate(connection.id, [], [employee("synthetic-01", 9)]);
    const run = await start(connection);
    const operation = await poll(
      async () =>
        (await db.operationAttempt.findFirst({
          where: { reconciliationId: run.id, repairRecordId: "synthetic-01" },
        })) ?? undefined,
    );
    expect(operation.attemptCount).toBe(0);
    await json("/connections/" + connection.id, connection.token, "DELETE");
    const queue = createQueue();
    try {
      await queue.add("reconciliation", {
        operationKey: operation.key,
        generation: run.generation,
      });
    } finally {
      await queue.close();
    }
    await processReconciliation(operation.key, run.generation);
    expect((await report(connection, run.id)).findings).toEqual([
      expect.objectContaining({
        repairStatus: "aborted",
        repairResult: "generation_changed",
      }),
    ]);
    expect(
      await db.operationAttempt.findUnique({ where: { key: operation.key } }),
    ).toMatchObject({ state: "failed", attemptCount: 0 });
    expect(
      await db.externalRecord.count({
        where: { connectionId: connection.id, version: 9 },
      }),
    ).toBe(0);
  } finally {
    await db.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${fixture} ON operation_attempt`,
    );
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fixture}()`);
  }
});
test("T28 repair retries respect persisted due_at and retain the attempt budget across restart", async () => {
  const connection = await connected(false);
  const fixture = "retry_" + randomUUID().replaceAll("-", "");
  if (!/^[a-f0-9-]+$/.test(connection.id))
    throw new Error("Expected a fixture UUID");
  let stopped = false;
  await db.$executeRawUnsafe(`CREATE SEQUENCE ${fixture}`);
  await db.$executeRawUnsafe(`CREATE FUNCTION ${fixture}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.connection_id = '${connection.id}' AND NEW.external_id='synthetic-01' AND nextval('${fixture}')=1 THEN
      RAISE EXCEPTION 'transient fixture fault' USING ERRCODE='40001';
    END IF; RETURN NEW; END $$`);
  try {
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${fixture} BEFORE INSERT ON external_records FOR EACH ROW EXECUTE FUNCTION ${fixture}()`,
    );
    const run = await start(connection);
    const operation = await poll(async () => {
      const row = await db.operationAttempt.findFirst({
        where: { reconciliationId: run.id, repairRecordId: "synthetic-01" },
      });
      return row?.state === "pending" && row.attemptCount === 1
        ? row
        : undefined;
    });
    expect(operation.dueAt.getTime()).toBeGreaterThan(Date.now());
    await Promise.all([
      processReconciliation(operation.key, run.generation),
      processReconciliation(operation.key, run.generation),
    ]);
    expect(
      await db.operationAttempt.findUnique({ where: { key: operation.key } }),
    ).toMatchObject({
      state: "pending",
      attemptCount: 1,
      dueAt: operation.dueAt,
    });
    compose("stop", "worker");
    stopped = true;
    compose("start", "worker");
    stopped = false;
    await poll(
      async () =>
        (
          await db.operationAttempt.findUnique({
            where: { key: operation.key },
          })
        )?.state === "done",
    );
    expect(
      await db.operationAttempt.findUnique({ where: { key: operation.key } }),
    ).toMatchObject({ attemptCount: 2 });
    expect(
      await db.attemptHistory.count({ where: { operationKey: operation.key } }),
    ).toBe(2);
    expect(
      (await report(connection, run.id)).findings.find(
        (finding: Finding) => finding.externalId === "synthetic-01",
      ),
    ).toMatchObject({ repairStatus: "applied" });
  } finally {
    if (stopped) compose("start", "worker");
    await db.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${fixture} ON external_records`,
    );
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fixture}()`);
    await db.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS ${fixture}`);
  }
}, 45000);
test("scheduled reconciliation and metrics are tenant-scoped with read-only viewer access", async () => {
  const connection = await connected(false);
  expect((await fetch(api + "/metrics")).status).toBe(401);
  await faults({ rateLimit: "date" });
  const synced = await waitRun(connection, (await trigger(connection)).id);
  expect(synced.status).toBe("succeeded");
  await db.connection.update({
    where: { id: connection.id },
    data: { reconcilePayrunsAt: new Date(0) },
  });
  const scheduled = await poll(
    async () =>
      (await db.reconciliationRun.findFirst({
        where: {
          connectionId: connection.id,
          resourceType: "payruns",
          trigger: "scheduled",
          status: "confirmed",
        },
      })) ?? undefined,
  );
  expect(scheduled.page).toBe(2);
  const tenant = (await json("/tenant", connection.token)).id;
  const viewer = identity(tenant, "viewer");
  const metrics = await poll(async () => {
    const result = await json("/metrics", viewer);
    return result.provider429s === 1 && result.syncDuration.samples > 0
      ? result
      : undefined;
  });
  expect(metrics).toMatchObject({ dlqDepth: 0, retryCount: 1 });
  expect(metrics.queueLag.samples).toBeGreaterThan(0);
  expect(metrics.rate429).toBeGreaterThan(0);
  expect(await json("/metrics", identity())).toMatchObject({
    providerRequests: 0,
    retryCount: 0,
    dlqDepth: 0,
    connections: [],
  });
});
