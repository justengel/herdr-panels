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

  // Same rule as frameLinkAction in web/src/externalLink.ts.
  // A clicked http(s) link that leaves this page asks the host for a new browsing context.
  // The desktop window turns that into the system browser. A browser tab opens a new tab.
  function frameLinkAction(href, pageHref, target) {
    let url;
    let page;
    try {
      url = new URL(href, pageHref);
      page = new URL(pageHref);
    } catch (err) {
      return "block";
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return "block";
    const blank = String(target || "").toLowerCase() === "_blank";
    const sameDocument =
      url.origin === page.origin &&
      url.pathname === page.pathname &&
      url.search === page.search &&
      url.hash.length > 0;
    if (sameDocument && !blank) return "stay";
    if (!blank && url.origin === page.origin) return "stay";
    return "open";
  }

  function openFrameLink(event) {
    if (event.defaultPrevented) return;
    if (event.type === "auxclick" && event.button !== 1) return;
    if (event.type === "click" && event.button !== 0) return;
    const node = event.target;
    if (!node || !node.closest) return;
    const anchor = node.closest("a[href]");
    if (!anchor) return;
    const action = frameLinkAction(anchor.href, window.location.href, anchor.target);
    if (action === "stay") return;
    event.preventDefault();
    if (action === "open") window.open(anchor.href, "_blank", "noopener,noreferrer");
  }

  document.addEventListener("click", openFrameLink);
  document.addEventListener("auxclick", openFrameLink);
}
