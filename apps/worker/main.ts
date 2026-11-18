import { Worker } from 'bullmq';
new Worker('employee-sync', async () => {}, {connection:{host:process.env.REDIS_HOST ?? 'localhost'}});
