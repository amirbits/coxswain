// Shared types. v2 model (DESIGN.md §12): comments anchor to file *content*, so
// one thread renders in every lens (file view, any diff, the panel). The old
// per-view anchor (intent quote / diff lines) is read via a compat shim in
// store.ts and normalized to this shape.

export type Author = "human" | "agent";
export type ThreadStatus = "open" | "resolved";
export type EffectiveStatus = ThreadStatus | "outdated";

// A comment anchors to a file + a line hint into the *current* file. `context`
// (on the thread) is the exact anchored text; drift + locating are content-based,
// the line numbers are hints for disambiguation and scroll.
export type Anchor = {
  path: string; // repo-relative, e.g. "INTENT.md", "src/x.ts"
  startLine: number; // 1-based hint into the current file (0 if unknown)
  endLine: number;
};

export type SuggestionStatus = "proposed" | "applied" | "dismissed";
export type Suggestion = { base: string; newText: string; status: SuggestionStatus };

export type Message = {
  author: Author;
  body: string;
  ts: string;
  suggestion?: Suggestion;
};

export type Thread = {
  id: string;
  anchor: Anchor;
  status: ThreadStatus;
  thread: Message[];
  context?: string;
};

// Where the context currently sits in the file (for inline highlight); null when
// the content has drifted away (→ outdated).
export type Located = { startLine: number; endLine: number } | null;

export type DecoratedThread = Thread & {
  outdated: boolean;
  effectiveStatus: EffectiveStatus;
  located: Located;
};

// Files & diff modes -------------------------------------------------------

export type FileKind = "markdown" | "text" | "binary";
export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | null;

// A diff is diff(base → target). The three submodes are presets:
//  working → HEAD vs working tree (uncommitted, incl. untracked)
//  branch  → merge-base(ref, HEAD)…HEAD  (merge-request style, three-dot)
//  ref     → ref..HEAD                    (vs a commit or tag, two-dot)
export type DiffMode = { kind: "working" | "branch" | "ref"; ref?: string | null };

export type TreeEntry = {
  path: string;
  status: ChangeStatus; // change in the active mode
  open: number; // open comment count
  outdated: number;
};

export type RepoInfo = {
  root: string;
  name: string;
  branch: string;
  head: string | null;
  refs: { branches: string[]; tags: string[] };
};

export type Workspace = {
  repo: RepoInfo;
  mode: DiffMode;
  tree: TreeEntry[];
  threads: DecoratedThread[];
};

export type FilePayload = {
  path: string;
  exists: boolean;
  kind: FileKind;
  content: string;
  diff: string; // per-file diff for the active mode ("" if none)
  status: ChangeStatus;
};

export type DiffPayload = { raw: string; mode: DiffMode; head: string | null };
export type IntentPayload = { content: string; exists: boolean; path: string };

export type RepoStatusFile = { path: string; index: string; worktree: string };
export type RepoStatus = {
  branch: string;
  head: string | null;
  ahead: number;
  behind: number;
  files: RepoStatusFile[];
};
