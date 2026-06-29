// The v1 capabilities, registered onto a Registry. Shared by the UI, the HTTP
// API, and the CLI (DESIGN.md §5). Diff modes are normalized here.

import { diffAll, gitFetch, gitStatus, gitTopology, status } from "./git";
import { parseMode } from "./mode";
import { Registry } from "./registry";
import { decorateThreads } from "./review";
import type { Store } from "./store";
import { getFile, getWorkspace } from "./workspace";

const asMode = (m: any) => parseMode(m);

export function buildRegistry(deps: { root: string; store: Store }): Registry {
  const { root, store } = deps;
  const reg = new Registry();

  // Projections
  reg.register("workspace", "Explorer tree + repo info + all threads", (a: any) => getWorkspace(root, store, asMode(a?.mode)));
  reg.register("file", "A file's current content + its per-mode diff", (a: any) => getFile(root, store, String(a.path), asMode(a?.mode)));
  reg.register("showDiff", "Whole-repo diff for a mode", (a: any) => diffAll(root, asMode(a?.mode)));
  reg.register("getIntent", "Read INTENT.md", () => store.readIntent());
  reg.register("writeIntent", "Write INTENT.md (write-through)", async (a: any) => {
    await store.writeIntent(String(a.content ?? ""));
    return store.readIntent();
  });
  reg.register("writeFile", "Write a repo file (write-through)", async (a: any) => {
    const path = String(a.path ?? "");
    if (!path) throw new Error("path required");
    await store.writeFile(path, String(a.content ?? ""));
    return { ok: true, path };
  });

  // Threads
  reg.register("listThreads", "List review threads, decorated", async () => decorateThreads(await store.listThreads(), root));
  reg.register("getThread", "One thread, decorated", async (a: any) => {
    const t = await store.getThread(a.id);
    if (!t) throw new Error(`thread not found: ${a.id}`);
    return (await decorateThreads([t], root))[0];
  });
  reg.register("addComment", "Create a thread anchored to file content", (a: any) =>
    store.createThread(
      { path: String(a.path), startLine: Number(a.startLine) || 0, endLine: Number(a.endLine) || Number(a.startLine) || 0 },
      String(a.text),
      a.author ?? "human",
      a.context,
    ),
  );
  reg.register("replyComment", "Append a reply", (a: any) => store.appendMessage(a.id, a.author ?? "human", a.text));
  reg.register("resolveComment", "Resolve a thread", (a: any) => store.setStatus(a.id, "resolved"));
  reg.register("reopenComment", "Reopen a thread", (a: any) => store.setStatus(a.id, "open"));

  // Suggestions
  reg.register("suggestEdit", "Propose a replacement for a thread's region", (a: any) =>
    store.addSuggestion(a.id, { newText: a.newText, base: a.base, body: a.body, author: a.author ?? "agent" }),
  );
  reg.register("applySuggestion", "Apply a thread's suggestion (write-through)", (a: any) => store.applySuggestion(a.id));
  reg.register("dismissSuggestion", "Dismiss a thread's suggestion", (a: any) => store.dismissSuggestion(a.id));

  reg.register("repoStatus", "Branch + change + review summary", async () => {
    const [st, threads] = await Promise.all([status(root), store.listThreads()]);
    return {
      branch: st.branch,
      head: st.head,
      changedFiles: st.files.length,
      comments: {
        open: threads.filter((t) => t.status === "open").length,
        resolved: threads.filter((t) => t.status === "resolved").length,
        total: threads.length,
      },
    };
  });

  // Source control (Slice A) — read-only orientation + the one safe action.
  reg.register("gitStatus", "Working-tree status grouped (staged/unstaged/untracked) + ahead/behind + stash count", () => gitStatus(root));
  reg.register("gitTopology", "Worktrees, remotes, and remote branches", () => gitTopology(root));
  reg.register("gitFetch", "Fetch + prune remote-tracking refs (safe; never touches the working tree)", (a: any) =>
    gitFetch(root, a?.remote ? String(a.remote) : null),
  );

  return reg;
}
