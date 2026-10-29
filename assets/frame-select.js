/* hwp-frame-select */
(() => {
  if (window.__hwpInstallSelect) return;
  const ITEM =
    "button, a, input, textarea, select, label, li, h1, h2, h3, h4, h5, h6, p, pre, blockquote, .tree-row, .agent-row, .space-row, .panel-title, [role='tab']";

  function asRect(rect) {
    const x = Number(rect.x ?? rect.left ?? 0);
    const y = Number(rect.y ?? rect.top ?? 0);
    const width = Math.max(0, Number(rect.width ?? 0));
    const height = Math.max(0, Number(rect.height ?? 0));
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
  }

  function covered(rect, marquee) {
    const area = rect.width * rect.height;
    if (area <= 0) return false;
    const width = Math.max(0, Math.min(rect.right, marquee.right) - Math.max(rect.left, marquee.left));
    const height = Math.max(0, Math.min(rect.bottom, marquee.bottom) - Math.max(rect.top, marquee.top));
    return (width * height) / area >= 0.55;
  }

  function centerInside(rect, marquee) {
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return x >= marquee.left && x <= marquee.right && y >= marquee.top && y <= marquee.bottom;
  }

  function overlapRatio(left, right) {
    const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
    const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    const small = Math.min(left.width * left.height, right.width * right.height);
    if (small <= 0) return 0;
    return (width * height) / small;
  }

  function selectable(node) {
    if (!(node instanceof Element)) return false;
    if (node.closest(".hwp-select-ui")) return false;
    const svg = node.namespaceURI === "http://www.w3.org/2000/svg";
    if (svg && node.tagName.toLowerCase() !== "svg") return false;
    if (!(node instanceof HTMLElement) && !svg) return false;
    const rect = node.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function promote(element, marquee) {
    const item = element.closest(ITEM);
    if (!(item instanceof Element) || item === element) return element;
    if (item.closest(".hwp-select-ui")) return element;
    const rect = asRect(item.getBoundingClientRect());
    if (covered(rect, marquee) || centerInside(rect, marquee)) return item;
    return element;
  }

  function elementsIn(raw) {
    const marquee = asRect(raw);
    const hits = [];
    const root = document.body || document.documentElement;
    for (const node of root.querySelectorAll("*")) {
      if (!selectable(node)) continue;
      const rect = asRect(node.getBoundingClientRect());
      if (!covered(rect, marquee) && !centerInside(rect, marquee)) continue;
      hits.push(node);
    }
    const deepest = hits.filter((element) => !hits.some((other) => other !== element && element.contains(other)));
    const promoted = deepest.map((element) => promote(element, marquee));
    const unique = [];
    for (const element of promoted) {
      if (!unique.includes(element)) unique.push(element);
    }
    unique.sort((left, right) => {
      const pos = left.compareDocumentPosition(right);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return collapseOverlaps(unique);
  }

  function collapseOverlaps(elements) {
    const kept = [];
    for (const element of elements) {
      const rect = asRect(element.getBoundingClientRect());
      const index = kept.findIndex((other) => overlapRatio(rect, asRect(other.getBoundingClientRect())) > 0.85);
      if (index < 0) {
        kept.push(element);
        continue;
      }
      const previous = textOf(kept[index]).length;
      const next = textOf(element).length;
      if (next > previous) kept[index] = element;
    }
    return kept;
  }

  function textOf(element) {
    return String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")
      .replace(/\u00a0/g, " ")
      .trim()
      .slice(0, 4000);
  }

  function pageCss() {
    return [...document.querySelectorAll("style")]
      .map((node) => node.textContent || "")
      .join("\n")
      .slice(0, 80000);
  }

  function record(element) {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      text: textOf(element),
      html: String(element.outerHTML || "").slice(0, 80000),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }

  function targetOf(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    if (target.closest(".hwp-select-ui")) return null;
    if (target === document.body || target === document.documentElement) return null;
    return target;
  }

  window.__hwpInstallSelect = function install(options) {
    if (window.__hwpSelectInstalled) return;
    window.__hwpSelectInstalled = true;
    const draw = Boolean(options && options.draw);
    const send = options && options.send ? options.send : () => {};
    let enabled = false;
    let drag = null;
    let chosen = [];
    let ui = null;

    function whenReady(run) {
      if (document.documentElement) run();
      else document.addEventListener("DOMContentLoaded", run, { once: true });
    }

    function overlay() {
      if (!draw || !document.documentElement) return null;
      if (!ui) ui = createUi();
      return ui;
    }

    whenReady(() => {
      const style = document.createElement("style");
      style.textContent =
        "html.hwp-select, html.hwp-select * { cursor: crosshair !important; user-select: none !important; } html.hwp-select .hwp-select-ui, html.hwp-select .hwp-select-ui * { cursor: default !important; user-select: auto !important; }";
      document.documentElement.appendChild(style);
      overlay();
    });

    window.__hwpSetSelect = (on) => {
      enabled = Boolean(on);
      drag = null;
      if (!enabled) chosen = [];
      whenReady(() => {
        document.documentElement.classList.toggle("hwp-select", enabled);
        const layer = overlay();
        if (!enabled && layer) layer.clear();
      });
    };

    window.__hwpHits = (rect) => elementsIn(rect).slice(0, 40).map(record);

    document.addEventListener(
      "pointermove",
      (event) => {
        if (!enabled) return;
        if (drag) {
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (!drag.moved && Math.hypot(dx, dy) < 4) return;
          drag.moved = true;
          const rect = asRect(boxFrom(drag.x, drag.y, event.clientX, event.clientY));
          const layer = overlay();
          if (layer) layer.marquee(rect);
          else if (!draw) send({ type: "select-marquee", rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
          return;
        }
        if (chosen.length > 0) {
          if (!draw) send({ type: "select-pointer", phase: "move", x: event.clientX, y: event.clientY });
          return;
        }
        if (event.target instanceof Element && event.target.closest(".hwp-select-ui")) return;
        const element = targetOf(event);
        const layer = overlay();
        if (!element) {
          if (layer) layer.hover(null);
          else if (!draw) send({ type: "select-hover", rect: null });
          if (!draw) send({ type: "select-pointer", phase: "move", x: event.clientX, y: event.clientY });
          return;
        }
        const rect = element.getBoundingClientRect();
        const local = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        if (layer) layer.hover(asRect(rect));
        else if (!draw) send({ type: "select-hover", rect: local });
        if (!draw) send({ type: "select-pointer", phase: "move", x: event.clientX, y: event.clientY });
      },
      true,
    );

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!enabled || event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest(".hwp-select-ui")) return;
        event.preventDefault();
        event.stopPropagation();
        drag = { x: event.clientX, y: event.clientY, moved: false };
        chosen = [];
        const layer = overlay();
        if (layer) layer.pick([], false);
        else if (!draw) send({ type: "select-clear" });
        const cap = event.target;
        if (cap instanceof Element && cap.setPointerCapture) {
          try {
            cap.setPointerCapture(event.pointerId);
          } catch {
            // The frame still receives the gesture when the pointer stays inside it.
          }
        }
      },
      true,
    );

    document.addEventListener(
      "pointerup",
      (event) => {
        if (!enabled) return;
        if (!drag) {
          if (!draw) send({ type: "select-pointer", phase: "up", x: event.clientX, y: event.clientY });
          return;
        }
        const start = drag;
        drag = null;
        const layer = overlay();
        if (layer) layer.marquee(null);
        else if (!draw) send({ type: "select-marquee", rect: null });
        if (start.moved) {
          const rect = asRect(boxFrom(start.x, start.y, event.clientX, event.clientY));
          finish(elementsIn(rect), true);
          return;
        }
        const element = targetOf(event);
        finish(element ? [element] : [], false);
      },
      true,
    );

    document.addEventListener(
      "click",
      (event) => {
        if (!enabled) return;
        if (event.target instanceof Element && event.target.closest(".hwp-select-ui")) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );

    window.addEventListener(
      "scroll",
      () => {
        if (!enabled || chosen.length === 0) return;
        const elements = chosen.map(record);
        const layer = overlay();
        if (layer) layer.boxes(chosen);
        else if (!draw) send({ type: "select-scroll", elements });
      },
      true,
    );

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.source !== "hwp-host" || event.source !== window.parent) return;
      if (msg.type === "select") {
        window.__hwpSetSelect(Boolean(msg.enabled));
        if (msg.enabled) send({ type: "select-ready" });
        return;
      }
      if (msg.type === "select-query") {
        send({
          type: "select-hits",
          requestId: msg.requestId,
          css: pageCss(),
          elements: window.__hwpHits(msg.rect || {}),
        });
        return;
      }
      if (msg.type === "select-at") {
        const found = document.elementFromPoint(Number(msg.x) || 0, Number(msg.y) || 0);
        const picked = found ? targetOf({ target: found }) : null;
        send({
          type: "select-at-result",
          requestId: msg.requestId,
          css: pageCss(),
          element: picked ? record(picked) : null,
        });
      }
    });

    function finish(elements, dragged) {
      chosen = elements.slice(0, 40);
      const payload = {
        type: "select-result",
        dragged,
        css: pageCss(),
        elements: chosen.map(record),
      };
      const layer = overlay();
      if (layer) layer.pick(chosen, dragged);
      else if (!draw) send(payload);
    }

    function boxFrom(x1, y1, x2, y2) {
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    }

    function createUi() {
      let closeShot = () => {};
      let shotGeneration = 0;
      const layer = document.createElement("div");
      layer.className = "hwp-select-ui";
      layer.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
      const boxes = document.createElement("div");
      const menu = document.createElement("div");
      menu.style.cssText =
        "position:fixed;display:none;pointer-events:auto;gap:8px;align-items:center;max-width:360px;padding:6px;background:#181b20;color:#e7e4dc;border:1px solid #3c4451;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);font:12px Segoe UI,sans-serif;";
      const label = document.createElement("span");
      label.style.cssText = "color:#9aa3b2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      menu.append(label, button("Copy", () => copyText()), button("HTML", () => copyHtml()), button("Screenshot", () => void copyShot()));
      const status = document.createElement("span");
      status.style.cssText = "color:#9aa3b2;";
      menu.append(status);
      layer.append(boxes, menu);
      document.documentElement.appendChild(layer);

      function button(text, onClick) {
        const node = document.createElement("button");
        node.type = "button";
        node.textContent = text;
        node.style.cssText = "border:0;background:transparent;color:inherit;padding:4px 6px;border-radius:4px;cursor:pointer;";
        node.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        });
        return node;
      }

      function paint(rect, dashed) {
        const node = document.createElement("div");
        node.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;border:${dashed ? "1px dashed" : "2px solid"} #e2b657;background:rgba(226,182,87,${dashed ? 0.12 : 0.16});pointer-events:none;`;
        return node;
      }

      return {
        hover(rect) {
          boxes.replaceChildren(rect ? paint(rect, false) : "");
        },
        marquee(rect) {
          boxes.replaceChildren(rect ? paint(rect, true) : "");
        },
        boxes(elements) {
          boxes.replaceChildren(...elements.map((element) => paint(asRect(element.getBoundingClientRect()), false)));
        },
        pick(elements, dragged) {
          this.boxes(elements);
          if (elements.length === 0) {
            if (!dragged) {
              menu.style.display = "none";
              return;
            }
            label.textContent = "";
            status.textContent = "Nothing in that box";
            menu.style.display = "flex";
            return;
          }
          label.textContent = elements.length === 1 ? elements[0].tagName.toLowerCase() : `${elements.length} items`;
          status.textContent = "";
          const bounds = union(elements.map((element) => asRect(element.getBoundingClientRect())));
          const below = bounds.bottom + 8;
          const top = below + 36 < window.innerHeight ? below : Math.max(8, bounds.top - 40);
          menu.style.display = "flex";
          menu.style.top = `${top}px`;
          menu.style.left = `${Math.min(Math.max(8, bounds.left), window.innerWidth - 280)}px`;
        },
        clear() {
          closeShot();
          boxes.replaceChildren();
          menu.style.display = "none";
        },
      };

      function copyText() {
        const text = chosen.map((element) => textOf(element)).filter(Boolean).join("\n");
        write(text, "Copied", "Nothing to copy");
      }
      function copyHtml() {
        write(chosen.map((element) => element.outerHTML).join("\n"), chosen.length === 1 ? "Copied HTML" : `Copied HTML for ${chosen.length} elements`, "Nothing to copy");
      }
      function copyShot() {
        const generation = ++shotGeneration;
        const pending = raster(chosen);
        const copied = writePng(pending);
        const name = shotName();
        pending.then(
          (blob) => {
            const giveUp = new Promise((resolve) => setTimeout(() => resolve(false), 700));
            Promise.race([copied, giveUp]).then((ok) => {
              if (generation !== shotGeneration) return;
              offerShot(blob, ok === true, name, generation);
              if (ok === true) return;
              copied.then((later) => {
                if (generation !== shotGeneration || later !== true) return;
                const text = layer.querySelector(".hwp-shot-dialog p");
                if (text) {
                  text.textContent =
                    "Copied to the clipboard. Save a PNG if it does not paste. Save downloads a PNG into your Downloads folder. Nothing is written until you choose Save.";
                }
              });
            });
          },
          (err) => {
            if (generation !== shotGeneration) return;
            status.textContent = err instanceof Error ? err.message : "Could not take the screenshot";
          },
        );
      }
      function writePng(pending) {
        const clipboard = navigator.clipboard;
        if (!clipboard || !clipboard.write || typeof ClipboardItem === "undefined") return Promise.resolve(false);
        const typed = pending.then((blob) => (blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" })));
        const write = (blob) =>
          clipboard.write([new ClipboardItem({ "image/png": blob })]).then(
            () => true,
            () => false,
          );
        try {
          return write(typed).then((ok) => (ok ? true : writeBlob(typed)));
        } catch {
          return writeBlob(typed);
        }
        function writeBlob(value) {
          return value.then(
            (blob) => write(blob),
            () => false,
          );
        }
      }
      function shotName() {
        const now = new Date();
        const pad = (value) => String(value).padStart(2, "0");
        return `herdr-panels-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
      }
      function offerShot(blob, copied, name, generation) {
        closeShot();
        const lead = copied
          ? "Copied to the clipboard. Save a PNG if it does not paste."
          : "The clipboard did not take this image.";
        const dialog = document.createElement("div");
        dialog.className = "hwp-shot-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-label", "Screenshot");
        dialog.style.cssText =
          "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.45);pointer-events:auto;";
        const card = document.createElement("div");
        card.style.cssText =
          "width:min(420px,calc(100vw - 32px));padding:16px;background:#181b20;color:#e7e4dc;border:1px solid #3c4451;border-radius:8px;display:flex;flex-direction:column;gap:12px;font:13px/1.45 Segoe UI,sans-serif;";
        const heading = document.createElement("strong");
        heading.textContent = "Screenshot";
        heading.style.fontSize = "16px";
        const text = document.createElement("p");
        text.style.margin = "0";
        text.textContent = `${lead} Save downloads a PNG into your Downloads folder. Nothing is written until you choose Save.`;
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;justify-content:space-between;gap:8px;";
        const save = choice("Save", () => {
          downloadBlob(blob, name);
          status.textContent = "Saving to Downloads";
          close();
        });
        const dismiss = choice("Don't save", close);
        actions.append(save, dismiss);
        card.append(heading, text, actions);
        dialog.append(card);
        dialog.addEventListener("mousedown", (event) => {
          if (event.target === dialog) close();
        });
        function close() {
          if (shotGeneration === generation) shotGeneration += 1;
          closeShot = () => {};
          dialog.remove();
          window.removeEventListener("keydown", onKey, true);
        }
        function onKey(event) {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        window.addEventListener("keydown", onKey, true);
        closeShot = close;
        layer.append(dialog);
        dismiss.focus();
      }
      function choice(label, onClick) {
        const node = document.createElement("button");
        node.type = "button";
        node.textContent = label;
        node.style.cssText =
          "border:1px solid #3c4451;background:#22262e;color:inherit;padding:6px 10px;border-radius:4px;cursor:pointer;";
        node.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        });
        return node;
      }
      function downloadBlob(blob, name) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      function write(text, ok, empty) {
        if (!text.trim()) {
          status.textContent = empty;
          return;
        }
        navigator.clipboard.writeText(text).then(
          () => {
            status.textContent = ok;
          },
          () => {
            status.textContent = "Could not copy. Click the page and try again.";
          },
        );
      }
    }

    function union(rects) {
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }

    async function raster(elements) {
      if (elements.length === 0) throw new Error("That selection has no visible area");
      try {
        return await rasterSvg(elements);
      } catch {
        // WebKit taints a canvas drawn from SVG foreignObject, so the PNG comes back empty.
        return paintElements(elements);
      }
    }

    async function rasterSvg(elements) {
      const bounds = union(elements.map((element) => asRect(element.getBoundingClientRect())));
      const scale = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bounds.width * scale));
      canvas.height = Math.max(1, Math.round(bounds.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not take the screenshot");
      const css = pageCss().replace(/<\/style/gi, "<\\/style");
      const body = elements
        .map((element) => {
          const rect = asRect(element.getBoundingClientRect());
          const html = String(element.outerHTML || "").replace(/<script[\s\S]*?<\/script>/gi, "");
          return `<div style="position:absolute;left:${rect.left - bounds.left}px;top:${rect.top - bounds.top}px">${html}</div>`;
        })
        .join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style><div style="position:relative;width:${bounds.width}px;height:${bounds.height}px">${body}</div></div></foreignObject></svg>`;
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return pngBlob(canvas);
    }

    async function paintElements(elements) {
      const bounds = union(elements.map((element) => asRect(element.getBoundingClientRect())));
      if (bounds.width < 1 || bounds.height < 1) throw new Error("That selection has no visible area");
      const scale = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bounds.width * scale));
      canvas.height = Math.max(1, Math.round(bounds.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not take the screenshot");
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.fillStyle = usableColor(getComputedStyle(document.body).backgroundColor) || "#14181f";
      ctx.fillRect(0, 0, bounds.width, bounds.height);
      for (const element of elements) paintTree(ctx, element, bounds);
      return pngBlob(canvas);
    }

    function paintTree(ctx, element, bounds) {
      if (!(element instanceof Element) || element.closest(".hwp-select-ui")) return;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return;
      const rect = asRect(element.getBoundingClientRect());
      const x = rect.left - bounds.left;
      const y = rect.top - bounds.top;
      const bg = usableColor(style.backgroundColor);
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, rect.width, rect.height);
      }
      const color = usableColor(style.color) || "#e7e4dc";
      ctx.fillStyle = color;
      ctx.font = style.font || `${style.fontSize} ${style.fontFamily}`;
      ctx.textBaseline = "top";
      const padX = Number.parseFloat(style.paddingLeft) || 0;
      const padY = Number.parseFloat(style.paddingTop) || 0;
      const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) || 16;
      for (const child of element.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE) continue;
        const text = String(child.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const box = textBox(child);
        const tx = box.width > 0 ? box.left - bounds.left : x + padX;
        const ty = box.height > 0 ? box.top - bounds.top : y + padY;
        wrapText(ctx, text, tx, ty, Math.max(1, rect.width - padX), line);
      }
      for (const child of element.children) paintTree(ctx, child, bounds);
    }

    function textBox(node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      range.detach();
      return asRect(rect);
    }

    function wrapText(ctx, text, x, y, width, line) {
      const words = text.split(" ");
      let row = "";
      let top = y;
      for (const word of words) {
        const next = row ? `${row} ${word}` : word;
        if (ctx.measureText(next).width > width && row) {
          ctx.fillText(row, x, top);
          row = word;
          top += line;
        } else row = next;
      }
      if (row) ctx.fillText(row, x, top);
    }

    function usableColor(value) {
      if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") return "";
      const ctx = usableColor.ctx || (usableColor.ctx = document.createElement("canvas").getContext("2d"));
      if (!ctx) return value;
      ctx.fillStyle = "#010203";
      ctx.fillStyle = value;
      return ctx.fillStyle === "#010203" ? "" : ctx.fillStyle;
    }

    function pngBlob(canvas) {
      return new Promise((resolve, reject) => {
        const fail = () => reject(new Error("Could not take the screenshot"));
        const fromUrl = () => {
          let url = "";
          try {
            url = canvas.toDataURL("image/png");
          } catch {
            return null;
          }
          const comma = url.indexOf(",");
          if (!url.startsWith("data:image/png") || comma < 0) return null;
          const binary = atob(url.slice(comma + 1));
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          return new Blob([bytes], { type: "image/png" });
        };
        try {
          canvas.toBlob((value) => {
            if (value) resolve(value);
            else {
              const blob = fromUrl();
              if (blob) resolve(blob);
              else fail();
            }
          }, "image/png");
        } catch {
          const blob = fromUrl();
          if (blob) resolve(blob);
          else fail();
        }
      });
    }
  };
})();
