import { useMemo, useState } from "react";
import { parseDiff } from "react-diff-view";
import type { FileData } from "react-diff-view";
import "react-diff-view/style/index.css";
import type { DecoratedThread, DiffMode, NewComment } from "../types";
import { countChanges, FileDiff, pathOfFile } from "./FileDiff";
import type { ThreadActions } from "./ThreadCard";

// The continuous "All changes" view: every affected file's diff in one scroll,
// for the active mode. Each file is a collapsible section (auto-collapsed when
// large), and Reviewable exactly like the single-file diff.
type Shared = {
  threads: DecoratedThread[];
  actions: ThreadActions;
  activeThreadId: string | null;
  onFocusThread: (id: string) => void;
  onAddComment: (c: NewComment, text: string) => Promise<void>;
};

export function ChangesView({ raw, mode, ...shared }: Shared & { raw: string; mode: DiffMode }) {
  const files = useMemo(() => {
    try {
      return parseDiff(raw || "");
    } catch {
      return [];
    }
  }, [raw]);

  const label = mode.kind === "working" ? "working tree" : mode.kind === "branch" ? `${mode.ref}…HEAD` : `${mode.ref}..HEAD`;

  if (files.length === 0) {
    return (
      <div className="empty big">
        <p>No changes in this mode.</p>
        <p className="muted">Nothing differs from {label}.</p>
      </div>
    );
  }

  return (
    <div className="changes-view">
      <div className="changes-head">
        {files.length} file{files.length > 1 ? "s" : ""} changed <span className="muted">· {label}</span>
      </div>
      {files.map((file, i) => (
        <ChangesSection key={`${i}:${file.oldPath}:${file.newPath}`} file={file} {...shared} />
      ))}
    </div>
  );
}

function ChangesSection({ file, threads, ...rest }: Shared & { file: FileData }) {
  const path = pathOfFile(file);
  const { adds, dels } = countChanges(file);
  const [open, setOpen] = useState(adds + dels <= 400);
  const fileThreads = threads.filter((t) => t.anchor.path === path);
  const openCount = fileThreads.filter((t) => t.effectiveStatus !== "resolved").length;

  return (
    <div className="changes-file">
      <div className="cf-head" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className={`ftype ${file.type}`}>{file.type}</span>
        <span className="fpath">{path}</span>
        {openCount > 0 && <span className="cbadge">{openCount}</span>}
        <span className="spacer" />
        <span className="fstat">
          <span className="add">+{adds}</span> <span className="del">−{dels}</span>
        </span>
      </div>
      {open && (
        <div className="cf-body">
          <FileDiff path={path} file={file} threads={fileThreads} {...rest} />
        </div>
      )}
    </div>
  );
}
