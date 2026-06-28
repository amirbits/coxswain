// Static frontend assets. When compiled to a single binary, the built web app is
// embedded via scripts/embed.ts (which generates assets.generated.ts). In dev /
// uncompiled runs the generated module may be absent, so this falls back to
// reading web/dist from disk (and ultimately to Vite, which serves the app
// itself during `bun run dev`).

type Embedded = { bytes: Uint8Array; type: string };

let MAP: Record<string, { b64: string; type: string }> = {};
try {
  // @ts-ignore assets.generated.ts is produced at build time by scripts/embed.ts
  const mod: any = await import("./assets.generated.ts");
  MAP = mod.ASSETS ?? {};
} catch {
  MAP = {};
}

export function hasEmbedded(): boolean {
  return Object.keys(MAP).length > 0;
}

export function getEmbedded(path: string): Embedded | null {
  const e = MAP[path];
  if (!e) return null;
  return { bytes: Buffer.from(e.b64, "base64"), type: e.type };
}
