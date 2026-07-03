# Decisions

Why things are the way they are. One line each; reverse only with care.

- **Source of truth = the git working tree.** No separate database of project state;
  every view is a projection, so nothing drifts. The server holds no authoritative state
  — kill it and re-derive everything from the tree.
- **Acceptance = git; reviewability is the point.** Review happens before acceptance; a
  commit / merge accepts. Coxswain makes work reviewable, it does not restrict who commits.
- **One function registry, many front doors.** Every capability is a deterministic typed
  function first; the UI, HTTP, and the `cox` CLI all call it. The LLM only routes to it.
- **Comments are content-anchored files.** `.reviews/<id>.json` anchored to file text,
  not diff coordinates, so one thread renders in every lens and survives edits.
- **`.reviews/` is local by default.** Gitignore-able, so an agent's threads never
  pollute the target repo. Opt in to committing them to share the decision log.
- **Suggestions are single-region.** A `base → newText` the comment is about, not
  multi-file patches; apply matches literal text, so it is drift-safe.
- **Single Bun binary; git is the only runtime dependency.** `bun build --compile`
  bundles the UI; it runs from any folder. macOS/Linux (the terminal needs a POSIX pty).
- **Embedded terminal = Bun's native pty, not node-pty.** No native addon, so it stays in
  the single binary; bridged to xterm.js over a WebSocket.
- **No intent↔code bidirectional projection.** The upward map (code → spec) is lossy and
  one-to-many; chasing it reproduces the desync it claims to kill. Views are reads with
  write-through to files instead.
- **SSE for state, WebSocket for the terminal.** SSE is enough for live repaint; the
  terminal needs bidirectional bytes.
- **In-repo `.reviews/` over a sidecar store.** Plain files the agent reads with zero
  extra API; revisit only if comment churn hurts.
