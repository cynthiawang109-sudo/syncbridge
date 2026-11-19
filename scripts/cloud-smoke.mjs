import assert from "node:assert/strict";
import {
  api,
  authorize,
  createConnection,
  records,
  trigger,
  waitRun,
} from "./scenario.mjs";
import { event, mutate, waitEvent } from "./webhook-scenario.mjs";

if (
  !process.env.API_URL?.startsWith("https://") ||
  !process.env.PROVIDER_URL?.startsWith("https://") ||
  !process.env.JWT_SECRET ||
  !process.env.NODE_EXTRA_CA_CERTS
) {
  throw new Error("Use the HTTPS deployment outputs and the demo credentials");
}
const health = await fetch(api + "/health", {
  signal: AbortSignal.timeout(10000),
});
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true });
console.log("ALB HTTPS health returned HTTP 200");

const connection = await createConnection();
assert.equal((await authorize(connection)).tokenStatus, "connected");
console.log(
  "OAuth authorization code and PKCE completed against the deployed synthetic provider",
);

const run = await waitRun(connection, (await trigger(connection)).id);
assert.equal(run.status, "succeeded");
const initial = await records(connection);
assert.deepEqual(
  initial.map((row) => [row.externalId, row.version]),
  [
    ["synthetic-01", 1],
    ["synthetic-02", 2],
    ["synthetic-03", 1],
    ["synthetic-04", 3],
    ["synthetic-05", 1],
  ],
);
console.log("Full employee sync succeeded with five verified mirror versions");

const hook = event("synthetic-01", 7);
const delivered = await mutate(
  connection.id,
  [hook],
  [
    {
      resource: "employees",
      row: { id: hook.externalId, version: 7, name: "Synthetic cloud update" },
    },
  ],
);
assert.deepEqual(delivered.statuses, [202]);
await waitEvent(connection, hook.id);
const result = await records(connection);
assert.equal(result.length, 5);
assert.equal(
  result.find((row) => row.externalId === hook.externalId)?.version,
  7,
);
console.log(
  "The provider delivered one signed webhook, the archive reached processed, and the mirror advanced to version 7",
);
