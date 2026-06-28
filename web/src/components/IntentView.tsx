import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { IntentPayload, TextAnchor } from "../types";
import { truncate } from "../util";
import { Composer } from "./Composer";

// Intent view: renders INTENT.md (Reviewable). Selecting text anchors a comment
// by quote (content-based; markdown has no stable line identity). "Edit" is the
// write-through: editing the view edits the file (DESIGN.md §1, §4).
export function IntentView({
  intent,
  threadCount,
  onAddComment,
  onWriteIntent,
}: {
  intent: IntentPayload;
  threadCount: number;
  onAddComment: (locator: TextAnchor, context: string, text: string) => Promise<void>;
  onWriteIntent: (content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(intent.content);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<{ quote: string; prefix?: string } | null>(null);
  const [composing, setComposing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) setDraft(intent.content);
  }, [intent.content, editing]);

  function captureSelection() {
    if (composing) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !bodyRef.current) {
      setSelection(null);
      return;
    }
    const quote = sel.toString().trim();
    const node = sel.anchorNode;
    if (!quote || !node || !bodyRef.current.contains(node)) {
      setSelection(null);
      return;
    }
    const full = bodyRef.current.textContent ?? "";
    const idx = full.indexOf(quote);
    const prefix = idx > 0 ? full.slice(Math.max(0, idx - 24), idx) : undefined;
    setSelection({ quote, prefix });
  }

  async function save() {
    setSaving(true);
    try {
      await onWriteIntent(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <section className="view intent-view">
        <header className="view-head">
          <h1>Intent</h1>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </header>
        <textarea
          className="intent-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
      </section>
    );
  }

  return (
    <section className="view intent-view">
      <header className="view-head">
        <h1>Intent</h1>
        {threadCount > 0 && (
          <span className="pill">
            {threadCount} comment{threadCount > 1 ? "s" : ""}
          </span>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={() => setEditing(true)}>
          Edit
        </button>
      </header>

      <div className="intent-body markdown" ref={bodyRef} onMouseUp={captureSelection}>
        {intent.exists ? (
          <Markdown remarkPlugins={[remarkGfm]}>{intent.content}</Markdown>
        ) : (
          <p className="muted">
            No <code>INTENT.md</code> yet. Click <strong>Edit</strong> to capture what this
            project is trying to be.
          </p>
        )}
      </div>

      {selection && !composing && (
        <div className="selection-bar">
          <span className="muted">“{truncate(selection.quote, 56)}”</span>
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
          <div className="composer-where">On “{truncate(selection.quote, 48)}”</div>
          <Composer
            placeholder="Comment on the selected text…"
            onSubmit={async (text) => {
              await onAddComment(
                { kind: "text", quote: selection.quote, prefix: selection.prefix },
                selection.quote,
                text,
              );
              setComposing(false);
              setSelection(null);
              window.getSelection()?.removeAllRanges();
            }}
            onCancel={() => setComposing(false)}
          />
        </div>
      )}
    </section>
  );
}
