// The HTTP server: a projector + write-through layer over git and the
// filesystem. It exposes the function registry over /api/call, a composed
// /api/state projection for the frontend, and an SSE stream for live updates.
// It holds no authoritative state (DESIGN.md §2).

import { extname, join } from "node:path";
import { getEmbedded, hasEmbedded } from "./assets";
import { buildRegistry } from "./capabilities";
import { parseMode } from "./mode";
import { SSEHub } from "./sse";
import { Store } from "./store";
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
  const sse = new SSEHub();
  sse.startHeartbeat();

  const watcher = startWatcher(root, (paths) => sse.broadcast({ type: "change", paths }));

  // The --base flag selects the PR-style branch diff at boot (DESIGN.md §12).
  const bootMode: DiffMode = opts.defaultBase
    ? parseMode({ kind: "branch", ref: opts.defaultBase })
    : { kind: "working" };

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    idleTimeout: 255, // SSE heartbeat (25s) keeps streams alive well within this
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/events") return sse.handler();

      if (pathname === "/api/health") return json({ ok: true, root });

      if (pathname === "/api/boot") return json({ mode: bootMode, root });

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

      if (pathname === "/api/call" && req.method === "POST") {
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
      console.error("helm: request error:", e);
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

  // 2. disk (running uncompiled from the helm repo, after `vite build`)
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
    "Helm frontend not built. Run `bun run dev` (Vite) or `bun run build`.",
    { status: 404 },
  );
}

function modeFromQuery(url: URL): DiffMode {
  return parseMode({ kind: url.searchParams.get("mode"), ref: url.searchParams.get("ref") });
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
