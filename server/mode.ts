// One place that parses a DiffMode. The HTTP query string, the CLI flags, and
// the registry's `asMode` all funnel through here so the three front doors agree
// on edge cases (see docs/intent/SPEC.md). The projector never receives a
// half-specified mode: an empty/whitespace ref collapses to null, and a
// ref-requiring kind (branch/ref) with no ref collapses to "working" — the UI is responsible
// for disabling the mode switch until a ref is entered, rather than silently
// rendering the working-tree diff.

import type { DiffMode } from "./types";

export type ModeInput = { kind?: unknown; ref?: unknown };

export function normalizeRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const r = ref.trim();
  return r ? r : null;
}

export function parseMode(input: ModeInput | null | undefined): DiffMode {
  if (!input) return { kind: "working" };
  const ref = normalizeRef(input.ref);
  const kind = input.kind;
  if (kind === "staged") return { kind: "staged" };
  if ((kind === "branch" || kind === "ref") && ref) return { kind, ref };
  return { kind: "working" };
}

// kind + ref as separate strings (query params, flag pairs).
export function parseModeParts(kind: unknown, ref: unknown): DiffMode {
  return parseMode({ kind, ref });
}
