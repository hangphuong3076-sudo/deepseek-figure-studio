/**
 * app/anchors.js — 选框锚点面板（v1-web-app）
 * Contract (APP-API.md):
 *   Anchors.mount(panelEl)        表格：label / x / y / w / h（mm，可编辑）/ note / 关联元素数
 *   Anchors.addFromSelection()    用当前选中元素的并集包围盒建锚点
 *   Anchors.update(id, patch) / Anchors.remove(id)
 *   Anchors.focus(id)             画布高亮该锚点
 * 所有改动经 App.commit 写回 doc.anchors（add_anchor / update_anchor / remove_anchor op），
 * 从而立即出现在 FigAI.buildEditMessages 的锚点清单里。
 */
(function () {
  "use strict";

  var g = globalThis;
  var Anchors = {};
  g.Anchors = Anchors;

  var els = { root: null, labelInput: null, addBtn: null, tbody: null, emptyHint: null };
  var unsub = [];

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (k === "style") el.setAttribute("style", v);
        else if (k === "className") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else el.setAttribute(k, v == null ? "" : String(v));
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function toast(text, opts) {
    if (g.Ui && typeof g.Ui.toast === "function") {
      try { g.Ui.toast(text, opts || {}); return; } catch (e) { /* fallthrough */ }
    }
    try { console.log("[Anchors] " + text); } catch (e) { /* ignore */ }
  }

  function confirmBox(text) {
    if (g.Ui && typeof g.Ui.confirm === "function") {
      try { return g.Ui.confirm(text); } catch (e) { /* fallthrough */ }
    }
    try { return Promise.resolve(window.confirm(text)); } catch (e) {
      return Promise.resolve(false);
    }
  }

  // App.commit 可能是同步也可能返回 Promise，统一处理。
  function doCommit(ops, opts) {
    var r = g.App.commit(ops, opts);
    if (r && typeof r.then === "function") return r;
    return Promise.resolve(r);
  }

  function requireApp() {
    if (!g.App || !g.App.doc) throw new Error("App 尚未初始化，无法使用锚点面板");
  }

  function anchors() {
    return (g.App.doc && g.App.doc.anchors) || [];
  }

  function relatedCount(doc, anchor) {
    // Elements linked explicitly, plus ones falling inside the anchor bbox.
    var n = 0;
    try {
      if (g.FigDoc && typeof g.FigDoc.elementsInAnchor === "function") {
        n = g.FigDoc.elementsInAnchor(doc, anchor.id).length;
      }
    } catch (e) { n = 0; }
    if (!n && Array.isArray(anchor.element_ids)) n = anchor.element_ids.length;
    return n;
  }

  function fmt(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    return String(Math.round(n * 100) / 100);
  }

  function parseMm(raw) {
    var v = Number(String(raw).trim());
    if (!isFinite(v) || v < 0) return null;
    return v;
  }

  // ------------------------------------------------------------------
  // data actions（全部经 App.commit）
  // ------------------------------------------------------------------

  /** Anchors.addFromSelection(label) — 用选区并集 bbox 建锚点 */
  Anchors.addFromSelection = function (label) {
    requireApp();
    var ids = (typeof g.App.selection === "function") ? g.App.selection() : [];
    if (!ids.length) {
      toast("请先在画布中选中元素，再从选区创建锚点", { type: "error" });
      return null;
    }
    var doc = g.App.doc;
    var union = null;
    ids.forEach(function (id) {
      var b = null;
      try { b = g.FigDoc.bbox(doc, id, { recursive: true }); } catch (e) { b = null; }
      if (!b) return;
      if (!union) union = { x: b.x, y: b.y, w: b.w, h: b.h };
      else {
        var x2 = Math.max(union.x + union.w, b.x + b.w);
        var y2 = Math.max(union.y + union.h, b.y + b.h);
        union.x = Math.min(union.x, b.x);
        union.y = Math.min(union.y, b.y);
        union.w = x2 - union.x;
        union.h = y2 - union.y;
      }
    });
    if (!union || union.w <= 0 || union.h <= 0) {
      toast("选区没有有效的包围盒，无法创建锚点", { type: "error" });
      return null;
    }
    // Default label: 1, 2, … — smallest number not in use. Existing anchors
    // are never renumbered when one is deleted; the freed number is reused.
    var used = {};
    anchors().forEach(function (a) {
      var raw = String(a && a.label || "").trim();
      var n = parseInt(raw, 10);
      if (isFinite(n) && n > 0 && String(n) === raw) used[n] = true;
    });
    var name = label != null && String(label).trim() ? String(label).trim() : null;
    if (!name) {
      var n = 1;
      while (used[n]) n++;
      name = String(n);
    }
    var canvas = doc.canvas;
    var norm = g.FigDoc.mmToNorm(union, canvas);
    var anchor = {
      id: g.FigDoc.uid("anchor"),
      label: name,
      bbox_mm: union,
      bbox_norm: norm,
      note: "",
      element_ids: ids.slice()
    };
    var op = { op: "add_anchor", anchor: anchor, reason: "从选区创建锚点" };
    return doCommit([op], { label: "锚点：" + name, source: "user" }).then(function (r) {
      if (r && r.applied > 0) {
        toast("已创建锚点 " + name, { type: "success" });
        if (els.labelInput) els.labelInput.value = "";
        // 让 AI 面板出现 [n] @anchor-id 引用，便于接着用自然语言指名该区域。
        try {
          if (g.AiPanel && typeof g.AiPanel.appendAnchorRef === "function") {
            g.AiPanel.appendAnchorRef(anchor);
          }
        } catch (e) { /* 引用注入失败不影响锚点创建 */ }
        return anchor;
      }
      return null;
    }).catch(function (err) {
      toast("创建锚点失败：" + (err && err.message ? err.message : err), { type: "error" });
      return null;
    });
  };

  /** Anchors.update(id, patch) — patch 可含 label/bbox_mm/note/element_ids */
  Anchors.update = function (id, patch) {
    requireApp();
    if (!id) throw new Error("Anchors.update：缺少锚点 id");
    if (!patch || typeof patch !== "object") throw new Error("Anchors.update：patch 必须是对象");
    var clean = {};
    ["label", "bbox_mm", "bbox_norm", "note", "element_ids"].forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) clean[k] = patch[k];
    });
    if (!Object.keys(clean).length) throw new Error("Anchors.update：patch 为空");
    // Anchor patch goes into the op's "anchor" payload with the id.
    clean.id = id;
    var op = { op: "update_anchor", anchor: clean, reason: "编辑锚点" };
    return doCommit([op], { label: "锚点：更新 " + id, source: "user" });
  };

  /** Anchors.remove(id) */
  Anchors.remove = function (id) {
    requireApp();
    var a = anchors().filter(function (x) { return x && x.id === id; })[0];
    var label = a ? a.label : id;
    return confirmBox("确定删除锚点「" + label + "」吗？").then(function (yes) {
      if (!yes) return { applied: 0 };
      var op = { op: "remove_anchor", anchor: { id: id }, reason: "删除锚点" };
      return doCommit([op], { label: "锚点：删除 " + label, source: "user" }).then(function (r) {
        if (!r || !r.applied) toast("锚点删除失败", { type: "error" });
        return r;
      });
    });
  };

  /** Anchors.focus(id) — 画布高亮该锚点（不改文档） */
  Anchors.focus = function (id) {
    requireApp();
    var a = anchors().filter(function (x) { return x && x.id === id; })[0];
    if (!a || !a.bbox_mm) {
      toast("找不到该锚点", { type: "error" });
      return;
    }
    var stage = g.App.stage;
    if (!stage || typeof stage.mmToScreen !== "function") {
      toast("画布尚未就绪，无法定位锚点", { type: "info" });
      return;
    }
    var p1 = stage.mmToScreen({ x_mm: a.bbox_mm.x, y_mm: a.bbox_mm.y });
    var p2 = stage.mmToScreen({ x_mm: a.bbox_mm.x + a.bbox_mm.w, y_mm: a.bbox_mm.y + a.bbox_mm.h });
    // Highlight on top of the canvas overlay; the overlay's parent (#stage)
    // is the positioned host, matching how Editor draws handles.
    var overlay = stage.overlayEl || stage.svgEl;
    if (!overlay || !overlay.parentElement) {
      toast("画布尚未就绪，无法定位锚点", { type: "info" });
      return;
    }
    var host = overlay.ownerDocument || document;
    var box = host.createElement("div");
    box.setAttribute("style",
      "position:absolute;pointer-events:none;border:2px dashed #ff8800;background:rgba(255,136,0,0.15);" +
      "left:" + Math.min(p1.x, p2.x) + "px;top:" + Math.min(p1.y, p2.y) + "px;" +
      "width:" + Math.abs(p2.x - p1.x) + "px;height:" + Math.abs(p2.y - p1.y) + "px;" +
      "box-sizing:border-box;z-index:50;transition:opacity 0.4s;");
    overlay.parentElement.appendChild(box);
    setTimeout(function () {
      box.style.opacity = "0";
      setTimeout(function () {
        if (box.parentElement) box.parentElement.removeChild(box);
      }, 450);
    }, 1200);
  };

  // ------------------------------------------------------------------
  // table rendering
  // ------------------------------------------------------------------
  function commitOnEdit(id, field, raw) {
    if (field === "label") {
      var label = String(raw).trim();
      if (!label) { toast("锚点标签不能为空", { type: "error" }); render(); return; }
      Anchors.update(id, { label: label });
    } else if (field === "note") {
      Anchors.update(id, { note: String(raw) });
    } else {
      var v = parseMm(raw);
      if (v === null) {
        toast("坐标必须是 ≥0 的数字（mm）", { type: "error" });
        render();
        return;
      }
      // Coordinate edits must be merged into bbox_mm: a top-level {x:10}
      // patch would only land on a dead anchor.x property, leave bbox_mm
      // (and thus bbox_norm / the canvas box) untouched.
      var cur = anchors().filter(function (a) { return a && a.id === id; })[0];
      var base = (cur && cur.bbox_mm) || {};
      var mm = {
        x: typeof base.x === "number" ? base.x : 0,
        y: typeof base.y === "number" ? base.y : 0,
        w: typeof base.w === "number" ? base.w : 0,
        h: typeof base.h === "number" ? base.h : 0
      };
      mm[field] = v;
      Anchors.update(id, { bbox_mm: mm });
    }
  }

  function cellInput(value, onCommit) {
    return h("input", {
      type: "text", value: value,
      style: "width:100%;box-sizing:border-box;font-size:12px;padding:1px 3px;",
      onChange: function (evt) { onCommit(evt.target.value); }
    });
  }

  function render() {
    if (!els.tbody) return;
    requireAppSafe();
    els.tbody.textContent = "";
    var list;
    try { list = anchors(); } catch (e) { list = []; }
    var doc = g.App && g.App.doc;
    if (!doc) return;
    if (!list.length) {
      var tr0 = h("tr", {}, [h("td", {
        colspan: "8", style: "color:#888;font-size:12px;text-align:center;padding:8px;",
        text: "暂无锚点。用工具栏「锚点」工具框选，或选中元素后点上方「从选区建锚点」。"
      })]);
      els.tbody.appendChild(tr0);
      return;
    }
    list.forEach(function (a) {
      if (!a || !a.id) return;
      var mm = a.bbox_mm || {};
      var mmNorm = a.bbox_norm || {};
      var row = h("tr", {}, [
        h("td", {}, [cellInput(String(a.label || ""), function (v) { commitOnEdit(a.id, "label", v); })]),
        h("td", {}, [cellInput(fmt(mm.x), function (v) { commitOnEdit(a.id, "x", v); })]),
        h("td", {}, [cellInput(fmt(mm.y), function (v) { commitOnEdit(a.id, "y", v); })]),
        h("td", {}, [cellInput(fmt(mm.w), function (v) { commitOnEdit(a.id, "w", v); })]),
        h("td", {}, [cellInput(fmt(mm.h), function (v) { commitOnEdit(a.id, "h", v); })]),
        h("td", {}, [cellInput(String(a.note || ""), function (v) { commitOnEdit(a.id, "note", v); })]),
        h("td", { style: "text-align:center;font-size:12px;", text: String(relatedCount(doc, a)) }),
        h("td", { style: "white-space:nowrap;" }, [
          h("button", { text: "定位", style: "padding:1px 6px;cursor:pointer;margin-right:4px;",
            onClick: function () { Anchors.focus(a.id); } }),
          h("button", { text: "删除", style: "padding:1px 6px;cursor:pointer;",
            onClick: function () { Anchors.remove(a.id); } })
        ])
      ]);
      row.setAttribute("data-anchor-id", a.id);
      row.title = "id: " + a.id + "    norm: " +
        [mmNorm.x, mmNorm.y, mmNorm.w, mmNorm.h].map(function (v) {
          return v == null ? "?" : (Math.round(v * 1000) / 1000);
        }).join(", ");
      els.tbody.appendChild(row);
    });
  }

  function requireAppSafe() {
    try { requireApp(); } catch (e) { /* not initialized yet */ }
  }

  function updateAddBtn() {
    if (!els.addBtn) return;
    try {
      var ids = (typeof g.App.selection === "function") ? g.App.selection() : [];
      els.addBtn.disabled = !ids.length;
      els.addBtn.title = ids.length ? "用选区并集包围盒创建锚点" : "先在画布中选中元素";
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // mount
  // ------------------------------------------------------------------
  Anchors.mount = function (panelEl) {
    if (!panelEl) throw new Error("Anchors.mount：panelEl 不能为空");
    requireApp();
    els.root = panelEl;
    panelEl.textContent = "";

    els.labelInput = h("input", {
      type: "text", placeholder: "锚点标签（留空则自动编号 1,2…）",
      style: "flex:1;box-sizing:border-box;font-size:12px;padding:3px 6px;"
    });
    els.addBtn = h("button", { text: "从选区建锚点", style: "padding:3px 10px;cursor:pointer;white-space:nowrap;",
      onClick: function () { Anchors.addFromSelection(els.labelInput ? els.labelInput.value : null); } });

    var thead = h("thead", {}, [h("tr", {}, [
      h("th", { text: "标签" }), h("th", { text: "X" }), h("th", { text: "Y" }),
      h("th", { text: "W" }), h("th", { text: "H" }), h("th", { text: "备注" }),
      h("th", { text: "关联" }), h("th", { text: "操作" })
    ])]);
    els.tbody = h("tbody", {});
    var table = h("table", {
      style: "width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;",
      className: "anchors-table"
    }, [thead, els.tbody]);

    panelEl.appendChild(h("div", { style: "display:flex;gap:6px;margin-bottom:8px;" },
      [els.labelInput, els.addBtn]));
    panelEl.appendChild(h("div", {
      style: "font-size:11px;color:#888;margin-bottom:4px;",
      text: "坐标单位 mm，可直接编辑；改动经 App.commit 写入 doc.anchors。"
    }));
    panelEl.appendChild(table);

    render();
    updateAddBtn();

    // Event-driven refresh; never poll.
    if (g.App && typeof g.App.on === "function") {
      unsub.push(g.App.on("doc:changed", render));
      unsub.push(g.App.on("anchors:changed", render));
      unsub.push(g.App.on("selection:changed", updateAddBtn));
    }
  };
})();
