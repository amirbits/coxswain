import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_REL_PATH, isExcluded, loadConfig } from "./config";
import { Store } from "./store";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function repo(config?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "cox-config-"));
  roots.push(root);
  if (config !== undefined) {
    mkdirSync(join(root, ".cox"), { recursive: true });
    writeFileSync(join(root, CONFIG_REL_PATH), typeof config === "string" ? config : JSON.stringify(config));
  }
  return root;
}

describe("loadConfig", () => {
  test("missing file → stock defaults", () => {
    const cfg = loadConfig(repo());
    expect(cfg.intent).toBeNull();
    expect(cfg.context.sections).toEqual(["intent", "include", "changes", "comments"]);
    expect(cfg.context.include).toEqual([]);
    expect(cfg.context.exclude).toEqual([]);
  });

  test("full config parses", () => {
    const cfg = loadConfig(
      repo({ intent: "docs/vision.md", context: { sections: ["changes"], include: ["A.md"], exclude: ["**/*.lock"] } }),
    );
    expect(cfg.intent).toBe("docs/vision.md");
    expect(cfg.context.sections).toEqual(["changes"]);
    expect(cfg.context.include).toEqual(["A.md"]);
    expect(cfg.context.exclude).toEqual(["**/*.lock"]);
  });

  test("malformed JSON is a loud error, not a silent default", () => {
    expect(() => loadConfig(repo("{ nope"))).toThrow(/not valid JSON/);
  });

  test("unknown section name is rejected (typo protection)", () => {
    expect(() => loadConfig(repo({ context: { sections: ["intnet"] } }))).toThrow(/unknown section "intnet"/);
  });

  test("non-string include entry is rejected", () => {
    expect(() => loadConfig(repo({ context: { include: [7] } }))).toThrow(/context\.include\[0\]/);
  });
});

describe("isExcluded", () => {
  test("glob patterns match changed-file paths", () => {
    expect(isExcluded("bun.lock", ["**/*.lock"])).toBe(true);
    expect(isExcluded("deep/dir/bun.lock", ["**/*.lock"])).toBe(true);
    expect(isExcluded("server/cli.ts", ["**/*.lock"])).toBe(false);
    expect(isExcluded("server/assets.generated.ts", ["**/*.generated.ts"])).toBe(true);
    expect(isExcluded("anything", [])).toBe(false);
  });
});

describe("intent override", () => {
  test("config intent wins over the built-in candidates", async () => {
    const root = repo({ intent: "docs/vision.md" });
    writeFileSync(join(root, "INTENT.md"), "legacy"); // would win without the override
    const store = new Store(root);
    expect(store.intentRelPath()).toBe("docs/vision.md");
    await store.writeIntent("the vision");
    expect((await store.readIntent()).content).toBe("the vision");
    expect((await store.readIntent()).path).toBe("docs/vision.md");
  });

  test("a config intent that escapes the repo is refused", async () => {
    const root = repo({ intent: "../outside.md" });
    const store = new Store(root);
    await expect(store.readIntent()).rejects.toThrow(/escapes repository/);
  });
});
