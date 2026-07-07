import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DecoratedThread, Suggestion } from "../types";
import { basename, timeAgo, truncate } from "../util";
import { wordDiff } from "../worddiff";
import { Composer } from "./Composer";

export type ThreadActions = {
  reply: (id: string, text: string) => Promise<void> | void;
  resolve: (id: string) => Promise<void> | void;
  reopen: (id: string) => Promise<void> | void;
  apply: (id: string) => Promise<void> | void;
  dismiss: (id: string) => Promise<void> | void;
};

// A stable per-author "tone" so each speaker reads as a distinct color band —
// human and agent are pinned; any other author (a named reviewer, a second agent)
// hashes to one of the generic tones. Kept in sync with the .msg.tone-* rules in
// styles.css.
const PINNED: Record<string, string> = { human: "h", agent: "a" };
const GENERIC_TONES = 6;
function toneOf(author: string): string {
  if (PINNED[author]) return PINNED[author];
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0;
  return String(h % GENERIC_TONES);
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg className={`thread-caret-ic${open ? " open" : ""}`} viewBox="0 0 24 24" width="9" height="9" aria-hidden="true">
      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Avatar({ author }: { author: string }) {
  return (
    <span className={`who-avatar tone-${toneOf(author)}`} title={author}>
      {author.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ThreadCard({
  thread,
  actions,
  compact,
  active,
  onFocus,
  defaultCollapsed,
}: {
  thread: DecoratedThread;
  actions: ThreadActions;
  compact?: boolean;
  active?: boolean;
  onFocus?: () => void;
  defaultCollapsed?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed);
  // Follow a panel-level collapse-all / expand-all, while still allowing a local
  // override until the next panel-wide toggle.
  useEffect(() => setCollapsed(!!defaultCollapsed), [defaultCollapsed]);

  const line = thread.located?.startLine ?? thread.anchor.startLine;
  const where = line > 0 ? `${basename(thread.anchor.path)}:${line}` : basename(thread.anchor.path);
  const msgs = thread.thread;
  const last = msgs[msgs.length - 1];
  const participants = useMemo(() => {
    const seen: string[] = [];
    for (const m of msgs) if (!seen.includes(m.author)) seen.push(m.author);
    return seen;
  }, [msgs]);

  return (
    <div
      className={`thread ${thread.effectiveStatus}${active ? " active" : ""}${compact ? " compact" : ""}${collapsed ? " collapsed" : ""}`}
      id={`thread-${thread.id}`}
      onMouseDown={onFocus}
    >
      <div className="thread-head" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand" : "Collapse"}>
        <span className="thread-caret">
          <Caret open={!collapsed} />
        </span>
        <span className="thread-where">{where}</span>
        {collapsed && (
          <span className="thread-people">
            {participants.map((a) => (
              <Avatar key={a} author={a} />
            ))}
            {msgs.length > 1 && <span className="msg-count">{msgs.length}</span>}
          </span>
        )}
        <span className="spacer" />
        <span className={`status ${thread.effectiveStatus}`}>{thread.effectiveStatus}</span>
      </div>

      {collapsed ? (
        <div className="thread-preview" onClick={() => setCollapsed(false)}>
          <span className={`who-dot tone-${toneOf(last.author)}`} />
          <span className="preview-text">{truncate(last.body.replace(/\s+/g, " ").trim(), 120)}</span>
        </div>
      ) : (
        <>
          {thread.context && (
            <blockquote className="thread-quote">{truncate(thread.context.replace(/\s+/g, " ").trim(), 160)}</blockquote>
          )}

          <div className="messages">
            {msgs.map((m, i) => (
              <div className={`msg tone-${toneOf(m.author)}`} key={i}>
                <div className="msg-head">
                  <Avatar author={m.author} />
                  <span className="who">{m.author}</span>
                  <span className="when">{timeAgo(m.ts)}</span>
                </div>
                <div className="msg-body md">
                  <Markdown remarkPlugins={[remarkGfm]}>{m.body}</Markdown>
                </div>
                {m.suggestion && (
                  <SuggestionBlock
                    s={m.suggestion}
                    onApply={() => actions.apply(thread.id)}
                    onDismiss={() => actions.dismiss(thread.id)}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="thread-actions">
            {!replying && (
              <button className="btn small" onClick={() => setReplying(true)}>
                Reply
              </button>
            )}
            {thread.status === "resolved" ? (
              <button className="btn small ghost" onClick={() => actions.reopen(thread.id)}>
                Reopen
              </button>
            ) : (
              <button className="btn small ghost" onClick={() => actions.resolve(thread.id)}>
                Resolve
              </button>
            )}
          </div>

          {replying && (
            <Composer
              placeholder="Reply…"
              submitLabel="Reply"
              onSubmit={async (t) => {
                await actions.reply(thread.id, t);
                setReplying(false);
              }}
              onCancel={() => setReplying(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

function SuggestionBlock({ s, onApply, onDismiss }: { s: Suggestion; onApply: () => void; onDismiss: () => void }) {
  const { del, ins } = useMemo(() => wordDiff(s.base, s.newText), [s.base, s.newText]);
  return (
    <div className={`suggestion ${s.status}`}>
      <div className="suggestion-head">
        <span className="suggestion-label">suggested edit</span>
        <span className={`sug-status ${s.status}`}>{s.status}</span>
      </div>
      <div className="suggestion-diff">
        {s.base !== "" && (
          <div className="sdiff del">
            {del.map((seg, i) => (seg.changed ? <span className="wd" key={i}>{seg.text}</span> : <span key={i}>{seg.text}</span>))}
          </div>
        )}
        {s.newText !== "" && (
          <div className="sdiff add">
            {ins.map((seg, i) => (seg.changed ? <span className="wd" key={i}>{seg.text}</span> : <span key={i}>{seg.text}</span>))}
          </div>
        )}
      </div>
      {s.status === "proposed" && (
        <div className="suggestion-actions">
          <button className="btn small primary" onClick={onApply}>
            Apply
          </button>
          <button className="btn small ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
