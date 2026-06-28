// Filesystem watcher over the working tree. Because truth is the filesystem, the
// server sees everything an external agent does without driving it (DESIGN.md
// §6). Events are debounced so a burst of writes repaints the UI once, and noisy
// internals (.git/objects, node_modules, build output) are filtered out so we
// never thrash — but we DO watch .git/HEAD, .git/index, .git/refs so commits,
// staging, and branch moves update the diff.

import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

export function startWatcher(
  root: string,
  onChange: (paths: string[]) => void,
  debounceMs = 120,
): FSWatcher {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const paths = [...pending];
    pending.clear();
    if (paths.length) onChange(paths);
  };

  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString();
    if (isIgnored(rel)) return;
    pending.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  watcher.on("error", (err) => {
    console.error("helm: watcher error:", err);
  });

  return watcher;
}

function isIgnored(rel: string): boolean {
  const parts = rel.split(sep);
  if (parts.includes("node_modules")) return true;
  if (parts.includes("dist") || parts.includes(".cache")) return true;

  if (parts[0] === ".git") {
    // High-churn internals we don't care about; everything else under .git
    // (HEAD, index, refs/*, MERGE_HEAD, ...) is meaningful.
    if (parts[1] === "objects" || parts[1] === "logs") return true;
    if (rel.endsWith(".lock")) return true;
    return false;
  }

  const base = parts[parts.length - 1] ?? "";
  if (base === ".DS_Store") return true;
  if (base.endsWith("~") || base.endsWith(".swp") || base.startsWith(".#")) return true;
  return false;
}
