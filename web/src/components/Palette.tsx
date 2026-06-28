import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

// ⌘K command palette (C2). The registry's arg-bearing calls need an
// arg-collection/NL step that's deferred; the palette's real value today is the
// set of local actions passed in (switch mode, toggle panes, open INTENT,
// resolve-all, toggle dark…). Fuzzy subsequence filter; ↑/↓ to move, Enter to
// run, Esc to close.

export type PaletteAction = { id: string; label: string; hint?: string; run: () => void };

export function Palette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return actions;
    return actions.filter((a) => {
      const hay = a.label.toLowerCase();
      // subsequence match
      let i = 0;
      for (const ch of hay) if (ch === needle[i]) i++;
      return i === needle.length || hay.includes(needle);
    });
  }, [q, actions]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered]);

  function run(a: PaletteAction | undefined) {
    if (!a) return;
    onClose();
    a.run();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(filtered[active]);
    }
  }

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-list">
          {filtered.length === 0 && <li className="palette-empty">No matches</li>}
          {filtered.map((a, i) => (
            <li
              key={a.id}
              className={`palette-item${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(a)}
            >
              <span>{a.label}</span>
              {a.hint && <span className="palette-hint">{a.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
