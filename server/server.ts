// The HTTP server: a projector + write-through layer over git and the
// filesystem. It exposes the function registry over /api/call, a composed
// /api/state projection for the frontend, and an SSE stream for live updates.
// It holds no authoritative state (see docs/intent/SPEC.md).

import { extname, join } from "node:path";
import { getEmbedded, hasEmbedded } from "./assets";
import { buildRegistry } from "./capabilities";
import { parseMode } from "./mode";
import { SSEHub } from "./sse";
import { diffAll } from "./git";
import { Store } from "./store";
import { closeTerminal, openTerminal, terminalMessage, type TermData } from "./terminal";
import type { DiffMode } from "./types";
import { startWatcher } from "./watcher";
import { getFile, getWorkspace } from "./workspace";

export type ServerOptions = {
  root: string;
  port: number;
  dev: boolean;
  defaultBase: string | null;
};

const DIST_DIR = join(import.meta.dir, "../web/dist");

export async function startServer(opts: ServerOptions) {
  const { root } = opts;
  const store = new Store(root);
  const registry = buildRegistry({ root, store });

  // A per-boot secret guarding the two doors that can execute or mutate: the PTY
  // (/terminal) and the registry call (/api/call). It's handed to our own page
  // through /api/boot — which the cross-origin guard keeps same-origin — so a
  // foreign page the browser lets reach this local server can neither read it
  // nor forge a request that carries it (see docs/intent/SPEC.md).
  const token = crypto.randomUUID();

  const sse = new SSEHub();
  sse.startHeartbeat();

  const watcher = startWatcher(root, (paths) => sse.broadcast({ type: "change", paths }));

  // The --base flag selects the PR-style branch diff at boot (see docs/intent/SPEC.md).
  const bootMode: DiffMode = opts.defaultBase
    ? parseMode({ kind: "branch", ref: opts.defaultBase })
    : { kind: "working" };

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    idleTimeout: 255, // SSE heartbeat (25s) keeps streams alive well within this
    websocket: {
      idleTimeout: 960,
      open: openTerminal,
      message: terminalMessage,
      close: closeTerminal,
    },
    async fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      // Trust boundary: the browser lets any origin reach this local server —
      // WebSocket handshakes and "simple" POSTs bypass the same-origin policy —
      // so refuse foreign origins on every live door. Static assets stay open;
      // they're public and load via top-level navigation, which sends no Origin.
      if (
        (pathname.startsWith("/api/") || pathname === "/terminal" || pathname === "/events") &&
        !isTrustedOrigin(req)
      ) {
        return json({ error: "cross-origin request refused" }, 403);
      }

      if (pathname === "/events") return sse.handler();

      if (pathname === "/terminal") {
        if (url.searchParams.get("token") !== token) return new Response("forbidden", { status: 403 });
        const data: TermData = {
          root,
          cols: Number(url.searchParams.get("cols")) || 80,
          rows: Number(url.searchParams.get("rows")) || 24,
        };
        if (server.upgrade(req, { data })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }

      if (pathname === "/api/health") return json({ ok: true, root });

      if (pathname === "/api/boot") return json({ mode: bootMode, root, token });

      if (pathname === "/api/registry") return json(registry.list());

      if (pathname === "/api/workspace") {
        try {
          return json(await getWorkspace(root, store, modeFromQuery(url)));
        } catch (e) {
          return json({ error: errMsg(e) }, 400);
        }
      }

      if (pathname === "/api/file") {
        const path = url.searchParams.get("path");
        if (!path) return json({ error: "path required" }, 400);
        try {
          return json(await getFile(root, store, path, modeFromQuery(url)));
        } catch (e) {
          return json({ error: errMsg(e) }, 400);
        }
      }

      if (pathname === "/api/changes") {
        try {
          return json(await diffAll(root, modeFromQuery(url)));
        } catch (e) {
          return json({ error: errMsg(e) }, 400);
        }
      }

      if (pathname === "/api/call" && req.method === "POST") {
        if (req.headers.get("x-cox-token") !== token) {
          return json({ ok: false, error: "forbidden" }, 403);
        }
        let body: any;
        try {
          body = await req.json();
        } catch {
          return json({ ok: false, error: "invalid JSON body" }, 400);
        }
        const name = body?.name;
        if (!name || !registry.has(name)) {
          return json({ ok: false, error: `unknown function: ${name}` }, 404);
        }
        try {
          return json({ ok: true, result: await registry.call(name, body.args) });
        } catch (e) {
          return json({ ok: false, error: errMsg(e) }, 400);
        }
      }

      if (req.method === "GET") return serveStatic(pathname);
      return new Response("Not found", { status: 404 });
    },
    error(e) {
      console.error("cox: request error:", e);
      return json({ error: errMsg(e) }, 500);
    },
  });

  return {
    server,
    stop() {
      watcher.close();
      sse.stop();
      server.stop(true);
    },
  };
}

async function serveStatic(pathname: string): Promise<Response> {
  const path = pathname === "/" ? "/index.html" : pathname;

  // 1. embedded assets (single-binary build)
  const embedded = getEmbedded(path);
  if (embedded) {
    return new Response(embedded.bytes, { headers: { "Content-Type": embedded.type } });
  }

  // 2. disk (running uncompiled from the cox repo, after `vite build`)
  if (!hasEmbedded()) {
    const file = Bun.file(join(DIST_DIR, path));
    if (await file.exists()) return new Response(file);
  }

  // 3. SPA fallback for extensionless routes
  if (!extname(path)) {
    const indexEmbedded = getEmbedded("/index.html");
    if (indexEmbedded) {
      return new Response(indexEmbedded.bytes, { headers: { "Content-Type": indexEmbedded.type } });
    }
    const index = Bun.file(join(DIST_DIR, "index.html"));
    if (await index.exists()) return new Response(index);
  }

  return new Response(
    "Coxswain frontend not built. Run `bun run dev` (Vite) or `bun run build`.",
    { status: 404 },
  );
}

function modeFromQuery(url: URL): DiffMode {
  return parseMode({ kind: url.searchParams.get("mode"), ref: url.searchParams.get("ref") });
}

// The browser attaches an Origin to cross-origin WebSocket handshakes and to
// cross-origin / POST fetches, but never enforces it — that's the server's job.
// Trust only same-machine origins, on any port so the Vite dev proxy (:5173)
// still reaches us. A missing Origin is a same-origin GET, a navigation, or the
// in-process CLI — none of them the cross-site threat — so it's allowed.
function isTrustedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function json(data: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
