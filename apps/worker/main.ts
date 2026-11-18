import { Worker } from "bullmq";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "../../packages/shared/db";
import { rewrapTokenBatch } from "../../packages/shared/key-rotation";
import {
  createQueue,
  PageJob,
  queueName,
  redisConnection,
} from "../../packages/shared/queue";
import { duePages, processPage } from "./sync";

const queue = createQueue();
const worker = new Worker<PageJob>(
  queueName,
  async (job) => {
    if (typeof job.data.operationKey === "string")
      await processPage(job.data.operationKey);
  },
  { connection: redisConnection, concurrency: 6 },
);
const logError = () =>
  console.error(JSON.stringify({ event: "sync_transport_error" }));
worker.on("error", logError);
worker.on("failed", logError);
queue.on("error", logError);
let stopping = false;
async function dispatch() {
  let nextRewrap = 0;
  while (!stopping) {
    try {
      const due = await duePages();
      await queue.addBulk(
        due.map(({ key }) => ({
          name: "page",
          data: { operationKey: key },
          opts: { jobId: key },
        })),
      );
      if (Date.now() >= nextRewrap) {
        nextRewrap = Date.now() + 5000;
        await rewrapTokenBatch();
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
