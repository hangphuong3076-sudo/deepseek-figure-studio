/*
 * templates.js — v1 web app module: built-in template gallery + auto recolor.
 *
 * Exposes globalThis.Templates:
 *   Templates.openLibrary()                         browse templates and recolor controls
 *   Templates.apply(templateId, opts?) -> Promise   templateFromStats (validation/warnings)
 *                                                   then App.commit(apply_template)
 *   Templates.recolor(paletteId, opts?) -> Promise  App.commit(recolor, byHue/byOrder/byRole)
 *   Templates.recommend(columnStats, opts?) -> list forwards FigPresets.recommend
 *
 * Contract: v1-web-app/APP-API.md and shared/lib/API.md (frozen v1.0).
 * Depends on: App (app/state.js), FigPresets + FigPalette (lib/). Ui is optional
 * (toast falls back to App.status). No build step, no modules, no CDN.
 *
 * Template cards carry a deterministic structural SVG thumbnail ("示意"
 * schematic, never user data) drawn by app/template-preview.js; that file is
 * loaded on demand if needed (index.html load order stays frozen).
 * The recolor section also visualizes every palette from FigPalette.list()
 * as clickable swatch cards, grouped by category.
 *
 * Note: apply_template carries explicit inline data and generation options to
 * the same templateFromStats path used here for validation and warnings. The
 * kernel rebuilds every panel (clearing elements, keeping canvas and anchors);
 * with no data it creates an explicit unbound skeleton instead of restoring
 * stale chart data.
 */

