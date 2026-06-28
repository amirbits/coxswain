# Helm — Intent

> The single source of truth for *what this project is trying to be*.
> Edit this file to change the project's intent. Comment on it to question or refine it.

## What Helm is

A local-first **command-and-control workspace for agentic software work**. You `cd`
into any git repo, run one binary, and Helm serves a localhost web UI that shows the
project through several **views** — its intent (this file) and its diff — all projected
from one source of truth: the git working tree itself.

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
- The agent edits the working tree and **never commits**. The human commits — and that
  act *is* acceptance.
- Every capability is a deterministic typed function first; the LLM only routes to it.
- All steering flows through this surface (comments-as-files the agent reads), never
  through side channels the views cannot observe.

## Scope right now (Phase 1 — WATCH)

Helm **watches** the filesystem and git and renders live. It does **not** drive your
agent yet. You run Claude Code yourself; you steer it by leaving review comments; the
agent reads `.reviews/`, edits files, and the UI repaints live.

- **Intent view** — renders this file. Reviewable.
- **Diff view** — renders the uncommitted diff (or `base...HEAD`). Reviewable.
- **Comments** — select a region, leave a thread; it persists as a file under `.reviews/`.

Driving the agent, a code-file view, multi-workspace `git worktree` orchestration, and
a command palette are designed but deliberately deferred.
