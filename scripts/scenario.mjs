import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export const api = process.env.API_URL ?? "http://localhost:4300";
export const mock = process.env.PROVIDER_URL ?? "http://localhost:4301";
export function identity(tenantId = randomUUID(), role = "operator") {
  return jwt.sign(
    { tenant_id: tenantId, role },
    process.env.JWT_SECRET ?? "local-demo-jwt-signing-only",
    {
      subject: tenantId,
      issuer: "syncbridge-local",
      audience: "syncbridge",
      expiresIn: "15m",
    },
  );
}
export async function request(path, token, method = "GET", body) {
  const headers = token ? { authorization: "Bearer " + token } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(api + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
}
export async function json(path, token, method, body) {
  const response = await request(path, token, method, body);
  if (!response.ok)
    throw new Error(
      `${method ?? "GET"} ${path.split("?")[0]}: HTTP ${response.status}`,
    );
  return response.json();
}
export async function createConnection(token = identity()) {
  await json("/tenant", token, "POST", { name: "Synthetic demo tenant" });
  const connection = await json("/connections", token, "POST", {
    name: "Mock employees",
  });
  return { token, id: connection.id };
}
export async function authorize({ token, id }) {
  const { authorizationUrl } = await json(
    `/connections/${id}/authorize`,
    token,
    "POST",
  );
  const redirect = await fetch(authorizationUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  const location = redirect.headers.get("location");
  if ((!redirect.ok && redirect.status !== 302) || !location)
    throw new Error("Mock authorization failed");
  return json(new URL(location).pathname + new URL(location).search);
}
export function trigger({ token, id }, mode = "full") {
  return json(`/connections/${id}/sync`, token, "POST", { mode });
}
export function records({ token, id }) {
  return json(`/connections/${id}/records`, token);
}
export async function poll(fn, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(40);
  }
  throw new Error("Timed out waiting for expected state");
}
export function waitRun({ token, id }, runId) {
  return poll(async () => {
    const run = await json(`/connections/${id}/sync/${runId}`, token);
    return ["succeeded", "partial", "failed"].includes(run.status)
      ? run
      : undefined;
  });
}
