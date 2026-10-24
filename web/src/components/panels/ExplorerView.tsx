import { useEffect, useState } from "react";
import { api, baseName } from "../../api";

interface Root {
  path: string;
  label: string;
}

interface Entry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

export function ExplorerView({
  path,
  roots,
  onEnter,
  onOpenFile,
  showAddress = true,
}: {
  path: string;
  roots: Root[];
  onEnter: (path: string) => void;
  onOpenFile: (path: string) => void | Promise<unknown>;
  showAddress?: boolean;
}) {
  const [draft, setDraft] = useState(path);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cleaned = plainPath(path);
    if (path && cleaned !== path) {
      onEnter(cleaned);
      return;
    }
    if (!cleaned && roots[0]) onEnter(plainPath(roots[0].path));
  }, [path, roots, onEnter]);

  useEffect(() => setDraft(plainPath(path)), [path]);

  const parent = parentOf(path);
  const canUp = parent.length > 0 && roots.some((root) => nested(parent, root.path));

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
      ) : (
        <div className="explorer-up">
          <button type="button" aria-label="Up" disabled={!canUp} onClick={() => onEnter(parent)}>
            ↑
          </button>
        </div>
      )}
      {error ? <div className="empty">{error}</div> : null}
      <div className="explorer-tree">
        {path ? (
          <TreeBranch
            path={plainPath(path)}
            name={baseName(path) || plainPath(path)}
            depth={0}
            startOpen
            onOpenFile={onOpenFile}
            onError={setError}
          />
        ) : (
          roots.map((root) => (
            <TreeBranch
              key={root.path}
              path={plainPath(root.path)}
              name={root.label}
              depth={0}
              startOpen={false}
              onOpenFile={onOpenFile}
              onError={setError}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TreeBranch({
  path,
  name,
  depth,
  startOpen,
  onOpenFile,
  onError,
}: {
  path: string;
  name: string;
  depth: number;
  startOpen: boolean;
  onOpenFile: (path: string) => void | Promise<unknown>;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => setOpen(startOpen), [startOpen, path]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    api.tree(path).then(
      (result) => {
        if (!stopped) {
          setEntries(result.entries.map((entry) => ({ ...entry, path: plainPath(entry.path) })));
          onError(null);
        }
      },
      (err: unknown) => {
        if (!stopped) onError(err instanceof Error ? err.message : "Could not read that folder");
      },
    );
    return () => {
      stopped = true;
    };
  }, [open, path, onError]);

  return (
    <div>
      <button
        type="button"
        className="tree-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
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
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
                startOpen={false}
                onOpenFile={onOpenFile}
                onError={onError}
              />
            ) : (
              <button
                key={entry.path}
                type="button"
                className="tree-row"
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

function plainPath(path: string): string {
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

function parentOf(path: string): string {
  path = plainPath(path);
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index < 0) return "";
  if (index === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  if (index === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, index);
}

function nested(path: string, root: string): boolean {
  const child = normalize(path);
  const base = normalize(root);
  return child === base || child.startsWith(`${base}/`);
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
