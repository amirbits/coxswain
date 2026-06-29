// Embedded terminal: a login shell rooted at the repo, attached to Bun's native
// PTY (Bun.Terminal / Bun.spawn({ terminal }), POSIX-only), bridged to xterm.js
// over a WebSocket. One PTY per connection; it dies when the socket closes. Pure
// Bun — no native addons — so it stays inside the single binary (DESIGN.md §6).

import type { ServerWebSocket } from "bun";

export type TermData = { root: string; cols: number; rows: number; proc?: Bun.Subprocess };

const SHELL = process.env.SHELL || "/bin/zsh";

export function openTerminal(ws: ServerWebSocket<TermData>): void {
  const { root, cols, rows } = ws.data;
  // A login shell so the user's real PATH/profile load (e.g. ~/.local/bin/claude).
  const proc = Bun.spawn([SHELL, "-l"], {
    cwd: root,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: {
      cols: cols || 80,
      rows: rows || 24,
      data(_term, bytes) {
        try {
          ws.send(bytes);
        } catch {
          // socket closed mid-write
        }
      },
    },
  });
  ws.data.proc = proc;
  proc.exited.then(() => {
    try {
      ws.close();
    } catch {}
  });
}

export function terminalMessage(ws: ServerWebSocket<TermData>, message: string | Buffer): void {
  const term = ws.data.proc?.terminal;
  if (!term) return;
  // Text frames are control (resize); binary frames are keystrokes.
  if (typeof message === "string") {
    try {
      const m = JSON.parse(message);
      if (m.type === "resize") term.resize(m.cols, m.rows);
    } catch {
      // ignore malformed control message
    }
  } else {
    term.write(message);
  }
}

export function closeTerminal(ws: ServerWebSocket<TermData>): void {
  const proc = ws.data.proc;
  try {
    proc?.terminal?.close();
  } catch {}
  try {
    proc?.kill();
  } catch {}
}
