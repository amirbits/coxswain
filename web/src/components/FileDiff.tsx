import { useMemo, useState, type ReactNode } from "react";
import { Diff, Hunk, getChangeKey, markEdits, tokenize } from "react-diff-view";
import type { ChangeData, FileData } from "react-diff-view";
import "react-diff-view/style/index.css";
import type { DecoratedThread, NewComment } from "../types";
import { Composer } from "./Composer";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

// One parsed file's diff (shared by the single-file Diff pane and the continuous
// "All changes" view). Click a gutter line (shift-click for a range) to comment;
// threads overlay at their located line. Comments anchor to current-file
// (new-side) content; deleted lines aren't commentable in v1 (DESIGN.md §12).
export type FileDiffProps = {
  path: string;
  file: FileData;
  threads: DecoratedThread[];
  actions: ThreadActions;
  activeThreadId: string | null;
  onFocusThread: (id: string) => void;
  onAddComment: (c: NewComment, text: string) => Promise<void>;
};

type Sel = { anchorKey: string; focusKey: string };

export function FileDiff({ path, file, threads, actions, activeThreadId, onFocusThread, onAddComment }: FileDiffProps) {
  const [sel, setSel] = useState<Sel | null>(null);
  const flat = file.hunks.flatMap((h) => h.changes);
  const active = sel ? computeRange(flat, sel) : null;

  // Intra-line ("word") highlighting: react-diff-view refines each changed line to
  // the exact edited spans. Guarded — tokenize can throw on pathological input.
  const tokens = useMemo(() => {
    try {
      return tokenize(file.hunks, { enhancers: [markEdits(file.hunks, { type: "block" })] });
    } catch {
      return undefined;
    }
  }, [file.hunks]);

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
          <ThreadCard key={t.id} thread={t} actions={actions} compact active={t.id === activeThreadId} onFocus={() => onFocusThread(t.id)} />
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
    <Diff
      diffType={file.type}
      viewType="unified"
      hunks={file.hunks}
      tokens={tokens}
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
  );
}

export function pathOfFile(file: FileData): string {
  return file.type === "delete" ? file.oldPath : file.newPath;
}

export function countChanges(file: FileData): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const h of file.hunks) {
    for (const c of h.changes) {
      if (c.type === "insert") adds++;
      else if (c.type === "delete") dels++;
    }
  }
  return { adds, dels };
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
  const content = chosen.filter((c) => c.type !== "delete").map((c) => c.content).join("\n");
  return {
    keys: chosen.map(getChangeKey),
    startLine: newLines.length ? Math.min(...newLines) : 0,
    endLine: newLines.length ? Math.max(...newLines) : 0,
    content,
  };
}
