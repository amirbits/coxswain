// File store for INTENT.md and the .reviews/ comment threads. Comments live
// in-repo as plain JSON. On read, threads are normalized to the v2 content-anchor
// shape (DESIGN.md §12) via a compat shim, so older comments keep working.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Anchor, Author, IntentPayload, Message, Thread, ThreadStatus } from "./types";

export class Store {
  constructor(private root: string) {}

  private reviewsDir(): string {
    return join(this.root, ".reviews");
  }
  private intentPath(): string {
    return join(this.root, "INTENT.md");
  }
  private fileFor(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid thread id: ${id}`);
    return join(this.reviewsDir(), `${id}.json`);
  }

  // Intent ------------------------------------------------------------------

  async readIntent(): Promise<IntentPayload> {
    const path = this.intentPath();
    if (!existsSync(path)) return { content: "", exists: false, path: "INTENT.md" };
    return { content: await readFile(path, "utf8"), exists: true, path: "INTENT.md" };
  }

  async writeIntent(content: string): Promise<void> {
    await writeFile(this.intentPath(), content, "utf8");
  }

  // Review threads ----------------------------------------------------------

  async listThreads(): Promise<Thread[]> {
    const dir = this.reviewsDir();
    if (!existsSync(dir)) return [];
    const out: Thread[] = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = normalizeThread(JSON.parse(await readFile(join(dir, f), "utf8")));
        if (t) out.push(t);
      } catch {
        // skip malformed
      }
    }
    out.sort((a, b) => (a.thread[0]?.ts ?? "").localeCompare(b.thread[0]?.ts ?? ""));
    return out;
  }

  async getThread(id: string): Promise<Thread | null> {
    const p = this.fileFor(id);
    if (!existsSync(p)) return null;
    try {
      return normalizeThread(JSON.parse(await readFile(p, "utf8")));
    } catch {
      return null;
    }
  }

  async saveThread(t: Thread): Promise<void> {
    await mkdir(this.reviewsDir(), { recursive: true });
    await writeFile(this.fileFor(t.id), JSON.stringify(t, null, 2) + "\n", "utf8");
  }

  async createThread(anchor: Anchor, body: string, author: Author = "human", context?: string): Promise<Thread> {
    const t: Thread = {
      id: crypto.randomUUID(),
      anchor,
      status: "open",
      thread: [{ author, body, ts: new Date().toISOString() }],
      ...(context ? { context } : {}),
    };
    await this.saveThread(t);
    return t;
  }

  async appendMessage(id: string, author: Author, body: string): Promise<Thread> {
    const t = await this.getThread(id);
    if (!t) throw new Error(`thread not found: ${id}`);
    t.thread.push({ author, body, ts: new Date().toISOString() });
    await this.saveThread(t);
    return t;
  }

  async setStatus(id: string, status: ThreadStatus): Promise<Thread> {
    const t = await this.getThread(id);
    if (!t) throw new Error(`thread not found: ${id}`);
    t.status = status;
    await this.saveThread(t);
    return t;
  }

  // Suggestions -------------------------------------------------------------

  private targetFile(t: Thread): string {
    return join(this.root, t.anchor.path);
  }

  private async deriveBase(t: Thread): Promise<string | null> {
    const file = this.targetFile(t);
    if (!existsSync(file)) return null;
    const content = await readFile(file, "utf8");
    if (t.anchor.startLine > 0) {
      return content.split("\n").slice(t.anchor.startLine - 1, t.anchor.endLine).join("\n");
    }
    return t.context && content.includes(t.context) ? t.context : null;
  }

  async addSuggestion(
    id: string,
    opts: { newText: string; base?: string; body?: string; author?: Author },
  ): Promise<Thread> {
    const t = await this.getThread(id);
    if (!t) throw new Error(`thread not found: ${id}`);
    let base = opts.base;
    if (base === undefined) {
      const derived = await this.deriveBase(t);
      if (derived === null) throw new Error("could not locate the anchored text to replace; pass an explicit base");
      base = derived;
    }
    t.thread.push({
      author: opts.author ?? "agent",
      body: opts.body ?? "Suggested edit.",
      ts: new Date().toISOString(),
      suggestion: { base, newText: opts.newText, status: "proposed" },
    });
    await this.saveThread(t);
    return t;
  }

  private latestProposed(t: Thread): Message | undefined {
    for (let i = t.thread.length - 1; i >= 0; i--) {
      const m = t.thread[i];
      if (m.suggestion && m.suggestion.status === "proposed") return m;
    }
    return undefined;
  }

  async applySuggestion(id: string): Promise<{ thread: Thread; file: string }> {
    const t = await this.getThread(id);
    if (!t) throw new Error(`thread not found: ${id}`);
    const msg = this.latestProposed(t);
    if (!msg?.suggestion) throw new Error("no pending suggestion on this thread");
    const file = this.targetFile(t);
    if (!existsSync(file)) throw new Error(`target file not found: ${t.anchor.path}`);
    const content = await readFile(file, "utf8");
    const { base, newText } = msg.suggestion;
    const n = occurrences(content, base);
    if (n === 0) throw new Error("stale suggestion: the text to replace was not found (the file changed)");
    if (n > 1) throw new Error(`ambiguous suggestion: the text to replace appears ${n} times`);
    await writeFile(file, content.replace(base, () => newText), "utf8");
    msg.suggestion.status = "applied";
    await this.saveThread(t);
    return { thread: t, file };
  }

  async dismissSuggestion(id: string): Promise<Thread> {
    const t = await this.getThread(id);
    if (!t) throw new Error(`thread not found: ${id}`);
    const msg = this.latestProposed(t);
    if (!msg?.suggestion) throw new Error("no pending suggestion on this thread");
    msg.suggestion.status = "dismissed";
    await this.saveThread(t);
    return t;
  }
}

// Compat shim: accept the v2 shape or the older per-view shape and return v2.
function normalizeThread(raw: any): Thread | null {
  if (!raw || typeof raw.id !== "string" || !Array.isArray(raw.thread)) return null;

  let anchor: Anchor;
  const a = raw.anchor ?? {};
  if (typeof a.path === "string" && typeof a.startLine === "number") {
    anchor = { path: a.path, startLine: a.startLine, endLine: a.endLine ?? a.startLine };
  } else {
    // legacy: { view, version, locator }
    const loc = a.locator ?? {};
    if (loc.kind === "lines") {
      anchor = { path: loc.path, startLine: loc.startLine ?? 0, endLine: loc.endLine ?? loc.startLine ?? 0 };
    } else {
      // legacy intent text anchor → INTENT.md
      anchor = { path: a.view === "intent" ? "INTENT.md" : (loc.path ?? "INTENT.md"), startLine: 0, endLine: 0 };
    }
  }

  return {
    id: raw.id,
    anchor,
    status: raw.status === "resolved" ? "resolved" : "open",
    thread: raw.thread,
    ...(raw.context ? { context: raw.context } : {}),
  };
}

function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}
