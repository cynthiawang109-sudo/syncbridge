const redacted = new Set([
  "authorization",
  "x-webhook-signature",
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
}
