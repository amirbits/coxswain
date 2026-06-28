import { useState, type KeyboardEvent } from "react";

// Shared comment composer (new threads and replies). ⌘/Ctrl+Enter submits,
// Escape cancels.
export function Composer({
  onSubmit,
  onCancel,
  placeholder = "Add a comment…",
  submitLabel = "Comment",
}: {
  onSubmit: (text: string) => Promise<void> | void;
  onCancel?: () => void;
  placeholder?: string;
  submitLabel?: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setText("");
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="composer">
      <textarea
        className="composer-input"
        autoFocus
        rows={3}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-actions">
        <span className="composer-hint">⌘⏎</span>
        <span className="spacer" />
        {onCancel && (
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button className="btn primary" onClick={submit} disabled={!text.trim() || busy}>
          {busy ? "…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
