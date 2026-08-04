import { withCsrfHeaders } from "./csrf-client";

export async function apiFetch<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    method: options.method ?? "POST",
    headers: withCsrfHeaders({ "Content-Type": "application/json" }),
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
