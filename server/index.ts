// Entry point. `cd <repo> && cox` resolves the repo root, finds an open port,
// starts the server, and opens the browser (see docs/intent/SPEC.md).

import { createServer as netServer } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runCli } from "./cli";
import { repoRoot, scopeFromCwd } from "./git";
import { startServer } from "./server";

// Subcommands (the agent CLI) are a fourth front door onto the function
// registry; bare `cox` serves the UI (see docs/intent/SPEC.md).
const VERBS = new Set([
  "context", "status", "intent", "tree", "file", "diff", "comments", "show",
  "reply", "suggest", "apply", "dismiss", "resolve", "reopen", "comment", "help",
]);
const firstArg = Bun.argv[2];
if (firstArg && !firstArg.startsWith("-")) {
  if (VERBS.has(firstArg)) process.exit(await runCli(Bun.argv.slice(2)));
  console.error(`cox: unknown command "${firstArg}". Run \`cox help\`, or \`cox\` to serve the UI.`);
  process.exit(1);
}

const HELP = `cox — a local-first command-and-control workspace for agentic work

Usage: cox [options]

Opens a localhost UI focused on the directory you run it in — its subtree of the
repo, which keeps a large monorepo navigable. Branch and ahead/behind stay
repo-wide, changes outside the focus are still surfaced, and the scope chip in
the UI widens back to the whole repository.

Options:
  --port <n>     Preferred port (default 4317; the next free port is used if taken)
  --base <ref>   Show the PR-style diff base...HEAD instead of the working-tree diff
  --dir <path>   Repo directory to serve, and the subtree to focus on (default: cwd)
  --no-open      Do not open the browser on launch
  --dev          Dev mode: no browser auto-open (Vite serves the UI)
  -h, --help     Show this help
`;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string" },
    base: { type: "string" },
    dir: { type: "string" },
    "no-open": { type: "boolean" },
    dev: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const cwd = values.dir ? resolve(values.dir) : process.cwd();
const root = await repoRoot(cwd);
if (!root) {
  console.error(`cox: ${cwd} is not a git repository.\nRun \`git init\` there first, then \`cox\`.`);
  process.exit(1);
}

const startPort = values.port ? parseInt(values.port, 10) : 4317;
const port = await findOpenPort(Number.isFinite(startPort) ? startPort : 4317);
const scope = scopeFromCwd(root, cwd);

const { server } = await startServer({
  root,
  port,
  dev: !!values.dev,
  defaultBase: values.base ?? null,
  scope,
});

const url = `http://localhost:${server.port}`;
console.log(`\n  🚣  Coxswain → ${url}\n     repo: ${root}${scope ? `\n     scope: ${scope}/` : ""}\n`);

if (!values["no-open"] && !values.dev) openBrowser(url);

// ---------------------------------------------------------------------------

function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = netServer();
    s.once("error", () => res(false));
    s.once("listening", () => s.close(() => res(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function findOpenPort(start: number, tries = 50): Promise<number> {
  for (let p = start; p < start + tries; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port found in range ${start}..${start + tries}`);
}

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // non-fatal: the URL is printed above
  }
}
