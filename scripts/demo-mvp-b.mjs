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
  assert.equal((await waitRun(connection, employeeRun.id)).status, "succeeded");
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
  await faults({});
  compose("start", "worker");
  stopped = false;
  const recovered = await waitEvent(
    connection,
    interrupted.id,
    "processed",
    80000,
  );
  assert.ok(recovered.attempt_count >= 2);
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
} finally {
  if (stopped) compose("start", "worker");
  await faults({ resetData: true });
}
