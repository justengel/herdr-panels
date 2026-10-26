import { describe, expect, it } from "vitest";
import { herdrStatusView } from "../src/herdrStatus";
import type { RuntimeSnapshot } from "../src/types";

const online: RuntimeSnapshot = {
  connected: true,
  socket: "sock",
  version: "0.9.5",
  workspaces: [],
  panes: [],
  agents: [],
};

const offline: RuntimeSnapshot = {
  connected: false,
  socket: "sock",
  workspaces: [],
  panes: [],
  agents: [],
};

describe("herdr status chip", () => {
  it("offers start when Herdr is offline", () => {
    expect(herdrStatusView(offline, null)).toMatchObject({
      label: "Herdr offline",
      action: "start",
      tone: "down",
    });
  });

  it("offers update when a newer release is available", () => {
    expect(
      herdrStatusView(online, {
        serverRunning: true,
        restartNeeded: false,
        serverBinaryStale: false,
        updateAvailable: true,
        latestVersion: "0.9.6",
        clientVersion: "0.9.5",
      }),
    ).toMatchObject({
      label: "Update Herdr → 0.9.6",
      action: "update",
      tone: "update",
    });
  });

  it("offers restart when an installed update needs it", () => {
    expect(
      herdrStatusView(online, {
        serverRunning: true,
        restartNeeded: true,
        serverBinaryStale: false,
        updateAvailable: false,
        clientVersion: "0.9.6",
      }),
    ).toMatchObject({
      action: "restart",
      tone: "update",
    });
  });

  it("stays idle when connected and current", () => {
    expect(
      herdrStatusView(online, {
        serverRunning: true,
        restartNeeded: false,
        serverBinaryStale: false,
        updateAvailable: false,
        clientVersion: "0.9.5",
      }),
    ).toMatchObject({
      label: "Herdr 0.9.5",
      action: null,
      tone: "live",
    });
  });
});
