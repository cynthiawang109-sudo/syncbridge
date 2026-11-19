import { Queue } from "bullmq";
export const queueName = "employee-sync";
export const redisConnection = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  ...(process.env.REDIS_TLS === "true"
    ? { tls: { servername: process.env.REDIS_HOST } }
    : {}),
};
export type PageJob = {
  operationKey: string;
  generation?: number;
  leaseToken?: string;
};
export function createQueue() {
  return new Queue<PageJob>(queueName, {
    connection: redisConnection,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
  });
}
