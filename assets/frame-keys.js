/* hwp-frame-keys */
function hwpFrameKeyAction(state, event) {
  const prefix = state.prefix;
  if (!prefix) return { armed: false, send: false };
  const key = event.key;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
    return { armed: state.armed, send: false };
  }
  const named = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  const alias = { arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down", escape: "esc", " ": "space" };
  const pressed = alias[named] || named;
  const same =
    prefix.ctrl === Boolean(event.ctrlKey) &&
    prefix.alt === Boolean(event.altKey) &&
    prefix.meta === Boolean(event.metaKey) &&
    (pressed === prefix.key || (prefix.key === "?" && pressed === "/")) &&
    (prefix.shift ? Boolean(event.shiftKey) : !(/^[a-z1-9]$/.test(prefix.key) && event.shiftKey));
  if (!state.armed) {
    if (event.repeat || !same) return { armed: false, send: false };
    return { armed: true, send: true };
  }
  if (same) return { armed: true, send: false };
  return { armed: false, send: true };
}

globalThis.hwpFrameKeyAction = hwpFrameKeyAction;

if (typeof window !== "undefined" && window.parent && window.parent !== window && !window.__hwpFrameKeys) {
  window.__hwpFrameKeys = true;
  let prefix = null;
  let token = "";
  let armed = false;
  function ask() {
    try {
      window.parent.postMessage({ source: "hwp-keys", type: "ready" }, "*");
    } catch (err) {
      /* The frame cannot see its parent yet. */
    }
  }
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "hwp-host" || data.type !== "prefix") return;
    prefix = data.chord || null;
    token = typeof data.token === "string" ? data.token : "";
    armed = false;
  });
  ask();
  const asking = window.setInterval(() => {
    if (token) {
      window.clearInterval(asking);
      return;
    }
    ask();
  }, 300);
  window.addEventListener(
    "keydown",
    (event) => {
      const next = hwpFrameKeyAction({ prefix, armed }, event);
      armed = next.armed;
      if (!next.send || !token) return;
      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage(
        {
          source: "hwp-keys",
          token,
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
        },
        "*",
      );
    },
    true,
  );
}
