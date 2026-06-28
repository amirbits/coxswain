import { Fragment, useRef, useState, type MouseEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DecoratedThread, FilePayload, NewComment } from "../types";
import { truncate } from "../util";
import { Composer } from "./Composer";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

// The file as-is (DESIGN.md §12). Markdown renders formatted with select-to-
// comment (+ a raw toggle); everything else is a line-numbered code view where
// you click a gutter line (shift-click for a range) to comment. Both anchor the
// comment to the line content.
type Props = {
  file: FilePayload;
  threads: DecoratedThread[];
  actions: ThreadActions;
  activeThreadId: string | null;
  onFocusThread: (id: string) => void;
  onAddComment: (c: NewComment, text: string) => Promise<void>;
};

export function FileView(props: Props) {
  const { file } = props;
  const [raw, setRaw] = useState(false);

  if (!file.exists) return <div className="empty big"><p>File not found.</p></div>;
  if (file.kind === "binary") return <div className="empty big"><p>Binary file.</p></div>;

  const isMd = file.kind === "markdown";
  return (
    <div className="file-view">
      {isMd && (
        <div className="file-subbar">
          <button className="btn small" onClick={() => setRaw((r) => !r)}>
            {raw ? "rendered" : "raw"}
          </button>
        </div>
      )}
      {isMd && !raw ? <MarkdownBody {...props} /> : <CodeLines {...props} />}
    </div>
  );
}

function CodeLines({ file, threads, actions, activeThreadId, onFocusThread, onAddComment }: Props) {
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const lines = file.content.replace(/\n$/, "").split("\n");

  const byLine: Record<number, DecoratedThread[]> = {};
  for (const t of threads) {
    const l = t.located?.endLine ?? t.anchor.endLine;
    if (l > 0) (byLine[l] ??= []).push(t);
  }

  const onGutter = (n: number, e: MouseEvent) =>
    setSel((prev) =>
      e.shiftKey && prev ? { start: Math.min(prev.start, n), end: Math.max(prev.end, n) } : { start: n, end: n },
    );

  const submit = async (text: string) => {
    if (!sel) return;
    const content = lines.slice(sel.start - 1, sel.end).join("\n");
    await onAddComment({ path: file.path, startLine: sel.start, endLine: sel.end, content }, text);
    setSel(null);
  };

  return (
    <div className="code-view">
      {lines.map((line, i) => {
        const n = i + 1;
        const inSel = sel && n >= sel.start && n <= sel.end;
        return (
          <Fragment key={n}>
            <div className={`code-line${inSel ? " sel" : ""}`}>
              <span className="ln" onClick={(e) => onGutter(n, e)}>
                {n}
              </span>
              <span className="lc">{line === "" ? " " : line}</span>
            </div>
            {byLine[n] && (
              <div className="inline-threads">
                {byLine[n].map((t) => (
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
            )}
            {sel && sel.end === n && (
              <div className="inline-composer">
                <div className="composer-where">
                  {file.path.split("/").pop()}:{sel.start}
                  {sel.end !== sel.start ? `–${sel.end}` : ""}
                </div>
                <Composer placeholder="Comment on these lines…" onSubmit={submit} onCancel={() => setSel(null)} />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function MarkdownBody({ file, threads, onAddComment }: Props) {
  const [selection, setSelection] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  function capture() {
    if (composing) return;
    const s = window.getSelection();
    const node = s?.anchorNode;
    if (!s || s.isCollapsed || !bodyRef.current || !node || !bodyRef.current.contains(node)) {
      setSelection(null);
      return;
    }
    const q = s.toString().trim();
    setSelection(q || null);
  }

  const submit = async (text: string) => {
    if (!selection) return;
    const idx = file.content.indexOf(selection.split("\n")[0]);
    const line = idx >= 0 ? file.content.slice(0, idx).split("\n").length : 0;
    await onAddComment({ path: file.path, startLine: line, endLine: line, content: selection }, text);
    setComposing(false);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className="markdown-wrap">
      <div className="intent-body markdown" ref={bodyRef} onMouseUp={capture}>
        <Markdown remarkPlugins={[remarkGfm]}>{file.content}</Markdown>
      </div>
      {threads.length > 0 && (
        <div className="md-note muted">
          {threads.length} comment{threads.length > 1 ? "s" : ""} on this file — anchored text is highlighted in the Review panel
        </div>
      )}
      {selection && !composing && (
        <div className="selection-bar">
          <span className="muted">“{truncate(selection, 56)}”</span>
          <button
            className="btn small primary"
            onMouseDown={(e) => {
              e.preventDefault();
              setComposing(true);
            }}
          >
            Comment
          </button>
        </div>
      )}
      {composing && selection && (
        <div className="intent-composer">
          <div className="composer-where">On “{truncate(selection, 48)}”</div>
          <Composer placeholder="Comment on the selected text…" onSubmit={submit} onCancel={() => setComposing(false)} />
        </div>
      )}
    </div>
  );
}
