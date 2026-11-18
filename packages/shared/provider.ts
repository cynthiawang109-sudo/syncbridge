const provider = process.env.PROVIDER_URL ?? "http://localhost:4301";
export const callback =
  process.env.CALLBACK_URL ?? "http://localhost:4300/oauth/callback";
export const browserProvider = process.env.PROVIDER_BROWSER_URL ?? provider;
export const REFRESH_TIMEOUT = 1500;
export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}
export interface Employee {
  id: string;
  name: string;
  version: number;
  revision: number;
}
export interface Page {
  items: Employee[];
  cursor: string | null;
  snapshot: string;
  watermark: number;
}
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly retryAfter = 0,
  ) {
    super(reason);
  }
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}
function retryDelay(value: string | null) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  return Math.max(0, Date.parse(value) - Date.now()) || 0;
}
async function request<T>(path: string, options: RequestInit, timeout: number) {
  try {
    const response = await fetch(provider + path, {
      ...options,
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = (body as { error?: string } | undefined)?.error;
      const safeCode = ["invalid_grant", "snapshot_expired"].includes(
        code ?? "",
      )
        ? code!
        : "provider_http_error";
      throw new ProviderError(
        response.status,
        safeCode,
        retryDelay(response.headers.get("retry-after")),
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(0, "provider_transport_uncertain");
  }
}
export async function tokenRequest(form: Record<string, string>) {
  const result = await request<Tokens | undefined>(
    "/token",
    {
      method: "POST",
      body: new URLSearchParams({ ...form, client_id: "syncbridge" }),
    },
    REFRESH_TIMEOUT,
  );
  if (
    !result ||
    typeof result.access_token !== "string" ||
    !result.access_token ||
    typeof result.refresh_token !== "string" ||
    !result.refresh_token ||
    !Number.isFinite(result.expires_in) ||
    result.expires_in <= 0 ||
    typeof result.scope !== "string"
  ) {
    throw new ProviderError(0, "provider_token_response_uncertain");
  }
  return result;
}
export function fetchEmployees(token: string, query: URLSearchParams) {
  return request<Page>(
    "/employees?" + query.toString(),
    { headers: { Authorization: "Bearer " + token } },
    4000,
  );
}
