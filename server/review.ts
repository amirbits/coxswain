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
      // Markdown is rendered but anchored against the raw source, so a text
      // selection comes back without its formatting markers (*italic*, **bold**,
      // `code`, links). Normalize both sides before comparing — otherwise a
      // comment on any formatted prose would read as outdated immediately.
      outdated = !normalizeProse(ctx.intent.content).includes(normalizeProse(t.context));
    } else if (t.anchor.view === "diff") {
      outdated = !ctx.diff.raw.includes(t.context);
    }
  }

  const effectiveStatus =
    t.status === "resolved" ? "resolved" : outdated ? "outdated" : "open";

  return { ...t, outdated, effectiveStatus };
}

// Strip inline markdown markers and collapse whitespace so a rendered selection
// matches the raw source. Lossy on purpose: a real rewrite still drifts the
// quote out, but mere formatting no longer triggers a false "outdated".
function normalizeProse(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/[*_`~]+/g, "") // emphasis / code / strikethrough markers
    .replace(/\s+/g, " ") // newlines + runs of spaces -> single space
    .trim();
}
