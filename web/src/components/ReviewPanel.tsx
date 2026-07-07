import { useState } from "react";
import type { DecoratedThread } from "../types";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

const ORDER: Record<string, number> = { open: 0, outdated: 1, resolved: 2 };

// The home for all review threads across views — the decision log as a
// byproduct of working (see docs/intent/SPEC.md). Resolved threads are hidden by default
// (they're archived, not erased) and revealed with the header toggle.
export function ReviewPanel({
  threads,
  actions,
  activeThreadId,
  onFocus,
  showResolved,
  onToggleResolved,
}: {
  threads: DecoratedThread[];
  actions: ThreadActions;
  activeThreadId: string | null;
  onFocus: (id: string) => void;
  showResolved: boolean;
  onToggleResolved: () => void;
}) {
  const open = threads.filter((t) => t.effectiveStatus === "open").length;
  const outdated = threads.filter((t) => t.effectiveStatus === "outdated").length;
  const resolved = threads.filter((t) => t.effectiveStatus === "resolved").length;

  const sorted = [...threads].sort((a, b) => ORDER[a.effectiveStatus] - ORDER[b.effectiveStatus]);
  const visible = showResolved ? sorted : sorted.filter((t) => t.effectiveStatus !== "resolved");

  // Panel-wide collapse toggle. Each ThreadCard follows this default but keeps a
  // local override until the next panel-wide flip.
  const [allCollapsed, setAllCollapsed] = useState(false);

  return (
    <aside className="review-panel">
      <div className="panel-head">
        <h2>Review</h2>
        <span className="counts">
          {open} open{outdated ? ` · ${outdated} outdated` : ""}
        </span>
        <span className="spacer" />
        {visible.length > 0 && (
          <button className="btn small ghost" onClick={() => setAllCollapsed((c) => !c)} title={allCollapsed ? "Expand all threads" : "Collapse all threads"}>
            {allCollapsed ? "expand all" : "collapse all"}
          </button>
        )}
        {resolved > 0 && (
          <button className="btn small ghost" onClick={onToggleResolved}>
            {showResolved ? "hide resolved" : `show resolved (${resolved})`}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          {threads.length === 0 ? (
            <>
              <p>No comments yet.</p>
              <p className="muted">
                Select diff lines or intent text to leave one. Your agent reads them from{" "}
                <code>.reviews/</code>.
              </p>
            </>
          ) : (
            <p className="muted">
              No open comments{resolved ? ` — ${resolved} resolved hidden` : ""}.
            </p>
          )}
        </div>
      ) : (
        <div className="thread-list">
          {visible.map((t) => (
            <ThreadCard
              key={t.id}
              thread={t}
              actions={actions}
              active={t.id === activeThreadId}
              onFocus={() => onFocus(t.id)}
              defaultCollapsed={allCollapsed}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
