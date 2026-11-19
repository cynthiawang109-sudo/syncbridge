const { SCHEDULER_ENDPOINT, SCHEDULER_SECRET } = process.env;
if (!SCHEDULER_ENDPOINT || !SCHEDULER_SECRET)
  throw new Error("Missing scheduler configuration");
const response = await fetch(SCHEDULER_ENDPOINT, {
  method: "POST",
  headers: { "x-scheduler-key": SCHEDULER_SECRET },
  signal: AbortSignal.timeout(10000),
});
if (response.status !== 202)
  throw new Error("Reconciliation enqueue returned HTTP " + response.status);
console.log("Reconciliation enqueue accepted (HTTP 202)");
