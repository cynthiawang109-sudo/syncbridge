import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  authorize,
  createConnection,
  json,
  mock,
  poll,
  records,
  trigger,
  waitRun,
} from "./scenario.mjs";
import {
  event,
  faults,
  mutate,
  waitEvent,
  webhook,
} from "./webhook-scenario.mjs";

function compose(...args) {
  const project = process.env.MVP_B_COMPOSE_PROJECT;
  execFileSync(
    "docker",
    ["compose", ...(project ? ["-p", project] : []), ...args],
    { stdio: "pipe", timeout: 30000 },
  );
}
export async function runRecovery({ hardening = false } = {}) {
  let stopped = false;
  await faults({ resetData: true });
  try {
    const connection = await createConnection();
    await authorize(connection);
    const base = "/connections/" + connection.id + "/sync";
    const [employeeRun, payrunRun] = await Promise.all([
      trigger(connection),
      json(base, connection.token, "POST", {
        mode: "full",
        resourceType: "payruns",
      }),
    ]);
    assert.equal(
      (await waitRun(connection, employeeRun.id)).status,
      "succeeded",
    );
    assert.equal((await waitRun(connection, payrunRun.id)).status, "succeeded");
    assert.equal((await records(connection)).length, 8);
    console.log("OAuth connected and synced 5 employees and 3 payruns");

    await faults({ duplicate: true, outOfOrder: true });
    const hooks = [
      event("synthetic-pay-01", 1, "update", "payruns"),
      event("synthetic-pay-01", 4, "update", "payruns"),
    ];
    const result = await mutate(connection.id, hooks, [
      {
        resource: "payruns",
        row: {
          id: "synthetic-pay-01",
          version: 4,
          name: "Synthetic adjusted pay period",
          amount: 45678,
        },
      },
    ]);
    assert.deepEqual(result.statuses, [202, 202, 202, 202]);
    await Promise.all(hooks.map((hook) => waitEvent(connection, hook.id)));
    assert.equal(
      (await records(connection)).find(
        (row) => row.externalId === "synthetic-pay-01",
      ).version,
      4,
    );
    console.log(
      "Four duplicate and out-of-order deliveries converged to payrun version 4",
    );

    await faults({ latencyMs: 3500 });
    const count = async () =>
      (await (await fetch(mock + "/__test/stats")).json()).getCalls;
    const before = await count();
    const interrupted = event("synthetic-01", 1);
    assert.equal((await webhook(connection.id, interrupted)).status, 202);
    await poll(async () => (await count()) > before);
    compose("kill", "-s", "SIGKILL", "worker");
    stopped = true;
    await waitEvent(connection, interrupted.id, "leased", 5000);
    const beforeLimits = hardening
      ? (await json("/metrics", connection.token)).provider429s
      : 0;
    await faults(hardening ? { rateLimit: "delta", rateLimitCount: 2 } : {});
    if (hardening)
      console.log(
        "Armed a two-response HTTP 429 burst with Retry-After before restarting the worker",
      );
    compose("start", "worker");
    stopped = false;
    const recovered = await waitEvent(
      connection,
      interrupted.id,
      "processed",
      80000,
    );
    assert.ok(recovered.attempt_count >= (hardening ? 4 : 2));
    if (hardening) {
      await poll(
        async () =>
          (await json("/metrics", connection.token)).provider429s ===
          beforeLimits + 2,
      );
      console.log(
        "Two HTTP 429 responses were recorded and the delivery completed on attempt " +
          recovered.attempt_count,
      );
    }
    console.log(
      "Killed the worker during a provider fetch; the sweeper recovered the expired lease",
    );

    await faults({ failGet: 400 });
    const failure = event("synthetic-02", 2);
    assert.equal((await webhook(connection.id, failure)).status, 202);
    const dead = await waitEvent(connection, failure.id, "dead_lettered");
    assert.ok(dead.dlq_id);
    await json(
      "/dead-letters/" + dead.dlq_id + "/replay",
      connection.token,
      "POST",
    );
    await waitEvent(connection, failure.id, "processed");
    assert.equal(
      (await json("/dead-letters/" + dead.dlq_id, connection.token)).state,
      "resolved",
    );
    console.log(
      "A provider HTTP 400 created a dead letter; operator replay resolved it",
    );
    if (hardening) await reconcileAndVerify(connection, dead.dlq_id);
  } finally {
    if (stopped) compose("start", "worker");
    await faults({ resetData: true });
  }
}
async function reconcileAndVerify(connection, deadLetterId) {
  await faults({ silent: true });
  const changes = [
    {
      resource: "employees",
      row: {
        id: "synthetic-01",
        name: "Synthetic revised employee",
        version: 7,
      },
    },
    {
      resource: "employees",
      row: {
        id: "synthetic-hardening",
        name: "Synthetic added employee",
        version: 1,
      },
    },
  ];
  assert.deepEqual((await mutate(connection.id, [], changes)).statuses, []);
  assert.equal(
    (await records(connection)).find((row) => row.externalId === "synthetic-01")
      .version,
    1,
  );
  console.log(
    "Silently changed one employee at the provider and added one provider-only employee",
  );
  const path = "/connections/" + connection.id + "/reconciliation";
  const run = await json(path, connection.token, "POST", {
    resourceType: "employees",
  });
  const report = await poll(async () => {
    const result = await json(path + "/" + run.id, connection.token);
    return result.status === "confirmed" &&
      result.findings.filter((row) => row.repairStatus === "applied").length ===
        2
      ? result
      : undefined;
  });
  assert.deepEqual(
    report.findings.map((finding) => [
      finding.externalId,
      finding.classification,
      finding.confidence,
      finding.repairStatus,
    ]),
    [
      ["synthetic-01", "stale", "confirmed", "applied"],
      ["synthetic-hardening", "missing_locally", "confirmed", "applied"],
    ],
  );
  console.log(
    "Stable snapshot confirmed and repaired stale and missing_locally findings",
  );
  const versions = Object.fromEntries(
    (await records(connection)).map((row) => [row.externalId, row.version]),
  );
  assert.deepEqual(versions, {
    "synthetic-01": 7,
    "synthetic-02": 2,
    "synthetic-03": 1,
    "synthetic-04": 3,
    "synthetic-05": 1,
    "synthetic-hardening": 1,
    "synthetic-pay-01": 4,
    "synthetic-pay-02": 2,
    "synthetic-pay-03": 1,
  });
  const { id: actor } = await json("/tenant", connection.token);
  const dead = await json("/dead-letters/" + deadLetterId, connection.token);
  assert.equal(dead.state, "resolved");
  assert.ok(
    dead.audits.some(
      (audit) =>
        audit.actor === actor &&
        audit.result === "resolved" &&
        audit.archiveAbsent === false &&
        Number.isFinite(Date.parse(audit.createdAt)),
    ),
  );
  assert.equal((await json("/metrics", connection.token)).dlqDepth, 0);
  console.log(
    "Verified nine mirror versions, zero outstanding dead letters, and the operator replay audit",
  );
}
