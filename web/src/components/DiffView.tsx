import { useMemo, useState, type ReactNode } from "react";
import { Diff, Hunk, getChangeKey, parseDiff } from "react-diff-view";
import type { ChangeData, FileData } from "react-diff-view";
import "react-diff-view/style/index.css";
import type { DecoratedThread, DiffPayload, LineRange } from "../types";
import { basename } from "../util";
import { Composer } from "./Composer";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

// The most important view (IMPLEMENTATION_BRIEF §4). Renders the unified diff,
// lets you select a line (or shift-click a range) on the gutter to attach a
// thread, and anchors existing threads inline as widgets. Drift is detected
// server-side via the captured line content.
type Sel = { fileKey: string; anchorKey: string; focusKey: string };

export function DiffView({
  diff,
  threads,
  actions,
  activeThreadId,
  onFocusThread,
  onAddComment,
}: {
  diff: DiffPayload;
  threads: DecoratedThread[];
  actions: ThreadActions;
  activeThreadId: string | null;
  onFocusThread: (id: string) => void;
  onAddComment: (locator: LineRange, context: string, text: string) => Promise<void>;
}) {
  const files = useMemo(() => safeParse(diff.raw), [diff.raw]);
  const [sel, setSel] = useState<Sel | null>(null);

  const diffThreads = threads.filter(
    (t) => t.anchor.view === "diff" && t.anchor.locator.kind === "lines",
  );

  return (
    <section className="view diff-view">
      <header className="view-head">
        <h1>Diff</h1>
        <span className="pill">{diff.mode === "branch" ? `${diff.base}…HEAD` : "working tree"}</span>
        <span className="spacer" />
        <span className="muted hint">click a line number to comment · shift-click for a range</span>
      </header>

      {files.length === 0 ? (
        <div className="empty big">
          <p>No changes.</p>
          <p className="muted">
            The working tree matches {diff.mode === "branch" ? "the diff base" : "HEAD"}. Edits
            appear here live.
          </p>
        </div>
      ) : (
        <div className="diff-files">
          {files.map((file, i) => {
            const fileKey = fileKeyOf(file, i);
            const flat = file.hunks.flatMap((h) => h.changes);
            const active = sel?.fileKey === fileKey ? computeRange(flat, sel) : null;
            const widgets = buildWidgets(file, fileKey, flat, active);
            const { adds, dels } = countChanges(flat);

            return (
              <div className="diff-file" key={fileKey}>
                <div className="file-head">
                  <span className={`ftype ${file.type}`}>{file.type}</span>
                  <span className="fpath">{pathOf(file)}</span>
                  <span className="spacer" />
                  <span className="fstat">
                    <span className="add">+{adds}</span> <span className="del">−{dels}</span>
                  </span>
                </div>
                <Diff
                  diffType={file.type}
                  viewType="unified"
                  hunks={file.hunks}
                  selectedChanges={active ? active.keys : []}
                  widgets={widgets}
                  gutterEvents={{
                    onClick: ({ change }, e) => {
                      if (!change) return;
                      const key = getChangeKey(change);
                      setSel((prev) =>
                        e.shiftKey && prev && prev.fileKey === fileKey
                          ? { ...prev, focusKey: key }
                          : { fileKey, anchorKey: key, focusKey: key },
                      );
                    },
                  }}
                >
                  {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
                </Diff>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );

  function buildWidgets(
    file: FileData,
    fileKey: string,
    flat: ChangeData[],
    active: Range | null,
  ): Record<string, ReactNode> {
    const widgets: Record<string, ReactNode> = {};
    const path = pathOf(file);

    // anchor existing threads to the change at their end line (if still present)
    const byKey: Record<string, DecoratedThread[]> = {};
    for (const t of diffThreads) {
      const loc = t.anchor.locator as LineRange;
      if (loc.path !== path && loc.path !== file.oldPath && loc.path !== file.newPath) continue;
      const change = flat.find((c) => changeMatches(c, loc.side ?? "new", loc.endLine));
      if (!change) continue; // drifted out of view → shows in the side panel only
      (byKey[getChangeKey(change)] ||= []).push(t);
    }
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

    // composer for the in-progress selection
    if (active && sel?.fileKey === fileKey) {
      const key = sel.focusKey;
      const existing = widgets[key];
      widgets[key] = (
        <div className="inline-stack">
          {existing}
          <div className="inline-composer">
            <div className="composer-where">
              On {basename(path)}:{active.startLine}
              {active.endLine !== active.startLine ? `–${active.endLine}` : ""}
            </div>
            <Composer
              placeholder="Comment on these lines…"
              onSubmit={async (text) => {
                await onAddComment(
                  { kind: "lines", path, side: active.side, startLine: active.startLine, endLine: active.endLine },
                  active.context,
                  text,
                );
                setSel(null);
              }}
              onCancel={() => setSel(null)}
            />
          </div>
        </div>
      );
    }

    return widgets;
  }
}

// ---------------------------------------------------------------------------

type Range = {
  keys: string[];
  startLine: number;
  endLine: number;
  side: "old" | "new";
  context: string;
};

function safeParse(raw: string): FileData[] {
  try {
    return parseDiff(raw || "");
  } catch {
    return [];
  }
}

function pathOf(f: FileData): string {
  return f.type === "delete" ? f.oldPath : f.newPath;
}

function fileKeyOf(f: FileData, i: number): string {
  return `${i}:${f.oldPath}:${f.newPath}`;
}

function countChanges(flat: ChangeData[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const c of flat) {
    if (c.type === "insert") adds++;
    else if (c.type === "delete") dels++;
  }
  return { adds, dels };
}

function changeMatches(c: ChangeData, side: "old" | "new", line: number): boolean {
  if (side === "new") {
    return (c.type === "insert" && c.lineNumber === line) || (c.type === "normal" && c.newLineNumber === line);
  }
  return (c.type === "delete" && c.lineNumber === line) || (c.type === "normal" && c.oldLineNumber === line);
}

// The drift context is rebuilt as `marker + content` so it substring-matches the
// raw unified diff the server checks against (gitdiff-parser strips the marker).
function marker(c: ChangeData): string {
  return c.type === "insert" ? "+" : c.type === "delete" ? "-" : " ";
}

function computeRange(flat: ChangeData[], sel: Sel): Range | null {
  const ai = flat.findIndex((c) => getChangeKey(c) === sel.anchorKey);
  const fi = flat.findIndex((c) => getChangeKey(c) === sel.focusKey);
  if (ai < 0 || fi < 0) return null;
  const [lo, hi] = ai <= fi ? [ai, fi] : [fi, ai];
  const chosen = flat.slice(lo, hi + 1);

  const newLines: number[] = [];
  const oldLines: number[] = [];
  for (const c of chosen) {
    if (c.type === "insert") newLines.push(c.lineNumber);
    else if (c.type === "delete") oldLines.push(c.lineNumber);
    else {
      newLines.push(c.newLineNumber);
      oldLines.push(c.oldLineNumber);
    }
  }
  const side: "old" | "new" = newLines.length ? "new" : "old";
  const lines = side === "new" ? newLines : oldLines;

  return {
    keys: chosen.map(getChangeKey),
    startLine: Math.min(...lines),
    endLine: Math.max(...lines),
    side,
    context: chosen.map((c) => marker(c) + c.content).join("\n"),
  };
}
