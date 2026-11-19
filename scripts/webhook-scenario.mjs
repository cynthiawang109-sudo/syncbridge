import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { api, mock, json, poll } from "./scenario.mjs";

export const event = (
  externalId,
  version,
  action = "update",
  resource = "employees",
) => ({ id: randomUUID(), resource, externalId, action, version });
export async function webhook(
  connectionId,
  body,
  {
    timestamp = Date.now(),
    key = process.env.WEBHOOK_KEY ?? "local-synthetic-webhook-key",
    invalid = false,
  } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const secret = createHmac("sha256", key).update(connectionId).digest("hex");
  const sig = createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(raw)
    .digest("hex");
  return fetch(api + "/webhooks/" + connectionId, {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": String(timestamp),
      "x-webhook-signature": invalid ? "0".repeat(64) : sig,
    },
    signal: AbortSignal.timeout(8000),
  });
}
async function mockWrite(path, method, body) {
  const res = await fetch(mock + path, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok)
    throw new Error("Mock fixture request failed with " + res.status);
  return res.json();
}
export const faults = (body) => mockWrite("/__test/faults", "PATCH", body);
export const mutate = (connectionId, events, changes = [], options = {}) =>
  mockWrite("/__test/events", "POST", {
    connectionId,
    events,
    changes,
    ...options,
  });
export function waitEvent(
  connection,
  eventId,
  status = "processed",
  timeout = 15000,
) {
  return poll(async () => {
    try {
      const item = await json(
        "/webhooks/" + connection.id + "/events/" + eventId,
        connection.token,
      );
      if (item.status === status) return item;
    } catch (error) {
      if (!(error instanceof TypeError && error.message === "fetch failed"))
        throw error;
    }
    await sleep(120);
  }, timeout);
}
