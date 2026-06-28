import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Compartment, EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import type { Extension } from "@codemirror/state";
import type { DecoratedThread, FilePayload, NewComment } from "../types";
import { truncate } from "../util";
import { Composer } from "./Composer";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

// Class-based highlight style so token colors adapt to dark mode via CSS
// (HighlightStyle with `class` instead of inline colors).
const helmHighlight = HighlightStyle.define([
  { tag: tags.keyword, class: "tok-kw" },
  { tag: [tags.name, tags.variableName, tags.propertyName], class: "tok-var" },
  { tag: tags.string, class: "tok-str" },
  { tag: tags.number, class: "tok-num" },
  { tag: [tags.bool, tags.null], class: "tok-bool" },
  { tag: tags.comment, class: "tok-comment" },
  { tag: tags.function(tags.variableName), class: "tok-fn" },
  { tag: tags.typeName, class: "tok-type" },
  { tag: tags.operator, class: "tok-op" },
  { tag: tags.punctuation, class: "tok-punc" },
  { tag: tags.definition(tags.variableName), class: "tok-def" },
  { tag: tags.tagName, class: "tok-tag" },
  { tag: tags.attributeName, class: "tok-attr" },
]);

// The file as-is (DESIGN.md §12). Markdown renders formatted with select-to-
// comment (+ a raw/edit toggle); everything else is a CodeMirror code view that
// is read-only by default (syntax highlighting) and editable on demand, with
// write-through save. Click a gutter line (shift-click for a range) to comment;
// existing threads overlay on their located line as CM widgets. Both anchor the
// comment to the line content.
type Props = {
  file: FilePayload;
  threads: DecoratedThread[];
  actions: ThreadActions;
  activeThreadId: string | null;
  onFocusThread: (id: string) => void;
  onAddComment: (c: NewComment, text: string) => Promise<void>;
  onSave?: (path: string, content: string) => Promise<void> | void;
  onEditingChange?: (editing: boolean) => void;
};

function languageForPath(path: string): Extension[] {
  if (/\.md$/i.test(path)) return [markdown()];
  if (/\.(ts|tsx)$/i.test(path)) return [javascript({ typescript: true, jsx: true })];
  if (/\.(js|jsx|mjs|cjs)$/i.test(path)) return [javascript({ jsx: true })];
  if (/\.css$/i.test(path)) return [css()];
  if (/\.json$/i.test(path)) return [json()];
  if (/\.py$/i.test(path)) return [python()];
  if (/\.html?$/i.test(path)) return [html()];
  return [];
}

export function FileView(props: Props) {
  const { file } = props;

  if (!file.exists) return <div className="empty big"><p>File not found.</p></div>;
  if (file.kind === "binary") return <div className="empty big"><p>Binary file.</p></div>;

  const isMd = file.kind === "markdown";
  const [raw, setRaw] = useState(false);

  return (
    <div className="file-view">
      {isMd && (
        <div className="file-subbar">
          <button className="btn small" onClick={() => setRaw((r) => !r)}>
            {raw ? "rendered" : "raw"}
          </button>
        </div>
      )}
      {isMd && !raw ? <MarkdownBody {...props} /> : <CodePane key={file.path} {...props} canEdit={!!props.onSave} />}
    </div>
  );
}

// --- CodeMirror pane --------------------------------------------------------

type Ctx = { threads: DecoratedThread[]; actions: ThreadActions; activeThreadId: string | null; onFocusThread: (id: string) => void };
const setSelEffect = StateEffect.define<{ start: number; end: number } | null>();
const refreshEffect = StateEffect.define<null>();

// Highlight the gutter-selected line range.
const selField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(sel, tr) {
    sel = sel.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSelEffect)) {
        const v = e.value;
        if (!v || v.start <= 0) return Decoration.none;
        const decos: Range<Decoration>[] = [];
        for (let n = v.start; n <= v.end; n++) {
          if (n < 1 || n > tr.state.doc.lines) continue;
          decos.push(Decoration.line({ class: "cm-sel" }).range(tr.state.doc.line(n).from));
        }
        return Decoration.set(decos, true);
      }
    }
    return sel;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// A widget that mounts the inline thread cards for one line via a React portal.
class ThreadWidget extends WidgetType {
  root?: ReturnType<typeof createRoot>;
  constructor(readonly threads: DecoratedThread[], readonly ctx: Ctx) {
    super();
  }
  eq(other: ThreadWidget) {
    // Reuse the portal unless the set of threads, their message counts, or the
    // active highlight changed — avoids remounting (and losing focus) on noop.
    return (
      this.ctx.activeThreadId === other.ctx.activeThreadId &&
      this.threads.length === other.threads.length &&
      this.threads.every((t, i) => t.id === other.threads[i]?.id && t.thread.length === other.threads[i]?.thread.length)
    );
  }
  toDOM() {
    const host = document.createElement("div");
    host.className = "cm-threads";
    this.root = createRoot(host);
    this.root.render(
      <div className="inline-threads">
        {this.threads.map((t) => (
          <ThreadCard
            key={t.id}
            thread={t}
            actions={this.ctx.actions}
            compact
            active={t.id === this.ctx.activeThreadId}
            onFocus={() => this.ctx.onFocusThread(t.id)}
          />
        ))}
      </div>,
    );
    return host;
  }
  destroy() {
    this.root?.unmount();
  }
}

