import { useCallback, useEffect, useRef, useState } from "react";
import { call, editFile, fetchBoot, fetchFile, fetchWorkspace, subscribe } from "./api";
import { DiffView } from "./components/DiffView";
import { Explorer } from "./components/Explorer";
import { FileView } from "./components/FileView";
import { Palette } from "./components/Palette";
import { ReviewPanel } from "./components/ReviewPanel";
import { Toasts, useToasts } from "./components/Toasts";
import type { ThreadActions } from "./components/ThreadCard";
import type { DiffMode, FilePayload, NewComment, Workspace } from "./types";

export default function App() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [file, setFile] = useState<FilePayload | null>(null);
  const [mode, setMode] = useState<DiffMode>({ kind: "working" });
  const [pendingKind, setPendingKind] = useState<DiffMode["kind"]>("working");
  const [refInput, setRefInput] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pane, setPane] = useState<"file" | "diff">("file");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [showExplorer, setShowExplorer] = useState(true);
  const [showReview, setShowReview] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dark, setDark] = useState(() => {
    try {
      const v = localStorage.getItem("helm:theme");
      if (v) return v === "dark";
    } catch {}
    return false;
  });
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return localStorage.getItem("helm:hint-dismissed") === "1";
    } catch {
      return false;
    }
  });

  const toasts = useToasts();

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const pathRef = useRef(selectedPath);
  pathRef.current = selectedPath;
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while the editor has unsaved changes — SSE-driven refetch must not
  // clobber the buffer (DESIGN.md §12; C1). Set by FileView via onEditingChange.
  const editingRef = useRef(false);

  const loadFile = useCallback(async (path: string) => {
    const f = await fetchFile(path, modeRef.current);
    setFile(f);
    return f;
  }, []);

  // Re-project the workspace (and the open file) from the server. Debounced so a
  // burst of SSE change events coalesces. `pickPane` is set only on a
  // mode change / explicit selection — never in the SSE path, or an external
  // change would yank the pane out from under you while you're reading.
  const refetch = useCallback((opts?: { pickPane?: boolean }) => {
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
        if (p) {
          // Don't clobber a buffer being edited — workspace/threads still refresh.
          if (editingRef.current && p === pathRef.current) return;
          const f = await loadFile(p);
          if (opts?.pickPane) setPane(f.diff ? "diff" : "file");
        } else setFile(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, 60);
  }, [loadFile]);

  // Boot: apply the --base flag's chosen mode (if any) before the first render.
  useEffect(() => {
    fetchBoot()
      .then((b) => {
        setMode(b.mode);
        setPendingKind(b.mode.kind);
        if (b.mode.ref) setRefInput(b.mode.ref);
      })
      .catch(() => {});
  }, []);

  useEffect(() => refetch({ pickPane: true }), [mode, refetch]);
  useEffect(() => subscribe(() => refetch(), setConnected), [refetch]);

  // Persist + apply the dark theme on the document root.
  useEffect(() => {
    const el = document.documentElement;
    if (dark) el.setAttribute("data-theme", "dark");
    else el.removeAttribute("data-theme");
    try {
      localStorage.setItem("helm:theme", dark ? "dark" : "light");
    } catch {}
  }, [dark]);

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
    async (name: string, args: unknown, okMsg?: string) => {
      try {
        await call(name, args);
        setError(null);
        if (okMsg) toasts.ok(okMsg);
        refetch();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        toasts.err(msg);
      }
    },
    [refetch, toasts],
  );

  const actions: ThreadActions = {
    reply: (id, text) => act("replyComment", { id, text }, "Replied"),
    resolve: (id) => act("resolveComment", { id }, "Resolved"),
    reopen: (id) => act("reopenComment", { id }, "Reopened"),
    apply: (id) => act("applySuggestion", { id }, "Suggestion applied"),
    dismiss: (id) => act("dismissSuggestion", { id }, "Suggestion dismissed"),
  };

  const addComment = (c: NewComment, text: string) =>
    act("addComment", { path: c.path, startLine: c.startLine, endLine: c.endLine, text, context: c.content }, "Comment added");

  // Write-through save for the editor (C1). Never commits.
  const saveFile = useCallback(
    async (path: string, content: string) => {
      try {
        await editFile(path, content);
        editingRef.current = false;
        setError(null);
        toasts.ok("Saved");
        await refetch({ pickPane: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        toasts.err(msg);
      }
    },
    [refetch, toasts],
  );

  const focusThread = useCallback(
    (id: string) => {
      setActiveThreadId(id);
      const t = wsRef.current?.threads.find((x) => x.id === id);
      if (t && t.anchor.path !== pathRef.current) selectFile(t.anchor.path);
      setTimeout(() => document.getElementById(`thread-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    },
    [selectFile],
  );

  // Diff mode selection (A2): the select reflects the user's choice
  // (pendingKind); a non-working mode only takes effect once a ref is entered,
  // so we never silently render the working-tree diff as a "branch" diff.
  function chooseKind(kind: DiffMode["kind"]) {
    setPendingKind(kind);
    if (kind === "working") {
      setRefInput("");
      setMode({ kind: "working" });
    } else {
      const ref = refInput.trim();
      setMode(ref ? { kind, ref } : { kind: "working" });
    }
  }
  function commitRef() {
    const ref = refInput.trim();
    if (pendingKind === "working" || !ref) return;
    setMode({ kind: pendingKind, ref });
  }
  const refMissing = pendingKind !== "working" && mode.kind === "working";

  // Keyboard shortcuts (C5). ⌘K works everywhere; single-key shortcuts (j/k/1/2)
  // are suppressed while the focus is in an input, textarea, contentEditable, or
  // the CodeMirror editor so typing never triggers navigation.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          t.closest(".cm-editor") != null);
      if (typing) return;
      const tree = wsRef.current?.tree ?? [];
      if (e.key === "j" || e.key === "k") {
        if (!tree.length) return;
        const paths = tree.map((x) => x.path);
        const idx = pathRef.current ? paths.indexOf(pathRef.current) : -1;
        const dir = e.key === "j" ? 1 : -1;
        const next = paths[Math.max(0, Math.min(paths.length - 1, (idx < 0 ? 0 : idx) + dir))];
        if (next) selectFile(next);
        e.preventDefault();
      } else if (e.key === "1") {
        setPane("file");
      } else if (e.key === "2") {
        setPane("diff");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectFile]);

  if (!ws) {
    return <div className="boot">{error ? <div className="error">Helm error: {error}</div> : "Loading…"}</div>;
  }

  const fileThreads =
    selectedPath != null
      ? ws.threads.filter((t) => t.anchor.path === selectedPath && (showResolved || t.effectiveStatus !== "resolved"))
      : [];
  const refs = [...ws.repo.refs.branches, ...ws.repo.refs.tags];

  const paletteActions = [
    { id: "open-intent", label: "Open INTENT.md", run: () => selectFile("INTENT.md") },
    { id: "toggle-explorer", label: "Toggle Files pane", run: () => setShowExplorer((s) => !s) },
    { id: "toggle-review", label: "Toggle Review pane", run: () => setShowReview((s) => !s) },
    { id: "toggle-dark", label: dark ? "Light mode" : "Dark mode", run: () => setDark((d) => !d) },
    { id: "pane-file", label: "View: File", hint: "1", run: () => setPane("file") },
    { id: "pane-diff", label: "View: Diff", hint: "2", run: () => setPane("diff") },
    { id: "mode-working", label: "Diff mode: working tree", run: () => chooseKind("working") },
    { id: "mode-branch", label: "Diff mode: vs branch…", run: () => chooseKind("branch") },
    { id: "mode-ref", label: "Diff mode: vs commit/tag…", run: () => chooseKind("ref") },
    { id: "toggle-resolved", label: showResolved ? "Hide resolved" : "Show resolved", run: () => setShowResolved((s) => !s) },
    {
      id: "resolve-all",
      label: "Resolve all open threads",
      run: () => {
        const open = (wsRef.current?.threads ?? []).filter((t) => t.effectiveStatus === "open");
        if (!open.length) {
          toasts.ok("No open threads");
          return;
        }
        Promise.all(open.map((t) => call("resolveComment", { id: t.id })))
          .then(() => {
            toasts.ok(`Resolved ${open.length}`);
            refetch();
          })
          .catch((e: unknown) => toasts.err(e instanceof Error ? e.message : String(e)));
      },
    },
  ];

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
          <select value={pendingKind} onChange={(e) => chooseKind(e.target.value as DiffMode["kind"])}>
            <option value="working">working tree</option>
            <option value="branch">vs branch</option>
            <option value="ref">vs commit/tag</option>
          </select>
          {pendingKind !== "working" && (
            <>
              <input
                list="helm-refs"
                value={refInput}
                placeholder="ref…"
                onChange={(e) => setRefInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRef();
                }}
                onBlur={commitRef}
              />
              <datalist id="helm-refs">
                {refs.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
              {refMissing && <span className="mode-hint">enter a ref</span>}
            </>
          )}
        </div>

        <span className="spacer" />
        <button className="btn small" onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)">
          ⌘K
        </button>
        <div className="toggles">
          <button className={`btn small${showExplorer ? " on" : ""}`} onClick={() => setShowExplorer((s) => !s)}>
            Files
          </button>
          <button className={`btn small${showReview ? " on" : ""}`} onClick={() => setShowReview((s) => !s)}>
            Review
          </button>
          <button className={`btn small${dark ? " on" : ""}`} onClick={() => setDark((d) => !d)} title="Dark mode">
            {dark ? "☾" : "☀"}
          </button>
        </div>
        <div className={`conn ${connected ? "ok" : "down"}`}>{connected ? "live" : "offline"}</div>
      </header>

      {error && <div className="error-bar">{error}</div>}

      {!hintDismissed && (
        <div className="loop-hint">
          <span>
            Comment on a file or its diff → tell your agent <em>“address the open review comments”</em> → it edits
            files and the views update live. <strong>You</strong> commit to accept.
          </span>
          <button
            className="btn small ghost"
            onClick={() => {
              setHintDismissed(true);
              try {
                localStorage.setItem("helm:hint-dismissed", "1");
              } catch {}
            }}
          >
            Dismiss
          </button>
        </div>
      )}

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
                  onSave={saveFile}
                  onEditingChange={(editing) => {
                    editingRef.current = editing;
                  }}
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

      {paletteOpen && (
        <Palette actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      )}
      <Toasts toasts={toasts.items} />
    </div>
  );
}
