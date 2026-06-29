import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Compartment, EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { DecoratedThread, FilePayload, NewComment } from "../types";
import { truncate } from "../util";
import { Composer } from "./Composer";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

// Class-based highlight style so token colors adapt to dark mode via CSS.
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

// Grammars are loaded on demand per file type so they stay out of the initial
// bundle (Vite code-splits each dynamic import).
async function loadLanguage(path: string): Promise<Extension> {
  try {
    if (/\.md$/i.test(path)) return (await import("@codemirror/lang-markdown")).markdown();
    if (/\.(ts|tsx)$/i.test(path)) return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    if (/\.(js|jsx|mjs|cjs)$/i.test(path)) return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    if (/\.css$/i.test(path)) return (await import("@codemirror/lang-css")).css();
    if (/\.json$/i.test(path)) return (await import("@codemirror/lang-json")).json();
    if (/\.py$/i.test(path)) return (await import("@codemirror/lang-python")).python();
    if (/\.html?$/i.test(path)) return (await import("@codemirror/lang-html")).html();
    if (/\.rs$/i.test(path)) return (await import("@codemirror/lang-rust")).rust();
    if (/\.(c|h|cc|cpp|cxx|hpp|hh|hxx)$/i.test(path)) return (await import("@codemirror/lang-cpp")).cpp();
    if (/\.(sh|bash|zsh|ksh)$/i.test(path) || /(^|\/)\.(bashrc|bash_profile|zshrc|zprofile|zshenv|profile)$/i.test(path)) {
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
    }
  } catch {
    // grammar failed to load → no highlighting, still usable
  }
  return [];
}

// The file as-is (see docs/intent/SPEC.md). Markdown renders formatted with select-to-
// comment (+ a raw/edit toggle); everything else is a CodeMirror code view that
// is read-only by default (syntax highlighting) and editable on demand, with
// write-through save. Click a gutter line (shift-click for a range) to comment;
// the composer and existing threads render inline at the line as CM widgets.
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
      {isMd && !raw ? <MarkdownBody {...props} /> : <CodePane key={file.path} {...props} canEdit={!!props.onSave} />}
    </div>
  );
}

// --- CodeMirror pane --------------------------------------------------------

type Ctx = { threads: DecoratedThread[]; actions: ThreadActions; activeThreadId: string | null; onFocusThread: (id: string) => void };
type ComposerCtx = { sel: { start: number; end: number } | null; submit: (t: string) => void; cancel: () => void; label: string };

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

