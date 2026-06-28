import { useMemo, useState, type ReactNode } from "react";
import { Diff, Hunk, getChangeKey, parseDiff } from "react-diff-view";
import type { ChangeData } from "react-diff-view";
import "react-diff-view/style/index.css";
import type { DecoratedThread, NewComment } from "../types";
import { Composer } from "./Composer";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

// Per-file diff for the active mode. Click a gutter line (shift-click for a
// range) to comment; existing threads on this file overlay wherever their
// content currently sits. Comments anchor to current-file (new-side) content;
// deleted lines aren't commentable in v1 (DESIGN.md §12).
type Props = {
  path: string;
  diff: string;
  threads: DecoratedThread[];
  actions: ThreadActions;
  activeThreadId: string | null;
  onFocusThread: (id: string) => void;
  onAddComment: (c: NewComment, text: string) => Promise<void>;
};

type Sel = { anchorKey: string; focusKey: string };

export function DiffView({ path, diff, threads, actions, activeThreadId, onFocusThread, onAddComment }: Props) {
  const files = useMemo(() => {
    try {
      return parseDiff(diff || "");
    } catch {
      return [];
    }
  }, [diff]);
  const [sel, setSel] = useState<Sel | null>(null);

  if (files.length === 0) {
    return (
      <div className="empty big">
        <p>No changes to this file in this mode.</p>
        <p className="muted">Switch to the File view to read and comment on it as-is.</p>
      </div>
    );
  }

  const file = files[0];
  const flat = file.hunks.flatMap((h) => h.changes);
  const active = sel ? computeRange(flat, sel) : null;

  const byKey: Record<string, DecoratedThread[]> = {};
  for (const t of threads) {
    const line = t.located?.endLine ?? t.anchor.endLine;
    if (line <= 0) continue;
    const change = flat.find((c) => newLineOf(c) === line);
    if (!change) continue;
    (byKey[getChangeKey(change)] ??= []).push(t);
  }

  const widgets: Record<string, ReactNode> = {};
  for (const [key, ts] of Object.entries(byKey)) {
    widgets[key] = (
      <div className="inline-threads">
        {ts.map((t) => (
          <ThreadCard
            key={t.id}
            thread={t}
            actions={actions}
            compact
            active={t.id === activeThreadId}
            onFocus={() => onFocusThread(t.id)}
          />
        ))}
      </div>
    );
  }
  if (active && sel) {
    widgets[sel.focusKey] = (
      <div className="inline-stack">
        {widgets[sel.focusKey]}
        <div className="inline-composer">
          <div className="composer-where">
            {path.split("/").pop()}:{active.startLine}
            {active.endLine !== active.startLine ? `–${active.endLine}` : ""}
          </div>
          <Composer
            placeholder="Comment on these lines…"
            onSubmit={async (text) => {
              await onAddComment({ path, startLine: active.startLine, endLine: active.endLine, content: active.content }, text);
              setSel(null);
            }}
            onCancel={() => setSel(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="diff-body">
      <Diff
        diffType={file.type}
        viewType="unified"
        hunks={file.hunks}
        selectedChanges={active ? active.keys : []}
        widgets={widgets}
        gutterEvents={{
          onClick: ({ change }, e) => {
            if (!change || change.type === "delete") return; // deleted lines: deferred
            const key = getChangeKey(change);
            setSel((prev) => (e.shiftKey && prev ? { ...prev, focusKey: key } : { anchorKey: key, focusKey: key }));
          },
        }}
      >
        {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
      </Diff>
    </div>
  );
}

function newLineOf(c: ChangeData): number {
  return c.type === "insert" ? c.lineNumber : c.type === "normal" ? c.newLineNumber : -1;
}

function computeRange(flat: ChangeData[], sel: Sel) {
  const ai = flat.findIndex((c) => getChangeKey(c) === sel.anchorKey);
  const fi = flat.findIndex((c) => getChangeKey(c) === sel.focusKey);
  if (ai < 0 || fi < 0) return null;
  const [lo, hi] = ai <= fi ? [ai, fi] : [fi, ai];
  const chosen = flat.slice(lo, hi + 1);
  const newLines = chosen.map(newLineOf).filter((n) => n > 0);
  // anchor to current-file content: keep non-deleted lines
  const content = chosen.filter((c) => c.type !== "delete").map((c) => c.content).join("\n");
  return {
    keys: chosen.map(getChangeKey),
    startLine: newLines.length ? Math.min(...newLines) : 0,
    endLine: newLines.length ? Math.max(...newLines) : 0,
    content,
  };
}
