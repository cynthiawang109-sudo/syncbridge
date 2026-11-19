import { afterAll, afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  archiveItem,
  claimArchive,
  expireArchiveItem,
  openReceipt,
  ARCHIVE_LEASE_MS,
} from "../packages/shared/archive";
import { db } from "../packages/shared/db";
import { createQueue } from "../packages/shared/queue";
import {
  dispatchArchiveItem,
  eventKey,
  sweepWebhooks,
} from "../apps/worker/webhooks";
import {
  verifyWebhook,
  signature,
  webhookSecret,
} from "../packages/shared/events";
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
import {
  event,
  faults,
  mutate,
  waitEvent,
  webhook,
} from "../scripts/webhook-scenario.mjs";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: process.env.DYNAMODB_URL ?? "http://localhost:4800",
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
);
function compose(...args: string[]) {
  const project = process.env.MVP_B_COMPOSE_PROJECT;
  execFileSync(
    "docker",
    ["compose", ...(project ? ["-p", project] : []), ...args],
    { stdio: "pipe", timeout: 22000 },
  );
}
let workerStopped = false;
function stopWorker() {
  compose("stop", "worker");
  workerStopped = true;
}
function startWorker() {
  compose("start", "worker");
  workerStopped = false;
}
const archiveKey = (connection_id: string, event_id: string) => ({
  connection_id,
  event_id,
});
async function restoreLease(
  connectionId: string,
  eventId: string,
  next = Date.now() - 500,
  expires = Date.now() - 500,
  received?: number,
) {
  await ddb.send(
    new UpdateCommand({
      TableName: "webhook_events",
      Key: archiveKey(connectionId, eventId),
      UpdateExpression:
        "SET #s = :leased, lease_expires_at=:expires, due_at=:due, next_attempt_at=:next, received_at=:received REMOVE #t",
      ExpressionAttributeNames: { "#s": "status", "#t": "ttl" },
      ExpressionAttributeValues: {
        ":leased": "leased",
        ":expires": expires,
        ":due": Math.max(next, expires),
        ":next": next,
        ":received": received ?? Date.now(),
      },
    }),
  );
}
async function connected() {
  const connection = await createConnection();
  await authorize(connection);
  return connection;
}
async function deadEntry(
  connection: Awaited<ReturnType<typeof connected>>,
  id: string,
) {
  await faults({ failGet: 400 });
  const hook = { ...event("synthetic-01", 1), id };
  expect((await webhook(connection.id, hook)).status).toBe(202);
  const terminal = await waitEvent(connection, hook.id, "dead_lettered");
  const entry = await json(
    "/dead-letters/" + terminal.dlq_id,
    connection.token,
  );
  expect(entry.providerError).toEqual({ error: "synthetic_get_failure" });
  return entry;
}
afterEach(async () => {
  if (workerStopped) startWorker();
  await faults({ resetData: true });
});
afterAll(async () => {
  ddb.destroy();
  await db.$disconnect();
});