// Inline thread cards for one line, mounted via a React portal.
class ThreadWidget extends WidgetType {
  root?: Root;
  constructor(readonly threads: DecoratedThread[], readonly ctx: Ctx) {
    super();
  }
  eq(other: ThreadWidget) {
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
  ignoreEvent() {
    return true;
  }
  destroy() {
    this.root?.unmount();
  }
}

// The new-comment composer, inline at the selected line. eq() is stable while
// the line is unchanged, so CM reuses the DOM (and the textarea keeps its text)
// across rebuilds; callbacks are read fresh from the ref to avoid stale closures.
class ComposerWidget extends WidgetType {
  root?: Root;
  constructor(readonly line: number, readonly ctxRef: { current: ComposerCtx }) {
    super();
  }
  eq(other: ComposerWidget) {
    return this.line === other.line;
  }
  toDOM() {
    const host = document.createElement("div");
    host.className = "cm-composer";
    const ref = this.ctxRef;
    this.root = createRoot(host);
    this.root.render(
      <div className="inline-composer">
        <div className="composer-where">{ref.current.label}</div>
        <Composer placeholder="Comment on these lines…" onSubmit={(t) => ref.current.submit(t)} onCancel={() => ref.current.cancel()} />
      </div>,
    );
    return host;
  }
  ignoreEvent() {
    return true;
  }
  destroy() {
    this.root?.unmount();
  }
}

// One plugin renders both the inline threads and the inline composer, and only
// rebuilds on doc / threads / selection changes (not on every scroll or cursor).
function decorationsPlugin(ctxRef: { current: Ctx }, composerRef: { current: ComposerCtx }) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        const relevant = u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect) || e.is(setSelEffect)));
        this.decorations = relevant ? this.build(u.view) : this.decorations.map(u.changes);
      }
      build(view: EditorView): DecorationSet {
        const ctx = ctxRef.current;
        const decos: Range<Decoration>[] = [];
        const byLine: Record<number, DecoratedThread[]> = {};
        for (const t of ctx.threads) {
          const l = t.located?.endLine ?? t.anchor.endLine;
          if (l > 0) (byLine[l] ??= []).push(t);
        }
        for (const [ln, ts] of Object.entries(byLine)) {
          const n = Number(ln);
          if (n < 1 || n > view.state.doc.lines) continue;
          decos.push(Decoration.widget({ widget: new ThreadWidget(ts, ctx), side: 1 }).range(view.state.doc.line(n).to));
        }
        const sel = composerRef.current.sel;
        if (sel && sel.end >= 1 && sel.end <= view.state.doc.lines) {
          decos.push(Decoration.widget({ widget: new ComposerWidget(sel.end, composerRef), side: 1 }).range(view.state.doc.line(sel.end).to));
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
  const languageComp = useRef(new Compartment()).current;
  const saveRef = useRef<() => void>(() => {});
  const dirtyChangeRef = useRef<() => void>(() => {});
  dirtyChangeRef.current = () => {
    setDirty(true);
    onEditingChange?.(true);
  };

  const fileName = file.path.split("/").pop();
  const composerLabel = sel ? `${fileName}:${sel.start}${sel.end !== sel.start ? `–${sel.end}` : ""}` : "";
  const composerRef = useRef<ComposerCtx>({ sel: null, submit: () => {}, cancel: () => {}, label: "" });
  composerRef.current = { sel, submit: submitComment, cancel: clearSel, label: composerLabel };

  // Build the editor once per file (CodePane is keyed by path in FileView).
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: file.content,
      extensions: [
        // The gutter's own click handler (reliable — unlike a content-level DOM
        // handler, which misses clicks on the gutter). Gives the clicked line.
        lineNumbers({
          domEventHandlers: {
            click: (view, block, event) => {
              const n = view.state.doc.lineAt(block.from).number;
              const shift = (event as MouseEvent).shiftKey;
              setSel((prev) =>
                shift && prev ? { start: Math.min(prev.start, n), end: Math.max(prev.end, n) } : { start: n, end: n },
              );
              return true;
            },
          },
        }),
        syntaxHighlighting(helmHighlight),
        selField,
        decorationsPlugin(ctxRef, composerRef),
        languageComp.of([]),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        keymap.of([{ key: "Mod-s", run: () => { saveRef.current(); return true; } }]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) dirtyChangeRef.current();
        }),
        editableComp.of(EditorView.editable.of(editable)),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
        EditorView.lineWrapping,
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    loadLanguage(file.path).then((ext) => {
      viewRef.current?.dispatch({ effects: languageComp.reconfigure(ext) });
    });
    return () => {
      view.destroy();
      viewRef.current = null;
      onEditingChange?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableComp.reconfigure(EditorView.editable.of(editable)) });
  }, [editable, editableComp]);

  // Sync external content changes when not dirty (the SSE refetch is paused while
  // editing; this covers non-editing refreshes and mode switches).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || dirty) return;
    if (file.content !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } });
    }
  }, [file.content, dirty]);

  // Selection drives both the highlight (selField) and the inline composer widget.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setSelEffect.of(sel) });
  }, [sel]);

  // Rebuild thread widgets when threads / active change.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshEffect.of(null) });
  }, [threads, activeThreadId]);

  saveRef.current = () => doSave();

  function clearSel() {
    setSel(null);
    viewRef.current?.dispatch({ effects: setSelEffect.of(null) });
  }

  async function submitComment(text: string) {
    if (!sel) return;
    const doc = viewRef.current?.state.doc.toString() ?? file.content;
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
    setDirty(false);
    onEditingChange?.(false);
    onSave(file.path, content);
  }

  return (
    <div className="code-view cm-host">
      <div className="cm-editor-host" ref={hostRef} />
      <div className="cm-subfooter">
        {editable ? (
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
        ) : (
          <div className="edit-bar">
            <span className="muted">
              {sel ? "commenting — the box is below the line · Esc to cancel" : `click a line number to comment${canEdit ? " · Edit to write" : ""}`}
            </span>
            <span className="spacer" />
            {canEdit && !sel && (
              <button className="btn small" onClick={startEdit} title="Edit this file (write-through)">
                Edit
              </button>
            )}
          </div>
        )}
      </div>
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
