# Design Doc — Project Command & Control (Helm)

Status: living design. Phases 1–2 have shipped (watch loop, file-centric views, embedded
terminal) plus a read-only git source-control surface. **§12–§13 describe the current
model**; §1–§11 keep the original v1 reasoning, annotated where it has moved on.
Audience: the implementing agent + the author. Companion to `IMPLEMENTATION_BRIEF.md`.

---

## 1. Problem & thesis

Most code is now produced by agents. Three failures follow:

1. **Blind acceptance.** Humans rubber-stamp agent plans and diffs. There's no
   forced collaboration point, no decision log, no conversation log.
2. **Fragmentation.** Spec lives in Confluence, code in GitLab + your laptop,
   the code view in an editor, the agent in a terminal, the running result
   somewhere else again. Nobody has one legible view of the project.
3. **Lost context & scope.** The agent lacks the bigger picture because the
   picture is scattered across tools it can't see at once.

**Thesis:** make the *project* (the repo) the unit of work, viewed through
multiple **lenses** that are all projections of one source of truth, with an
always-present agent that reads and writes that same truth. Steering, review,
and the decision log all happen in one surface, so the log is a *byproduct* of
working rather than a document someone maintains (and lets rot).

### What this is and isn't

- It **is** a governance + memory + overview layer for agentic work, plus a
  review loop that forces collaboration before acceptance.
- It is **not** a correctness oracle. A review log does not make an
  implementation correct; you still verify the work. The product's leverage is
  catching *wrong intent early* (at the decision level) instead of *wrong
  implementation late*. Do not let the UI imply it validates correctness.

### What we deliberately are NOT building

The original concept included lossless, bidirectional projection between intent
and code (edit the spec → code updates → code changes flow back up to the spec).
That's the model-driven / "intent as source, code as projection" dream, and it
fails for a structural reason: the intent→implementation mapping is **lossy and
one-to-many**, so the upward direction requires a classifier that decides which
code changes are "intent-bearing." Get it slightly wrong and you reproduce
exactly the desync you set out to kill, behind a UI that promises you can't.

We sidestep this entirely by making the source of truth **files**, not an
abstract model. Views are read-projections with **write-through to files**.
"Editing a view edits the project" is then literally true — no inversion, no
classifier, no research problem.

## 2. Architecture overview

```
  Browser (React + Vite, localhost) — panes & files open as tabs
    Explorer · File view · Diff view (working / staged / branch / ref)
    · Source Control · Review panel · Terminal · Command palette (⌘K)
    Files & diffs are Reviewable.
        ▲  │   SSE (state) + /terminal WebSocket (live)        │  ▲   JSON API / registry calls
        │  ▼                                                   ▼  │
  Local server (Bun + TS, single binary) — no authoritative state
    · function registry (the only way to act)
    · git CLI adapter (status / diff / log / branch / fetch / worktree / remote)
    · file store (INTENT.md, .reviews/) + filesystem watcher → SSE
    · PTY bridge → embedded terminal (xterm.js over a WebSocket)
        │ reads / writes                              ▲ watches
        ▼                                             │
  SOURCE OF TRUTH — the git working tree
    · INTENT.md (intent)              · source files (code)
    · .git (history / diff / branch)  · .reviews/*.json (comment threads)
        ▲ reads comments / writes files
        │
  Claude Code — your own terminal, or Helm's embedded terminal (a tab);
  reads .reviews/ and edits the working tree
```

The server holds **no authoritative state of its own.** It is a projector and a
write-through layer over git + the filesystem. If the server dies, nothing is
lost; restart and re-derive everything from the working tree. This is the
property that keeps the views genuinely bound to one truth.

## 3. The source-of-truth model

| Truth | Storage | Read via | Written via |
|---|---|---|---|
| Intent / spec | `INTENT.md` (later `.intent/` for multi-doc) | file read | view write-through / agent |
| Code | source files | file read | agent / editor |
| Diff & history | `.git` | `git` CLI | git commits |
| Comments / review | `.reviews/<id>.json` | file read | API write / agent append |

