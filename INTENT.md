# Helm — Intent

> The single source of truth for *what this project is trying to be*.
> Edit this file to change the project's intent. Comment on it to question or refine it.

## What Helm is

A local-first **command-and-control workspace for agentic software work**. You `cd`
into any git repo, run one binary, and Helm serves a localhost web UI that shows the
project through several **views** — its intent (this file), its files, their diffs, its
git/source-control state, and an embedded terminal — all projected from one source of
truth: the git working tree itself.

Every view is **reviewable**: you can comment on a region like in a Google Doc or a PR
review, and an agent can read those comments, reply, and revise the files. Review
happens *before* the work is accepted — and acceptance is just `git commit` / push / merge.

## Why it exists

Most code is now produced by agents, which creates three failures:

1. **Blind acceptance** — humans rubber-stamp agent diffs; there is no forced review point.
2. **Fragmentation** — spec, code, history, and the agent live in four different tools.
3. **Lost context** — the agent cannot see the whole picture because it is scattered.

Helm makes the *repo* the unit of work, viewed through lenses that are all projections of
one truth, with review and the decision log as a **byproduct** of working.

## Invariants (do not break)

- The git working tree is the **only** source of truth. No parallel state store.
- Work is **reviewable before it's accepted**: comments and suggestions land on the
  working tree, you review them, and accepting is a commit / push / merge.
- Every capability is a deterministic typed function first; the LLM only routes to it.
- All steering flows through this surface (comments-as-files the agent reads), never
  through side channels the views cannot observe.

## Scope right now

Helm **watches** the filesystem and git and renders live — the agent edits files (in
its own terminal, or Helm's embedded one) and the UI repaints with no refresh. You
steer by leaving review comments; the agent reads `.reviews/`, edits files, replies.

- **Explorer + file view** — browse the project and read any file as-is (markdown
  rendered; code syntax-highlighted). Reviewable.
- **Diff view** — the selected file's diff, or a continuous "All changes" view, in four
  modes: working tree, staged (index), vs a branch (merge-request style), or vs a
  commit/tag — with word-level highlighting. Reviewable.
- **Source control** — branch, ahead/behind vs origin, fetch, the working tree grouped
  staged/unstaged/untracked, stashes, worktrees, remotes.
- **Comments** — select a region in any view; the thread persists as a file under
  `.reviews/` and rides the file's content across every lens.
- **Terminal** — a real shell (or your agent) embedded as a tab, rooted at the repo.
- **Command palette** (⌘K) over the function registry.

Still deferred: mutating git from the UI (stage / commit / stash / switch — they need
guardrails) and multi-workspace `git worktree` orchestration.

## Agents steer through the surface, not around it

Steering must flow through the surface, or the decision log becomes fiction. So an
agent gets a small CLI — `helm <verb>` — that is the *same* function registry the UI
uses, just a different front door (no new protocol, no daemon). An agent can:

- **orient** — `helm context` / `helm comments`: read the intent, the diff, and the open threads;
- **respond** — `helm reply <id>`: answer a thread;
- **propose** — `helm suggest <id>`: offer a non-destructive edit you Apply with one click.

All of it is reading and writing the same files (`.reviews/`, the working tree) the
views are projected from. A **suggested edit** is a proposed `base → newText`
replacement that lives in the comment thread; applying it write-throughs to the file.
Like everything the agent does, it lands on the working tree to be reviewed — you accept by committing.
