import type { ReactNode } from "react";
import type { TabFrame } from "../tabFrame";
import type { TabEdge } from "../types";

/**
 * Side rails are siblings of the center, so they run the full height.
 * The top and bottom strips sit in the center and stop where a rail starts.
 */
export function TabFrameLayout({
  frame,
  open,
  strip,
  children,
}: {
  frame: TabFrame;
  /** Strips to draw. Absent draws each edge that has a tab. */
  open?: readonly TabEdge[];
  strip: (edge: TabEdge) => ReactNode;
  children: ReactNode;
}) {
  const shown = open ?? (["left", "top", "bottom", "right"] as const).filter((edge) => frame[edge].length > 0);
  const has = (edge: TabEdge) => shown.includes(edge);
  return (
    <>
      {has("left") ? strip("left") : null}
      <div className="panel-well">
        {has("top") ? strip("top") : null}
        {children}
        {has("bottom") ? strip("bottom") : null}
      </div>
      {has("right") ? strip("right") : null}
    </>
  );
}