**Decision — comments are plain files in the repo tree; sharing them is opt-in.**
`.reviews/<id>.json` lets the agent read threads as plain files with zero extra API.
Whether they're *committed* is the user's choice: by default `.reviews/` is
**gitignore-able and kept local** (so an agent's review threads never pollute the target
repo's history), and you opt in to committing them where you want the decision log to
travel with the code. (v1 leaned toward committing them; the current default is local —
see §13.) The rejected alternative — a sidecar store outside git — gives cleaner history
but reintroduces a database + API the agent must be taught to read.

## 4. The Reviewable contract

A view satisfies **Reviewable** if it implements:

```ts
interface Reviewable {
  // Regions a comment can attach to (lines, text spans, etc.)
  getRegions(): Region[];
  // Existing threads, with their anchors resolved against current content
  listThreads(): Thread[];
  // Create a thread anchored to a region
  attachThread(anchor: Anchor, body: string, author: Author): Thread;
  // Write-through: apply a suggested edit to the underlying file
  applySuggestion(anchor: Anchor, newContent: string): void;
}
```

### Anchoring (the one genuinely fiddly part)

Every comment anchors to **file content** (a path + line hints + the exact captured
text), and is shown as **outdated** when that text can no longer be found in the file.
Content-based anchoring (not version+line coordinates) is what lets one thread render in
every lens — the file view and any diff mode — and survive edits. (v1 started with the
per-view `{ view, version, locator }` anchor below; §12 records the generalization to
content anchors, which is what ships today.)

```ts
// current (§12):
type Anchor = { path: string; startLine: number; endLine: number };
// + `context` on the thread: the exact anchored text, used to re-locate / mark outdated.
```

- **Code:** the anchor is `{ path, startLine, endLine }` plus a captured `context`
  snippet; on drift (the snippet no longer matches near the line hints) mark the thread
  **outdated** rather than silently moving it.
- **Markdown (e.g. `INTENT.md`):** same shape, but lean entirely on the `context` text —
  markdown has no stable line identity across edits, so the snippet *is* the anchor and
  large rewrites orphan comments → outdated.

> The contract's real substance is defining the `Anchor`/`Region` abstraction
> **once** and satisfying it differently per view. Implement it for **exactly
> two** views (intent + diff) before generalizing — two implementations is when
> the abstraction earns its keep; one is premature architecture.

### Thread file shape

```jsonc
// .reviews/<uuid>.json   (v2 — see §12)
{
  "id": "<uuid>",
  "anchor": { "path": "src/x.ts", "startLine": 40, "endLine": 44 },
  "status": "open",            // open | resolved  ("outdated" is derived, not stored)
  "context": "…the exact anchored text…",
  "thread": [
    { "author": "human", "body": "Why fetch inside the loop?", "ts": "..." },
    { "author": "agent", "body": "Refactored to batch; see new diff.", "ts": "..." }
  ]
}
```

The agent reads these files directly, appends replies, and edits the referenced
source — no special protocol needed beyond "read `.reviews/`, act, append."

## 5. AI-able: one function registry, several front doors

Every capability is a **deterministic typed function** registered once. The LLM
is confined to (a) routing natural language to a registered call with extracted
args, and (b) the irreducibly fuzzy work (writing comment prose, editing the
spec). Anything that can be programmed is programmed and unit-testable; the LLM
never executes it directly.

```ts
type Caller = "palette" | "nl" | "agent" | "cli";   // §11 adds the CLI

registry.register("workspace",      (a: { mode }) => Workspace);  // explorer + repo + threads
registry.register("file",           (a: { path, mode }) => FilePayload);
registry.register("showDiff",       (a: { mode }) => Diff);
registry.register("addComment",     (a: { path, startLine, endLine, text }) => Thread);
registry.register("replyComment",   (a: { id, text }) => Thread);
registry.register("suggestEdit",    (a: { id, newText, base? }) => Thread);
registry.register("applySuggestion",(a: { id }) => Result);
registry.register("gitStatus",      () => GitStatus);    // §13: status / ahead-behind / stash
registry.register("gitTopology",    () => GitTopology);  // worktrees / remotes
registry.register("gitFetch",       (a: { remote? }) => GitStatus);
// later: createWorkspace({ branch, origin }) — git-worktree multi-agent (Phase 3)
```

Front doors onto the one registry:
- **Command palette** (⌘K) — the verbs above, exposed as clickable commands. The
  palette's contents *are* the registry; nothing more.
- **NL bar** — "show me the diff against main" → LLM parses to
  `showDiff({ base: "main" })`. If the parse is ambiguous, it **asks**, it does
  not guess.
- **Agent** — calls the same functions programmatically.
- **`helm` CLI** — the same calls, one-shot from the terminal, no server required (§11).

This is what makes "AI-able" reliable instead of flaky: the deterministic 90%
never depends on the model.

## 6. The critical seam — Watch vs Drive

This single choice shapes the whole build. There are two architectures:

### Phase 1 — WATCH (build this first)
The server only **observes**: it watches the working tree, `.git`, and
`.reviews/` and renders live. The user runs their own Claude Code in their own
terminal. The loop:

1. Human drops a review comment in the UI → written to `.reviews/`.
2. Human tells their Claude Code: "address the open review comments."
3. CC reads `.reviews/`, edits files, optionally appends replies.
4. Filesystem watcher fires → the UI repaints intent/diff live.

Because truth is the filesystem, the server sees everything CC does **without
driving it.** This validates ~the entire thesis with near-zero subprocess code
and zero pty/terminal headaches — which is precisely why it's first.

### Phase 2 — DRIVE (shipped: the embedded terminal)
The watch loop proved sticky, so Phase 2 landed: Helm embeds a real terminal
(`xterm.js` ↔ a Bun-native pty over a WebSocket, POSIX-only) as a tab, rooted at the
repo, so you can run Claude Code *inside* the surface. Still open: routing a comment
straight to that agent (a "send to agent" action) so the human never copy-pastes
"address the open comments." See §13.

**The rule that governs both phases:** if steering happens anywhere the views
can't observe, the decision log is fiction. In Phase 1 that means steering must
go through comments-as-files the agent reads — not ad-hoc terminal chatter that
the surface never sees.

## 7. Acceptance boundary

- The point is **reviewability before acceptance**, not restricting who commits. The
  agent works in the working tree; you review the diff and the threads; accepting is a
  `git commit` → push → merge.
- The diff view is the live uncommitted (or vs-branch) diff; a commit is the accept
  action. Helm makes the work reviewable *before* you accept it — whether you or the
  agent runs the commit is up to you.

## 8. Phasing roadmap

- **Phase 1 (MVP) — done:** watch architecture; Intent + Diff views; Reviewable on
  both; comments as in-repo files; live updates. Manual agent wiring (separate CC).
- **Phase 1.5 — done:** file-centric views (explorer + code view with syntax
  highlighting + richer diff, on content anchors, §12); command palette (⌘K).
- **Phase 2 — partly done:** embedded terminal shipped (run CC in a tab); routing a
  comment straight to the agent ("send to agent") is still open.
- **Git source control (§13) — Slice A done:** read-only status / ahead-behind / fetch /
  staged diff / worktrees / remotes. Slice B/C (stage, commit, stash, branch & worktree
  switching — with dirty-tree auto-stash + confirm/undo guardrails) are next.
- **Phase 3:** Multi-workspace via `git worktree` ("create a workspace from branch D
  origin"); each worktree = an isolated sandbox for one agent → real parallel agents.
- **Later:** more views as the project earns them (build, CI, deploy, render) — each a
  new contract, added **only** once it has two concrete implementations.

## 9. Known sharp edges

- **Markdown anchoring** is weaker than line-based code anchoring; lean on
  content-based anchors and accept orphan→outdated on big rewrites.
- **`git worktree`** (Phase 3): a branch can't be checked out in two worktrees
  at once; submodules / hooks / LFS behave oddly across worktrees.
- **Comment churn** from in-repo `.reviews/` may eventually justify moving to a
  sidecar store — flagged, not solved.
- **Staleness in watch mode:** the UI is only as fresh as the filesystem
  watcher; ensure debounced, reliable change events so you never command from a
  stale map.

## 10. Open questions to settle during the build

1. `INTENT.md` single file vs `.intent/` directory of docs — start single.
2. Comment file format: JSON (above) vs markdown-with-frontmatter (more
   agent-legible, messier to parse). Start JSON; revisit if the agent struggles.
3. SSE vs WebSocket for live updates — SSE is simpler and sufficient for v1.
4. Port selection / auto-open-browser behavior on `helm` launch.

## 11. Agent interface — CLI + suggested edits (Phase 1.5)

Phase 1.5 gives the agent a first-class way to participate without inventing a
protocol: a CLI that is a **fourth front door onto the one function registry**
(§5), plus **suggested edits** as a new kind of thread message.

### CLI = the registry, one-shot

`helm` with no verb serves the UI (unchanged). `helm <verb> [args] [--json]` runs a
single registry call against the working tree and exits — **no server required**.
Because truth is the filesystem, the CLI and the UI stay in sync through the files,
not through each other: a `helm reply` writes `.reviews/`, the watcher fires, and any
open browser repaints. Output is readable text by default, `--json` for parsing. IDs
accept any unique prefix (like git).

| Verb | Registry fn | Notes |
|---|---|---|
| `context` | `getWorkspace` (+ intent) | repo + intent + changed files + open comments, one shot |
| `status` | `repoStatus` | branch, change count, comment counts |
| `intent` | `getIntent` | print `INTENT.md` |
| `tree [--all]` | `getWorkspace` | explorer: changed + commented files (`--all` = every file) |
| `file <path>` | `getFile` | a file's current content |
| `diff [path]` | `showDiff` / `getFile` | working tree by default; `--branch <ref>` (`ref...HEAD`), `--ref\|--tag <r>` (`r..HEAD`) |
| `comments [--all]` | `listThreads` | open + outdated by default; `--all` for resolved |
| `show <id>` | `getThread` | one thread, decorated, with any suggestion |
| `comment <path> <line>` | `addComment` | open a thread as the agent (`--end`, `--stdin`/`--file`) |
| `reply <id> <text>` | `replyComment` | author forced to `agent` |
| `suggest <id> <text>` | `suggestEdit` | `--stdin`/`--file` for the new text; `--replaces "<t>"` sets what it replaces |
| `apply <id>` | `applySuggestion` | write-through to the file |
| `dismiss <id>` | `dismissSuggestion` | |
| `resolve` / `reopen <id>` | `resolve/reopenComment` | |

The git source-control functions (`gitStatus` / `gitTopology` / `gitFetch`, §13) are in
the registry and the UI but **not** yet exposed as `helm` verbs.

### Suggested edits live in the thread

A suggestion is a normal message that also carries a proposed replacement:

```jsonc
{ "author": "agent", "body": "Batch the fetch — proposed below.", "ts": "…",
  "suggestion": {
    "base":    "for (const id of ids) { await fetch(id); }",  // exact current text
    "newText": "await fetchMany(ids);",
    "status":  "proposed"   // proposed | applied | dismissed
  } }
```

- **Apply** replaces the unique occurrence of `base` with `newText` in the thread's
  target file (`anchor.path`, or `INTENT.md` for intent), then write-throughs. It
  **refuses** if `base` is missing (drifted → *stale*) or appears more than once
  (ambiguous) — the same content-based safety as comment "outdated", reused.
- `base` is captured from the anchored region at suggest-time (file lines for code;
  the quote for intent) or supplied explicitly with `--base`. Using literal text,
  not line numbers, makes apply drift-safe and sidesteps the diff-marker /
  markdown-source fidelity traps entirely.
- Applying edits the **working tree only**; you review it, then accept by committing
  (§7). The thread now records the proposal, its rationale, and whether it was taken.

### Non-goals (kept deliberately small)

- Suggestions are **single-region replacements** — the thing the comment is about —
  not multi-file patches. For broader changes the agent edits directly and you review
  the diff. Two clean modes: **suggest** (scoped, non-destructive, apply-on-click) vs
  **edit** (direct, you commit/restore). Both end at the same boundary: a reviewed commit.
- `apply` write-throughs to the file; committing stays a separate, deliberate step.

## 12. File-centric views + content anchors (v2)

Generalizes the two fixed lenses (intent, diff) into a file-centric workspace — the
code-file view plus a richer diff, on a unified anchor model.

### Views
- **Explorer** — the project file tree, each file decorated with its change status in
  the active diff mode and a comment badge. `INTENT.md` is pinned at the top.
- **File view** — the selected file as-is: markdown rendered (with a raw toggle), else
  a line-numbered code view. Reviewable (gutter click / shift-range / text select).
- **Diff view** — the selected file's diff for the active mode. Reviewable.
- Intent is no longer a separate lens — it's the file view of `INTENT.md`.

### Diff modes — `diff(base → target)`
- **working** — HEAD vs the working tree (uncommitted, incl. untracked).
- **staged** — HEAD vs the index (`git diff --cached`: what a commit would record).
- **branch** — `ref...HEAD` (merge-request style, three-dot — *your* changes since the
  fork point).
- **ref** — `ref..HEAD` (vs a commit, tag, or remote branch like `origin/main`; two-dot
  net delta).

One server pair `diffAll/diffFile({kind, ref})`; the UI mode bar selects the preset, and
the ref autocompletes from local + remote branches and tags. A per-file view and a
continuous "All changes" view share the renderer (with word-level / intra-line
highlighting).

### Content anchors (the keystone)
A comment anchors to `{ path, startLine, endLine }` + the captured `context` text —
*not* to diff coordinates. So one thread renders in every lens: highlighted in the file
view, overlaid on any diff whose current hunks contain that text, in the Review panel,
and as an Explorer badge. "Outdated" and the live inline location are found by searching
the current file for `context` (markdown-formatting tolerant). Older per-view anchors
load via a compat shim in `store.ts`.

### Comments & suggestions across modes
- The click gesture is identical in the file view and in every diff submode; a comment
  is **not** bound to a mode.
- Suggestions always operate on **current file state** (`base` = current text), so they
  are mode-independent; Apply write-throughs to the working file.
- Deleted (old-side) diff lines aren't commentable in v1 (no current-file content to
  anchor to) — deferred.

### Agent / CLI
New read verbs `helm tree` (explorer) and `helm file <path>`; `helm diff [path]` gains
`--branch <ref>` / `--ref|--tag <r>`. reply/suggest/apply are unchanged. The agent's
model is simply "file + region."

## 13. Source control + embedded terminal (current)

Two surfaces added on top of §12, both reached through the same registry / front doors
and kept inside the single binary.

### Embedded terminal
A real login shell attached to **Bun's native pty** (`Bun.spawn({ terminal })`,
POSIX-only — macOS/Linux), bridged to **xterm.js** over a `/terminal` WebSocket. One pty
per connection; opens in the repo root; appears as a tab; more than one allowed. No
`node-pty`, no native addon — so it stays in the single binary. Caveats: a real shell runs
with your privileges (it *can* `git commit`), and there's no session persistence if the
socket drops.

