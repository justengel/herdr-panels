import { describe, expect, it } from "vitest";
import { panelsStatusView } from "../src/panelsStatus";

const up = {
  state: "up" as const,
  version: "0.1.10",
  dev: false,
  build: "0123456789abcdef",
  address: "http://127.0.0.1:4737",
  port: "4737",
};

describe("panels status chip", () => {
  it("waits without claiming the server is down", () => {
    expect(panelsStatusView({ state: "pending" })).toMatchObject({
      label: "Panels",
      tone: "wait",
      lines: [],
    });
  });

  it("names a release by its version and keeps the port for the hover", () => {
    const view = panelsStatusView(up);
    expect(view.label).toBe("Panels 0.1.10");
    expect(view.tone).toBe("live");
    expect(view.lines).toEqual([
      { label: "Address", value: "http://127.0.0.1:4737" },
      { label: "Version", value: "0.1.10" },
      { label: "Build", value: "0123456789abcdef" },
    ]);
  });

  it("keeps a development build on the version and puts the address in the hover", () => {
    const view = panelsStatusView({ ...up, dev: true, port: "4741", address: "http://127.0.0.1:4741" });
    expect(view.label).toBe("Panels 0.1.10");
    expect(view.lines.find((line) => line.label === "Mode")?.value).toBe("Development");
    expect(view.lines.find((line) => line.label === "Address")?.value).toBe("http://127.0.0.1:4741");
  });

  it("says offline when the server does not answer", () => {
    expect(panelsStatusView({ state: "down" })).toMatchObject({
      label: "Panels offline",
      tone: "down",
    });
  });
});
