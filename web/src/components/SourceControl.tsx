import type { GitStatus, GitTopology, RepoStatusFile } from "../types";
import { basename } from "../util";

// Slice A: a read-only Source Control rail. Orientation only — branch/upstream,
// ahead/behind, the working-tree status grouped staged/unstaged/untracked, plus
// stashes / worktrees / remotes — and one safe action, Fetch. Staging, commit,
// discard, and switching are deferred to Slice B/C (they need guardrails).

type Props = {
  status: GitStatus | null;
  topology: GitTopology | null;
  onOpen: (path: string) => void;
  onFetch: () => void;
  fetching: boolean;
};

const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
};
const baseDir = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const letterClass = (l: string) =>
  ({ M: "mod", A: "add", D: "del", R: "ren", C: "cpy", U: "unt" } as Record<string, string>)[l] ?? "mod";

function FileRow({ f, letter, onOpen }: { f: RepoStatusFile; letter: string; onOpen: (p: string) => void }) {
  return (
    <div className="sc-file" onClick={() => onOpen(f.path)} title={f.path}>
      <span className={`gbadge ${letterClass(letter)}`}>{letter}</span>
      <span className="sc-fname">{basename(f.path)}</span>
      {dirOf(f.path) && <span className="sc-fdir">{dirOf(f.path)}</span>}
    </div>
  );
}

function Group({ label, files, col, onOpen }: { label: string; files: RepoStatusFile[]; col: "index" | "worktree" | "untracked"; onOpen: (p: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="sc-section">
      <div className="sc-head">
        {label} <span className="sc-count">{files.length}</span>
      </div>
      {files.map((f) => {
        const letter = col === "untracked" ? "U" : (f[col] || "").trim() || "?";
        return <FileRow key={f.path} f={f} letter={letter} onOpen={onOpen} />;
      })}
    </div>
  );
}

export function SourceControl({ status, topology, onOpen, onFetch, fetching }: Props) {
  const noRemotes = !topology?.remotes.length;
  return (
    <aside className="sc">
      <div className="sc-branchbar">
        <div className="sc-branchline">
          <span className="sc-branch">⎇ {status?.branch ?? "…"}</span>
          {status?.upstream && <span className="sc-upstream">→ {status.upstream}</span>}
          {!!status && (status.ahead > 0 || status.behind > 0) && (
            <span className="ab-chip">
              {status.ahead > 0 && <span className="ahead">↑{status.ahead}</span>}
              {status.behind > 0 && <span className="behind">↓{status.behind}</span>}
            </span>
          )}
        </div>
        <button className="btn small" onClick={onFetch} disabled={fetching || noRemotes} title={noRemotes ? "no remotes configured" : "Fetch + prune (safe — never touches the working tree)"}>
          {fetching ? "Fetching…" : "Fetch"}
        </button>
      </div>

      {!status ? (
        <div className="sc-empty">Loading…</div>
      ) : status.staged.length + status.unstaged.length + status.untracked.length === 0 ? (
        <div className="sc-empty">Working tree clean</div>
      ) : (
        <>
          <Group label="Staged" files={status.staged} col="index" onOpen={onOpen} />
          <Group label="Changes" files={status.unstaged} col="worktree" onOpen={onOpen} />
          <Group label="Untracked" files={status.untracked} col="untracked" onOpen={onOpen} />
        </>
      )}

      {!!status?.stashCount && (
        <div className="sc-section">
          <div className="sc-head">Stashes</div>
          <div className="sc-mini">{status.stashCount} stash{status.stashCount > 1 ? "es" : ""}</div>
        </div>
      )}

      {topology && topology.worktrees.length > 0 && (
        <div className="sc-section">
          <div className="sc-head">Worktrees <span className="sc-count">{topology.worktrees.length}</span></div>
          {topology.worktrees.map((w) => (
            <div className={`sc-mini wt${w.current ? " current" : ""}`} key={w.path} title={w.path}>
              <span className="wt-branch">{w.branch ?? (w.detached ? `detached@${w.head?.slice(0, 7) ?? "?"}` : "—")}</span>
              <span className="wt-path">{w.current ? "· this" : baseDir(w.path)}</span>
            </div>
          ))}
        </div>
      )}

      {topology && topology.remotes.length > 0 && (
        <div className="sc-section">
          <div className="sc-head">Remotes</div>
          {topology.remotes.map((r) => (
            <div className="sc-mini" key={r.name} title={r.fetchUrl ?? ""}>
              <span className="rmt-name">{r.name}</span>
              <span className="rmt-url">{r.fetchUrl}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
