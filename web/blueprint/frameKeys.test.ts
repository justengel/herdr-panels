import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { frameOwnsKeys, framePrefix, readFrameKey } from "../src/frameKeys";

const source = readFileSync(new URL("../../assets/frame-keys.js", import.meta.url), "utf8");

function action(state: { prefix: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string } | null; armed: boolean }, event: Record<string, unknown>) {
  const sandbox = createContext({}) as { hwpFrameKeyAction?: (state: unknown, event: unknown) => { armed: boolean; send: boolean } };
  runInContext(source, sandbox);
  const decide = sandbox.hwpFrameKeyAction;
  if (!decide) throw new Error("frame key action was not installed");
  return decide(state, { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, key: "", ...event });
}

const ctrlB = { ctrl: true, alt: false, shift: false, meta: false, key: "b" };

describe("frame prefix keys", () => {
  it("describes the Herdr prefix chord", () => {
    expect(framePrefix("ctrl+b")).toEqual(ctrlB);
    expect(framePrefix("")).toBeNull();
  });

  it("sends the prefix and the following key, and leaves ordinary typing alone", () => {
    const armed = action({ prefix: ctrlB, armed: false }, { key: "b", ctrlKey: true });
    expect(armed).toEqual({ armed: true, send: true });
    const again = action({ prefix: ctrlB, armed: true }, { key: "b", ctrlKey: true, repeat: true });
    expect(again).toEqual({ armed: true, send: false });
    const letter = action({ prefix: ctrlB, armed: false }, { key: "z" });
    expect(letter.send).toBe(false);
    const follow = action({ prefix: ctrlB, armed: true }, { key: "z" });
    expect(follow).toEqual({ armed: false, send: true });
    const shifted = action({ prefix: ctrlB, armed: true }, { key: "Shift" });
    expect(shifted).toEqual({ armed: true, send: false });
  });

  it("accepts a key only with the frame token", () => {
    const key = { source: "hwp-keys", token: "secret", key: "z", code: "KeyZ", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false };
    expect(readFrameKey(key, "secret")?.key).toBe("z");
    expect(readFrameKey({ ...key, token: "other" }, "secret")).toBeNull();
    expect(readFrameKey({ ...key, source: "page" }, "secret")).toBeNull();
  });

  it("recognizes a plugin frame by its address", () => {
    expect(frameOwnsKeys({ getAttribute: () => "/plugins/welcome" })).toBe(true);
    expect(frameOwnsKeys({ getAttribute: () => "http://127.0.0.1:4737/plugins/checkin-report" })).toBe(true);
    expect(frameOwnsKeys({ getAttribute: () => "https://example.com" })).toBe(false);
  });
});
