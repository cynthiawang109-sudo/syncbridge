import {
  applyDecorators,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { db } from "../../packages/shared/db";
import { Caller, deny, type Identity } from "./auth";

const pages = [
  ["Connections", "/ops"],
  ["Sync runs", "/ops/sync-runs"],
  ["Dead letters", "/ops/dead-letters"],
  ["Reconciliation", "/ops/reconciliation"],
] as const;
const pageSize = 100;

function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}
function link(label: string, href: string) {
  return '<a href="' + escapeHtml(href) + '">' + escapeHtml(label) + "</a>";
}
type Cell = string | number | Date | null | { label: string; href: string };
function cell(value: Cell) {
  if (value === null) return "&mdash;";
  if (value instanceof Date) return "<time>" + value.toISOString() + "</time>";
  if (typeof value === "object") return link(value.label, value.href);
  return escapeHtml(String(value));
}
function table(caption: string, headings: string[], rows: Cell[][]) {
  if (!rows.length) return "<p>No matching records.</p>";
  return (
    "<table><caption>" +
    escapeHtml(caption) +
    "</caption><thead><tr>" +
    headings
      .map((heading) => '<th scope="col">' + escapeHtml(heading) + "</th>")
      .join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" +
          row.map((value) => "<td>" + cell(value) + "</td>").join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table>"
  );
}
function page(title: string, body: string) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" +
    escapeHtml(title) +
    ' | SyncBridge</title></head><body><nav aria-label="Operations"><ul>' +
    pages
      .map(([label, path]) => "<li>" + link(label, path) + "</li>")
      .join("") +
    "</ul></nav><main><h1>" +
    escapeHtml(title) +
    "</h1>" +
    body +
    "</main></body></html>"
  );
}
function tenantConnections(identity: Identity) {
  return { tenantId: identity.tenantId, tenant: { deletedAt: null } };
}

function OpsPage(path?: string) {
  return applyDecorators(
    Get(path),
    Header("Content-Type", "text/html; charset=utf-8"),
    Header("Cache-Control", "no-store"),
    Header(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    ),
    Header("X-Content-Type-Options", "nosniff"),
  );
}
@Controller("ops")
export class OpsController {
  @OpsPage()
  async connections(@Caller() identity: Identity) {
    const rows = await db.connection.findMany({
      where: { ...tenantConnections(identity), lifecycle: { not: "deleted" } },
      select: {
        id: true,
        name: true,
        provider: true,
        lifecycle: true,
        tokenStatus: true,
        pausedReason: true,
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: pageSize,
    });
    return page(
      "Connections",
      table(
        "Tenant connections",
        [
          "Name",
          "ID",
          "Provider",
          "Lifecycle",
          "Authorization",
          "Pause reason",
        ],
        rows.map((row) => [
          row.name,
          row.id,
          row.provider,
          row.lifecycle,
          row.tokenStatus,
          row.pausedReason,
        ]),
      ),
    );
  }

  @OpsPage("sync-runs")
  async syncRuns(@Caller() identity: Identity) {
    const rows = await db.syncRun.findMany({
      where: { connection: tenantConnections(identity) },
      select: {
        id: true,
        connectionId: true,
        resourceType: true,
        mode: true,
        status: true,
        page: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize,
    });
    return page(
      "Sync runs",
      table(
        "Recent sync runs",
        [
          "ID",
          "Connection",
          "Resource",
          "Mode",
          "Status",
          "Pages",
          "Created (UTC)",
        ],
        rows.map((row) => [
          row.id,
          row.connectionId,
          row.resourceType,
          row.mode,
          row.status,
          row.page,
          row.createdAt,
        ]),
      ),
    );
  }

  @OpsPage("dead-letters")
  async deadLetters(@Caller() identity: Identity) {
    const rows = await db.deadLetter.findMany({
      where: { tenantId: identity.tenantId },
      select: {
        id: true,
        connectionId: true,
        eventId: true,
        runId: true,
        state: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize,
    });
    return page(
      "Dead letters",
      table(
        "Recent dead letters",
        ["ID", "Connection", "Event", "Sync run", "Status", "Created (UTC)"],
        rows.map((row) => [
          row.id,
          row.connectionId,
          row.eventId,
          row.runId,
          row.state,
          row.createdAt,
        ]),
      ),
    );
  }

  @OpsPage("reconciliation")
  async reconciliation(@Caller() identity: Identity) {
    const rows = await db.reconciliationRun.findMany({
      where: { connection: tenantConnections(identity) },
      select: {
        id: true,
        connectionId: true,
        resourceType: true,
        trigger: true,
        status: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize,
    });
    return page(
      "Reconciliation",
      table(
        "Recent reconciliation runs",
        [
          "Report",
          "Connection",
          "Resource",
          "Trigger",
          "Status",
          "Created (UTC)",
        ],
        rows.map((row) => [
          {
            label: row.id,
            href: "/ops/reconciliation/" + encodeURIComponent(row.id),
          },
          row.connectionId,
          row.resourceType,
          row.trigger,
          row.status,
          row.createdAt,
        ]),
      ),
    );
  }

  @OpsPage("reconciliation/:runId")
  async report(
    @Caller() identity: Identity,
    @Param("runId") runId: string,
    @Query("after") after?: string,
  ) {
    const run = await db.reconciliationRun.findFirst({
      where: { id: runId, connection: tenantConnections(identity) },
      select: {
        id: true,
        connectionId: true,
        resourceType: true,
        status: true,
        reason: true,
        finishedAt: true,
        findings: {
          where: {
            externalId:
              typeof after === "string" && after ? { gt: after } : undefined,
          },
          orderBy: { externalId: "asc" },
          take: pageSize + 1,
          select: {
            externalId: true,
            classification: true,
            confidence: true,
            mirrorVersion: true,
            providerVersion: true,
            repairStatus: true,
            repairResult: true,
          },
        },
      },
    });
    if (!run) {
      await deny(identity, runId, "ops_reconciliation_report_unavailable");
      throw new NotFoundException();
    }
    const findings = run.findings.slice(0, pageSize);
    const next =
      run.findings.length > pageSize
        ? "<p>" +
          link(
            "Next findings",
            "/ops/reconciliation/" +
              encodeURIComponent(run.id) +
              "?after=" +
              encodeURIComponent(findings[pageSize - 1].externalId),
          ) +
          "</p>"
        : "";
    return page(
      "Reconciliation report",
      table(
        "Run",
        ["ID", "Connection", "Resource", "Status", "Reason", "Finished (UTC)"],
        [
          [
            run.id,
            run.connectionId,
            run.resourceType,
            run.status,
            run.reason,
            run.finishedAt,
          ],
        ],
      ) +
        table(
          "Findings",
          [
            "Record",
            "Classification",
            "Confidence",
            "Mirror version",
            "Provider version",
            "Repair",
            "Result",
          ],
          findings.map((row) => [
            row.externalId,
            row.classification,
            row.confidence,
            row.mirrorVersion,
            row.providerVersion,
            row.repairStatus,
            row.repairResult,
          ]),
        ) +
        next,
    );
  }
}
