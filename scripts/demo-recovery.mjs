import assert from "node:assert/strict";
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

const connection = await createConnection();
await authorize(connection);
const setFault = async (body) => {
  const response = await fetch(mock + "/__test/faults", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
};
await setFault({ failPage: 2 });
try {
  const run = await trigger(connection);
  const checkpoint = await poll(async () => {
    const current = await json(
      `/connections/${connection.id}/sync/${run.id}`,
      connection.token,
    );
    return current.page === 1 && current.error === "provider_http_error"
      ? current
      : undefined;
  });
  assert.ok(checkpoint.cursor);
  assert.equal(checkpoint._count.outcomes, 2);
  console.log(
    "Injected HTTP 503 on page 2; checkpoint stayed at page 1 with 2 durable outcomes",
  );
  const recovered = await waitRun(connection, run.id);
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered._count.outcomes, 5);
  assert.equal((await records(connection)).length, 5);
  console.log(
    "The same run resumed and finished with 5 mirror rows and 5 outcomes",
  );
} finally {
  await setFault({});
}
