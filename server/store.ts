// File store for the two non-git truths: INTENT.md and the .reviews/ comment
// threads. Comments live in-repo as plain JSON so the agent reads them with zero
// extra API (DESIGN.md §3). The store never caches — it reads/writes files.

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

  // Write-through: editing the intent view edits the file (DESIGN.md §1).
  async writeIntent(content: string): Promise<void> {
    await writeFile(this.intentPath(), content, "utf8");
  }

  // Review threads ----------------------------------------------------------

  async listThreads(): Promise<Thread[]> {
    const dir = this.reviewsDir();
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir);
    const out: Thread[] = [];
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(await readFile(join(dir, f), "utf8")) as Thread;
        if (t && typeof t.id === "string" && Array.isArray(t.thread)) out.push(t);
      } catch {
        // skip malformed thread files rather than failing the whole list
      }
    }
    out.sort((a, b) => (a.thread[0]?.ts ?? "").localeCompare(b.thread[0]?.ts ?? ""));
    return out;
  }

  async getThread(id: string): Promise<Thread | null> {
    const p = this.fileFor(id);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(await readFile(p, "utf8")) as Thread;
    } catch {
      return null;
    }
  }

  async saveThread(t: Thread): Promise<void> {
    await mkdir(this.reviewsDir(), { recursive: true });
    await writeFile(this.fileFor(t.id), JSON.stringify(t, null, 2) + "\n", "utf8");
  }

  async createThread(
    anchor: Anchor,
    body: string,
    author: Author = "human",
    context?: string,
  ): Promise<Thread> {
    const thread: Thread = {
      id: crypto.randomUUID(),
      anchor,
      status: "open",
      thread: [{ author, body, ts: new Date().toISOString() }],
      ...(context ? { context } : {}),
    };
    await this.saveThread(thread);
    return thread;
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

  // The file a thread's suggestion would edit: INTENT.md for intent threads,
  // else the anchored source file.
  private targetFile(t: Thread): string {
    if (t.anchor.view === "intent") return this.intentPath();
    const loc = t.anchor.locator;
    if (loc.kind === "lines") return join(this.root, loc.path);
    throw new Error("thread has no target file to edit");
  }

  // The exact current text a suggestion replaces, derived from the anchor. For
  // line anchors it is read straight from the file (drift-safe); for an intent
  // quote it only works if the quote is still verbatim in the source.
  private async deriveBase(t: Thread): Promise<string | null> {
    const file = this.targetFile(t);
    if (!existsSync(file)) return null;
    const content = await readFile(file, "utf8");
    const loc = t.anchor.locator;
    if (loc.kind === "lines") {
      return content.split("\n").slice(loc.startLine - 1, loc.endLine).join("\n");
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
      if (derived === null) {
        throw new Error('could not locate the anchored text to replace; pass an explicit base');
      }
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

  // Write-through: apply the thread's pending suggestion to its file. Replaces
  // the unique occurrence of `base` with `newText`; refuses if the text drifted
  // (0 matches) or is ambiguous (>1). Never commits.
  async applySuggestion(id: string): Promise<{ thread: Thread; file: string }> {
    const t = await this.getThread(id);
    if (!t) throw new Error(`thread not found: ${id}`);
    const msg = this.latestProposed(t);
    if (!msg?.suggestion) throw new Error("no pending suggestion on this thread");
    const file = this.targetFile(t);
    if (!existsSync(file)) throw new Error(`target file not found: ${file}`);
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
