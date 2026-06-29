// Word-level diff for the suggestion before/after blocks. An LCS over coarse
// tokens (word runs, whitespace runs, single punctuation) so highlights land on
// word boundaries like GitHub. Dependency-free and small; suggestions are
// region-sized, and we fall back to a whole-side highlight if either side is
// large (the LCS table is O(n*m)).
export type WordSeg = { text: string; changed: boolean };

const MAX_TOKENS = 1500; // region-sized suggestions stay well under this

function toTokens(s: string): string[] {
  return s.match(/\s+|\w+|[^\s\w]/g) ?? [];
}

function push(arr: WordSeg[], text: string, changed: boolean): void {
  const last = arr[arr.length - 1];
  if (last && last.changed === changed) last.text += text;
  else arr.push({ text, changed });
}

export function wordDiff(base: string, next: string): { del: WordSeg[]; ins: WordSeg[] } {
  const A = toTokens(base);
  const B = toTokens(next);
  const n = A.length;
  const m = B.length;
  if (n > MAX_TOKENS || m > MAX_TOKENS) {
    return { del: base ? [{ text: base, changed: true }] : [], ins: next ? [{ text: next, changed: true }] : [] };
  }

  // dp[i][j] = LCS length of A[i:] and B[j:]
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const del: WordSeg[] = [];
  const ins: WordSeg[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push(del, A[i], false);
      push(ins, B[j], false);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(del, A[i], true);
      i++;
    } else {
      push(ins, B[j], true);
      j++;
    }
  }
  while (i < n) push(del, A[i++], true);
  while (j < m) push(ins, B[j++], true);
  return { del, ins };
}
