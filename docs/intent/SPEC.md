# Helm — Spec & Intent

> This is the project's intent: edit it to change what Helm should be. Helm pins it in
> the explorer; comment on a line to question or refine it.

## What it is

A local-first workspace for agentic software work. One binary over a git repo serves a
localhost UI whose views are all projections of one source of truth — the git working
tree — and every view is reviewable.

## Invariants

- The git working tree is the only source of truth. No parallel state store.
- Work is reviewable before it's accepted. Acceptance is a commit / merge; Helm does not
  restrict who commits.
- Every capability is a deterministic typed function (the registry) before any LLM
  routes to it.
- Steering flows through the surface (comments-as-files), not side channels the views
  can't see.

## Views (all reviewable)

- **Explorer** — file tree with change + comment badges; the intent doc pinned on top.
- **File** — the file as-is: markdown rendered, code syntax-highlighted.
- **Diff** — per-file or a continuous "All changes" view, word-level highlighted, in four
  modes: `working` (HEAD vs tree), `staged` (HEAD vs index), `branch` (`ref...HEAD` —
  your changes since the fork), `ref` (`ref..HEAD` — vs a commit/tag/remote branch).
- **Source control** — branch, ahead/behind vs origin, fetch, staged/unstaged/untracked,
  stashes, worktrees, remotes. Read-only plus fetch; mutations are deferred.
- **Review** — the open comment threads.
- **Terminal** — a real shell (or your agent) in a tab, rooted at the repo.

## Comments & suggestions

A comment anchors to **file content** — `{ path, startLine, endLine }` plus the captured
text — so one thread shows in every lens and goes **outdated** when that text is gone.
Threads are `.reviews/<id>.json` (local by default). A **suggestion** is a single-region
`base → newText` on a thread; Apply replaces the unique `base` in the file and refuses on
drift or ambiguity. The agent reads `.reviews/`, edits the tree, and appends replies.

## Front doors

One function registry, reached four ways: the UI, `POST /api/call`, the `helm` CLI, and
(planned) a natural-language bar. State streams over SSE; the terminal over a WebSocket.

## Deferred

Mutating git from the UI (stage / commit / stash / switch — they need guardrails);
worktree switching; routing a comment straight to the agent.
