// The agent-facing CLI: a front door onto the same function registry the UI and
// HTTP API use (DESIGN.md §5, §11–12). `helm <verb>` is a one-shot call against
// the working tree — no server required.

import { resolve } from "node:path";
import { buildRegistry } from "./capabilities";
import { repoRoot } from "./git";
import { Store } from "./store";
import type { DecoratedThread, DiffMode, FilePayload, Suggestion, Workspace } from "./types";

type Flags = {
  _: string[];
  json?: boolean;
  all?: boolean;
  stdin?: boolean;
  diff?: boolean;
  base?: string;
  body?: string;
  file?: string;
  dir?: string;
  branch?: string;
  ref?: string;
  commit?: string;
  tag?: string;
};

const HELP = `helm — agent + human CLI over the review surface

  helm                       serve the UI (default)
  helm context               repo + intent + changed files + open comments (one shot)
  helm status                branch, change count, comment counts
  helm intent                print INTENT.md
  helm tree [--all]          file explorer: changed + commented files (--all = every file)
  helm file <path>           print a file's current content
  helm diff [path]           diff (whole repo, or one file)
  helm comments [--all]      list review threads (default: open + outdated)
  helm show <id>             one thread in full (messages + any suggestion)
  helm reply <id> <text>     append a reply, as the agent
  helm suggest <id> <text>   propose a replacement for the thread's region
                               --stdin / --file  read the new text
                               --base "<text>"   set exactly what it replaces
  helm apply <id>            apply the thread's pending suggestion (write-through)
  helm dismiss <id>          dismiss it
  helm resolve | reopen <id> change thread status

  diff modes:  --branch <ref>   merge-request diff (ref...HEAD)
               --ref|--tag <r>  vs a commit or tag (r..HEAD)
               (default)        working tree (uncommitted)
  --json   structured output      <id>  any unique prefix, like git

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
  const mode = modeFromFlags(flags);

  try {
    switch (verb) {
      case "context": {
        const ws = await call<Workspace>("workspace", { mode });
        const intent = await call<{ content: string; exists: boolean }>("getIntent", {});
        emit(fmtContext(ws, intent), { repo: ws.repo, mode: ws.mode, intent, tree: ws.tree.filter((e) => e.status || e.open), openThreads: ws.threads.filter((t) => t.effectiveStatus !== "resolved") });
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
      case "tree": {
        const ws = await call<Workspace>("workspace", { mode });
        emit(fmtTree(ws, !!flags.all), flags.all ? ws.tree : ws.tree.filter((e) => e.status || e.open || e.outdated));
        return 0;
      }
      case "file": {
        const path = requireArg(flags, 0, "path");
        const f = await call<FilePayload>("file", { path, mode });
        if (!f.exists) throw new Error(`no such file: ${path}`);
        if (f.kind === "binary") {
          emit(`(binary file: ${path})`, f);
          return 0;
        }
        emit(f.content.replace(/\n$/, ""), f);
        return 0;
      }
      case "diff": {
        if (flags._[0]) {
          const f = await call<FilePayload>("file", { path: flags._[0], mode });
          emit(f.diff.trim() || "(no changes)", f);
        } else {
          const d = await call<{ raw: string }>("showDiff", { mode });
          emit(d.raw.trim() || "(no changes)", d);
        }
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
    else if (a === "--diff") f.diff = true;
    else if (a === "--base") f.base = args[++i];
    else if (a === "--body") f.body = args[++i];
    else if (a === "--file") f.file = args[++i];
    else if (a === "--dir") f.dir = args[++i];
    else if (a === "--branch") f.branch = args[++i];
    else if (a === "--ref") f.ref = args[++i];
    else if (a === "--commit") f.commit = args[++i];
    else if (a === "--tag") f.tag = args[++i];
    else if (!a.startsWith("--")) f._.push(a);
  }
  return f;
}

function modeFromFlags(f: Flags): DiffMode {
  if (f.branch) return { kind: "branch", ref: f.branch };
  const ref = f.ref || f.commit || f.tag || f.base;
  if (ref) return { kind: f.base || f.branch ? "branch" : "ref", ref };
  return { kind: "working" };
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
  for (let i = t.thread.length - 1; i >= 0; i--) if (t.thread[i].suggestion) return t.thread[i].suggestion;
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

const short = (id: string) => id.slice(0, 8);
const json = (d: unknown) => JSON.stringify(d, null, 2);

function where(t: DecoratedThread): string {
  const line = t.located?.startLine ?? t.anchor.startLine;
  return line > 0 ? `${t.anchor.path}:${line}` : t.anchor.path;
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
  const c = (s: string) => threads.filter((t) => t.effectiveStatus === s).length;
  const shown = all ? threads : threads.filter((t) => t.effectiveStatus !== "resolved");
  if (!shown.length) return all ? "No comments." : "No open comments. (helm comments --all for resolved)";
  const header = `${c("open")} open · ${c("outdated")} outdated · ${c("resolved")} resolved\n`;
  const rows = shown.map((t) => {
    const last = t.thread[t.thread.length - 1];
    const sug = t.thread.some((m) => m.suggestion?.status === "proposed") ? ", suggestion" : "";
    return ` ${GLYPH[t.effectiveStatus] ?? "•"} ${short(t.id)}  ${pad(where(t), 24)}  "${oneLine(last.body, 42)}"  (${last.author}${sug})`;
  });
  return header + rows.join("\n");
}

function fmtThread(t: DecoratedThread): string {
  let o = `${short(t.id)}  ${where(t)}  [${t.effectiveStatus}]\n`;
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

function fmtTree(ws: Workspace, all: boolean): string {
  const entries = all ? ws.tree : ws.tree.filter((e) => e.status || e.open || e.outdated);
  if (!entries.length) return all ? "(empty)" : "No changed or commented files. (helm tree --all)";
  return entries
    .map((e) => {
      const st = e.status ? e.status : " ";
      const badge = e.open || e.outdated ? `  💬${e.open}${e.outdated ? `+${e.outdated}!` : ""}` : "";
      return ` ${st}  ${e.path}${badge}`;
    })
    .join("\n");
}

function fmtContext(ws: Workspace, intent: { content: string; exists: boolean }): string {
  const changed = ws.tree.filter((e) => e.status);
  const open = ws.threads.filter((t) => t.effectiveStatus !== "resolved");
  const modeLabel =
    ws.mode.kind === "working" ? "working tree" : ws.mode.kind === "branch" ? `${ws.mode.ref}...HEAD` : `${ws.mode.ref}..HEAD`;
  let o = `repo:   ${ws.repo.name}\nbranch: ${ws.repo.branch}${ws.repo.head ? ` @ ${ws.repo.head.slice(0, 7)}` : ""}\n`;
  o += `\n── intent ──────────────────────────────\n${intent.exists ? intent.content.trim() : "(no INTENT.md yet)"}\n`;
  o += `\n── changes (${modeLabel}) ─────────────────  ${changed.length} file(s)\n`;
  o += (changed.length ? changed.map((e) => ` ${e.status}  ${e.path}`).join("\n") : "  (none)") + "\n";
  o += `  → helm diff [path] for the diff\n`;
  o += `\n── open comments ───────────────────────  ${open.length}\n`;
  o += open.length
    ? open.map((t) => ` ${GLYPH[t.effectiveStatus] ?? "•"} ${short(t.id)} ${where(t)}  "${oneLine(t.thread[t.thread.length - 1].body, 40)}"`).join("\n")
    : "  (none)";
  return o;
}
