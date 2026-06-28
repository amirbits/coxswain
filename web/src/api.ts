// Thin client over the server's two front doors: GET /api/state (the full
// projection) and POST /api/call (the function registry). Live updates arrive
// via the /events SSE stream — every "change" just tells us to re-project.

import type { AppState } from "./types";

export async function fetchState(base: string | null): Promise<AppState> {
  const q = base ? `?base=${encodeURIComponent(base)}` : "";
  const res = await fetch(`/api/state${q}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `state failed (${res.status})`);
  }
  return res.json();
}

export async function call<T = unknown>(name: string, args: unknown): Promise<T> {
  const res = await fetch("/api/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `call ${name} failed`);
  return data.result as T;
}

// Subscribe to live change events. Returns an unsubscribe function. The browser
// auto-reconnects EventSource on transient errors.
export function subscribe(onChange: () => void, onStatus?: (ok: boolean) => void): () => void {
  const es = new EventSource("/events");
  es.onopen = () => onStatus?.(true);
  es.onmessage = () => onChange(); // only `data:` lines fire this; heartbeats are comments
  es.onerror = () => onStatus?.(false);
  return () => es.close();
}
