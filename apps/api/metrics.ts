import { Controller, Get } from "@nestjs/common";
import { db } from "../../packages/shared/db";
import { Caller, type Identity } from "./auth";

@Controller("metrics")
export class MetricsController {
  @Get()
  async metrics(@Caller() identity: Identity) {
    const since = new Date(Math.floor(Date.now() / 60000) * 60000 - 59 * 60000);
    const [samples, retries, dlq, connections] = await Promise.all([
      db.$queryRaw<
        Array<{ kind: string; count: number; total: number; peak: number }>
      >`
        SELECT m.kind, sum(m.samples)::double precision AS count, sum(m.total)::double precision AS total,
          max(m.peak)::double precision AS peak FROM metric_buckets m JOIN connections c ON c.id=m.connection_id
        WHERE c.tenant_id=${identity.tenantId} AND m.minute>=${since} GROUP BY m.kind`,
      db.$queryRaw<Array<{ n: number }>>`
        SELECT coalesce(sum(greatest(a.attempt_count-1,0)),0)::double precision AS n
        FROM operation_attempt a JOIN connections c ON c.id=a.connection_id WHERE c.tenant_id=${identity.tenantId}`,
      db.deadLetter.groupBy({
        by: ["state"],
        where: {
          tenantId: identity.tenantId,
          state: { in: ["open", "reopened", "replay_queued"] },
        },
        _count: { _all: true },
      }),
      db.connection.groupBy({
        by: ["lifecycle", "tokenStatus", "pausedReason"],
        where: { tenantId: identity.tenantId },
        _count: { _all: true },
      }),
    ]);
    const metric = (kind: string) =>
      samples.find((sample) => sample.kind === kind) ?? {
        count: 0,
        total: 0,
        peak: 0,
      };
    const distribution = (kind: string) => {
      const sample = metric(kind);
      return {
        samples: sample.count,
        meanMs: sample.count ? sample.total / sample.count : null,
        maxMs: sample.count ? sample.peak : null,
      };
    };
    const provider = metric("provider");
    return {
      windowStart: since,
      queueLag: distribution("queue_lag"),
      syncDuration: distribution("sync_duration"),
      retryCount: retries[0].n,
      dlqDepth: dlq.reduce((sum, row) => sum + row._count._all, 0),
      providerRequests: provider.count,
      provider429s: provider.total,
      rate429: provider.count ? provider.total / provider.count : 0,
      tokenRefreshErrors: metric("refresh_error").count,
      connections: connections.map((row) => ({
        lifecycle: row.lifecycle,
        tokenStatus: row.tokenStatus,
        pausedReason: row.pausedReason,
        count: row._count._all,
      })),
    };
  }
}
