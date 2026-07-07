import { useEffect, useState } from "react";
import type { TreeEntry } from "../types";

// File explorer. Pinned rows on top (All changes, New terminal, a "changed
// elsewhere" escape hatch, then the intent doc); below them the tree, rooted at
// the current scope. Folders that hold changes open by default and clean subtrees
// stay collapsed; single-child folder chains are path-compressed onto one row; a
// "Changed / All" toggle prunes the tree to what you're reviewing. A scope
// breadcrumb widens the focus; a folder's focus button narrows it (see
// docs/intent/SPEC.md).

type Node = { name: string; path: string; entry?: TreeEntry; children: Node[]; dirty?: boolean };

function changed(e: TreeEntry | undefined): boolean {
  return !!e && !!(e.status || e.open || e.outdated);
}

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
  // Propagate a "has changes somewhere below" flag so collapsed folders can hint
  // and default their open state.
  const markDirty = (n: Node): boolean => {
    const childDirty = n.children.map(markDirty).some(Boolean);
    n.dirty = childDirty || changed(n.entry);
    return n.dirty;
  };
  markDirty(root);
  return root;
}

// Descend to the node at `path` (the scope), so the tree roots there instead of
// re-showing the scope's own ancestor folders. Paths stay full repo-relative.
function findNode(root: Node, path: string): Node | null {
  if (!path) return root;
  let cur: Node | undefined = root;
  for (const seg of path.split("/")) {
    cur = cur.children.find((c) => c.name === seg);
    if (!cur) return null;
  }
  return cur;
}