describe("MVP-B Compose integration", () => {
  test("T09 and T16 raw authentication, rotation, size cap, archive encryption and log redaction", async () => {
    const connection = await connected();
    const hook = event("synthetic-01", 1);
    expect((await webhook(connection.id, hook, { invalid: true })).status).toBe(
      401,
    );
    expect(
      (await webhook(connection.id, hook, { timestamp: Date.now() - 400000 }))
        .status,
    ).toBe(401);
    expect((await webhook(connection.id, "x".repeat(262145))).status).toBe(413);
    expect((await webhook(connection.id, "{")).status).toBe(400);
    const previousKey = process.env.WEBHOOK_PREVIOUS_KEY,
      previousUntil = process.env.WEBHOOK_PREVIOUS_UNTIL;
    try {
      process.env.WEBHOOK_PREVIOUS_KEY = "rotation-fixture";
      const now = Date.now();
      process.env.WEBHOOK_PREVIOUS_UNTIL = String(now + 3000);
      const raw = Buffer.from(JSON.stringify(hook));
      const signed = signature(
        webhookSecret(connection.id, true)!,
        String(now),
        raw,
      ).toString("hex");
      expect(verifyWebhook(connection.id, String(now), raw, signed, now)).toBe(
        true,
      );
      expect(
        verifyWebhook(connection.id, String(now), raw, signed, now + 4000),
      ).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env.WEBHOOK_PREVIOUS_KEY;
      else process.env.WEBHOOK_PREVIOUS_KEY = previousKey;
      if (previousUntil === undefined)
        delete process.env.WEBHOOK_PREVIOUS_UNTIL;
      else process.env.WEBHOOK_PREVIOUS_UNTIL = previousUntil;
    }
    const privateBody = {
      ...hook,
      salary: "synthetic-salary-redaction-marker",
      access_token: "synthetic-token-redaction-marker",
    };
    expect((await webhook(connection.id, privateBody)).status).toBe(202);
    await waitEvent(connection, hook.id);
    const archive = (await archiveItem(connection.id, hook.id))!;
    expect(JSON.parse(openReceipt(archive).toString())).toEqual(privateBody);
    expect(archive.ttl).toBeGreaterThan(Date.now() / 1000);
    expect(JSON.stringify(archive)).not.toContain("redaction-marker");
    const project = process.env.MVP_B_COMPOSE_PROJECT;
    const logs = execFileSync(
      "docker",
      [
        "compose",
        ...(project ? ["-p", project] : []),
        "logs",
        "--no-color",
        "api",
        "mock-provider",
        "worker",
      ],
      { encoding: "utf8" },
    );
    expect(logs).not.toContain("redaction-marker");
    expect(logs).not.toContain("x-webhook-signature");
  });
  test("T04/T20 fetched versions apply, stale versions drop and equal-version conflicts persist", async () => {
    const connection = await connected();
    for (const [seen, fetched, name, result] of [
      [2, 4, "Version four", "applied"],
      [1, 1, "Version one", "stale"],
      [2, 2, "Version two", "stale"],
      [4, 4, "Conflicting four", "conflict"],
    ] as const) {
      const hook = event("synthetic-webhook-order", seen);
      const statuses = await mutate(
        connection.id,
        [hook],
        [
          {
            resource: "employees",
            row: { id: hook.externalId, version: fetched, name },
          },
        ],
      );
      expect(statuses.statuses).toEqual([202]);
      await waitEvent(connection, hook.id);
      expect(
        await db.webhookOutcome.findUnique({
          where: { operationKey: eventKey(archiveKey(connection.id, hook.id)) },
        }),
      ).toMatchObject({
        eventId: hook.id,
        eventVersion: seen,
        fetchedVersion: fetched,
        result,
      });
    }
    expect(await records(connection)).toMatchObject([
      { version: 4, payload: { name: "Version four" } },
    ]);
  });
  test("payruns share full, incremental and webhook processing with employees", async () => {
    const connection = await connected();
    const base = "/connections/" + connection.id + "/sync";
    const [employees, payruns] = await Promise.all([
      trigger(connection),
      json(base, connection.token, "POST", {
        mode: "full",
        resourceType: "payruns",
      }),
    ]);
    expect((await waitRun(connection, employees.id)).status).toBe("succeeded");
    expect((await waitRun(connection, payruns.id)).status).toBe("succeeded");
    expect(
      (await records(connection)).filter(
        (row: { resourceType: string }) => row.resourceType === "payruns",
      ),
    ).toHaveLength(3);
    await faults({ duplicate: true, outOfOrder: true });
    const hooks = [
      event("synthetic-pay-01", 1, "update", "payruns"),
      event("synthetic-pay-01", 4, "update", "payruns"),
    ];
    const delivered = await mutate(connection.id, hooks, [
      {
        resource: "payruns",
        row: {
          id: "synthetic-pay-01",
          name: "Changed payrun",
          version: 4,
          amount: 76543,
        },
      },
    ]);
    expect(delivered.statuses).toEqual([202, 202, 202, 202]);
    await Promise.all(hooks.map((hook) => waitEvent(connection, hook.id)));
    expect(
      await db.webhookOutcome.count({ where: { connectionId: connection.id } }),
    ).toBe(2);
    const incremental = await json(base, connection.token, "POST", {
      mode: "incremental",
      resourceType: "payruns",
    });
    expect(await waitRun(connection, incremental.id)).toMatchObject({
      status: "succeeded",
      since: 3,
      _count: { outcomes: 1 },
    });
  });
  test("T27 direct delete, unresolved update, then stale update preserve the tombstone", async () => {
    const connection = await connected();
    const invalid = {
      ...event("synthetic-01", 6, "delete"),
      version: undefined,
    };
    expect((await webhook(connection.id, invalid)).status).toBe(400);
    await faults({ failGet: 404 });
    const update = event("synthetic-01", 1);
    expect((await webhook(connection.id, update)).status).toBe(202);
    const key = eventKey(archiveKey(connection.id, update.id));
    await poll(
      async () =>
        (await db.attemptHistory.findFirst({
          where: { operationKey: key, result: "unresolved" },
        })) || undefined,
    );
    expect(await records(connection)).toHaveLength(0);
    await waitEvent(connection, update.id);
    const deletion = event("synthetic-01", 6, "delete");
    expect((await webhook(connection.id, deletion)).status).toBe(202);
    await waitEvent(connection, deletion.id);
    const late = event("synthetic-01", 5);
    await mutate(
      connection.id,
      [late],
      [
        {
          resource: "employees",
          row: { id: late.externalId, version: 5, name: "Late fixture" },
        },
      ],
    );
    await waitEvent(connection, late.id);
    expect(await records(connection)).toMatchObject([
      { version: 6, tombstone: true },
    ]);
  });
  test("T06/T07/T21 preserve provider error and audit replay races and role/tenant denials", async () => {
    const connection = await connected(),
      other = await connected();
    const entry = await deadEntry(connection, event("synthetic-01", 1).id);
    const route = "/dead-letters/" + entry.id + "/replay";
    const tenant = (await json("/tenant", connection.token)).id;
    expect(
      (await request(route, identity(tenant, "viewer"), "POST")).status,
    ).toBe(403);
    expect((await request(route, other.token, "POST")).status).toBe(404);
    const results = await Promise.all([
      request(route, connection.token, "POST"),
      request(route, connection.token, "POST"),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    await waitEvent(connection, entry.eventId, "processed");
    const read = await json("/dead-letters/" + entry.id, connection.token);
    expect(read.state).toBe("resolved");
    expect(
      read.audits.map((audit: { result: string }) => audit.result).sort(),
    ).toEqual(["denied_role", "denied_state", "denied_tenant", "resolved"]);
  });
  test("T25 replay from PostgreSQL when the archive expires, and refuse expired DLQ evidence", async () => {
    const connection = await connected();
    const entry = await deadEntry(connection, event("synthetic-01", 1).id);
    await ddb.send(
      new DeleteCommand({
        TableName: "webhook_events",
        Key: archiveKey(connection.id, entry.eventId),
      }),
    );
    await json(
      "/dead-letters/" + entry.id + "/replay",
      connection.token,
      "POST",
    );
    await poll(
      async () =>
        (await db.deadLetter.findUnique({ where: { id: entry.id } }))?.state ===
        "resolved",
    );
    expect(
      await db.replayAudit.findFirst({ where: { deadLetterId: entry.id } }),
    ).toMatchObject({ result: "resolved", archiveAbsent: true });
    await db.deadLetter.update({
      where: { id: entry.id },
      data: { createdAt: new Date(0), state: "reopened" },
    });
    expect(
      (
        await request(
          "/dead-letters/" + entry.id + "/replay",
          connection.token,
          "POST",
        )
      ).status,
    ).toBe(410);
  });
  test("T01/T10 recover archived receipt after enqueue failure and aged cleanup leaves it intact", async () => {
    stopWorker();
    const connection = await connected(),
      hook = event("synthetic-01", 1);
    expect((await webhook(connection.id, hook)).status).toBe(202);
    const pending = (await archiveItem(connection.id, hook.id))!;
    expect(pending.ttl).toBeUndefined();
    await expireArchiveItem(pending, Date.now() + 40 * 86400000);
    expect(await archiveItem(connection.id, hook.id)).toBeDefined();
    const disconnectedQueue = createQueue();
    await disconnectedQueue.close();
    await expect(
      dispatchArchiveItem(pending, disconnectedQueue),
    ).rejects.toThrow();
    expect((await archiveItem(connection.id, hook.id))?.status).toBe("leased");
    await restoreLease(
      connection.id,
      hook.id,
      Date.now() - 500,
      Date.now() - 500,
      Date.now() - 2 * 86400000,
    );
    const queue = createQueue();
    try {
      await sweepWebhooks(queue, Date.now() + 86400000);
    } finally {
      await queue.close();
    }
    startWorker();
    await waitEvent(connection, hook.id);
    expect(
      await db.webhookOutcome.count({
        where: { connectionId: connection.id, eventId: hook.id },
      }),
    ).toBe(1);
  }, 45000);
  test("T02/T11/T18 terminal projections converge from durable PG outcomes and stale leases cannot regress them", async () => {
    const connection = await connected();
    const applied = event("synthetic-01", 1);
    await webhook(connection.id, applied);
    await waitEvent(connection, applied.id);
    stopWorker();
    await restoreLease(connection.id, applied.id);
    const stale = (await archiveItem(connection.id, applied.id))!;
    const queue = createQueue();
    try {
      await Promise.all([
        dispatchArchiveItem(stale, queue),
        dispatchArchiveItem(stale, queue),
      ]);
      expect(await claimArchive(stale)).toBeUndefined();
    } finally {
      await queue.close();
    }
    expect((await archiveItem(connection.id, applied.id))?.status).toBe(
      "processed",
    );
    expect(
      await db.webhookOutcome.count({
        where: { connectionId: connection.id, eventId: applied.id },
      }),
    ).toBe(1);
    startWorker();
    const failed = await deadEntry(connection, event("synthetic-01", 1).id);
    await restoreLease(connection.id, failed.eventId);
    await waitEvent(connection, failed.eventId, "dead_lettered");
    expect(
      await db.deadLetter.count({
        where: { connectionId: connection.id, eventId: failed.eventId },
      }),
    ).toBe(1);
  }, 45000);
  test("T23 mismatched lease and next-attempt times honor max due and re-drive a stale discovery", async () => {
    stopWorker();
    const connection = await connected(),
      hook = event("synthetic-01", 1);
    await webhook(connection.id, hook);
    const before = (await archiveItem(connection.id, hook.id))!;
    const future = Date.now() + 1200;
    await restoreLease(connection.id, hook.id, future, Date.now() - 1000);
    expect(await claimArchive(before)).toBeUndefined();
    expect((await archiveItem(connection.id, hook.id))?.due_at).toBe(future);
    startWorker();
    await sleep(200);
    expect(await db.webhookOutcome.count({ where: { eventId: hook.id } })).toBe(
      0,
    );
    await waitEvent(connection, hook.id);
    expect(await db.webhookOutcome.count({ where: { eventId: hook.id } })).toBe(
      1,
    );
  }, 45000);
  test("T28 webhook retry survives a worker restart, reuses its PG operation key and stays behind due_at", async () => {
    const connection = await connected(),
      hook = event("synthetic-01", 1);
    await faults({ burst: 1 });
    await webhook(connection.id, hook);
    const key = eventKey(archiveKey(connection.id, hook.id));
    const retry = await poll(async () => {
      const op = await db.operationAttempt.findUnique({ where: { key } });
      return op?.attemptCount === 1 && op.state === "pending" ? op : undefined;
    });
    expect(retry.dueAt.getTime()).toBeGreaterThan(Date.now());
    stopWorker();
    await webhook(connection.id, hook);
    startWorker();
    await waitEvent(connection, hook.id);
    expect(
      await db.operationAttempt.findUnique({ where: { key } }),
    ).toMatchObject({ attemptCount: 2, state: "done" });
  }, 45000);
  test("T24 offboarding fences an in-flight fetch and verifies cleanup after the longest lease", async () => {
    const connection = await connected(),
      hook = event("synthetic-01", 1);
    const base = "/connections/" + connection.id;
    expect(
      (await waitRun(connection, (await trigger(connection)).id)).status,
    ).toBe("succeeded");
    const stats = async () =>
      (await (await fetch(mock + "/__test/stats")).json()).getCalls as number;
    const before = await stats();
    await faults({ latencyMs: 2000 });
    expect((await webhook(connection.id, hook)).status).toBe(202);
    await poll(async () => (await stats()) > before);
    expect(await json(base, connection.token, "DELETE")).toEqual({
      lifecycle: "closing",
    });
    expect((await webhook(connection.id, hook)).status).toBe(410);
    await poll(
      async () =>
        (await db.connection.findUnique({ where: { id: connection.id } }))
          ?.lifecycle === "deleted",
      ARCHIVE_LEASE_MS + 12000,
    );
    expect(await archiveItem(connection.id, hook.id)).toBeUndefined();
    expect(
      await db.externalRecord.count({ where: { connectionId: connection.id } }),
    ).toBe(0);
    expect(
      await db.webhookOutcome.count({ where: { connectionId: connection.id } }),
    ).toBe(0);
    const audits = await db.authorizationAudit.findMany({
      where: { object: connection.id },
    });
    expect(audits.map((row) => row.reason)).toEqual(
      expect.arrayContaining([
        "webhook_connection_closed",
        "closing_verified_initial",
        "closing_verified_after_lease",
      ]),
    );
  }, 50000);
});
