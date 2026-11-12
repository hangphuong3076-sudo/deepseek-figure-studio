/* =====================================================================
 * props.js — Properties panel (v1 web app)
 *
 * Shows / edits the current selection:
 *   - geometry: X / Y / W / H (mm) and rotation (deg)
 *       single selection: absolute values (move / resize / rotate ops)
 *       multi selection: union box; X/Y move all, W/H scale proportionally
 *   - appearance: fill & stroke color (color picker + recent palette
 *     swatches), stroke width (pt), dash, opacity
 *   - text: font family, font size (pt), weight, italic, horizontal /
 *     vertical alignment, line height
 *   - characterization charts (表征图表): when exactly one chart element is
 *     selected, an extra section edits the unified characterization spec —
 *     axis labels (with units), x_reverse, guarded log10, normalize,
 *     stack offset, fit_model, declared fit/component/baseline curve
 *     columns and user-declared peak annotations
 *   - multi selection shows common values; differing values show "混合"
 *
 * All changes go through App.commit (move / resize / rotate / set_style /
 * set_color / set_chart_properties / apply_schematic ops). Connector semantics
 * retain semantic ids and manual layouts. Subscribes to doc:changed /
 * selection:changed.
 *
 * The characterization section is pending-edit based: edits accumulate in
 * a local buffer and reach the document only through the "应用修改" button,
 * which issues exactly ONE set_chart_properties op (a single App.commit,
 * one history record; undo restores). It never touches chartType or
 * chart.data.inline — original data rows are never rewritten — and never
 * invents technique / fit_model / peak positions: every shown value comes
 * from the committed spec or from the user's own input.
 *
 * Depends on: App (state.js), FigDoc (lib/figdoc.js), FigOps (lib/ops.js,
 * only for the set_chart_properties op), FigPalette
 * (lib/palette.js, only for seeding recent colors). DOM only, no build.
 * ===================================================================== */
