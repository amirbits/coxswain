import { useState } from "react";
import type { DecoratedThread } from "../types";
import { basename, timeAgo, truncate } from "../util";
import { Composer } from "./Composer";

export type ThreadActions = {
  reply: (id: string, text: string) => Promise<void> | void;
  resolve: (id: string) => Promise<void> | void;
  reopen: (id: string) => Promise<void> | void;
};

export function ThreadCard({
  thread,
  actions,
  compact,
  active,
  onFocus,
}: {
  thread: DecoratedThread;
  actions: ThreadActions;
  compact?: boolean;
  active?: boolean;
  onFocus?: () => void;
}) {
  const [replying, setReplying] = useState(false);
  const loc = thread.anchor.locator;
  const where =
    loc.kind === "lines"
      ? `${basename(loc.path)}:${loc.startLine}${loc.endLine !== loc.startLine ? `–${loc.endLine}` : ""}`
      : "INTENT.md";

  return (
    <div
      className={`thread ${thread.effectiveStatus}${active ? " active" : ""}${compact ? " compact" : ""}`}
      id={`thread-${thread.id}`}
      onMouseDown={onFocus}
    >
      <div className="thread-head">
        <span className={`badge ${thread.anchor.view}`}>{thread.anchor.view}</span>
        <span className="thread-where">{where}</span>
        <span className="spacer" />
        <span className={`status ${thread.effectiveStatus}`}>{thread.effectiveStatus}</span>
      </div>

      {thread.context && thread.anchor.view === "intent" && (
        <blockquote className="thread-quote">{truncate(thread.context, 180)}</blockquote>
      )}

      <div className="messages">
        {thread.thread.map((m, i) => (
          <div className={`msg ${m.author}`} key={i}>
            <div className="msg-head">
              <span className={`who ${m.author}`}>{m.author}</span>
              <span className="when">{timeAgo(m.ts)}</span>
            </div>
            <div className="msg-body">{m.body}</div>
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
    </div>
  );
}