// Collapse a single-child folder chain (web → src → components) onto one row.
// Returns the joined label and the deepest folder, whose children we render and
// whose path keys the open state / focus target.
function compress(node: Node): { label: string; tail: Node } {
  let label = node.name;
  let tail = node;
  while (tail.children.length === 1 && tail.children[0].children.length > 0) {
    tail = tail.children[0];
    label += "/" + tail.name;
  }
  return { label, tail };
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

function FocusButton({ path, onFocus }: { path: string; onFocus: (p: string) => void }) {
  return (
    <button
      className="focus-btn"
      title={`Focus ${path}/`}
      onClick={(e) => {
        e.stopPropagation();
        onFocus(path);
      }}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
        <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      </svg>
    </button>
  );
}

export function Explorer({
  tree,
  intentPath,
  scope,
  elsewhere,
  onScope,
  activeKey,
  changesActive,
  onSelect,
  onOpenChanges,
  onNewTerminal,
}: {
  tree: TreeEntry[];
  intentPath: string;
  scope: string; // effective scope from the workspace ("" = whole repo)
  elsewhere: number; // working-tree changes outside the scope
  onScope: (scope: string) => void;
  activeKey: string | null;
  changesActive: boolean;
  onSelect: (path: string) => void;
  onOpenChanges: () => void;
  onNewTerminal: () => void;
}) {
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<boolean>(() => {
    try {
      return localStorage.getItem("cox:tree-all") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("cox:tree-all", showAll ? "1" : "0");
    } catch {}
  }, [showAll]);

  const intent = tree.find((e) => e.path === intentPath);
  const changedCount = tree.filter((e) => e.status).length;

  // Entries feeding the tree: drop the pinned intent; in "Changed" mode keep only
  // files that changed or carry a comment.
  const entries = tree.filter((e) => e.path !== intentPath && (showAll || changed(e)));
  const full = buildTree(entries);
  const rootNode = scope ? findNode(full, scope) ?? { name: "", path: scope, children: [] } : full;

  // A folder opens by default when it holds changes; in "Changed" mode everything
  // shown is already on a change path, so open it all. An explicit user toggle
  // (openState) always wins.
  const defaultOpen = (n: Node) => (showAll ? !!n.dirty : true);
  const isOpen = (n: Node) => openState[n.path] ?? defaultOpen(n);
  const toggle = (n: Node) => setOpenState((s) => ({ ...s, [n.path]: !isOpen(n) }));

  const segs = scope ? scope.split("/") : [];

  return (
    <aside className="explorer">
      <div className="panel-head">
        <h2>Files</h2>
        <span className="counts">{changedCount} changed</span>
        <span className="spacer" />
        <div className="tree-filter">
          <button className={showAll ? "" : "on"} onClick={() => setShowAll(false)} title="Only changed & commented files">
            Changed
          </button>
          <button className={showAll ? "on" : ""} onClick={() => setShowAll(true)} title="Every file in scope">
            All
          </button>
        </div>
      </div>

      <div className="scope-bar" title="Focus scope — click a crumb to widen">
        <button className={`crumb root${scope ? "" : " here"}`} onClick={() => onScope("")} title="Whole repository">
          ◆
        </button>
        {segs.map((seg, i) => {
          const upto = segs.slice(0, i + 1).join("/");
          const here = i === segs.length - 1;
          return (
            <span key={upto} className="crumb-wrap">
              <span className="crumb-sep">/</span>
              <button className={`crumb${here ? " here" : ""}`} onClick={() => onScope(upto)}>
                {seg}
              </button>
            </span>
          );
        })}
      </div>

      <div className="tree">
        <div className={`row file changes-row${changesActive ? " selected" : ""}`} onClick={onOpenChanges} title="all changed files in one scroll">
          <span className="name">✦ All changes</span>
          {changedCount > 0 && <span className="cbadge">{changedCount}</span>}
        </div>
        <div className="row file term-row" onClick={onNewTerminal} title="open a shell in the repo">
          <span className="name">⌗ New terminal</span>
        </div>
        {elsewhere > 0 && (
          <div className="row file elsewhere-row" onClick={() => onScope("")} title="Uncommitted changes outside this folder — click to view the whole repo">
            <span className="name">⤢ {elsewhere} changed elsewhere</span>
          </div>
        )}
        {intent && <FileRow entry={intent} pinned selected={activeKey === intentPath} onSelect={onSelect} />}

        {rootNode.children.length === 0 ? (
          <div className="tree-empty muted">
            {showAll ? "No files here." : "No changes here."}
            {!showAll && (
              <>
                {" · "}
                <button className="linklike" onClick={() => setShowAll(true)}>
                  show all
                </button>
              </>
            )}
          </div>
        ) : (
          rootNode.children.map((n) => (
            <TreeNode key={n.path} node={n} isOpen={isOpen} toggle={toggle} onFocus={onScope} activeKey={activeKey} onSelect={onSelect} showAll={showAll} />
          ))
        )}
      </div>
    </aside>
  );
}

function TreeNode({
  node,
  isOpen,
  toggle,
  onFocus,
  activeKey,
  onSelect,
  showAll,
}: {
  node: Node;
  isOpen: (n: Node) => boolean;
  toggle: (n: Node) => void;
  onFocus: (p: string) => void;
  activeKey: string | null;
  onSelect: (path: string) => void;
  showAll: boolean;
}) {
  const isFolder = node.children.length > 0;
  if (!isFolder && node.entry) {
    return <FileRow entry={node.entry} selected={activeKey === node.path} onSelect={onSelect} dim={showAll && !changed(node.entry)} />;
  }
  const { label, tail } = compress(node);
  const open = isOpen(tail);
  return (
    <>
      <div className="row folder" onClick={() => toggle(tail)} title={tail.path}>
        <span className="twiggle">
          <Chevron open={open} />
        </span>
        <FolderIcon open={open} />
        <span className="name">{label}</span>
        {!open && tail.dirty && <span className="dot" title="changes inside" />}
        <FocusButton path={tail.path} onFocus={onFocus} />
      </div>
      {open && (
        <div className="tree-children">
          {tail.children.map((c) => (
            <TreeNode key={c.path} node={c} isOpen={isOpen} toggle={toggle} onFocus={onFocus} activeKey={activeKey} onSelect={onSelect} showAll={showAll} />
          ))}
        </div>
      )}
    </>
  );
}

function FileRow({
  entry,
  selected,
  pinned,
  dim,
  onSelect,
}: {
  entry: TreeEntry;
  selected: boolean;
  pinned?: boolean;
  dim?: boolean;
  onSelect: (path: string) => void;
}) {
  const comments = entry.open + entry.outdated;
  return (
    <div className={`row file${selected ? " selected" : ""}${dim ? " dim" : ""}`} style={pinned ? { paddingLeft: 10 } : undefined} onClick={() => onSelect(entry.path)} title={entry.path}>
      <span className="twiggle" />
      <FileIcon />
      <span className={`name${entry.status ? ` st-${entry.status}` : ""}`}>
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
