import { createContext, useContext } from "react";

export interface ElementPick {
  panelId: string;
  tag: string;
  text: string;
}

export interface DesignState {
  enabled: boolean;
  selectedId: string | null;
  element: ElementPick | null;
  selectPanel: (id: string) => void;
  selectElement: (pick: ElementPick) => void;
}

const DesignContext = createContext<DesignState>({
  enabled: false,
  selectedId: null,
  element: null,
  selectPanel: () => undefined,
  selectElement: () => undefined,
});

export function DesignProvider({
  value,
  children,
}: {
  value: DesignState;
  children: React.ReactNode;
}) {
  return <DesignContext.Provider value={value}>{children}</DesignContext.Provider>;
}

export function useDesign(): DesignState {
  return useContext(DesignContext);
}