(function (global) {
  "use strict";

  // ------------------------------------------------------------- state

  var _paletteId = null;
  var _strategy = "byHue";

  var CATEGORIES = { chart: "数据图", characterization: "表征图", mechanism: "机制图",
    flow: "流程图", composite: "组图" };
  var STRATEGIES = ["byHue", "byOrder", "byRole"];
  var STRATEGY_NAMES = {
    byHue: "按色相",
    byOrder: "按出现顺序",
    byRole: "按语义角色"
  };
  var PALETTE_CATEGORY_ORDER = ["journal", "qualitative", "sequential", "diverging", "categorical", "accent"];
  var PALETTE_CATEGORY_NAMES = {
    journal: "期刊配色",
    qualitative: "定性配色 (qualitative)",
    sequential: "顺序配色 (sequential)",
    diverging: "发散配色 (diverging)",
    categorical: "分类/灰度 (categorical)",
    accent: "强调 (accent)"
  };

  // Base URL of this script, used to inject template-preview.js on demand
  // (index.html script order is frozen, so the preview module cannot be a
  // static <script> tag there).
  var _scriptBase = (function () {
    try {
      var s = global.document && global.document.currentScript;
      if (s && s.src) {
        var i = s.src.lastIndexOf("/");
        return i >= 0 ? s.src.slice(0, i + 1) : "";
      }
    } catch (e) { /* embedded without src: previews render as fallback */ }
    return "";
  })();
  var _previewWaiters = null;

  // ------------------------------------------------------------ helpers

  function _fail(msg) {
    throw new Error(msg);
  }

  function _requireApp() {
    if (!global.App || typeof global.App.commit !== "function") {
      _fail("templates.js 需要 app/state.js 的 App 先加载");
    }
  }

  function _requirePresets() {
    if (!global.FigPresets || typeof global.FigPresets.templates !== "function") {
      _fail("模板库未加载");
    }
  }

  function _applicability(templateId) {
    if (!global.FigPresets || typeof global.FigPresets.validateTemplateCapability !== "function") {
      return { ok: false, errors: ["模板能力信息未加载，暂时不能应用"], capability: null };
    }
    try {
      return global.FigPresets.validateTemplateCapability(templateId);
    } catch (e) {
      return { ok: false, errors: ["模板能力校验失败：" + e.message], capability: null };
    }
  }

  function _requirePalette() {
    if (!global.FigPalette || typeof global.FigPalette.list !== "function") {
      _fail("配色库未加载");
    }
  }

  function _toast(text, type) {
    if (global.Ui && typeof global.Ui.toast === "function") {
      global.Ui.toast(text, { type: type || "info" });
    } else if (global.App && typeof global.App.status === "function") {
      global.App.status(text);
    }
  }

  function _appError(text) {
    if (global.App && typeof global.App.error === "function") {
      global.App.error(text);
    } else {
      _fail(text);
    }
  }

  // Minimal DOM builder (plain ES5, textContent only — XSS safe).
  function _h(tag, attrs, children) {
    var el = global.document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "style") el.setAttribute("style", v);
        else if (k === "title") el.setAttribute("title", v);
        else if (k.lastIndexOf("on", 0) === 0 && typeof v === "function") {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else el.setAttribute(k, v);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? global.document.createTextNode(c) : c);
    });
    return el;
  }

  function _clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // Inject app/template-preview.js on demand; done() always runs (with or
  // without previews) so the panel never fails to render.
  function _previewLoaded() {
    var waiters = _previewWaiters || [];
    _previewWaiters = [];
    for (var i = 0; i < waiters.length; i++) {
      try { waiters[i](); } catch (e) { /* keep going */ }
    }
  }

  function _hasPreview() {
    return !!(global.TemplatePreview && typeof global.TemplatePreview.draw === "function");
  }

  function _ensurePreview(done) {
    if (_hasPreview()) { done(); return; }
    if (_previewWaiters) { _previewWaiters.push(done); return; }
    if (!_scriptBase) { done(); return; }
    _previewWaiters = [done];
    var script = global.document.createElement("script");
    script.src = _scriptBase + "template-preview.js";
    script.onload = _previewLoaded;
    script.onerror = _previewLoaded;
    global.document.head.appendChild(script);
  }

  // Accent colors for thumbnails come from the currently selected palette
  // (live FigPalette data, never a hardcoded copy).
  function _previewColors() {
    if (!_paletteId || !global.FigPalette || typeof global.FigPalette.colors !== "function") {
      return null;
    }
    try {
      return global.FigPalette.colors(_paletteId) || null;
    } catch (e) {
      return null;
    }
  }

  function _paletteGroups(palettes) {
    var byCat = {};
    var order = [];
    palettes.forEach(function (p) {
      var cat = p.category || "other";
      if (!byCat[cat]) {
        byCat[cat] = [];
        order.push(cat);
      }
      byCat[cat].push(p);
    });
    order.sort(function (a, b) {
      var ia = PALETTE_CATEGORY_ORDER.indexOf(a); if (ia < 0) ia = PALETTE_CATEGORY_ORDER.length;
      var ib = PALETTE_CATEGORY_ORDER.indexOf(b); if (ib < 0) ib = PALETTE_CATEGORY_ORDER.length;
      if (ia !== ib) return ia - ib;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return order.map(function (cat) {
      return { category: cat, palettes: byCat[cat] };
    });
  }

  function _paletteCatName(cat) {
    return PALETTE_CATEGORY_NAMES[cat] || cat;
  }

  // First inline dataset found in existing chart elements, so that chart
  // templates can be applied after data was imported once.
  function _docInlineData(doc) {
    var els = doc && Array.isArray(doc.elements) ? doc.elements : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var inline = el && el.type === "chart" && el.chart &&
        el.chart.data && el.chart.data.inline;
      if (inline && Array.isArray(inline.columns) && inline.columns.length) {
        return inline;
      }
    }
    return null;
  }

  // ------------------------------------------------------------- public

  function apply(templateId, opts) {
    _requireApp();
    _requirePresets();
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var tpl;
      try {
        tpl = global.FigPresets.template(templateId);
        if (!tpl) _fail("未找到模板：" + templateId);
        var applicability = _applicability(templateId);
        if (!applicability.ok) _fail("模板「" + tpl.name + "」不可应用：" + applicability.errors.join("；"));
        if (!global.App.doc) _fail("当前没有文档，无法应用模板");
        if (tpl.category === "diagram") {
          if (!global.FigDiagram || typeof global.FigDiagram.build !== "function") _fail("示意图功能未加载");
          // R9：优先模板自带 schematic 默认结构（与 apply_template 路径一致）；
          // 模板 schematic 不带 id 时注入模板 id，缺失时才回退合成示例。
          var contract = opts.schematic || tpl.schematic ||
            global.FigDiagram.example(templateId, true);
          contract = JSON.parse(JSON.stringify(contract));
          contract.id = contract.id || templateId;
          contract.template_id = templateId;
          if (opts.canvas_fill != null) {
            var page = global.App.doc.canvas;
            contract.canvas = {width_mm:page.width_mm, height_mm:page.height_mm, dpi:page.dpi, background:page.background};
            contract.layout = Object.assign({}, contract.layout, {page_fill:opts.canvas_fill});
          }
          var schematicWarnings = global.FigDiagram.build(global.App.doc, contract).warnings;
          var committed = global.App.commit([{op:"apply_schematic",contract:contract}],
            {label:"应用可编辑实体关系示意图（合成示例，非论文）："+tpl.name,source:"template"});
          Promise.resolve(committed).then(function(res){
            if(!res||!res.applied)throw new Error("示意图提交未生效");
            var root=(global.App.doc.elements||[]).filter(function(el){return el.diagramId===contract.id&&el.type==="group"&&!el.diagramNodeId;})[0];
            if(root&&typeof global.App.select==="function")global.App.select([root.id]);
            var message="已生成可编辑原生矢量；这是原始参数"+(opts.schematic?"":"合成示例")+"，不是论文或数据自动关联";
            _toast(message+(schematicWarnings.length?"；"+schematicWarnings.join("；"):""),"info");
            resolve({template_id:templateId,applied:res.applied,warnings:schematicWarnings,
              capability:applicability.capability,data_bound:false,root_id:root&&root.id});
          }).catch(reject);
          return;
        }

        var data = opts.data || _docInlineData(global.App.doc);
        var journalId = opts.journal_id ||
          global.App.doc.canvas.journal_preset_id || tpl.journal_default || null;
        var paletteId = opts.palette_id || tpl.palette_default || null;

        var generationOpts = {
          journal_id: journalId,
          palette_id: paletteId,
          canvas: global.App.doc.canvas,
          canvas_fill: opts.canvas_fill,
          title: opts.title || undefined
        };
        // Generate once for user-facing warnings; the op supplies the same
        // explicit inputs to the same kernel path for its actual per-panel edit.
        var built = global.FigPresets.templateFromStats(templateId, data, generationOpts);
        var warnings = built.warnings || [];

        var applyLabel = applicability.capability.status === "layout" ? "应用空白版式：" : "应用模板：";
        var tOps = [{ op: "apply_template", template_id: templateId,
            data: data || null, options: generationOpts }];
        // R5：默认风格追加进同一笔 commit；apply_template 重建元素，
        // 故目标用 {kind:type} 在应用后解析（仅命中新建图表）。
        if (global.StyleGallery && typeof StyleGallery.defaultStyleOps === "function") {
          tOps = tOps.concat(StyleGallery.defaultStyleOps({ kind: "type", type: "chart" }));
        }
        // R7：模板 chart_overrides 在默认风格之后再套（apply_chart_style
        // 是替换式，会重建 legend.position 等风格键；set_chart_properties
        // 补丁保证模板值最终生效）。目标 {kind:type} 只命中新建图表。
        if (global.FigPresets && typeof FigPresets.templateOverrideOps === "function") {
          tOps = tOps.concat(FigPresets.templateOverrideOps(templateId,
            [{ kind: "type", type: "chart" }]));
        }
        var commitRes = global.App.commit(
          tOps,
          { label: applyLabel + tpl.name, source: "template" }
        );

        Promise.resolve(commitRes).then(function (res) {
          if (!res || !res.applied) {
            reject(new Error("模板应用未生效（校验未通过）：" + tpl.name));
            return;
          }
          var msg = applicability.capability.status === "layout"
            ? "已创建空白复合版式「" + tpl.name + "」；未自动填图或绑定数据"
            : "已应用模板「" + tpl.name + "」" +
              (built.data_bound ? "" : "：空占位框，未绑定数据，不算已生成图表");
          msg += warnings.length ? "（" + warnings.length + " 条提示）" : "";
          _toast(msg, warnings.length || !built.data_bound ? "info" : "success");
          if (typeof global.App.status === "function") global.App.status(msg);
          resolve({ template_id: templateId, applied: res.applied, warnings: warnings,
            capability: applicability.capability, data_bound: built.data_bound });
        }, reject);
      } catch (e) {
        _appError(e.message);
        reject(e);
      }
    });
  }

  function recolor(paletteId, opts) {
    _requireApp();
    _requirePresets();
    _requirePalette();
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      try {
        var strategy = opts.strategy || "byHue";
        if (STRATEGIES.indexOf(strategy) < 0) {
          _fail("换色策略无效，请从「按色相 / 按出现顺序 / 按语义角色」中选择，收到：" + strategy);
        }
        var pal = global.FigPalette.get(paletteId);
        if (!pal) _fail("未找到配色：" + paletteId);
        if (!global.App.doc) _fail("当前没有文档，无法换色");

        var commitRes = global.App.commit(
          [{ op: "recolor", palette_id: paletteId, recolor_strategy: strategy }],
          { label: "自动换色：" + pal.name + "（" + STRATEGY_NAMES[strategy] + "）", source: "template" }
        );

        Promise.resolve(commitRes).then(function (res) {
          if (!res || !res.applied) {
            reject(new Error("换色未生效（校验未通过）：" + pal.name));
            return;
          }
          var msg = "已按「" + STRATEGY_NAMES[strategy] + "」应用配色「" + pal.name + "」";
          _toast(msg, "success");
          if (typeof global.App.status === "function") global.App.status(msg);
          resolve({ palette_id: paletteId, strategy: strategy, applied: res.applied });
        }, reject);
      } catch (e) {
        _appError(e.message);
        reject(e);
      }
    });
  }

  function recommend(columnStats, opts) {
    _requirePresets();
    return global.FigPresets.recommend(columnStats, opts || {});
  }

  function _libCategory(t) {
    if (t.category === "composite") return "composite";
    if (t.characterization) return "characterization";
    if (t.category === "diagram") {
      // 架构、层级、模型、对比沿用 diagram_architecture；四阶段图文摘要随流程展示。
      return t.chart_type === "diagram_architecture" ? "mechanism" : "flow";
    }
    return "chart";
  }

  // ------------------------------------------------------- 模板库对话框
  // 大画幅浏览：卡片网格 + 分类筛选 + 搜索 + 仅显示可用 + 详情/应用。

  var _lib = { category: "all", group: "all", query: "", onlyApplicable: false, selected: null };

  function _libCapability(t) {
    var a = _applicability(t.id);
    return {
      ok: !!a.ok,
      capability: a.capability || {
        status: "unsupported", label: "能力未知 · 不可应用", can_apply: false,
        reason: (a.errors || []).join("；")
      },
      errors: a.errors || []
    };
  }

  function _libSearchMatch(t, q) {
    if (!q) return true;
    var hay = [t.name, t.notes, t.recommend_when,
      (t.hints || []).join(" "), t.chart_type,
      (t.default_mapping ? Object.keys(t.default_mapping).join(" ") : "")
    ].join(" ").toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function _libTemplates() {
    var list;
    try {
      _requirePresets();
      list = global.FigPresets.templates();
    } catch (e) {
      return { list: [], error: e.message };
    }
    var q = (_lib.query || "").trim().toLowerCase();
    list = list.filter(function (t) {
      return (_lib.category === "all" || _libCategory(t) === _lib.category) &&
        (_lib.group === "all" || t.group === _lib.group) && _libSearchMatch(t, q);
    });
    if (_lib.onlyApplicable) {
      list = list.filter(function (t) { return _libCapability(t).ok; });
    }
    return { list: list, error: null };
  }

  function _libCard(t, onPick) {
    var cap = _libCapability(t);
    var c = cap.capability;
    var canApply = cap.ok && c.can_apply !== false;
    var inputNeeds = [];
    if (t.default_mapping && typeof t.default_mapping === "object") {
      Object.keys(t.default_mapping).forEach(function (slot) {
        var d = t.default_mapping[slot];
        if (d) inputNeeds.push(String(d));
      });
    }
    var card = _h("div", {
      class: "tl-card" + (canApply ? "" : " tl-card-off"),
      "data-template-id": t.id,
      "data-capability": c.status,
      tabindex: "0",
      role: "button",
      title: t.name + "（" + CATEGORIES[_libCategory(t)] + "）" +
        (canApply ? "" : "；" + (c.reason || "不可应用")),
      onclick: function () { onPick(t); },
      onkeydown: function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onPick(t); }
      }
    });
    var prevHost = _h("div", { class: "tl-preview" });
    prevHost.setAttribute("data-preview-for", t.id);
    card.appendChild(prevHost);
    card.appendChild(_h("div", { class: "tl-card-name", text: t.name }));
    card.appendChild(_h("div", { class: "tl-card-meta", text:
      CATEGORIES[_libCategory(t)] + (c.status === "layout" ? " · 空版式" :
        (canApply ? "" : " · 不可应用")) }));
    if (inputNeeds.length) {
      card.appendChild(_h("div", { class: "tl-card-needs",
        text: "输入：" + inputNeeds.slice(0, 3).join("、") +
          (inputNeeds.length > 3 ? " 等" : ""), title: inputNeeds.join("、") }));
    }
    return card;
  }

  function _libDetail(t, rerender) {
    var cap = _libCapability(t);
    var c = cap.capability;
    var canApply = cap.ok && c.can_apply !== false;
    var wrap = _h("div", { class: "tl-detail" });
    var prevHost = _h("div", { class: "tl-detail-preview" });
    if (_hasPreview()) {
      try {
        var pv = global.TemplatePreview.draw(t, { colors: _previewColors() });
        if (pv) { pv.setAttribute("class", "tl-detail-svg"); prevHost.appendChild(pv); }
      } catch (e) { /* 预览失败不影响详情 */ }
    }
    wrap.appendChild(prevHost);
    wrap.appendChild(_h("div", { class: "tl-detail-name", text: t.name }));
    wrap.appendChild(_h("div", { class: "tl-detail-tags", text:
      [CATEGORIES[_libCategory(t)], t.chart_type ? (global.FigData &&
        typeof global.FigData.chartTypeName === "function" ?
        global.FigData.chartTypeName(t.chart_type) : t.chart_type) : null,
      t.journal_default ? "期刊默认" : null]
        .filter(Boolean).join(" · ") }));
    wrap.appendChild(_h("div", { class: "tl-detail-cap", text:
      "能力：" + c.label + "（" +
      ({ full: "可直接生成", layout: "只创建空版式", unsupported: "暂时不能生成" })[c.status] + "）",
      style: "color:" + (c.status === "full" ? "#166534" :
        (c.status === "layout" ? "#1d4ed8" : "#b91c1c")) + ";" }));
    if (c.reason) wrap.appendChild(_h("div", { class: "tl-detail-reason", text: c.reason }));
    var usage = c.status === "layout"
      ? "只创建空白复合版式，不自动填图；适合先定行列再放图。"
      : (c.status === "unsupported"
        ? "这种图暂时还不能生成，这里只是样式示意。"
        : (t.notes || "按所选数据列生成真实图表。"));
    wrap.appendChild(_h("div", { class: "tl-detail-desc", text: usage }));
    var needs = [];
    if (t.default_mapping && typeof t.default_mapping === "object") {
      Object.keys(t.default_mapping).forEach(function (slot) {
        var d = t.default_mapping[slot];
        if (d) needs.push(slot + "：" + d);
      });
    }
    if (t.category === "diagram") needs = ["实体关系合同（节点/关系/来源，不猜科学内容）"];
    if (needs.length) {
      wrap.appendChild(_h("div", { class: "tl-detail-sec", text: "输入需求" }));
      wrap.appendChild(_h("ul", { class: "tl-detail-list" },
        needs.map(function (n) { return _h("li", { text: n }); })));
    }
    if (Array.isArray(t.hints) && t.hints.length) {
      wrap.appendChild(_h("div", { class: "tl-detail-sec", text: "下一步提示" }));
      wrap.appendChild(_h("ul", { class: "tl-detail-list tl-hints" },
        t.hints.map(function (n) { return _h("li", { text: n }); })));
    }
    var fill = _h("select", { "aria-label": "模板占幅" }, [
      _h("option", { value: "0.8", text: "居中 80%" }),
      _h("option", { value: "1", text: "铺满页面" }),
      _h("option", { value: "", text: "模板默认排版" })
    ]);
    if (canApply) wrap.appendChild(_h("label", {}, ["模板占幅 ", fill]));
    var btns = _h("div", { class: "tl-detail-actions" }, [
      _h("button", {
        type: "button", class: "ui-btn ui-btn-primary", text: "应用此模板",
        disabled: canApply ? null : "disabled",
        title: canApply ? "应用到当前画布（可撤销）" : (c.reason || "不可应用"),
        onclick: function () {
          global.Templates.apply(t.id, {canvas_fill: fill.value ? Number(fill.value) : undefined}).then(function () {
            _toast("已应用模板「" + t.name + "」", "success");
            if (_libModal) _libModal.close();
          }).catch(function () { /* App.error 已提示 */ });
        }
      }),
      _h("button", {
        type: "button", class: "ui-btn", text: "返回列表",
        onclick: function () { _lib.selected = null; rerender(); }
      })
    ]);
    wrap.appendChild(btns);
    return wrap;
  }

  var _libModal = null;
  function openLibrary() {
    _requireApp();
    _requirePresets();
    _ensurePreview(function () {
      var body = _h("div", { class: "tl-body" });
      function rerender() {
        _clear(body);
        renderLib(body, rerender);
      }
      _libModal = global.Ui.modal({
        title: "模板库",
        className: "template-library-modal",
        body: body,
        onClosed: global.App.on("doc:changed", rerender),
        actions: [{ label: "关闭", onClick: function (c) { c.close(); } }]
      });
      rerender();
    });
  }

  function renderLib(body, rerender) {
    // ---- 工具条：搜索 + 分类 + 仅显示可用 ----
    var search = _h("input", {
      type: "search", placeholder: "搜索模板（名称/用途/输入需求）",
      "aria-label": "搜索模板", class: "tl-search", value: _lib.query || ""
    });
    search.addEventListener("input", function () {
      _lib.query = search.value;
      _lib.selected = null;
      rerender();
      var s2 = body.querySelector(".tl-search");
      if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }
    });
    function filterSelect(key, label, className, choices) {
      var sel = _h("select", { "aria-label": label, class: className });
      Object.keys(choices).forEach(function (value) {
        sel.appendChild(_h("option", { value: value, text: choices[value] }));
      });
      sel.value = _lib[key];
      sel.addEventListener("change", function () {
        _lib[key] = sel.value;
        _lib.selected = null;
        rerender();
      });
      return sel;
    }
    var onlyChk = _h("input", { type: "checkbox", "aria-label": "仅显示可用" });
    onlyChk.checked = !!_lib.onlyApplicable;
    onlyChk.addEventListener("change", function () {
      _lib.onlyApplicable = onlyChk.checked;
      _lib.selected = null;
      rerender();
    });
    body.appendChild(_h("div", { class: "tl-toolbar" }, [
      search,
      filterSelect("category", "模板分类", "tl-cat", Object.assign({ all: "全部" }, CATEGORIES)),
      filterSelect("group", "专题筛选", "tl-group", { all: "全部专题", electrochem: "电化学", stats: "统计" }),
      _h("label", { class: "tl-only" }, [onlyChk, " 仅显示可用"])
    ]));

    var res = _libTemplates();
    if (res.error) {
      body.appendChild(_h("div", { class: "tl-empty", text: "预设未加载：" + res.error }));
      return;
    }
    var list = res.list;
    var main = _h("div", { class: "tl-main" + (_lib.selected ? " tl-has-detail" : "") });
    var grid = _h("div", { class: "tl-grid" });
    if (!list.length) {
      grid.appendChild(_h("div", { class: "tl-empty",
        text: "没有匹配的模板" + (_lib.onlyApplicable ? "（已勾选仅显示可用）" : "") }));
    } else {
      Object.keys(CATEGORIES).forEach(function (category) {
        var items = list.filter(function (t) { return _libCategory(t) === category; });
        if (!items.length) return;
        grid.appendChild(_h("h3", { class: "tl-section-title", text: CATEGORIES[category] }));
        items.forEach(function (t) {
          var card = _libCard(t, function (tpl) {
            _lib.selected = tpl;
            rerender();
          });
          if (_lib.selected && _lib.selected.id === t.id) card.classList.add("tl-card-sel");
          grid.appendChild(card);
        });
      });
    }
    main.appendChild(grid);
    if (_lib.selected) {
      var sel = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === _lib.selected.id) { sel = list[i]; break; }
      }
      if (sel) main.appendChild(_libDetail(sel, rerender));
      else _lib.selected = null;
    }
    body.appendChild(main);
    body.appendChild(_renderRecolor(rerender));

    // ---- 分批填充真实渲染缩略图（80 张全量同步渲染太慢）----
    var hosts = grid.querySelectorAll(".tl-preview[data-preview-for]");
    var idx = 0;
    function fillBatch() {
      var end = Math.min(idx + 10, hosts.length);
      for (; idx < end; idx++) {
        var host = hosts[idx];
        var tid = host.getAttribute("data-preview-for");
        var tpl = null;
        for (var j = 0; j < list.length; j++) {
          if (list[j].id === tid) { tpl = list[j]; break; }
        }
        if (!tpl) continue;
        try {
          var node = global.TemplatePreview.draw(tpl, { colors: _previewColors() });
          if (node) host.appendChild(node);
        } catch (e) { /* 单张预览失败不影响网格 */ }
      }
      if (idx < hosts.length) setTimeout(fillBatch, 0);
    }
    if (hosts.length) setTimeout(fillBatch, 0);
  }

  function _renderRecolor(rerender) {
    var box = _h("div", {
      class: "recolor-section",
      style: "border-top:1px solid #ddd;padding-top:8px;" +
        "display:flex;flex-direction:column;gap:6px;"
    });
    box.appendChild(_h("div", {
      text: "自动换色",
      style: "font-weight:bold;font-size:12px;"
    }));

    var palettes = [];
    var palLoadErr = null;
    try {
      _requirePalette();
      palettes = global.FigPalette.list();
    } catch (e) {
      palLoadErr = e;
    }
    var docReady = !!(global.App && global.App.doc);

    var paletteSel = _h("select", {
      class: "recolor-palette",
      style: "font-size:12px;width:100%;",
      onchange: function () {
        _paletteId = this.value || null;
        rerender(); // keep swatch selection highlight + thumbnail colors in sync
      }
    });
    if (palLoadErr || !palettes.length) {
      paletteSel.disabled = true;
      paletteSel.appendChild(_h("option", {
        value: "",
        text: palLoadErr ? "配色未加载" : "无可用配色"
      }));
    } else {
      _paletteGroups(palettes).forEach(function (g) {
        var og = _h("optgroup", { label: _paletteCatName(g.category) });
        g.palettes.forEach(function (p) {
          og.appendChild(_h("option", {
            value: p.id,
            text: p.name + "（" + p.colors.length + " 色）"
          }));
        });
        paletteSel.appendChild(og);
      });
    }
    if (_paletteId) {
      paletteSel.value = _paletteId;
    } else if (paletteSel.options && paletteSel.firstChild && paletteSel.firstChild.value) {
      _paletteId = paletteSel.value = paletteSel.firstChild.value;
    }
    box.appendChild(paletteSel);

    var strategySel = _h("select", {
      class: "recolor-strategy",
      style: "font-size:12px;width:100%;",
      onchange: function () { _strategy = this.value || "byHue"; }
    });
    STRATEGIES.forEach(function (s) {
      strategySel.appendChild(_h("option", { value: s, text: STRATEGY_NAMES[s] }));
    });
    strategySel.value = _strategy;
    box.appendChild(strategySel);

    box.appendChild(_h("button", {
      type: "button",
      text: "换色",
      style: "font-size:12px;padding:3px 0;cursor:pointer;" + (docReady ? "" : "opacity:0.6;"),
      title: "把文档内非中性颜色按所选策略映射到调色板",
      onclick: function () {
        var pid = paletteSel.value;
        global.Templates.recolor(pid, { strategy: strategySel.value })
          .catch(function () { /* App.error already informed the user */ });
      }
    }));

    // ---- palette swatch grid (visual; live from FigPalette.list())
    if (palLoadErr) {
      box.appendChild(_h("div", {
        text: "配色未加载：" + palLoadErr.message,
        style: "color:#a00;font-size:11px;"
      }));
    } else if (!palettes.length) {
      box.appendChild(_h("div", {
        text: "无可用配色",
        style: "color:#888;font-size:11px;"
      }));
    } else {
      box.appendChild(_h("div", {
        text: "色板预览",
        style: "font-weight:bold;font-size:12px;margin-top:2px;"
      }));
      var grid = _h("div", {
        class: "palette-grid",
        style: "display:flex;flex-direction:column;gap:4px;"
      });
      _paletteGroups(palettes).forEach(function (g) {
        grid.appendChild(_h("div", {
          text: _paletteCatName(g.category),
          style: "color:#666;font-size:11px;margin-top:2px;"
        }));
        var row = _h("div", {
          class: "palette-grid-row",
          style: "display:flex;flex-wrap:wrap;gap:4px;"
        });
        g.palettes.forEach(function (p) {
          row.appendChild(_renderPaletteCard(p, docReady));
        });
        grid.appendChild(row);
      });
      box.appendChild(grid);
      if (!docReady) {
        box.appendChild(_h("div", {
          text: "当前没有文档：先新建或打开工程才能应用换色",
          style: "color:#a60;font-size:11px;"
        }));
      }
    }

    box.appendChild(_h("div", {
      text: "白色/透明/黑色描边等中性色不参与换色",
      style: "color:#888;font-size:11px;"
    }));
    return box;
  }

  function _renderPaletteCard(p, docReady) {
    var selected = _paletteId === p.id;
    var colors = p.colors || [];
    var swatches = _h("div", {
      class: "palette-swatches",
      style: "display:flex;height:12px;border:1px solid #c8ccd2;" +
        "border-radius:2px;overflow:hidden;background:#ffffff;"
    });
    colors.forEach(function (col) {
      swatches.appendChild(_h("span", {
        style: "flex:1 1 0;min-width:0;background:" + col + ";"
      }));
    });
    var sourceTip = p.source ? " · " + p.source : "";
    var card = _h("div", {
      class: "palette-card" + (selected ? " selected" : ""),
      title: p.name + "（" + colors.length + " 色）" + sourceTip +
        (docReady ? "，点击应用换色" : "；当前没有文档，无法应用换色"),
      style: "width:104px;padding:3px 4px;border:1px solid " +
        (selected ? "#2b6cb0" : "#ddd") + ";border-radius:4px;" +
        "cursor:" + (docReady ? "pointer" : "not-allowed") + ";" +
        "opacity:" + (docReady ? "1" : "0.55") + ";" +
        (selected ? "box-shadow:0 0 0 1px #2b6cb0;" : "") +
        "display:flex;flex-direction:column;gap:3px;font-size:11px;"
    }, [
      _h("div", {
        text: p.name,
        style: "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
          (selected ? "font-weight:bold;" : "")
      }),
      swatches
    ]);
    card.addEventListener("click", function () {
      if (!global.App || !global.App.doc) {
        _toast("当前没有文档，无法换色", "info");
        return;
      }
      _paletteId = p.id;
      global.Templates.recolor(p.id, { strategy: _strategy })
        .catch(function () { /* App.error already informed the user */ });
    });
    return card;
  }

  // ------------------------------------------------------------ exports

  var Templates = {
    apply: apply,
    recolor: recolor,
    recommend: recommend,
    openLibrary: openLibrary
  };

  global.Templates = Templates;

  // 工具栏「模板库」按钮（index.html load order 冻结，脚本内自绑定，
  // 与 style-gallery.js 的 btn-style-gallery 同一模式）
  if (typeof document !== "undefined") {
    function _bindLibButton() {
      var btn = document.getElementById("btn-template-library");
      if (btn && !btn.__tlBound) {
        btn.__tlBound = true;
        btn.addEventListener("click", function () { openLibrary(); });
      }
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _bindLibButton);
    } else { _bindLibButton(); }
    setTimeout(_bindLibButton, 500);
    setTimeout(_bindLibButton, 2000);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
