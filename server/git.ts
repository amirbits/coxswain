// git CLI adapter. Helm holds no authoritative state — every fact about history,
// diff, branch, and file content is read from git / the filesystem on demand.

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ChangeStatus,
  DiffMode,
  DiffPayload,
  FileKind,
  GitStatus,
  GitTopology,
  Remote,
  RepoStatus,
  RepoStatusFile,
  Worktree,
} from "./types";

type GitResult = { ok: boolean; stdout: string; stderr: string; code: number };

// Comment threads are their own truth (the Review panel), kept out of the diff.
const EXCLUDE_REVIEWS = ["--", ".", ":(exclude).reviews"];

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr, code };
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.stdout.trim() || null : null;
}

export async function headSha(root: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.stdout.trim() || null : null;
}

export async function currentBranch(root: string): Promise<string> {
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
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      // "## main...origin/main [ahead 2, behind 1]" — upstream + tracking counts.
      const refs = line.slice(3).split(" ")[0]; // "main...origin/main" or "HEAD"
      const dots = refs.indexOf("...");
      if (dots >= 0) upstream = refs.slice(dots + 3) || null;
      ahead = parseInt(line.match(/ahead (\d+)/)?.[1] ?? "0", 10) || 0;
      behind = parseInt(line.match(/behind (\d+)/)?.[1] ?? "0", 10) || 0;
      continue;
    }
    files.push({ index: line[0], worktree: line[1], path: line.slice(3) });
  }
  return { branch, head, upstream, ahead, behind, files };
}

export async function listRefs(root: string): Promise<{ branches: string[]; tags: string[]; remoteBranches: string[] }> {
  const [b, t, rb] = await Promise.all([
    git(root, ["branch", "--format=%(refname:short)"]),
    git(root, ["tag", "--list", "--sort=-creatordate"]),
    git(root, ["branch", "-r", "--format=%(refname:short)"]),
  ]);
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  return {
    branches: lines(b.stdout),
    tags: lines(t.stdout),
    remoteBranches: lines(rb.stdout).filter((x) => !x.endsWith("/HEAD")),
  };
}

// --- Source control (Slice A): read-only status/topology + the one safe action.

export async function stashCount(root: string): Promise<number> {
  const r = await git(root, ["stash", "list"]);
  return r.ok ? r.stdout.split("\n").filter(Boolean).length : 0;
}

// Working-tree status grouped into staged / unstaged / untracked (a file can be
// in both staged and unstaged). .reviews/ is excluded — review truth, not repo
// content.
export async function gitStatus(root: string): Promise<GitStatus> {
  const [st, stashes] = await Promise.all([status(root), stashCount(root)]);
  const staged: RepoStatusFile[] = [];
  const unstaged: RepoStatusFile[] = [];
  const untracked: RepoStatusFile[] = [];
  for (const f of st.files) {
    if (!keepPath(f.path)) continue;
    if (f.index === "?" && f.worktree === "?") {
      untracked.push(f);
      continue;
    }
    if (f.index !== " ") staged.push(f);
    if (f.worktree !== " ") unstaged.push(f);
  }
  return { branch: st.branch, head: st.head, upstream: st.upstream, ahead: st.ahead, behind: st.behind, staged, unstaged, untracked, stashCount: stashes };
}

export async function listWorktrees(root: string): Promise<Worktree[]> {
  const r = await git(root, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const here = resolve(root);
  const out: Worktree[] = [];
  let cur: (Partial<Worktree> & { path?: string }) | null = null;
  const flush = () => {
    if (!cur?.path) return;
    out.push({
      path: cur.path,
      head: cur.head ?? null,
      branch: cur.branch ?? null,
      detached: !!cur.detached,
      bare: !!cur.bare,
      locked: !!cur.locked,
      current: resolve(cur.path) === here,
    });
  };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length) };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line.startsWith("locked")) {
      cur.locked = true;
    }
  }
  flush();
  return out;
}

export async function listRemotes(root: string): Promise<Remote[]> {
  const r = await git(root, ["remote", "-v"]);
  if (!r.ok) return [];
  const seen = new Map<string, string | null>();
  for (const line of r.stdout.split("\n")) {
    if (!line.endsWith("(fetch)")) continue;
    const [name, rest] = line.split("\t");
    if (name && !seen.has(name)) seen.set(name, (rest ?? "").replace(/ \(fetch\)$/, "") || null);
  }
  return [...seen].map(([name, fetchUrl]) => ({ name, fetchUrl }));
}

export async function gitTopology(root: string): Promise<GitTopology> {
  const [worktrees, remotes, refs] = await Promise.all([listWorktrees(root), listRemotes(root), listRefs(root)]);
  return { worktrees, remotes, remoteBranches: refs.remoteBranches };
}

// The one mutating op in Slice A — and it's safe: fetch only updates
// remote-tracking refs, never the working tree or your local branches.
export async function gitFetch(root: string, remote?: string | null): Promise<GitStatus> {
  const args = ["fetch", "--prune"];
  if (remote) args.push(remote);
  const r = await git(root, args);
  if (!r.ok) throw new Error(r.stderr.trim() || "git fetch failed");
  return gitStatus(root);
}

