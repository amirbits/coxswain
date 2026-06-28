# Helm

A local-first command-and-control workspace for agentic software work.

`cd` into any git repo, run one binary, and Helm serves a localhost web UI that
projects the project through reviewable **views** — its intent and its diff — all
backed by a single source of truth: the git working tree.

See [`INTENT.md`](./INTENT.md) for what Helm is, and [`DESIGN.md`](./DESIGN.md) /
[`IMPLEMENTATION_BRIEF.md`](./IMPLEMENTATION_BRIEF.md) for the why and the build order.

## Status — Phase 1 (WATCH)

Helm watches the filesystem + git and renders live. You run your own Claude Code; you
steer it by leaving review comments that persist as files under `.reviews/`; the agent
reads them, edits files, and the UI repaints live. **Helm never commits — you do, and
that is acceptance.**

## Develop

```sh
bun install
bun run dev      # Vite (web) + Bun API server, with live reload
```

Open the URL Vite prints (default http://localhost:5173).

## Build the single binary

```sh
bun run build    # builds the web app, embeds it, compiles ./helm
./helm           # run inside any git repo
```

## The loop

1. Run `helm` inside a git repo. Edit `INTENT.md` to capture intent.
2. Make changes (or let your agent make them); watch the **Diff** view update live.
3. Select a diff line or an intent passage → leave a comment. It is saved under `.reviews/`.
4. Tell your Claude Code: *"address the open review comments."* It reads `.reviews/`,
   edits files, optionally appends replies. The UI repaints.
5. When you are satisfied, **you** `git commit`. That is acceptance.
