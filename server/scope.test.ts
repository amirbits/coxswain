import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, cleanScope, diffAll, inScope, listFiles, scopeFromCwd } from "./git";
import { Store } from "./store";
import { getWorkspace } from "./workspace";

const root = mkdtempSync(join(tmpdir(), "cox-scope-"));
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });

beforeAll(() => {
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  mkdirSync(join(root, "web/src"), { recursive: true });
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, "web/src/app.ts"), "one\n");
  writeFileSync(join(root, "server/index.ts"), "srv\n");
  writeFileSync(join(root, "readme.md"), "hi\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  // Uncommitted changes in two different subtrees.
  writeFileSync(join(root, "web/src/app.ts"), "one\ntwo\n"); // modify in web/
  writeFileSync(join(root, "server/index.ts"), "srv\nmore\n"); // modify in server/
  writeFileSync(join(root, "web/src/new.ts"), "new\n"); // untracked in web/
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("cleanScope", () => {
  test("strips slashes and rejects traversal", () => {
    expect(cleanScope("/web/")).toBe("web");
    expect(cleanScope(".")).toBe("");
    expect(cleanScope("")).toBe("");
    expect(cleanScope("web/../etc")).toBe("");
    expect(cleanScope("web/src")).toBe("web/src");
  });
});

describe("inScope", () => {
  test("prefix containment, empty scope = whole repo", () => {
    expect(inScope("web/src/app.ts", "")).toBe(true);
    expect(inScope("web/src/app.ts", "web")).toBe(true);
    expect(inScope("server/index.ts", "web")).toBe(false);
    expect(inScope("website/x", "web")).toBe(false); // not a false prefix match
  });
});

describe("scopeFromCwd", () => {
  test("subdir → relative, root → '', outside → ''", () => {
    expect(scopeFromCwd(root, join(root, "web/src"))).toBe("web/src");
    expect(scopeFromCwd(root, root)).toBe("");
    expect(scopeFromCwd(root, tmpdir())).toBe("");
  });
});

describe("scoped git reads", () => {
  test("listFiles narrows to the subtree", async () => {
    const all = await listFiles(root);
    const web = await listFiles(root, "web");
    expect(all).toContain("server/index.ts");
    expect(web).toContain("web/src/app.ts");
    expect(web).toContain("web/src/new.ts");
    expect(web.some((p) => p.startsWith("server/"))).toBe(false);
  });

  test("changedFiles narrows to the subtree (incl. untracked)", async () => {
    const web = await changedFiles(root, { kind: "working" }, "web");
    expect(web["web/src/app.ts"]).toBe("M");
    expect(web["web/src/new.ts"]).toBe("A");
    expect(web["server/index.ts"]).toBeUndefined();
  });

  test("diffAll narrows to the subtree", async () => {
    const web = await diffAll(root, { kind: "working" }, "web");
    expect(web.raw).toContain("web/src/app.ts");
    expect(web.raw).not.toContain("server/index.ts");
  });
});

describe("getWorkspace scope + elsewhere", () => {
  test("tree is scoped; branch stays global; elsewhere counts outside changes", async () => {
    const ws = await getWorkspace(root, new Store(root), { kind: "working" }, "web");
    expect(ws.repo.scope).toBe("web");
    expect(ws.repo.branch).toBeTruthy(); // branch is a repo-wide fact
    expect(ws.tree.some((e) => e.path.startsWith("server/"))).toBe(false);
    expect(ws.tree.some((e) => e.path === "web/src/app.ts")).toBe(true);
    // server/index.ts changed but sits outside the scope.
    expect(ws.repo.elsewhere).toBe(1);
  });

  test("whole-repo scope sees everything and reports nothing elsewhere", async () => {
    const ws = await getWorkspace(root, new Store(root), { kind: "working" }, "");
    expect(ws.repo.scope).toBe("");
    expect(ws.repo.elsewhere).toBe(0);
    expect(ws.tree.some((e) => e.path === "server/index.ts")).toBe(true);
  });
});
