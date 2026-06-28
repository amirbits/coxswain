// Client over the server's front doors: GET /api/workspace (explorer + threads),
// GET /api/file (one file's content + diff), POST /api/call (the registry), and
// the /events SSE stream. Every change just re-projects.

import type { DiffMode, FilePayload, Workspace } from "./types";

function modeParams(mode: DiffMode): string {
  const p = new URLSearchParams();
  p.set("mode", mode.kind);
  if (mode.ref) p.set("ref", mode.ref);
  return p.toString();
}

export async function fetchWorkspace(mode: DiffMode): Promise<Workspace> {
  const res = await fetch(`/api/workspace?${modeParams(mode)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `workspace ${res.status}`);
  return res.json();
}

export async function fetchFile(path: string, mode: DiffMode): Promise<FilePayload> {
  const res = await fetch(`/api/file?path=${encodeURIComponent(path)}&${modeParams(mode)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `file ${res.status}`);
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

export function subscribe(onChange: () => void, onStatus?: (ok: boolean) => void): () => void {
  const es = new EventSource("/events");
  es.onopen = () => onStatus?.(true);
  es.onmessage = () => onChange();
  es.onerror = () => onStatus?.(false);
  return () => es.close();
}
