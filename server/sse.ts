// Server-Sent Events hub. Live updates are push-only and carry no payload of
// substance — a "change" event just tells the client to re-project state from
// the server (which re-derives it from the working tree). SSE is simpler than
// WebSocket and sufficient for v1 (DESIGN.md §10).

export type ChangeEvent = { type: string; [k: string]: unknown };

export class SSEHub {
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private encoder = new TextEncoder();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  handler(): Response {
    let ref: ReadableStreamDefaultController<Uint8Array>;
    const clients = this.clients;
    const encoder = this.encoder;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ref = controller;
        clients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
        clients.delete(ref);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  broadcast(event: ChangeEvent): void {
    const payload = this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const c of this.clients) {
      try {
        c.enqueue(payload);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  // Keep idle connections alive through proxies (Vite dev proxy, etc.).
  startHeartbeat(ms = 25000): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const ping = this.encoder.encode(": ping\n\n");
      for (const c of this.clients) {
        try {
          c.enqueue(ping);
        } catch {
          this.clients.delete(c);
        }
      }
    }, ms);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