// Tracked + untracked (non-ignored) files, minus .reviews/.
export async function listFiles(root: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(root, ["ls-files", "-z"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const set = new Set<string>();
  for (const f of tracked.stdout.split("\0")) if (keepPath(f)) set.add(f);
  for (const f of untracked.stdout.split("\0")) if (keepPath(f)) set.add(f);
  return [...set].sort();
}

function keepPath(f: string): boolean {
  return !!f && !f.startsWith(".reviews/") && f !== ".reviews";
}

// The git range args for a mode (target is HEAD/working; see DiffMode).
function rangeArgs(mode: DiffMode, head: string | null): string[] {
  if (mode.kind === "staged") return ["--cached"]; // index vs HEAD
  if (mode.kind === "working" || !mode.ref) return head ? ["HEAD"] : ["--cached"];
  if (mode.kind === "branch") return [`${mode.ref}...HEAD`]; // merge-base (MR style)
  return [`${mode.ref}..HEAD`]; // vs a commit / tag
}

// Changed files in a mode → path -> status letter (A/M/D/R/C).
export async function changedFiles(root: string, mode: DiffMode): Promise<Record<string, ChangeStatus>> {
  const head = await headSha(root);
  const r = await git(root, ["diff", "--name-status", ...rangeArgs(mode, head), ...EXCLUDE_REVIEWS]);
  const map: Record<string, ChangeStatus> = {};
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const code = parts[0]?.[0] as ChangeStatus;
    const path = parts[parts.length - 1]; // for renames, the new path
    if (path) map[path] = code;
  }
  if (mode.kind === "working") {
    const u = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const f of u.stdout.split("\0")) if (keepPath(f)) map[f] = "A";
  }
  return map;
}

// Single-file change status for a mode — scoped to one path, so opening a file
// doesn't run a whole-repo name-status (which getFile previously did per open).
export async function fileStatus(root: string, path: string, mode: DiffMode): Promise<ChangeStatus> {
  const head = await headSha(root);
  const r = await git(root, ["diff", "--name-status", ...rangeArgs(mode, head), "--", path]);
  const line = r.stdout.split("\n").find(Boolean);
  if (line) return (line.split("\t")[0]?.[0] as ChangeStatus) ?? null;
  if (mode.kind === "working") {
    const u = await git(root, ["ls-files", "--others", "--exclude-standard", "--", path]);
    if (u.stdout.trim()) return "A";
  }
  return null;
}

// Whole-repo diff for a mode (used by the CLI and the "all changes" view).
export async function diffAll(root: string, mode: DiffMode): Promise<DiffPayload> {
  const head = await headSha(root);
  if (mode.ref && !(await refExists(root, mode.ref))) throw new Error(`ref not found: ${mode.ref}`);
  const r = await git(root, ["diff", "--no-color", "--no-ext-diff", ...rangeArgs(mode, head), ...EXCLUDE_REVIEWS]);
  let raw = r.stdout;
  if (mode.kind === "working") raw += await untrackedDiff(root);
  return { raw, mode, head };
}

// Per-file diff for a mode.
export async function diffFile(root: string, path: string, mode: DiffMode): Promise<string> {
  const head = await headSha(root);
  if (mode.ref && !(await refExists(root, mode.ref))) throw new Error(`ref not found: ${mode.ref}`);
  const r = await git(root, ["diff", "--no-color", "--no-ext-diff", ...rangeArgs(mode, head), "--", path]);
  if (r.stdout) return r.stdout;
  // An *untracked* new file has no HEAD diff — synthesize an added-file diff for
  // it. A tracked file with no changes correctly returns "" (don't synth those,
  // or every committed file would render as all-added).
  if (mode.kind === "working" && existsSync(join(root, path))) {
    const tracked = await git(root, ["ls-files", "--error-unmatch", "--", path]);
    if (!tracked.ok) {
      const u = await git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "/dev/null", path]);
      if (u.code <= 1) return u.stdout;
    }
  }
  return "";
}

async function untrackedDiff(root: string): Promise<string> {
  try {
    const r = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (!r.ok) return "";
    const files = r.stdout.split("\0").filter((f) => keepPath(f));
    if (files.length > 100) console.warn(`helm: ${files.length} untracked files; diffing the first 100 (use 'git add' to stage the rest).`);
    const capped = files.slice(0, 100);
    let out = "";
    for (const f of capped) {
      try {
        if (statSync(join(root, f)).size > 512 * 1024) continue;
      } catch {
        continue;
      }
      const d = await git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "/dev/null", f]);
      if (d.code <= 1 && d.stdout) out += d.stdout;
    }
    return out;
  } catch {
    return "";
  }
}

// Current file content + kind. Guards against path traversal.
export async function readFileContent(
  root: string,
  path: string,
): Promise<{ content: string; exists: boolean; kind: FileKind }> {
  const full = resolve(root, path);
  if (full !== resolve(root) && !full.startsWith(resolve(root) + "/")) {
    throw new Error("path escapes repository");
  }
  if (!existsSync(full)) return { content: "", exists: false, kind: "text" };
  try {
    if (statSync(full).size > 2 * 1024 * 1024) return { content: "", exists: true, kind: "binary" };
  } catch {
    return { content: "", exists: false, kind: "text" };
  }
  const buf = await readFile(full);
  if (buf.includes(0)) return { content: "", exists: true, kind: "binary" };
  const kind: FileKind = /\.(md|markdown)$/i.test(path) ? "markdown" : "text";
  return { content: buf.toString("utf8"), exists: true, kind };
}
