# Helm

A local-first command-and-control workspace for agentic work. `cd` into a git repo, run
one binary, and get a localhost web UI over the working tree: files, diffs, review
comments, git state, and a terminal.

## Requires

- `git` on `PATH`
- macOS or Linux (the embedded terminal uses a POSIX pty)
- a browser

The compiled binary bundles everything else — no Bun/Node needed to run it.

## Build & run

```sh
bun install
bun run build            # builds the UI, embeds it, compiles ./helm
cd ~/your-repo && /path/to/helm
```

Dev with live reload: `bun run dev` (Vite on :5173, API on :4317).

Flags: `--port <n>`, `--base <ref>`, `--dir <path>`, `--no-open`.

## The loop

1. Open the repo's intent (`docs/intent/SPEC.md`, pinned in the explorer) and edit it.
2. Make changes, or let your agent. The diff updates live.
3. Click a line number (shift-click for a range) to comment. It's saved under `.reviews/`.
4. Tell your agent "address the open review comments" — in your own terminal or Helm's.
   It reads `.reviews/`, edits files, replies. The UI repaints; no refresh.
5. Commit (or merge) to accept.

## Agent CLI

`helm <verb>` is the same function registry the UI uses, one-shot, no server required
(`helm help` for the full list):

```sh
helm context             # intent + changed files + open comments
helm diff [path]         # working tree; --branch <ref> / --ref <tag>
helm comments            # open threads (--all includes resolved)
helm reply <id> "…"      # answer a thread
helm suggest <id> "…"    # propose a base→newText edit (--replaces)
helm apply <id>          # write the suggestion through to the file
```

## Docs

- [`docs/intent/SPEC.md`](docs/intent/SPEC.md) — what Helm is and does (the spec; also
  the in-app intent doc).
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — the decisions, and why.
