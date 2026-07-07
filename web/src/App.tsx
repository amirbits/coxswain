import { useCallback, useEffect, useRef, useState } from "react";
import { call, editFile, fetchBoot, fetchChanges, fetchFile, fetchGitStatus, fetchGitTopology, fetchWorkspace, gitFetch, subscribe } from "./api";
import { ChangesView } from "./components/ChangesView";
import { DiffView } from "./components/DiffView";
import { Explorer } from "./components/Explorer";
import { FileView } from "./components/FileView";
import { TerminalPane } from "./components/Terminal";
import { Palette } from "./components/Palette";
import { ReviewPanel } from "./components/ReviewPanel";
import { SourceControl } from "./components/SourceControl";
import { Toasts, useToasts } from "./components/Toasts";
import type { ThreadActions } from "./components/ThreadCard";
import type { DiffMode, FilePayload, GitStatus, GitTopology, NewComment, Workspace } from "./types";

type Tab = { kind: "changes" } | { kind: "file"; path: string } | { kind: "terminal"; id: string; title: string };
const CHANGES_KEY = " changes";
const keyOf = (t: Tab): string => (t.kind === "changes" ? CHANGES_KEY : t.kind === "terminal" ? ` t:${t.id}` : t.path);

export default function App() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FilePayload>>({});
  const [changes, setChanges] = useState<{ raw: string; mode: DiffMode } | null>(null);
  const [paneByPath, setPaneByPath] = useState<Record<string, "file" | "diff">>({});
  const [mode, setMode] = useState<DiffMode>({ kind: "working" });
  // The repo-relative subdir the view is focused on. `undefined` until boot
  // resolves it — while undefined we send no scope param, so the server applies
  // the launch scope. After that it's an explicit string ("" = whole repo).
  const [scope, setScope] = useState<string | undefined>(undefined);
  const [pendingKind, setPendingKind] = useState<DiffMode["kind"]>("working");
  const [refInput, setRefInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [showExplorer, setShowExplorer] = useState(true);
  const [showReview, setShowReview] = useState(true);
  const [showSource, setShowSource] = useState(() => {
    try {
      return localStorage.getItem("cox:show-source") !== "0";
    } catch {
      return true;
    }
  });
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [topology, setTopology] = useState<GitTopology | null>(null);
  const [fetching, setFetching] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dark, setDark] = useState(() => {
    try {
      const v = localStorage.getItem("cox:theme");
      if (v) return v === "dark";
    } catch {}
    return false;
  });
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return localStorage.getItem("cox:hint-dismissed") === "1";
    } catch {
      return false;
    }
  });

  const toasts = useToasts();

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const bootedRef = useRef(false);
  const editingPathRef = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePath = (() => {
    const t = tabs.find((x) => keyOf(x) === activeKey);
    return t?.kind === "file" ? t.path : null;
  })();
  const activePathRef = useRef<string | null>(activePath);
  activePathRef.current = activePath;

  // --- loaders ---

  const loadChanges = useCallback(async () => {
    const c = await fetchChanges(modeRef.current, scopeRef.current);
    setChanges({ raw: c.raw, mode: c.mode });
  }, []);

  const openFile = useCallback((path: string) => {
    setTabs((ts) => (ts.some((t) => t.kind === "file" && t.path === path) ? ts : [...ts, { kind: "file", path }]));
    setActiveKey(path);
    fetchFile(path, modeRef.current)
      .then((f) => {
        setFiles((m) => ({ ...m, [path]: f }));
        setPaneByPath((p) => (p[path] != null ? p : { ...p, [path]: f.diff ? "diff" : "file" }));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const openChanges = useCallback(() => {
    setTabs((ts) => (ts.some((t) => t.kind === "changes") ? ts : [{ kind: "changes" }, ...ts]));
    setActiveKey(CHANGES_KEY);
    loadChanges().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [loadChanges]);

  const termCounter = useRef(0);
  const openTerminal = useCallback(() => {
    const tab: Tab = { kind: "terminal", id: crypto.randomUUID(), title: `Terminal ${++termCounter.current}` };
    setTabs((ts) => [...ts, tab]);
    setActiveKey(keyOf(tab));
  }, []);

  const closeTab = useCallback((key: string) => {
    const ts = tabsRef.current;
    const idx = ts.findIndex((t) => keyOf(t) === key);
    const next = ts.filter((t) => keyOf(t) !== key);
    setTabs(next);
    if (activeKeyRef.current === key) {
      const fb = next[Math.max(0, idx - 1)];
      setActiveKey(fb ? keyOf(fb) : null);
    }
  }, []);

  // Re-project the workspace + every open tab. Debounced. `pickPane` re-derives
  // the active file's pane (mode change / explicit selection only — never SSE).
  const refetch = useCallback(
    (opts?: { pickPane?: boolean }) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        try {
          const w = await fetchWorkspace(modeRef.current, scopeRef.current);
          setWs(w);
          setError(null);

          if (!bootedRef.current) {
            bootedRef.current = true;
            if (tabsRef.current.length === 0) {
              const first = w.tree.find((e) => e.path === w.repo.intentPath)?.path ?? w.tree.find((e) => e.status)?.path ?? w.tree[0]?.path;
              if (first) {
                setTabs([{ kind: "file", path: first }]);
                setActiveKey(first);
                const f = await fetchFile(first, modeRef.current);
                setFiles({ [first]: f });
                setPaneByPath({ [first]: f.diff ? "diff" : "file" });
                return;
              }
            }
          }

          const fileTabs = tabsRef.current.filter((t): t is { kind: "file"; path: string } => t.kind === "file");
          await Promise.all(
            fileTabs.map(async (t) => {
              if (editingPathRef.current === t.path) return; // don't clobber a buffer being edited
              const f = await fetchFile(t.path, modeRef.current);
              setFiles((m) => ({ ...m, [t.path]: f }));
              if (opts?.pickPane && t.path === activeKeyRef.current) {
                setPaneByPath((p) => ({ ...p, [t.path]: f.diff ? "diff" : "file" }));
              }
            }),
          );
          if (tabsRef.current.some((t) => t.kind === "changes")) await loadChanges();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }, 60);
    },
    [loadChanges],
  );

  // On mode change, reset per-file pane memory (so each re-derives from its new
  // diff) and re-project.
  useEffect(() => {
    setPaneByPath({});
    refetch({ pickPane: true });
  }, [mode, refetch]);

  useEffect(() => {
    fetchBoot()
      .then((b) => {
        setMode(b.mode);
        setPendingKind(b.mode.kind);
        if (b.mode.ref) setRefInput(b.mode.ref);
        setScope(b.scope ?? "");
      })
      .catch(() => {});
  }, []);

  // Re-project when the focus scope changes (widen/narrow from the explorer).
  useEffect(() => {
    if (scope !== undefined) refetch();
  }, [scope, refetch]);

  const onScope = useCallback((next: string) => setScope(next), []);

  // Git source-control panel: status on every change, topology on mount + fetch.
  const loadGitStatus = useCallback(() => {
    fetchGitStatus().then(setGitStatus).catch(() => {});
  }, []);
  const loadTopology = useCallback(() => {
    fetchGitTopology().then(setTopology).catch(() => {});
  }, []);
  const onFetch = useCallback(() => {
    setFetching(true);
    gitFetch()
      .then((s) => {
        setGitStatus(s);
        loadTopology();
        toasts.ok("Fetched");
      })
      .catch((e) => toasts.err(e instanceof Error ? e.message : String(e)))
      .finally(() => setFetching(false));
  }, [loadTopology, toasts]);
  useEffect(() => {
    loadGitStatus();
    loadTopology();
  }, [loadGitStatus, loadTopology]);

  useEffect(() => subscribe(() => { refetch(); loadGitStatus(); }, setConnected), [refetch, loadGitStatus]);

  useEffect(() => {
    const el = document.documentElement;
    if (dark) el.setAttribute("data-theme", "dark");
    else el.removeAttribute("data-theme");
    try {
      localStorage.setItem("cox:theme", dark ? "dark" : "light");
    } catch {}
  }, [dark]);

  useEffect(() => {
    try {
      localStorage.setItem("cox:show-source", showSource ? "1" : "0");
    } catch {}
  }, [showSource]);

  // --- actions ---

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

  const saveFile = useCallback(
    async (path: string, content: string) => {
      try {
        await editFile(path, content);
        editingPathRef.current = null;
        setError(null);
        toasts.ok("Saved");
        refetch({ pickPane: true });
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
      if (t && t.anchor.path !== activePathRef.current) openFile(t.anchor.path);
      setTimeout(() => document.getElementById(`thread-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    },
    [openFile],
  );

  function setPane(p: "file" | "diff") {
    const path = activePathRef.current;
    if (path) setPaneByPath((m) => ({ ...m, [path]: p }));
  }

  // diff mode selection (A2)
  function chooseKind(kind: DiffMode["kind"]) {
    setPendingKind(kind);
    if (kind === "working" || kind === "staged") {
      setRefInput("");
      setMode({ kind });
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
  const refMissing = pendingKind !== "working" && pendingKind !== "staged" && mode.kind === "working";

  // keyboard shortcuts (C5)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest(".cm-editor") != null);
      if (typing) return;
      const tree = wsRef.current?.tree ?? [];
      if (e.key === "j" || e.key === "k") {
        if (!tree.length) return;
        const paths = tree.map((x) => x.path);
        const idx = activePathRef.current ? paths.indexOf(activePathRef.current) : -1;
        const dir = e.key === "j" ? 1 : -1;
        const next = paths[Math.max(0, Math.min(paths.length - 1, (idx < 0 ? 0 : idx) + dir))];
        if (next) openFile(next);
        e.preventDefault();
      } else if (e.key === "1") {
        setPane("file");
      } else if (e.key === "2") {
        setPane("diff");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFile]);

  if (!ws) {
    return <div className="boot">{error ? <div className="error">Coxswain error: {error}</div> : "Loading…"}</div>;
  }

  const activeTab = tabs.find((t) => keyOf(t) === activeKey) ?? null;
  const activeFile = activePath ? files[activePath] : undefined;
  const pane: "file" | "diff" = activePath ? paneByPath[activePath] ?? (activeFile?.diff ? "diff" : "file") : "file";
  const visibleThreads = ws.threads.filter((t) => showResolved || t.effectiveStatus !== "resolved");
  const fileThreads = activePath ? visibleThreads.filter((t) => t.anchor.path === activePath) : [];
  const refs = [...ws.repo.refs.branches, ...ws.repo.refs.remoteBranches, ...ws.repo.refs.tags];

  const paletteActions = [
    { id: "open-changes", label: "Open: All changes", run: openChanges },
    { id: "new-terminal", label: "New terminal", run: openTerminal },
    ...(ws.repo.scope ? [{ id: "scope-repo", label: "Scope: whole repository", run: () => onScope("") }] : []),
    { id: "open-intent", label: "Open intent", run: () => openFile(ws.repo.intentPath) },
    { id: "toggle-explorer", label: "Toggle Files pane", run: () => setShowExplorer((s) => !s) },
    { id: "toggle-source", label: "Toggle Source Control pane", run: () => setShowSource((s) => !s) },
    { id: "toggle-review", label: "Toggle Review pane", run: () => setShowReview((s) => !s) },
    { id: "toggle-dark", label: dark ? "Light mode" : "Dark mode", run: () => setDark((d) => !d) },
    { id: "pane-file", label: "View: File", hint: "1", run: () => setPane("file") },
    { id: "pane-diff", label: "View: Diff", hint: "2", run: () => setPane("diff") },
    { id: "mode-working", label: "Diff mode: working tree", run: () => chooseKind("working") },
    { id: "mode-staged", label: "Diff mode: staged", run: () => chooseKind("staged") },
    { id: "mode-branch", label: "Diff mode: vs branch…", run: () => chooseKind("branch") },
    { id: "mode-ref", label: "Diff mode: vs commit/tag…", run: () => chooseKind("ref") },
    { id: "git-fetch", label: "Git: fetch", run: onFetch },
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
        <div className="brand">🚣 Coxswain</div>
        <div className="repo">
          <strong>{ws.repo.name}</strong>
          <button className="branch" onClick={() => setShowSource((s) => !s)} title="Toggle Source Control">
            ⎇ {ws.repo.branch}
          </button>
          {(ws.repo.ahead > 0 || ws.repo.behind > 0) && (
            <span className="ab-chip">
              {ws.repo.ahead > 0 && <span className="ahead">↑{ws.repo.ahead}</span>}
              {ws.repo.behind > 0 && <span className="behind">↓{ws.repo.behind}</span>}
            </span>
          )}
          {ws.repo.head && <span className="sha">{ws.repo.head.slice(0, 7)}</span>}
          {ws.repo.scope && (
            <button
              className="scope-chip"
              onClick={() => onScope("")}
              title={`Focused on ${ws.repo.scope}/${ws.repo.elsewhere ? ` — ${ws.repo.elsewhere} changed elsewhere` : ""}. Click to view the whole repo.`}
            >
              ▸ {ws.repo.scope}/{ws.repo.elsewhere > 0 && <span className="scope-elsewhere">+{ws.repo.elsewhere}</span>}
            </button>
          )}
        </div>

        <div className="mode-bar">
          <select value={pendingKind} onChange={(e) => chooseKind(e.target.value as DiffMode["kind"])}>
            <option value="working">working tree</option>
            <option value="staged">staged</option>
            <option value="branch">vs branch</option>
            <option value="ref">vs commit/tag</option>
          </select>
          {pendingKind !== "working" && pendingKind !== "staged" && (
            <>
              <input
                list="cox-refs"
                value={refInput}
                placeholder="ref…"
                onChange={(e) => setRefInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRef();
                }}
                onBlur={commitRef}
              />
              <datalist id="cox-refs">
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
          <button className={`btn small${showSource ? " on" : ""}`} onClick={() => setShowSource((s) => !s)} title="Source Control">
            Source
          </button>
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
            Comment on a file or its diff → tell your agent <em>“address the open review comments”</em> → it edits files and
            the views update live. Review, then commit to accept.
          </span>
          <button
            className="btn small ghost"
            onClick={() => {
              setHintDismissed(true);
              try {
                localStorage.setItem("cox:hint-dismissed", "1");
              } catch {}
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <main className="workbench">
        {showSource && (
          <div className="col source-col">
            <SourceControl status={gitStatus} topology={topology} onOpen={openFile} onFetch={onFetch} fetching={fetching} />
          </div>
        )}
        {showExplorer && (
          <div className="col explorer-col">
            <Explorer
              tree={ws.tree}
              intentPath={ws.repo.intentPath}
              scope={ws.repo.scope}
              elsewhere={ws.repo.elsewhere}
              onScope={onScope}
              activeKey={activePath}
              changesActive={activeKey === CHANGES_KEY}
              onSelect={openFile}
              onOpenChanges={openChanges}
              onNewTerminal={openTerminal}
            />
          </div>
        )}

        <div className="col main-col">
          {tabs.length > 0 && (
            <div className="main-header">
              <div className="tabbar">
                {tabs.map((t) => {
                  const k = keyOf(t);
                  const label = t.kind === "changes" ? "✦ All changes" : t.kind === "terminal" ? `⌗ ${t.title}` : t.path.split("/").pop();
                  return (
                    <div key={k} className={`tab${activeKey === k ? " active" : ""}`} onClick={() => setActiveKey(k)} title={t.kind === "file" ? t.path : t.kind === "terminal" ? t.title : "all changes"}>
                      <span className="tab-label">{label}</span>
                      <button className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(k); }} title="Close">
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
              {activeFile && (
                <div className="active-ctl">
                  {activeFile.status && <span className={`gstatus ${activeFile.status}`}>{activeFile.status}</span>}
                  <div className="pane-toggle">
                    <button className={pane === "file" ? "on" : ""} onClick={() => setPane("file")}>
                      File
                    </button>
                    <button className={pane === "diff" ? "on" : ""} onClick={() => setPane("diff")} disabled={!activeFile.diff} title={activeFile.diff ? "" : "no changes in this mode"}>
                      Diff
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="main-body">
            {activeTab?.kind === "terminal" ? null : activeTab?.kind === "changes" ? (
              changes ? (
                <ChangesView
                  raw={changes.raw}
                  mode={changes.mode}
                  threads={visibleThreads}
                  actions={actions}
                  activeThreadId={activeThreadId}
                  onFocusThread={focusThread}
                  onAddComment={addComment}
                />
              ) : (
                <div className="empty big"><p>Loading changes…</p></div>
              )
            ) : activeTab?.kind === "file" ? (
              activeFile ? (
                pane === "file" ? (
                  <FileView
                    file={activeFile}
                    threads={fileThreads}
                    actions={actions}
                    activeThreadId={activeThreadId}
                    onFocusThread={focusThread}
                    onAddComment={addComment}
                    onSave={saveFile}
                    onEditingChange={(editing) => {
                      editingPathRef.current = editing ? activePath : null;
                    }}
                  />
                ) : (
                  <DiffView
                    path={activeFile.path}
                    diff={activeFile.diff}
                    threads={fileThreads}
                    actions={actions}
                    activeThreadId={activeThreadId}
                    onFocusThread={focusThread}
                    onAddComment={addComment}
                  />
                )
              ) : (
                <div className="empty big"><p>Loading…</p></div>
              )
            ) : (
              <div className="empty big">
                <p>Open a file or ✦ All changes from the explorer — or ⌗ New terminal.</p>
              </div>
            )}
            {tabs.map((t) =>
              t.kind === "terminal" ? <TerminalPane key={t.id} active={activeKey === keyOf(t)} dark={dark} /> : null,
            )}
          </div>
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

      {paletteOpen && <Palette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}
      <Toasts toasts={toasts.items} />
    </div>
  );
}
