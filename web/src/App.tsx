import { useCallback, useEffect, useRef, useState } from "react";
import { call, fetchState, subscribe } from "./api";
import { DiffView } from "./components/DiffView";
import { IntentView } from "./components/IntentView";
import { ReviewPanel } from "./components/ReviewPanel";
import type { ThreadActions } from "./components/ThreadCard";
import type { AppState, LineRange, TextAnchor } from "./types";

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [baseInput, setBaseInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showIntent, setShowIntent] = useState(true);
  const [showReview, setShowReview] = useState(true);

  const baseRef = useRef<string | null>(base);
  baseRef.current = base;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-project from the server. Debounced so a burst of SSE change events (a
  // single agent edit can touch many files) coalesces into one fetch.
  const refetch = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        setState(await fetchState(baseRef.current));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, 60);
  }, []);

  useEffect(() => refetch(), [base, refetch]);
  useEffect(() => subscribe(refetch, setConnected), [refetch]);

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

  const diffVersion = () =>
    state && state.diff.mode === "branch" ? state.diff.head ?? "working" : "working";

  const addDiffComment = (locator: LineRange, context: string, text: string) =>
    act("addComment", { anchor: { view: "diff", version: diffVersion(), locator }, context, text });
  const addIntentComment = (locator: TextAnchor, context: string, text: string) =>
    act("addComment", { anchor: { view: "intent", version: "working", locator }, context, text });
  const writeIntent = (content: string) => act("writeIntent", { content });

  function focusThread(id: string) {
    setActiveThreadId(id);
    document.getElementById(`thread-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  if (!state) {
    return (
      <div className="boot">{error ? <div className="error">Helm error: {error}</div> : "Loading…"}</div>
    );
  }

  const intentThreads = state.threads.filter((t) => t.anchor.view === "intent");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">⎈ Helm</div>
        <div className="repo">
          <strong>{state.repoName}</strong>
          <span className="branch">{state.branch}</span>
          {state.head && <span className="sha">{state.head.slice(0, 7)}</span>}
        </div>
        <div className="base-select">
          <input
            value={baseInput}
            placeholder="diff base, e.g. main"
            onChange={(e) => setBaseInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setBase(baseInput.trim() || null);
            }}
          />
          {base && (
            <button
              className="btn small ghost"
              onClick={() => {
                setBase(null);
                setBaseInput("");
              }}
            >
              working
            </button>
          )}
        </div>
        <span className="spacer" />
        <div className="toggles">
          <button className={`btn small${showIntent ? " on" : ""}`} onClick={() => setShowIntent((s) => !s)}>
            Intent
          </button>
          <button className={`btn small${showReview ? " on" : ""}`} onClick={() => setShowReview((s) => !s)}>
            Review
          </button>
        </div>
        <div className={`conn ${connected ? "ok" : "down"}`} title={connected ? "live" : "reconnecting…"}>
          {connected ? "live" : "offline"}
        </div>
      </header>

      {error && <div className="error-bar">{error}</div>}

      <div className="loop-hint">
        Leave comments → tell your agent <em>“address the open review comments”</em> → it edits files
        and the views update live. <strong>You</strong> commit to accept.
      </div>

      <main className="workbench">
        {showIntent && (
          <div className="col intent-col">
            <IntentView
              intent={state.intent}
              threadCount={intentThreads.length}
              onAddComment={addIntentComment}
              onWriteIntent={writeIntent}
            />
          </div>
        )}
        <div className="col diff-col">
          <DiffView
            diff={state.diff}
            threads={state.threads}
            actions={actions}
            activeThreadId={activeThreadId}
            onFocusThread={focusThread}
            onAddComment={addDiffComment}
          />
        </div>
        {showReview && (
          <div className="col review-col">
            <ReviewPanel
              threads={state.threads}
              actions={actions}
              activeThreadId={activeThreadId}
              onFocus={focusThread}
            />
          </div>
        )}
      </main>
    </div>
  );
}
