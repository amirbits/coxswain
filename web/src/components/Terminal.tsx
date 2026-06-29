import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

// A live terminal: xterm.js ↔ the server's PTY over a WebSocket. Each instance is
// one shell session in the repo root. Kept mounted (hidden) when not the active
// tab so the session survives tab switches.
const FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const themes = {
  dark: { background: "#16161c", foreground: "#dcdce4", cursor: "#dcdce4", cursorAccent: "#16161c", selectionBackground: "#3a3a4a" },
  light: { background: "#ffffff", foreground: "#1c1c1e", cursor: "#1c1c1e", cursorAccent: "#ffffff", selectionBackground: "#cdd3f0" },
};

export function TerminalPane({ active, dark }: { active: boolean; dark: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      fontFamily: FONT,
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: dark ? themes.dark : themes.light,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const uni = new Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = "11";
    term.open(host);
    try {
      fit.fit();
    } catch {}
    termRef.current = term;
    fitRef.current = fit;

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/terminal?cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") term.write(ev.data);
      else term.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");

    const enc = new TextEncoder();
    const onData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });

    const resize = () => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      } catch {}
    };
    const ro = new ResizeObserver(() => resize());
    ro.observe(host);

    return () => {
      ro.disconnect();
      onData.dispose();
      try {
        ws.close();
      } catch {}
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = dark ? themes.dark : themes.light;
  }, [dark]);

  // xterm needs a refit after being shown from display:none.
  useEffect(() => {
    if (!active) return;
    const id = setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        const ws = wsRef.current;
        if (term && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        term?.focus();
      } catch {}
    }, 30);
    return () => clearTimeout(id);
  }, [active]);

  return <div className={`terminal-pane${active ? "" : " hidden"}`} ref={hostRef} />;
}
