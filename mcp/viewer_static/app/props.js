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
    return global.Ui.h(tag, attrs, children);
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
  // 点选样式作用范围：single=只改这一个 / series=同系列全部；跨选中保留。
  var markScope = "single";

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
    [["fit", "拟合"], ["component", "组分"],
     ["baseline", "基线"]].forEach(function (ro) {
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
    if (ref.part === "axis-tick-x" || ref.part === "axis-tick-y") {
      var axx = ref.part === "axis-tick-x" ? "x" : "y";
      return (pres.axes && pres.axes[axx] && pres.axes[axx].tick) || {};
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
    } else if (ref.part === "axis-tick-x" || ref.part === "axis-tick-y") {
      var axx = {}; axx[ref.part === "axis-tick-x" ? "x" : "y"] = { tick: values };
      patch.axes = axx;
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
      ["series", "legend", "axis-title-x", "axis-title-y", "axis-tick-x", "axis-tick-y", "peak"].indexOf(ref.part) >= 0 &&
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
      if (ref.part === "axis-tick-x") return "X 轴刻度文字";
      if (ref.part === "axis-tick-y") return "Y 轴刻度文字";
      if (ref.part === "peak") return "峰标注 " + ref.peakId;
      return "图表部件";
    }

    refs.partWrap.textContent = "";
    refs.partWrap.appendChild(h("div", {
      text: label() + "（只改外观，不改数据）",
      style: { fontSize: "11px", color: "#555", margin: "2px 0 6px" }
    }));

    var inputs = {};
    function numField(key, text, min, max, step) {
      var inp = h("input", { type: "number", min: String(min), max: String(max),
        step: String(step), value: cur[key] != null ? String(cur[key]) : "",
        placeholder: "默认", "aria-label": text,
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
          value: v, text: v === "" ? "默认" : (({none:"不显示",right:"右侧",top:"上方",bottom:"下方"})[v] || v)
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
    } else if (ref.part === "axis-title-x" || ref.part === "axis-title-y" ||
               ref.part === "axis-tick-x" || ref.part === "axis-tick-y") {
      rows.push(numField("fontSizePt", "字号", 1, 200, 0.5));
      rows.push(colorField("color", "颜色"));
      if (ref.part === "axis-title-x" || ref.part === "axis-title-y") {
        var bold = h("input", { type: "checkbox" });
        bold.checked = cur.fontWeight === "bold";
        inputs.fontWeight = bold;
        rows.push(h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
          fontSize: "12px" } }, [bold, h("span", { text: "加粗" })]));
      }
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
      text: "应用",
      title: "只改这一部分的外观，可撤销",
      style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer", marginRight: "6px" }
    });
    applyBtn.addEventListener("click", function () {
      var values = collectValues(false);
      if (!values || !Object.keys(values).length) {
        if (global.Ui && Ui.toast) Ui.toast("没有可应用的修改（空输入表示用默认）", { type: "info" });
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
      text: "恢复默认",
      title: "去掉单独设置，回到默认外观",
      style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer" }
    });
    resetBtn.addEventListener("click", function () {
      var patch = buildPresentationPatch(ref, null);
      commit([{
        op: "set_chart_properties", targets: [el.id],
        properties: { presentation: patch },
        reason: "恢复默认：" + label()
      }], "恢复部件默认：" + label());
    });
    refs.partWrap.appendChild(applyBtn);
    refs.partWrap.appendChild(resetBtn);
  }

  // ------------------------------------------------------------------
  // H1：图内单个数据点 / 柱子的样式编辑（chartPart.part = point|bar）
  //
  // 每个控件 change 即提交一笔 set_chart_properties（presentation 覆盖），
  // 可撤销；作用范围 single→points[键]、series→series[系列键]。
  // ------------------------------------------------------------------

  function markPalette(chart) {
    var id = chart && chart.paletteId;
    try { if (id && global.FigPalette) return FigPalette.colors(id).slice(0, 8); } catch (e) { /* fallthrough */ }
    try { if (global.FigPalette) return FigPalette.colors("npg").slice(0, 8); } catch (e) { /* fallthrough */ }
    return ["#3C5488", "#E64B35", "#00A087", "#4DBBD5", "#F39B7F", "#8491B4", "#91D1C2", "#DC0000"];
  }

  // 当前选中标记的实际渲染值（fill / data-size-pt / data-marker / fill-opacity）。
  // compact 点没有独立 DOM 节点：经 FigData.effectiveMarkStyle 按同一套
  // 默认←plot←series←points 规则取有效样式（defFill 用系列调色板色）。
  function markNodeStyle(el, ref) {
    var node = null;
    try {
      node = (global.Editor && typeof Editor.chartPartNode === "function")
        ? Editor.chartPartNode() : null;
    } catch (e) { node = null; }
    if (!node && ref && ref.compact && el && el.chart &&
        global.FigData && typeof FigData.effectiveMarkStyle === "function") {
      var chart = el.chart;
      var idx = 0;
      try {
        var ident = FigData.seriesIdentity(chart) || [];
        for (var si = 0; si < ident.length; si++) {
          if (ident[si].key === ref.seriesKey) { idx = si; break; }
        }
      } catch (e) { /* keep 0 */ }
      var pal = [];
      try {
        var pid = chart.paletteId;
        if (pid && global.FigPalette) pal = FigPalette.colors(pid) || [];
        if (!pal.length && global.FigPalette) pal = FigPalette.colors("npg") || [];
      } catch (e) { pal = []; }
      if (!pal.length) pal = markPalette(chart);
      var ms = FigData.effectiveMarkStyle(chart, {
        kind: "point", seriesKey: ref.seriesKey, pointKey: ref.pointKey,
        defFill: pal.length ? pal[idx % pal.length] : "#3C5488",
        defMarker: "circle", defDiaPt: 4.5,
        defStroke: "#FFFFFF", defStrokeWidthPt: 0.4, defOpacity: 0.85
      });
      return {
        fill: ms.fill,
        sizePt: (typeof ms.sizePt === "number") ? String(ms.sizePt) : null,
        marker: ms.marker,
        opacity: (typeof ms.opacity === "number") ? ms.opacity : null
      };
    }
    function attr(n) { return (node && node.getAttribute) ? node.getAttribute(n) : null; }
    var op = attr("fill-opacity");
    var opN = op === null ? null : parseFloat(op);
    return {
      fill: attr("fill"),
      sizePt: attr("data-size-pt"),
      marker: attr("data-marker"),
      opacity: (opN === null || !isFinite(opN)) ? null : opN
    };
  }

  function fmtCell(v) { return v === null || v === undefined || v === "" ? "—" : String(v); }

  function markDescribePoint(el, ref) {
    var chart = el.chart || {};
    var d = chart.data && chart.data.inline;
    var rowIdx = parseInt(ref.row, 10);
    var seg = "第 ? 行";
    if (isFinite(rowIdx) && d && Array.isArray(d.rows) && d.rows[rowIdx]) {
      var row = d.rows[rowIdx];
      var cols = Array.isArray(d.columns) ? d.columns : [];
      var map = chart.mapping || {};
      var xi = cols.indexOf(map.x), yi = cols.indexOf(map.y);
      seg = "第 " + (rowIdx + 1) + " 行";
      if (map.x) seg += " · " + map.x + "=" + fmtCell(xi >= 0 ? row[xi] : null);
      if (map.y) seg += " · " + map.y + "=" + fmtCell(yi >= 0 ? row[yi] : null);
    }
    var sLabel = null;
    try {
      var ident = (global.FigData && FigData.seriesIdentity(chart)) || [];
      var hit = ident.filter(function (s) { return s.key === ref.seriesKey; })[0];
      if (hit) sLabel = hit.label;
    } catch (e) { /* ignore */ }
    if (sLabel) seg += " · 系列：" + sLabel;
    return seg;
  }

  function markDescribeBar(ref) {
    var p = String(ref.pointKey || "").split("|");
    var cat = p[1] || "";
    var grp = p[2] || "";
    var n = String(ref.row || "").split(",").filter(function (s) { return s !== ""; }).length;
    var s = "类别 " + cat;
    if (grp) s += " · 组 " + grp;
    s += " · 由 " + n + " 行数据求均值";
    return s;
  }

  function renderMarkSection(els, single) {
    if (!refs.markTitle || !refs.markWrap) return;
    var App = app();
    var ref = App.ui && App.ui.chartPart;
    var el = (single && els[0] && els[0].type === "chart") ? els[0] : null;
    // 嵌在 panel/group 里的 chart：点选部件时顶层选中的是容器，
    // 按 chartPart.chartId 解析真正的 chart 元素。
    if (!el && ref && ref.chartId && App.doc) {
      var cand = figdoc().get(App.doc, ref.chartId);
      if (cand && cand.type === "chart") el = cand;
    }
    var ok = !!(el && ref && ref.chartId === el.id && ref.pointKey &&
      (ref.part === "point" || ref.part === "bar"));
    refs.markTitle.style.display = ok ? "" : "none";
    refs.markWrap.style.display = ok ? "" : "none";
    if (!ok) return;
    var chart = el.chart || {};
    var isBar = ref.part === "bar";
    refs.markTitle.textContent = isBar ? "选中的柱子" : "选中的数据点";
    var ns = markNodeStyle(el, ref);
    var pal = markPalette(chart);
    var curFill = (ns.fill && /^#/.test(ns.fill)) ? ns.fill : pal[0];
    var histLabel = markScope === "series" ? "系列样式" : (isBar ? "柱子样式" : "数据点样式");

    refs.markWrap.textContent = "";
    refs.markWrap.appendChild(h("div", {
      text: isBar ? markDescribeBar(ref) : markDescribePoint(el, ref),
      style: { fontSize: "11px", color: "#555", margin: "2px 0 6px" }
    }));

    // D 项：定位到原始数据（只读弹窗，不改文档、不进历史）
    var locateBtn = h("button", {
      text: "定位到原始数据", type: "button",
      title: "在只读数据表中查看这条数据来自图表数据的哪一行",
      style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer",
        margin: "0 0 8px" }
    });
    locateBtn.addEventListener("click", function () {
      var rowList = String(ref.row || "").split(",").map(function (s) {
        var n = parseInt(s, 10); return isFinite(n) && n >= 0 ? n : null;
      }).filter(function (n) { return n !== null; });
      if (!global.DataTable || typeof DataTable.open !== "function") {
        if (global.Ui && Ui.toast) Ui.toast("页面缺少数据表组件，请刷新窗口", { type: "error" });
        return;
      }
      DataTable.open({ chartId: el.id, rows: rowList });
    });
    refs.markWrap.appendChild(locateBtn);

    var canSeries = !!ref.seriesKey;
    var scopeRow = h("div", { style: { display: "flex", gap: "12px", margin: "2px 0 6px",
      fontSize: "12px", alignItems: "center" } });
    [["single", isBar ? "只改这根柱子" : "只改这个点"],
     ["series", "同系列全部"]].forEach(function (pair) {
      var rb = h("input", { type: "radio", name: "mark-scope", value: pair[0] });
      rb.checked = (markScope === pair[0]);
      if (pair[0] === "series" && !canSeries) rb.disabled = true;
      rb.addEventListener("change", function () {
        if (rb.checked) { markScope = pair[0]; render(); }
      });
      scopeRow.appendChild(h("label", { style: { display: "inline-flex", gap: "4px",
        alignItems: "center" } }, [rb, h("span", { text: pair[1] })]));
    });
    refs.markWrap.appendChild(scopeRow);

    function propKeyFor(kind) {
      if (markScope === "series") {
        return kind === "color" ? "stroke" : (kind === "size" ? "markerSizePt" : kind);
      }
      return kind === "color" ? "fill" : (kind === "size" ? "sizePt" : kind);
    }
    function commitProp(kind, val) {
      var pk = propKeyFor(kind);
      var blk = markScope === "series" ? "series" : "points";
      var target = markScope === "series" ? ref.seriesKey : ref.pointKey;
      var inner = {}; inner[pk] = val;
      var holder = {}; holder[target] = inner;
      var pres = { version: 1 }; pres[blk] = holder;
      commit([{ op: "set_chart_properties", targets: [el.id],
        properties: { presentation: pres } }], histLabel);
    }
    function commitReset() {
      var blk = markScope === "series" ? "series" : "points";
      var target = markScope === "series" ? ref.seriesKey : ref.pointKey;
      var holder = {}; holder[target] = null;
      var pres = { version: 1 }; pres[blk] = holder;
      commit([{ op: "set_chart_properties", targets: [el.id],
        properties: { presentation: pres } }], "恢复默认：" + histLabel);
    }
    function rangeToast(what, min, max) {
      if (global.Ui && Ui.toast) Ui.toast(what + " 需在 " + min + "–" + max + " 之间", { type: "info" });
    }

    var rows = [];
    // 颜色：color 输入 + 色块
    (function () {
      var inp = h("input", { type: "color", value: curFill,
        "aria-label": "颜色", style: { width: "34px", padding: "0", height: "22px" } });
      inp.addEventListener("change", function () { commitProp("color", inp.value); });
      var sw = h("span", { style: { display: "inline-flex", gap: "2px", alignItems: "center" } });
      pal.forEach(function (hex) {
        sw.appendChild(h("button", {
          title: hex, "aria-label": "用颜色 " + hex,
          style: { width: "13px", height: "13px", borderRadius: "2px", cursor: "pointer",
            border: "1px solid #999", background: hex, padding: "0", flex: "none" },
          onclick: function () { inp.value = hex; commitProp("color", hex); }
        }));
      });
      rows.push(h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
        fontSize: "12px", marginRight: "10px" } }, [
        h("span", { text: "颜色", style: { width: "28px" } }), inp, sw
      ]));
    })();
    if (!isBar) {
      // 大小 pt（仅点）：0.5–40
      (function () {
        var inp = h("input", { type: "number", min: "0.5", max: "40", step: "0.5",
          value: ns.sizePt != null ? String(ns.sizePt) : "",
          placeholder: "默认", "aria-label": "大小",
          style: { width: "58px", fontSize: "12px", boxSizing: "border-box" } });
        inp.addEventListener("change", function () {
          var n = parseNum(inp.value);
          if (n === null) { commitProp("size", null); return; } // 空=恢复默认
          if (n < 0.5 || n > 40) { rangeToast("大小", 0.5, 40); render(); return; }
          commitProp("size", n);
        });
        rows.push(h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
          fontSize: "12px", marginRight: "10px" } }, [
          h("span", { text: "大小", style: { width: "28px" } }), inp, h("span", { text: "pt", style: { fontSize: "11px", color: "#888" } })
        ]));
      })();
      // 形状（仅点）
      (function () {
        var sel = h("select", { "aria-label": "形状",
          style: { fontSize: "12px", maxWidth: "90px" } });
        [["circle", "圆形"], ["square", "方形"], ["triangle", "三角"], ["diamond", "菱形"]]
          .forEach(function (p) { sel.appendChild(h("option", { value: p[0], text: p[1] })); });
        sel.value = ns.marker || "circle";
        sel.addEventListener("change", function () { commitProp("marker", sel.value); });
        rows.push(h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
          fontSize: "12px", marginRight: "10px" } }, [
          h("span", { text: "形状", style: { width: "28px" } }), sel
        ]));
      })();
    }
    // 不透明度：0.05–1
    (function () {
      var inp = h("input", { type: "number", min: "0.05", max: "1", step: "0.05",
        value: ns.opacity != null ? String(ns.opacity) : "",
        placeholder: "默认", "aria-label": "不透明度",
        style: { width: "58px", fontSize: "12px", boxSizing: "border-box" } });
      inp.addEventListener("change", function () {
        var n = parseNum(inp.value);
        if (n === null) { commitProp("opacity", null); return; }
        if (n < 0.05 || n > 1) { rangeToast("不透明度", 0.05, 1); render(); return; }
        commitProp("opacity", n);
      });
      rows.push(h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
        fontSize: "12px", marginRight: "10px" } }, [
        h("span", { text: "不透明", style: { width: "28px" } }), inp
      ]));
    })();

    refs.markWrap.appendChild(h("div", { style: { display: "flex", flexWrap: "wrap",
      gap: "6px", alignItems: "center", marginBottom: "4px" } }, rows));

    var resetBtn = h("button", {
      text: "恢复默认",
      title: "删除该目标的样式覆盖，回到默认渲染",
      style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer" }
    });
    resetBtn.addEventListener("click", commitReset);
    refs.markWrap.appendChild(resetBtn);
  }

  // G21：图表数据分区（选中单个带 inline 数据的 chart 时显示）
  function renderChartDataSection(els, single) {
    if (!refs.dataTitle || !refs.dataWrap) return;
    var el = single && els[0];
    var chart = el && el.type === "chart" ? (el.chart || {}) : null;
    var inline = chart && chart.data && chart.data.inline;
    var hasData = !!(inline && Array.isArray(inline.columns) && Array.isArray(inline.rows));
    refs.dataTitle.style.display = hasData ? "" : "none";
    refs.dataWrap.style.display = hasData ? "" : "none";
    if (!hasData) return;
    var src = (chart.data && chart.data.source_info) || {};
    var fname = src.file_name || src.locator || "未记录";
    refs.dataWrap.textContent = "";
    refs.dataWrap.appendChild(h("div", {
      text: "来源：" + fname + " · " + inline.rows.length + " 行 × " +
        inline.columns.length + " 列",
      style: { fontSize: "12px", margin: "2px 0 6px" }
    }));
    var me = src.manual_edits;
    if (me && me.count > 0 && Array.isArray(me.cells)) {
      refs.dataWrap.appendChild(h("div", {
        text: "导入时手工修改了 " + me.count + " 个单元格",
        style: { fontSize: "12px", color: "#8a5a00", margin: "2px 0" }
      }));
      var det = h("details", { style: { fontSize: "11px", margin: "2px 0 6px" } }, [
        h("summary", { text: "查看修改清单" })
      ]);
      var list = h("div", {});
      me.cells.slice(0, 50).forEach(function (c) {
        list.appendChild(h("div", {
          text: "第 " + (c.row + 1) + " 行 · " + c.column + "：" +
            String(c.from) + " → " + String(c.to)
        }));
      });
      det.appendChild(list);
      refs.dataWrap.appendChild(det);
    }
    var po = src.parse_options;
    if (po && po.number_format && po.number_format !== "plain") {
      refs.dataWrap.appendChild(h("div", {
        text: "数字写法：" + (po.number_format === "comma_decimal" ? "逗号是小数点" : "逗号是千分位"),
        style: { fontSize: "12px", margin: "2px 0 6px" }
      }));
    }
    var btn = h("button", {
      text: "用这份数据再建一张图",
      title: "用同一份数据另建一张图，例如换一种图型；两张图记录同一个数据来源",
      "data-props-reuse-data": "1",
      style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer" }
    });
    btn.addEventListener("click", function () {
      if (global.Import && typeof global.Import.newChartFromChart === "function") {
        global.Import.newChartFromChart(el.id);
      } else if (global.Ui && Ui.toast) {
        Ui.toast("当前环境不支持复用数据", { type: "error" });
      }
    });
    refs.dataWrap.appendChild(btn);
  }

  // 图表外观：presentation.plot + axes.gridlines（选中单个 chart 时显示）
  function renderChartLookSection(els, single) {
    if (!refs.lookTitle || !refs.lookWrap) return;
    var isChart = single && els[0] && els[0].type === "chart";
    refs.lookTitle.style.display = isChart ? "" : "none";
    refs.lookWrap.style.display = isChart ? "" : "none";
    if (!isChart) return;
    var el = els[0];
    var chart = el.chart || {};
    var pres = (chart.presentation && typeof chart.presentation === "object") ? chart.presentation : {};
    var plot = (pres.plot && typeof pres.plot === "object") ? pres.plot : {};
    var gridOn = !!(chart.axes && chart.axes.gridlines === true);

    refs.lookWrap.textContent = "";
    refs.lookWrap.appendChild(h("div", {
      text: "直接点图里的某个点、柱子、图例或坐标轴文字，可以单独改它的样式。",
      style: { fontSize: "11px", color: "#666", margin: "2px 0 6px" }
    }));
    // R5：打开风格库（预览/套用/设为默认）
    var styleBtn = h("button", {
      class: "props-style-btn", text: "换个风格…",
      title: "打开图表风格库"
    });
    styleBtn.addEventListener("click", function () {
      if (global.StyleGallery && typeof StyleGallery.open === "function") {
        StyleGallery.open();
      }
    });
    refs.lookWrap.appendChild(styleBtn);

    // R6：局部放大插图——同数据副本图表（x 范围缩放）+ 母图区间底色 +
    // 分组，三者一个 commit（一次撤销全回退）。数值一律来自用户输入。
    var INSET_TYPES = ["bar", "bar_grouped", "line", "line_multi", "area",
      "scatter", "heatmap", "box"];
    if (INSET_TYPES.indexOf(chart.chartType) >= 0) {
      var insetBtn = h("button", {
        class: "props-style-btn", text: "添加局部放大插图",
        title: "复制本图表并把 x 轴局部区域放大为插图（一次撤销可整体回退）"
      });
      insetBtn.addEventListener("click", function () { openInsetDialog(el, chart); });
      refs.lookWrap.appendChild(insetBtn);
    }

    // x 轴数据域：数值 x（散点必为数值；折线类全数值时）取数据 min/max；
    // 类别 x（柱/箱/热图/折线类非数值）取类别序号域 [0, 类别数-1]；
    // 时间 x 取毫秒时间戳域。无法判定返回 null。
    function chartXDomain(ch) {
      var inline = ch.data && ch.data.inline;
      var cols = (inline && Array.isArray(inline.columns)) ? inline.columns : [];
      var rows = (inline && Array.isArray(inline.rows)) ? inline.rows : [];
      var mapping = ch.mapping || {};
      var xi = cols.indexOf(mapping.x);
      if (xi < 0) return null;
      var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
      var nums = [], catSet = {}, any = false, allNum = true, allTime = true;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!Array.isArray(row)) continue;
        var v = row[xi];
        if (v === null || v === undefined || v === "") continue;
        any = true;
        var t = String(v).trim();
        if (NUM_RE.test(t)) nums.push(Number(t)); else allNum = false;
        if (typeof v !== "string" || isNaN(Date.parse(v))) allTime = false;
        catSet[t] = true;
      }
      if (!any) return null;
      var ctype = ch.chartType;
      var xyType = ctype === "scatter" || ctype === "line" ||
        ctype === "line_multi" || ctype === "area";
      if (xyType && allNum && nums.length) {
        return { min: Math.min.apply(null, nums), max: Math.max.apply(null, nums), numeric: true };
      }
      if (xyType && allTime && !allNum) {
        var tms = [];
        for (i = 0; i < rows.length; i++) {
          var rv = rows[i] && rows[i][xi];
          if (rv === null || rv === undefined || rv === "") continue;
          var dv = Date.parse(String(rv).trim());
          if (!isNaN(dv)) tms.push(dv);
        }
        if (tms.length) {
          return { min: Math.min.apply(null, tms), max: Math.max.apply(null, tms), numeric: true };
        }
      }
      var nCat = Object.keys(catSet).length;
      if (!nCat) return null;
      return { min: 0, max: Math.max(0, nCat - 1), numeric: false };
    }

    function openInsetDialog(targetEl, targetChart) {
      var dom = chartXDomain(targetChart);
      if (!dom) {
        if (global.Ui && Ui.toast) Ui.toast("无法确定该图表的 x 轴范围", { type: "info" });
        return;
      }
      var span = dom.max - dom.min;
      var dLo = span > 0 ? dom.min + span * 0.4 : dom.min - 0.5;
      var dHi = span > 0 ? dom.min + span * 0.6 : dom.max + 0.5;
      var fmtD = function (v) {
        return String(Math.round(v * 10000) / 10000);
      };
      var inMin = h("input", { type: "number", step: "any", value: fmtD(dLo),
        "aria-label": "放大起点 x", style: { width: "110px", fontSize: "12px" } });
      var inMax = h("input", { type: "number", step: "any", value: fmtD(dHi),
        "aria-label": "放大终点 x", style: { width: "110px", fontSize: "12px" } });
      var hint = h("div", { style: { fontSize: "11px", color: "#666", marginTop: "6px" },
        text: "默认取 x 轴范围的中间 20%。插图为同数据副本（40% 尺寸、缩小一档字号、" +
          "无图例与轴标题），母图上该区间加半透明底色标示；两者合成一组，一次撤销全部回退。" +
          (dom.numeric ? "" : "（类别轴按类别序号填写范围）") });
      var body = h("div", {}, [
        h("div", { style: { fontSize: "12px", marginBottom: "8px" } }, [
          h("label", { style: { marginRight: "8px" } },
            [h("span", { text: "起点 x " }), inMin]),
          h("label", {}, [h("span", { text: "终点 x " }), inMax])
        ]),
        hint
      ]);
      function doInset(lo, hi) {
        var t = targetEl.transform || {};
        var pw = typeof t.w === "number" ? t.w : 0;
        var ph = typeof t.h === "number" ? t.h : 0;
        if (!(pw > 0) || !(ph > 0)) {
          if (global.Ui && Ui.toast) Ui.toast("图表尺寸无效，无法创建插图", { type: "info" });
          return false;
        }
        var iw = pw * 0.40, ih = ph * 0.40;
        // 母图绘图区右上内侧（近似：右/上各留 ~7% 边距）
        var ix = Math.max(t.x, Math.min(t.x + pw * 0.93 - iw, t.x + pw - iw));
        var iy = Math.max(t.y, Math.min(t.y + ph * 0.07, t.y + ph - ih));
        var insetChart = JSON.parse(JSON.stringify(targetChart));
        insetChart.axes = Object.assign({}, insetChart.axes || {}, {
          xMin: lo, xMax: hi, xLabel: "", yLabel: ""
        });
        if (insetChart.characterization && typeof insetChart.characterization === "object") {
          insetChart.characterization = Object.assign({}, insetChart.characterization,
            { x_label: "", y_label: "" });
        }
        var ipres = (insetChart.presentation && typeof insetChart.presentation === "object")
          ? JSON.parse(JSON.stringify(insetChart.presentation)) : { version: 1 };
        ipres.legend = Object.assign({}, ipres.legend || {}, { position: "none" });
        insetChart.presentation = ipres;
        var parentPt = (targetEl.style && typeof targetEl.style.fontSizePt === "number" &&
          isFinite(targetEl.style.fontSizePt)) ? targetEl.style.fontSizePt : 7;
        var ist = Object.assign({}, targetEl.style || {},
          { fontSizePt: Math.max(4, parentPt - 1) });
        var insetId = "chart-inset-" + Date.now().toString(36);
        var insetEl = {
          id: insetId, type: "chart",
          transform: { x: r3(ix), y: r3(iy), w: r3(iw), h: r3(ih) },
          chart: insetChart, style: ist,
          parent_id: targetEl.parent_id || null
        };
        // R6-J：插图底衬——不透明白色矩形盖住母图曲线（图表 SVG 背景透明，
        // 直接叠加会透出母图）；组内顺序 母图→底衬→插图。
        var bgId = "shape-insetbg-" + Date.now().toString(36);
        var bgEl = {
          id: bgId, type: "rect",
          transform: { x: r3(ix), y: r3(iy), w: r3(iw), h: r3(ih) },
          style: { fill: "#FFFFFF", stroke: null, strokeWidthPt: 0 },
          parent_id: targetEl.parent_id || null
        };
        var bands = Array.isArray(targetChart.bands) ? targetChart.bands.slice() : [];
        if (bands.length >= 20) {
          if (global.Ui && Ui.toast) {
            Ui.toast("母图 bands 已达上限 20，无法标示放大区域", { type: "info" });
          }
          return false;
        }
        bands.push({ x0: lo, x1: hi, opacity: 0.08 });
        var ops = [
          { op: "add_element", element: bgEl },
          { op: "add_element", element: insetEl },
          { op: "set_chart_properties", targets: [targetEl.id],
            properties: { bands: bands } },
          { op: "group", targets: [targetEl.id, bgId, insetId] }
        ];
        return Promise.resolve(commit(ops, "添加局部放大插图")).then(function (res) {
          return !!(res && res.applied > 0);
        }).catch(function (err) {
          if (global.Ui && Ui.toast) {
            Ui.toast("创建插图失败：" + (err && err.message ? err.message : String(err)), { type: "info" });
          }
          return false;
        });
      }
      if (!(global.Ui && typeof Ui.modal === "function")) {
        if (global.Ui && Ui.toast) Ui.toast("需要 Ui.modal 支持", { type: "info" });
        return;
      }
      Ui.modal({
        title: "添加局部放大插图",
        body: body,
        actions: [
          { label: "取消" },
          { label: "添加", primary: true, onClick: function () {
            var lo = parseNum(inMin.value), hi = parseNum(inMax.value);
            if (lo === null || hi === null) {
              if (global.Ui && Ui.toast) Ui.toast("请输入有效的 x 数值", { type: "info" });
              return false;
            }
            if (!(lo < hi)) {
              if (global.Ui && Ui.toast) Ui.toast("起点 x 必须小于终点 x", { type: "info" });
              return false;
            }
            var ch2 = targetChart.characterization;
            if (ch2 && ch2.x_scale === "log10" && (lo <= 0 || hi <= 0)) {
              if (global.Ui && Ui.toast) Ui.toast("log10 轴的范围必须大于 0", { type: "info" });
              return false;
            }
            return doInset(lo, hi);
          } }
        ]
      });
    }

    function commitPlot(key, val) {
      var inner = {}; inner[key] = val;
      commit([{ op: "set_chart_properties", targets: [el.id],
        properties: { presentation: { version: 1, plot: inner } } }], "图表外观");
    }
    function commitGrid(on) {
      commit([{ op: "set_chart_properties", targets: [el.id],
        properties: { axes: { gridlines: on } } }], "图表外观");
    }
    function selRow(text, aria, options, cur, onpick) {
      var sel = h("select", { "aria-label": aria, style: { fontSize: "12px", maxWidth: "120px" } });
      options.forEach(function (o) { sel.appendChild(h("option", { value: o[0], text: o[1] })); });
      sel.value = cur;
      sel.addEventListener("change", function () { onpick(sel.value); });
      return h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
        fontSize: "12px", marginRight: "10px" } }, [
        h("span", { text: text, style: { width: "52px" } }), sel
      ]);
    }
    function numPlotRow(text, aria, key, min, max, step, dflt) {
      var inp = h("input", { type: "number", min: String(min), max: String(max), step: String(step),
        value: typeof plot[key] === "number" ? String(plot[key]) : "",
        placeholder: String(dflt), "aria-label": aria,
        style: { width: "58px", fontSize: "12px", boxSizing: "border-box" } });
      inp.addEventListener("change", function () {
        var n = parseNum(inp.value);
        if (n === null) { commitPlot(key, null); return; } // 空=恢复默认
        if (n < min || n > max) {
          if (global.Ui && Ui.toast) Ui.toast(text + " 需在 " + min + "–" + max + " 之间", { type: "info" });
          render(); return;
        }
        commitPlot(key, n);
      });
      return h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
        fontSize: "12px", marginRight: "10px" } }, [
        h("span", { text: text, style: { width: "52px" } }), inp, h("span", { text: "pt", style: { fontSize: "11px", color: "#888" } })
      ]);
    }

    var rows = [];
    // R4：未显式设置时渲染默认已是 box/in（effPlot 默认值），
    // 选择器必须显示有效值而非空 patch 的隐含旧默认。
    rows.push(selRow("边框", "边框样式", [["open", "只画左、下两条轴"], ["box", "四边方框"]],
      plot.frame === "open" ? "open" : "box", function (v) { commitPlot("frame", v); }));
    rows.push(selRow("刻度朝向", "刻度朝向", [["out", "朝外"], ["in", "朝内"]],
      plot.tickDirection === "out" ? "out" : "in", function (v) { commitPlot("tickDirection", v); }));
    rows.push(numPlotRow("轴线粗细", "轴线粗细", "axisWidthPt", 0.1, 5, 0.05, 0.75));
    rows.push(numPlotRow("数据点大小", "默认点大小", "markerSizePt", 0.5, 40, 0.5, 4.5));
    rows.push(numPlotRow("线条粗细", "默认线宽", "lineWidthPt", 0.1, 20, 0.1, 1.2));
    var gridCb = h("input", { type: "checkbox", "aria-label": "网格线" });
    gridCb.checked = gridOn;
    gridCb.addEventListener("change", function () { commitGrid(gridCb.checked === true); });
    rows.push(h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center",
      fontSize: "12px", marginRight: "10px" } }, [gridCb, h("span", { text: "网格线" })]));

    refs.lookWrap.appendChild(h("div", { style: { display: "flex", flexWrap: "wrap",
      gap: "6px", alignItems: "center", marginBottom: "4px" } }, rows));

    // R4-HB：双纵轴——系列左/右轴归属 + 右轴标题/范围（仅 line_multi/scatter 且 ≥2 系列）
    var chartType = chart.chartType;
    if (chartType === "line_multi" || chartType === "scatter") {
      var mapping = chart.mapping || {};
      var seriesNames = [];
      var wideYs = Array.isArray(mapping.ys)
        ? mapping.ys.filter(function (n) { return typeof n === "string" && n !== ""; }) : null;
      if (wideYs && wideYs.length >= 2) {
        seriesNames = wideYs.slice();
      } else {
        var inl = chart.data && chart.data.inline;
        var cols = (inl && inl.columns) || [], irows = (inl && inl.rows) || [];
        var gcol = chartType === "line_multi" ? mapping.group : mapping.color;
        var gi = typeof gcol === "string" ? cols.indexOf(gcol) : -1;
        if (gi >= 0) {
          var seenG = {};
          for (var ri = 0; ri < irows.length; ri++) {
            var rv = irows[ri] ? irows[ri][gi] : null;
            if (rv === null || rv === undefined || rv === "") continue;
            var gv = String(rv);
            if (!seenG[gv]) { seenG[gv] = true; seriesNames.push(gv); }
          }
        }
      }
      if (seriesNames.length >= 2) {
        var y2cur = (chart.axes && chart.axes.y2 && typeof chart.axes.y2 === "object")
          ? chart.axes.y2 : null;
        var rightSet = {};
        ((y2cur && y2cur.series) || []).forEach(function (n) { rightSet[n] = true; });
        var anyRight = seriesNames.some(function (n) { return rightSet[n]; });

        function commitY2(next) {
          commit([{ op: "set_chart_properties", targets: [el.id],
            properties: { axes: { y2: next } } }], "纵轴设置");
        }
        function y2Patch(field, val) {
          var base = {
            series: seriesNames.filter(function (n) { return rightSet[n]; }),
            label: y2cur && typeof y2cur.label === "string" ? y2cur.label : null,
            min: y2cur && typeof y2cur.min === "number" ? y2cur.min : null,
            max: y2cur && typeof y2cur.max === "number" ? y2cur.max : null
          };
          base[field] = val;
          return base;
        }
        function toggleAxis(name, toRight) {
          var rights = seriesNames.filter(function (n) {
            return n === name ? toRight : !!rightSet[n];
          });
          if (!rights.length) { commitY2(null); return; }
          var base = y2Patch("series", rights);
          commitY2(base);
        }

        var axisRows = [];
        seriesNames.forEach(function (nm) {
          var isRight = !!rightSet[nm];
          var sel = h("select", { "aria-label": "系列「" + nm + "」纵轴",
            style: { fontSize: "12px", maxWidth: "120px" } });
          sel.appendChild(h("option", { value: "left", text: "左轴" }));
          sel.appendChild(h("option", { value: "right", text: "右轴" }));
          sel.value = isRight ? "right" : "left";
          sel.addEventListener("change", function () { toggleAxis(nm, sel.value === "right"); });
          axisRows.push(h("label", { style: { display: "inline-flex", gap: "4px",
            alignItems: "center", fontSize: "12px", marginRight: "10px" } }, [
            h("span", { text: nm, style: { maxWidth: "90px", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap" } }), sel
          ]));
        });
        refs.lookWrap.appendChild(h("div", { style: { fontSize: "11px", color: "#666",
          margin: "6px 0 2px" } }, [h("span", { text: "系列纵轴（多条曲线可分左右两轴）" })]));
        refs.lookWrap.appendChild(h("div", { style: { display: "flex", flexWrap: "wrap",
          gap: "6px", alignItems: "center", marginBottom: "4px" } }, axisRows));

        if (anyRight) {
          var r2rows = [];
          var lblInp = h("input", { type: "text", maxlength: "60",
            value: (y2cur && typeof y2cur.label === "string") ? y2cur.label : "",
            placeholder: "右轴标题（可空）", "aria-label": "右轴标题",
            style: { width: "130px", fontSize: "12px", boxSizing: "border-box" } });
          lblInp.addEventListener("change", function () {
            var v = lblInp.value.trim();
            commitY2(y2Patch("label", v === "" ? null : v));
          });
          r2rows.push(h("label", { style: { display: "inline-flex", gap: "4px",
            alignItems: "center", fontSize: "12px", marginRight: "10px" } }, [
            h("span", { text: "右轴标题", style: { width: "52px" } }), lblInp
          ]));
          ["min", "max"].forEach(function (mk) {
            var minp = h("input", { type: "number", step: "any",
              value: (y2cur && typeof y2cur[mk] === "number") ? String(y2cur[mk]) : "",
              placeholder: "自动", "aria-label": mk === "min" ? "右轴最小值" : "右轴最大值",
              style: { width: "80px", fontSize: "12px", boxSizing: "border-box" } });
            minp.addEventListener("change", function () {
              var n = minp.value.trim() === "" ? null : parseFloat(minp.value);
              if (n !== null && !isFinite(n)) {
                if (global.Ui && Ui.toast) Ui.toast("请输入数字或留空自动", { type: "info" });
                render(); return;
              }
              commitY2(y2Patch(mk, n));
            });
            r2rows.push(h("label", { style: { display: "inline-flex", gap: "4px",
              alignItems: "center", fontSize: "12px", marginRight: "10px" } }, [
              h("span", { text: mk === "min" ? "最小值" : "最大值", style: { width: "52px" } }),
              minp
            ]));
          });
          refs.lookWrap.appendChild(h("div", { style: { display: "flex", flexWrap: "wrap",
            gap: "6px", alignItems: "center", marginBottom: "4px" } }, r2rows));
        }
      }
    }

    // compact 快速模式提示：画布上合并绘制的标记在半透明重叠处观感与导出不同
    try {
      var host = document.querySelector('#svg-stage [data-fig-id="' + el.id + '"]');
      var cpath = host && host.querySelector("[data-compact-marks]");
      if (cpath) {
        var cop = parseFloat(cpath.getAttribute("opacity"));
        if (!isFinite(cop)) cop = parseFloat(cpath.getAttribute("fill-opacity"));
        if (!isFinite(cop) || cop < 1) {
          refs.lookWrap.appendChild(h("div", {
            text: "点数较多，画布用快速模式显示；半透明重叠处的深浅以导出结果为准。",
            style: { fontSize: "11px", color: "#8a6d00", margin: "4px 0 0" }
          }));
        }
      }
    } catch (e) { /* 提示为可选增强，失败静默 */ }
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

  // ------------------------------------------------------------------
  // R6-K：表征与标注区——坐标范围/隐藏刻度/图例位置/参考卡/区间底色/
  // 渐变配色/组分填充/误差显示/显著性/字母/系列斜线填充。
  // 每项修改 = 一次 set_chart_properties commit（单条历史，可撤销）；
  // 列表项可删除（提交过滤后的整组数组）。
  // ------------------------------------------------------------------

  var SEQ_PALETTES = ["viridis", "plasma", "magma", "blues", "ylgnbu",
    "reds", "purples", "greys"];
  var HATCH_STYLES = [["", "无"], ["/", "斜线 /"], ["\\", "反斜线 \\"],
    ["x", "交叉 x"], [".", "点 ."], ["-", "横线 -"], ["|", "竖线 |"]];
  var LEGEND_POS_OPTS = [
    ["", "默认"], ["right", "右侧"], ["top", "上方"], ["bottom", "下方"],
    ["inside-best", "绘图区内自动"], ["inside-tr", "绘图区右上"],
    ["inside-tl", "绘图区左上"], ["inside-br", "绘图区右下"],
    ["inside-bl", "绘图区左下"], ["inline", "曲线旁"], ["none", "不显示"]
  ];
  // 显著性/字母只对类别型图有意义——与 ops.js validateChartExtrasTargets
  // 的图型白名单一致（bar_stacked 不在内：ops 校验会拒绝）。
  var ANNOT_CAT_TYPES = { bar: 1, bar_grouped: 1, box: 1,
    violin: 1, dotplot: 1 };
  var ANNOT_MAX_CATS = 30;
  // 折叠小节状态：会话内记忆（重渲染不丢，刷新页面还原默认）
  var annotFoldState = {};
  // R7：模板 hints 关闭状态——会话内记忆，不写入文档
  var tplHintsDismissed = {};
  function annotFold(title, key, defOpen) {
    var open = (key in annotFoldState) ? !!annotFoldState[key] : !!defOpen;
    var arrow = h("span", { text: open ? "▾ " : "▸ ",
      style: { display: "inline-block", width: "14px", color: "#789" } });
    var head = h("div", {
      "data-annot-fold": key,
      style: { cursor: "pointer", fontSize: "12px", fontWeight: "700",
        color: "#345", margin: "8px 0 3px", userSelect: "none" }
    }, [arrow, h("span", { text: title })]);
    var body = h("div", { style: { display: open ? "" : "none" } });
    head.addEventListener("click", function () {
      open = !open;
      annotFoldState[key] = open;
      arrow.textContent = open ? "▾ " : "▸ ";
      body.style.display = open ? "" : "none";
    });
    return { node: h("div", {}, [head, body]), body: body };
  }

  function annotEl() {
    var ids = effectiveIds();
    if (ids.length !== 1) return null;
    var el = elementsOf(ids)[0];
    return (el && el.type === "chart") ? el : null;
  }
  function annotCommit(el, properties, label) {
    return commit([{ op: "set_chart_properties", targets: [el.id],
      properties: properties }], label || "表征与标注");
  }
  // 与 lib/data.js stableSeriesKey 同格式
  function annotSeriesKey(prefix, field, value) {
    var t = (value === null || value === undefined) ? "n"
      : (typeof value === "number" ? "n" : "s");
    return prefix + "|" + (field || "") + "|" + t + ":" + String(value);
  }
  function annotPres(chart) {
    var p = chart && chart.presentation;
    return (p && typeof p === "object" && !Array.isArray(p)) ? p : {};
  }
  function annotPlot(chart) {
    var p = annotPres(chart).plot;
    return (p && typeof p === "object") ? p : {};
  }
  function annotLegend(chart) {
    var l = annotPres(chart).legend;
    return (l && typeof l === "object") ? l : {};
  }
  function annotSeries(chart) {
    var s = annotPres(chart).series;
    return (s && typeof s === "object" && !Array.isArray(s)) ? s : {};
  }
  // mapping.x 列的唯一类别值（按出现顺序）
  function annotCategories(chart) {
    var d = chart && chart.data && chart.data.inline;
    var cols = (d && Array.isArray(d.columns)) ? d.columns : [];
    var rows = (d && Array.isArray(d.rows)) ? d.rows : [];
    var xi = cols.indexOf((chart.mapping || {}).x);
    if (xi < 0) return [];
    var seen = {}, out = [];
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i] ? rows[i][xi] : null;
      if (v === null || v === undefined || v === "") continue;
      var s = String(v);
      if (!seen[s]) { seen[s] = 1; out.push(s); }
    }
    return out;
  }
  function annotGroupValues(chart) {
    var d = chart && chart.data && chart.data.inline;
    var cols = (d && Array.isArray(d.columns)) ? d.columns : [];
    var rows = (d && Array.isArray(d.rows)) ? d.rows : [];
    var gi = cols.indexOf((chart.mapping || {}).group);
    if (gi < 0) return [];
    var seen = {}, out = [];
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i] ? rows[i][gi] : null;
      if (v === null || v === undefined || v === "") continue;
      var s = String(v);
      if (!seen[s]) { seen[s] = 1; out.push(s); }
    }
    return out;
  }
  // 斜线填充适用的系列键列表 [{key,label}]
  function annotHatchSeries(chart) {
    var type = chart.chartType, m = chart.mapping || {};
    var out = [];
    if (type === "bar" || type === "box" || type === "area") {
      if (m.y) out.push({ key: annotSeriesKey("series", m.y, m.y), label: m.y });
    } else if (type === "bar_grouped" && m.y && m.group) {
      annotGroupValues(chart).forEach(function (g) {
        out.push({ key: annotSeriesKey("group", m.group, g), label: g });
      });
    }
    return out;
  }
  function annotHasErrorSource(chart) {
    var type = chart.chartType;
    if (type !== "line" && type !== "line_multi") return false;
    var m = chart.mapping || {};
    return typeof m.error === "string" && m.error !== "";
  }
  function annotHasComponent(chart) {
    var ch = chart.characterization;
    if (!ch || !Array.isArray(ch.curves)) return false;
    return ch.curves.some(function (c) { return c && c.role === "component"; });
  }
  function annotRow(label, control) {
    return h("div", {
      style: { display: "flex", alignItems: "center", gap: "6px",
        fontSize: "12px", margin: "3px 0", flexWrap: "wrap" }
    }, [h("span", { text: label, style: { width: "86px", flex: "none", color: "#444" } }), control]);
  }
  function annotNumInput(value, aria, oncommit) {
    var inp = h("input", { type: "number", step: "any", "aria-label": aria,
      value: (value === null || value === undefined) ? "" : String(value),
      style: { width: "72px", fontSize: "12px", boxSizing: "border-box" } });
    inp.addEventListener("change", function () {
      var raw = inp.value.trim();
      var v = raw === "" ? null : Number(raw);
      if (raw !== "" && !isFinite(v)) { inp.value = value == null ? "" : String(value); return; }
      oncommit(v);
    });
    return inp;
  }
  function annotCheck(label, checked, oncommit) {
    var cb = h("input", { type: "checkbox" });
    cb.checked = !!checked;
    cb.addEventListener("change", function () { oncommit(cb.checked); });
    return h("label", {
      style: { display: "inline-flex", alignItems: "center", gap: "4px",
        fontSize: "12px", marginRight: "10px" }
    }, [cb, h("span", { text: label })]);
  }
  function annotSelect(options, value, aria, oncommit) {
    var sel = h("select", { "aria-label": aria, style: { fontSize: "12px", maxWidth: "150px" } });
    options.forEach(function (o) {
      sel.appendChild(h("option", { value: o[0], text: o[1] }));
    });
    sel.value = value == null ? "" : String(value);
    sel.addEventListener("change", function () { oncommit(sel.value); });
    return sel;
  }
  function annotDelBtn(onclick) {
    return h("button", { text: "删除", title: "删除该项（一次提交，可撤销）",
      style: { fontSize: "11px", padding: "0 6px", cursor: "pointer" } });
  }
  function annotListRow(text, ondel) {
    var row = h("div", {
      style: { display: "flex", alignItems: "center", gap: "6px",
        fontSize: "12px", margin: "2px 0" }
    }, [h("span", { text: text, style: { flex: "1", overflow: "hidden",
      textOverflow: "ellipsis", whiteSpace: "nowrap" } })]);
    var btn = annotDelBtn(ondel);
    btn.addEventListener("click", ondel);
    row.appendChild(btn);
    return row;
  }
  function annotSubTitle(text) {
    return h("div", { text: text, style: { fontSize: "11px", fontWeight: "700",
      color: "#345", margin: "7px 0 2px" } });
  }

  function renderAnnotSection(els, single) {
    var el = annotEl();
    var isChart = !!(single && el);
    refs.annotTitle.style.display = isChart ? "" : "none";
    refs.annotWrap.style.display = isChart ? "" : "none";
    if (!isChart) return;
    var chart = el.chart || {};
    var axes = chart.axes || {};
    var pres = annotPres(chart), plot = annotPlot(chart);
    var legend = annotLegend(chart), pseries = annotSeries(chart);
    var sc = plot.seriesColors && typeof plot.seriesColors === "object"
      ? plot.seriesColors : null;
    var wrap = refs.annotWrap;
    wrap.textContent = "";

    // R7：模板 hints——建图后在图表区顶部显示「下一步」提示；
    // 可关闭（会话内记住，不写入文档）。
    try {
      var docMeta = (global.App && global.App.doc && global.App.doc.meta) || {};
      var tplId = docMeta.template_id;
      var tpl = (tplId && global.FigPresets && typeof FigPresets.template === "function")
        ? FigPresets.template(tplId) : null;
      var hints = tpl && Array.isArray(tpl.hints) ? tpl.hints : [];
      if (tplId && hints.length && !tplHintsDismissed[tplId]) {
        var hintItems = hints.map(function (s) {
          return h("li", { text: s, style: { margin: "1px 0" } });
        });
        var hintBox = h("div", {
          "data-template-hints": tplId,
          style: { background: "#f0f6ff", border: "1px solid #c8d9f0",
            borderRadius: "4px", padding: "6px 8px", margin: "0 0 8px",
            fontSize: "12px", color: "#274a77" }
        }, [
          h("div", { style: { fontWeight: "700", marginBottom: "2px",
            display: "flex", justifyContent: "space-between" } }, [
            h("span", { text: "下一步（模板「" + (tpl.name || tplId) + "」）" }),
            h("button", {
              "data-hint-dismiss": "1", text: "关闭",
              style: { border: "none", background: "none", color: "#5b7ba6",
                cursor: "pointer", fontSize: "12px", padding: "0 2px" }
            })
          ]),
          h("ul", { style: { margin: "0", paddingLeft: "16px" } }, hintItems)
        ]);
        hintBox.querySelector("[data-hint-dismiss]").addEventListener("click", function () {
          tplHintsDismissed[tplId] = true;
          hintBox.remove();
        });
        wrap.appendChild(hintBox);
      }
    } catch (e) { /* hints 是增强信息，失败不阻断面板 */ }

    function commitAxes(patch) {
      var ax = {};
      ["xMin", "xMax", "yMin", "yMax"].forEach(function (k) {
        if (patch[k] !== undefined) ax[k] = patch[k];
      });
      annotCommit(el, { axes: ax }, "坐标范围");
    }
    function commitPres(presPatch) {
      annotCommit(el, { presentation: Object.assign({ version: 1 }, presPatch) },
        "表征与标注");
    }
    function commitPlotPatch(patch) {
      commitPres({ plot: patch });
    }

    // R6-3：可折叠小节——「坐标范围与显示」默认展开，其余默认折叠；
    // 折叠状态存 annotFoldState（会话内记忆，重渲染不丢）。
    // 显著性/字母仅类别型图显示：曲线图的 x 列是数值，
    // 旧逻辑会把几十个 x 值误列为「类别」。
    var isCat = !!ANNOT_CAT_TYPES[chart.chartType];
    var cats = isCat ? annotCategories(chart) : [];
    var fRange = annotFold("坐标范围与显示", "range", true);
    var fRef = annotFold("参考线 / 区间底色", "refband", false);
    var fStyle = annotFold("系列样式", "seriesstyle", false);
    var fCat = annotFold("显著性与字母", "sigletter", false);
    wrap.appendChild(fRange.node);
    wrap.appendChild(fRef.node);
    wrap.appendChild(fStyle.node);
    if (isCat) wrap.appendChild(fCat.node);

    // ---- 坐标范围 ----
    fRange.body.appendChild(annotSubTitle("坐标范围（留空=自动）"));
    var rng = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } });
    rng.appendChild(annotRow("X 最小", annotNumInput(axes.xMin, "x 最小值",
      function (v) { commitAxes({ xMin: v }); })));
    rng.appendChild(annotRow("X 最大", annotNumInput(axes.xMax, "x 最大值",
      function (v) { commitAxes({ xMax: v }); })));
    rng.appendChild(annotRow("Y 最小", annotNumInput(axes.yMin, "y 最小值",
      function (v) { commitAxes({ yMin: v }); })));
    rng.appendChild(annotRow("Y 最大", annotNumInput(axes.yMax, "y 最大值",
      function (v) { commitAxes({ yMax: v }); })));
    fRange.body.appendChild(rng);

    // ---- 隐藏刻度 ----
    fRange.body.appendChild(annotSubTitle("刻度显示"));
    var tickRow = h("div", { style: { display: "flex", flexWrap: "wrap" } });
    var paxes = pres.axes && typeof pres.axes === "object" ? pres.axes : {};
    tickRow.appendChild(annotCheck("隐藏 X 刻度",
      !!(paxes.x && paxes.x.tick && paxes.x.tick.hidden === true),
      function (on) {
        commitPres({ axes: { x: { tick: { hidden: on } } } });
      }));
    tickRow.appendChild(annotCheck("隐藏 Y 刻度",
      !!(paxes.y && paxes.y.tick && paxes.y.tick.hidden === true),
      function (on) {
        commitPres({ axes: { y: { tick: { hidden: on } } } });
      }));
    fRange.body.appendChild(tickRow);

    // ---- 图例位置 ----
    fRange.body.appendChild(annotRow("图例位置",
      annotSelect(LEGEND_POS_OPTS, legend.position == null ? "" : legend.position,
        "图例位置", function (v) {
          commitPres({ legend: { position: v === "" ? null : v } });
        })));

    // ---- 参考线 / 标准卡 ----
    fRef.body.appendChild(annotSubTitle("参考线 / 标准卡"));
    var refList = Array.isArray(chart.references) ? chart.references : [];
    refList.forEach(function (r, ri) {
      var st = r && r.style === "lines" ? "虚线" : "竖线条";
      var txt = (r && r.label ? String(r.label) : "（未命名）") +
        " · " + st + " · " + ((r && r.positions) ? r.positions.length : 0) + " 位" +
        (r && r.source ? " · " + String(r.source) : "");
      fRef.body.appendChild(annotListRow(txt, function () {
        var next = refList.filter(function (_, j) { return j !== ri; });
        annotCommit(el, { references: next.length ? next : null }, "删除参考卡");
      }));
    });
    var addRefBtn = h("button", { text: "+ 添加参考卡", title: "添加参考线/标准卡峰位（位置由您填写）",
      style: { fontSize: "11px", padding: "2px 8px", cursor: "pointer", margin: "2px 0" } });
    addRefBtn.addEventListener("click", function () { openRefDialog(el, chart); });
    fRef.body.appendChild(addRefBtn);

    // ---- 区间底色 ----
    fRef.body.appendChild(annotSubTitle("区间底色"));
    var bands = Array.isArray(chart.bands) ? chart.bands : [];
    bands.forEach(function (b, bi) {
      var txt = "[" + (b && b.x0) + ", " + (b && b.x1) + "]" +
        (b && b.label ? " · " + String(b.label) : "");
      fRef.body.appendChild(annotListRow(txt, function () {
        var next = bands.filter(function (_, j) { return j !== bi; });
        annotCommit(el, { bands: next.length ? next : null }, "删除区间底色");
      }));
    });
    var addBandBtn = h("button", { text: "+ 添加区间", title: "添加一段 x 区间底色",
      style: { fontSize: "11px", padding: "2px 8px", cursor: "pointer", margin: "2px 0" } });
    addBandBtn.addEventListener("click", function () { openBandDialog(el, chart); });
    fRef.body.appendChild(addBandBtn);

    // ---- 渐变配色 ----
    fStyle.body.appendChild(annotSubTitle("渐变系列色"));
    var gradOn = !!(sc && sc.mode === "gradient");
    fStyle.body.appendChild(annotCheck("启用渐变配色", gradOn, function (on) {
      var inner = { seriesColors: on
        ? { mode: "gradient", palette: (sc && sc.palette) || "viridis",
            reverse: !!(sc && sc.reverse),
            colorbar: (sc && sc.colorbar) || { show: false } }
        : null };
      commitPlotPatch(inner);
    }));
    if (gradOn) {
      var palOpts = [["", "选择配色…"]].concat(SEQ_PALETTES.map(function (p) {
        return [p, p];
      }));
      fStyle.body.appendChild(annotRow("顺序配色",
        annotSelect(palOpts, sc.palette || "", "顺序配色", function (v) {
          if (!v) return;
          var next = Object.assign({}, sc, { palette: v });
          commitPlotPatch({ seriesColors: next });
        })));
      var cb = (sc.colorbar && typeof sc.colorbar === "object") ? sc.colorbar : {};
      fStyle.body.appendChild(annotCheck("显示色标", cb.show === true, function (on) {
        var next = Object.assign({}, sc,
          { colorbar: Object.assign({}, cb, { show: on }) });
        commitPlotPatch({ seriesColors: next });
      }));
      if (cb.show === true) {
        fStyle.body.appendChild(annotRow("色标标题",
          (function () {
            var inp = h("input", { type: "text", "aria-label": "色标标题",
              value: cb.label || "",
              style: { width: "140px", fontSize: "12px" } });
            inp.addEventListener("change", function () {
              var next = Object.assign({}, sc,
                { colorbar: Object.assign({}, cb, { label: inp.value || null }) });
              commitPlotPatch({ seriesColors: next });
            });
            return inp;
          })()));
      }
    }

    // ---- 组分填充（仅含 component 曲线的表征图）----
    if (annotHasComponent(chart)) {
      fStyle.body.appendChild(annotCheck("组分填充（组分−基线）", plot.componentFill === true,
        function (on) { commitPlotPatch({ componentFill: on }); }));
    }

    // ---- 误差显示（仅有误差来源的折线）----
    if (annotHasErrorSource(chart)) {
      fStyle.body.appendChild(annotRow("误差显示",
        annotSelect([["bars", "误差棒"], ["band", "阴影带"]],
          plot.errorStyle === "band" ? "band" : "bars", "误差显示",
          function (v) { commitPlotPatch({ errorStyle: v }); })));
    }

    // ---- 显著性（仅类别型图；fCat 只在 isCat 时挂载）----
    fCat.body.appendChild(annotSubTitle("显著性标注"));
    var sigs = Array.isArray(chart.significance) ? chart.significance : [];
    sigs.forEach(function (s, si) {
      fCat.body.appendChild(annotListRow(
        String(s && s.a) + " ↔ " + String(s && s.b) + " · " + String(s && s.label),
        function () {
          var next = sigs.filter(function (_, j) { return j !== si; });
          annotCommit(el, { significance: next.length ? next : null }, "删除显著性");
        }));
    });
    // R6-3：类别 >30 时不再列输入/下拉，给提示走 API
    if (cats.length > ANNOT_MAX_CATS) {
      fCat.body.appendChild(h("div", {
        text: "类别超过 " + ANNOT_MAX_CATS + " 个，显著性请用 API 设置",
        style: { fontSize: "11px", color: "#999", margin: "2px 0" } }));
    } else if (cats.length) {
      var addSigBtn = h("button", { text: "+ 添加显著性", title: "在两个类别间添加显著性标注",
        style: { fontSize: "11px", padding: "2px 8px", cursor: "pointer", margin: "2px 0" } });
      addSigBtn.addEventListener("click", function () { openSigDialog(el, chart); });
      fCat.body.appendChild(addSigBtn);
    } else {
      fCat.body.appendChild(h("div", {
        text: "未识别到类别数据（需要内联数据的类别列）",
        style: { fontSize: "11px", color: "#999", margin: "2px 0" } }));
    }

    // ---- 字母标注（每个类别一个；>30 类别只给提示不列输入框）----
    if (cats.length > ANNOT_MAX_CATS) {
      fCat.body.appendChild(annotSubTitle("字母标注"));
      fCat.body.appendChild(h("div", {
        text: "类别超过 " + ANNOT_MAX_CATS + " 个，字母标注请用 API 设置",
        style: { fontSize: "11px", color: "#999", margin: "2px 0" } }));
    } else if (cats.length) {
      fCat.body.appendChild(annotSubTitle("字母标注（每个类别一个）"));
      var letters = (chart.letters && typeof chart.letters === "object" &&
        !Array.isArray(chart.letters)) ? chart.letters : {};
      cats.forEach(function (c) {
        var inp = h("input", { type: "text", "aria-label": "类别 " + c + " 的字母",
          value: letters[c] || "", placeholder: "字母",
          style: { width: "46px", fontSize: "12px", textAlign: "center" } });
        inp.addEventListener("change", function () {
          var next = Object.assign({}, letters);
          var v = inp.value.trim();
          if (v) next[c] = v; else delete next[c];
          annotCommit(el, { letters: Object.keys(next).length ? next : null },
            "字母标注");
        });
        fCat.body.appendChild(annotRow(c, inp));
      });
    }

    // ---- 系列斜线填充 ----
    var hseries = annotHatchSeries(chart);
    if (hseries.length) {
      fStyle.body.appendChild(annotSubTitle("系列斜线填充"));
      hseries.forEach(function (hs) {
        var cur = (pseries[hs.key] && pseries[hs.key].hatch) || "";
        fStyle.body.appendChild(annotRow(hs.label,
          annotSelect(HATCH_STYLES, cur, "斜线填充 " + hs.label, function (v) {
            // 补丁按键深合并：只发 {key:{hatch:v|null}}，缺省键不会被清除；
            // hatch:null 只删斜线子键，保留该系列其它样式（stroke/dash 等）。
            commitPres({ series: (function () {
              var one = {};
              one[hs.key] = { hatch: v || null };
              return one;
            })() });
          })));
      });
    }
  }

  // ---- 表征与标注：添加对话框 ----
  function openRefDialog(el, chart) {
    if (!(global.Ui && typeof Ui.modal === "function")) return;
    var inLabel = h("input", { type: "text", placeholder: "名称（如 JCPDS 21-1272）",
      "aria-label": "参考卡名称", style: { width: "100%", fontSize: "12px" } });
    var inSource = h("input", { type: "text", placeholder: "来源（可选）",
      "aria-label": "参考卡来源", style: { width: "100%", fontSize: "12px" } });
    var inStyle = h("select", { "aria-label": "参考卡样式", style: { fontSize: "12px" } });
    inStyle.appendChild(h("option", { value: "sticks", text: "竖线条带（底部）" }));
    inStyle.appendChild(h("option", { value: "lines", text: "贯穿虚线" }));
    var inPos = h("textarea", { rows: "4", placeholder: "每行一个位置：x  或  x,相对高度(0-1)",
      "aria-label": "参考位置", style: { width: "100%", fontSize: "12px" } });
    var body = h("div", {}, [
      h("div", { style: { fontSize: "12px", marginBottom: "6px" } }, [
        h("label", { style: { display: "block", margin: "3px 0" } },
          [h("span", { text: "名称 ", style: { display: "inline-block", width: "44px" } }), inLabel]),
        h("label", { style: { display: "block", margin: "3px 0" } },
          [h("span", { text: "来源 ", style: { display: "inline-block", width: "44px" } }), inSource]),
        h("label", { style: { display: "block", margin: "3px 0" } },
          [h("span", { text: "样式 ", style: { display: "inline-block", width: "44px" } }), inStyle]),
        h("div", { style: { margin: "4px 0 2px", color: "#666" } }, [h("span", { text: "位置（每行一个 x，可选 ,相对高度）" })]),
        inPos
      ])
    ]);
    Ui.modal({
      title: "添加参考卡 / 参考线",
      body: body,
      actions: [
        { label: "取消" },
        { label: "添加", primary: true, onClick: function () {
          var positions = [], heights = [];
          var lines = String(inPos.value || "").split(/\r?\n/);
          for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim();
            if (!ln) continue;
            var parts = ln.split(",").map(function (s) { return s.trim(); });
            var xv = Number(parts[0]), hv = parts.length > 1 ? Number(parts[1]) : NaN;
            if (!isFinite(xv)) {
              if (global.Ui && Ui.toast) Ui.toast("第 " + (i + 1) + " 行位置不是数字", { type: "info" });
              return false;
            }
            positions.push(xv);
            heights.push(isFinite(hv) ? hv : null);
          }
          if (!positions.length) {
            if (global.Ui && Ui.toast) Ui.toast("请至少填写一个位置", { type: "info" });
            return false;
          }
          var hasH = heights.some(function (v) { return v !== null; });
          var item = {
            label: inLabel.value.trim() || "参考",
            style: inStyle.value === "lines" ? "lines" : "sticks",
            positions: positions
          };
          var src = inSource.value.trim();
          if (src) item.source = src;
          if (hasH) {
            item.heights = heights.map(function (v) { return v === null ? 1 : v; });
          }
          var refList2 = Array.isArray(chart.references) ? chart.references.slice() : [];
          if (refList2.length >= 8) {
            if (global.Ui && Ui.toast) Ui.toast("参考卡最多 8 组", { type: "info" });
            return false;
          }
          refList2.push(item);
          annotCommit(el, { references: refList2 }, "添加参考卡");
          return true;
        } }
      ]
    });
  }

  function openBandDialog(el, chart) {
    if (!(global.Ui && typeof Ui.modal === "function")) return;
    var inX0 = h("input", { type: "number", step: "any", "aria-label": "区间起点",
      style: { width: "90px", fontSize: "12px" } });
    var inX1 = h("input", { type: "number", step: "any", "aria-label": "区间终点",
      style: { width: "90px", fontSize: "12px" } });
    var inColor = h("input", { type: "color", value: "#FFF59D",
      "aria-label": "区间颜色", style: { width: "42px", height: "24px", padding: "0" } });
    var inLabel = h("input", { type: "text", placeholder: "标签（可选）",
      "aria-label": "区间标签", style: { width: "140px", fontSize: "12px" } });
    var body = h("div", {}, [
      h("div", { style: { fontSize: "12px" } }, [
        h("label", { style: { marginRight: "8px" } },
          [h("span", { text: "起点 " }), inX0]),
        h("label", { style: { marginRight: "8px" } },
          [h("span", { text: "终点 " }), inX1]),
        h("label", { style: { marginRight: "8px" } },
          [h("span", { text: "颜色 " }), inColor]),
        h("label", {}, [h("span", { text: "标签 " }), inLabel])
      ])
    ]);
    Ui.modal({
      title: "添加区间底色",
      body: body,
      actions: [
        { label: "取消" },
        { label: "添加", primary: true, onClick: function () {
          var x0 = Number(inX0.value), x1 = Number(inX1.value);
          if (!isFinite(x0) || !isFinite(x1)) {
            if (global.Ui && Ui.toast) Ui.toast("起点/终点须为数字", { type: "info" });
            return false;
          }
          var item = { x0: x0, x1: x1, color: inColor.value, opacity: 0.15 };
          var lb = inLabel.value.trim();
          if (lb) item.label = lb;
          var bands = Array.isArray(chart.bands) ? chart.bands.slice() : [];
          if (bands.length >= 20) {
            if (global.Ui && Ui.toast) Ui.toast("区间底色最多 20 段", { type: "info" });
            return false;
          }
          bands.push(item);
          annotCommit(el, { bands: bands }, "添加区间底色");
          return true;
        } }
      ]
    });
  }

  function openSigDialog(el, chart) {
    if (!(global.Ui && typeof Ui.modal === "function")) return;
    var cats = annotCategories(chart);
    if (!cats.length) {
      if (global.Ui && Ui.toast) Ui.toast("该图表没有可识别的类别", { type: "info" });
      return;
    }
    var mkSel = function (aria) {
      var sel = h("select", { "aria-label": aria, style: { fontSize: "12px", maxWidth: "130px" } });
      cats.forEach(function (c) { sel.appendChild(h("option", { value: c, text: c })); });
      return sel;
    };
    var selA = mkSel("类别 A"), selB = mkSel("类别 B");
    var inLabel = h("input", { type: "text", placeholder: "标注（如 *、**、ns）",
      "aria-label": "显著性标注", style: { width: "120px", fontSize: "12px" } });
    var body = h("div", {}, [
      h("div", { style: { fontSize: "12px" } }, [
        h("label", { style: { marginRight: "8px" } },
          [h("span", { text: "类别 A " }), selA]),
        h("label", { style: { marginRight: "8px" } },
          [h("span", { text: "类别 B " }), selB]),
        h("label", {}, [h("span", { text: "标注 " }), inLabel])
      ])
    ]);
    Ui.modal({
      title: "添加显著性标注",
      body: body,
      actions: [
        { label: "取消" },
        { label: "添加", primary: true, onClick: function () {
          var lb = inLabel.value.trim();
          if (!lb) {
            if (global.Ui && Ui.toast) Ui.toast("请填写标注文本", { type: "info" });
            return false;
          }
          var item = { a: selA.value, b: selB.value, label: lb };
          var sigs = Array.isArray(chart.significance) ? chart.significance.slice() : [];
          if (sigs.length >= 30) {
            if (global.Ui && Ui.toast) Ui.toast("显著性标注最多 30 条", { type: "info" });
            return false;
          }
          sigs.push(item);
          annotCommit(el, { significance: sigs }, "添加显著性");
          return true;
        } }
      ]
    });
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
      text: "以下设置写入图表的表征参数；原始数据列永不修改。",
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
      sel.appendChild(h("option", { value: "linear", text: "线性" }));
      sel.appendChild(h("option", { value: "log10", text: "对数刻度（剔除非正值）" }));
      sel.style.cssText = "max-width:150px;font-size:12px;";
      sel.addEventListener("change", onCharXScale);
      refs.chXScale = sel;
      return sel;
    })()));
    charWrap.appendChild(charRow("归一化", (function () {
      var sel = document.createElement("select");
      sel.appendChild(h("option", { value: "none", text: "不归一" }));
      sel.appendChild(h("option", { value: "max_to_unity", text: "最大值归一" }));
      sel.style.cssText = "max-width:150px;font-size:12px;";
      sel.addEventListener("change", onCharNormalize);
      refs.chNormalize = sel;
      return sel;
    })()));
    charWrap.appendChild(charRow("叠加偏移", (function () {
      var input = h("input", {
        type: "number", step: "any", title: "仅表示视觉位置，不改变数据数值",
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
      text: "曲线声明（拟合 / 组分 / 基线，均来自已导入数值列）",
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
      text: "清除表征", title: "删除全部表征参数（可撤销）",
      style: { fontSize: "12px", padding: "2px 10px", cursor: "pointer" }
    });
    refs.chClear.addEventListener("click", onClearChar);
    charBtns.appendChild(refs.chApply);
    charBtns.appendChild(refs.chRevert);
    charBtns.appendChild(refs.chClear);
    charWrap.appendChild(charBtns);

    panel.appendChild(info);
    panel.appendChild(hint);
    // R8：组图——多选入口 / 组图排版编辑 / 空版式格放入图表
    refs.composeTitle = sectionTitle("组图");
    refs.composeTitle.style.display = "none";
    refs.composeWrap = h("div", {
      "data-props-section": "compose",
      style: { padding: "0 8px 8px", display: "none" }
    });
    panel.appendChild(refs.composeTitle);
    panel.appendChild(refs.composeWrap);
    // R04：图表部件局部样式（选中 chart 且点击了系列/图例/轴标题/峰标注）
    refs.partTitle = sectionTitle("图表部件局部样式");
    refs.partTitle.style.display = "none";
    refs.partWrap = h("div", {
      "data-props-section": "chart-part",
      style: { padding: "0 8px 8px", display: "none" }
    });
    panel.appendChild(refs.partTitle);
    panel.appendChild(refs.partWrap);

    // H1：图内单个数据点/柱子样式（选中 point/bar 时显示，最上方）
    refs.markTitle = sectionTitle("选中的数据点");
    refs.markTitle.style.display = "none";
    refs.markWrap = h("div", {
      "data-props-section": "chart-mark",
      style: { padding: "0 8px 8px", display: "none" }
    });
    panel.appendChild(refs.markTitle);
    panel.appendChild(refs.markWrap);

    // H1：图表外观（选中单个 chart 时显示）
    refs.lookTitle = sectionTitle("图表外观");
    refs.lookTitle.style.display = "none";
    refs.lookWrap = h("div", {
      "data-props-section": "chart-look",
      style: { padding: "0 8px 8px", display: "none" }
    });
    panel.appendChild(refs.lookTitle);
    panel.appendChild(refs.lookWrap);

    // R6-K：表征与标注（选中单个 chart 时显示；每项修改一次 commit 可撤销）
    refs.annotTitle = sectionTitle("表征与标注");
    refs.annotTitle.style.display = "none";
    refs.annotWrap = h("div", {
      "data-props-section": "chart-annot",
      style: { padding: "0 8px 8px", display: "none" }
    });
    panel.appendChild(refs.annotTitle);
    panel.appendChild(refs.annotWrap);

    // G21：图表数据（选中单个带 inline 数据的 chart 时显示）
    refs.dataTitle = sectionTitle("图表数据");
    refs.dataTitle.style.display = "none";
    refs.dataWrap = h("div", {
      "data-props-section": "chart-data",
      style: { padding: "0 8px 8px", display: "none" }
    });
    panel.appendChild(refs.dataTitle);
    panel.appendChild(refs.dataWrap);

    // R06：多子图协同（文档含 ≥2 个数据图表时显示）
    refs.multiTitle = sectionTitle("多子图协同");
    refs.multiTitle.style.display = "none";
    refs.multiWrap = h("div", {
      "data-props-section": "multi-panel",
      style: { padding: "0 8px 8px", display: "none" }
    });
    var unifyBtn = h("button", {
      text: "统一实验组颜色",
      title: "把各子图里同名的实验组统一成同一种颜色；一笔提交、可撤销；" +
        "色板不足会提示补色，不会静默合并不同组",
      style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer" }
    });
    unifyBtn.addEventListener("click", function () {
      var App = app();
      if (!global.FigOps || typeof FigOps.unifySeriesColors !== "function") {
        if (global.Ui && Ui.toast) Ui.toast("当前环境不支持统一颜色", { type: "error" });
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
      commit(res.ops, "统一实验组颜色");
    });
    refs.multiWrap.appendChild(unifyBtn);
    refs.multiWrap.appendChild(h("div", {
      text: "把各子图里同名的实验组统一成同一种颜色（可撤销）。" +
        "统一坐标范围和合并图例暂时需要手动设置。",
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
    [["forward", "正向"], ["reverse", "反向"], ["both", "双向"], ["none", "无"]].forEach(function (dir) {
      refs.relDirection.appendChild(h("option", { value: dir[0], text: dir[1] }));
    });
    refs.relApply = refs.relDirection;
    refs.relWrap.appendChild(h("div", { text: "激活/顺序=箭头，抑制=T，包含=原生分组，并列=无向线；此修改可撤销，保留节点文本与手动布局。",
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

  // R8：组图区——组成组图 / 编辑组图排版 / 解散 / 空格放入图表
  function renderComposeSection(els, ids, single) {
    var show = false;
    if (refs.composeWrap) {
      while (refs.composeWrap.firstChild) refs.composeWrap.removeChild(refs.composeWrap.firstChild);
      var C = global.Compose;
      var hasCompose = !!(C && typeof C.open === "function");
      if (hasCompose && ids.length >= 2) {
        var F = figdoc();
        var d = app() && app().doc;
        var eligIds = ids.filter(function (id) {
          var el = (F && d) ? F.get(d, id) : null;
          return el && typeof C.isSourceEl === "function" && C.isSourceEl(el);
        });
        if (eligIds.length >= 2) {
          show = true;
          var b1 = h("button", {
            text: "组成组图…",
            title: "把选中的图表/图片/组组合成带子图字母的组图（可跨标签页取图）",
            style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer" }
          });
          b1.addEventListener("click", function () { C.open({ ids: eligIds }); });
          refs.composeWrap.appendChild(b1);
        }
      }
      if (hasCompose && single && els[0]) {
        var el = els[0];
        if (typeof C.isComposition === "function" && C.isComposition(el)) {
          show = true;
          var b2 = h("button", {
            text: "编辑组图排版",
            title: "调整版式/行列/间距/子图字母/子图顺序（每次应用一次提交）",
            style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer", marginRight: "6px" }
          });
          b2.addEventListener("click", function () { C.editPanel(el.id); });
          var b3 = h("button", {
            text: "解散组图",
            title: "移除组图外框与子图字母，元素保留在原位（一次提交可撤销）",
            style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer" }
          });
          b3.addEventListener("click", function () { C.dissolve(el.id); });
          refs.composeWrap.appendChild(b2);
          refs.composeWrap.appendChild(b3);
        } else if (typeof C.isEmptyCell === "function" && C.isEmptyCell(el)) {
          show = true;
          var b4 = h("button", {
            text: "放入图表…",
            title: "从当前或其他标签页选择一个图表放入这个空版式格",
            style: { fontSize: "12px", padding: "3px 12px", cursor: "pointer" }
          });
          b4.addEventListener("click", function () { C.placeIntoCell(el.id); });
          refs.composeWrap.appendChild(b4);
        }
      }
    }
    if (refs.composeTitle) refs.composeTitle.style.display = show ? "" : "none";
    if (refs.composeWrap) refs.composeWrap.style.display = show ? "" : "none";
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

    if (single && els[0]) {
      var dispName = els[0].name ||
        (global.FigDoc && typeof global.FigDoc.elementTypeName === "function"
          ? global.FigDoc.elementTypeName(els[0].type) : els[0].type);
      refs.info.textContent = "已选 1 个：" + dispName;
      refs.info.title = els[0].id || "";
    } else {
      refs.info.textContent = ids.length ? ("已选 " + ids.length + " 个元素") : "未选中元素";
      refs.info.title = "";
    }

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
    renderMarkSection(els, single);   // H1 图内单个数据点/柱子样式
    renderPartSection(els, single); // R04 图表部件局部样式
    renderChartLookSection(els, single); // H1 图表外观
    renderAnnotSection(els, single);     // R6 表征与标注
    renderChartDataSection(els, single); // G21 图表数据
    renderMultiSection(); // R06 多子图协同
    renderComposeSection(els, ids, single); // R8 组图
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
