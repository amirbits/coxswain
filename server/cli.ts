// The agent-facing CLI: a front door onto the same function registry the UI and
// HTTP API use (see docs/intent/SPEC.md). `cox <verb>` is a one-shot call against
// the working tree — no server required.

import { resolve } from "node:path";
import { buildRegistry } from "./capabilities";
import { isExcluded, type ContextSection, type CoxConfig } from "./config";
import { readFileContent, repoRoot, scopeFromCwd } from "./git";
import { parseMode } from "./mode";
import { Store } from "./store";
import type { DecoratedThread, DiffMode, FilePayload, Suggestion, Workspace } from "./types";

type Flags = {
  _: string[];
  json?: boolean;
  all?: boolean;
  repo?: boolean;
  stdin?: boolean;
  diff?: boolean;
  replaces?: string; // suggest: the exact text a proposal replaces
  end?: number; // comment: end line of the range
  body?: string;
  file?: string;
  dir?: string;
  branch?: string;
  ref?: string;
  commit?: string;
  tag?: string;
};

const HELP = `cox — agent + human CLI over the review surface

  cox                       serve the UI (default)
  cox context               repo + intent + changed files + open comments (one shot)
  cox status                branch, change count, comment counts
  cox intent                print the intent doc
  cox tree [--all]          file explorer: changed + commented files (--all = every file)
  cox file <path>           print a file's current content
  cox diff [path]           diff (current scope, or one file)
  cox comments [--all]      list review threads (default: open + outdated)
  cox show <id>             one thread in full (messages + any suggestion)
  cox comment <path> <line> open a thread as the agent (--end <line> for a range;
                               --stdin / --file for the body). Captures the anchored
                               text as context so the thread can go outdated.
  cox reply <id> <text>     append a reply, as the agent
  cox suggest <id> <text>   propose a replacement for the thread's region
                               --stdin / --file  read the new text
                               --replaces "<text>"  set exactly what it replaces
  cox apply <id>            apply the thread's pending suggestion (write-through)
  cox dismiss <id>          dismiss it
  cox resolve | reopen <id> change thread status

  diff modes:  --branch <ref>   merge-request diff (ref...HEAD)
               --ref|--tag <r>  vs a commit or tag (r..HEAD)
               (default)        working tree (uncommitted)

  scope: tree / diff / context are scoped to the directory you run cox in (its
  subtree of the repo) — the win for large monorepos. Branch + ahead/behind stay
  repo-wide, and a scoped view still reports changes elsewhere. --repo widens any
  command back to the whole repository.

  --json   structured output      <id>  any unique prefix, like git

  config: an optional .cox/config.json (committed with the repo) shapes what
  \`cox context\` returns — every key optional, missing file = stock behavior:
    { "intent": "docs/vision.md",              intent doc location
      "context": {
        "sections": ["intent", "include",      which blocks, in order
                     "changes", "comments"],
        "include": ["docs/DECISIONS.md"],      extra files inlined
        "exclude": ["**/*.lock"] } }           globs hidden from changes

Changes land in the working tree for review; you accept by committing.`;

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
    console.error(`cox: ${cwd} is not a git repository.`);
    return 1;
  }
  // Scope to the directory the agent is working in (parity with the UI's launch
  // scope), unless --repo widens back to the whole repository.
  const scope = flags.repo ? "" : scopeFromCwd(root, cwd);

  const store = new Store(root);
  const registry = buildRegistry({ root, store });
  const call = <T = unknown>(name: string, args: unknown) => registry.call(name, args) as Promise<T>;
  const emit = (text: string, data: unknown) => console.log(flags.json ? json(data) : text);
  const mode = modeFromFlags(flags);

  try {
    switch (verb) {
      case "context": {
        const cfg = await call<CoxConfig>("config", {});
        const { sections, include, exclude } = cfg.context;
        const ws = await call<Workspace>("workspace", { mode, scope });
        const intent = sections.includes("intent")
          ? await call<{ content: string; exists: boolean }>("getIntent", {})
          : null;
        const includes = sections.includes("include")
          ? await Promise.all(include.map(async (path) => ({ path, file: await call<FilePayload>("file", { path, mode }) })))
          : [];
        const data: Record<string, unknown> = { repo: ws.repo, mode: ws.mode };
        if (intent) data.intent = intent;
        if (includes.length) data.includes = includes.map((i) => ({ path: i.path, exists: i.file.exists, content: i.file.content }));
        if (sections.includes("changes"))
          data.tree = ws.tree.filter((e) => (e.status || e.open || e.outdated) && !isExcluded(e.path, exclude));
        if (sections.includes("comments")) data.openThreads = ws.threads.filter((t) => t.effectiveStatus !== "resolved");
        emit(fmtContext(ws, intent, cfg, includes), data);
        return 0;
      }
      case "status": {
        const s = await call("repoStatus", {});
        emit(fmtStatus(s as StatusShape), s);
        return 0;
      }
      case "intent": {
        const i = await call<{ content: string; exists: boolean }>("getIntent", {});
        emit(i.exists ? i.content.replace(/\n$/, "") : "(no intent doc yet)", i);
        return 0;
      }
      case "tree": {
        const ws = await call<Workspace>("workspace", { mode, scope });
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
          const d = await call<{ raw: string }>("showDiff", { mode, scope });
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
      case "comment": {
        const path = requireArg(flags, 0, "path");
        const startLine = Number(requireArg(flags, 1, "line"));
        if (!Number.isInteger(startLine) || startLine < 1) throw new Error("line must be a positive integer");
        const endLine = flags.end && flags.end > 0 ? flags.end : startLine;
        const text = flags._.slice(2).join(" ") || (flags.stdin ? await readStdin() : flags.file ? (await Bun.file(flags.file).text()).replace(/\n$/, "") : "");
        if (!text) throw new Error("comment text is required (positional, --stdin, or --file)");
        // Capture the anchored text as context so the thread can go outdated and
        // locates inline — parity with UI-created threads.
        const fc = await readFileContent(root, path);
        if (!fc.exists) throw new Error(`no such file: ${path}`);
        if (fc.kind === "binary") throw new Error(`cannot comment on a binary file: ${path}`);
        const context = fc.content.split("\n").slice(startLine - 1, endLine).join("\n");
        const t = await call<DecoratedThread>("addComment", { path, startLine, endLine, text, author: "agent", context });
        emit(`commented on ${path}:${startLine}${endLine !== startLine ? `–${endLine}` : ""} (${short(t.id)})`, t);
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
        const t = await call<DecoratedThread>("suggestEdit", { id, newText, base: flags.replaces, body: flags.body });
        const s = lastSuggestion(t);
        emit(`suggestion added to ${short(id)}\n${s ? fmtSuggestion(s) + "\n" : ""}apply: cox apply ${short(id)}`, t);
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
        console.error(`cox: unknown command "${verb}". Run \`cox help\`.`);
        return 1;
    }
  } catch (e) {
    console.error(`cox: ${e instanceof Error ? e.message : String(e)}`);
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
    else if (a === "--repo") f.repo = true;
    else if (a === "--stdin") f.stdin = true;
    else if (a === "--diff") f.diff = true;
    else if (a === "--replaces") f.replaces = args[++i];
    else if (a === "--end") f.end = Number(args[++i]);
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
  if (f.branch) return parseMode({ kind: "branch", ref: f.branch });
  const ref = f.ref || f.commit || f.tag;
  if (ref) return parseMode({ kind: "ref", ref });
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
  if (!shown.length) return all ? "No comments." : "No open comments. (cox comments --all for resolved)";
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

function scopeNote(ws: Workspace): string {
  const parts: string[] = [];
  if (ws.repo.scope) parts.push(`scope: ${ws.repo.scope}/`);
  if (ws.repo.elsewhere) parts.push(`${ws.repo.elsewhere} changed elsewhere (--repo to widen)`);
  return parts.length ? parts.join(" · ") + "\n" : "";
}

function fmtTree(ws: Workspace, all: boolean): string {
  const entries = all ? ws.tree : ws.tree.filter((e) => e.status || e.open || e.outdated);
  const head = scopeNote(ws);
  if (!entries.length) return head + (all ? "(empty)" : "No changed or commented files here. (cox tree --all)");
  return (
    head +
    entries
      .map((e) => {
        const st = e.status ? e.status : " ";
        const badge = e.open || e.outdated ? `  💬${e.open}${e.outdated ? `+${e.outdated}!` : ""}` : "";
        return ` ${st}  ${e.path}${badge}`;
      })
      .join("\n")
  );
}

function fmtContext(
  ws: Workspace,
  intent: { content: string; exists: boolean } | null,
  cfg: CoxConfig,
  includes: { path: string; file: FilePayload }[],
): string {
  const changed = ws.tree.filter((e) => e.status && !isExcluded(e.path, cfg.context.exclude));
  const open = ws.threads.filter((t) => t.effectiveStatus !== "resolved");
  const modeLabel =
    ws.mode.kind === "working" ? "working tree" : ws.mode.kind === "branch" ? `${ws.mode.ref}...HEAD` : `${ws.mode.ref}..HEAD`;
  const rule = (label: string, tail = "") => `\n── ${label} ${"─".repeat(Math.max(2, 40 - label.length))}${tail}\n`;
  const blocks: Record<ContextSection, () => string> = {
    intent: () => rule("intent") + `${intent?.exists ? intent.content.trim() : "(no intent doc yet)"}\n`,
    include: () =>
      includes
        .map(({ path, file }) => rule(path) + (file.exists ? (file.kind === "binary" ? "(binary)" : file.content.trim()) : "(missing)") + "\n")
        .join(""),
    changes: () =>
      rule(`changes (${modeLabel})`, `  ${changed.length} file(s)`) +
      (changed.length ? changed.map((e) => ` ${e.status}  ${e.path}`).join("\n") : "  (none)") +
      "\n  → cox diff [path] for the diff\n",
    comments: () =>
      rule("open comments", `  ${open.length}`) +
      (open.length
        ? open.map((t) => ` ${GLYPH[t.effectiveStatus] ?? "•"} ${short(t.id)} ${where(t)}  "${oneLine(t.thread[t.thread.length - 1].body, 40)}"`).join("\n")
        : "  (none)"),
  };
  let o = `repo:   ${ws.repo.name}\nbranch: ${ws.repo.branch}${ws.repo.head ? ` @ ${ws.repo.head.slice(0, 7)}` : ""}\n`;
  if (ws.repo.scope) o += `scope:  ${ws.repo.scope}/${ws.repo.elsewhere ? `  (${ws.repo.elsewhere} changed elsewhere; cox --repo to widen)` : ""}\n`;
  o += cfg.context.sections.map((s) => blocks[s]()).join("");
  return o.replace(/\n+$/, "");
}
