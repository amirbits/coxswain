import { useMemo } from "react";
import { parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import type { DecoratedThread, NewComment } from "../types";
import { FileDiff } from "./FileDiff";
import type { ThreadActions } from "./ThreadCard";

// The single-file Diff pane: parse the file's diff and render one FileDiff.
export function DiffView({
  path,
  diff,
  threads,
  actions,
  activeThreadId,
  onFocusThread,
  onAddComment,
}: {
  path: string;
  diff: string;
  threads: DecoratedThread[];
  actions: ThreadActions;
  activeThreadId: string | null;
  onFocusThread: (id: string) => void;
  onAddComment: (c: NewComment, text: string) => Promise<void>;
}) {
  const files = useMemo(() => {
    try {
      return parseDiff(diff || "");
    } catch {
      return [];
    }
  }, [diff]);

  if (files.length === 0) {
    return (
      <div className="empty big">
        <p>No changes to this file in this mode.</p>
        <p className="muted">Switch to the File view to read and comment on it as-is.</p>
      </div>
    );
  }

  return (
    <div className="diff-body">
      <FileDiff
        path={path}
        file={files[0]}
        threads={threads}
        actions={actions}
        activeThreadId={activeThreadId}
        onFocusThread={onFocusThread}
        onAddComment={onAddComment}
      />
    </div>
  );
}
