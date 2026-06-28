// The full app state is a *projection* of the working tree — composed fresh from
// git + the file store on every request. Nothing is cached; if the server
// restarts, the exact same state re-derives from the filesystem (DESIGN.md §2).

import { basename } from "node:path";
import { getDiff, status } from "./git";
import { decorateThreads } from "./review";
import type { Store } from "./store";
import type { AppState } from "./types";

export async function getState(
  root: string,
  store: Store,
  base: string | null,
): Promise<AppState> {
  const [st, intent, diff, rawThreads] = await Promise.all([
    status(root),
    store.readIntent(),
    getDiff(root, base),
    store.listThreads(),
  ]);

  const threads = decorateThreads(rawThreads, { intent, diff });

  return {
    repoRoot: root,
    repoName: basename(root),
    branch: st.branch,
    head: st.head,
    status: st,
    intent,
    diff,
    threads,
  };
}
