import { expect, test } from "bun:test";
import { normalizeRef, parseMode, parseModeParts } from "./mode";

test("parseMode: working by default and on bad input", () => {
  expect(parseMode({})).toEqual({ kind: "working" });
  expect(parseMode({ kind: "working" })).toEqual({ kind: "working" });
  expect(parseMode({ kind: "nonsense", ref: "main" })).toEqual({ kind: "working" });
  expect(parseMode({ kind: 42 })).toEqual({ kind: "working" });
  expect(parseMode(null as any)).toEqual({ kind: "working" });
});

test("parseMode: branch/ref require a non-empty ref, else collapse to working", () => {
  expect(parseMode({ kind: "branch", ref: "main" })).toEqual({ kind: "branch", ref: "main" });
  expect(parseMode({ kind: "ref", ref: "v1" })).toEqual({ kind: "ref", ref: "v1" });
  // empty / whitespace ref → working (the projector never receives a half-specified mode)
  expect(parseMode({ kind: "branch", ref: "" })).toEqual({ kind: "working" });
  expect(parseMode({ kind: "branch", ref: "   " })).toEqual({ kind: "working" });
  expect(parseMode({ kind: "ref" })).toEqual({ kind: "working" });
  expect(parseMode({ kind: "branch", ref: null })).toEqual({ kind: "working" });
});

test("parseMode: ref is trimmed", () => {
  expect(parseMode({ kind: "branch", ref: "  main  " })).toEqual({ kind: "branch", ref: "main" });
});

test("parseModeParts: query/flag-shaped input", () => {
  expect(parseModeParts("branch", "main")).toEqual({ kind: "branch", ref: "main" });
  expect(parseModeParts(null, null)).toEqual({ kind: "working" });
  expect(parseModeParts("ref", "")).toEqual({ kind: "working" });
});

test("normalizeRef", () => {
  expect(normalizeRef("main")).toBe("main");
  expect(normalizeRef("  x ")).toBe("x");
  expect(normalizeRef("")).toBe(null);
  expect(normalizeRef("   ")).toBe(null);
  expect(normalizeRef(null)).toBe(null);
  expect(normalizeRef(undefined)).toBe(null);
  expect(normalizeRef(42 as any)).toBe(null);
});
