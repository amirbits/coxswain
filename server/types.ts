// Shared types for Helm's server. These mirror the Reviewable contract and the
// source-of-truth model described in DESIGN.md §3–4.

export type ViewName = "intent" | "diff" | "code";
export type Author = "human" | "agent";

// Stored status of a thread. "outdated" is *derived* at read time (see review.ts),
// never persisted — persisting it would churn files on every drift.
export type ThreadStatus = "open" | "resolved";
export type EffectiveStatus = ThreadStatus | "outdated";

// Locators -------------------------------------------------------------------

// Line-based anchor, used by the diff (and later, code) views.
export type LineRange = {
  kind: "lines";
  path: string;
  side?: "old" | "new"; // which side of the diff the lines belong to (default "new")
  startLine: number;
  endLine: number;
};

// Content-based anchor, used by the intent (markdown) view. Markdown has no
// stable line identity across edits, so we anchor by quoted text + context.
export type TextAnchor = {
  kind: "text";
  quote: string;
  prefix?: string;
  suffix?: string;
};

export type Locator = LineRange | TextAnchor;

export type Anchor = {
  view: ViewName;
  version: string; // commit SHA, or "working" for the live tree
  locator: Locator;
};

// Threads --------------------------------------------------------------------

export type Message = {
  author: Author;
  body: string;
  ts: string; // ISO 8601
};

export type Thread = {
  id: string;
  anchor: Anchor;
  status: ThreadStatus;
  thread: Message[];
  // The text that was anchored at creation time. Used purely for drift
  // detection; it is not part of the anchor's identity.
  context?: string;
};

export type DecoratedThread = Thread & {
  outdated: boolean;
  effectiveStatus: EffectiveStatus;
};

// Payloads -------------------------------------------------------------------

export type DiffPayload = {
  raw: string; // unified diff text (empty string === no changes)
  base: string | null; // base ref for PR-style diff, else null (working tree)
  mode: "working" | "branch";
  head: string | null; // current HEAD sha (null when the repo has no commits)
};

export type IntentPayload = {
  content: string;
  exists: boolean;
  path: string; // "INTENT.md"
};

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
