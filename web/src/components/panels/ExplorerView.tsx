import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, baseName } from "../../api";
import {
  cachedEntries,
  explorerMemory,
  folderOpen,
  rememberEntries,
  rememberFolder,
  type TreeEntry,
} from "../../explorerMemory";
import { parentPath, pathKey, plainPath, samePath } from "../../paths";

interface Root {
  path: string;
  label: string;
}

export function ExplorerView({
  panelId,
  path,
  focus,
  highlight,
  roots,
  onEnter,
  onOpenFile,
  showAddress = true,
}: {
  panelId: string;
  path: string;
  focus?: string;
  /** File or folder the address bar is showing. The tree selects this row. */
  highlight?: string;
  roots: Root[];
  onEnter: (path: string) => void;
  onOpenFile: (path: string) => void | Promise<unknown>;
  showAddress?: boolean;
}) {
  const memory = explorerMemory(panelId);
  const treeRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const [draft, setDraft] = useState(path);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    restored.current = false;
  }, [panelId]);

  useLayoutEffect(() => {
    const node = treeRef.current;
    if (!node || restored.current) return;
    if (memory.scroll > 0 && node.scrollHeight <= node.clientHeight) return;
    node.scrollTop = memory.scroll;
    restored.current = true;
  });

  useEffect(() => {
    const node = treeRef.current;
    if (!node) return;
    const onScroll = () => {
      memory.scroll = node.scrollTop;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [memory]);

  useEffect(() => {
    const cleaned = plainPath(path);
    if (path && cleaned !== path) {
      onEnter(cleaned);
      return;
    }
    if (!cleaned && roots[0]) onEnter(plainPath(roots[0].path));
  }, [path, roots, onEnter]);

  useEffect(() => setDraft(plainPath(path)), [path]);
  useEffect(() => setError(null), [path]);

  const selected = highlight || focus || "";
  const scrolled = useRef("");

  useEffect(() => {
    const node = treeRef.current?.querySelector("[data-selected='true']");
    if (!(node instanceof HTMLElement)) return;
    const key = node.getAttribute("data-path") || "";
    if (!key || scrolled.current === key) return;
    scrolled.current = key;
    node.scrollIntoView({ block: "nearest" });
  });

  const parent = parentOf(path);
  const canUp = parent.length > 0 && !samePath(parent, path);

  return (
    <div className="explorer">
      {showAddress ? (
        <form
          className="location-bar"
          onSubmit={(event) => {
            event.preventDefault();
            onEnter(plainPath(draft));
          }}
        >
          <button type="button" aria-label="Up" disabled={!canUp} onClick={() => onEnter(parent)}>
            ↑
          </button>
          <input aria-label="Folder" value={draft} onChange={(event) => setDraft(event.target.value)} />
        </form>
      ) : null}
      {error ? (
        <div className="empty">{error}</div>
      ) : (
        <div className="explorer-tree" ref={treeRef}>
          {path ? (
            <TreeBranch
              panelId={panelId}
              path={plainPath(path)}
              name={baseName(path) || plainPath(path)}
              depth={0}
              startOpen
              focus={focus}
              highlight={selected}
              onOpenFile={onOpenFile}
              onError={setError}
            />
          ) : (
            roots.map((root) => (
              <TreeBranch
                key={root.path}
                panelId={panelId}
                path={plainPath(root.path)}
                name={root.label}
                depth={0}
                startOpen={Boolean(selected && samePath(selected, root.path))}
                focus={focus}
                highlight={selected}
                onOpenFile={onOpenFile}
                onError={setError}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TreeBranch({
  panelId,
  path,
  name,
  depth,
  startOpen,
  focus,
  highlight,
  onOpenFile,
  onError,
}: {
  panelId: string;
  path: string;
  name: string;
  depth: number;
  startOpen: boolean;
  focus?: string;
  highlight?: string;
  onOpenFile: (path: string) => void | Promise<unknown>;
  onError: (message: string | null) => void;
}) {
  const memory = explorerMemory(panelId);
  const chain = highlight || focus || "";
  const forceOpen = Boolean(chain && samePath(chain, path) && pathKey(path) !== pathKey(chain));
  const selected = Boolean(highlight && pathKey(path) === pathKey(highlight));
  const [open, setOpen] = useState(() => forceOpen || folderOpen(memory, path, startOpen || forceOpen));
  const [entries, setEntries] = useState<TreeEntry[] | null>(() => cachedEntries(memory, path) ?? null);
  const openRef = useRef(open);
  const pathRef = useRef(path);
  openRef.current = open;

  useEffect(() => {
    rememberFolder(memory, pathRef.current, openRef.current);
    pathRef.current = path;
    setOpen(forceOpen || folderOpen(memory, path, startOpen || forceOpen));
    setEntries(cachedEntries(memory, path) ?? null);
  }, [memory, path, startOpen, forceOpen]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    if (!cachedEntries(memory, path)) setEntries(null);
    api.tree(path).then(
      (result) => {
        if (stopped) return;
        const next = result.entries.map((entry) => ({ ...entry, path: plainPath(entry.path) }));
        rememberEntries(memory, path, next);
        setEntries(next);
        onError(null);
      },
      (err: unknown) => {
        if (!stopped) {
          setEntries(null);
          onError(err instanceof Error ? err.message : "Could not read that folder");
        }
      },
    );
    return () => {
      stopped = true;
    };
  }, [open, path, onError, memory]);

  function toggle() {
    setOpen((current) => {
      const next = !current;
      rememberFolder(memory, path, next);
      return next;
    });
  }

  return (
    <div>
      <button
        type="button"
        className={`tree-row${selected ? " is-selected" : ""}`}
        data-path={path}
        data-selected={selected ? "true" : undefined}
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={open ? "tree-chevron open" : "tree-chevron"} />
        <FolderIcon />
        <span className="tree-name">{name}</span>
      </button>
      {open && entries ? (
        <div>
          {entries.map((entry) =>
            entry.kind === "dir" ? (
              <TreeBranch
                key={entry.path}
                panelId={panelId}
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
                startOpen={false}
                focus={focus}
                highlight={highlight}
                onOpenFile={onOpenFile}
                onError={onError}
              />
            ) : (
              <button
                key={entry.path}
                type="button"
                className={`tree-row${highlight && pathKey(entry.path) === pathKey(highlight) ? " is-selected" : ""}`}
                data-path={entry.path}
                data-selected={highlight && pathKey(entry.path) === pathKey(highlight) ? "true" : undefined}
                style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                onClick={() => {
                  void Promise.resolve(onOpenFile(entry.path)).catch((err: unknown) => {
                    onError(err instanceof Error ? err.message : "Could not open that file");
                  });
                }}
              >
                <span className="tree-chevron spacer" />
                <FileIcon />
                <span className="tree-name">{entry.name}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg className="tree-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.3 1.5H13A1.5 1.5 0 0 1 14.5 5v7.5A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9Z"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="tree-icon file" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M4 1.5h5.2L13 5.3V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1Z" />
      <path fill="var(--bg-panel)" d="M9 1.8V5h3.2" />
    </svg>
  );
}

function parentOf(path: string): string {
  return parentPath(path);
}
