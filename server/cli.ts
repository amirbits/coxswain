// The agent-facing CLI: a fourth front door onto the same function registry the
// UI and HTTP API use (DESIGN.md §5, §11). `helm <verb>` is a one-shot call
// against the working tree — no server required. If the UI is running, the
// filesystem watcher repaints it, because the CLI changed the same files.

import { resolve } from "node:path";
import { buildRegistry } from "./capabilities";
import { repoRoot } from "./git";
import { Store } from "./store";
import type { AppState, DecoratedThread, Locator, Suggestion } from "./types";

type Flags = {
  _: string[];
  json?: boolean;
  all?: boolean;
  stdin?: boolean;
  base?: string;
  body?: string;
  file?: string;
  dir?: string;
};

const HELP = `helm — agent + human CLI over the review surface

  helm                      serve the UI (default)
  helm context              intent + diff summary + open comments (orient in one shot)
  helm status               branch, changes, and comment counts
  helm intent               print INTENT.md
  helm diff [--base R]      print the diff (working tree, or R...HEAD)
  helm comments [--all]     list review threads (default: open + outdated)
  helm show <id>            one thread in full (messages + any suggestion)
  helm reply <id> <text>    append a reply, as the agent
  helm suggest <id> <text>  propose a replacement for the thread's region
                              --stdin          read the new text from stdin
                              --base "<text>"  set exactly what it replaces
                              --body "<text>"  prose alongside the suggestion
  helm apply <id>           apply the thread's pending suggestion (write-through)
  helm dismiss <id>         dismiss the thread's pending suggestion
  helm resolve <id>         mark a thread resolved
  helm reopen <id>          reopen a resolved thread

  --json   structured output for any verb
  <id>     any unique prefix, like git

The agent edits the working tree and never commits — you accept by committing.`;

