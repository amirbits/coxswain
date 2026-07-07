// Client over the server's front doors: GET /api/workspace (explorer + threads),
// GET /api/file (one file's content + diff), POST /api/call (the registry), and
// the /events SSE stream. Every change just re-projects.

import type { DiffMode, FilePayload, GitStatus, GitTopology, Workspace } from "./types";

export type BootPayload = { mode: DiffMode; root: string; token: string; scope: string };
export type RegistrySpec = { name: string; description: string };

// The per-boot token authorizing the PTY and mutating calls. Fetched once from
// /api/boot (same-origin only — the server refuses it cross-origin) and attached
// to every /api/call and the terminal WebSocket URL. Memoized, so callers don't
// have to sequence themselves after boot.
let bootPromise: Promise<BootPayload> | null = null;
function boot(): Promise<BootPayload> {
  return (bootPromise ??= fetch("/api/boot")
    .then((r) => {
      if (!r.ok) throw new Error(`boot ${r.status}`);
      return r.json();
    })
    .catch((e) => {
      bootPromise = null; // don't cache a transient failure — let the next call retry
      throw e;
    }));
}
async function authToken(): Promise<string> {
  return (await boot()).token ?? "";
}

// mode (+ optional scope) as a query string. Scope is always sent when provided
// — including the empty string, which the server reads as "the whole repo" (an
// absent param would instead fall back to the launch scope).
function viewParams(mode: DiffMode, scope?: string): string {
  const p = new URLSearchParams();
  p.set("mode", mode.kind);
  if (mode.ref) p.set("ref", mode.ref);
  if (scope !== undefined) p.set("scope", scope);
  return p.toString();
}

export function fetchBoot(): Promise<BootPayload> {
  return boot();
}

export async function fetchRegistry(): Promise<RegistrySpec[]> {
  const res = await fetch("/api/registry");
  if (!res.ok) return [];
  return res.json();
}

export async function fetchWorkspace(mode: DiffMode, scope?: string): Promise<Workspace> {
  const res = await fetch(`/api/workspace?${viewParams(mode, scope)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `workspace ${res.status}`);
  return res.json();
}

export type ChangesPayload = { raw: string; mode: DiffMode; head: string | null };

// The changeset diff for the active mode + scope (the continuous "All changes" view).
export async function fetchChanges(mode: DiffMode, scope?: string): Promise<ChangesPayload> {
  const res = await fetch(`/api/changes?${viewParams(mode, scope)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `changes ${res.status}`);
  return res.json();
}

export async function fetchFile(path: string, mode: DiffMode): Promise<FilePayload> {
  const res = await fetch(`/api/file?path=${encodeURIComponent(path)}&${viewParams(mode)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `file ${res.status}`);
  return res.json();
}

export async function call<T = unknown>(name: string, args: unknown): Promise<T> {
  const res = await fetch("/api/call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cox-token": await authToken() },
    body: JSON.stringify({ name, args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `call ${name} failed`);
  return data.result as T;
}

// Source control (Slice A): orientation + the one safe action (fetch).
export const fetchGitStatus = () => call<GitStatus>("gitStatus", {});
export const fetchGitTopology = () => call<GitTopology>("gitTopology", {});
export const gitFetch = (remote?: string) => call<GitStatus>("gitFetch", remote ? { remote } : {});

// Write-through for the editor: the intent doc is just another file under the tree.
export async function editFile(path: string, content: string): Promise<void> {
  await call("writeFile", { path, content });
}

// The terminal WebSocket URL, carrying the token the server requires to open a
// PTY. Async because the token is fetched from /api/boot.
export async function terminalUrl(cols: number, rows: number): Promise<string> {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ cols: String(cols), rows: String(rows), token: await authToken() });
  return `${proto}://${location.host}/terminal?${q}`;
}

export function subscribe(onChange: () => void, onStatus?: (ok: boolean) => void): () => void {
  const es = new EventSource("/events");
  es.onopen = () => onStatus?.(true);
  es.onmessage = () => onChange();
  es.onerror = () => onStatus?.(false);
  return () => es.close();
}
