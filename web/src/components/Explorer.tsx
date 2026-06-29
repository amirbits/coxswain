import { useState } from "react";
import type { TreeEntry } from "../types";

// File explorer. A pinned "All changes" row opens the continuous changeset diff;
// INTENT.md is pinned next. Files are decorated with their change status (in the
// active mode) and a comment badge. Click a file to open it (DESIGN.md §12).

type Node = { name: string; path: string; entry?: TreeEntry; children: Node[] };

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
  return root;
}

export function Explorer({
  tree,
  activeKey,
  changesActive,
  onSelect,
  onOpenChanges,
  onNewTerminal,
}: {
  tree: TreeEntry[];
  activeKey: string | null; // active file path, for highlight
  changesActive: boolean;
  onSelect: (path: string) => void;
  onOpenChanges: () => void;
  onNewTerminal: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const root = buildTree(tree);
  const intent = tree.find((e) => e.path === "INTENT.md");
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
        {intent && <FileRow entry={intent} depth={0} pinned selected={activeKey === "INTENT.md"} onSelect={onSelect} />}
        {root.children
          .filter((n) => n.path !== "INTENT.md")
          .map((n) => (
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
  const isCollapsed = collapsed.has(node.path);
  return (
    <>
      <div className="row folder" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(node.path)}>
        <span className="caret">{isCollapsed ? "▸" : "▾"}</span>
        <span className="name">{node.name}</span>
      </div>
      {!isCollapsed &&
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
    <div
      className={`row file${selected ? " selected" : ""}`}
      style={{ paddingLeft: 8 + depth * 12 + (pinned ? 0 : 14) }}
      onClick={() => onSelect(entry.path)}
      title={entry.path}
    >
      {entry.status && <span className={`gstatus ${entry.status}`}>{entry.status}</span>}
      <span className="name">
        {pinned ? "⚑ " : ""}
        {entry.path.split("/").pop()}
      </span>
      {comments > 0 && (
        <span className={`cbadge${entry.outdated ? " has-outdated" : ""}`} title={`${entry.open} open, ${entry.outdated} outdated`}>
          {comments}
        </span>
      )}
    </div>
  );
}
