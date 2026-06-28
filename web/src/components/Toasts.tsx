import { useCallback, useRef, useState } from "react";

// Minimal toast surface for transient action feedback (Apply/Resolve/Reply/Save
// + errors). Replaces the old "silent action + persistent error bar" pattern —
// successes and failures both surface briefly and auto-dismiss.

export type ToastKind = "ok" | "err";
export type Toast = { id: number; kind: ToastKind; text: string };

export type ToastApi = {
  ok: (text: string) => void;
  err: (text: string) => void;
  items: Toast[];
};

const DISMISS_MS = 3400;

// Returns a stable object whose `ok`/`err` callbacks never change identity
// (so callers can depend on them without re-creating effects); only `items`
// updates as toasts come and go.
export function useToasts(): ToastApi {
  const [items, setItems] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const apiRef = useRef<ToastApi>({ ok: () => {}, err: () => {}, items: [] });

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++idRef.current;
    setItems((prev) => [...prev, { id, kind, text }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), DISMISS_MS);
  }, []);

  const ok = useCallback((text: string) => push("ok", text), [push]);
  const err = useCallback((text: string) => push("err", text), [push]);

  apiRef.current.ok = ok;
  apiRef.current.err = err;
  apiRef.current.items = items;
  return apiRef.current;
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
