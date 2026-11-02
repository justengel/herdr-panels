import { createContext, useContext, type ReactNode } from "react";
import { closeBrowser, nextBrowserGeneration } from "./desktopBrowser";

const VisitIdsContext = createContext<ReadonlySet<string> | null>(null);
const KeptIdsContext = createContext<ReadonlySet<string>>(new Set());
const BrowserRoleContext = createContext<"desk" | "visit" | "keeper">("desk");

export function BrowserVisitProvider({
  ids,
  keptIds,
  children,
}: {
  ids: ReadonlySet<string> | null;
  keptIds: ReadonlySet<string>;
  children: ReactNode;
}) {
  return (
    <VisitIdsContext.Provider value={ids}>
      <KeptIdsContext.Provider value={keptIds}>{children}</KeptIdsContext.Provider>
    </VisitIdsContext.Provider>
  );
}

export function BrowserRoleProvider({
  role,
  children,
}: {
  role: "desk" | "visit" | "keeper";
  children: ReactNode;
}) {
  return <BrowserRoleContext.Provider value={role}>{children}</BrowserRoleContext.Provider>;
}

export function useVisitIds(): ReadonlySet<string> | null {
  return useContext(VisitIdsContext);
}

export function useKeptIds(): ReadonlySet<string> {
  return useContext(KeptIdsContext);
}

export function useBrowserRole(): "desk" | "visit" | "keeper" {
  return useContext(BrowserRoleContext);
}

const owners = new Map<string, { count: number; generation: number; closeTimer: number }>();

/** One native window per panel. The last owner closes it after the next paint, so a visit can hand it back to the desk. */
export function holdBrowser(label: string): number {
  const slot = owners.get(label);
  if (slot) {
    if (slot.closeTimer) {
      window.clearTimeout(slot.closeTimer);
      slot.closeTimer = 0;
    }
    slot.count += 1;
    return slot.generation;
  }
  const generation = nextBrowserGeneration();
  owners.set(label, { count: 1, generation, closeTimer: 0 });
  return generation;
}

export function dropBrowser(label: string, generation: number) {
  const slot = owners.get(label);
  if (!slot || slot.generation !== generation) return;
  slot.count -= 1;
  if (slot.count > 0) return;
  if (slot.closeTimer) window.clearTimeout(slot.closeTimer);
  slot.closeTimer = window.setTimeout(() => {
    const current = owners.get(label);
    if (!current || current.generation !== generation || current.count > 0) return;
    owners.delete(label);
    void closeBrowser(label, generation);
  }, 0);
}

/** The visit paints a panel it owns. The desk hides the rest and does not close them. */
export function browserLeader(
  role: "desk" | "visit" | "keeper",
  ids: ReadonlySet<string> | null,
  keptIds: ReadonlySet<string>,
  panelId: string,
): { leader: boolean; hide: boolean } {
  const inVisit = ids?.has(panelId) ?? false;
  const kept = keptIds.has(panelId);
  if (!ids) return { leader: role === "desk", hide: false };
  if (kept) return { leader: role === "keeper", hide: !inVisit };
  if (inVisit) return { leader: role === "visit", hide: role !== "visit" };
  return { leader: role === "desk", hide: true };
}
