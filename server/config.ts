// Project-owned configuration: .cox/config.json at the repo root, committed with
// the project so every clone (and every agent) sees the same shape. Everything is
// optional — no file means stock behavior — but a *malformed* file is a loud
// error, not a silent fallback: a typo that quietly reverted to defaults would be
// worse than no config at all.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_REL_PATH = ".cox/config.json";

const SECTIONS = ["intent", "include", "changes", "comments"] as const;
export type ContextSection = (typeof SECTIONS)[number];

export type CoxConfig = {
  // Where the intent doc lives, overriding the built-in candidates.
  intent: string | null;
  // What `cox context` returns (and in what order).
  context: {
    sections: ContextSection[];
    include: string[]; // extra repo files inlined into context
    exclude: string[]; // globs hidden from the changed-files list
  };
};

const DEFAULTS: CoxConfig = {
  intent: null,
  context: { sections: [...SECTIONS], include: [], exclude: [] },
};

export function loadConfig(root: string): CoxConfig {
  const full = join(root, CONFIG_REL_PATH);
  if (!existsSync(full)) return structuredClone(DEFAULTS);
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(full, "utf8"));
  } catch (e) {
    throw new Error(`${CONFIG_REL_PATH} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    intent: raw.intent == null ? null : asString(raw.intent, "intent"),
    context: {
      sections: asSections(raw.context?.sections),
      include: asStrings(raw.context?.include, "context.include"),
      exclude: asStrings(raw.context?.exclude, "context.exclude"),
    },
  };
}

// True when a path matches any of the exclude globs.
export function isExcluded(path: string, patterns: string[]): boolean {
  return patterns.some((p) => new Bun.Glob(p).match(path));
}

function asString(v: unknown, key: string): string {
  if (typeof v !== "string" || !v) throw new Error(`${CONFIG_REL_PATH}: "${key}" must be a non-empty string`);
  return v;
}

function asStrings(v: unknown, key: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error(`${CONFIG_REL_PATH}: "${key}" must be an array of strings`);
  return v.map((s, i) => asString(s, `${key}[${i}]`));
}

function asSections(v: unknown): ContextSection[] {
  if (v == null) return [...SECTIONS];
  if (!Array.isArray(v)) throw new Error(`${CONFIG_REL_PATH}: "context.sections" must be an array`);
  for (const s of v) {
    if (!SECTIONS.includes(s)) {
      throw new Error(`${CONFIG_REL_PATH}: unknown section "${s}" (valid: ${SECTIONS.join(", ")})`);
    }
  }
  return v as ContextSection[];
}
