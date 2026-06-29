import { useState } from "react";
import type { TreeEntry } from "../types";

// File explorer. A pinned "All changes" row opens the continuous changeset diff;
// the intent doc is pinned next. Folders collapse/expand; files and folders are shown
// with distinct icons, and a collapsed folder that hides changes gets a dot so
// you can still tell (see docs/intent/SPEC.md).

type Node = { name: string; path: string; entry?: TreeEntry; children: Node[]; dirty?: boolean };

function buildTree(entries: TreeEntry[]): Node {
  const root: Node = { name: "", path: "", children: [] };
  for (const e of entries) {
    let cur = root;
    let acc = "";
    const parts = e.path.split("/");
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      let child = cur.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: acc, children: [] };
        cur.children.push(child);
      }
      if (i === parts.length - 1) child.entry = e;
      cur = child;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => {
      const af = a.children.length > 0;
      const bf = b.children.length > 0;
      if (af !== bf) return af ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sort);
  };
  sort(root);
  // Propagate a "has changes somewhere below" flag so collapsed folders can hint.
  const markDirty = (n: Node): boolean => {
    const childDirty = n.children.map(markDirty).some(Boolean);
    n.dirty = childDirty || !!n.entry?.status;
    return n.dirty;
  };
  markDirty(root);
  return root;
}

// --- icons (currentColor, so they follow the theme) ------------------------

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`caret-ic${open ? " open" : ""}`} viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className={`ftype-ic folder${open ? " open" : ""}`} viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M3 6.5C3 5.7 3.7 5 4.5 5h4.2c.4 0 .77.17 1.04.46L11 7h8.5c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5h-15C3.67 19 3 18.33 3 17.5v-11z"
        fill="currentColor"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="ftype-ic file" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M13 3v6h6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function Explorer({
  tree,
  intentPath,
  activeKey,
  changesActive,
  onSelect,
  onOpenChanges,
  onNewTerminal,
}: {
  tree: TreeEntry[];
  intentPath: string;
  activeKey: string | null; // active file path, for highlight
  changesActive: boolean;
  onSelect: (path: string) => void;
  onOpenChanges: () => void;
  onNewTerminal: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const root = buildTree(tree.filter((e) => e.path !== intentPath));
  const intent = tree.find((e) => e.path === intentPath);
  const changedCount = tree.filter((e) => e.status).length;

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  return (
    <aside className="explorer">
      <div className="panel-head">
        <h2>Files</h2>
        <span className="counts">{changedCount} changed</span>
      </div>
      <div className="tree">
        <div className={`row file changes-row${changesActive ? " selected" : ""}`} onClick={onOpenChanges} title="all changed files in one scroll">
          <span className="name">✦ All changes</span>
          {changedCount > 0 && <span className="cbadge">{changedCount}</span>}
        </div>
        <div className="row file term-row" onClick={onNewTerminal} title="open a shell in the repo root">
          <span className="name">⌗ New terminal</span>
        </div>
        {intent && <FileRow entry={intent} depth={0} pinned selected={activeKey === intentPath} onSelect={onSelect} />}
        {root.children.map((n) => (
          <TreeNode key={n.path} node={n} depth={0} collapsed={collapsed} toggle={toggle} activeKey={activeKey} onSelect={onSelect} />
        ))}
      </div>
    </aside>
  );
}

function TreeNode({
  node,
  depth,
  collapsed,
  toggle,
  activeKey,
  onSelect,
}: {
  node: Node;
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  activeKey: string | null;
  onSelect: (path: string) => void;
}) {
  const isFolder = node.children.length > 0;
  if (!isFolder && node.entry) {
    return <FileRow entry={node.entry} depth={depth} selected={activeKey === node.path} onSelect={onSelect} />;
  }
  const open = !collapsed.has(node.path);
  return (
    <>
      <div className="row folder" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(node.path)} title={node.path}>
        <span className="twiggle">
          <Chevron open={open} />
        </span>
        <FolderIcon open={open} />
        <span className="name">{node.name}</span>
        {!open && node.dirty && <span className="dot" title="changes inside" />}
      </div>
      {open &&
        node.children.map((c) => (
          <TreeNode key={c.path} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} activeKey={activeKey} onSelect={onSelect} />
        ))}
    </>
  );
}

function FileRow({
  entry,
  depth,
  selected,
  pinned,
  onSelect,
}: {
  entry: TreeEntry;
  depth: number;
  selected: boolean;
  pinned?: boolean;
  onSelect: (path: string) => void;
}) {
  const comments = entry.open + entry.outdated;
  return (
    <div className={`row file${selected ? " selected" : ""}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onSelect(entry.path)} title={entry.path}>
      <span className="twiggle" />
      <FileIcon />
      <span className="name">
        {pinned ? "⚑ " : ""}
        {entry.path.split("/").pop()}
      </span>
      {entry.status && <span className={`gstatus ${entry.status}`}>{entry.status}</span>}
      {comments > 0 && (
        <span className={`cbadge${entry.outdated ? " has-outdated" : ""}`} title={`${entry.open} open, ${entry.outdated} outdated`}>
          {comments}
        </span>
      )}
    </div>
  );
}
