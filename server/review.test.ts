import { expect, test } from "bun:test";
import { locate } from "./review";

const at = (startLine: number, endLine: number = startLine) => ({ startLine, endLine });

test("locate: no context falls back to the line hint", () => {
  expect(locate("a\nb\nc", undefined, at(2))).toEqual({ startLine: 2, endLine: 2 });
  expect(locate("a\nb\nc", undefined, at(0))).toBe(null);
});

test("locate: unique context returns its real line range", () => {
  expect(locate("a\nb\nc\nd", "b", at(0))).toEqual({ startLine: 2, endLine: 2 });
  expect(locate("a\nb\nc\nd", "b\nc", at(0))).toEqual({ startLine: 2, endLine: 3 });
});

test("locate: repeated context picks the occurrence nearest the hint", () => {
  const content = "x\nfoo\nx\nfoo\nx\nfoo"; // foo at lines 2, 4, 6
  expect(locate(content, "foo", at(5))).toEqual({ startLine: 6, endLine: 6 });
  expect(locate(content, "foo", at(3))).toEqual({ startLine: 4, endLine: 4 });
  expect(locate(content, "foo", at(1))).toEqual({ startLine: 2, endLine: 2 });
  // hint 0 → first occurrence (deterministic)
  expect(locate(content, "foo", at(0))).toEqual({ startLine: 2, endLine: 2 });
});

test("locate: drifted context → null (→ outdated)", () => {
  expect(locate("a\nb\nc", "zzz", at(2))).toBe(null);
});

test("locate: markdown tolerance finds the real line via normalized equality", () => {
  // anchored text captured from rendered markdown (no markers) against raw
  // markdown source with markers — must map back to the real line, not a hint.
  const content = "# Title\n\nSome **bold** and *ital* text.\n\nMore.\n";
  const context = "Some bold and ital text."; // rendered selection
  expect(locate(content, context, at(0))).toEqual({ startLine: 3, endLine: 3 });
});

test("locate: markdown tolerance picks nearest hint among multiple tolerant runs", () => {
  const content = "note: hi\nnote: hi\nnote: hi";
  expect(locate(content, "note: hi", at(3))).toEqual({ startLine: 3, endLine: 3 });
});

test("locate: all-empty normalized context does not match everything", () => {
  // a context that's just blank lines shouldn't locate at line 1 of any file
  expect(locate("a\nb\nc", " \n ", at(2))).toBe(null);
});
