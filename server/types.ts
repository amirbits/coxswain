// Shared types. v2 model (see docs/intent/SPEC.md): comments anchor to file *content*, so
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

// A diff is diff(base → target). The submodes are presets:
//  working → HEAD vs working tree (uncommitted, incl. untracked)
//  staged  → HEAD vs index (git diff --cached: what a commit would record)
//  branch  → merge-base(ref, HEAD)…HEAD  (merge-request style, three-dot)
//  ref     → ref..HEAD                    (vs a commit or tag, two-dot)
export type DiffMode = { kind: "working" | "staged" | "branch" | "ref"; ref?: string | null };

export type TreeEntry = {
  path: string;
  status: ChangeStatus; // change in the active mode
  open: number; // open comment count
  outdated: number;
};

export type RepoInfo = {
  root: string;
  name: string;
  scope: string; // repo-relative subdir the view is focused on ("" = whole repo)
  elsewhere: number; // working-tree changes outside the scope (0 when scope is "")
  intentPath: string; // repo-relative path of the pinned intent doc
  branch: string;
  head: string | null;
  upstream: string | null; // tracking branch, e.g. "origin/main"
  ahead: number;
  behind: number;
  refs: { branches: string[]; tags: string[]; remoteBranches: string[] };
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
  upstream: string | null;
  ahead: number;
  behind: number;
  files: RepoStatusFile[];
};

// Source-control panel (Slice A): working-tree status grouped for display, plus
// the repo's worktrees / remotes / remote branches (its topology). All read-only.
export type GitStatus = {
  branch: string;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: RepoStatusFile[];
  unstaged: RepoStatusFile[];
  untracked: RepoStatusFile[];
  stashCount: number;
};

export type Worktree = {
  path: string;
  head: string | null;
  branch: string | null;
  current: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
};

export type Remote = { name: string; fetchUrl: string | null };

export type GitTopology = {
  worktrees: Worktree[];
  remotes: Remote[];
  remoteBranches: string[];
};
