import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "./git";

const root = mkdtempSync(join(tmpdir(), "cox-git-"));
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });

beforeAll(() => {
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("mv", "a.txt", "b.txt"); // staged rename
  writeFileSync(join(root, "un ötracked.txt"), "x\n"); // space + non-ASCII, untracked
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("status() -z porcelain (F3)", () => {
  test("a rename reports the new path, not the porcelain 'old -> new'", async () => {
    const { files } = await status(root);
    const rename = files.find((f) => f.index === "R");
    expect(rename?.path).toBe("b.txt");
  });

  test("a space + non-ASCII untracked path comes back unquoted", async () => {
    const { files } = await status(root);
    const untracked = files.find((f) => f.index === "?" && f.worktree === "?");
    expect(untracked?.path).toBe("un ötracked.txt");
  });
});
