import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const root = mkdtempSync(join(tmpdir(), "helm-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("withThreadLock (F4)", () => {
  test("concurrent appends serialize — no lost update", async () => {
    const store = new Store(root);
    const t = await store.createThread({ path: "x.ts", startLine: 1, endLine: 1 }, "base");
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.appendMessage(t.id, "human", `m${i}`)));
    const got = await store.getThread(t.id);
    expect(got?.thread.length).toBe(9); // 1 base + 8 appended, none clobbered
  });

  test("a stale lock is stolen so a crashed writer can't wedge the thread", async () => {
    const store = new Store(root);
    const t = await store.createThread({ path: "y.ts", startLine: 1, endLine: 1 }, "base");
    // Simulate a crashed holder: a lockfile with an ancient mtime (> the 30s stale threshold).
    const lock = join(root, ".reviews", `${t.id}.json.lock`);
    closeSync(openSync(lock, "w"));
    const ancient = new Date(Date.now() - 120_000);
    utimesSync(lock, ancient, ancient);
    await store.appendMessage(t.id, "agent", "after-crash");
    const got = await store.getThread(t.id);
    expect(got?.thread.at(-1)?.body).toBe("after-crash");
  });
});
