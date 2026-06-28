import { useCallback, useEffect, useRef, useState } from "react";
import { call, fetchFile, fetchWorkspace, subscribe } from "./api";
import { DiffView } from "./components/DiffView";
import { Explorer } from "./components/Explorer";
import { FileView } from "./components/FileView";
import { ReviewPanel } from "./components/ReviewPanel";
import type { ThreadActions } from "./components/ThreadCard";
import type { DiffMode, FilePayload, NewComment, Workspace } from "./types";

export default function App() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [file, setFile] = useState<FilePayload | null>(null);
  const [mode, setMode] = useState<DiffMode>({ kind: "working" });
  const [refInput, setRefInput] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pane, setPane] = useState<"file" | "diff">("file");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [showExplorer, setShowExplorer] = useState(true);
  const [showReview, setShowReview] = useState(true);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const pathRef = useRef(selectedPath);
  pathRef.current = selectedPath;
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFile = useCallback(async (path: string) => {
    const f = await fetchFile(path, modeRef.current);
    setFile(f);
    return f;
  }, []);

  // Re-project the workspace (and the open file) from the server. Debounced so a
  // burst of SSE change events coalesces.
  const refetch = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const w = await fetchWorkspace(modeRef.current);
        setWs(w);
        setError(null);
        let p = pathRef.current;
        if (!p || !w.tree.some((e) => e.path === p)) {
          p = w.tree.find((e) => e.path === "INTENT.md")?.path ?? w.tree.find((e) => e.status)?.path ?? w.tree[0]?.path ?? null;
          setSelectedPath(p);
        }
        if (p) await loadFile(p);
        else setFile(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, 60);
  }, [loadFile]);

  useEffect(() => refetch(), [mode, refetch]);
  useEffect(() => subscribe(refetch, setConnected), [refetch]);

  const selectFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      try {
        const f = await loadFile(path);
        setPane(f.diff ? "diff" : "file");
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadFile],
  );

  const act = useCallback(
    async (name: string, args: unknown) => {
      try {
        await call(name, args);
        setError(null);
        refetch();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refetch],
  );

  const actions: ThreadActions = {
    reply: (id, text) => act("replyComment", { id, text }),
    resolve: (id) => act("resolveComment", { id }),
    reopen: (id) => act("reopenComment", { id }),
    apply: (id) => act("applySuggestion", { id }),
    dismiss: (id) => act("dismissSuggestion", { id }),
  };

  const addComment = (c: NewComment, text: string) =>
    act("addComment", { path: c.path, startLine: c.startLine, endLine: c.endLine, text, context: c.content });

  const focusThread = useCallback(
    (id: string) => {
      setActiveThreadId(id);
      const t = wsRef.current?.threads.find((x) => x.id === id);
      if (t && t.anchor.path !== pathRef.current) selectFile(t.anchor.path);
      setTimeout(() => document.getElementById(`thread-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    },
    [selectFile],
  );

  function setKind(kind: DiffMode["kind"]) {
    setMode(kind === "working" ? { kind: "working" } : { kind, ref: refInput.trim() || null });
  }

  if (!ws) {
    return <div className="boot">{error ? <div className="error">Helm error: {error}</div> : "Loading…"}</div>;
  }

  const fileThreads =
    selectedPath != null
      ? ws.threads.filter((t) => t.anchor.path === selectedPath && (showResolved || t.effectiveStatus !== "resolved"))
      : [];
  const refs = [...ws.repo.refs.branches, ...ws.repo.refs.tags];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">⎈ Helm</div>
        <div className="repo">
          <strong>{ws.repo.name}</strong>
          <span className="branch">{ws.repo.branch}</span>
          {ws.repo.head && <span className="sha">{ws.repo.head.slice(0, 7)}</span>}
        </div>

        <div className="mode-bar">
          <select value={mode.kind} onChange={(e) => setKind(e.target.value as DiffMode["kind"])}>
            <option value="working">working tree</option>
            <option value="branch">vs branch</option>
            <option value="ref">vs commit/tag</option>
          </select>
          {mode.kind !== "working" && (
            <>
              <input
                list="helm-refs"
                value={refInput}
                placeholder="ref…"
                onChange={(e) => setRefInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setMode({ kind: mode.kind, ref: refInput.trim() || null });
                }}
                onBlur={() => setMode({ kind: mode.kind, ref: refInput.trim() || null })}
              />
              <datalist id="helm-refs">
                {refs.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </>
          )}
        </div>

        <span className="spacer" />
        <div className="toggles">
          <button className={`btn small${showExplorer ? " on" : ""}`} onClick={() => setShowExplorer((s) => !s)}>
            Files
          </button>
          <button className={`btn small${showReview ? " on" : ""}`} onClick={() => setShowReview((s) => !s)}>
            Review
          </button>
        </div>
        <div className={`conn ${connected ? "ok" : "down"}`}>{connected ? "live" : "offline"}</div>
      </header>

      {error && <div className="error-bar">{error}</div>}

      <div className="loop-hint">
        Comment on a file or its diff → tell your agent <em>“address the open review comments”</em> → it edits files
        and the views update live. <strong>You</strong> commit to accept.
      </div>

      <main className="workbench">
        {showExplorer && (
          <div className="col explorer-col">
            <Explorer tree={ws.tree} selectedPath={selectedPath} onSelect={selectFile} />
          </div>
        )}

        <div className="col main-col">
          {file ? (
            <section className="view">
              <header className="view-head">
                <span className="fpath">{file.path}</span>
                {file.status && <span className={`gstatus ${file.status}`}>{file.status}</span>}
                <span className="spacer" />
                <div className="pane-toggle">
                  <button className={pane === "file" ? "on" : ""} onClick={() => setPane("file")}>
                    File
                  </button>
                  <button
                    className={pane === "diff" ? "on" : ""}
                    onClick={() => setPane("diff")}
                    disabled={!file.diff}
                    title={file.diff ? "" : "no changes in this mode"}
                  >
                    Diff
                  </button>
                </div>
              </header>
              {pane === "file" ? (
                <FileView
                  file={file}
                  threads={fileThreads}
                  actions={actions}
                  activeThreadId={activeThreadId}
                  onFocusThread={focusThread}
                  onAddComment={addComment}
                />
              ) : (
                <DiffView
                  path={file.path}
                  diff={file.diff}
                  threads={fileThreads}
                  actions={actions}
                  activeThreadId={activeThreadId}
                  onFocusThread={focusThread}
                  onAddComment={addComment}
                />
              )}
            </section>
          ) : (
            <div className="empty big">
              <p>Select a file from the explorer.</p>
            </div>
          )}
        </div>

        {showReview && (
          <div className="col review-col">
            <ReviewPanel
              threads={ws.threads}
              actions={actions}
              activeThreadId={activeThreadId}
              onFocus={focusThread}
              showResolved={showResolved}
              onToggleResolved={() => setShowResolved((s) => !s)}
            />
          </div>
        )}
      </main>
    </div>
  );
}
