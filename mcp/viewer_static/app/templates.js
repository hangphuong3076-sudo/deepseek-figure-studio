/*
 * templates.js — v1 web app module: built-in template gallery + auto recolor.
 *
 * Exposes globalThis.Templates:
 *   Templates.mount(panelEl)                        render template list + recolor controls
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
 * injected on demand at mount time (index.html load order stays frozen).
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

  var _panel = null;
  var _unsubDoc = null;
  var _listWrap = null;
  var _category = null;
  var _paletteId = null;
  var _strategy = "byHue";

  var CATEGORIES = ["chart", "diagram", "composite"];
  var CATEGORY_NAMES = {
    chart: "图表模板",
    diagram: "示意图模板",
    composite: "复合主图模板"
  };
  // R7：电化学/统计为模板 group 维度的横切筛选（表征仍按
  // characterization 字段判定）；group 不改变模板 category。
  var FILTERS = [["all", "全部"], ["chart", "图表"], ["characterization", "表征"],
    ["electrochem", "电化学"], ["stats", "统计"], ["diagram", "示意图"], ["composite", "复合"]];
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

  function mount(panelEl) {
    _requireApp();
    if (!panelEl) _fail("Templates.mount 需要面板元素");
    _panel = panelEl;
    if (_unsubDoc) _unsubDoc();
    _ensurePreview(function () {
      if (typeof global.App.on === "function") {
        _unsubDoc = global.App.on("doc:changed", function () { _render(); });
      }
      _render();
    });
  }

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

  // ------------------------------------------------------------- render

  function _render() {
    if (!_panel) return;
    _clear(_panel);

    _panel.appendChild(_h("div", {
      class: "panel-section",
      style: "padding:8px 10px;display:flex;flex-direction:column;gap:8px;"
    }, [
      _h("div", {
        class: "panel-section-title",
        text: "模板",
        style: "font-weight:bold;font-size:13px;"
      }),
      _h("button", {
        type: "button",
        class: "tl-open-btn",
        text: "打开模板库（大图预览 · 筛选 · 搜索）",
        title: "打开模板库对话框：卡片网格、分类筛选、搜索与详情",
        onclick: function () { openLibrary(); }
      }),
      _renderFilters(),
      _renderListWrap(),
      _renderRecolor()
    ]));
  }

  function _renderFilters() {
    var row = _h("div", {
      style: "display:flex;gap:4px;flex-wrap:wrap;"
    });
    FILTERS.forEach(function (f) {
      var value = f[0];
      row.appendChild(_h("button", {
        type: "button",
        text: f[1],
        style: "font-size:12px;padding:2px 8px;cursor:pointer;" +
          (value === _category ? "font-weight:bold;" : ""),
        onclick: function () {
          _category = value === "all" ? null : value;
          _renderList();
        }
      }));
    });
    return row;
  }

  function _renderListWrap() {
    _listWrap = _h("div", {
      class: "templates-list",
      style: "display:flex;flex-direction:column;gap:6px;"
    });
    _renderList();
    return _listWrap;
  }

  // 分类 → 模板列表（面板与模板库共用；characterization/electrochem/stats
  // 是横切维度，不改变模板 category）
  function _templatesForCategory(cat) {
    var list = global.FigPresets.templates(cat != null &&
      ["characterization", "electrochem", "stats"].indexOf(cat) < 0
      ? { category: cat } : {});
    if (cat === "characterization") {
      list = list.filter(function (template) { return !!template.characterization; });
    } else if (cat === "electrochem" || cat === "stats") {
      list = list.filter(function (template) { return template.group === cat; });
    }
    return list;
  }

  function _renderList() {
    if (!_listWrap) return;
    _clear(_listWrap);

    var list;
    try {
      _requirePresets();
      list = _templatesForCategory(_category);
    } catch (e) {
      _listWrap.appendChild(_h("div", {
        text: "预设未加载：" + e.message,
        style: "color:#a00;font-size:12px;"
      }));
      return;
    }

    CATEGORIES.forEach(function (cat) {
      var items = list.filter(function (t) { return t.category === cat; });
      if (!items.length) return;
      _listWrap.appendChild(_h("div", {
        text: CATEGORY_NAMES[cat] || cat,
        style: "font-weight:bold;font-size:12px;margin-top:4px;"
      }));
      items.forEach(function (t) {
        _listWrap.appendChild(_renderTemplateItem(t));
      });
    });

    if (!_listWrap.firstChild) {
      _listWrap.appendChild(_h("div", {
        text: "该分类下暂无模板",
        style: "color:#666;font-size:12px;"
      }));
    }
  }

  function _renderTemplateItem(t) {
    var applicability = _applicability(t.id);
    var capability = applicability.capability || {
      status: "unsupported", label: "能力未知 · 不可应用", can_apply: false,
      reason: applicability.errors.join("；")
    };
    // R03：主面只保留用户语言（用途/输入需求/预览/动作）；
    // 内部能力标记（full/layout/unsupported）、renderer 名、面板数与
    // 元数据移入 <details>，保留真实能力边界不删除。
    var inputNeeds = [];
    if (t.default_mapping && typeof t.default_mapping === "object") {
      Object.keys(t.default_mapping).forEach(function (slot) {
        var desc = t.default_mapping[slot];
        if (desc) inputNeeds.push(String(desc));
      });
    }
    if (t.category === "diagram") inputNeeds = ["实体关系合同（节点/关系/来源，不猜科学内容）"];
    var preview = null;
    if (_hasPreview()) {
      try {
        preview = global.TemplatePreview.draw(t, { colors: _previewColors() });
        if (preview) preview.setAttribute("class", "template-preview");
      } catch (e) {
        preview = null; // a broken painter must not break the gallery
      }
    }
    function applyFromCard() {
      global.Templates.apply(t.id)
        .then(function () { _renderList(); })
        .catch(function () { /* App.error already informed the user */ });
    }
    var usageLine = capability.status === "layout"
      ? "只创建空白复合版式，不自动填图；适合先定行列再放图。"
      : (capability.status === "unsupported"
        ? "这种图暂时还不能生成，这里只是样式示意。"
        : (t.notes || "按所选数据列生成真实图表。"));
    var details = _h("details", {
      style: "font-size:11px;color:#666;margin-top:2px;"
    }, [
      _h("summary", {
        text: "详情（能力与内部参数）",
        style: "cursor:pointer;color:#475569;"
      }),
      _h("div", {
        text: "能力：" + capability.label + "（" + ({full:"可直接生成",layout:"只创建空版式",unsupported:"暂时不能生成"})[capability.status] + "）",
        style: "color:" + (capability.status === "full" ? "#166534" :
          (capability.status === "layout" ? "#1d4ed8" : "#b91c1c")) + ";"
      }),
      _h("div", { text: "说明：" + capability.reason }),
      _h("div", {
        text: "内部参数：" + [t.chart_type ? ("图型 " + (global.FigData && typeof global.FigData.chartTypeName === "function" ? global.FigData.chartTypeName(t.chart_type) : t.chart_type)) : null,
          (Array.isArray(t.panels) && (t.panels[0] > 1 || t.panels[1] > 1))
            ? (t.panels[0] + "×" + t.panels[1] + " 个子图") : null,
          t.journal_default ? ("期刊默认 " + (function(){try{var j=global.FigPresets&&global.FigPresets.journal?global.FigPresets.journal(t.journal_default):null;return j&&j.name?j.name:t.journal_default;}catch(e){return t.journal_default;}})()) : null]
          .filter(Boolean).join(" · ") || "—"
      })
    ]);
    var infoCol = _h("div", {
      class: "template-info",
      style: "flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;"
    }, [
      _h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:6px;" }, [
        _h("span", { text: t.name, style: "font-weight:bold;" }),
        _h("button", {
          type: "button",
          text: capability.status === "layout" ? "应用空版式" : (t.category === "diagram" && capability.can_apply ? "应用合成示例" : (capability.can_apply ? "应用" : "不可应用")),
          disabled: capability.can_apply ? null : "disabled",
          "aria-disabled": capability.can_apply ? null : "true",
          style: "font-size:12px;padding:1px 10px;flex:none;cursor:" +
            (capability.can_apply ? "pointer" : "not-allowed") + ";" +
            (capability.can_apply ? "" : "opacity:0.55;"),
          title: capability.reason + (capability.can_apply ? (t.category === "diagram" ? "（仅替换同一编号的示意图；保留其他图表，文字可编辑，全部改动可撤销）" : "（会清空现有元素，保留画布与锚点）") : ""),
          onclick: capability.can_apply ? applyFromCard : null
        })
      ]),
      _h("div", { text: usageLine, style: "color:#374151;" }),
      inputNeeds.length ? _h("div", {
        text: "输入需求：" + inputNeeds.join("、"),
        style: "color:#6b7280;"
      }) : null,
      details
    ]);
    if (preview) {
      return _h("div", {
        class: "template-item",
        "data-capability": capability.status,
        style: "border:1px solid #ddd;border-radius:4px;padding:6px 8px;" +
          "display:flex;flex-direction:column;gap:3px;font-size:12px;"
      }, [
        _h("div", { style: "display:flex;gap:8px;align-items:flex-start;" }, [
          _h("div", {
            class: "template-thumb",
            title: (capability.status === "layout" ? "空白版式示意（不会自动填图）" :
              "模板样本示意（非真实数据）") + "；" + capability.reason +
              (capability.can_apply ? "；点击应用" : "；仅供预览，不可点击应用"),
            style: "flex:none;line-height:0;cursor:" + (capability.can_apply ? "pointer" : "default") + ";",
            onclick: capability.can_apply ? applyFromCard : null
          }, [preview]),
          infoCol
        ])
      ]);
    }
    return _h("div", {
      class: "template-item",
      "data-capability": capability.status,
      style: "border:1px solid #ddd;border-radius:4px;padding:6px 8px;" +
        "display:flex;flex-direction:column;gap:3px;font-size:12px;"
    }, [infoCol]);
  }

  // ------------------------------------------------------- 模板库对话框
  // 大画幅浏览：卡片网格 + 分类筛选 + 搜索 + 仅显示可用 + 详情/应用。
  // 右侧面板保留紧凑列表；本对话框复用 Ui.modal 与 TemplatePreview。

  var _lib = { category: "all", query: "", onlyApplicable: false, selected: null };

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
      list = _templatesForCategory(_lib.category === "all" ? null : _lib.category);
    } catch (e) {
      return { list: [], error: e.message };
    }
    var q = (_lib.query || "").trim().toLowerCase();
    list = list.filter(function (t) { return _libSearchMatch(t, q); });
    if (_lib.onlyApplicable) {
      list = list.filter(function (t) { return _libCapability(t).ok; });
    }
    return { list: list, error: null };
  }

  function _libCategoryTag(t) {
    if (t.characterization) return "表征";
    if (t.group === "electrochem") return "电化学";
    if (t.group === "stats") return "统计";
    return { chart: "图表", diagram: "示意图", composite: "复合" }[t.category] || t.category;
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
      title: t.name + "（" + _libCategoryTag(t) + "）" +
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
      _libCategoryTag(t) + (c.status === "layout" ? " · 空版式" :
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
      [_libCategoryTag(t), t.chart_type ? (global.FigData &&
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
    var btns = _h("div", { class: "tl-detail-actions" }, [
      _h("button", {
        type: "button", class: "ui-btn ui-btn-primary", text: "应用此模板",
        disabled: canApply ? null : "disabled",
        title: canApply ? "应用到当前画布（可撤销）" : (c.reason || "不可应用"),
        onclick: function () {
          global.Templates.apply(t.id).then(function () {
            _toast("已应用模板「" + t.name + "」", "success");
            if (_libModal) _libModal.close();
            if (_panel) _render();
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
    var catSel = _h("select", { "aria-label": "模板分类", class: "tl-cat" });
    FILTERS.forEach(function (f) {
      catSel.appendChild(_h("option", { value: f[0], text: f[1] }));
    });
    catSel.value = _lib.category;
    catSel.addEventListener("change", function () {
      _lib.category = catSel.value;
      _lib.selected = null;
      rerender();
    });
    var onlyChk = _h("input", { type: "checkbox", "aria-label": "仅显示可用" });
    onlyChk.checked = !!_lib.onlyApplicable;
    onlyChk.addEventListener("change", function () {
      _lib.onlyApplicable = onlyChk.checked;
      _lib.selected = null;
      rerender();
    });
    body.appendChild(_h("div", { class: "tl-toolbar" }, [
      search, catSel,
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
      list.forEach(function (t) {
        var card = _libCard(t, function (tpl) {
          _lib.selected = tpl;
          rerender();
        });
        if (_lib.selected && _lib.selected.id === t.id) card.classList.add("tl-card-sel");
        grid.appendChild(card);
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

  function _renderRecolor() {
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
        _render(); // keep swatch selection highlight + thumbnail colors in sync
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
    mount: mount,
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
