// File store for the two non-git truths: INTENT.md and the .reviews/ comment
// threads. Comments live in-repo as plain JSON so the agent reads them with zero
// extra API (DESIGN.md §3). The store never caches — it reads/writes files.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Anchor, Author, IntentPayload, Thread, ThreadStatus } from "./types";

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
}
