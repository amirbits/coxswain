// Registers the concrete v1 capabilities onto a Registry. These are the verbs
// the palette/NL bar/agent share. Each is a thin, deterministic binding over the
// git adapter and the file store.

import { getDiff, status } from "./git";
import { Registry } from "./registry";
import { decorateThreads } from "./review";
import { getState } from "./state";
import type { Store } from "./store";
import type { Anchor, Author } from "./types";

export function buildRegistry(deps: { root: string; store: Store }): Registry {
  const { root, store } = deps;
  const reg = new Registry();

  reg.register("getState", "Project the full app state from the working tree", (a: { base?: string }) =>
    getState(root, store, a.base ?? null),
  );

  reg.register("showDiff", "Get the diff (working tree, or base...HEAD)", (a: { base?: string }) =>
    getDiff(root, a.base ?? null),
  );

  reg.register("getIntent", "Read INTENT.md", () => store.readIntent());

  reg.register("writeIntent", "Write INTENT.md (write-through edit)", async (a: { content: string }) => {
    await store.writeIntent(String(a.content ?? ""));
    return store.readIntent();
  });

  reg.register("listThreads", "List review threads, decorated with drift state", async () => {
    const [intent, diff, threads] = await Promise.all([
      store.readIntent(),
      getDiff(root, null),
      store.listThreads(),
    ]);
    return decorateThreads(threads, { intent, diff });
  });

  reg.register(
    "addComment",
    "Create a review thread anchored to a region",
    (a: { anchor: Anchor; text: string; author?: Author; context?: string }) =>
      store.createThread(a.anchor, a.text, a.author ?? "human", a.context),
  );

  reg.register("replyComment", "Append a reply to a thread", (a: { id: string; text: string; author?: Author }) =>
    store.appendMessage(a.id, a.author ?? "human", a.text),
  );

  reg.register("resolveComment", "Resolve a thread", (a: { id: string }) => store.setStatus(a.id, "resolved"));

  reg.register("reopenComment", "Reopen a resolved thread", (a: { id: string }) => store.setStatus(a.id, "open"));

  reg.register("getThread", "Get one thread, decorated with drift state", async (a: { id: string }) => {
    const t = await store.getThread(a.id);
    if (!t) throw new Error(`thread not found: ${a.id}`);
    const [intent, diff] = await Promise.all([store.readIntent(), getDiff(root, null)]);
    return decorateThreads([t], { intent, diff })[0];
  });

  reg.register(
    "suggestEdit",
    "Propose a non-destructive replacement for a thread's anchored region",
    (a: { id: string; newText: string; base?: string; body?: string; author?: Author }) =>
      store.addSuggestion(a.id, { newText: a.newText, base: a.base, body: a.body, author: a.author ?? "agent" }),
  );

  reg.register("applySuggestion", "Apply a thread's pending suggestion to its file (write-through)", (a: { id: string }) =>
    store.applySuggestion(a.id),
  );

  reg.register("dismissSuggestion", "Dismiss a thread's pending suggestion", (a: { id: string }) =>
    store.dismissSuggestion(a.id),
  );

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

  return reg;
}
