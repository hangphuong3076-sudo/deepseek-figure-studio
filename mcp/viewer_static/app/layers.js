/* =====================================================================
 * layers.js — Layers panel (v1 web app)
 *
 * Tree view of the document:
 *   - group / panel containers are collapsible, children are indented
 *   - rows are listed in z-descending order (front-most element first)
 *   - click selects, Shift/Ctrl-click toggles multi-selection
 *   - double-click the name to rename an element
 *   - eye / padlock buttons toggle element.visible / element.locked
 *   - drag & drop reorders among siblings (via z_order ops)
 *
 * Rename / visible / locked have NO representation in the frozen EditOp enum
 * (see shared/schema/edit-op.schema.json), so they are applied as direct doc
 * mutations via the serialized App.publishDoc queue. To leave a trace anyway,
 * each published change then queues a companion `note` op through App.commit,
 * so the change appears in doc.history and meta.provenance. The direct clone
 * retains the old non-enumerable __snapshots cache for later undo/restore.
 *
 * LIMITATION of this workaround: the direct mutation itself is not an op, so
 * undo / restore can NOT revert its content — they only replay known ops from
 * snapshots. What happened can only be traced after the fact via the note
 * record ("图层改名 a→b" / "隐藏元素 x" / "锁定元素 y"), never undone.
 *
 * Depends on: App (state.js), FigDoc (lib/figdoc.js). DOM only, no build.
 * ===================================================================== */
