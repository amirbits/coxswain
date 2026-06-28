import type { DecoratedThread } from "../types";
import { ThreadCard, type ThreadActions } from "./ThreadCard";

const ORDER: Record<string, number> = { open: 0, outdated: 1, resolved: 2 };

// The home for all review threads across views — the decision log as a
// byproduct of working (DESIGN.md §1).
export function ReviewPanel({
  threads,
  actions,
  activeThreadId,
  onFocus,
}: {
  threads: DecoratedThread[];
  actions: ThreadActions;
  activeThreadId: string | null;
  onFocus: (id: string) => void;
}) {
  const sorted = [...threads].sort(
    (a, b) => ORDER[a.effectiveStatus] - ORDER[b.effectiveStatus],
  );
  const open = threads.filter((t) => t.effectiveStatus === "open").length;
  const outdated = threads.filter((t) => t.effectiveStatus === "outdated").length;

  return (
    <aside className="review-panel">
      <div className="panel-head">
        <h2>Review</h2>
        <span className="counts">
          {open} open{outdated ? ` · ${outdated} outdated` : ""}
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">
          <p>No comments yet.</p>
          <p className="muted">
            Select diff lines or intent text to leave one. Your agent reads them
            from <code>.reviews/</code>.
          </p>
        </div>
      ) : (
        <div className="thread-list">
          {sorted.map((t) => (
            <ThreadCard
              key={t.id}
              thread={t}
              actions={actions}
              active={t.id === activeThreadId}
              onFocus={() => onFocus(t.id)}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
