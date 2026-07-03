// Full production build: build the web app, embed it, then compile a single
// self-contained `cox` binary. Run with `bun run build`.

import { join } from "node:path";

const root = join(import.meta.dir, "..");

async function run(cmd: string[], cwd = root): Promise<void> {
  console.log(`\n$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`build: \`${cmd.join(" ")}\` exited ${code}`);
    process.exit(code);
  }
}

await run(["bunx", "vite", "build", "--config", join(root, "web/vite.config.ts")]);
await run(["bun", join(root, "scripts/embed.ts")]);
await run([
  "bun",
  "build",
  "--compile",
  "--outfile",
  join(root, "cox"),
  join(root, "server/index.ts"),
]);

console.log("\n✓ built ./cox — run it inside any git repo (e.g. `cd ~/some-repo && /path/to/cox`)");
