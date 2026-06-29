// File store for the intent doc and the .reviews/ comment threads. Comments live
// in-repo as plain JSON. On read, threads are normalized to the v2 content-anchor
// shape (see docs/intent/SPEC.md) via a compat shim, so older comments keep working.

import { closeSync, existsSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Anchor, Author, IntentPayload, Message, Thread, ThreadStatus } from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Store {
  constructor(private root: string) {}

  private reviewsDir(): string {
    return join(this.root, ".reviews");
  }
  // The project's intent doc. Prefer docs/intent/SPEC.md (the convention), fall back to
  // a legacy root INTENT.md, and default to the former when neither exists yet.
  private static INTENT_CANDIDATES = ["docs/intent/SPEC.md", "INTENT.md"];
  intentRelPath(): string {
    for (const rel of Store.INTENT_CANDIDATES) if (existsSync(join(this.root, rel))) return rel;
    return Store.INTENT_CANDIDATES[0];
  }
  private intentPath(): string {
    return join(this.root, this.intentRelPath());
  }
  private fileFor(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid thread id: ${id}`);
    return join(this.reviewsDir(), `${id}.json`);
  }

  // Intent ------------------------------------------------------------------

  async readIntent(): Promise<IntentPayload> {
    const path = this.intentRelPath();
    const full = join(this.root, path);
    if (!existsSync(full)) return { content: "", exists: false, path };
    return { content: await readFile(full, "utf8"), exists: true, path };
  }

  async writeIntent(content: string): Promise<void> {
    const full = this.intentPath();
    await mkdir(dirname(full), { recursive: true });
    await fsWriteFile(full, content, "utf8");
  }

  // Write an arbitrary repo file (write-through for the editor). Guards against
  // path traversal and refuses binary paths; the editor only edits text.
  async writeFile(path: string, content: string): Promise<void> {
    const root = resolve(this.root);
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + "/")) throw new Error("path escapes repository");
    await mkdir(dirname(full), { recursive: true });
    await fsWriteFile(full, content, "utf8");
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
    await fsWriteFile(this.fileFor(t.id), JSON.stringify(t, null, 2) + "\n", "utf8");
  }

  // Cross-process exclusive lock around a thread's read-modify-write. The CLI
  // and the server are separate processes, so an in-process mutex would not
  // cover the real race; an O_EXCL lockfile does (with stale-lock stealing so a
  // crashed process can't wedge a thread forever). createThread needs no lock —
  // it writes a fresh uuid with no contender.
  private lockPath(id: string): string {
    return join(this.reviewsDir(), `${id}.json.lock`);
  }

  private async withThreadLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.reviewsDir(), { recursive: true });
    const lock = this.lockPath(id);
    const staleMs = 30_000;
    const deadline = Date.now() + 5000;
    let acquired = false;
    while (Date.now() < deadline) {
      try {
        const fd = openSync(lock, "wx"); // O_EXCL | O_CREAT
        writeSync(fd, String(process.pid));
        closeSync(fd);
        acquired = true;
        break;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > staleMs) unlinkSync(lock);
        } catch {
          // lock vanished in a race — loop and retry
        }
      }
      await sleep(15);
    }
    if (!acquired) throw new Error(`could not acquire lock for thread ${id}`);
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // already gone — benign
      }
    }
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
    return this.withThreadLock(id, async () => {
      const t = await this.getThread(id);
      if (!t) throw new Error(`thread not found: ${id}`);
      t.thread.push({ author, body, ts: new Date().toISOString() });
      await this.saveThread(t);
      return t;
    });
  }

  async setStatus(id: string, status: ThreadStatus): Promise<Thread> {
    return this.withThreadLock(id, async () => {
      const t = await this.getThread(id);
      if (!t) throw new Error(`thread not found: ${id}`);
      t.status = status;
      await this.saveThread(t);
      return t;
    });
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
    return this.withThreadLock(id, async () => {
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
    });
  }

  private latestProposed(t: Thread): Message | undefined {
    for (let i = t.thread.length - 1; i >= 0; i--) {
      const m = t.thread[i];
      if (m.suggestion && m.suggestion.status === "proposed") return m;
    }
    return undefined;
  }

  async applySuggestion(id: string): Promise<{ thread: Thread; file: string }> {
    return this.withThreadLock(id, async () => {
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
      await fsWriteFile(file, content.replace(base, () => newText), "utf8");
      msg.suggestion.status = "applied";
      await this.saveThread(t);
      return { thread: t, file };
    });
  }

  async dismissSuggestion(id: string): Promise<Thread> {
    return this.withThreadLock(id, async () => {
      const t = await this.getThread(id);
      if (!t) throw new Error(`thread not found: ${id}`);
      const msg = this.latestProposed(t);
      if (!msg?.suggestion) throw new Error("no pending suggestion on this thread");
      msg.suggestion.status = "dismissed";
      await this.saveThread(t);
      return t;
    });
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
