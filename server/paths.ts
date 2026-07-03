// Repo path containment. `resolve` only collapses "..", so a symlink *inside*
// the repo that points outward passes a lexical `startsWith(root)` check yet
// reads/writes outside it. We canonicalize with realpath to close that — and,
// because a file we're about to write may not exist yet, realpath the nearest
// existing ancestor and re-attach the missing tail. Callers get back the
// resolved (non-canonical) path to act on; the guard is the point, not the
// rewrite.

import { realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

export function resolveInRepo(root: string, rel: string): string {
  const realRoot = realpathSync(resolve(root));
  const full = resolve(realRoot, rel);
  const real = canonicalize(full);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error("path escapes repository");
  }
  return full;
}

// realpath, tolerant of a not-yet-created tail: resolve the longest existing
// prefix (following any symlinks along it) and re-attach the missing segments.
function canonicalize(p: string): string {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return missing.length ? resolve(real, ...missing) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p; // hit the filesystem root without resolving
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}
