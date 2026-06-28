// Derive the "outdated" display state for threads. A comment anchored to content
// that has since drifted is marked outdated rather than silently moved — exactly
// how GitHub survives commenting on a moving diff (DESIGN.md §4).
//
// We use content-based drift detection: the text that was anchored at creation
// (`thread.context`) is searched for in the current projection. If it is gone,
// the thread is outdated. This is uniform across views and needs no line-number
// rebasing.

import type { DecoratedThread, DiffPayload, IntentPayload, Thread } from "./types";

export type DriftContext = { intent: IntentPayload; diff: DiffPayload };

export function decorateThreads(threads: Thread[], ctx: DriftContext): DecoratedThread[] {
  return threads.map((t) => decorate(t, ctx));
}

function decorate(t: Thread, ctx: DriftContext): DecoratedThread {
  let outdated = false;

  // Only open threads can be outdated; resolved ones are done.
  if (t.status === "open" && t.context) {
    if (t.anchor.view === "intent") {
      outdated = !ctx.intent.content.includes(t.context);
    } else if (t.anchor.view === "diff") {
      outdated = !ctx.diff.raw.includes(t.context);
    }
  }

  const effectiveStatus =
    t.status === "resolved" ? "resolved" : outdated ? "outdated" : "open";

  return { ...t, outdated, effectiveStatus };
}
