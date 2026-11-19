import { afterAll, expect, test } from "vitest";
import { db } from "../packages/shared/db";
import {
  createConnection,
  identity,
  json,
  request,
} from "../scripts/scenario.mjs";

const routes = [
  "/ops",
  "/ops/sync-runs",
  "/ops/dead-letters",
  "/ops/reconciliation",
];
afterAll(() => db.$disconnect());

async function seed(label: string) {
  const connection = await createConnection();
  const tenant = await json("/tenant", connection.token);
  await json("/connections/" + connection.id, connection.token, "PATCH", {
    name: label,
  });
  const [sync, dead, reconciliation] = await db.$transaction([
    db.syncRun.create({
      data: {
        connectionId: connection.id,
        generation: 0,
        mode: "full",
        since: 0,
        status: "succeeded",
      },
    }),
    db.deadLetter.create({
      data: {
        connectionId: connection.id,
        tenantId: tenant.id,
        operationKey: "fixture",
        reason: "provider_http_error",
        payload: { amount: "sensitive-payload-fixture" },
        providerError: { error: "sensitive-error-fixture" },
      },
    }),
    db.reconciliationRun.create({
      data: {
        connectionId: connection.id,
        generation: 0,
        resourceType: "employees",
        trigger: "manual",
        status: "confirmed",
        snapshot: "private-snapshot-fixture",
        findings: {
          create: {
            externalId: label,
            classification: "stale",
            confidence: "confirmed",
            repairStatus: "applied",
          },
        },
      },
    }),
  ]);
  return {
    ...connection,
    viewer: identity(tenant.id, "viewer"),
    sync,
    dead,
    reconciliation,
  };
}

test("ops console requires JWT authentication and serves no mutation routes", async () => {
  const token = identity();
  const parts = token.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  for (const path of [...routes, "/ops/reconciliation/unknown"]) {
    expect((await request(path)).status).toBe(401);
    expect((await request(path, parts.join("."))).status).toBe(401);
    expect((await request(path, token, "POST", {})).status).toBe(404);
  }
});

test("viewer sees only tenant-owned console rows and reports, with escaped HTML and operational metadata", async () => {
  const [own, other] = await Promise.all([
    seed('<script>own "test" & fixture</script>'),
    seed("other-tenant-fixture"),
  ]);
  const rows = [
    [own.id, other.id],
    [own.sync.id, other.sync.id],
    [own.dead.id, other.dead.id],
    [own.reconciliation.id, other.reconciliation.id],
  ];
  for (const [index, path] of routes.entries()) {
    const response = await request(path, own.viewer);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'none'",
    );
    const html = await response.text();
    expect(html).toContain(rows[index][0]);
    expect(html).not.toContain(rows[index][1]);
    expect(html).not.toMatch(
      /<form|<script|sensitive-payload-fixture|sensitive-error-fixture|private-snapshot-fixture/,
    );
  }
  const connectionHtml = await (await request("/ops", own.viewer)).text();
  expect(connectionHtml).toContain(
    "&lt;script&gt;own &quot;test&quot; &amp; fixture&lt;/script&gt;",
  );
  const pathname = "/ops/reconciliation/" + own.reconciliation.id;
  const report = await request(pathname, own.viewer);
  expect(report.status).toBe(200);
  const html = await report.text();
  expect(html).toContain(
    "&lt;script&gt;own &quot;test&quot; &amp; fixture&lt;/script&gt;",
  );
  expect(html).toContain("<td>applied</td>");
  expect(html).not.toContain("private-snapshot-fixture");
  expect((await request(pathname, other.viewer)).status).toBe(404);
  expect((await request(pathname, other.token)).status).toBe(404);
  expect((await request(pathname, own.token)).status).toBe(200);
  expect(
    await db.authorizationAudit.count({
      where: {
        object: own.reconciliation.id,
        reason: "ops_reconciliation_report_unavailable",
      },
    }),
  ).toBe(2);
});
