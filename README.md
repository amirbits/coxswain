# Helm

A local-first command-and-control workspace for agentic software work.

`cd` into any git repo, run one binary, and Helm serves a localhost web UI that
projects the project through reviewable **views** — its files, their diffs, its
git/source-control state, and an embedded terminal — all backed by a single source
of truth: the git working tree.

See [`INTENT.md`](./INTENT.md) for what Helm is, and [`DESIGN.md`](./DESIGN.md) /
[`IMPLEMENTATION_BRIEF.md`](./IMPLEMENTATION_BRIEF.md) for the why and the build order.

## Status

Helm watches the filesystem + git and renders live. Steer your agent by leaving review
comments that persist as files under `.reviews/` (gitignore-able, so they stay local);
the agent reads them, edits files, and the UI repaints with no refresh. Run Claude Code
in your own terminal **or** in Helm's embedded terminal. The point is that the work is
**reviewable before you accept it** — accepting is a commit / merge.

Built so far: the file **explorer** + **file view** (syntax-highlighted) + **diff view**
(per-file and a continuous "All changes" view, with word-level highlighting) in four
modes — working / staged / vs-branch / vs-commit; a **Source Control** rail (branch,
ahead/behind vs origin, fetch, staged/unstaged/untracked, stashes, worktrees, remotes);
the **Review** panel; a command palette (⌘K); and an **embedded terminal** (real PTY,
multiple tabs) — all opened as tabs.

## Quick start

```sh
bun install
bun run build              # builds the web app, embeds it, compiles ./helm
cd ~/your-repo && /path/to/helm
```

Or develop with live reload (dogfoods Helm on the Helm repo):

```sh
bun run dev                # Vite (UI, :5173) + Bun API server (:4317)
```

Flags (`helm --help`): `--port <n>`, `--base <ref>` (PR-style `base...HEAD` diff),
`--dir <path>`, `--no-open`.

**Requires** to *run*: `git` on your `PATH`, **macOS or Linux** (the embedded terminal
uses a POSIX pty), and a browser. The compiled binary bundles everything else — no
Bun/Node needed to run it (only to build it).

## The loop

1. Run `helm` inside a git repo. Open `INTENT.md` (pinned in the explorer) to capture intent.
2. Make changes — or let your agent make them; watch the **Diff** view update live.
3. Select diff lines (click a line number, shift-click for a range) or intent text →
   leave a comment. It is saved as a file under `.reviews/`.
4. Tell your Claude Code: **“address the open review comments.”** It reads `.reviews/`,
   edits files, optionally appends replies. The UI repaints — no refresh.
5. When you're satisfied, **commit** (or merge) to accept.

## Agent CLI

The cleanest way for an agent to participate is the `helm` subcommands — the same
function registry the UI uses, exposed as one-shot commands that work with or without
the server running (run `helm help` for the full list):

```sh
helm context            # orient: intent + changed files + open comments, in one shot
helm tree               # file explorer: changed + commented files (--all = every file)
helm file <path>        # print a file's current content
helm diff [path]        # diff (whole repo or one file); --branch <ref> / --ref <tag>
helm comments           # list open review threads (--all to include resolved)
helm show <id>          # one thread in full (id = any unique prefix, like git)
helm reply <id> "…"     # answer a thread, as the agent
helm comment <path> <line> # open a thread as the agent (--end <line> for a range; --stdin / --file for the body)
helm suggest <id> "…"   # propose a replacement for the thread's region (--stdin / --replaces)
helm apply <id>         # apply that suggestion to the file (write-through; review then commit)
helm resolve <id>       # mark it done
helm <verb> --json      # structured output, for parsing
```

A **suggested edit** is the non-destructive option: the agent proposes a
`base → newText` replacement (stored in the thread), and you **Apply** it with one
click in the UI — or `helm apply`. Applying write-throughs to the working tree;
you review it, then commit to accept. To change files directly instead, the agent just
edits them and you review the diff.

Paste-to-your-agent:

> Run `helm context` to orient, then `helm comments`. For each open thread, either
> `helm reply <id> "…"` with an answer, or make the change — directly (edit the files)
> or as a `helm suggest <id> --stdin` proposal.

## How the agent participates

Comments live in-repo as plain JSON, so the agent needs no special API — just the
filesystem. Each thread is one file:

```jsonc
// .reviews/<uuid>.json
{
  "id": "<uuid>",
  "anchor": { "path": "src/x.ts", "startLine": 40, "endLine": 44 },
  "status": "open",                 // open | resolved  ("outdated" is derived, not stored)
  "context": "…the exact anchored text…",   // how the thread re-locates itself across edits
  "thread": [
    { "author": "human", "body": "Why fetch inside the loop?", "ts": "…" },
    { "author": "agent", "body": "Refactored to batch.", "ts": "…" }
  ]
}
```

A comment anchors to **file content** (`path` + line hints + the captured `context`),
not to diff coordinates — so one thread renders in every lens (file view, any diff mode,
the Review panel) and goes **outdated** when its `context` can no longer be found.

To wire your agent, tell it:

> Read every `*.json` under `.reviews/` whose `status` is `open`. For each, do what
> the latest human message asks by editing the working-tree files its anchor points
> to. Then append a reply — push `{ "author": "agent", "body": "…", "ts": "<ISO>" }`
> onto that file's `thread` array. The human reviews the change and accepts by committing.

The filesystem watcher picks up the agent's edits and reply, and every connected
browser re-projects state live.

## Architecture (v1)

- **Server** (`server/`, Bun + TS): a pure projector + write-through layer over git
  and the filesystem — no authoritative state of its own. `GET /api/workspace`,
  `/api/file`, `/api/changes` compose the projections; `POST /api/call` dispatches the
  function registry; `/events` is the SSE change stream; `/terminal` is the PTY
  WebSocket.
- **Web** (`web/`, React + Vite + TS): the file explorer, the file view and per-file +
  continuous diff views (Reviewable, in working / staged / vs-branch / vs-commit modes),
  the Source Control rail, the Review panel, and an embedded terminal — opened as tabs.
- **Single binary**: `bun run build` bakes the web app into the executable, so `helm`
  runs from any folder with nothing else on disk (just `git`).

## Invariants

- The git working tree is the only source of truth; nothing is cached in a parallel store.
- Work is reviewable before it's accepted; acceptance is a commit / push / merge.
- Every capability is a deterministic typed function (the registry) before any LLM routes to it.
- All steering flows through the surface (comments-as-files), never side channels the views can't see.
