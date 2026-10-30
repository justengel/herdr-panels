export interface PanelsUp {
  state: "up";
  version: string;
  dev: boolean;
  build: string;
  address: string;
  port: string;
}

export type PanelsLink = { state: "pending" } | { state: "down" } | PanelsUp;

export interface PanelsFact {
  label: string;
  value: string;
}

export interface PanelsStatusView {
  label: string;
  tone: "live" | "down" | "wait";
  lines: PanelsFact[];
}

/** The top-bar Panels chip. A development build keeps the port in the label. */
export function panelsStatusView(link: PanelsLink): PanelsStatusView {
  if (link.state === "pending") {
    return { label: "Panels", tone: "wait", lines: [] };
  }
  if (link.state === "down") {
    return {
      label: "Panels offline",
      tone: "down",
      lines: [{ label: "Status", value: "This page cannot reach its server" }],
    };
  }
  const version = link.version.trim();
  const lines: PanelsFact[] = [
    { label: "Address", value: link.address },
    { label: "Version", value: version || "unknown" },
    { label: "Build", value: link.build },
  ];
  if (link.dev) lines.push({ label: "Mode", value: "Development" });
  return {
    label: version ? `Panels ${version}` : "Panels",
    tone: "live",
    lines,
  };
}
