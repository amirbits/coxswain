# Design Doc — Project Command & Control (Helm)

Status: v1 design for the validation MVP, with Phase-2 directions noted.
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
            ┌──────────────────────────────────────────────┐
            │  Browser (React + Vite, localhost)            │
            │  ┌──────────┐ ┌──────────┐  ┌──────────────┐  │
            │  │ Intent   │ │ Diff     │  │ Command       │ │
            │  │ view     │ │ view     │  │ palette / NL  │ │
            │  │(Reviewable)(Reviewable)│  │ bar           │ │
            │  └──────────┘ └──────────┘  └──────────────┘  │
            └───────────────▲───────────────┬───────────────┘
                            │ SSE (live)     │ JSON API / function calls
            ┌───────────────┴───────────────▼───────────────┐
            │  Local server (Bun + TS, single binary)        │
            │  - Function registry (the only way to act)     │
            │  - git CLI adapter (status/diff/log/branch)    │
            │  - file store adapter (INTENT.md, .reviews/)   │
            │  - filesystem watcher → SSE push               │
            └───────────────▲───────────────┬───────────────┘
                            │ reads/writes   │ watches
            ┌───────────────┴───────────────▼───────────────┐
            │  SOURCE OF TRUTH: the git working tree         │
            │  - INTENT.md          (intent)                 │
            │  - source files       (code)                   │
            │  - .git               (history, diff, branch)  │
            │  - .reviews/*.json    (comment threads)        │
            └───────────────▲────────────────────────────────┘
                            │ reads comments / writes files
            ┌───────────────┴────────────────────────────────┐
            │  Claude Code (Phase 1: run separately by user;  │
            │  Phase 2: driven by the server)                 │
            └─────────────────────────────────────────────────┘
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
| Diff & history | `.git` | `git` CLI | git commits (human only) |
| Comments / review | `.reviews/<id>.json` | file read | API write / agent append |

**Decision — comments live in-repo for v1.** Committing `.reviews/` into the
repo means the agent reads threads as plain files with zero extra API, and the
decision log is a true byproduct (it travels with the code, versioned by git).
Cost: history noise and possible merge conflicts on comment files. The
alternative (a sidecar store outside git) gives cleaner history but reintroduces
a database + API the agent must be taught to read. **v1 = in-repo, by deliberate
choice.** Revisit if comment churn becomes painful.

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

Every comment anchors to an **immutable version + a locator**, and is shown as
**outdated** when the live content at that locator has drifted. This is exactly
how GitHub survives commenting on a moving diff — reuse the pattern.

```ts
type Anchor = {
  view: "intent" | "diff" | "code";
  version: string;          // commit SHA, or "working" for the live tree
  locator: LineRange | TextAnchor;
};
```

- **Code / diff:** locator = `{ path, startLine, endLine }`, version = the SHA
  the comment was made against (or `"working"`). On drift, mark outdated rather
  than silently moving the comment.
- **Intent (markdown):** locator = a text anchor (quote + offset, or a heading
  path). Markdown has no stable line identity across edits, so prefer a
  content-based anchor and accept that large rewrites orphan comments → outdated.

> The contract's real substance is defining the `Anchor`/`Region` abstraction
> **once** and satisfying it differently per view. Implement it for **exactly
> two** views (intent + diff) before generalizing — two implementations is when
> the abstraction earns its keep; one is premature architecture.

### Thread file shape

```jsonc
// .reviews/<uuid>.json
{
  "id": "uuid",
  "anchor": { "view": "diff", "version": "<sha|working>",
              "locator": { "path": "src/x.ts", "startLine": 40, "endLine": 44 } },
  "status": "open",            // open | resolved | outdated
  "thread": [
    { "author": "human", "body": "Why fetch inside the loop?", "ts": "..." },
    { "author": "agent", "body": "Refactored to batch; see new diff.", "ts": "..." }
  ]
}
```

The agent reads these files directly, appends replies, and edits the referenced
source — no special protocol needed beyond "read `.reviews/`, act, append."

## 5. AI-able: one function registry, three front doors

Every capability is a **deterministic typed function** registered once. The LLM
is confined to (a) routing natural language to a registered call with extracted
args, and (b) the irreducibly fuzzy work (writing comment prose, editing the
spec). Anything that can be programmed is programmed and unit-testable; the LLM
never executes it directly.

```ts
type Caller = "palette" | "nl" | "agent";

registry.register("showDiff",       (args: { base?: string }) => Diff);
registry.register("openView",       (args: { name: ViewName }) => void);
registry.register("addComment",     (args: { view, anchor, text }) => Thread);
registry.register("replyComment",   (args: { id, text }) => Thread);
registry.register("resolveComment", (args: { id }) => void);
// Phase 2:
registry.register("createWorkspace",(args: { branch, origin }) => Workspace);
registry.register("listWorkspaces", () => Workspace[]);
```

Three front doors, one registry:
- **Command palette** — the verbs above, exposed as clickable commands. The
  palette's contents *are* the registry; nothing more.
- **NL bar** — "show me the diff against main" → LLM parses to
  `showDiff({ base: "main" })`. If the parse is ambiguous, it **asks**, it does
  not guess.
- **Agent** — calls the same functions programmatically.

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

### Phase 2 — DRIVE (only after the watch loop is sticky)
The server spawns and manages Claude Code, embeds a terminal emulator
(`xterm.js` + a pty), and routes comments to the agent directly so the human
never leaves the surface. This is where the real plumbing cost lives; defer it
until Phase 1 proves people (you) actually steer through the surface.

**The rule that governs both phases:** if steering happens anywhere the views
can't observe, the decision log is fiction. In Phase 1 that means steering must
go through comments-as-files the agent reads — not ad-hoc terminal chatter that
the surface never sees.

## 7. Acceptance boundary

- The agent edits the **working tree only** and **never commits.**
- The human accepts by `git commit` → push → merge. The diff view is the live
  uncommitted (or vs-branch) diff; commit is the accept action.
- In Phase 2 (drive mode), configure Claude Code so it cannot auto-commit;
  if it controls the commit boundary, the "no more blind acceptance" guarantee
  silently breaks.

## 8. Phasing roadmap

- **Phase 1 (MVP, ~2 days):** watch architecture; Intent + Diff views;
  Reviewable on both; comments as in-repo files; live updates. Manual agent
  wiring (separate CC).
- **Phase 1.5:** Code-file view (file tree + contents, Reviewable). Minimal
  palette + NL bar over the existing registry.
- **Phase 2:** Drive Claude Code — embedded terminal, route comments to the
  agent, agent replies surfaced in-thread automatically.
- **Phase 3:** Multi-workspace via `git worktree` ("create a workspace from
  branch D origin"); each worktree = an isolated sandbox for one agent → real
  parallel agents without collision.
- **Later:** more views as the project acquires capability (build, CI, deploy,
  render) — each a new contract, added **only** once it has two concrete
  implementations to justify the abstraction.

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
| `context` | `getState` | intent + diff summary + open comments, one shot |
| `status` | `repoStatus` | branch, change count, comment counts |
| `intent` / `diff` | `getIntent` / `showDiff` | raw projections (`diff --base R`) |
| `comments` | `listThreads` | open + outdated by default; `--all` for resolved |
| `show <id>` | `getThread` | one thread, decorated, with any suggestion |
| `reply <id> <text>` | `replyComment` | author forced to `agent` |
| `suggest <id> <text>` | `suggestEdit` | `--stdin` / `--file` for the new text; `--base` to set what it replaces |
| `apply <id>` | `applySuggestion` | write-through; never commits |
| `dismiss <id>` | `dismissSuggestion` | |
| `resolve` / `reopen <id>` | `resolve/reopenComment` | |

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
  target file (`locator.path`, or `INTENT.md` for intent), then write-throughs. It
  **refuses** if `base` is missing (drifted → *stale*) or appears more than once
  (ambiguous) — the same content-based safety as comment "outdated", reused.
- `base` is captured from the anchored region at suggest-time (file lines for code;
  the quote for intent) or supplied explicitly with `--base`. Using literal text,
  not line numbers, makes apply drift-safe and sidesteps the diff-marker /
  markdown-source fidelity traps entirely.
- Applying edits the **working tree only**; acceptance is still the human's commit
  (§7). The thread now records the proposal, its rationale, and whether it was taken.

### Non-goals (kept deliberately small)

- Suggestions are **single-region replacements** — the thing the comment is about —
  not multi-file patches. For broader changes the agent edits directly and you review
  the diff. Two clean modes: **suggest** (scoped, non-destructive, apply-on-click) vs
  **edit** (direct, you commit/restore). Both end at the same boundary: your commit.
- `apply` never commits, and the CLI exposes no commit verb.
