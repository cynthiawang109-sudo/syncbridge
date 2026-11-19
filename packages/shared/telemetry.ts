import { db } from "./db";
const redacted = new Set([
  "authorization",
  "x-webhook-signature",
  "x-scheduler-key",
  "access_token",
  "refresh_token",
  "encrypted_tokens",
  "oauthverifier",
  "salary",
  "amount",
  "encrypted_body",
  "webhook_key",
  "envelope_key",
  "jwt_secret",
  "providererror",
  "payload",
  "body",
]);
type Field = string | number | boolean | null | undefined;

export function telemetry(
  event: string,
  fields: Record<string, Field> = {},
  level: "info" | "warn" | "error" = "info",
) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !redacted.has(key.toLowerCase())),
  );
  console[level](JSON.stringify({ event, ...safe }));
  if (typeof safe.connectionId !== "string") return;
  if (typeof safe.queueLagMs === "number")
    sample(safe.connectionId, "queue_lag", safe.queueLagMs);
  if (event === "sync_finished" && typeof safe.durationMs === "number")
    sample(safe.connectionId, "sync_duration", safe.durationMs);
  if (event === "token_refresh_error")
    sample(safe.connectionId, "refresh_error", 1);
  if (event === "provider_observed")
    sample(safe.connectionId, "provider", safe.status === 429 ? 1 : 0);
}

function sample(id: string, kind: string, value: number) {
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000);
  void db.$executeRaw`
    INSERT INTO metric_buckets (connection_id, minute, kind, samples, total, peak)
    VALUES (${id}, ${minute}, ${kind}, 1, ${value}, ${value})
    ON CONFLICT (connection_id, minute, kind) DO UPDATE SET
      samples=metric_buckets.samples + 1, total=metric_buckets.total + excluded.total,
      peak=greatest(metric_buckets.peak, excluded.peak)
  `.catch(() =>
    console.warn(JSON.stringify({ event: "metric_sample_unavailable" })),
  );
}
