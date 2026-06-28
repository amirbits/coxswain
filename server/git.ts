// git CLI adapter. Helm holds no authoritative state of its own — every fact
// about history, diff, and branch is read from git on demand (DESIGN.md §2).

import { statSync } from "node:fs";
import { join } from "node:path";
import type { DiffPayload, RepoStatus, RepoStatusFile } from "./types";

type GitResult = { ok: boolean; stdout: string; stderr: string; code: number };

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr, code };
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return null;
  return r.stdout.trim() || null;
}

export async function headSha(root: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "HEAD"]);
  if (!r.ok) return null;
  return r.stdout.trim() || null;
}

export async function currentBranch(root: string): Promise<string> {
  // symbolic-ref works even on an unborn branch (a fresh repo with no commits).
  const sym = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (sym.ok && sym.stdout.trim()) return sym.stdout.trim();
  const short = await git(root, ["rev-parse", "--short", "HEAD"]);
  if (short.ok && short.stdout.trim()) return `detached@${short.stdout.trim()}`;
  return "(unknown)";
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  const r = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.ok;
}

export async function status(root: string): Promise<RepoStatus> {
  const [branch, head] = await Promise.all([currentBranch(root), headSha(root)]);
  const r = await git(root, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]);
  const files: RepoStatusFile[] = [];
  let ahead = 0;
  let behind = 0;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const m = line.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
      if (m) {
        ahead = parseInt(m[1] ?? "0", 10) || 0;
        behind = parseInt(m[2] ?? m[3] ?? "0", 10) || 0;
      }
      continue;
    }
    files.push({ index: line[0], worktree: line[1], path: line.slice(3) });
  }
  return { branch, head, ahead, behind, files, isRepo: true };
}

// Comment threads live under .reviews/ as their own truth (surfaced in the
// Review panel), so keep them out of the code/content diff — otherwise leaving
// a comment spawns a .reviews/*.json that clutters the very diff you're reviewing.
const EXCLUDE_REVIEWS = ["--", ".", ":(exclude).reviews"];

// The diff view's source of truth. `base` null === the live uncommitted diff
// (staged + unstaged + new files). A base ref produces the PR-style
// `base...HEAD` diff.
export async function getDiff(root: string, base: string | null): Promise<DiffPayload> {
  const head = await headSha(root);

  if (base) {
    if (!(await refExists(root, base))) {
      throw new Error(`base ref not found: ${base}`);
    }
    const r = await git(root, ["diff", "--no-color", "--no-ext-diff", `${base}...HEAD`, ...EXCLUDE_REVIEWS]);
    return { raw: r.stdout, base, mode: "branch", head };
  }

  let raw = "";
  if (head) {
    const r = await git(root, ["diff", "--no-color", "--no-ext-diff", "HEAD", ...EXCLUDE_REVIEWS]);
    raw = r.stdout;
  } else {
    // Unborn branch: nothing is committed, so "uncommitted" === staged.
    const r = await git(root, ["diff", "--no-color", "--no-ext-diff", "--cached", ...EXCLUDE_REVIEWS]);
    raw = r.stdout;
  }
  raw += await untrackedDiff(root);
  return { raw, base: null, mode: "working", head };
}

// `git diff HEAD` omits untracked files, but new files are central to the
// agentic workflow — so synthesize an added-file diff for each untracked file.
async function untrackedDiff(root: string): Promise<string> {
  try {
    const r = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (!r.ok) return "";
    const files = r.stdout
      .split("\0")
      .filter((f) => f && !f.startsWith(".reviews/"))
      .slice(0, 100);
    let out = "";
    for (const f of files) {
      try {
        if (statSync(join(root, f)).size > 512 * 1024) continue; // skip large blobs
      } catch {
        continue;
      }
      // --no-index returns exit code 1 when files differ; that is expected.
      const d = await git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "/dev/null", f]);
      if (d.code <= 1 && d.stdout) out += d.stdout;
    }
    return out;
  } catch {
    return "";
  }
}
