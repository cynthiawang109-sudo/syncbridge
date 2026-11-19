import { createHmac, timingSafeEqual } from "node:crypto";
export const webhookLimit = 256 * 1024;
export const replayWindow = 300000;
export type Resource = "employees" | "payruns";
export function isResource(value: unknown): value is Resource {
  return value === "employees" || value === "payruns";
}
export type ProviderEvent = {
  id: string;
  resource: Resource;
  externalId: string;
  action: "update" | "delete";
  version: number;
};
export function parseEvent(value: unknown): ProviderEvent {
  const event = value as Partial<ProviderEvent> | null;
  if (
    !event ||
    !validId(event.id) ||
    !validId(event.externalId) ||
    !isResource(event.resource) ||
    (event.action !== "update" && event.action !== "delete") ||
    !Number.isInteger(event.version) ||
    (event.version ?? 0) < 1 ||
    (event.version ?? 0) > 2147483647
  )
    throw new Error("invalid_event");
  return {
    id: event.id,
    resource: event.resource,
    externalId: event.externalId,
    action: event.action,
    version: event.version!,
  };
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
}
export function webhookSecret(connectionId: string, previous = false) {
  const root = previous
    ? process.env.WEBHOOK_PREVIOUS_KEY
    : (process.env.WEBHOOK_KEY ?? "local-synthetic-webhook-key");
  return root
    ? createHmac("sha256", root).update(connectionId).digest("hex")
    : undefined;
}
export function signature(secret: string, timestamp: string, raw: Buffer) {
  return createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(raw)
    .digest();
}
export function verifyWebhook(
  connectionId: string,
  timestamp: string,
  raw: Buffer,
  presented: string,
  now = Date.now(),
) {
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > replayWindow ||
    !/^[a-f0-9]{64}$/i.test(presented)
  )
    return false;
  const supplied = Buffer.from(presented, "hex");
  const current = webhookSecret(connectionId)!;
  const previous = webhookSecret(connectionId, true);
  const currentMatch = timingSafeEqual(
    supplied,
    signature(current, timestamp, raw),
  );
  const previousMatch =
    previous &&
    now <= Number(process.env.WEBHOOK_PREVIOUS_UNTIL ?? "0") &&
    timingSafeEqual(supplied, signature(previous, timestamp, raw));
  return currentMatch || !!previousMatch;
}
