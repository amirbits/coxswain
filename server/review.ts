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
// Drift + locating are content-based; the anchor's line numbers are a hint used
// only to disambiguate when the anchored text occurs more than once (DESIGN.md
// §12). This matches applySuggestion's stance: a unique occurrence is exact, a
// repeated one is resolved by proximity to the hint rather than silently picking
// the first copy.
export function locate(content: string, context: string | undefined, anchor: { startLine: number; endLine: number }): Located {
  if (!context) {
    return anchor.startLine > 0 ? { startLine: anchor.startLine, endLine: anchor.endLine } : null;
  }

  // 1. Exact raw match — collect every occurrence, pick the one nearest the hint.
  const ids = allIndexOf(content, context);
  if (ids.length) {
    const lineCount = context.split("\n").length;
    return nearest(
      ids.map((idx) => rangeAt(content, idx, lineCount)),
      anchor.startLine,
    );
  }

  // 2. Tolerant raw search — markdown / formatting tolerance. A normalized
  //    index is lossy (whitespace collapsed, markers stripped) and does not map
  //    back to a real line, so walk the *raw* lines and match each context line
  //    by normalizeProse equality; the matched run's real line range is the
  //    location. Returns null (→ outdated) when no tolerant run is found, rather
  //    than falling back to a stale hint.
  const normCtx = context.split("\n").map(normalizeProse);
  if (normCtx.length === 0 || normCtx.every((l) => l === "")) return null;
  const rawLines = content.split("\n");
  const tolerant: Range[] = [];
  for (let i = 0; i + normCtx.length <= rawLines.length; i++) {
    let match = true;
    for (let j = 0; j < normCtx.length; j++) {
      if (normalizeProse(rawLines[i + j]) !== normCtx[j]) {
        match = false;
        break;
      }
    }
    if (match) tolerant.push({ startLine: i + 1, endLine: i + normCtx.length });
  }
  if (tolerant.length) return nearest(tolerant, anchor.startLine);

  return null;
}

function allIndexOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    out.push(i);
    i += needle.length;
  }
  return out;
}

function rangeAt(content: string, idx: number, lineCount: number): Range {
  const startLine = content.slice(0, idx).split("\n").length;
  return { startLine, endLine: startLine + lineCount - 1 };
}

// Pick the range whose startLine is closest to the hint; with no usable hint,
// the first occurrence wins (stable, deterministic).
type Range = { startLine: number; endLine: number };
function nearest(ranges: Range[], hint: number): Range {
  if (ranges.length === 1 || hint <= 0) return ranges[0];
  let best = ranges[0];
  let bestDist = Math.abs(best.startLine - hint);
  for (let i = 1; i < ranges.length; i++) {
    const d = Math.abs(ranges[i].startLine - hint);
    if (d < bestDist || (d === bestDist && ranges[i].startLine > best.startLine)) {
      // on a tie, prefer the occurrence at/after the hint (forward) — that's
      // the copy closest to where the comment was likely made
      best = ranges[i];
      bestDist = d;
    }
  }
  return best;
}

export function normalizeProse(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
