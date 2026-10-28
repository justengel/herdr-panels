/* hwp-bridge */
(() => {
  const SOURCE = "hwp-panel";
  const HOST = "hwp-host";
  const pending = new Map();
  let seq = 0;
  let design = false;

  const style = document.createElement("style");
  style.textContent =
    "html.hwp-design, html.hwp-design * { cursor: crosshair !important; } .hwp-hit { outline: 2px solid #e6b35a !important; outline-offset: 2px; }";
  document.documentElement.appendChild(style);

  document.addEventListener(
    "click",
    (event) => {
      if (!design) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      event.preventDefault();
      event.stopPropagation();
      const el = target.closest("body *") || target;
      const text = (el.textContent || el.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      parent.postMessage(
        {
          source: SOURCE,
          type: "pick",
          tag: el.tagName.toLowerCase(),
          text,
        },
        "*",
      );
    },
    true,
  );

  function call(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parent.postMessage({ source: SOURCE, id, method, params: params ?? {} }, "*");
    });
  }

  window.herdrPanels = {
    status: () => call("status"),
    listPanes: () => call("listPanes"),
    sendText: (paneId, text) => call("sendText", { paneId, text }),
    sendKeys: (paneId, keys) => call("sendKeys", { paneId, keys }),
    readPane: (paneId, source) => call("readPane", { paneId, source: source || "visible" }),
    focusPane: (paneId) => call("focusPane", { paneId }),
    listPanels: () => call("listPanels"),
    openPanel: (target, options) => call("openPanel", Object.assign({ target }, options || {})),
    updatePanel: (panelId, options) => call("updatePanel", Object.assign({ panelId }, options || {})),
    closePanel: (panelId) => call("closePanel", { panelId }),
    movePanel: (panelId, target, place) => call("movePanel", { panelId, target, place: place || "swap" }),
    resizePanel: (panelId, ratio) => call("resizePanel", { panelId, ratio }),
    fillPanel: (panelId) => call("fillPanel", { panelId }),
    showDesk: () => call("showDesk"),
    visitPanel: (panelId) => call("visitPanel", { panelId }),
    visitPanels: (panelIds, arrange) => call("visitPanel", { panelIds, arrange }),
    setZoom: (scale) => call("setZoom", { scale }),
    scrollPane: (paneId, direction, lines) => call("scrollPane", { paneId, direction, lines }),
    openExternal: (url) => {
      let popup = null;
      try {
        popup = window.open("about:blank", "_blank");
      } catch (err) {
        popup = null;
      }
      return call("openExternal", { url }).then(
        (result) => {
          const approved = result && result.url;
          if (popup && approved) {
            try {
              popup.location.replace(approved);
            } catch (err) {
              popup.close();
              throw new Error("the browser blocked the new tab");
            }
            try {
              popup.opener = null;
            } catch (err) {
              /* The new page has already left this frame. */
            }
          } else if (!popup && !(result && result.opened)) {
            throw new Error("the browser blocked the new tab");
          }
          return result;
        },
        (error) => {
          if (popup) popup.close();
          throw error;
        },
      );
    },
  };

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.source !== HOST) return;
    if (msg.type === "design") {
      design = Boolean(msg.enabled);
      document.documentElement.classList.toggle("hwp-design", design);
      return;
    }
    if (msg.type === "inspect") {
      parent.postMessage(
        {
          source: SOURCE,
          type: "inspect-result",
          requestId: msg.requestId,
          result: inspect(msg.selector, msg.text),
        },
        "*",
      );
      return;
    }
    if (msg.type === "highlight") {
      document.querySelectorAll(".hwp-hit").forEach((el) => el.classList.remove("hwp-hit"));
      if (!msg.selector && !msg.text) return;
      for (const el of find(msg.selector, msg.text).slice(0, 20)) el.classList.add("hwp-hit");
      return;
    }
    if (!msg.id || !pending.has(msg.id)) {
      return;
    }
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) {
      waiter.resolve(msg.result);
    } else {
      waiter.reject(new Error(msg.error || "request failed"));
    }
  });

  if (window.__hwpInstallSelect) {
    window.__hwpInstallSelect({
      draw: false,
      send(message) {
        parent.postMessage(Object.assign({ source: SOURCE }, message), "*");
      },
    });
  }

  function find(selector, text) {
    const candidates = "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,a,button,label,td,th,input,code";
    let nodes = [];
    if (selector && String(selector).length <= 200) {
      try {
        nodes = [...document.querySelectorAll(selector)];
      } catch {
        nodes = [];
      }
    }
    if (nodes.length === 0 && !selector) nodes = [...document.querySelectorAll(candidates)];
    const needle = String(text || "").trim().toLowerCase();
    return nodes.filter((el) => {
      const body = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (needle && !body.includes(needle)) return false;
      return body.length > 0 || el.matches("input, img, button");
    });
  }

  function inspect(selector, text) {
    const styleNames = ["color", "backgroundColor", "fontSize", "fontFamily", "display", "width", "height", "margin", "padding"];
    const elements = find(selector, text).slice(0, 40).map((el) => {
      const computed = getComputedStyle(el);
      const style = {};
      for (const name of styleNames) style[name] = computed[name];
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
        style,
      };
    });
    return {
      accessible: true,
      title: document.title,
      html: document.documentElement.outerHTML.slice(0, 12000),
      css: [...document.querySelectorAll("style")].map((node) => node.textContent || "").join("\n").slice(0, 8000),
      elements,
    };
  }
})();
