// Decorate threads with drift state and their current location. A comment is
// anchored to file content; we find that content in the current file to (a) place
// the inline highlight and (b) decide "outdated" when it's gone (DESIGN.md §12).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecoratedThread, Located, Thread } from "./types";

export async function decorateThreads(threads: Thread[], root: string): Promise<DecoratedThread[]> {
  const cache = new Map<string, string | null>();
  const read = async (path: string): Promise<string | null> => {
    if (cache.has(path)) return cache.get(path)!;
    let content: string | null = null;
    try {
      const full = join(root, path);
      if (existsSync(full)) content = await readFile(full, "utf8");
    } catch {
      // unreadable → treated as absent
    }
    cache.set(path, content);
    return content;
  };

  const out: DecoratedThread[] = [];
  for (const t of threads) {
    const content = await read(t.anchor.path);
    const located = content === null ? null : locate(content, t.context, t.anchor);
    const outdated = t.status === "open" && !!t.context ? located === null : false;
    const effectiveStatus = t.status === "resolved" ? "resolved" : outdated ? "outdated" : "open";
    out.push({ ...t, located, outdated, effectiveStatus });
  }
  return out;
}

// Find the anchored content in the current file → 1-based line range, or null.
function locate(content: string, context: string | undefined, anchor: { startLine: number; endLine: number }): Located {
  if (!context) {
    return anchor.startLine > 0 ? { startLine: anchor.startLine, endLine: anchor.endLine } : null;
  }
  const idx = content.indexOf(context);
  if (idx >= 0) {
    const startLine = content.slice(0, idx).split("\n").length;
    const endLine = startLine + context.split("\n").length - 1;
    return { startLine, endLine };
  }
  // markdown / formatting tolerance: rendered selections drop *_`[]() markers
  if (normalizeProse(content).includes(normalizeProse(context))) {
    const s = anchor.startLine > 0 ? anchor.startLine : 1;
    return { startLine: s, endLine: anchor.endLine > 0 ? anchor.endLine : s };
  }
  return null;
}

export function normalizeProse(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
