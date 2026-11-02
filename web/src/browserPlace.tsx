import { createContext, useContext, type ReactNode } from "react";
import { closeBrowser, nextBrowserGeneration } from "./desktopBrowser";

const VisitIdsContext = createContext<ReadonlySet<string> | null>(null);
const KeptIdsContext = createContext<ReadonlySet<string>>(new Set());
const BrowserRoleContext = createContext<"desk" | "visit" | "keeper">("desk");
const StayFillContext = createContext<string | null>(null);

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

/** The panel that is maximized in place. Its browser stays where it is and only changes size. */
export function StayFillProvider({ id, children }: { id: string | null; children: ReactNode }) {
  return <StayFillContext.Provider value={id}>{children}</StayFillContext.Provider>;
}

export function useStayFill(): string | null {
  return useContext(StayFillContext);
}

function ownerId(panelId: string): string {
  const split = panelId.indexOf(":");
  return split === -1 ? panelId : panelId.slice(0, split);
}

const owners = new Map<string, { count: number; generation: number; closeTimer: number; url: string }>();

/**
 * A browser that is about to close because its panel moved. The next page with the same URL
 * claims it and keeps the native webview, instead of opening a blank one.
 */
export function donorBrowser(
  waiting: Array<{ label: string; url: string }>,
  url: string,
  nextLabel: string,
): string | null {
  const page = url.trim();
  if (!page) return null;
  return waiting.find((item) => item.label !== nextLabel && item.url === page)?.label ?? null;
}

/** One native window per panel. The last owner closes it after the next paint, so a visit can hand it back to the desk. */
export function holdBrowser(label: string): { generation: number; reload: boolean } {
  const slot = owners.get(label);
  if (slot) {
    if (slot.closeTimer) {
      window.clearTimeout(slot.closeTimer);
      slot.closeTimer = 0;
    }
    slot.count += 1;
    // The page is still open. Navigating here reloads it, which is what maximize
    // did when the desk handed the same browser to the visit.
    return { generation: slot.generation, reload: false };
  }
  const generation = nextBrowserGeneration();
  owners.set(label, { count: 1, generation, closeTimer: 0, url: "" });
  return { generation, reload: false };
}

export function dropBrowser(label: string, generation: number, url = "") {
  const slot = owners.get(label);
  if (!slot || slot.generation !== generation) return;
  slot.count -= 1;
  if (url) slot.url = url;
  if (slot.count > 0) return;
  if (slot.closeTimer) window.clearTimeout(slot.closeTimer);
  slot.closeTimer = window.setTimeout(() => {
    const current = owners.get(label);
    if (!current || current.generation !== generation || current.count > 0) return;
    owners.delete(label);
    void closeBrowser(label, generation);
  }, 0);
}

/** Take a browser that is closing with this URL, so a drop onto a tab can keep its page. */
export function claimMovingBrowser(url: string, nextLabel: string): { from: string; generation: number } | null {
  const waiting = [...owners.entries()]
    .filter(([, slot]) => slot.count <= 0 && slot.closeTimer !== 0)
    .map(([label, slot]) => ({ label, url: slot.url }));
  const from = donorBrowser(waiting, url, nextLabel);
  if (!from) return null;
  const slot = owners.get(from);
  if (!slot) return null;
  window.clearTimeout(slot.closeTimer);
  slot.closeTimer = 0;
  const generation = slot.generation;
  owners.delete(from);
  return { from, generation };
}

/** The visit paints a panel it owns. The desk hides the rest and does not close them. */
export function browserLeader(
  role: "desk" | "visit" | "keeper",
  ids: ReadonlySet<string> | null,
  keptIds: ReadonlySet<string>,
  panelId: string,
  stayId: string | null = null,
): { leader: boolean; hide: boolean } {
  const owner = ownerId(panelId);
  const inVisit = Boolean(ids?.has(panelId) || ids?.has(owner));
  const kept = keptIds.has(panelId) || keptIds.has(owner);
  const stay = stayId != null && (stayId === panelId || stayId === owner);
  if (!ids) return { leader: role === "desk", hide: false };
  if (kept && !stay) return { leader: role === "keeper", hide: !inVisit };
  if (inVisit && stay) {
    if (role === "desk") return { leader: true, hide: false };
    return { leader: false, hide: true };
  }
  if (inVisit) return { leader: role === "visit", hide: role !== "visit" };
  return { leader: role === "desk", hide: true };
}
