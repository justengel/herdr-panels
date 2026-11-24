/* hwp-frame-find */
function hwpFindChord(event) {
  if (!event || event.altKey) return null;
  var command = event.ctrlKey || event.metaKey;
  if (command && !event.shiftKey && (event.key === "f" || event.key === "F")) return "open";
  if (!command && event.key === "F3") return event.shiftKey ? "prev" : "next";
  return null;
}

function hwpEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hwpTextMatches(text, query, matchCase) {
  var needle = String(query || "");
  if (!needle) return [];
  var pattern;
  try {
    pattern = new RegExp(hwpEscape(needle), matchCase ? "gu" : "giu");
  } catch (err) {
    return [];
  }
  var found = [];
  var source = String(text || "");
  for (var match of source.matchAll(pattern)) {
    if (!match[0]) break;
    var start = match.index || 0;
    found.push({ start: start, end: start + match[0].length });
  }
  return found;
}

function hwpHidden(el) {
  var node = el;
  while (node) {
    if (node.nodeType === 1) {
      if (node.hidden) return true;
      if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return true;
      var tag = node.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
      if (node.classList && node.classList.contains("find-bar")) return true;
    }
    node = node.parentNode;
  }
  return false;
}

function hwpBlock(node) {
  var el = node.parentElement;
  var view = node.ownerDocument && node.ownerDocument.defaultView;
  while (el) {
    var display = "";
    try {
      display = view ? view.getComputedStyle(el).display : "";
    } catch (err) {
      return el;
    }
    if (
      display === "block" ||
      display === "flex" ||
      display === "grid" ||
      display === "table" ||
      display === "list-item" ||
      display === "flow-root" ||
      display === "table-row"
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return node.parentElement;
}

function hwpCollect(root) {
  var doc = root.ownerDocument;
  var view = doc.defaultView;
  var filter = view && view.NodeFilter;
  var walker = doc.createTreeWalker(root, filter ? filter.SHOW_TEXT : 4);
  var parts = [];
  var text = "";
  var lastBlock = null;
  var node = walker.nextNode();
  while (node) {
    var value = node.nodeValue || "";
    if (value && !hwpHidden(node.parentElement)) {
      var block = hwpBlock(node);
      if (lastBlock && block !== lastBlock) text += "\n";
      parts.push({ node: node, start: text.length });
      text += value;
      lastBlock = block;
    }
    node = walker.nextNode();
  }
  return { text: text, parts: parts };
}

function hwpRanges(doc, parts, start, end) {
  var ranges = [];
  for (var i = 0; i < parts.length; i += 1) {
    var part = parts[i];
    var value = part.node.nodeValue || "";
    var partEnd = part.start + value.length;
    var from = Math.max(start, part.start);
    var to = Math.min(end, partEnd);
    if (from >= to) continue;
    var range = doc.createRange();
    range.setStart(part.node, from - part.start);
    range.setEnd(part.node, to - part.start);
    ranges.push(range);
  }
  return ranges;
}

function hwpStyle(doc) {
  if (!doc || doc.getElementById("hwp-find-style")) return;
  var style = doc.createElement("style");
  style.id = "hwp-find-style";
  style.textContent =
    "::highlight(hwp-find){background-color:#e2b65766}::highlight(hwp-find-current){background-color:#e2b657;color:#101114}" +
    "mark.hwp-find-mark{background:#e2b65766;color:inherit}mark.hwp-find-mark.is-current{background:#e2b657;color:#101114}";
  (doc.head || doc.documentElement).appendChild(style);
}

function hwpClearFind(doc, root) {
  var view = doc && doc.defaultView;
  if (view && view.CSS && view.CSS.highlights) {
    view.CSS.highlights.delete("hwp-find");
    view.CSS.highlights.delete("hwp-find-current");
  }
  if (!root || !root.querySelectorAll) return;
  var marks = root.querySelectorAll("mark.hwp-find-mark");
  for (var i = 0; i < marks.length; i += 1) {
    var mark = marks[i];
    var parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
}

function hwpSlice(matches, at) {
  var slice = [];
  var from = 0;
  var to = matches.length;
  if (matches.length > 800) {
    from = Math.max(0, at - 200);
    to = Math.min(matches.length, from + 400);
  }
  for (var i = from; i < to; i += 1) slice.push({ start: matches[i].start, end: matches[i].end, i: i });
  return slice;
}

function hwpPaint(doc, parts, matches, at) {
  hwpStyle(doc);
  var view = doc.defaultView;
  var current = hwpRanges(doc, parts, matches[at].start, matches[at].end);
  if (view && view.CSS && view.CSS.highlights && view.Highlight) {
    var all = new view.Highlight();
    var here = new view.Highlight();
    var windowed = hwpSlice(matches, at);
    for (var i = 0; i < windowed.length; i += 1) {
      if (windowed[i].i === at) continue;
      var ranges = hwpRanges(doc, parts, windowed[i].start, windowed[i].end);
      for (var j = 0; j < ranges.length; j += 1) all.add(ranges[j]);
    }
    for (var k = 0; k < current.length; k += 1) here.add(current[k]);
    view.CSS.highlights.set("hwp-find", all);
    view.CSS.highlights.set("hwp-find-current", here);
  } else {
    for (var n = current.length - 1; n >= 0; n -= 1) {
      var mark = doc.createElement("mark");
      mark.className = "hwp-find-mark is-current";
      try {
        current[n].surroundContents(mark);
      } catch (err) {
        /* A match that crosses an element stays unwrapped. */
      }
    }
  }
  var target = current[0] && (current[0].startContainer.nodeType === 1 ? current[0].startContainer : current[0].startContainer.parentElement);
  if (target && target.scrollIntoView) target.scrollIntoView({ block: "center", inline: "nearest" });
}

function hwpApplyFind(root, query, index, matchCase) {
  if (!root || !root.ownerDocument) return { count: 0, index: -1 };
  var doc = root.ownerDocument;
  hwpClearFind(doc, root);
  var needle = String(query || "");
  if (!needle) return { count: 0, index: -1 };
  var collected = hwpCollect(root);
  var matches = hwpTextMatches(collected.text, needle, Boolean(matchCase));
  if (!matches.length) return { count: 0, index: -1 };
  var at = Number(index);
  if (!isFinite(at)) at = 0;
  if (at < 0) at = matches.length - 1;
  else at = at % matches.length;
  hwpPaint(doc, collected.parts, matches, at);
  return { count: matches.length, index: at };
}

globalThis.hwpFindChord = hwpFindChord;
globalThis.hwpTextMatches = hwpTextMatches;
globalThis.hwpApplyFind = hwpApplyFind;

if (typeof window !== "undefined" && window.parent && window.parent !== window && !window.__hwpFrameFind) {
  window.__hwpFrameFind = true;
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "hwp-host" || data.type !== "find") return;
    if (event.source !== window.parent) return;
    var result = hwpApplyFind(document.body, data.query, data.index, data.matchCase);
    try {
      window.parent.postMessage(
        { source: "hwp-find", type: "result", token: data.token, count: result.count, index: result.index },
        "*",
      );
    } catch (err) {
      /* The host frame is gone. */
    }
  });
  window.addEventListener(
    "keydown",
    function (event) {
      var op = hwpFindChord(event);
      if (!op) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat && op === "open") return;
      try {
        window.parent.postMessage({ source: "hwp-find", type: "key", op: op }, "*");
      } catch (err) {
        /* The host frame is gone. */
      }
    },
    true,
  );
}
