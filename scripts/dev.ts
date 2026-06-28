// One-command dev: start the Bun API server (watching the Helm repo itself, so
// you dogfood Helm on Helm) and Vite (which serves the UI with HMR and proxies
// /api + /events to the server). Ctrl-C stops both.

import { join } from "node:path";

const root = join(import.meta.dir, "..");
const serverPort = "4317";

const server = Bun.spawn(
  ["bun", join(root, "server/index.ts"), "--dev", "--no-open", "--port", serverPort, "--dir", root],
  { cwd: root, stdout: "inherit", stderr: "inherit", stdin: "inherit" },
);

const vite = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1"], {
  cwd: join(root, "web"),
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

function shutdown() {
  server.kill();
  vite.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// If either process dies, take the other down too.
await Promise.race([server.exited, vite.exited]);
shutdown();
