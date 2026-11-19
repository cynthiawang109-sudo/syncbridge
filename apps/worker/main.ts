import {
  dueReconciliation,
  processReconciliation,
  scheduleReconciliation,
} from "./reconciliation";
import { Worker } from "bullmq";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "../../packages/shared/db";
import { telemetry } from "../../packages/shared/telemetry";
import { rewrapTokenBatch } from "../../packages/shared/key-rotation";
import {
  createQueue,
  PageJob,
  queueName,
  redisConnection,
} from "../../packages/shared/queue";
import { duePages, processPage } from "./sync";

import {
  dueReplays,
  processWebhook,
  projectReplays,
  sweepWebhooks,
} from "./webhooks";
import { closeConnections } from "./offboarding";
const queue = createQueue();
const worker = new Worker<PageJob>(
  queueName,
  async (job) => {
    if (
      typeof job.data.operationKey === "string" &&
      typeof job.data.generation === "number"
    )
      if (job.name === "reconciliation")
        await processReconciliation(job.data.operationKey, job.data.generation);
      else if (job.name === "webhook" || job.name === "replay")
        await processWebhook(job.data);
      else await processPage(job.data.operationKey, job.data.generation);
  },
  { connection: redisConnection, concurrency: 6 },
);
const logError = () => telemetry("sync_transport_error", {}, "error");
worker.on("error", logError);
worker.on("failed", logError);
queue.on("error", logError);
let stopping = false;
async function dispatch() {
  let nextRewrap = 0;
  let nextMetricsCleanup = 0;
  while (!stopping) {
    try {
      const due = await duePages();
      await queue.addBulk(
        due.map(({ key, generation }) => ({
          name: "page",
          data: { operationKey: key, generation: generation ?? undefined },
          opts: { jobId: key },
        })),
      );
      await queue.addBulk(
        (await dueReconciliation()).map(({ key, generation }) => ({
          name: "reconciliation",
          data: { operationKey: key, generation },
          opts: { jobId: key },
        })),
      );
      await sweepWebhooks(queue);
      await projectReplays();
      await closeConnections();
      for (const replay of await dueReplays())
        await queue.add(
          "replay",
          {
            operationKey: replay.key,
            generation: replay.generation ?? undefined,
          },
          { jobId: replay.key },
        );
      if (Date.now() >= nextRewrap) {
        nextRewrap = Date.now() + 5000;
        if (Date.now() >= nextMetricsCleanup) {
          nextMetricsCleanup = Date.now() + 60000;
          await db.metricBucket.deleteMany({
            where: { minute: { lt: new Date(Date.now() - 86400000) } },
          });
        }
        await scheduleReconciliation();
        await rewrapTokenBatch();
        telemetry("worker_status", {
          dlqDepth: await db.deadLetter.count({
            where: { state: { in: ["open", "reopened"] } },
          }),
          queuedJobs: await queue.getWaitingCount(),
        });
      }
    } catch {
      logError();
    }
    await sleep(200);
  }
}
const dispatching = dispatch();
async function stop() {
  stopping = true;
  await dispatching;
  await worker.close();
  await queue.close();
  await db.$disconnect();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
