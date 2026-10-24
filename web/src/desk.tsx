import { createContext, useContext } from "react";
import type { TabView } from "./types";

export interface PluginInfo {
  id: string;
  title: string;
}

interface Desk {
  tabs: TabView[];
  focusedTabId: string | null;
  focusedWorkspaceId: string | null;
  plugins: PluginInfo[];
  onFocusTab: (tabId: string) => void;
}

const DeskContext = createContext<Desk>({
  tabs: [],
  focusedTabId: null,
  focusedWorkspaceId: null,
  plugins: [],
  onFocusTab: () => undefined,
});

export function DeskProvider({ value, children }: { value: Desk; children: React.ReactNode }) {
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

export function useDesk(): Desk {
  return useContext(DeskContext);
}
