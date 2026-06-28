# Helm

A local-first command-and-control workspace for agentic software work.

`cd` into any git repo, run one binary, and Helm serves a localhost web UI that
projects the project through reviewable **views** — its intent and its diff — all
backed by a single source of truth: the git working tree.

See [`INTENT.md`](./INTENT.md) for what Helm is, and [`DESIGN.md`](./DESIGN.md) /
[`IMPLEMENTATION_BRIEF.md`](./IMPLEMENTATION_BRIEF.md) for the why and the build order.

## Status — Phase 1 (WATCH)

Helm watches the filesystem + git and renders live. You run your own Claude Code;
you steer it by leaving review comments that persist as files under `.reviews/`;
the agent reads them, edits files, and the UI repaints live. **Helm never commits —
you do, and that is acceptance.**

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

## The loop

1. Run `helm` inside a git repo. Edit `INTENT.md` (the **Intent** view) to capture intent.
2. Make changes — or let your agent make them; watch the **Diff** view update live.
3. Select diff lines (click a line number, shift-click for a range) or intent text →
   leave a comment. It is saved as a file under `.reviews/`.
4. Tell your Claude Code: **“address the open review comments.”** It reads `.reviews/`,
   edits files, optionally appends replies. The UI repaints — no refresh.
5. When you are satisfied, **you** `git commit`. That is acceptance.

## Agent CLI

The cleanest way for an agent to participate is the `helm` subcommands — the same
function registry the UI uses, exposed as one-shot commands that work with or without
the server running (run `helm help` for the full list):

```sh
helm context            # orient: intent + changed files + open comments, in one shot
helm comments           # list open review threads (--all to include resolved)
helm show <id>          # one thread in full (id = any unique prefix, like git)
helm reply <id> "…"     # answer a thread, as the agent
helm suggest <id> "…"   # propose a replacement for the thread's region (--stdin / --base)
helm apply <id>         # apply that suggestion to the file (you still commit to accept)
helm resolve <id>       # mark it done
helm <verb> --json      # structured output, for parsing
```

A **suggested edit** is the non-destructive option: the agent proposes a
`base → newText` replacement (stored in the thread), and you **Apply** it with one
click in the UI — or `helm apply`. Applying write-throughs to the working tree;
acceptance is still your commit. To change files directly instead, the agent just
edits them and you review the diff.

Paste-to-your-agent:

> Run `helm context` to orient, then `helm comments`. For each open thread, either
> `helm reply <id> "…"` with an answer, or make the change — directly (edit the files)
> or as a `helm suggest <id> --stdin` proposal. Never `git commit`.

## How the agent participates

Comments live in-repo as plain JSON, so the agent needs no special API — just the
filesystem. Each thread is one file:

```jsonc
// .reviews/<uuid>.json
{
  "id": "<uuid>",
  "anchor": {
    "view": "diff",                 // or "intent"
    "version": "working",           // sha the comment was made against, or "working"
    "locator": { "kind": "lines", "path": "src/x.ts", "side": "new",
                 "startLine": 40, "endLine": 44 }
  },
  "status": "open",                 // open | resolved  ("outdated" is derived, not stored)
  "context": "…captured anchored text…",
  "thread": [
    { "author": "human", "body": "Why fetch inside the loop?", "ts": "…" },
    { "author": "agent", "body": "Refactored to batch.", "ts": "…" }
  ]
}
```

To wire your agent, tell it:

> Read every `*.json` under `.reviews/` whose `status` is `open`. For each, do what
> the latest human message asks by editing the working-tree files its anchor points
> to. Then append a reply — push `{ "author": "agent", "body": "…", "ts": "<ISO>" }`
> onto that file's `thread` array. **Do not commit;** the human accepts by committing.

The filesystem watcher picks up the agent's edits and reply, and every connected
browser re-projects state live.

## Architecture (v1)

- **Server** (`server/`, Bun + TS): a pure projector + write-through layer over git
  and the filesystem — no authoritative state of its own. `GET /api/state` composes
  the whole projection; `POST /api/call` dispatches the function registry; `/events`
  is the SSE change stream.
- **Web** (`web/`, React + Vite + TS): the Intent and Diff views (both Reviewable)
  plus the Review panel.
- **Single binary**: `bun run build` bakes the web app into the executable, so `helm`
  runs from any folder with nothing else on disk.

## Invariants

- The git working tree is the only source of truth; nothing is cached in a parallel store.
- The agent edits the working tree and **never commits**.
- Every capability is a deterministic typed function (the registry) before any LLM routes to it.
- All steering flows through the surface (comments-as-files), never side channels the views can't see.
