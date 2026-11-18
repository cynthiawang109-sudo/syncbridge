import assert from "node:assert/strict";
import {
  authorize,
  createConnection,
  records,
  trigger,
  waitRun,
} from "./scenario.mjs";

const connection = await createConnection();
console.log("Tenant and connection created");
const authorized = await authorize(connection);
assert.equal(authorized.tokenStatus, "connected");
console.log("Mock OAuth connected via S256 PKCE");
const run = await trigger(connection);
const result = await waitRun(connection, run.id);
assert.equal(result.status, "succeeded");
assert.equal(result.page, 3);
console.log(`Full employee sync succeeded in ${result.page} pages`);
const mirror = (await records(connection)).map(({ externalId, version }) => [
  externalId,
  version,
]);
assert.deepEqual(mirror, [
  ["synthetic-01", 1],
  ["synthetic-02", 2],
  ["synthetic-03", 1],
  ["synthetic-04", 3],
  ["synthetic-05", 1],
]);
console.log(
  "Mirror ID and version:",
  mirror.map(([id, version]) => `${id}=v${version}`).join(", "),
);
