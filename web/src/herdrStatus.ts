import type { HerdrCtlStatus } from "./api";
import type { RuntimeSnapshot } from "./types";

export type HerdrStatusAction = "start" | "update" | "restart";

export interface HerdrStatusView {
  label: string;
  title: string;
  tone: "live" | "down" | "update";
  action: HerdrStatusAction | null;
}

/** Pick the top-bar Herdr chip label and click action. */
export function herdrStatusView(
  runtime: RuntimeSnapshot | null,
  ctl: HerdrCtlStatus | null,
): HerdrStatusView {
  const connected = runtime?.connected === true;
  const version = (runtime?.version || ctl?.clientVersion || "").trim();
  if (!connected) {
    return {
      label: "Herdr offline",
      title: "Start Herdr",
      tone: "down",
      action: "start",
    };
  }
  if (ctl?.restartNeeded || ctl?.serverBinaryStale) {
    return {
      label: version ? `Restart Herdr ${version}` : "Restart Herdr",
      title: "An update is installed. Restart Herdr to use it.",
      tone: "update",
      action: "restart",
    };
  }
  if (ctl?.updateAvailable) {
    const latest = ctl.latestVersion?.trim();
    return {
      label: latest ? `Update Herdr → ${latest}` : "Update Herdr",
      title: latest ? `Download and install Herdr ${latest}` : "Download and install the latest Herdr",
      tone: "update",
      action: "update",
    };
  }
  return {
    label: version ? `Herdr ${version}` : "Herdr",
    title: runtime?.error ?? runtime?.socket ?? "",
    tone: "live",
    action: null,
  };
}
