import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInRepo } from "./paths";

// A repo with a symlink pointing outside its own tree (the F5 case).
const root = mkdtempSync(join(tmpdir(), "cox-paths-"));
const outside = mkdtempSync(join(tmpdir(), "cox-outside-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "a.ts"), "x");
writeFileSync(join(outside, "secret.txt"), "s3cret");
symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveInRepo (F5)", () => {
  test("allows a normal in-repo file", () => {
    expect(() => resolveInRepo(root, "src/a.ts")).not.toThrow();
  });

  test("allows a not-yet-created nested path (so writes to new files work)", () => {
    expect(() => resolveInRepo(root, "src/new/deep.ts")).not.toThrow();
  });

  test("rejects ../ traversal", () => {
    expect(() => resolveInRepo(root, "../secret.txt")).toThrow(/escapes/);
  });

  test("rejects an absolute path", () => {
    expect(() => resolveInRepo(root, "/etc/passwd")).toThrow(/escapes/);
  });

  test("rejects a symlink that escapes the repo", () => {
    expect(() => resolveInRepo(root, "escape.txt")).toThrow(/escapes/);
  });
});
