// Mirror of the server's wire types (server/types.ts). Kept as a hand copy
// rather than a shared package — the surface is small and the two tsconfigs are
// separate.

export type ViewName = "intent" | "diff" | "code";
export type Author = "human" | "agent";
export type ThreadStatus = "open" | "resolved";
export type EffectiveStatus = ThreadStatus | "outdated";

export type LineRange = {
  kind: "lines";
  path: string;
  side?: "old" | "new";
  startLine: number;
  endLine: number;
};

export type TextAnchor = {
  kind: "text";
  quote: string;
  prefix?: string;
  suffix?: string;
};

export type Locator = LineRange | TextAnchor;

export type Anchor = {
  view: ViewName;
  version: string;
  locator: Locator;
};

export type Message = { author: Author; body: string; ts: string };

export type DecoratedThread = {
  id: string;
  anchor: Anchor;
  status: ThreadStatus;
  thread: Message[];
  context?: string;
  outdated: boolean;
  effectiveStatus: EffectiveStatus;
};

export type DiffPayload = {
  raw: string;
  base: string | null;
  mode: "working" | "branch";
  head: string | null;
};

export type IntentPayload = { content: string; exists: boolean; path: string };

export type RepoStatusFile = { path: string; index: string; worktree: string };

export type RepoStatus = {
  branch: string;
  head: string | null;
  ahead: number;
  behind: number;
  files: RepoStatusFile[];
  isRepo: boolean;
};

export type AppState = {
  repoRoot: string;
  repoName: string;
  branch: string;
  head: string | null;
  status: RepoStatus;
  intent: IntentPayload;
  diff: DiffPayload;
  threads: DecoratedThread[];
};