(function (global) {
  "use strict";

  // ------------------------------------------------------------------
  // Module state
  // ------------------------------------------------------------------

  var panelEl = null;
  var refs = {};
  var unsubs = [];
  var lastIdsKey = "";

  var MIXED = "\u0000MIXED";
  var FONTS = ["Arial", "Helvetica", "Times New Roman", "宋体", "黑体"];
  var DEFAULTS = {
    strokeWidthPt: 0.75,
    opacity: 1,
    fontFamily: "Arial",
    fontSizePt: 7,
    fontWeight: "normal",
    fontStyle: "normal",
    textAlign: "left",
    verticalAlign: "top",
    lineHeight: 1.2
  };
  var RECENT_KEY = "figdoc.recentColors";
  var RECENT_MAX = 14;

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  function app() {
    if (!global.App) throw new Error("Props 依赖 App，请先加载 app/state.js");
    return global.App;
  }

  function figdoc() {
    if (!global.FigDoc) throw new Error("Props 依赖 FigDoc，请先加载 lib/figdoc.js");
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

  function r3(n) { return Math.round(n * 1000) / 1000; }

  function parseNum(s) {
    if (s === null || s === undefined) return null;
    var t = String(s).trim();
    if (!t) return null;
    var v = Number(t);
    return isFinite(v) ? v : null;
  }

  // ------------------------------------------------------------------
  // Selection helpers
  // ------------------------------------------------------------------

  // Elements whose ancestors are also selected are excluded (the parent
  // op already covers them, e.g. move on a group).
  function effectiveIds() {
    var App = app();
    var F = figdoc();
    var doc = App.doc;
    var ids = App.selection().filter(function (id) { return !!F.get(doc, id); });
    var covered = Object.create(null);
    ids.forEach(function (id) {
      F.descendants(doc, id).forEach(function (d) { covered[d.id] = 1; });
    });
    return ids.filter(function (id) { return !covered[id]; });
  }

  function elementsOf(ids) {
    var F = figdoc();
    var doc = app().doc;
    return ids.map(function (id) { return F.get(doc, id); }).filter(Boolean);
  }

  function unionBox(els) {
    var u = null;
    els.forEach(function (el) {
      var t = el.transform;
      if (!t) return;
      if (!u) { u = { x: t.x, y: t.y, w: t.w, h: t.h }; return; }
      var x2 = Math.max(u.x + u.w, t.x + t.w);
      var y2 = Math.max(u.y + u.h, t.y + t.h);
      u.x = Math.min(u.x, t.x);
      u.y = Math.min(u.y, t.y);
      u.w = x2 - u.x;
      u.h = y2 - u.y;
    });
    return u;
  }

  // ------------------------------------------------------------------
  // Style value computation (common value or MIXED)
  // ------------------------------------------------------------------

  function styleVal(els, key, dflt) {
    var val = MIXED;
    var first = true;
    els.forEach(function (el) {
      var st = el.style || {};
      var v = (st[key] === undefined) ? dflt : st[key];
      if (first) { val = v; first = false; }
      else if (v !== val) val = MIXED;
    });
    return els.length ? val : MIXED;
  }

  // SVG default: shapes/text fill black unless set; line/arrow fill none.
  function fillDefaultFor(el) {
    return (el.type === "line" || el.type === "arrow") ? null : "#000000";
  }

  function isMixed(v) { return v === MIXED; }

  function setNumInput(input, v) {
    if (isMixed(v)) { input.value = ""; input.placeholder = "混合"; }
    else { input.value = String(r3(Number(v))); input.placeholder = ""; }
  }

  function setTextInput(input, v) {
    if (isMixed(v)) { input.value = ""; input.placeholder = "混合"; }
    else { input.value = v === null || v === undefined ? "" : String(v); input.placeholder = ""; }
  }

  function setSelect(input, v) {
    if (isMixed(v)) input.value = "";
    else input.value = String(v);
  }

  function setCheckbox(input, v) {
    if (isMixed(v)) { input.checked = false; input.indeterminate = true; }
    else { input.checked = v === true; input.indeterminate = false; }
  }

  // Color value for display: null/"" -> "none"; undefined -> renderer default.
  function colorDisplay(els, key, dflt) {
    var val = MIXED;
    var first = true;
    els.forEach(function (el) {
      var st = el.style || {};
      var v;
      if (st[key] === undefined) v = dflt(el);
      else if (st[key] === null || st[key] === "") v = null;
      else v = st[key];
      if (first) { val = v; first = false; }
      else if (v !== val) val = MIXED;
    });
    return els.length ? val : MIXED;
  }

  function hex6(hex) {
    var m = /^#([0-9a-fA-F]{3})$/.exec(hex);
    if (m) {
      return "#" + m[1].split("").map(function (c) { return c + c; }).join("").toLowerCase();
    }
    return hex;
  }

  function validHex(hex) {
    return /^#[0-9a-fA-F]{6}$/.test(hex) || /^#[0-9a-fA-F]{3}$/.test(hex);
  }

  // ------------------------------------------------------------------
  // Recent palette colors (localStorage, seeded from FigPalette npg)
  // ------------------------------------------------------------------

  function recentColors() {
    var arr = [];
    try {
      var raw = global.localStorage ? localStorage.getItem(RECENT_KEY) : null;
      if (raw) arr = JSON.parse(raw);
    } catch (e) { arr = []; }
    if (!Array.isArray(arr) || !arr.length) {
      try {
        arr = (global.FigPalette && FigPalette.colors("npg")) || [];
      } catch (e2) { arr = []; }
    }
    return arr.filter(function (c) { return typeof c === "string"; }).slice(0, RECENT_MAX);
  }

  function pushRecent(hex) {
    if (!validHex(hex)) return;
    hex = hex6(hex).toUpperCase();
    var arr = recentColors().filter(function (c) {
      return c.toUpperCase() !== hex;
    });
    arr.unshift(hex);
    arr = arr.slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
    render();
  }

  // ------------------------------------------------------------------
  // Commit helpers
  // ------------------------------------------------------------------

  function commit(ops, label) {
    var App = app();
    if (!ops.length) return null;
    return App.commit(ops, { label: label, source: "user" });
  }

  function commitMoveXY(ids, x, y) {
    commit([{ op: "move", targets: ids, x: x, y: y }], "设置位置");
  }

  function commitResize(ids, w, h) {
    commit([{ op: "resize", targets: ids, w: w, h: h }], "设置尺寸");
  }

  function commitStyle(patch) {
    var ids = effectiveIds();
    commit([{ op: "set_style", targets: ids, style: patch }], "修改样式");
  }

  function commitColor(kind, value) {
    var ids = effectiveIds();
    var op = { op: "set_color", targets: ids };
    if (kind === "fill") op.color = value;
    else op.stroke = value;
    commit([op], kind === "fill" ? "修改填充色" : "修改描边色");
  }

  // ------------------------------------------------------------------
  // Change handlers
  // ------------------------------------------------------------------

  function onXY(which) {
    var ids = effectiveIds();
    if (!ids.length) return;
    var v = parseNum(refs[which].value);
    if (v === null) { app().error("请输入有效的" + (which === "x" ? "X" : "Y") + "数值（mm）"); render(); return; }
    if (ids.length === 1) {
      commitMoveXY(ids, which === "x" ? r3(v) : undefined, which === "y" ? r3(v) : undefined);
      return;
    }
    var u = unionBox(elementsOf(ids));
    if (!u) return;
    var dx = which === "x" ? r3(v - u.x) : 0;
    var dy = which === "y" ? r3(v - u.y) : 0;
    if (!dx && !dy) return;
    commit([{ op: "move", targets: ids, dx: dx, dy: dy }], "设置位置");
  }

  function onWH(which) {
    var ids = effectiveIds();
    if (!ids.length) return;
    var v = parseNum(refs[which].value);
    if (v === null || v <= 0) { app().error("请输入有效的正数（mm）"); render(); return; }
    if (ids.length === 1) {
      commitResize(ids, which === "w" ? r3(v) : undefined, which === "h" ? r3(v) : undefined);
      return;
    }
    // Multi selection: scale every element proportionally inside the union box.
    var els = elementsOf(ids);
    var u = unionBox(els);
    if (!u) return;
    var fx = which === "w" ? v / u.w : 1;
    var fy = which === "h" ? v / u.h : 1;
    if (!isFinite(fx) || !isFinite(fy) || u.w <= 0 || u.h <= 0) return;
    var ops = [];
    els.forEach(function (el) {
      var t = el.transform;
      if (!t) return;
      if (el.style && el.style.panelRelative === true) return; // ratio coords
      var nx = u.x + (t.x - u.x) * fx;
      var ny = u.y + (t.y - u.y) * fy;
      ops.push({ op: "move", targets: [el.id], x: r3(nx), y: r3(ny) });
      ops.push({ op: "resize", targets: [el.id], w: r3(t.w * fx), h: r3(t.h * fy) });
    });
    if (!commit(ops, "等比调整尺寸")) render();
  }

  function onRotation() {
    var ids = effectiveIds();
    if (!ids.length) return;
    var v = parseNum(refs.rot.value);
    if (v === null) { app().error("请输入有效的旋转角度（度）"); render(); return; }
    commit([{ op: "rotate", targets: ids, rotation: r3(v) }], "设置旋转");
  }

  function onFill() {
    if (refs.fillNone.checked) { commitColor("fill", null); return; }
    var hex = refs.fillColor.value;
    if (!validHex(hex)) { app().error("填充色格式无效，应为 #RRGGBB"); return; }
    commitColor("fill", hex6(hex).toUpperCase());
    pushRecent(hex6(hex).toUpperCase());
  }

  function onStroke() {
    if (refs.strokeNone.checked) { commitColor("stroke", null); return; }
    var hex = refs.strokeColor.value;
    if (!validHex(hex)) { app().error("描边色格式无效，应为 #RRGGBB"); return; }
    commitColor("stroke", hex6(hex).toUpperCase());
    pushRecent(hex6(hex).toUpperCase());
  }

  function onStrokeWidth() {
    var v = parseNum(refs.strokeWidth.value);
    if (v === null || v < 0) { app().error("线宽应为非负数（pt）"); render(); return; }
    commitStyle({ strokeWidthPt: r3(v) });
  }

  function onDash() {
    var t = refs.dash.value.trim();
    commitStyle({ dash: t || null });
  }

  function onOpacity() {
    var v = parseNum(refs.opacity.value);
    if (v === null || v < 0 || v > 1) { app().error("不透明度应在 0–1 之间"); render(); return; }
    commitStyle({ opacity: v });
  }

  function onFontFamily() {
    var v = refs.font.value;
    if (!v) return; // mixed placeholder selected — nothing chosen
    commitStyle({ fontFamily: v });
  }

  function onFontSize() {
    var v = parseNum(refs.fontSize.value);
    if (v === null || v <= 0) { app().error("字号应为正数（pt）"); render(); return; }
    commitStyle({ fontSizePt: r3(v) });
  }

  function onWeight() {
    var v = refs.weight.value;
    if (!v) return;
    commitStyle({ fontWeight: v });
  }

  function onItalic() {
    commitStyle({ fontStyle: refs.italic.checked ? "italic" : "normal" });
  }

  function onAlignH() {
    var v = refs.alignH.value;
    if (!v) return;
    var anchor = v === "center" ? "middle" : (v === "right" ? "end" : "start");
    commitStyle({ textAlign: v, textAnchor: anchor });
  }

  function onAlignV() {
    var v = refs.alignV.value;
    if (!v) return;
    commitStyle({ verticalAlign: v });
  }

  function onLineHeight() {
    var v = parseNum(refs.lineHeight.value);
    if (v === null || v < 0.5) { app().error("行高应不小于 0.5"); render(); return; }
    commitStyle({ lineHeight: v });
  }

  // ------------------------------------------------------------------
  // Characterization section (表征图表参数)
  //
  // Pending-edit model: every control writes into charState.pend only;
  // "应用修改" produces ONE set_chart_properties op. Values never come
  // from templates or scripts — only from the committed spec or user input.
  // ------------------------------------------------------------------

  var CHAR_DEFAULTS = {
    technique: "", x_reverse: false, x_scale: "linear", x_label: "",
    y_label: "", curves: [], fit_model: "", fit_source: "",
    peak_annotations: [], normalize: "none", offset_each_series: 0
  };

  var charState = {
    chartId: null,      // element id the pending buffer belongs to
    pend: null,         // pending characterization mirror (full object)
    pendAxes: null,     // pending axes labels {xLabel, yLabel}
    committedJson: "",  // committed state snapshot key at buffer creation
    dirty: false,       // pending edits not yet applied
    listJson: ""        // curves+peaks JSON at last list rebuild
  };

  function committedChar(chart) {
    return (chart && chart.characterization
      && typeof chart.characterization === "object"
      && !Array.isArray(chart.characterization)) ? chart.characterization : {};
  }

  // Committed values with contract defaults filled in (absent or explicit
  // null ≡ default, e.g. templates store fit_model: null), so the Apply
  // diff never writes redundant keys.
  function effectiveChar(chart) {
    var c = committedChar(chart);
    var eff = {};
    Object.keys(CHAR_DEFAULTS).forEach(function (k) {
      eff[k] = (c[k] === undefined || c[k] === null) ? CHAR_DEFAULTS[k] : c[k];
    });
    return eff;
  }

  function charKey(chart) {
    return JSON.stringify([
      chart.characterization === undefined ? null : chart.characterization,
      chart.axes ? { xLabel: chart.axes.xLabel || "", yLabel: chart.axes.yLabel || "" } : null
    ]);
  }

  function pendFromChart(chart) {
    var eff = effectiveChar(chart);
    var p = JSON.parse(JSON.stringify(eff));
    if (typeof p.technique !== "string") p.technique = "";
    if (typeof p.x_label !== "string") p.x_label = "";
    if (typeof p.y_label !== "string") p.y_label = "";
    if (typeof p.fit_model !== "string") p.fit_model = "";
    if (typeof p.fit_source !== "string") p.fit_source = "";
    if (typeof p.offset_each_series !== "number" || !isFinite(p.offset_each_series)) {
      p.offset_each_series = 0;
    }
    p.x_reverse = p.x_reverse === true;
    p.x_scale = p.x_scale === "log10" ? "log10" : "linear";
    p.normalize = p.normalize === "max_to_unity" ? "max_to_unity" : "none";
    p.curves = (Array.isArray(p.curves) ? p.curves : []).map(function (c) {
      var col = c && typeof c.column === "string" ? c.column : "";
      return {
        role: (c && (c.role === "fit" || c.role === "component" || c.role === "baseline"))
          ? c.role : "component",
        column: col,
        label: (c && typeof c.label === "string" && c.label !== "") ? c.label : col
      };
    });
    p.peak_annotations = (Array.isArray(p.peak_annotations) ? p.peak_annotations : [])
      .map(function (pk) {
        return {
          x: (pk && typeof pk.x === "number" && isFinite(pk.x)) ? pk.x : null,
          label: (pk && typeof pk.label === "string") ? pk.label : ""
        };
      });
    return p;
  }

  function currentCharElement() {
    var ids = effectiveIds();
    if (ids.length !== 1) return null;
    var el = elementsOf(ids)[0];
    return (el && el.type === "chart") ? el : null;
  }

  // Numeric columns of the chart's inline data (curve-column candidates).
  function numericColumns(chart) {
    var d = chart && chart.data && chart.data.inline;
    if (!d || !Array.isArray(d.columns) || !Array.isArray(d.rows)) return [];
    var out = [];
    for (var c = 0; c < d.columns.length; c++) {
      for (var r = 0; r < d.rows.length; r++) {
        var v = d.rows[r] ? d.rows[r][c] : null;
        if (v === null || v === undefined || v === "") continue;
        if (typeof v === "number" && isFinite(v)) { out.push(d.columns[c]); break; }
        if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) {
          out.push(d.columns[c]); break;
        }
      }
    }
    return out;
  }

  // Count of parseable values <= 0 in one inline column (log10 guard).
  function nonPositiveCount(chart, colName) {
    var d = chart && chart.data && chart.data.inline;
    if (!d || !Array.isArray(d.columns) || !Array.isArray(d.rows)) return -1;
    var ci = d.columns.indexOf(colName);
    if (ci < 0) return -1;
    var n = 0;
    for (var r = 0; r < d.rows.length; r++) {
      var v = d.rows[r] ? d.rows[r][ci] : null;
      if (v === null || v === undefined || v === "") continue;
      var num = typeof v === "number" ? v : (typeof v === "string" ? Number(v) : NaN);
      if (isFinite(num) && num <= 0) n++;
    }
    return n;
  }

  function markCharDirty() {
    charState.dirty = true;
    refreshCharButtons();
  }

  function refreshCharButtons() {
    var hasChar = !!(charState.pend && Object.keys(charState.pend).length);
    refs.chApply.disabled = !charState.dirty;
    refs.chRevert.disabled = !charState.dirty;
    refs.chClear.disabled = !hasChar;
  }

  function rebuildCharLists(chart) {
    var p = charState.pend;
    var listsJson = JSON.stringify([p.curves, p.peak_annotations]);
    var structureChanged = listsJson !== charState.listJson;
    charState.listJson = listsJson;
    if (!structureChanged) return;

    while (refs.chCurves.firstChild) refs.chCurves.removeChild(refs.chCurves.firstChild);
    var cols = numericColumns(chart);
    for (var i = 0; i < p.curves.length; i++) {
      refs.chCurves.appendChild(curveRow(p.curves[i], i, cols));
    }
    if (!p.curves.length) {
      refs.chCurves.appendChild(h("div", {
        text: "暂无声明曲线（fit / component / baseline 均须来自您已导入的数据列）",
        style: { fontSize: "11px", color: "#888", padding: "2px 0" }
      }));
    }

    while (refs.chPeaks.firstChild) refs.chPeaks.removeChild(refs.chPeaks.firstChild);
    for (var j = 0; j < p.peak_annotations.length; j++) {
      refs.chPeaks.appendChild(peakRow(p.peak_annotations[j], j));
    }
    if (!p.peak_annotations.length) {
      refs.chPeaks.appendChild(h("div", {
        text: "暂无峰标注（峰位与标签只能由您填写，不提供默认 D/G 等峰位）",
        style: { fontSize: "11px", color: "#888", padding: "2px 0" }
      }));
    }
    refreshCharButtons();
  }

  function curveRow(curve, idx, cols) {
    var options = cols.slice();
    if (curve.column && options.indexOf(curve.column) < 0) options.unshift(curve.column);
    var colSel = document.createElement("select");
    colSel.appendChild(h("option", { value: "", text: "（选择数据列）" }));
    options.forEach(function (name) {
      colSel.appendChild(h("option", { value: name, text: name }));
    });
    colSel.value = curve.column || "";
    colSel.addEventListener("change", function () {
      curve.column = colSel.value;
      markCharDirty();
    });
    var roleSel = document.createElement("select");
    [["fit", "fit（拟合）"], ["component", "component（组分）"],
     ["baseline", "baseline（基线）"]].forEach(function (ro) {
      roleSel.appendChild(h("option", { value: ro[0], text: ro[1] }));
    });
    roleSel.value = curve.role;
    roleSel.addEventListener("change", function () {
      curve.role = roleSel.value;
      markCharDirty();
    });
    var labelInput = h("input", {
      type: "text", value: curve.label, placeholder: "图例标签（可空）",
      style: { width: "86px", fontSize: "12px", boxSizing: "border-box" }
    });
    labelInput.addEventListener("change", function () {
      curve.label = labelInput.value;
      markCharDirty();
    });
    var del = h("button", {
      text: "移除", title: "移除该曲线声明",
      style: { fontSize: "11px", padding: "1px 6px", cursor: "pointer" }
    });
    del.addEventListener("click", function () {
      charState.pend.curves.splice(idx, 1);
      markCharDirty();
      rebuildCharLists(currentCharElement() ? currentCharElement().chart || {} : {});
    });
    return h("div", {
      style: { display: "flex", alignItems: "center", gap: "4px", margin: "3px 0", flexWrap: "wrap" }
    }, [roleSel, colSel, labelInput, del]);
  }

  function peakRow(peak, idx) {
    var xInput = h("input", {
      type: "number", step: "any", placeholder: "X",
      value: peak.x === null || peak.x === undefined ? "" : String(peak.x),
      style: { width: "76px", fontSize: "12px", boxSizing: "border-box" }
    });
    xInput.addEventListener("change", function () {
      var v = parseNum(xInput.value);
      peak.x = v; // null stays null; Apply validates
      markCharDirty();
    });
    var labelInput = h("input", {
      type: "text", value: peak.label, placeholder: "峰标签（用户申报）",
      style: { width: "104px", fontSize: "12px", boxSizing: "border-box" }
    });
    labelInput.addEventListener("change", function () {
      peak.label = labelInput.value;
      markCharDirty();
    });
    var del = h("button", {
      text: "移除", title: "移除该峰标注",
      style: { fontSize: "11px", padding: "1px 6px", cursor: "pointer" }
    });
    del.addEventListener("click", function () {
      charState.pend.peak_annotations.splice(idx, 1);
      markCharDirty();
      rebuildCharLists(currentCharElement() ? currentCharElement().chart || {} : {});
    });
    return h("div", {
      style: { display: "flex", alignItems: "center", gap: "4px", margin: "3px 0", flexWrap: "wrap" }
    }, [xInput, labelInput, del]);
  }

  function onAddCurve() {
    if (!charState.pend) return;
    var el = currentCharElement();
    var cols = el ? numericColumns(el.chart || {}) : [];
    var col = cols.length ? cols[0] : "";
    charState.pend.curves.push({ role: "component", column: col, label: col });
    markCharDirty();
    rebuildCharLists(el ? el.chart || {} : {});
  }

  function onAddPeak() {
    if (!charState.pend) return;
    charState.pend.peak_annotations.push({ x: null, label: "" });
    markCharDirty();
    rebuildCharLists(currentCharElement() ? currentCharElement().chart || {} : {});
  }

  function onCharTechnique() {
    charState.pend.technique = refs.chTechnique.value;
    markCharDirty();
  }

  function onCharLabel(which) {
    var v = refs[which === "xLabel" ? "chXLabel" : "chYLabel"].value;
    charState.pendAxes[which] = v;
    // Keep the characterization axis label in sync: the renderer gives
    // characterization.x_label/y_label precedence for char charts, so the
    // edit must reach both places (one Apply, one history record).
    charState.pend[which === "xLabel" ? "x_label" : "y_label"] = v;
    markCharDirty();
  }

  function onCharReverse() {
    charState.pend.x_reverse = refs.chReverse.checked === true;
    markCharDirty();
  }

  function onCharXScale() {
    charState.pend.x_scale = refs.chXScale.value === "log10" ? "log10" : "linear";
    markCharDirty();
    updateCharGuard(currentCharElement() ? currentCharElement().chart || {} : {});
  }

  function onCharNormalize() {
    charState.pend.normalize = refs.chNormalize.value === "max_to_unity"
      ? "max_to_unity" : "none";
    markCharDirty();
    updateCharGuard(currentCharElement() ? currentCharElement().chart || {} : {});
  }

  function onCharOffset() {
    var v = parseNum(refs.chOffset.value);
    charState.pend.offset_each_series = (v === null) ? 0 : v;
    markCharDirty();
  }

  function onCharFitModel() {
    charState.pend.fit_model = refs.chFitModel.value;
    markCharDirty();
  }

  // log10 / normalization / offset hints. The log10 guard pre-checks the
  // mapping.x column for non-positive values (renderer excludes them and
  // warns; inline rows are never modified).
  function updateCharGuard(chart) {
    var p = charState.pend;
    var msgs = [];
    if (p && p.x_scale === "log10") {
      var col = (chart && chart.mapping && typeof chart.mapping.x === "string")
        ? chart.mapping.x : null;
      if (col) {
        var n = nonPositiveCount(chart, col);
        if (n > 0) {
          msgs.push("log10 守卫：「" + col + "」列有 " + n + " 个非正值，渲染时将被剔除并给出数据排除警告；内联原始数据不变。");
        } else if (n === 0) {
          msgs.push("log10 守卫：「" + col + "」列未发现非正值。");
        } else {
          msgs.push("log10 守卫：找不到「" + col + "」列，无法预检非正值。");
        }
      } else {
        msgs.push("log10 守卫：未设置 mapping.x，无法预检非正值。");
      }
    }
    if (p && p.normalize === "max_to_unity") {
      msgs.push("归一化 max_to_unity 仅在您明确声明后应用，原始数据永不修改。");
    }
    msgs.push("叠加偏移只表示视觉位置，偏移后的差值不作为真实数据参与统计或显著性。");
    refs.chGuard.textContent = msgs.join(" ");
  }

  function charDiffPatch(chart) {
    var App = app();
    var eff = effectiveChar(chart);
    var p = charState.pend;
    var patch = {};

    ["technique", "x_label", "y_label", "fit_model"].forEach(function (k) {
      if (String(p[k] === null || p[k] === undefined ? "" : p[k]) !== String(eff[k])) {
        patch[k] = String(p[k] === null || p[k] === undefined ? "" : p[k]);
      }
    });
    if ((p.x_reverse === true) !== (eff.x_reverse === true)) {
      patch.x_reverse = p.x_reverse === true;
    }
    if (p.x_scale !== eff.x_scale) patch.x_scale = p.x_scale;
    if (p.normalize !== eff.normalize) patch.normalize = p.normalize;
    var off = (typeof p.offset_each_series === "number" && isFinite(p.offset_each_series))
      ? p.offset_each_series : 0;
    if (off !== eff.offset_each_series) patch.offset_each_series = off;

    var curves = (Array.isArray(p.curves) ? p.curves : []).map(function (c) {
      return { role: c.role, column: String(c.column || ""), label: String(c.label || "") };
    });
    if (JSON.stringify(curves) !== JSON.stringify(eff.curves || [])) {
      patch.curves = curves;
    }

    var peaks = [];
    for (var i = 0; i < p.peak_annotations.length; i++) {
      var pk = p.peak_annotations[i];
      if (typeof pk.x !== "number" || !isFinite(pk.x)) {
        App.error("峰标注第 " + (i + 1) + " 行的 X 必须是有效数字（峰位只能由您申报）");
        return null;
      }
      if (typeof pk.label !== "string" || !pk.label.trim()) {
        App.error("峰标注第 " + (i + 1) + " 行的标签不能为空");
        return null;
      }
      peaks.push({ x: pk.x, label: pk.label });
    }
    if (JSON.stringify(peaks) !== JSON.stringify(eff.peak_annotations || [])) {
      patch.peak_annotations = peaks;
    }

    // fit_source follows the user's own declaration of a fit curve; it is
    // the only allowed value and is never invented by the panel.
    var hasFit = curves.some(function (c) { return c.role === "fit"; });
    if (hasFit && eff.fit_source !== "provided_by_user_fit") {
      patch.fit_source = "provided_by_user_fit";
    }
    return patch;
  }

  function onApplyChar() {
    var App = app();
    var el = currentCharElement();
    if (!el) return;
    var chart = el.chart || {};
    var props = {};

    var axesPatch = {};
    var ax = chart.axes || {};
    ["xLabel", "yLabel"].forEach(function (k) {
      var pend = String(charState.pendAxes[k] === null || charState.pendAxes[k] === undefined
        ? "" : charState.pendAxes[k]);
      if (pend !== String(ax[k] === undefined || ax[k] === null ? "" : ax[k])) {
        axesPatch[k] = pend;
      }
    });
    if (Object.keys(axesPatch).length) props.axes = axesPatch;

    var charPatch = charDiffPatch(chart);
    if (charPatch === null) return; // client-side validation error shown
    // 普通图表（未声明 characterization）：只改轴标签的编辑只走 axes，
    // 不因标签编辑暗中创建 characterization 块（避免 technique-missing
    // 告警与渲染路径切换）；声明其它表征字段时才一并落块。
    if (!(chart && chart.characterization && typeof chart.characterization === "object")) {
      var labelOnly = ["x_label", "y_label"];
      var nonLabel = Object.keys(charPatch).filter(function (k) {
        return labelOnly.indexOf(k) < 0;
      });
      if (!nonLabel.length) {
        labelOnly.forEach(function (k) { delete charPatch[k]; });
      }
    }
    if (Object.keys(charPatch).length) props.characterization = charPatch;

    if (!Object.keys(props).length) {
      App.status("表征参数无修改");
      return;
    }
    var label = props.axes && props.characterization ? "编辑表征图表属性"
      : (props.characterization ? "编辑表征参数" : "编辑坐标轴标签");
    var r = commit([{ op: "set_chart_properties", targets: [el.id], properties: props }], label);
    if (r) charState.dirty = false; // doc:changed -> render re-syncs the buffer
  }

  function onRevertChar() {
    var el = currentCharElement();
    if (!el) return;
    var chart = el.chart || {};
    charState.pend = pendFromChart(chart);
    charState.pendAxes = {
      xLabel: (chart.axes && chart.axes.xLabel) || "",
      yLabel: (chart.axes && chart.axes.yLabel) || ""
    };
    charState.dirty = false;
    charState.listJson = "";
    rebuildCharLists(chart);
    populateCharInputs(chart);
    updateCharGuard(chart);
    app().status("已还原为文档中的表征参数");
  }

  function onClearChar() {
    var App = app();
    var el = currentCharElement();
    if (!el) return;
    if (!(el.chart && el.chart.characterization !== undefined)) {
      App.status("该图表没有表征参数可清除");
      return;
    }
    commit([{ op: "set_chart_properties", targets: [el.id],
      properties: { characterization: null } }], "清除表征参数");
    if (charState.dirty) App.status("已清除表征参数（未应用的待定修改一并丢弃）");
    charState.dirty = false;
  }

  function charRow(labelText, control) {
    return h("label", {
      style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", margin: "4px 0" }
    }, [h("span", { text: labelText, style: { width: "72px", flex: "none" } }), control]);
  }

  function charTextInput(key, placeholder, onchange) {
    var input = h("input", {
      type: "text", placeholder: placeholder || "",
      style: { width: "150px", fontSize: "12px", boxSizing: "border-box" }
    });
    input.addEventListener("change", onchange);
    refs[key] = input;
    return input;
  }

  function populateCharInputs(chart) {
    var p = charState.pend;
    refs.chTechnique.value = p.technique;
    refs.chXLabel.value = charState.pendAxes.xLabel;
    refs.chYLabel.value = charState.pendAxes.yLabel;
    setCheckbox(refs.chReverse, p.x_reverse === true);
    refs.chXScale.value = p.x_scale;
    refs.chNormalize.value = p.normalize;
    refs.chOffset.value = String(p.offset_each_series);
    refs.chFitModel.value = p.fit_model;
    var committedFitSource = committedChar(chart).fit_source;
    refs.chFitSource.textContent = committedFitSource
      ? String(committedFitSource) + "（来自您提供的拟合列）"
      : "—（声明 fit 曲线并应用后自动记录）";
    refreshCharButtons();
  }

  // ------------------------------------------------------------------
  // R04：图表部件局部样式（chart.presentation 受控覆盖）
  //
  // 选中 chart 且 App.ui.chartPart 指向语义部件（系列/图例/轴标题/峰标注）
  // 时显示。每次「应用」恰好一笔 set_chart_properties（presentation 补丁），
  // 可撤销；「恢复继承」用 null 删除该级覆盖。样式不改数据/统计/绑定列。
  // ------------------------------------------------------------------

  function partPresentation(chart, ref) {
    var pres = (chart.chart && chart.chart.presentation) || {};
    if (ref.part === "series" && ref.seriesKey) {
      return pres.series && pres.series[ref.seriesKey] ? pres.series[ref.seriesKey] : {};
    }
    if (ref.part === "legend") return pres.legend || {};
    if (ref.part === "axis-title-x" || ref.part === "axis-title-y") {
      var axis = ref.part === "axis-title-x" ? "x" : "y";
      return (pres.axes && pres.axes[axis] && pres.axes[axis].title) || {};
    }
    if (ref.part === "peak" && ref.peakId) {
      return pres.peaks && pres.peaks[ref.peakId] ? pres.peaks[ref.peakId] : {};
    }
    return {};
  }

  function buildPresentationPatch(ref, values) {
    var patch = { version: 1 };
    if (ref.part === "series") patch.series = (function () {
      var o = {}; o[ref.seriesKey] = values; return o;
    })();
    else if (ref.part === "legend") patch.legend = values;
    else if (ref.part === "axis-title-x" || ref.part === "axis-title-y") {
      var ax = {}; ax[ref.part === "axis-title-x" ? "x" : "y"] = { title: values };
      patch.axes = ax;
    } else if (ref.part === "peak") {
      var pk = {}; pk[ref.peakId] = values; patch.peaks = pk;
    }
    return patch;
  }

  function renderMultiSection() {
    if (!refs.multiTitle || !refs.multiWrap) return;
    var App = app();
    var charts = (App.doc && App.doc.elements || []).filter(function (e) {
      return e && e.type === "chart" && e.chart && e.chart.data &&
        e.chart.data.inline && Array.isArray(e.chart.data.inline.rows) &&
        e.chart.data.inline.rows.length;
    });
    var show = charts.length >= 2;
    refs.multiTitle.style.display = show ? "" : "none";
    refs.multiWrap.style.display = show ? "" : "none";
  }

  function renderPartSection(els, single) {
    if (!refs.partTitle || !refs.partWrap) return;
    var App = app();
    var ref = App.ui && App.ui.chartPart;
    var isChartSel = single && els[0] && els[0].type === "chart";
    var applicable = isChartSel && ref && ref.chartId === els[0].id &&
      ["series", "legend", "axis-title-x", "axis-title-y", "peak"].indexOf(ref.part) >= 0 &&
      (ref.part !== "series" || ref.seriesKey) &&
      (ref.part !== "peak" || ref.peakId);
    refs.partTitle.style.display = applicable ? "" : "none";
    refs.partWrap.style.display = applicable ? "" : "none";
    if (!applicable) return;
    var el = els[0];
    var cur = partPresentation(el, ref);

    function label(name) {
      if (ref.part === "series" && ref.seriesKey) {
        var ident = (global.FigData && FigData.seriesIdentity(el.chart) || [])
          .filter(function (s) { return s.key === ref.seriesKey; })[0];
        return "系列 " + (ident ? ident.label : ref.seriesKey);
      }
      if (ref.part === "legend") return "图例";
      if (ref.part === "axis-title-x") return "X 轴标题";
      if (ref.part === "axis-title-y") return "Y 轴标题";
      if (ref.part === "peak") return "峰标注 " + ref.peakId;
      return "图表部件";
    }

    refs.partWrap.textContent = "";
    refs.partWrap.appendChild(h("div", {
      text: label() + "（样式覆盖不改数据；原始行与统计不变）",
      style: { fontSize: "11px", color: "#555", margin: "2px 0 6px" }
    }));

    var inputs = {};
    function numField(key, text, min, max, step) {
      var inp = h("input", { type: "number", min: String(min), max: String(max),
        step: String(step), value: cur[key] != null ? String(cur[key]) : "",
        placeholder: "继承", "aria-label": text,
        style: { width: "62px", fontSize: "12px", boxSizing: "border-box" } });
      inputs[key] = inp;
      return h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
        fontSize: "12px", marginRight: "10px" } }, [
        h("span", { text: text, style: { width: "44px" } }), inp
      ]);
    }
    function colorField(key, text) {
      var inp = h("input", { type: "color", value: cur[key] || "#000000",
        "aria-label": text, style: { width: "40px", padding: "0", height: "22px" } });
      inputs[key] = inp;
      return h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
        fontSize: "12px", marginRight: "10px" } }, [
        h("span", { text: text, style: { width: "44px" } }), inp
      ]);
    }

    var rows = [];
    if (ref.part === "series") {
      rows.push(colorField("stroke", "颜色"));
      rows.push(numField("strokeWidthPt", "线宽", 0.1, 20, 0.1));
      var dashInp = h("input", { type: "text", value: cur.dash || "",
        placeholder: "如 4 2，空=实线", "aria-label": "虚线",
        style: { width: "110px", fontSize: "12px", boxSizing: "border-box" } });
      inputs.dash = dashInp;
      rows.push(h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
        fontSize: "12px" } }, [h("span", { text: "虚线", style: { width: "44px" } }), dashInp]));
    } else if (ref.part === "legend") {
      var posSel = h("select", { "aria-label": "图例位置",
        style: { fontSize: "12px", maxWidth: "110px" } });
      ["", "none", "right", "top", "bottom"].forEach(function (v) {
        posSel.appendChild(h("option", {
          value: v, text: v === "" ? "继承" : (v === "none" ? "不显示" : v)
        }));
      });
      posSel.value = cur.position || "";
      inputs.position = posSel;
      rows.push(h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
        fontSize: "12px", marginRight: "10px" } }, [
        h("span", { text: "位置", style: { width: "44px" } }), posSel
      ]));
      rows.push(numField("fontSizePt", "字号", 1, 200, 0.5));
      rows.push(colorField("color", "颜色"));
    } else if (ref.part === "axis-title-x" || ref.part === "axis-title-y") {
      rows.push(numField("fontSizePt", "字号", 1, 200, 0.5));
      rows.push(colorField("color", "颜色"));
      var bold = h("input", { type: "checkbox" });
      bold.checked = cur.fontWeight === "bold";
      inputs.fontWeight = bold;
      rows.push(h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
        fontSize: "12px" } }, [bold, h("span", { text: "加粗" })]));
    } else if (ref.part === "peak") {
      rows.push(colorField("color", "颜色"));
      rows.push(numField("fontSizePt", "字号", 1, 200, 0.5));
    }
    var row = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px",
      alignItems: "center", marginBottom: "4px" } }, rows);
    refs.partWrap.appendChild(row);

    function collectValues(clear) {
      if (clear) return null; // null = 删除该级覆盖（恢复继承）
      var v = {};
      ["stroke", "strokeWidthPt", "dash", "position", "fontSizePt", "color"].forEach(function (k) {
        var inp = inputs[k];
        if (!inp) return;
        var raw = String(inp.value == null ? "" : inp.value).trim();
        if (raw === "") return; // 空输入 = 继承（不写覆盖）
        if (k === "stroke" || k === "color") v[k] = raw;
        else if (k === "strokeWidthPt" || k === "fontSizePt") {
          var n = Number(raw);
          if (isFinite(n) && n > 0) v[k] = n;
        } else v[k] = raw;
      });
      if (inputs.fontWeight && inputs.fontWeight.checked) v.fontWeight = "bold";
      return v;
    }

    var applyBtn = h("button", {
      text: "应用部件样式",
      title: "一笔 set_chart_properties（presentation 补丁），可撤销；不改数据与统计",
      style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer", marginRight: "6px" }
    });
    applyBtn.addEventListener("click", function () {
      var values = collectValues(false);
      if (!values || !Object.keys(values).length) {
        if (global.Ui && Ui.toast) Ui.toast("没有可应用的修改（空输入表示继承）", { type: "info" });
        return;
      }
      var patch = buildPresentationPatch(ref, values);
      commit([{
        op: "set_chart_properties", targets: [el.id],
        properties: { presentation: patch },
        reason: "图表部件局部样式：" + label()
      }], "图表部件样式：" + label());
    });
    var resetBtn = h("button", {
      text: "恢复继承",
      title: "删除该部件的样式覆盖（null 语义），回到默认渲染",
      style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer" }
    });
    resetBtn.addEventListener("click", function () {
      var patch = buildPresentationPatch(ref, null);
      commit([{
        op: "set_chart_properties", targets: [el.id],
        properties: { presentation: patch },
        reason: "恢复继承：" + label()
      }], "恢复部件继承：" + label());
    });
    refs.partWrap.appendChild(applyBtn);
    refs.partWrap.appendChild(resetBtn);
  }

  function renderCharSection(els, single) {
    var isChart = single && els[0].type === "chart";
    refs.charTitle.style.display = isChart ? "" : "none";
    refs.charWrap.style.display = isChart ? "" : "none";
    if (!isChart) {
      charState.chartId = null;
      charState.pend = null;
      charState.pendAxes = null;
      charState.dirty = false;
      charState.listJson = "";
      return;
    }
    var el = els[0];
    var chart = el.chart || {};
    var key = charKey(chart);
    var selectionChanged = charState.chartId !== el.id;
    var externallyChanged = !charState.dirty && key !== charState.committedJson;
    if (selectionChanged || externallyChanged || !charState.pend) {
      charState.chartId = el.id;
      charState.committedJson = key;
      charState.dirty = false;
      charState.listJson = "";
      charState.pend = pendFromChart(chart);
      charState.pendAxes = {
        xLabel: (chart.axes && chart.axes.xLabel) || "",
        yLabel: (chart.axes && chart.axes.yLabel) || ""
      };
      rebuildCharLists(chart);
    } else {
      // Structure edits from this panel's own add/remove already rebuilt;
      // committed JSON only moves after Apply (handled above next render).
      rebuildCharLists(chart);
    }
    populateCharInputs(chart);
    updateCharGuard(chart);
  }

  function connectorContext() {
    var ids = effectiveIds();
    if (ids.length !== 1) return null;
    var el = elementsOf(ids)[0], doc = app().doc;
    if (!el || el.type !== "connector" || !el.relation) return null;
    var sid = el.diagram_id || el.diagramId;
    var entry = doc.meta && doc.meta.diagrams && doc.meta.diagrams[sid];
    var contract = entry && (entry.contract || entry.spec);
    if (!contract || !Array.isArray(contract.relations)) return null;
    var rid = el.semantic_relation && el.semantic_relation.id;
    var index = contract.relations.findIndex(function (r) { return r.id === rid; });
    if (index < 0) {
      index = contract.relations.findIndex(function (r) {
        return r.source === el.relation.source && r.target === el.relation.target && r.kind === el.relation.kind;
      });
    }
    return index < 0 ? null : { el: el, contract: contract, index: index };
  }

  function onRelationSemanticChange() {
    var context = connectorContext();
    if (!context) return;
    var contract = JSON.parse(JSON.stringify(context.contract));
    var relation = contract.relations[context.index];
    var kind = refs.relKind.value, direction = refs.relDirection.value;
    if (kind === "include" || kind === "associate") direction = "none";
    if (kind !== "include" && kind !== "associate" && direction === "none") direction = "forward";
    Object.keys(relation).forEach(function (key) { delete relation[key]; });
    var original = context.contract.relations[context.index];
    Object.keys(original).forEach(function (key) {
      if (key !== "kind" && key !== "direction" && key !== "source" && key !== "target") relation[key] = original[key];
    });
    relation.source = refs.relSource.value;
    relation.target = refs.relTarget.value;
    relation.kind = kind;
    relation.direction = direction;
    commit([{ op: "apply_schematic", contract: contract }], "修改科学关系（保留节点文本与手动布局）");
  }

  function renderRelationSection(els, single) {
    var context = single && els[0].type === "connector" ? connectorContext() : null;
    refs.relTitle.style.display = context ? "" : "none";
    refs.relWrap.style.display = context ? "" : "none";
    if (!context) return;
    [refs.relKind, refs.relSource, refs.relTarget, refs.relDirection, refs.relApply].forEach(function (input) { input.disabled = false; });
    refs.relKind.value = context.el.relation.kind;
    refs.relDirection.value = context.el.relation.direction || "forward";
    [refs.relSource, refs.relTarget].forEach(function (select, endpointIndex) {
      select.innerHTML = "";
      context.contract.nodes.forEach(function (node) {
        select.appendChild(h("option", { value: node.id, text: node.id + " · " + node.label }));
      });
      select.value = context.el.relation[endpointIndex ? "target" : "source"];
    });
  }

  function relationSelect(label, key, onchange) {
    var select = document.createElement("select");
    select.style.cssText = "max-width:150px;font-size:12px;";
    select.addEventListener("change", onchange || function () {});
    refs[key] = select;
    return h("label", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", margin: "4px 0" } },
      [h("span", { text: label, style: { width: "58px" } }), select]);
  }

  // ------------------------------------------------------------------
  // DOM building
  // ------------------------------------------------------------------

  function numRow(label, key, step, min, oncommit, unit) {
    var input = h("input", {
      type: "number", step: String(step),
      style: { width: "58px", boxSizing: "border-box" }
    });
    if (min !== undefined) input.setAttribute("min", String(min));
    input.addEventListener("change", oncommit);
    refs[key] = input;
    return h("label", {
      style: { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px" }
    }, [h("span", { text: label }), input, unit ? h("span", { text: unit, style: { color: "#888" } }) : null]);
  }

  function colorRow(label, noneKey, noneLabel, colorKey, oncommit) {
    var none = h("input", { type: "checkbox" });
    none.addEventListener("change", function () {
      refs[colorKey].disabled = none.checked;
      oncommit();
    });
    var color = h("input", {
      type: "color", style: { width: "28px", height: "20px", padding: "0", border: "none", background: "none" }
    });
    color.addEventListener("change", oncommit);
    refs[noneKey] = none;
    refs[colorKey] = color;
    var swatches = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "3px", margin: "4px 0 0 2px" } });
    refs[noneKey + "Swatches"] = swatches;
    return h("div", { style: { margin: "4px 0" } }, [
      h("div", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" } }, [
        h("span", { text: label, style: { width: "48px" } }),
        color,
        h("label", { style: { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11px", color: "#555" } }, [
          none, h("span", { text: noneLabel })
        ])
      ]),
      swatches
    ]);
  }

  function selectRow(label, key, options, oncommit, mixedOption) {
    var sel = document.createElement("select");
    if (mixedOption) {
      sel.appendChild(h("option", { value: "", text: "（混合）" }));
    }
    options.forEach(function (o) {
      sel.appendChild(h("option", { value: o.value, text: o.label }));
    });
    sel.addEventListener("change", oncommit);
    sel.style.cssText = "max-width:150px;font-size:12px;";
    refs[key] = sel;
    return h("label", {
      style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", margin: "4px 0" }
    }, [h("span", { text: label, style: { width: "54px" } }), sel]);
  }

  function sectionTitle(text) {
    return h("div", {
      text: text,
      style: {
        fontWeight: "700", fontSize: "12px", color: "#345",
        borderBottom: "1px solid #ddd", padding: "6px 8px 3px", marginTop: "4px"
      }
    });
  }

  function buildUI(panel) {
    panel.innerHTML = "";

    var info = h("div", {
      text: "未选中元素",
      style: { padding: "6px 8px", fontSize: "12px", color: "#555" }
    });
    refs.info = info;
    var hint = h("div", {
      text: "",
      style: { padding: "0 8px 4px", fontSize: "11px", color: "#a60" }
    });
    refs.hint = hint;

    // --- geometry ---
    var geo = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", padding: "4px 8px" } });
    geo.appendChild(numRow("X", "x", 0.1, 0, function () { onXY("x"); }, "mm"));
    geo.appendChild(numRow("Y", "y", 0.1, 0, function () { onXY("y"); }, "mm"));
    geo.appendChild(numRow("W", "w", 0.1, 0.1, function () { onWH("w"); }, "mm"));
    geo.appendChild(numRow("H", "h", 0.1, 0.1, function () { onWH("h"); }, "mm"));
    geo.appendChild(numRow("旋转", "rot", 1, undefined, onRotation, "°"));

    // --- appearance ---
    var look = h("div", { style: { padding: "2px 8px" } });
    look.appendChild(colorRow("填充", "fillNone", "无", "fillColor", onFill));
    look.appendChild(colorRow("描边", "strokeNone", "无", "strokeColor", onStroke));
    var look2 = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", padding: "4px 8px" } });
    look2.appendChild(numRow("线宽", "strokeWidth", 0.25, 0, onStrokeWidth, "pt"));
    look2.appendChild(numRow("不透明", "opacity", 0.05, 0, onOpacity, ""));
    var dashWrap = h("label", {
      style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", margin: "4px 8px" }
    }, [
      h("span", { text: "虚线", style: { width: "54px" } }),
      (refs.dash = h("input", {
        type: "text", placeholder: "如 2 1，留空为实线",
        style: { width: "140px", fontSize: "12px" }
      }))
    ]);
    refs.dash.addEventListener("change", onDash);

    // --- text ---
    var text = h("div", { style: { padding: "2px 8px" } });
    text.appendChild(selectRow("字体族", "font", FONTS.map(function (f) {
      return { value: f, label: f };
    }), onFontFamily, true));
    text.appendChild(selectRow("字重", "weight", [
      { value: "normal", label: "常规" },
      { value: "bold", label: "粗体" }
    ], onWeight, true));
    text.appendChild(selectRow("水平对齐", "alignH", [
      { value: "left", label: "左对齐" },
      { value: "center", label: "居中" },
      { value: "right", label: "右对齐" }
    ], onAlignH, true));
    text.appendChild(selectRow("垂直对齐", "alignV", [
      { value: "top", label: "顶部" },
      { value: "middle", label: "居中" },
      { value: "bottom", label: "底部" }
    ], onAlignV, true));
    var italicWrap = h("label", {
      style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", margin: "4px 0" }
    }, [
      h("span", { text: "斜体", style: { width: "54px" } }),
      (refs.italic = h("input", { type: "checkbox" }))
    ]);
    refs.italic.addEventListener("change", onItalic);
    text.appendChild(italicWrap);
    var text2 = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", padding: "0 8px 8px" } });
    text2.appendChild(numRow("字号", "fontSize", 0.5, 0.5, onFontSize, "pt"));
    text2.appendChild(numRow("行高", "lineHeight", 0.1, 0.5, onLineHeight, ""));

    // --- characterization (表征图表参数) ---
    var charTitle = sectionTitle("表征图表参数");
    refs.charTitle = charTitle;
    var charWrap = h("div", { style: { padding: "0 8px 8px" } });
    refs.charWrap = charWrap;
    charWrap.appendChild(h("div", {
      text: "以下字段写入 chart.characterization（统一表征契约）；原始数据列永不修改。",
      style: { fontSize: "11px", color: "#888", margin: "2px 0 6px" }
    }));
    charWrap.appendChild(charRow("技术", charTextInput("chTechnique",
      "如 XPS / Raman / XRD（用户申报）", onCharTechnique)));
    charWrap.appendChild(charRow("X轴标签", charTextInput("chXLabel",
      "含单位，如 Binding energy (eV)", function () { onCharLabel("xLabel"); })));
    charWrap.appendChild(charRow("Y轴标签", charTextInput("chYLabel",
      "含单位，如 Intensity (counts)", function () { onCharLabel("yLabel"); })));
    var reverseWrap = h("label", {
      style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", margin: "4px 0" }
    }, [
      h("span", { text: "X反向", style: { width: "72px", flex: "none" } }),
      (refs.chReverse = h("input", { type: "checkbox", title: "横轴反转（XPS/NMR 结合能习惯）" }))
    ]);
    refs.chReverse.addEventListener("change", onCharReverse);
    charWrap.appendChild(reverseWrap);
    charWrap.appendChild(charRow("X刻度", (function () {
      var sel = document.createElement("select");
      sel.appendChild(h("option", { value: "linear", text: "linear（线性）" }));
      sel.appendChild(h("option", { value: "log10", text: "log10（非正值剔除）" }));
      sel.style.cssText = "max-width:150px;font-size:12px;";
      sel.addEventListener("change", onCharXScale);
      refs.chXScale = sel;
      return sel;
    })()));
    charWrap.appendChild(charRow("归一化", (function () {
      var sel = document.createElement("select");
      sel.appendChild(h("option", { value: "none", text: "不归一" }));
      sel.appendChild(h("option", { value: "max_to_unity", text: "max_to_unity（最大值归一）" }));
      sel.style.cssText = "max-width:150px;font-size:12px;";
      sel.addEventListener("change", onCharNormalize);
      refs.chNormalize = sel;
      return sel;
    })()));
    charWrap.appendChild(charRow("叠加偏移", (function () {
      var input = h("input", {
        type: "number", step: "any", title: "offset_each_series：仅表示视觉位置",
        style: { width: "150px", fontSize: "12px", boxSizing: "border-box" }
      });
      input.addEventListener("change", onCharOffset);
      refs.chOffset = input;
      return input;
    })()));
    charWrap.appendChild(charRow("拟合模型", charTextInput("chFitModel",
      "由您申报，如 Shirley / Voigt", onCharFitModel)));
    charWrap.appendChild(charRow("拟合来源", (function () {
      var span = h("span", {
        text: "—",
        style: { fontSize: "11px", color: "#555", flex: "1" }
      });
      refs.chFitSource = span;
      return span;
    })()));

    charWrap.appendChild(h("div", {
      text: "曲线声明（fit / component / baseline，均来自已导入数值列）",
      style: { fontSize: "11px", fontWeight: "700", color: "#345", margin: "6px 0 2px" }
    }));
    refs.chCurves = h("div", {});
    charWrap.appendChild(refs.chCurves);
    var addCurveBtn = h("button", {
      text: "添加曲线", title: "声明一条曲线并选择其数据列",
      style: { fontSize: "11px", padding: "2px 8px", cursor: "pointer", margin: "3px 0" }
    });
    addCurveBtn.addEventListener("click", onAddCurve);
    charWrap.appendChild(addCurveBtn);

    charWrap.appendChild(h("div", {
      text: "峰标注（X 位置与标签，仅来自您的申报）",
      style: { fontSize: "11px", fontWeight: "700", color: "#345", margin: "6px 0 2px" }
    }));
    refs.chPeaks = h("div", {});
    charWrap.appendChild(refs.chPeaks);
    var addPeakBtn = h("button", {
      text: "添加峰标注", title: "添加一条峰标注（X + 标签）",
      style: { fontSize: "11px", padding: "2px 8px", cursor: "pointer", margin: "3px 0" }
    });
    addPeakBtn.addEventListener("click", onAddPeak);
    charWrap.appendChild(addPeakBtn);

    refs.chGuard = h("div", {
      text: "",
      style: { fontSize: "11px", color: "#a60", margin: "6px 0" }
    });
    charWrap.appendChild(refs.chGuard);

    var charBtns = h("div", { style: { display: "flex", gap: "6px", margin: "4px 0" } });
    refs.chApply = h("button", {
      text: "应用修改", title: "一次提交全部表征修改（单条历史记录，可撤销）",
      style: { fontSize: "12px", padding: "2px 10px", cursor: "pointer" }
    });
    refs.chApply.addEventListener("click", onApplyChar);
    refs.chRevert = h("button", {
      text: "还原", title: "丢弃未应用的待定修改",
      style: { fontSize: "12px", padding: "2px 10px", cursor: "pointer" }
    });
    refs.chRevert.addEventListener("click", onRevertChar);
    refs.chClear = h("button", {
      text: "清除表征", title: "删除整个 characterization 块（可撤销）",
      style: { fontSize: "12px", padding: "2px 10px", cursor: "pointer" }
    });
    refs.chClear.addEventListener("click", onClearChar);
    charBtns.appendChild(refs.chApply);
    charBtns.appendChild(refs.chRevert);
    charBtns.appendChild(refs.chClear);
    charWrap.appendChild(charBtns);

    panel.appendChild(info);
    panel.appendChild(hint);
    // R04：图表部件局部样式（选中 chart 且点击了系列/图例/轴标题/峰标注）
    refs.partTitle = sectionTitle("图表部件局部样式");
    refs.partTitle.style.display = "none";
    refs.partWrap = h("div", {
      "data-props-section": "chart-part",
      style: { padding: "0 8px 8px", display: "none" }
    });
    panel.appendChild(refs.partTitle);
    panel.appendChild(refs.partWrap);

    // R06：多子图协同（文档含 ≥2 个数据图表时显示）
    refs.multiTitle = sectionTitle("多子图协同");
    refs.multiTitle.style.display = "none";
    refs.multiWrap = h("div", {
      "data-props-section": "multi-panel",
      style: { padding: "0 8px 8px", display: "none" }
    });
    var unifyBtn = h("button", {
      text: "统一实验组颜色",
      title: "按稳定语义键把同一实验组在各子图统一为同一颜色；一笔提交、可撤销；" +
        "色板不足会提示补色，不静默合并不同组",
      style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer" }
    });
    unifyBtn.addEventListener("click", function () {
      var App = app();
      if (!global.FigOps || typeof FigOps.unifySeriesColors !== "function") {
        if (global.Ui && Ui.toast) Ui.toast("内核缺少 unifySeriesColors", { type: "error" });
        return;
      }
      var res;
      try { res = FigOps.unifySeriesColors(App.doc, {}); }
      catch (err) {
        if (global.Ui && Ui.toast) Ui.toast("统一颜色失败：" + err.message, { type: "error" });
        return;
      }
      (res.warnings || []).forEach(function (w) {
        if (global.Ui && Ui.toast) Ui.toast(w, { type: "info" });
      });
      if (!res.ops.length) {
        if (global.Ui && Ui.toast) Ui.toast("没有可统一的数据图表", { type: "info" });
        return;
      }
      commit(res.ops, "R06 统一实验组颜色");
    });
    refs.multiWrap.appendChild(unifyBtn);
    refs.multiWrap.appendChild(h("div", {
      text: "统一实验组颜色＝同一语义键（分组列+组值/曲线角色+列）在各子图同色；" +
        "显式提交一笔历史，可撤销。共享坐标范围与共享图例暂未提供自动化，" +
        "可用期刊预设统一尺寸后在各子图分别设置。",
      style: { fontSize: "11px", color: "#666", margin: "4px 0 0" }
    }));
    panel.appendChild(refs.multiTitle);
    panel.appendChild(refs.multiWrap);
    // R03：未选中时的下一步指引（info 区在 render 中按文档状态更新）
    refs.geoSection = h("div", {}, [
      sectionTitle("位置与尺寸"),
      geo
    ]);
    panel.appendChild(refs.geoSection);
    panel.appendChild(sectionTitle("填充与描边"));
    panel.appendChild(look);
    panel.appendChild(look2);
    panel.appendChild(dashWrap);
    // R03：文本属性只对包含 text 元素的选择显示
    refs.textSection = h("div", { "data-props-section": "text" }, [
      sectionTitle("文本"),
      text,
      text2
    ]);
    panel.appendChild(refs.textSection);
    panel.appendChild(charTitle);
    panel.appendChild(charWrap);

    refs.relTitle = sectionTitle("科学关系");
    refs.relWrap = h("div", { style: { padding: "0 8px 8px", display: "none" } });
    refs.relTitle.style.display = "none";
    refs.relWrap.appendChild(relationSelect("起点", "relSource", onRelationSemanticChange));
    refs.relWrap.appendChild(relationSelect("终点", "relTarget", onRelationSemanticChange));
    refs.relWrap.appendChild(relationSelect("类型", "relKind", onRelationSemanticChange));
    ["activate", "inhibit", "include", "associate", "sequence"].forEach(function (kind) {
      refs.relKind.appendChild(h("option", { value: kind, text: kind }));
    });
    refs.relWrap.appendChild(relationSelect("方向", "relDirection", onRelationSemanticChange));
    ["forward", "reverse", "both", "none"].forEach(function (direction) {
      refs.relDirection.appendChild(h("option", { value: direction, text: direction }));
    });
    refs.relApply = refs.relDirection;
    refs.relWrap.appendChild(h("div", { text: "激活/顺序=箭头，抑制=T，包含=原生分组，并列=无向线；apply_schematic 可撤销，保留节点文本与手动布局。",
      style: { fontSize: "11px", color: "#765414" } }));
    panel.appendChild(refs.relTitle);
    panel.appendChild(refs.relWrap);
  }

  function swatchButton(hex, onpick) {
    return h("button", {
      title: hex,
      "aria-label": "使用颜色 " + hex,
      style: {
        width: "14px", height: "14px", borderRadius: "2px", cursor: "pointer",
        border: "1px solid #999", background: hex, padding: "0", flex: "none"
      },
      onclick: onpick
    });
  }

  function renderSwatches() {
    ["fillNone", "strokeNone"].forEach(function (noneKey) {
      var wrap = refs[noneKey + "Swatches"];
      if (!wrap) return;
      while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
      recentColors().forEach(function (hex) {
        wrap.appendChild(swatchButton(hex, function () {
          refs[noneKey === "fillNone" ? "fillColor" : "strokeColor"].value = hex;
          if (noneKey === "fillNone") onFill(); else onStroke();
        }));
      });
    });
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  function render() {
    if (!panelEl) return;
    var App = app();
    var F = figdoc();
    var doc = App.doc;
    var ids = effectiveIds();
    var els = elementsOf(ids);
    var single = ids.length === 1;
    var noSel = !ids.length;

    refs.info.textContent = noSel
      ? "未选中元素"
      : (single
        ? "已选 1 个：" + (els[0].name || els[0].type) + "（" + els[0].id + "）"
        : "已选 " + ids.length + " 个元素");

    // R03：上下文属性——未选中给下一步指引；选中文本才显示文本段
    var hasText = els.some(function (el) { return el.type === "text"; });
    if (refs.textSection) refs.textSection.style.display = hasText ? "" : "none";
    if (noSel) {
      var empty = !(doc && Array.isArray(doc.elements) && doc.elements.length);
      refs.info.textContent = empty
        ? "空文档：点画布上方任务卡开始，或用左上「导入数据」；AI 面板可直接下指令（先预览后应用）。"
        : "未选中。点击画布元素查看属性；框选多个可批量调整；右键「发送给 AI」可引用区域。";
    }

    var panelRelative = els.some(function (el) {
      return el.style && el.style.panelRelative === true;
    });
    refs.hint.textContent = panelRelative
      ? "所选元素为面板相对坐标：x/y/w/h 为 0–1 比例值"
      : "";

    // Enable / disable all inputs
    panelEl.querySelectorAll("input, select, button").forEach(function (inp) {
      if (inp === refs.fillNone || inp === refs.strokeNone) {
        inp.disabled = noSel;
        return;
      }
      inp.disabled = noSel;
    });

    // Geometry
    if (single) {
      var t = els[0].transform || {};
      setNumInput(refs.x, t.x);
      setNumInput(refs.y, t.y);
      setNumInput(refs.w, t.w);
      setNumInput(refs.h, t.h);
      setNumInput(refs.rot, t.rotation === undefined ? 0 : t.rotation);
    } else if (!noSel) {
      var u = unionBox(els);
      setNumInput(refs.x, u ? u.x : MIXED);
      setNumInput(refs.y, u ? u.y : MIXED);
      setNumInput(refs.w, u ? u.w : MIXED);
      setNumInput(refs.h, u ? u.h : MIXED);
      // rotation lives on transform, not style — compute manually
      var rv = els[0].transform && els[0].transform.rotation !== undefined ? els[0].transform.rotation : 0;
      els.forEach(function (el) {
        var v = el.transform && el.transform.rotation !== undefined ? el.transform.rotation : 0;
        if (v !== rv) rv = MIXED;
      });
      setNumInput(refs.rot, rv);
    }

    // Colors
    var fillV = colorDisplay(els, "fill", fillDefaultFor);
    var strokeV = colorDisplay(els, "stroke", function () { return null; });
    refs.fillNone.checked = false;
    refs.fillNone.indeterminate = false;
    if (!isMixed(fillV) && fillV === null) refs.fillNone.checked = true;
    refs.fillColor.disabled = noSel || (!isMixed(fillV) && fillV === null);
    refs.fillColor.value = (!isMixed(fillV) && fillV && validHex(fillV)) ? hex6(fillV) : "#000000";
    if (isMixed(fillV)) { refs.fillColor.style.opacity = "0.4"; } else { refs.fillColor.style.opacity = "1"; }

    refs.strokeNone.checked = false;
    refs.strokeNone.indeterminate = false;
    if (!isMixed(strokeV) && strokeV === null) refs.strokeNone.checked = true;
    refs.strokeColor.disabled = noSel || (!isMixed(strokeV) && strokeV === null);
    refs.strokeColor.value = (!isMixed(strokeV) && strokeV && validHex(strokeV)) ? hex6(strokeV) : "#000000";
    refs.strokeColor.style.opacity = isMixed(strokeV) ? "0.4" : "1";

    // Mixed color: show a visible hint via title
    refs.fillColor.title = isMixed(fillV) ? "混合（多种填充色）" : "填充色";
    refs.strokeColor.title = isMixed(strokeV) ? "混合（多种描边色）" : "描边色";

    // Style numbers
    setNumInput(refs.strokeWidth, styleVal(els, "strokeWidthPt", DEFAULTS.strokeWidthPt));
    setNumInput(refs.opacity, styleVal(els, "opacity", DEFAULTS.opacity));
    setTextInput(refs.dash, styleVal(els, "dash", null));
    setNumInput(refs.fontSize, styleVal(els, "fontSizePt", DEFAULTS.fontSizePt));
    setNumInput(refs.lineHeight, styleVal(els, "lineHeight", DEFAULTS.lineHeight));

    // Style selects / checkbox
    setSelect(refs.font, styleVal(els, "fontFamily", DEFAULTS.fontFamily));
    setSelect(refs.weight, styleVal(els, "fontWeight", DEFAULTS.fontWeight));
    setSelect(refs.alignH, styleVal(els, "textAlign", DEFAULTS.textAlign));
    setSelect(refs.alignV, styleVal(els, "verticalAlign", DEFAULTS.verticalAlign));
    setCheckbox(refs.italic, styleVal(els, "fontStyle", DEFAULTS.fontStyle) === "italic");

    // Only rebuild swatches when the recent list may have changed
    var key = recentColors().join(",");
    if (key !== lastIdsKey) {
      lastIdsKey = key;
      renderSwatches();
    }

    // Characterization section (single chart selection only)
    renderCharSection(els, single);
    renderPartSection(els, single); // R04 图表部件局部样式
    renderMultiSection(); // R06 多子图协同
    renderRelationSection(els, single);
  }

  // ------------------------------------------------------------------
  // Mount
  // ------------------------------------------------------------------

  function mount(p) {
    if (!p || p.nodeType !== 1) {
      throw new Error("Props.mount 需要一个面板 DOM 元素");
    }
    var App = app();
    unsubs.forEach(function (u) { u(); });
    unsubs = [];

    panelEl = p;
    buildUI(panelEl);

    unsubs.push(App.on("doc:changed", render));
    unsubs.push(App.on("selection:changed", render));
    // R04：部件引用变化（点击图表内部系列/图例/轴标题/峰标注）也刷新
    unsubs.push(App.on("ui:changed", function () { render(); }));
    render();
  }

  global.Props = { mount: mount, render: render };
})(globalThis);