(function (global) {
  "use strict";

  // ------------------------------------------------------------------
  // Module state
  // ------------------------------------------------------------------

  var panelEl = null;
  var listEl = null;
  var infoEl = null;
  var collapsed = Object.create(null); // container id -> true (collapse state)
  var dragId = null;
  var unsubs = [];

  var TYPE_META = {
    rect:    { label: "矩形", glyph: "▭" },
    ellipse: { label: "椭圆", glyph: "◯" },
    line:    { label: "直线", glyph: "╱" },
    arrow:   { label: "箭头", glyph: "→" },
    path:    { label: "路径", glyph: "∿" },
    text:    { label: "文本", glyph: "T" },
    image:   { label: "图片", glyph: "▣" },
    chart:   { label: "图表", glyph: "▦" },
    group:   { label: "组",   glyph: "❏" },
    panel:   { label: "面板", glyph: "☰" }
  };

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  function app() {
    if (!global.App) throw new Error("Layers 依赖 App，请先加载 app/state.js");
    return global.App;
  }

  function figdoc() {
    if (!global.FigDoc) throw new Error("Layers 依赖 FigDoc，请先加载 lib/figdoc.js");
    return global.FigDoc;
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined) return;
      if (k === "text") { el.textContent = String(v); return; }
      if (k === "class") { el.className = String(v); return; }
      if (k === "style" && typeof v === "object") {
        Object.keys(v).forEach(function (p) { el.style[p] = v[p]; });
        return;
      }
      if (k.indexOf("on") === 0 && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
        return;
      }
      el.setAttribute(k, String(v));
    });
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }

  function zOf(el) {
    return (el && typeof el.z === "number" && isFinite(el.z)) ? el.z : 0;
  }

  function isContainer(el) {
    return el.type === "group" || el.type === "panel";
  }

  function parentKey(el) {
    return (el && el.parent_id) ? el.parent_id : null;
  }

  function typeGlyph(el) {
    var m = TYPE_META[el.type];
    return m ? m.glyph : "?";
  }

  function typeName(el) {
    var m = TYPE_META[el.type];
    return m ? m.label : String(el.type);
  }

  // Text summary: first 20 chars for text, chart type for chart, etc.
  function summaryOf(el) {
    if (el.type === "text" && typeof el.text === "string" && el.text.length) {
      var t = el.text.replace(/\s+/g, " ");
      return "“" + t.slice(0, 20) + (t.length > 20 ? "…" : "") + "”";
    }
    if (el.type === "chart" && el.chart && el.chart.chartType) {
      return String(el.chart.chartType);
    }
    if (el.type === "image") return el.src ? "图片" : "图片（未设置）";
    if (el.type === "group") return (el.children || []).length + " 个子元素";
    if (el.type === "panel") {
      var pl = el.panelLayout || {};
      return "面板 " + (pl.cols || 1) + "×" + (pl.rows || 1);
    }
    return typeName(el);
  }

  // ------------------------------------------------------------------
  // Tree order: display = z descending (front-most first)
  // ------------------------------------------------------------------

  function displayIds(doc, parentId) {
    var F = figdoc();
    var pos = Object.create(null); // fallback order: children array reversed
    if (parentId) {
      var p = F.get(doc, parentId);
      if (p && Array.isArray(p.children)) {
        p.children.forEach(function (id, i) { pos[id] = i; });
      }
    }
    var els = doc.elements.filter(function (e) {
      return e && parentKey(e) === parentId;
    });
    els.sort(function (a, b) {
      return zOf(b) - zOf(a) || (pos[b.id] || 0) - (pos[a.id] || 0);
    });
    return els;
  }

  // ------------------------------------------------------------------
  // Doc mutations without an EditOp (rename / visible / locked)
  // ------------------------------------------------------------------

  // Applies a direct doc mutation (clone -> mutate -> setDoc). Because the
  // frozen EditOp enum has no op for these changes, a companion `note` op is
  // committed via App.commit in the same user action so the change is traced
  // in doc.history and meta.provenance. Limitation: the content change itself
  // is NOT undoable (undo only replays known ops from snapshots); it can only
  // be traced after the fact via the note record.
  function mutateDirect(fn, reason, note) {
    var App = app();
    var F = figdoc();
    return App.publishDoc(function (current) {
      var d = F.clone(current);
      fn(d, F);
      d = F.touch(d);
      // FigDoc.clone/touch 不复制不可枚举的运行期缓存。保留同一缓存对象，
      // 后续 note 与普通 undo 才能继续访问此次图层修改之前的快照。
      var cache = current.__snapshots || null;
      if (cache) {
        try {
          Object.defineProperty(d, "__snapshots", {
            value: cache, enumerable: false, configurable: true, writable: true
          });
        } catch (err) {
          try { d.__snapshots = cache; } catch (ignored) { /* ignore */ }
        }
      }
      return d;
    }, { reason: reason, history: false }).then(function () {
      // 在 publishDoc 返回后再排队；不要从队列工厂里直接返回 App.commit，
      // 否则事务会等待排在自己后面的任务而形成自死锁。
      return App.commit([{ op: "note", note: note, reason: note }],
        { label: note, source: "user" });
    }).catch(function (err) {
      App.error("记录历史备注失败：" + (err && err.message ? err.message : err));
    });
  }

  function renameElement(id, name) {
    var cur = figdoc().get(app().doc, id);
    var from = (cur && cur.name) ? cur.name : "（未命名）";
    return mutateDirect(function (d, F) {
      var el = F.get(d, id);
      if (!el) return;
      if (name) el.name = name;
      else if ("name" in el) delete el.name;
    }, "layers:rename", "图层改名 " + from + "→" + (name || "（无名称）"));
  }

  function setFlag(id, key, value) {
    var cur = figdoc().get(app().doc, id);
    var who = cur ? (cur.name || cur.id) : id;
    var note;
    if (key === "visible") note = (value ? "显示元素 " : "隐藏元素 ") + who;
    else if (key === "locked") note = (value ? "锁定元素 " : "解锁元素 ") + who;
    else note = (value ? "开启 " : "关闭 ") + key + " " + who;
    return mutateDirect(function (d, F) {
      var el = F.get(d, id);
      if (el) el[key] = value;
    }, "layers:" + key, note);
  }

  // ------------------------------------------------------------------
  // Sibling drag reorder (via z_order forward/backward ops)
  // ------------------------------------------------------------------

  function clearIndicators() {
    if (!listEl) return;
    Array.prototype.forEach.call(listEl.querySelectorAll(".layer-row"), function (r) {
      r.style.borderTop = "";
      r.style.borderBottom = "";
    });
  }

  function handleDrop(targetEl, dropBefore) {
    var App = app();
    var F = figdoc();
    var doc = App.doc;
    var drag = dragId ? F.get(doc, dragId) : null;
    dragId = null;
    clearIndicators();
    if (!drag || !targetEl) return;
    if (drag.id === targetEl.id) return;
    if (parentKey(drag) !== parentKey(targetEl)) {
      App.status("只能在同级元素之间拖拽排序");
      return;
    }
    var sibs = displayIds(doc, parentKey(drag));
    var ids = sibs.map(function (e) { return e.id; });
    var c = ids.indexOf(drag.id);
    var t = ids.indexOf(targetEl.id);
    if (c < 0 || t < 0) return;
    // Display list is z-descending; "before" = closer to the front.
    // z_order forward moves toward the front (display index decreases).
    var f = dropBefore
      ? (c < t ? t - 1 : t)
      : (c < t ? t : t + 1);
    f = Math.max(0, Math.min(ids.length - 1, f));
    var steps = c - f; // >0: forward, <0: backward
    if (!steps) return;
    var ops = [];
    for (var i = 0; i < Math.abs(steps); i++) {
      ops.push({
        op: "z_order",
        targets: [drag.id],
        to: steps > 0 ? "forward" : "backward"
      });
    }
    App.commit(ops, { label: "调整图层顺序", source: "user" });
  }

  // ------------------------------------------------------------------
  // Row building
  // ------------------------------------------------------------------

  var ICON_EYE = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="8" cy="8" r="2" fill="currentColor"/></svg>';
  var ICON_EYE_OFF = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.35"/>' +
    '<line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.3"/></svg>';
  var ICON_LOCK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<rect x="4" y="7.5" width="8" height="6" rx="1" fill="currentColor"/>' +
    '<path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  var ICON_UNLOCK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<rect x="4" y="7.5" width="8" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M5.5 7.5V5a2.5 2.5 0 0 1 4.9-.7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

  function buildRow(doc, el, depth) {
    var App = app();
    var selected = App.selection().indexOf(el.id) >= 0;
    var hidden = el.visible === false;
    var locked = el.locked === true;

    var row = h("div", {
      "class": "layer-row",
      "data-id": el.id,
      draggable: "true",
      title: el.id + "（拖拽可调整同级顺序）",
      style: {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        padding: "3px 6px 3px " + (6 + depth * 16) + "px",
        cursor: "pointer",
        userSelect: "none",
        fontSize: "12px",
        borderRadius: "3px",
        margin: "1px 2px",
        background: selected ? "#cfe2ff" : "transparent",
        opacity: hidden ? "0.55" : "1"
      },
      onclick: function (ev) {
        if (ev.target !== row && ev.target.tagName === "INPUT") return;
        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) App.toggleSelect(el.id);
        else App.select([el.id]);
      }
    });

    // Collapse caret for containers
    if (isContainer(el)) {
      row.appendChild(h("span", {
        text: collapsed[el.id] ? "▸" : "▾",
        title: collapsed[el.id] ? "展开" : "折叠",
        style: { width: "12px", textAlign: "center", flex: "none", color: "#555" },
        onclick: function (ev) {
          ev.stopPropagation();
          collapsed[el.id] = !collapsed[el.id];
          render();
        }
      }));
    } else {
      row.appendChild(h("span", { style: { width: "12px", flex: "none" } }));
    }

    // Type icon
    row.appendChild(h("span", {
      text: typeGlyph(el),
      title: typeName(el),
      style: { width: "16px", textAlign: "center", flex: "none", color: "#345" }
    }));

    // Name (double-click to rename)
    var name = h("span", {
      text: el.name || typeName(el),
      title: "双击改名",
      style: {
        flex: "0 1 auto",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontWeight: isContainer(el) ? "600" : "normal",
        fontStyle: el.name ? "normal" : "italic",
        color: el.name ? "#111" : "#555"
      },
      ondblclick: function (ev) {
        ev.stopPropagation();
        startRename(row, el, name);
      }
    });
    row.appendChild(name);

    // Summary
    row.appendChild(h("span", {
      text: summaryOf(el),
      title: summaryOf(el),
      style: {
        flex: "1 1 auto",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "#888",
        fontSize: "11px"
      }
    }));

    // Visibility toggle
    row.appendChild(h("button", {
      title: hidden ? "显示" : "隐藏",
      "aria-label": hidden ? "显示" : "隐藏",
      style: {
        border: "none", background: "none", cursor: "pointer",
        padding: "1px 3px", flex: "none", color: hidden ? "#aaa" : "#345", lineHeight: 0
      },
      onclick: function (ev) {
        ev.stopPropagation();
        setFlag(el.id, "visible", hidden);
      }
    })).innerHTML = hidden ? ICON_EYE_OFF : ICON_EYE;

    // Lock toggle
    row.appendChild(h("button", {
      title: locked ? "解锁" : "锁定",
      "aria-label": locked ? "解锁" : "锁定",
      style: {
        border: "none", background: "none", cursor: "pointer",
        padding: "1px 3px", flex: "none", color: locked ? "#b33" : "#999", lineHeight: 0
      },
      onclick: function (ev) {
        ev.stopPropagation();
        setFlag(el.id, "locked", !locked);
      }
    })).innerHTML = locked ? ICON_LOCK : ICON_UNLOCK;

    // Drag & drop (siblings only)
    row.addEventListener("dragstart", function (ev) {
      dragId = el.id;
      if (ev.dataTransfer) {
        ev.dataTransfer.setData("text/plain", el.id);
        ev.dataTransfer.effectAllowed = "move";
      }
      row.style.opacity = "0.4";
    });
    row.addEventListener("dragend", function () {
      dragId = null;
      clearIndicators();
      render();
    });
    row.addEventListener("dragover", function (ev) {
      if (!dragId || dragId === el.id) return;
      var dragEl = figdoc().get(app().doc, dragId);
      if (!dragEl || parentKey(dragEl) !== parentKey(el)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      var rect = row.getBoundingClientRect();
      var before = ev.clientY < rect.top + rect.height / 2;
      row.style.borderTop = before ? "2px solid #4a90d9" : "";
      row.style.borderBottom = before ? "" : "2px solid #4a90d9";
    });
    row.addEventListener("dragleave", function () {
      row.style.borderTop = "";
      row.style.borderBottom = "";
    });
    row.addEventListener("drop", function (ev) {
      ev.preventDefault();
      var rect = row.getBoundingClientRect();
      var before = ev.clientY < rect.top + rect.height / 2;
      handleDrop(el, before);
    });

    return row;
  }

  function startRename(row, el, nameSpan) {
    var input = document.createElement("input");
    input.type = "text";
    input.value = el.name || "";
    input.setAttribute("aria-label", "元素名称");
    input.style.cssText =
      "flex:1 1 auto;min-width:60px;font-size:12px;padding:1px 4px;border:1px solid #7ab;" +
      "border-radius:2px;outline:none;";
    var cancelled = false;
    var finished = false;
    // Finish asynchronously: destroying the focused input synchronously
    // inside its own blur handler makes Chromium throw NotFoundError.
    function finish() {
      if (finished) return;
      finished = true;
      var v = input.value.trim();
      if (!cancelled && v && v !== (el.name || "")) renameElement(el.id, v);
      render();
    }
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") input.blur();
      else if (ev.key === "Escape") { cancelled = true; input.blur(); }
      ev.stopPropagation();
    });
    input.addEventListener("blur", function () { setTimeout(finish, 0); });
    input.addEventListener("click", function (ev) { ev.stopPropagation(); });
    if (nameSpan.parentNode) nameSpan.parentNode.replaceChild(input, nameSpan);
    input.focus();
    input.select();
  }

  // ------------------------------------------------------------------
  // Render / mount
  // ------------------------------------------------------------------

  function appendSubtree(doc, el, depth) {
    listEl.appendChild(buildRow(doc, el, depth));
    if (isContainer(el) && !collapsed[el.id]) {
      displayIds(doc, el.id).forEach(function (kid) {
        appendSubtree(doc, kid, depth + 1);
      });
    }
  }

  function render() {
    if (!panelEl || !listEl) return;
    var App = app();
    var doc = App.doc;
    clearIndicators();
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    if (!doc || !Array.isArray(doc.elements) || !doc.elements.length) {
      listEl.appendChild(h("div", {
        text: "（空文档，暂无图层）",
        style: { color: "#888", padding: "8px", fontSize: "12px" }
      }));
      if (infoEl) infoEl.textContent = "0 个元素";
      return;
    }
    displayIds(doc, null).forEach(function (el) {
      appendSubtree(doc, el, 0);
    });
    if (infoEl) infoEl.textContent = doc.elements.length + " 个元素";
  }

  function mount(p) {
    if (!p || p.nodeType !== 1) {
      throw new Error("Layers.mount 需要一个面板 DOM 元素");
    }
    var App = app();
    // Re-mount: drop previous subscriptions
    unsubs.forEach(function (u) { u(); });
    unsubs = [];

    panelEl = p;
    panelEl.innerHTML = "";

    var header = h("div", {
      style: { display: "flex", alignItems: "baseline", gap: "8px", padding: "6px 8px" }
    }, [
      h("span", { text: "图层", style: { fontWeight: "700", fontSize: "13px" } }),
      (infoEl = h("span", { text: "", style: { color: "#888", fontSize: "11px" } })),
      h("span", {
        text: "双击名称改名 · 拖拽排序",
        style: { marginLeft: "auto", color: "#aaa", fontSize: "11px" }
      })
    ]);

    listEl = h("div", { "class": "layer-list", style: { padding: "0 2px 8px" } });
    panelEl.appendChild(header);
    panelEl.appendChild(listEl);

    unsubs.push(App.on("doc:changed", render));
    unsubs.push(App.on("selection:changed", render));
    render();
  }

  // renameElement / setFlag are the direct-change path (no EditOp exists for
  // them; each commits a companion note op — see header). Exposed so tests and
  // callers can drive them without a DOM.
  global.Layers = {
    mount: mount,
    render: render,
    renameElement: renameElement,
    setFlag: setFlag
  };
})(globalThis);
