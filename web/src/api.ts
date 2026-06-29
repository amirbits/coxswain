// Client over the server's front doors: GET /api/workspace (explorer + threads),
// GET /api/file (one file's content + diff), POST /api/call (the registry), and
// the /events SSE stream. Every change just re-projects.

import type { DiffMode, FilePayload, Workspace } from "./types";

export type BootPayload = { mode: DiffMode; root: string };
export type RegistrySpec = { name: string; description: string };

function modeParams(mode: DiffMode): string {
  const p = new URLSearchParams();
  p.set("mode", mode.kind);
  if (mode.ref) p.set("ref", mode.ref);
  return p.toString();
}

export async function fetchBoot(): Promise<BootPayload> {
  const res = await fetch("/api/boot");
  if (!res.ok) throw new Error(`boot ${res.status}`);
  return res.json();
}

export async function fetchRegistry(): Promise<RegistrySpec[]> {
  const res = await fetch("/api/registry");
  if (!res.ok) return [];
  return res.json();
}

export async function fetchWorkspace(mode: DiffMode): Promise<Workspace> {
  const res = await fetch(`/api/workspace?${modeParams(mode)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `workspace ${res.status}`);
  return res.json();
}

export type ChangesPayload = { raw: string; mode: DiffMode; head: string | null };

// The whole-changeset diff for the active mode (the continuous "All changes" view).
export async function fetchChanges(mode: DiffMode): Promise<ChangesPayload> {
  const res = await fetch(`/api/changes?${modeParams(mode)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `changes ${res.status}`);
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

// Write-through for the editor. INTENT.md goes through writeIntent; everything
// else through writeFile. Never commits — acceptance is the human's commit.
export async function editFile(path: string, content: string): Promise<void> {
  const fn = path === "INTENT.md" ? "writeIntent" : "writeFile";
  await call(fn, fn === "writeIntent" ? { content } : { path, content });
}

export function subscribe(onChange: () => void, onStatus?: (ok: boolean) => void): () => void {
  const es = new EventSource("/events");
  es.onopen = () => onStatus?.(true);
  es.onmessage = () => onChange();
  es.onerror = () => onStatus?.(false);
  return () => es.close();
}
