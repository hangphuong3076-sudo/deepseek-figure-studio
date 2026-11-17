/* =====================================================================
 * style-gallery.js — 图表风格库画廊（R5）
 *
 * 打开入口：工具栏「风格」按钮、属性面板「图表外观 → 换个风格…」。
 * 数据源：FigPresets.styles()（内置 14 风格）+ GET /api/prefs 的
 * custom_styles（我的风格，id 为 my-*）。套用走 apply_chart_style op，
 * 一次 App.commit = 一条历史；内置风格用 style_id，自定义风格用内联
 * style tokens（styleRef.id 取 token.id）。
 * 默认风格：prefs.default_style_id；UI 创建路径经
 * StyleGallery.defaultStyleOps(ids) 追加同一笔 commit 的 op。
 * AI/MCP 创建的图表不自动套用。
 * ===================================================================== */
(function (global) {
  "use strict";

  var g = global;
  function has(n) { return typeof g[n] !== "undefined"; }
  function h(tag, attrs, children) { return g.Ui.h(tag, attrs, children); }
  function esc(s) { return String(s == null ? "" : s); }

  // ------------------------------------------------------------ prefs API

  var prefsCache = { default_style_id: null, custom_styles: [] };
  var prefsReady = false;

  function apiGet(path) {
    return fetch(path, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); });
  }
  function apiPost(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function refreshPrefs() {
    return apiGet("/api/prefs").then(function (res) {
      if (res && res.ok && res.prefs) {
        prefsCache = {
          default_style_id: res.prefs.default_style_id || null,
          custom_styles: Array.isArray(res.prefs.custom_styles) ? res.prefs.custom_styles : []
        };
      }
      prefsReady = true;
      return prefsCache;
    }).catch(function () { prefsReady = true; return prefsCache; });
  }

  function savePrefs(patch) {
    return apiPost("/api/prefs", { patch: patch }).then(function (res) {
      if (res && res.ok && res.prefs) {
        prefsCache = {
          default_style_id: res.prefs.default_style_id || null,
          custom_styles: Array.isArray(res.prefs.custom_styles) ? res.prefs.custom_styles : []
        };
      }
      return res;
    });
  }

  // ------------------------------------------------------------ style list

  function builtinStyles() {
    if (has("FigPresets") && typeof FigPresets.styles === "function") {
      try { return FigPresets.styles() || []; } catch (e) { return []; }
    }
    return [];
  }

  // 统一条目：{kind:"builtin"|"custom", id, name, tags, description, tokens}
  function allStyles() {
    var out = builtinStyles().map(function (t) {
      return { kind: "builtin", id: t.id, name: t.name, tags: t.tags || [],
        description: t.description || "", tokens: t };
    });
    (prefsCache.custom_styles || []).forEach(function (t) {
      out.push({ kind: "custom", id: t.id, name: t.name, tags: t.tags || [],
        description: t.description || "", tokens: t });
    });
    return out;
  }

  function styleTokensForId(id) {
    var all = allStyles();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  // apply_chart_style 的 op 片段：内置用 style_id；自定义用内联 tokens
  function styleOpFields(entry) {
    if (!entry) return null;
    if (entry.kind === "builtin") return { style_id: entry.id };
    return { style: entry.tokens };
  }

  // ------------------------------------------------- default style helpers
  // 创建路径（向导/模板/再建一张图/新标签导入）在同一笔 commit 里追加
  // 这些 op；无默认风格或 prefs 未就绪时返回 []。
  function defaultStyleOps(chartIds) {
    // chartIds：id 数组，或单个 targets 说明对象（如 {kind:"type",type:"chart"}）
    var targets = Array.isArray(chartIds) ? chartIds.slice()
      : (chartIds && typeof chartIds === "object" ? [chartIds] : []);
    if (!targets.length) return [];
    var id = prefsCache.default_style_id;
    if (!id || !prefsReady) return [];
    var entry = styleTokensForId(id);
    if (!entry) return [];
    var fields = styleOpFields(entry);
    if (!fields) return [];
    return [{
      op: "apply_chart_style",
      targets: targets,
      style_id: fields.style_id,
      style: fields.style,
      reason: "应用默认图表风格「" + (entry.name || id) + "」"
    }];
  }

  // 扫描一笔 ops 里 add_element 新建的 chart 元素 id，返回默认风格 ops
  // （创建路径统一入口：data-wizard / templates / import 新标签等）
  function defaultStyleOpsForOps(ops) {
    if (!Array.isArray(ops)) return [];
    var ids = [];
    ops.forEach(function (op) {
      if (!op || op.op !== "add_element") return;
      var els = Array.isArray(op.elements) ? op.elements
        : (op.element ? [op.element] : []);
      els.forEach(function (el) {
        if (el && el.type === "chart" && el.id) ids.push(el.id);
      });
    });
    return defaultStyleOps(ids);
  }

  // ------------------------------------------------------------ demo specs

  // 三类预览数据（各 2–3 系列，能体现标记/线型循环）
  function demoData(chartType) {
    var cols, rows;
    if (chartType === "scatter") {
      cols = ["x", "y", "grp"];
      rows = [];
      for (var i = 0; i < 36; i++) {
        var t = i / 35;
        rows.push([+(t * 10).toFixed(2), +(Math.sin(t * 6.28) * 3 + (i % 3)).toFixed(2),
          ["A", "B", "C"][i % 3]]);
      }
      return { columns: cols, rows: rows,
        mapping: { x: "x", y: "y", color: "grp" }, chart_type: "scatter" };
    }
    if (chartType === "bar") {
      cols = ["cat", "v", "grp"];
      rows = [];
      var cats = ["对照", "低剂量", "高剂量", "处理"];
      for (var c = 0; c < cats.length; c++) {
        for (var gI = 0; gI < 3; gI++) {
          rows.push([cats[c], +(10 + c * 4 + gI * 2 + (c * gI) % 3).toFixed(1),
            ["甲", "乙", "丙"][gI]]);
        }
      }
      return { columns: cols, rows: rows,
        mapping: { x: "cat", y: "v", group: "grp" }, chart_type: "bar_grouped" };
    }
    // line：宽表三系列折线（12 点，避免标记拥挤）
    cols = ["x", "a", "b", "c"];
    rows = [];
    for (var j = 0; j < 12; j++) {
      var x = j;
      rows.push([x,
        +(Math.sin(x / 6) * 2 + x * 0.08).toFixed(2),
        +(Math.cos(x / 5) * 1.5 + 4).toFixed(2),
        +(Math.sin(x / 4 + 1) * 2.5 + 2).toFixed(2)]);
    }
    return { columns: cols, rows: rows,
      mapping: { x: "x", y: "a", ys: ["a", "b", "c"] }, chart_type: "line_multi" };
  }

  var demoDocs = {};

  function demoDoc(chartType) {
    if (demoDocs[chartType]) return demoDocs[chartType];
    var d = g.FigDoc.create({ title: "风格预览", width_mm: 120, height_mm: 90 });
    var spec = demoData(chartType);
    var el = g.FigData.makeChartElement(
      { columns: spec.columns, rows: spec.rows },
      { chart_type: spec.chart_type, mapping: spec.mapping });
    d = g.FigOps.applyAll(d, [{ op: "add_element", element: el }], { label: "init" }).doc;
    demoDocs[chartType] = d;
    return d;
  }

  // 选中图预览：克隆 chart 元素进临时文档；>500 行截断（仅预览）
  function selectedChartDoc() {
    var ids = chartIdsInSelection();
    if (!ids.length) return null;
    var doc = g.App.doc;
    var el = null;
    (doc.elements || []).forEach(function (e) {
      if (e.id === ids[0]) el = e;
    });
    if (!el || el.type !== "chart") return null;
    var cp = JSON.parse(JSON.stringify(el));
    var inl = cp.chart && cp.chart.data && cp.chart.data.inline;
    if (inl && Array.isArray(inl.rows) && inl.rows.length > 500) {
      inl.rows = inl.rows.slice(0, 500);
    }
    var d = g.FigDoc.create({ title: "预览", width_mm: 120, height_mm: 90 });
    d.elements = [cp];
    return { doc: d, el: cp };
  }

  // 用真实 apply_chart_style op 生成 SVG（预览与成品同一路径）
  function previewSVG(entry, mode, chartType) {
    try {
      var doc, el;
      if (mode === "selected") {
        var sd = selectedChartDoc();
        if (!sd) return null;
        doc = sd.doc; el = sd.el;
      } else {
        doc = demoDoc(chartType);
        el = doc.elements.filter(function (e) { return e.type === "chart"; })[0];
      }
      var fields = styleOpFields(entry);
      if (!fields) return null;
      var op = { op: "apply_chart_style", targets: [el.id] };
      if (fields.style_id) op.style_id = fields.style_id; else op.style = fields.style;
      var res = g.FigOps.apply(doc, op);
      var chartEl = res.doc.elements.filter(function (e) { return e.id === el.id; })[0] || el;
      var st = chartEl.style || {};
      return g.FigData.renderChartSVG(chartEl.chart, {
        width_mm: 62, height_mm: 42, dpi: 110,
        fontFamily: st.fontFamily, fontSizePt: st.fontSizePt
      });
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------ chart ids

  function chartIdsInSelection() {
    if (!has("App") || typeof App.selection !== "function") return [];
    var sel = App.selection() || [];
    var doc = App.doc;
    if (!doc) return [];
    var out = [];
    sel.forEach(function (id) {
      var el = (doc.elements || []).filter(function (e) { return e.id === id; })[0];
      if (el && el.type === "chart") out.push(id);
    });
    return out;
  }
  function allChartIds() {
    var doc = g.App && g.App.doc;
    if (!doc) return [];
    return (doc.elements || []).filter(function (e) { return e.type === "chart"; })
      .map(function (e) { return e.id; });
  }

  // ------------------------------------------------------- tokens extract

  function tokensFromChart(el) {
    var chart = (el && el.chart) || {};
    var pres = (chart.presentation && typeof chart.presentation === "object") ? chart.presentation : {};
    var plot = (pres.plot && typeof pres.plot === "object") ? pres.plot : {};
    var leg = (pres.legend && typeof pres.legend === "object") ? pres.legend : {};
    var axesPres = (pres.axes && typeof pres.axes === "object") ? pres.axes : {};
    var axX = axesPres.x || {}, axY = axesPres.y || {};
    var st = el.style || {};
    var axes = chart.axes || {};
    function clean(o) {
      var r = {};
      Object.keys(o || {}).forEach(function (k) {
        if (o[k] !== undefined) r[k] = o[k];
      });
      return Object.keys(r).length ? r : undefined;
    }
    var t = {
      font: clean({
        family: st.fontFamily,
        basePt: st.fontSizePt,
        tickPt: axes.tickLabelSizePt,
        titleWeight: axX.title && axX.title.fontWeight,
        tickWeight: axX.tick && axX.tick.fontWeight
      }),
      palette: chart.paletteId || undefined,
      plot: clean({
        frame: plot.frame, tickDirection: plot.tickDirection,
        axisWidthPt: plot.axisWidthPt, tickLengthPt: plot.tickLengthPt,
        lineWidthPt: plot.lineWidthPt, markerSizePt: plot.markerSizePt
      }),
      markers: clean({ cycle: plot.markerCycle, fill: plot.markerFill }),
      dashes: Array.isArray(plot.dashCycle) && plot.dashCycle.length ? plot.dashCycle : undefined,
      legend: clean({ position: leg.position, frame: leg.frame === true ? true : undefined }),
      grid: clean({ show: axes.gridlines === true, color: plot.gridColor }),
      background: plot.background !== undefined ? plot.background : undefined
    };
    return t;
  }

  function slugify(name) {
    // 服务端要求 id 匹配 my-[a-z0-9][a-z0-9-]{0,58}：只取 ASCII 字母数字，
    // 中文名退化为「style-<hash]」保证唯一且合法
    var s = String(name || "my-style");
    var base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "").slice(0, 40);
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    var hash = h.toString(36);
    var slug = (base || "style") + "-" + hash;
    if (slug.length > 56) slug = slug.slice(0, 48) + "-" + hash;
    return "my-" + slug;
  }

  // ------------------------------------------------------------- gallery UI

  var state = {
    mode: "sample",        // sample | selected
    chartType: "line",     // line | scatter | bar
    tag: "",               // "" | tag
    query: "",
    entries: []
  };

  function selectedChartId() {
    var ids = chartIdsInSelection();
    return ids.length ? ids[0] : null;
  }

  function applyStyle(entry, targets, label) {
    var fields = styleOpFields(entry);
    if (!fields || !targets.length) return Promise.resolve(false);
    var op = { op: "apply_chart_style", targets: targets.slice(), reason: label || "套用图表风格" };
    if (fields.style_id) op.style_id = fields.style_id; else op.style = fields.style;
    return Promise.resolve(g.App.commit([op], { label: label || "套用图表风格", source: "user" }))
      .then(function () {
        if (g.Ui && Ui.toast) {
          Ui.toast("已为 " + targets.length + " 张图表套用「" + (entry.name || entry.id) +
            "」；单点颜色覆盖已保留", { type: "ok", ms: 3500 });
        }
        return true;
      });
  }

  function namePrompt(title, initial, onOk) {
    var input = h("input", {
      type: "text", maxlength: "40", value: initial || "",
      style: { width: "100%", fontSize: "13px", boxSizing: "border-box", padding: "4px 6px" }
    });
    var modal = g.Ui.modal({
      title: title,
      body: h("div", {}, [
        h("div", { text: "名称（不超过 40 字）", style: { fontSize: "12px", color: "#666", marginBottom: "4px" } }),
        input
      ]),
      actions: [
        { label: "取消", onClick: function (c) { c.close(); } },
        { label: "确定", primary: true, onClick: function (c) {
          var v = (input.value || "").trim();
          if (!v) { if (g.Ui.toast) Ui.toast("名称不能为空", { type: "info" }); return false; }
          c.close(); onOk(v);
        } }
      ]
    });
    setTimeout(function () { input.focus(); input.select(); }, 30);
    return modal;
  }

  function allTags(entries) {
    var seen = {}, out = [];
    entries.forEach(function (e) {
      (e.tags || []).forEach(function (t) {
        if (!seen[t]) { seen[t] = 1; out.push(t); }
      });
    });
    return out;
  }

  function filteredEntries() {
    var q = state.query.trim().toLowerCase();
    return state.entries.filter(function (e) {
      if (state.tag && (e.tags || []).indexOf(state.tag) < 0) return false;
      if (q) {
        var hay = ((e.name || "") + " " + (e.description || "") + " " + (e.tags || []).join(" ")).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function cardEl(entry, rerender) {
    var card = h("div", { class: "sg-card" + (entry.kind === "custom" ? " sg-custom" : "") });
    var prevWrap = h("div", { class: "sg-preview" });
    var svg = previewSVG(entry, state.mode, state.chartType);
    if (svg) {
      // renderChartSVG 返回 <g> 片段（CSS 像素坐标），需包 <svg viewBox>
      // 才能在 div 里真正渲染：px = mm * dpi / 25.4（与 render.js 同约定）
      var k = 25.4 / 110;
      var pxW = Math.max(1, Math.round(62 / k));
      var pxH = Math.max(1, Math.round(42 / k));
      prevWrap.innerHTML =
        '<svg viewBox="0 0 ' + pxW + ' ' + pxH + '" ' +
        'preserveAspectRatio="xMidYMid meet" ' +
        'style="width:100%;height:100%;display:block">' + svg + '</svg>';
    } else {
      prevWrap.innerHTML = '<div class="sg-preview-empty">预览不可用</div>';
    }
    card.appendChild(prevWrap);

    var badges = [];
    if (prefsCache.default_style_id === entry.id) badges.push(h("span", { class: "sg-badge sg-badge-default", text: "默认" }));
    if (entry.kind === "custom") badges.push(h("span", { class: "sg-badge sg-badge-mine", text: "我的" }));
    var titleRow = h("div", { class: "sg-card-title" }, [
      h("span", { class: "sg-card-name", text: entry.name || entry.id }), badges
    ]);
    card.appendChild(titleRow);
    if ((entry.tags || []).length) {
      card.appendChild(h("div", { class: "sg-card-tags", text: entry.tags.join(" · ") }));
    }
    if (entry.description) {
      card.appendChild(h("div", { class: "sg-card-desc", text: entry.description }));
    }

    var selIds = chartIdsInSelection();
    var allIds = allChartIds();
    var applySel = h("button", {
      class: "sg-btn", text: "套用到选中图表",
      disabled: selIds.length ? null : "",
      title: selIds.length ? "" : "请先在画布上选中一张图表"
    });
    if (!selIds.length) applySel.setAttribute("aria-disabled", "true");
    applySel.addEventListener("click", function () {
      if (!selIds.length) return;
      applyStyle(entry, selIds, "套用图表风格「" + (entry.name || entry.id) + "」").then(function (ok) {
        if (ok) rerender();
      });
    });
    var applyAll = h("button", {
      class: "sg-btn", text: "套用到本画布全部图表",
      disabled: allIds.length ? null : "",
      title: allIds.length ? "" : "当前画布没有图表"
    });
    if (!allIds.length) applyAll.setAttribute("aria-disabled", "true");
    applyAll.addEventListener("click", function () {
      if (!allIds.length) return;
      applyStyle(entry, allIds, "套用图表风格「" + (entry.name || entry.id) + "」").then(function (ok) {
        if (ok) rerender();
      });
    });
    var isDefault = prefsCache.default_style_id === entry.id;
    var defBtn = h("button", {
      class: "sg-btn", text: isDefault ? "取消默认" : "设为默认"
    });
    defBtn.addEventListener("click", function () {
      var patch = { default_style_id: isDefault ? null : entry.id };
      savePrefs(patch).then(function () { rerender(); });
    });
    card.appendChild(h("div", { class: "sg-card-actions" }, [applySel, applyAll, defBtn]));

    if (entry.kind === "custom") {
      var renBtn = h("button", { class: "sg-btn sg-btn-ghost", text: "改名" });
      renBtn.addEventListener("click", function () {
        namePrompt("重命名我的风格", entry.name, function (v) {
          var list = (prefsCache.custom_styles || []).map(function (s) {
            if (s.id === entry.id) { var c = JSON.parse(JSON.stringify(s)); c.name = v; return c; }
            return s;
          });
          savePrefs({ custom_styles: list }).then(function () { rerender(); });
        });
      });
      var delBtn = h("button", { class: "sg-btn sg-btn-danger", text: "删除" });
      delBtn.addEventListener("click", function () {
        g.Ui.confirm("删除我的风格「" + (entry.name || entry.id) + "」？已套用到图表上的样式不受影响。").then(function (ok) {
          if (!ok) return;
          var patch = { custom_styles: (prefsCache.custom_styles || []).filter(function (s) {
            return s.id !== entry.id;
          }) };
          if (prefsCache.default_style_id === entry.id) patch.default_style_id = null;
          savePrefs(patch).then(function () { rerender(); });
        });
      });
      card.appendChild(h("div", { class: "sg-card-actions" }, [renBtn, delBtn]));
    }
    return card;
  }

  function renderGallery(body, rerender) {
    body.textContent = "";
    var entries = allStyles();
    state.entries = entries;

    // 顶部控制区
    var top = h("div", { class: "sg-top" });

    var modeSeg = h("div", { class: "sg-seg", role: "group", "aria-label": "预览数据" });
    [["sample", "示例数据"], ["selected", "用选中的图"]].forEach(function (m) {
      var b = h("button", {
        class: "sg-seg-btn" + (state.mode === m[0] ? " on" : ""), text: m[1]
      });
      b.addEventListener("click", function () {
        if (state.mode === m[0]) return;
        state.mode = m[0]; renderGallery(body, rerender);
      });
      modeSeg.appendChild(b);
    });
    top.appendChild(modeSeg);

    if (state.mode === "sample") {
      var typeSeg = h("div", { class: "sg-seg", role: "group", "aria-label": "图表类型" });
      [["line", "折线"], ["scatter", "散点"], ["bar", "柱状"]].forEach(function (t) {
        var b = h("button", {
          class: "sg-seg-btn" + (state.chartType === t[0] ? " on" : ""), text: t[1]
        });
        b.addEventListener("click", function () {
          if (state.chartType === t[0]) return;
          state.chartType = t[0]; renderGallery(body, rerender);
        });
        typeSeg.appendChild(b);
      });
      top.appendChild(typeSeg);
    } else if (!selectedChartId()) {
      top.appendChild(h("span", { class: "sg-hint-inline", text: "未选中图表：示例数据预览" }));
    }

    var search = h("input", {
      type: "search", placeholder: "搜索风格名称…", value: state.query,
      "aria-label": "搜索风格",
      style: { flex: "1 1 160px", fontSize: "12px", padding: "4px 8px",
        border: "1px solid #C9D1DB", borderRadius: "4px" }
    });
    search.addEventListener("input", function () {
      state.query = search.value; renderGallery(body, rerender);
    });
    top.appendChild(search);
    body.appendChild(top);

    // 标签筛选 chips
    var tags = allTags(entries);
    if (tags.length) {
      var chipRow = h("div", { class: "sg-chips" });
      var allChip = h("button", {
        class: "sg-chip" + (state.tag === "" ? " on" : ""), text: "全部"
      });
      allChip.addEventListener("click", function () { state.tag = ""; renderGallery(body, rerender); });
      chipRow.appendChild(allChip);
      tags.forEach(function (t) {
        var c = h("button", {
          class: "sg-chip" + (state.tag === t ? " on" : ""), text: t
        });
        c.addEventListener("click", function () {
          state.tag = state.tag === t ? "" : t; renderGallery(body, rerender);
        });
        chipRow.appendChild(c);
      });
      body.appendChild(chipRow);
    }

    // 提示行
    body.appendChild(h("div", {
      class: "sg-hint",
      text: "点击卡片上的按钮套用；默认风格会用于向导、模板与导入新建的图表；AI/MCP 创建的图表不会自动套用。"
    }));

    // 我的风格操作条
    var selChart = selectedChartId();
    var saveBar = h("div", { class: "sg-mine-bar" });
    var saveBtn = h("button", {
      class: "sg-btn sg-btn-primary", text: "把选中图表的样式存为我的风格",
      disabled: selChart ? null : "",
      title: selChart ? "" : "请先选中一张图表"
    });
    if (!selChart) saveBtn.setAttribute("aria-disabled", "true");
    saveBtn.addEventListener("click", function () {
      if (!selChart) return;
      var el = (g.App.doc.elements || []).filter(function (e) { return e.id === selChart; })[0];
      if (!el) return;
      var tokens = tokensFromChart(el);
      namePrompt("保存为我的风格", "我的风格", function (v) {
        tokens.id = slugify(v);
        tokens.name = v;
        tokens.tags = [];
        var list = (prefsCache.custom_styles || []).slice();
        if (list.some(function (s) { return s.id === tokens.id; })) {
          if (g.Ui.toast) Ui.toast("同名风格已存在，请换个名称", { type: "info" });
          return;
        }
        list.push(tokens);
        if (list.length > 50) {
          if (g.Ui.toast) Ui.toast("我的风格最多 50 个，请先删除不用的", { type: "info" });
          return;
        }
        savePrefs({ custom_styles: list }).then(function (res) {
          if (res && res.ok && g.Ui.toast) Ui.toast("已保存我的风格「" + v + "」", { type: "ok" });
          renderGallery(body, rerender);
        });
      });
    });
    saveBar.appendChild(saveBtn);
    body.appendChild(saveBar);

    // 卡片网格
    var grid = h("div", { class: "sg-grid" });
    var shown = filteredEntries();
    if (!shown.length) {
      grid.appendChild(h("div", { class: "sg-empty", text: "没有符合条件的风格" }));
    }
    shown.forEach(function (entry) {
      grid.appendChild(cardEl(entry, function () { renderGallery(body, rerender); }));
    });
    body.appendChild(grid);
  }

  // ------------------------------------------------------------- public

  var StyleGallery = {
    open: function (opts) {
      opts = opts || {};
      if (state.mode === "selected" && !chartIdsInSelection().length) {
        state.mode = "sample";
      }
      var bodyEl = h("div", { class: "sg-body" });
      var rerender = function () { renderGallery(bodyEl, rerender); };
      var modal = g.Ui.modal({
        title: "图表风格库",
        className: "style-gallery-modal",
        body: bodyEl,
        actions: [{ label: "关闭", onClick: function (c) { c.close(); } }]
      });
      renderGallery(bodyEl, rerender);
      refreshPrefs().then(function () { renderGallery(bodyEl, rerender); });
      return modal;
    },
    // 供创建路径调用：返回要追加进同一笔 commit 的 apply_chart_style ops
    defaultStyleOps: defaultStyleOps,
    defaultStyleOpsForOps: defaultStyleOpsForOps,
    refreshPrefs: refreshPrefs,
    // 供测试/调试
    _state: state,
    _prefs: function () { return prefsCache; }
  };

  g.StyleGallery = StyleGallery;

  // 启动即拉取 prefs（默认风格要在创建路径同步可用）
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { refreshPrefs(); });
    } else {
      refreshPrefs();
    }
    // 工具栏「风格」按钮
    function bindToolbar() {
      var btn = document.getElementById("btn-style-gallery");
      if (btn && !btn.__sgBound) {
        btn.__sgBound = true;
        btn.addEventListener("click", function () { StyleGallery.open(); });
      }
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bindToolbar);
    } else { bindToolbar(); }
    // main.js 可能晚于本脚本渲染工具栏；兜底轮询一次
    setTimeout(bindToolbar, 500);
    setTimeout(bindToolbar, 2000);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
