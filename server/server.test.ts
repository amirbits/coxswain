import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server";

const root = mkdtempSync(join(tmpdir(), "helm-server-"));
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });

let base = "";
let token = "";
let stop: () => void = () => {};

beforeAll(async () => {
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(root, "f.txt"), "hi\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const h = await startServer({ root, port: 0, dev: false, defaultBase: null });
  stop = h.stop;
  base = `http://127.0.0.1:${h.server.port}`;
  token = ((await (await fetch(`${base}/api/boot`)).json()) as { token: string }).token;
});
afterAll(() => {
  stop();
  rmSync(root, { recursive: true, force: true });
});

describe("trust boundary (F1/F2)", () => {
  test("/api/boot issues a non-empty token", () => {
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  test("a foreign Origin is refused", async () => {
    const r = await fetch(`${base}/api/workspace?mode=working`, { headers: { Origin: "http://evil.example" } });
    expect(r.status).toBe(403);
  });

  test("/api/call without the token is refused (the CSRF door)", async () => {
    const r = await fetch(`${base}/api/call`, {
      method: "POST",
      headers: { "content-type": "text/plain" }, // the CORS-simple-request preflight bypass
      body: JSON.stringify({ name: "getIntent", args: {} }),
    });
    expect(r.status).toBe(403);
  });

  test("/api/call with the token succeeds", async () => {
    const r = await fetch(`${base}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-helm-token": token },
      body: JSON.stringify({ name: "getIntent", args: {} }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("/terminal without the token is refused (the RCE door)", async () => {
    const r = await fetch(`${base}/terminal`, { headers: { Origin: base } });
    expect(r.status).toBe(403);
  });

  test("a same-origin read (no Origin header) is allowed", async () => {
    const r = await fetch(`${base}/api/workspace?mode=working`);
    expect(r.status).toBe(200);
  });
});
