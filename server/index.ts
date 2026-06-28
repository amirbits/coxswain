// Entry point. `cd <repo> && helm` resolves the repo root, finds an open port,
// starts the server, and opens the browser (DESIGN.md §7, open question §10.4).

import { createServer as netServer } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { repoRoot } from "./git";
import { startServer } from "./server";

const HELP = `helm — a local-first command-and-control workspace for agentic work

Usage: helm [options]

Options:
  --port <n>     Preferred port (default 4317; the next free port is used if taken)
  --base <ref>   Show the PR-style diff base...HEAD instead of the working-tree diff
  --dir <path>   Repo directory to serve (default: current directory)
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
  console.error(`helm: ${cwd} is not a git repository.\nRun \`git init\` there first, then \`helm\`.`);
  process.exit(1);
}

const startPort = values.port ? parseInt(values.port, 10) : 4317;
const port = await findOpenPort(Number.isFinite(startPort) ? startPort : 4317);

const { server } = await startServer({
  root,
  port,
  dev: !!values.dev,
  defaultBase: values.base ?? null,
});

const url = `http://localhost:${server.port}`;
console.log(`\n  ⎈  Helm → ${url}\n     repo: ${root}\n`);

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
