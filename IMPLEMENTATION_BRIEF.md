# Implementation Brief — Project Command & Control (working name: **Helm**)

> Hand this to Claude Code. It is the *what and in what order*. The companion
> `DESIGN.md` is the *how and why*. Read both before writing code.

---

## 1. One-paragraph pitch

A local-first command-and-control workspace for agentic software work. You `cd`
into any git repo, run one binary, and it serves a localhost web UI that shows
the project through several **views** — its intent (spec), its diff, its code —
all projected from a single source of truth: the git working tree itself. Every
view is **reviewable**: you can comment on a region like in a Google Doc / PR
review, and an agent can read those comments, reply, and revise the files. You
stop blindly accepting agent output because review happens *before* the work is
accepted — and acceptance is just `git commit` / push / merge.

## 2. The decisions already made (do not relitigate in v1)

1. **Source of truth = the git working tree + git itself.** No separate
   database of project state. Intent is a markdown file. Code is the files.
   History/diff is git. Comments are files in the repo. Editing a view edits a
   file; the agent operates on the same file. This is what makes the views
   genuinely bound to one truth instead of drifting copies.

2. **Acceptance = git, not a UI button.** The agent works in the **working tree**; you
   review the diff and the threads, and acceptance is a `git commit` / push / merge.
   The goal is **reviewability before acceptance** — no more rubber-stamping — not
   restricting who runs the commit.

3. **Reviewable is a real, enforceable contract** (an *interaction* contract,
   not a correctness one): a view implements Reviewable if it can render
   addressable regions, attach comment threads to them, and accept a
   write-through edit. See `DESIGN.md §4`.

4. **Everything is AI-able via one function registry.** Every capability is a
   deterministic typed function first. The LLM never *executes* anything
   programmable; it only *routes* natural language to those functions and fills
   the fuzzy bits (comment prose, spec edits). Palette, NL bar, and the agent
   all call the same registry. See `DESIGN.md §5`.

5. **Phase 1 = WATCH, not DRIVE.** v1 does **not** spawn or embed Claude Code.
   It watches the filesystem + git and renders live; you run your own Claude
   Code in your own terminal. Driving CC (embedded terminal, pty) is Phase 2,
   built only after the watch loop proves sticky. This removes the single
   riskiest, most time-consuming piece of plumbing from the validation build.
   See `DESIGN.md §6`.

## 3. Stack

- **Frontend:** React + Vite + TypeScript. Off-the-shelf diff renderer
  (e.g. `react-diff-view`). No state library, no design system for v1.
- **Server:** **Bun + TypeScript**, compiled to a single binary
  (`bun build --compile`). Rationale: one language across the whole stack,
  trivial subprocess/filesystem APIs, and it still satisfies the
  "single binary, run from any folder" requirement.
  - *Alternatives considered:* **Go** (also single-binary, excellent subprocess
    story — pick this if you'd rather not run JS server-side). **Rust** —
    deferred; it's the right *rewrite-once-it-works* target, but its costs
    (compile times, async ceremony, subprocess pain) tax a fast validation
    build for zero benefit at this size. Do not start in Rust unless the
    explicit goal is "I want to build it in Rust" rather than "validate the
    loop fast."
- **Platform:** macOS first. Localhost only, single user, **no auth, no
  hosting.** Keep it local-first as long as possible.

## 4. MVP scope (the 2-day validation build)

**In:**
- `cd <repo> && helm` → starts server, opens browser at `localhost:<port>`,
  scoped to that repo.
- **Intent view:** renders `INTENT.md`. Reviewable.
- **Diff view:** renders `git diff` (uncommitted) or `git diff <base>...HEAD`
  (PR-style). Reviewable. *This is the most important view — build it well.*
- Commenting: select a region in either view → create a thread → persists as a
  file under `.reviews/`.
- Live update: a filesystem/git change re-renders the affected view (SSE or
  WebSocket push).
- Agent loop (manual wiring): you run Claude Code separately and tell it
  "address the open review comments"; it reads `.reviews/`, edits files,
  optionally appends replies; the UI reflects changes live.

**Explicitly OUT of v1 (already designed for, build later):**
- Driving / embedding Claude Code (terminal emulator, pty) — Phase 2.
- Multi-workspace management (`git worktree` orchestration) — Phase 2.
- Git graph / log visualization (plain `git log` text is enough if needed).
- Most of the command palette (only the handful of verbs you need).
- Code-file view (fast-follow after Intent + Diff prove out).

## 5. Build order

**Day 1 — server + truth plumbing**
1. Server skeleton: serve the built frontend + a JSON API.
2. Git integration via the `git` CLI: `status`, `diff` (working tree),
   `diff <base>...HEAD`, current branch.
3. Filesystem watcher over the working tree, `.git`, and `.reviews/`; push
   change events to the frontend (SSE).
4. Read `INTENT.md`; read/write `.reviews/*.json` (the comment store).

**Day 2 — frontend + Reviewable**
1. React shell with two panels: Intent and Diff.
2. Render the diff (off-the-shelf component) and the intent markdown.
3. Reviewable: region selection → create thread → POST to API → file written;
   render existing threads anchored to their regions; mark **outdated** when the
   anchored content has drifted.
4. Wire live updates so an external file change (i.e. your Claude Code editing
   files) repaints the views.

## 6. Definition of done & the real test

**Done when:**
- One command in any repo gives a live browser view of intent + diff.
- You can comment on a diff line and an intent line; the comment survives as a
  file in the repo.
- Claude Code, run separately, can read those comments, edit files, and the UI
  updates live without a refresh.

**The actual success metric is behavioral, not functional:** on day two, when
you're tired and the raw terminal is right there, *do you keep steering through
this surface?* If you defect to the terminal, the channel isn't sticky yet —
and that, not any bug, is the most important result to act on.

## 7. Hard invariants (regressions here break the product, not just the build)

- The working tree is the only source of truth; never cache project state in a
  parallel store that can drift.
- Work is reviewable before it's accepted; acceptance is a commit / push / merge.
- Every capability exists as a deterministic function before any LLM touches it.
- If steering ever happens somewhere the views can't observe, the decision log
  becomes fiction — so all steering must flow through the surface (in Phase 1,
  that means comments-as-files the agent reads, not ad-hoc terminal chatter).
