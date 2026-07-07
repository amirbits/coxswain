// The two projections the v2 UI fetches: the workspace (explorer tree + repo info
// + all threads) and a single file (content + its per-mode diff). Both are
// composed fresh from git + the store on every request — nothing is cached
// (see docs/intent/SPEC.md).

import { basename } from "node:path";
import { changedFiles, diffFile, fileStatus, inScope, keepPath, listFiles, listRefs, readFileContent, status } from "./git";
import { decorateThreads } from "./review";
import type { Store } from "./store";
import type { DiffMode, FilePayload, TreeEntry, Workspace } from "./types";

// `scope` is a repo-relative subdir the view is focused on ("" = whole repo).
// The file tree and change badges are scoped to it; branch topology stays global
// (a branch is a repo-wide fact), and `elsewhere` counts the working-tree changes
// outside the scope so the view never hides that the repo is dirty (see
// docs/intent/SPEC.md).
export async function getWorkspace(root: string, store: Store, mode: DiffMode, scope = ""): Promise<Workspace> {
  const [st, files, refs, changed, rawThreads] = await Promise.all([
    status(root),
    listFiles(root, scope),
    listRefs(root),
    changedFiles(root, mode, scope),
    store.listThreads(),
  ]);
  const threads = await decorateThreads(rawThreads, root);

  const elsewhere = new Set(
    st.files.map((f) => f.path).filter((p) => keepPath(p) && !inScope(p, scope)),
  ).size;

  const counts: Record<string, { open: number; outdated: number }> = {};
  for (const t of threads) {
    const c = (counts[t.anchor.path] ??= { open: 0, outdated: 0 });
    if (t.effectiveStatus === "open") c.open++;
    else if (t.effectiveStatus === "outdated") c.outdated++;
  }

  const paths = new Set(files);
  for (const p of Object.keys(changed)) paths.add(p); // include deletions (not in ls-files)
  const tree: TreeEntry[] = [...paths].sort().map((p) => ({
    path: p,
    status: changed[p] ?? null,
    open: counts[p]?.open ?? 0,
    outdated: counts[p]?.outdated ?? 0,
  }));

  return {
    repo: { root, name: basename(root), scope, elsewhere, intentPath: store.intentRelPath(), branch: st.branch, head: st.head, upstream: st.upstream, ahead: st.ahead, behind: st.behind, refs },
    mode,
    tree,
    threads,
  };
}

export async function getFile(root: string, store: Store, path: string, mode: DiffMode): Promise<FilePayload> {
  const [file, diff, status] = await Promise.all([
    readFileContent(root, path),
    diffFile(root, path, mode),
    fileStatus(root, path, mode),
  ]);
  return { path, exists: file.exists, kind: file.kind, content: file.content, diff, status };
}