export async function runCli(rawArgs: string[]): Promise<number> {
  const verb = rawArgs[0];
  const flags = parseFlags(rawArgs.slice(1));

  if (verb === "help") {
    console.log(HELP);
    return 0;
  }

  const cwd = flags.dir ? resolve(flags.dir) : process.cwd();
  const root = await repoRoot(cwd);
  if (!root) {
    console.error(`helm: ${cwd} is not a git repository.`);
    return 1;
  }

  const store = new Store(root);
  const registry = buildRegistry({ root, store });
  const call = <T = unknown>(name: string, args: unknown) => registry.call(name, args) as Promise<T>;
  const emit = (text: string, data: unknown) => console.log(flags.json ? json(data) : text);

  try {
    switch (verb) {
      case "context": {
        const s = await call<AppState>("getState", { base: flags.base ?? null });
        emit(fmtContext(s), {
          repo: s.repoName,
          branch: s.branch,
          head: s.head,
          intent: s.intent,
          diff: s.diff,
          openThreads: s.threads.filter((t) => t.effectiveStatus !== "resolved"),
        });
        return 0;
      }
      case "status": {
        const s = await call("repoStatus", {});
        emit(fmtStatus(s as StatusShape), s);
        return 0;
      }
      case "intent": {
        const i = await call<{ content: string; exists: boolean }>("getIntent", {});
        emit(i.exists ? i.content.replace(/\n$/, "") : "(no INTENT.md yet)", i);
        return 0;
      }
      case "diff": {
        const d = await call<{ raw: string }>("showDiff", { base: flags.base ?? null });
        emit(d.raw.trim() || "(no changes)", d);
        return 0;
      }
      case "comments": {
        const threads = await call<DecoratedThread[]>("listThreads", {});
        const shown = flags.all ? threads : threads.filter((t) => t.effectiveStatus !== "resolved");
        emit(fmtComments(threads, !!flags.all), shown);
        return 0;
      }
      case "show": {
        const id = await resolveId(store, requireArg(flags, 0, "id"));
        const t = await call<DecoratedThread>("getThread", { id });
        emit(fmtThread(t), t);
        return 0;
      }
      case "reply": {
        const id = await resolveId(store, requireArg(flags, 0, "id"));
        const text = flags._.slice(1).join(" ") || (flags.stdin ? await readStdin() : "");
        if (!text) throw new Error("reply text is required (positional or --stdin)");
        const t = await call<{ thread: unknown[] }>("replyComment", { id, text, author: "agent" });
        emit(`replied to ${short(id)} (${t.thread.length} messages)`, t);
        return 0;
      }
      case "suggest": {
        const id = await resolveId(store, requireArg(flags, 0, "id"));
        const newText = flags.stdin
          ? await readStdin()
          : flags.file
            ? (await Bun.file(flags.file).text()).replace(/\n$/, "")
            : flags._.slice(1).join(" ");
        if (!newText) throw new Error("new text is required (positional, --stdin, or --file)");
        const t = await call<DecoratedThread>("suggestEdit", { id, newText, base: flags.base, body: flags.body });
        const s = lastSuggestion(t);
        emit(`suggestion added to ${short(id)}\n${s ? fmtSuggestion(s) + "\n" : ""}apply: helm apply ${short(id)}`, t);
        return 0;
      }
      case "apply": {
        const id = await resolveId(store, requireArg(flags, 0, "id"));
        const r = await call<{ file: string }>("applySuggestion", { id });
        emit(`applied suggestion to ${r.file.replace(root + "/", "")}`, r);
        return 0;
      }
      case "dismiss": {
        const id = await resolveId(store, requireArg(flags, 0, "id"));
        const t = await call("dismissSuggestion", { id });
        emit(`dismissed suggestion on ${short(id)}`, t);
        return 0;
      }
      case "resolve":
      case "reopen": {
        const id = await resolveId(store, requireArg(flags, 0, "id"));
        const t = await call(verb === "resolve" ? "resolveComment" : "reopenComment", { id });
        emit(`${verb === "resolve" ? "resolved" : "reopened"} ${short(id)}`, t);
        return 0;
      }
      default:
        console.error(`helm: unknown command "${verb}". Run \`helm help\`.`);
        return 1;
    }
  } catch (e) {
    console.error(`helm: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// Parsing -------------------------------------------------------------------

function parseFlags(args: string[]): Flags {
  const f: Flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") f.json = true;
    else if (a === "--all") f.all = true;
    else if (a === "--stdin") f.stdin = true;
    else if (a === "--base") f.base = args[++i];
    else if (a === "--body") f.body = args[++i];
    else if (a === "--file") f.file = args[++i];
    else if (a === "--dir") f.dir = args[++i];
    else if (!a.startsWith("--")) f._.push(a);
  }
  return f;
}

function requireArg(flags: Flags, i: number, name: string): string {
  const v = flags._[i];
  if (!v) throw new Error(`missing <${name}>`);
  return v;
}

async function resolveId(store: Store, prefix: string): Promise<string> {
  if (await store.getThread(prefix)) return prefix;
  const matches = (await store.listThreads()).filter((t) => t.id.startsWith(prefix));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) throw new Error(`no thread matches id "${prefix}"`);
  throw new Error(`ambiguous id "${prefix}" — ${matches.length} threads match`);
}

async function readStdin(): Promise<string> {
  return (await Bun.stdin.text()).replace(/\n$/, "");
}

function lastSuggestion(t: DecoratedThread): Suggestion | undefined {
  for (let i = t.thread.length - 1; i >= 0; i--) {
    if (t.thread[i].suggestion) return t.thread[i].suggestion;
  }
  return undefined;
}

// Formatting ----------------------------------------------------------------

type StatusShape = {
  branch: string;
  head: string | null;
  changedFiles: number;
  comments: { open: number; resolved: number; total: number };
};

const GLYPH: Record<string, string> = { open: "●", outdated: "◐", resolved: "○" };

function short(id: string): string {
  return id.slice(0, 8);
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function where(loc: Locator): string {
  return loc.kind === "lines"
    ? `${loc.path}:${loc.startLine}${loc.endLine !== loc.startLine ? "-" + loc.endLine : ""}`
    : "INTENT.md";
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function timeAgo(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtComments(threads: DecoratedThread[], all: boolean): string {
  const counts = {
    open: threads.filter((t) => t.effectiveStatus === "open").length,
    outdated: threads.filter((t) => t.effectiveStatus === "outdated").length,
    resolved: threads.filter((t) => t.effectiveStatus === "resolved").length,
  };
  const shown = all ? threads : threads.filter((t) => t.effectiveStatus !== "resolved");
  if (!shown.length) return all ? "No comments." : "No open comments. (helm comments --all to see resolved)";
  const header = `${counts.open} open · ${counts.outdated} outdated · ${counts.resolved} resolved\n`;
  const rows = shown.map((t) => {
    const last = t.thread[t.thread.length - 1];
    const sug = t.thread.some((m) => m.suggestion?.status === "proposed") ? ", suggestion" : "";
    return ` ${GLYPH[t.effectiveStatus] ?? "•"} ${short(t.id)}  ${pad(t.anchor.view, 6)} ${pad(where(t.anchor.locator), 18)}  "${oneLine(last.body, 44)}"  (${last.author}${sug})`;
  });
  return header + rows.join("\n");
}

function fmtThread(t: DecoratedThread): string {
  let o = `${short(t.id)}  ${t.anchor.view} @ ${where(t.anchor.locator)}  [${t.effectiveStatus}]\n`;
  if (t.context) o += `anchored: "${oneLine(t.context, 90)}"\n`;
  for (const m of t.thread) {
    o += `\n  ${m.author}  (${timeAgo(m.ts)})\n`;
    o += m.body.split("\n").map((l) => "    " + l).join("\n") + "\n";
    if (m.suggestion) o += fmtSuggestion(m.suggestion) + "\n";
  }
  return o.replace(/\n$/, "");
}

function fmtSuggestion(s: Suggestion): string {
  const minus = s.base.split("\n").map((l) => "   - " + l).join("\n");
  const plus = s.newText.split("\n").map((l) => "   + " + l).join("\n");
  return `   ┌ suggestion [${s.status}]\n${minus}\n${plus}`;
}

function fmtStatus(s: StatusShape): string {
  return (
    `branch:  ${s.branch}${s.head ? ` @ ${s.head.slice(0, 7)}` : " (no commits)"}\n` +
    `changes: ${s.changedFiles} file(s)\n` +
    `review:  ${s.comments.open} open · ${s.comments.resolved} resolved`
  );
}

function fmtContext(s: AppState): string {
  const files = (s.diff.raw.match(/^\+\+\+ b\/(.+)$/gm) || []).map((l) => l.replace("+++ b/", ""));
  const open = s.threads.filter((t) => t.effectiveStatus !== "resolved");
  let o = `repo:   ${s.repoName}\nbranch: ${s.branch}${s.head ? ` @ ${s.head.slice(0, 7)}` : ""}\n`;
  o += `\n── intent ──────────────────────────────\n`;
  o += `${s.intent.exists ? s.intent.content.trim() : "(no INTENT.md yet)"}\n`;
  o += `\n── diff ────────────────────────────────  ${files.length} file(s) changed\n`;
  o += (files.length ? files.map((f) => "  " + f).join("\n") : "  (no changes)") + "\n";
  o += "  → helm diff for the full diff\n";
  o += `\n── open comments ───────────────────────  ${open.length}\n`;
  o += open.length
    ? open
        .map((t) => ` ${GLYPH[t.effectiveStatus] ?? "•"} ${short(t.id)} ${t.anchor.view} ${where(t.anchor.locator)}  "${oneLine(t.thread[t.thread.length - 1].body, 42)}"`)
        .join("\n")
    : "  (none)";
  return o;
}