### Git source control (Slice A — read-only + fetch)
Three registry functions surface the git state the UI was missing, none of which mutate
your tree:
- `gitStatus` — working-tree status grouped staged / unstaged / untracked, plus
  ahead/behind vs upstream, the upstream name, and stash count (`.reviews/` excluded).
- `gitTopology` — worktrees, remotes, and remote branches.
- `gitFetch` — `fetch --prune`; the one action, and a safe one (updates remote-tracking
  refs only, never the working tree or local branches).

The UI shows these in a **Source Control rail** (branch → upstream, ↑ahead ↓behind, a
Fetch button, the grouped changes, stashes, worktrees, remotes) and an enriched branch
chip; the comparison picker gained the **staged** preset and `origin/*` autocompletion.

**Guardrailed mutations are deferred (Slice B/C):** stage / unstage / commit / stash /
discard, and branch / worktree switching — each needs the dirty-tree auto-stash, confirm,
and reflog-backed undo from the plan, so they're intentionally not in the UI yet. Today
those go through the embedded terminal, and the watcher repaints live.

### Acceptance, restated
`.reviews/` is gitignore-able and **local by default** (a shift from §3's lean toward
committing the threads) — reviews stay on your machine unless you choose to commit them.
And per §7, acceptance is a commit/merge; Helm makes the work reviewable first, it does
not restrict who commits.