function threadPlugin(ctxRef: { current: Ctx }) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const ctx = ctxRef.current;
        const byLine: Record<number, DecoratedThread[]> = {};
        for (const t of ctx.threads) {
          const l = t.located?.endLine ?? t.anchor.endLine;
          if (l > 0) (byLine[l] ??= []).push(t);
        }
        const decos: Range<Decoration>[] = [];
        for (const [ln, ts] of Object.entries(byLine)) {
          const n = Number(ln);
          if (n < 1 || n > view.state.doc.lines) continue;
          decos.push(Decoration.widget({ widget: new ThreadWidget(ts, ctx), side: 1 }).range(view.state.doc.line(n).to));
        }
        return Decoration.set(decos, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function CodePane(props: Props & { canEdit: boolean }) {
  const { file, threads, actions, activeThreadId, onFocusThread, onAddComment, onSave, onEditingChange, canEdit } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const ctxRef = useRef<Ctx>({ threads, actions, activeThreadId, onFocusThread });
  ctxRef.current = { threads, actions, activeThreadId, onFocusThread };

  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [editable, setEditable] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editableComp = useRef(new Compartment()).current;
  const saveRef = useRef<() => void>(() => {});
  const dirtyChangeRef = useRef<() => void>(() => {});
  dirtyChangeRef.current = () => {
    setDirty(true);
    onEditingChange?.(true);
  };

  // Build the editor once per file (keyed by path in FileView).
  useEffect(() => {
    if (!hostRef.current) return;
    const ctx = ctxRef;
    const state = EditorState.create({
      doc: file.content,
      extensions: [
        lineNumbers(),
        syntaxHighlighting(helmHighlight),
        selField,
        threadPlugin(ctx),
        EditorView.domEventHandlers({
          click: (event, view) => {
            const target = event.target as HTMLElement | null;
            if (!target || !target.closest(".cm-gutters")) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            const n = view.state.doc.lineAt(pos).number;
            setSel((prev) =>
              event.shiftKey && prev ? { start: Math.min(prev.start, n), end: Math.max(prev.end, n) } : { start: n, end: n },
            );
            return true;
          },
        }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        keymap.of([{ key: "Mod-s", run: () => { saveRef.current(); return true; } }]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) dirtyChangeRef.current();
        }),
        editableComp.of(EditorView.editable.of(editable)),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
        EditorView.lineWrapping,
        ...languageForPath(file.path),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
      // Release the edit lock so SSE refetch resumes for the next file.
      onEditingChange?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to edit-mode toggles.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableComp.reconfigure(EditorView.editable.of(editable)) });
  }, [editable, editableComp]);

  // Sync external content changes when not dirty (the SSE refetch is paused
  // while editing — this covers non-editing refreshes and mode switches).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || dirty) return;
    if (file.content !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } });
    }
  }, [file.content, dirty]);

  // Push the gutter selection into CM for highlighting.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setSelEffect.of(sel) });
  }, [sel]);

  // Force the thread-widget plugin to rebuild when threads/active change.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshEffect.of(null) });
  }, [threads, activeThreadId]);

  // Track dirty + notify the host so SSE refetch won't clobber the buffer.
  // (handled by the updateListener installed above)

  // Keep the ⌘S keymap (installed once) pointed at the latest save closure.
  saveRef.current = () => doSave();

  function clearSel() {
    setSel(null);
    viewRef.current?.dispatch({ effects: setSelEffect.of(null) });
  }

  async function submitComment(text: string) {
    if (!sel) return;
    const view = viewRef.current;
    const doc = view?.state.doc.toString() ?? file.content;
    const lines = doc.split("\n");
    const content = lines.slice(sel.start - 1, sel.end).join("\n");
    await onAddComment({ path: file.path, startLine: sel.start, endLine: sel.end, content }, text);
    clearSel();
  }

  function startEdit() {
    setEditable(true);
  }

  function cancelEdit() {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    const view = viewRef.current;
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } });
    setDirty(false);
    setEditable(false);
    onEditingChange?.(false);
  }

  function doSave() {
    const view = viewRef.current;
    if (!view || !onSave) return;
    const content = view.state.doc.toString();
    // Optimistic: clear dirty now; refetch will resync the doc.
    setDirty(false);
    onEditingChange?.(false);
    onSave(file.path, content);
  }

  return (
    <div className="code-view cm-host">
      <div className="cm-editor-host" ref={hostRef} />
      {(sel || (canEdit && (editable || dirty)) || sel) && (
        <div className="cm-subfooter">
          {sel && (
            <div className="inline-composer">
              <div className="composer-where">
                {file.path.split("/").pop()}:{sel.start}
                {sel.end !== sel.start ? `–${sel.end}` : ""}
              </div>
              <Composer placeholder="Comment on these lines…" onSubmit={submitComment} onCancel={clearSel} />
            </div>
          )}
          {!sel && canEdit && !editable && (
            <div className="edit-bar">
              <span className="muted">read-only</span>
              <span className="spacer" />
              <button className="btn small" onClick={startEdit} title="Edit this file (write-through, never commits)">
                Edit
              </button>
            </div>
          )}
          {!sel && editable && (
            <div className="edit-bar">
              <span className="muted">{dirty ? "unsaved changes" : "no changes"}</span>
              <span className="spacer" />
              <button className="btn ghost small" onClick={cancelEdit}>
                Cancel
              </button>
              <button className="btn primary small" disabled={!dirty} onClick={doSave}>
                Save{dirty ? " *" : ""}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Markdown (rendered) ----------------------------------------------------

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

// avoid an unused-import/type error for DecorationSet / Transaction
