// Mirror of the server's v2 wire types (server/types.ts).

export type Author = "human" | "agent";
export type ThreadStatus = "open" | "resolved";
export type EffectiveStatus = ThreadStatus | "outdated";

export type Anchor = { path: string; startLine: number; endLine: number };

export type SuggestionStatus = "proposed" | "applied" | "dismissed";
export type Suggestion = { base: string; newText: string; status: SuggestionStatus };

export type Message = { author: Author; body: string; ts: string; suggestion?: Suggestion };

export type Located = { startLine: number; endLine: number } | null;

export type DecoratedThread = {
  id: string;
  anchor: Anchor;
  status: ThreadStatus;
  thread: Message[];
  context?: string;
  outdated: boolean;
  effectiveStatus: EffectiveStatus;
  located: Located;
};

export type FileKind = "markdown" | "text" | "binary";
export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | null;

export type DiffMode = { kind: "working" | "staged" | "branch" | "ref"; ref?: string | null };

export type TreeEntry = { path: string; status: ChangeStatus; open: number; outdated: number };

export type RepoInfo = {
  root: string;
  name: string;
  intentPath: string;
  branch: string;
  head: string | null;
  upstream: string | null;
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
  diff: string;
  status: ChangeStatus;
};

// What a view hands up when the human leaves a comment.
export type NewComment = { path: string; startLine: number; endLine: number; content: string };

// Source-control panel (Slice A).
export type RepoStatusFile = { path: string; index: string; worktree: string };
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
export type GitTopology = { worktrees: Worktree[]; remotes: Remote[]; remoteBranches: string[] };
