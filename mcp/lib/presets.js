/*
 * presets.js — FigPresets (shared kernel, frozen API v1.0)
 *
 * Journal presets, journal canvas application, journal compliance checks,
 * font scaling, template recommendation and template skeleton generation.
 *
 * Load order: figdoc.js -> ops.js -> palette.js -> presets.js.
 * Hard dependency: FigPalette (needed by load). Runtime dependencies that
 * are used when available and guarded otherwise: FigOps (applyCanvas),
 * FigDoc (uid/clone, with internal fallbacks).
 *
 * No module system, no third-party dependencies, no build step.
 * Attaches FigPresets to globalThis so it works in the browser (file://)
 * and under Node.
 */

(function (global) {
  "use strict";

  // ------------------------------------------------------------- state

  var _journals = null;   // deep copy of journals.json presets array
  var _templates = null;  // deep copy of templates.json templates array
  var _uidCounter = 0;

  // ------------------------------------------------------- name heuristics

  var TIME_RE = /(^|[^a-z])(time|date|day|month|year|week|hour|t)([^a-z]|$)|时间|日期|天数|月份|年份|时刻|周/i;
  var LOG2FC_RE = /log2|log₂|fold|差异倍数|倍数/i;
  var PVAL_RE = /p[._\- ]?val|p\.?value|^p$|padj|q[._\- ]?val|q\.?value|^q$|fdr|p ?值|q ?值|显著/i;
  var SCORE_RE = /score|prob|likelihood|得分|概率|评分/i;
  var TRUTH_RE = /truth|y[_\-]?true|actual|gold|真值|真实|金标准/i;
  var LABEL2_RE = /label|class|diagnos|disease|outcome|case|control|诊断|标签|结局/i;
  var EVENT_RE = /event|status|censor|death|dead|事件|结局|死亡/i;
  var CORR_RE = /corr|相关系数|相关/i;
  var STD_RE = /(^|[^a-z])(std|sd)([^a-z]|$)|标准差/i;

  // Characterization technique detection (column-name declared only; the
  // renderer never infers a technique from values and never guesses peaks).
  var XPS_RE = /(binding[.\-_ ]?energy|kinetic[.\-_ ]?energy|结合能|(?<![a-z])xps(?![a-z])|be[._\- ]?ev)/i;
  var RAMAN_RE = /(raman|拉曼)/i;
  var XRD_RE = /(2.?theta|xrd|衍射)/i;
  var FTIR_RE = /(wavenumber|波数|ftir|红外|transmittance|透射率|透过率)/i;
  var NMR_RE = /(chemical[.\-_ ]?shift|化学位移|(?<![a-z])ppm(?![a-z])|(?<![a-z])nmr(?![a-z]))/i;
  var UVPL_RE = /(wavelength|absorbance|吸光度|波长|photoluminesc|(?<![a-z])pl(?![a-z])[_ ]|emission|荧光|uv[.\-_ ]?vis)/i;
  var NYQUIST_RE = /(z[’']|zprime|z_?re|re\(z\)|-z.{0,3}(im|prime|double)|z[”'']{2}|zimag|z_?im)/i;
  var EIS_RE = /(impedance|阻抗|(?<![a-z])eis(?![a-z])|freq|频率)/i;
  var CV_RE = /(voltammet|循环伏安|potential|电位|(?<![a-z])cv(?![a-z])[_ ])/i;
  var STRESS_RE = /(stress|strain|应力|应变)/i;
  var PSD_RE = /(particle|粒径|粒度|size[.\-_ ]?(dist|distrib)|size[._\-]?nm|diameter|直径|(?<![a-z])d(10|50|90)(?![a-z]))/i;

  // ---------------------------------------------------------- small utils

  function _fail(msg) {
    throw new Error(msg);
  }

  function _isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function _deepCopy(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function _round2(v) {
    return Math.round(v * 100) / 100;
  }

  function _requireLoaded() {
    if (!_journals || !_templates) {
      _fail("预设尚未加载，请先调用 FigPresets.load({journals, templates, palettes})");
    }
  }

  function _uid(prefix) {
    if (_isObj(global.FigDoc) && typeof global.FigDoc.uid === "function") {
      return global.FigDoc.uid(prefix);
    }
    _uidCounter += 1;
    var n = _uidCounter.toString(36);
    while (n.length < 8) n = "0" + n;
    return prefix + "-" + n;
  }

  // ------------------------------------------------------- color helpers

  // #rgb / #rrggbb -> {r,g,b}; returns null for anything unparsable.
  function _hexToRgb(hex) {
    if (typeof hex !== "string") return null;
    var h = hex.trim();
    var m = /^#([0-9a-fA-F]{6})$/.exec(h);
    if (m) {
      return {
        r: parseInt(m[1].slice(0, 2), 16),
        g: parseInt(m[1].slice(2, 4), 16),
        b: parseInt(m[1].slice(4, 6), 16)
      };
    }
    m = /^#([0-9a-fA-F]{3})$/.exec(h);
    if (m) {
      return {
        r: parseInt(m[1][0] + m[1][0], 16),
        g: parseInt(m[1][1] + m[1][1], 16),
        b: parseInt(m[1][2] + m[1][2], 16)
      };
    }
    return null;
  }

  // WCAG relative luminance (0-1); null when the color cannot be parsed.
  function _luminance(hex) {
    var rgb = _hexToRgb(hex);
    if (!rgb) return null;
    function lin(c) {
      c = c / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  }

  // WCAG contrast ratio (1-21); null when either color cannot be parsed.
  function _contrastRatio(hexA, hexB) {
    var la = _luminance(hexA);
    var lb = _luminance(hexB);
    if (la === null || lb === null) return null;
    var hi = Math.max(la, lb);
    var lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  // ------------------------------------------------------ column roles

  // Infer semantic roles for one columnStats column. Returns string[].
  function _columnRoles(col) {
    var name = String(col.name || "");
    var kind = col.kind;
    var roles = [];

    if (kind === "datetime") {
      roles.push("time");
      return roles;
    }
    if (kind === "numeric") {
      roles.push("numeric");
    } else if (kind === "categorical") {
      roles.push("categorical");
    } else {
      roles.push("text");
    }

    if (TIME_RE.test(name)) roles.push("time");

    if (kind === "numeric") {
      if (LOG2FC_RE.test(name)) roles.push("log2fc");
      if (PVAL_RE.test(name)) roles.push("pvalue");
      var mn = typeof col.min === "number" ? col.min : null;
      var mx = typeof col.max === "number" ? col.max : null;
      if (SCORE_RE.test(name) || (mn !== null && mx !== null && mn >= 0 && mx <= 1)) {
        roles.push("score");
      }
      if (EVENT_RE.test(name)) roles.push("event");
      if (TRUTH_RE.test(name) || LABEL2_RE.test(name)) roles.push("truth");
      if (CORR_RE.test(name)) roles.push("corr");
      if (STD_RE.test(name)) roles.push("std");
    } else if (kind === "categorical") {
      var nu = typeof col.nunique === "number" ? col.nunique : null;
      if (nu !== null && nu >= 2 && nu <= 6) roles.push("group");
      if (nu === 2) roles.push("binary");
      if (nu === 2 && (TRUTH_RE.test(name) || LABEL2_RE.test(name))) roles.push("truth");
      if (EVENT_RE.test(name)) roles.push("event");
      if (TIME_RE.test(name) && nu !== null && nu > 6) roles.push("time");
    }
    return roles;
  }

  function _rolesOf(col) {
    return Array.isArray(col.roles) ? col.roles : _columnRoles(col);
  }

  function _hasRole(list, role) {
    for (var i = 0; i < list.length; i++) {
      if (_rolesOf(list[i]).indexOf(role) >= 0) return true;
    }
    return false;
  }

  // ------------------------------------------------------ data helpers

  // Infer per-column numeric/categorical info straight from {columns, rows}.
  function _dataKinds(columns, rows) {
    return columns.map(function (name, i) {
      var vals = [];
      for (var r = 0; r < rows.length; r++) {
        var v = rows[r] ? rows[r][i] : null;
        if (v !== null && v !== undefined && v !== "") vals.push(v);
      }
      var numeric = vals.length > 0 && vals.every(function (v) {
        if (typeof v === "number") return isFinite(v);
        if (typeof v === "string" && v.trim() !== "") return isFinite(Number(v));
        return false;
      });
      var uniq = {};
      vals.forEach(function (v) { uniq[String(v)] = 1; });
      return {
        name: name,
        index: i,
        numeric: numeric,
        nunique: Object.keys(uniq).length,
        n: vals.length
      };
    });
  }

  // ---------------------------------------------------- public: loading

  function load(bundle) {
    if (!_isObj(bundle)) {
      _fail("FigPresets.load 需要 {journals, templates, palettes} 参数");
    }
    if (!_isObj(bundle.journals) || !Array.isArray(bundle.journals.presets)) {
      _fail("journals 参数格式错误：需要含 presets 数组的 journals.json 对象");
    }
    if (!_isObj(bundle.templates) || !Array.isArray(bundle.templates.templates)) {
      _fail("templates 参数格式错误：需要含 templates 数组的 templates.json 对象");
    }
    if (!_isObj(bundle.palettes)) {
      _fail("palettes 参数格式错误：需要 palettes.json 对象");
    }
    if (!_isObj(global.FigPalette) || typeof global.FigPalette.load !== "function") {
      _fail("FigPresets.load 需要 FigPalette 模块（palette.js）先加载");
    }
    global.FigPalette.load(bundle.palettes);
    _journals = _deepCopy(bundle.journals.presets);
    _templates = _deepCopy(bundle.templates.templates);
    _rules = Array.isArray(bundle.journals.rules) ? _deepCopy(bundle.journals.rules) : [];
  }

  var _rules = [];

  function journals() {
    _requireLoaded();
    return _journals.slice();
  }

  function journal(id) {
    _requireLoaded();
    if (typeof id !== "string") _fail("journal(id) 的 id 必须为字符串");
    for (var i = 0; i < _journals.length; i++) {
      if (_journals[i].id === id) return _journals[i];
    }
    return null;
  }

  var FALLBACK_RENDER_TYPES = [
    "bar", "bar_grouped", "line", "line_multi", "scatter", "area",
    "pie", "histogram", "heatmap", "box"
  ];

  function _rawTemplate(id) {
    for (var i = 0; i < _templates.length; i++) {
      if (_templates[i].id === id) return _templates[i];
    }
    return null;
  }

  function _rendererSupports(chartType) {
    var fd = global.FigData;
    if (fd && typeof fd.supportsChartType === "function") {
      try {
        return fd.supportsChartType(chartType) === true;
      } catch (e) {
        return false;
      }
    }
    // Compatibility with the pre-capability kernel. This is deliberately only
    // the renderer set already shipped in data.js, never a name/category guess.
    return FALLBACK_RENDER_TYPES.indexOf(chartType) >= 0;
  }

  function templateCapability(templateOrId) {
    _requireLoaded();
    var tpl = _isObj(templateOrId) ? templateOrId : null;
    if (!tpl) {
      if (typeof templateOrId !== "string" || !templateOrId) {
        _fail("templateCapability 需要模板对象或非空模板 id");
      }
      tpl = _rawTemplate(templateOrId);
    }
    if (!tpl || tpl.id !== templateOrId && typeof templateOrId === "string") return null;

    var chartType = typeof tpl.chart_type === "string" && tpl.chart_type ? tpl.chart_type : null;
    var status = "unsupported";
    var label = "仅示意 · 不可应用";
    var reason;
    if (tpl.category !== "diagram" && chartType && _rendererSupports(chartType)) {
      status = "full";
      label = "本地可生成";
      reason = "chartType " + chartType + " 已有本地实际 SVG 渲染器；无数据时只生成未绑定数据的空骨架";
    } else if (tpl.category === "composite" && chartType === null) {
      status = "layout";
      label = "仅空版式";
      var panels = Array.isArray(tpl.panels) ? tpl.panels : [1, 1];
      reason = "只创建 " + (panels[0] || 1) + "×" + (panels[1] || 1) +
        " 空白复合版式，不自动填图、不绑定或伪造数据";
    } else if (tpl.category === "diagram" && global.FigDiagram &&
        typeof global.FigDiagram.supportsTemplate === "function" &&
        global.FigDiagram.supportsTemplate(tpl).supported === true) {
      var schematic = global.FigDiagram.supportsTemplate(tpl);
      status = "full";
      label = "可编辑示意图 · 原始参数";
      reason = schematic.reason + "；不使用数据自动关联，必须提供/确认 nodes/relations 与来源";
    } else if (tpl.category === "diagram") {
      reason = global.FigDiagram && global.FigDiagram.supportsTemplate
        ? global.FigDiagram.supportsTemplate(tpl).reason
        : "实体关系 builder 未加载，示意图模板保持不可应用";
    } else {
      reason = "chartType " + (chartType || "(未声明)") +
        " 当前没有本地实际 SVG 渲染器，只供示意预览，禁止应用";
    }
    return {
      template_id: tpl.id,
      chart_type: chartType,
      status: status,
      label: label,
      can_generate: status === "full",
      can_apply: status !== "unsupported",
      requires_data: status === "full",
      can_preview: true,
      reason: reason
    };
  }

  function validateTemplateCapability(templateOrId) {
    var capability = templateCapability(templateOrId);
    if (!capability) {
      return { ok: false, errors: ["模板不存在: " + String(templateOrId)], capability: null };
    }
    return {
      ok: capability.can_apply,
      errors: capability.can_apply ? [] : [capability.reason],
      capability: capability
    };
  }

  function _publicTemplate(tpl) {
    var out = _deepCopy(tpl);
    out.capability = templateCapability(tpl);
    return out;
  }

  function templates(opts) {
    _requireLoaded();
    if (opts == null) opts = {};
    if (!_isObj(opts)) _fail("templates(opts) 的参数必须是对象");
    return _templates.filter(function (t) {
      if (opts.category != null && t.category !== opts.category) return false;
      if (opts.chart_type !== undefined && t.chart_type !== opts.chart_type) return false;
      if (opts.capability != null && templateCapability(t).status !== opts.capability) return false;
      return true;
    }).map(_publicTemplate);
  }

  function template(id) {
    _requireLoaded();
    if (typeof id !== "string") _fail("template(id) 的 id 必须为字符串");
    var tpl = _rawTemplate(id);
    return tpl ? _publicTemplate(tpl) : null;
  }

  function pxPerMm(dpi) {
    if (typeof dpi !== "number" || !isFinite(dpi) || dpi <= 0) {
      _fail("dpi 必须为正数");
    }
    return dpi / 25.4;
  }

  // --------------------------------------------------- journal warnings

  // Post-apply comparison of a document against a journal preset.
  function _journalWarnings(preset, doc) {
    var warnings = [];
    var minPt = preset.min_font_pt;

    // Font sizes below the preset floor, grouped by distinct size.
    var offenders = {};
    var elements = Array.isArray(doc.elements) ? doc.elements : [];
    elements.forEach(function (el) {
      if (!_isObj(el) || !_isObj(el.style)) return;
      var pt = el.style.fontSizePt;
      if (typeof pt === "number" && isFinite(pt) && minPt != null && pt < minPt) {
        offenders[pt] = (offenders[pt] || 0) + 1;
      }
    });
    Object.keys(offenders).map(Number).sort(function (a, b) { return a - b; }).forEach(function (pt) {
      var count = offenders[pt];
      var msg = "正文 " + pt + "pt 低于 " + preset.name + " " + minPt + "pt 下限";
      if (count > 1) msg += "（" + count + " 个元素）";
      warnings.push(msg);
    });

    var dpi = doc.canvas ? doc.canvas.dpi : undefined;
    if (typeof dpi === "number" && preset.dpi_min != null && dpi < preset.dpi_min) {
      warnings.push("分辨率 " + dpi + "dpi 低于 " + preset.name + " 最低要求 " + preset.dpi_min + "dpi");
    }
    return warnings;
  }

  // ------------------------------------------------------ applyCanvas

  function applyCanvas(presetId, doc) {
    _requireLoaded();
    if (typeof presetId !== "string" || !presetId) {
      _fail("applyCanvas 的 presetId 必须为非空字符串");
    }
    if (!_isObj(doc)) _fail("applyCanvas 需要合法的文档对象");

    var preset = journal(presetId);
    if (!preset) _fail("未找到期刊预设：" + presetId);

    if (!_isObj(global.FigOps) || typeof global.FigOps.apply !== "function") {
      _fail("FigPresets.applyCanvas 需要 FigOps 模块（ops.js）先加载");
    }

    var op = { op: "apply_journal", journal_preset_id: presetId };
    if (typeof global.FigOps.validate === "function") {
      var v = global.FigOps.validate(op, doc);
      if (!v || v.ok !== true) {
        _fail("apply_journal 操作校验失败：" + (v && Array.isArray(v.errors) ? v.errors.join("；") : "未知原因"));
      }
    }
    var res = global.FigOps.apply(doc, op);
    return { doc: res.doc, op: op, warnings: _journalWarnings(preset, res.doc) };
  }

  // ----------------------------------------------------------- check

  function check(doc) {
    if (!_isObj(doc) || !_isObj(doc.canvas)) {
      _fail("check 需要包含 canvas 的文档对象");
    }
    var canvas = doc.canvas;
    var preset = typeof canvas.journal_preset_id === "string" ? journal(canvas.journal_preset_id) : null;
    var elements = Array.isArray(doc.elements) ? doc.elements : [];
    var anchors = Array.isArray(doc.anchors) ? doc.anchors : [];
    var warnings = [];

    // FONT_TOO_SMALL
    var minPt = preset && preset.min_font_pt != null ? preset.min_font_pt : 5;
    var minSrc = preset ? preset.name : "通用";
    elements.forEach(function (el) {
      if (!_isObj(el) || !_isObj(el.style)) return;
      var pt = el.style.fontSizePt;
      if (typeof pt === "number" && isFinite(pt) && pt < minPt) {
        warnings.push({
          code: "FONT_TOO_SMALL",
          message: "元素 " + el.id + " 字号 " + pt + "pt 低于" + minSrc + "最小字号 " + minPt + "pt",
          element_id: el.id
        });
      }
    });

    // WIDTH_MISMATCH / HEIGHT_TOO_TALL / DPI_TOO_LOW (need a journal preset)
    if (preset) {
      if (typeof canvas.width_mm === "number" &&
          Math.abs(canvas.width_mm - preset.width_mm) > 0.5) {
        warnings.push({
          code: "WIDTH_MISMATCH",
          message: "画布宽度 " + canvas.width_mm + "mm 与 " + preset.name + " 栏宽 " + preset.width_mm + "mm 不一致"
        });
      }
      if (preset.height_mm != null && typeof canvas.height_mm === "number" &&
          canvas.height_mm > preset.height_mm + 0.5) {
        warnings.push({
          code: "HEIGHT_TOO_TALL",
          message: "画布高度 " + canvas.height_mm + "mm 超过 " + preset.name + " 建议上限 " + preset.height_mm + "mm"
        });
      }
      if (preset.dpi_min != null && typeof canvas.dpi === "number" &&
          canvas.dpi < preset.dpi_min) {
        warnings.push({
          code: "DPI_TOO_LOW",
          message: "画布分辨率 " + canvas.dpi + "dpi 低于 " + preset.name + " 最低要求 " + preset.dpi_min + "dpi"
        });
      }
    }

    // PANEL_OVERFLOW (panel-relative coordinates must stay within 0-1)
    var byId = {};
    elements.forEach(function (el) { if (_isObj(el)) byId[el.id] = el; });
    elements.forEach(function (el) {
      if (!_isObj(el) || !_isObj(el.style) || el.style.panelRelative !== true) return;
      var parent = el.parent_id ? byId[el.parent_id] : null;
      if (!parent || parent.type !== "panel") return;
      var t = _isObj(el.transform) ? el.transform : {};
      var x = typeof t.x === "number" ? t.x : 0;
      var y = typeof t.y === "number" ? t.y : 0;
      var w = typeof t.w === "number" ? t.w : 0;
      var h = typeof t.h === "number" ? t.h : 0;
      var eps = 1e-6;
      if (x < -eps || y < -eps || w < 0 || h < 0 || x + w > 1 + eps || y + h > 1 + eps) {
        warnings.push({
          code: "PANEL_OVERFLOW",
          message: "元素 " + el.id + " 的面板相对坐标越界（x=" + x + "，y=" + y + "，w=" + w + "，h=" + h + "）",
          element_id: el.id
        });
      }
    });

    // LOW_CONTRAST (text fill vs panel/canvas background, WCAG 4.5:1)
    var bgHex = typeof canvas.background === "string" &&
      _hexToRgb(canvas.background) !== null ? canvas.background : null;
    elements.forEach(function (el) {
      if (!_isObj(el) || el.type !== "text" || !_isObj(el.style)) return;
      var fg = el.style.fill;
      if (typeof fg !== "string" || _hexToRgb(fg) === null) return;
      var bg = bgHex;
      var pid = el.parent_id;
      var guard = 0;
      while (pid && byId[pid] && guard++ < 16) {
        var p = byId[pid];
        if (_isObj(p.style) && typeof p.style.fill === "string" && _hexToRgb(p.style.fill) !== null) {
          bg = p.style.fill;
          break;
        }
        pid = p.parent_id;
      }
      if (!bg) return;
      var ratio = _contrastRatio(fg, bg);
      if (ratio !== null && ratio < 4.5) {
        warnings.push({
          code: "LOW_CONTRAST",
          message: "元素 " + el.id + " 文字与背景对比度 " + ratio.toFixed(2) + " 低于 4.5",
          element_id: el.id
        });
      }
    });

    // NO_ANCHOR
    if (elements.length > 0 && anchors.length === 0) {
      warnings.push({
        code: "NO_ANCHOR",
        message: "文档没有任何锚点，AI 定位与审阅需要先用选框工具创建锚点"
      });
    }

    return { ok: warnings.length === 0, warnings: warnings };
  }

  // ------------------------------------------------------- scaleFonts

  function scaleFonts(doc, fromPt, toPt) {
    if (!_isObj(doc)) _fail("scaleFonts 需要合法的文档对象");
    if (typeof fromPt !== "number" || !isFinite(fromPt) || fromPt <= 0) {
      _fail("fromPt 必须为正数");
    }
    if (typeof toPt !== "number" || !isFinite(toPt) || toPt <= 0) {
      _fail("toPt 必须为正数");
    }
    var out;
    if (_isObj(global.FigDoc) && typeof global.FigDoc.clone === "function") {
      out = global.FigDoc.clone(doc);
    } else {
      out = _deepCopy(doc);
    }
    var factor = toPt / fromPt;
    (out.elements || []).forEach(function (el) {
      if (!_isObj(el)) return;
      if (_isObj(el.style) && typeof el.style.fontSizePt === "number") {
        el.style.fontSizePt = _round2(el.style.fontSizePt * factor);
      }
      if (_isObj(el.panelLayout) && _isObj(el.panelLayout.labelStyle) &&
          typeof el.panelLayout.labelStyle.fontSizePt === "number") {
        el.panelLayout.labelStyle.fontSizePt = _round2(el.panelLayout.labelStyle.fontSizePt * factor);
      }
    });
    return out;
  }

  // ---------------------------------------------------- inferColumns

  // Validates the columnStats shape and annotates each column in place with
  // a `roles` array of semantic hints used by recommend(). Returns void.
  function inferColumns(columnStats) {
    if (!_isObj(columnStats) || !Array.isArray(columnStats.columns)) {
      _fail("inferColumns 需要 FigData.columnStats 的输出（含 columns 数组）");
    }
    columnStats.columns.forEach(function (col) {
      if (!_isObj(col)) _fail("columnStats.columns 中存在非法列描述");
      col.roles = _columnRoles(col);
    });
  }

  // ------------------------------------------------------- recommend

  // Extract chart-shape features from columnStats (roles annotated by
  // inferColumns when present, recomputed otherwise).
  function _features(cs) {
    var cols = cs.columns;
    var num = [];
    var cat = [];
    var time = [];
    cols.forEach(function (c) {
      if (!_isObj(c)) _fail("columnStats.columns 中存在非法列描述");
      var isTime = c.kind === "datetime" || _rolesOf(c).indexOf("time") >= 0;
      if (isTime) time.push(c);
      if (c.kind === "numeric") num.push(c);
      else if (c.kind === "categorical") cat.push(c);
    });

    var bestCat = null;   // categorical with 2-12 levels, smallest first
    var groupCat = null;  // categorical with 2-6 levels
    var pairB = null;     // grouping categorical with 2-4 levels
    cat.forEach(function (c) {
      var nu = typeof c.nunique === "number" ? c.nunique : 0;
      if (nu >= 2 && nu <= 12 && (bestCat === null || nu < bestCat.nunique)) bestCat = c;
      if (nu >= 2 && nu <= 6 && (groupCat === null || nu < groupCat.nunique)) groupCat = c;
      if (nu >= 2 && nu <= 4 && (pairB === null || nu < pairB.nunique)) pairB = c;
    });
    var pairA = null;
    if (pairB) {
      for (var i = 0; i < cat.length; i++) {
        var c2 = cat[i];
        if (c2 !== pairB && typeof c2.nunique === "number" &&
            c2.nunique >= 2 && c2.nunique <= 12) { pairA = c2; break; }
      }
    }
    var binaryCats = cat.filter(function (c) { return c.nunique === 2; }).length;
    var nRows = typeof cs.n_rows === "number" ? cs.n_rows : 0;

    return {
      n_rows: nRows,
      num: num,
      cat: cat,
      time: time,
      hasData: nRows > 0 && (num.length + cat.length) > 0,
      hasTime: time.length > 0,
      hasGroup: _hasRole(cat, "group"),
      hasLog2fc: _hasRole(num, "log2fc"),
      hasPval: _hasRole(num, "pvalue"),
      hasScore: _hasRole(num, "score"),
      hasTruth: _hasRole(cols, "truth"),
      hasEvent: _hasRole(cols, "event"),
      hasCorr: _hasRole(num, "corr"),
      hasStd: _hasRole(num, "std"),
      bestCat: bestCat,
      groupCat: groupCat,
      pairA: pairA,
      pairB: pairB,
      binaryCats: binaryCats
    };
  }

  function recommend(columnStats, opts) {
    _requireLoaded();
    if (!_isObj(columnStats) || !Array.isArray(columnStats.columns)) {
      _fail("recommend 需要 FigData.columnStats 的输出（含 columns 数组）");
    }
    if (opts == null) opts = {};
    if (!_isObj(opts)) _fail("recommend 的第二个参数必须是对象");
    var n = opts.n != null ? opts.n : 5;
    if (typeof n !== "number" || !isFinite(n) || n < 1 || Math.floor(n) !== n) {
      _fail("n 必须为正整数");
    }

    var f = _features(columnStats);
    var scored = {};
    function put(id, score, reason) {
      var cur = scored[id];
      if (!cur || score > cur.score) {
        scored[id] = { score: score, reasons: reason ? [reason] : [] };
      }
    }
    function q(s) { return "「" + s + "」"; }

    if (!f.hasData) {
      put("tpl-diagram-flow", 90, "没有可用数据 → 流程示意图");
      put("tpl-diagram-arch", 88, "没有可用数据 → 系统/模型架构图");
    } else {
      // High-confidence domain charts
      if (f.hasLog2fc && f.hasPval) {
        put("tpl-volcano", 96, "检测到 log2FC 列与显著性(p/q)列 → 火山图");
      }
      if (f.hasTruth && f.hasScore) {
        put("tpl-roc", 96, "存在真值列与预测得分列 → ROC 曲线");
      }
      if (f.hasTime && f.hasEvent && f.hasGroup) {
        put("tpl-survival", 94, "时间列 + 事件列 + 分组列 → 生存曲线");
      }

      // Time series
      if (f.hasTime && f.num.length >= 1) {
        if (f.hasGroup) {
          put("tpl-line-multi", 88, "时间列 + 数值列 + 分组列 → 多折线图");
        }
        put("tpl-line", 85, "时间/有序列 + 数值列 → 折线图");
      }

      // Category-driven charts
      if (f.pairA && f.pairB && f.num.length >= 1) {
        put("tpl-bar-grouped", 84,
          "类别列" + q(f.pairA.name) + "(基数 " + f.pairA.nunique + ") + 分组列" +
          q(f.pairB.name) + "(基数 " + f.pairB.nunique + ") + 数值列 → 分组柱状图");
        put("tpl-bar-stacked", 74, "类别列 + 组分列 + 数值列 → 堆叠柱状图");
      }
      if (f.bestCat && f.num.length >= 1) {
        put("tpl-bar", 82,
          "类别列" + q(f.bestCat.name) + "(基数 " + f.bestCat.nunique + ") + 数值列" +
          q(f.num[0].name) + " → 柱状图");
        put("tpl-box", 76, "类别列(基数 2–8) + 数值列 → 箱线图（需配散点）");
        if (f.bestCat.nunique > 0 && f.n_rows / f.bestCat.nunique >= 20) {
          put("tpl-violin", 72,
            "每组样本量约 " + Math.round(f.n_rows / f.bestCat.nunique) + " ≥ 20，可展示分布形状 → 小提琴图");
        }
        if (f.num.length >= 2) {
          put("tpl-dotplot", 60, "类别列 + 多个数值列 → 点图（富信息摘要）");
        } else {
          put("tpl-dotplot", 45, "类别列 + 数值列 → 点图");
        }
      }
      if (f.cat.length >= 2 && f.num.length >= 1) {
        put("tpl-heatmap", 74, "两个类别列 + 数值列 → 热图（须配色标）");
        put("tpl-sankey", 40, "两个类别列 + 权重列 → 桑基图（流向）");
      }
      if (f.num.length >= 2 && !f.hasTime) {
        put("tpl-scatter", 83,
          "两个数值列" + q(f.num[0].name) + "、" + q(f.num[1].name) + " → 散点图");
        if (f.n_rows >= 30) {
          put("tpl-marginal", 80, "两个数值列且样本量 " + f.n_rows + " ≥ 30 → 边际散点图");
        }
        put("tpl-paired", 55, "两个数值列可作两次测量 → 配对比较图");
      }
      if (f.num.length >= 1 && f.binaryCats === 1) {
        put("tpl-paired", 50, "数值列 + 二水平分组列 → 配对比较图");
      }
      if (f.num.length >= 1 && f.cat.length === 0 && !f.hasTime) {
        put("tpl-histogram", 65, "仅数值列" + q(f.num[0].name) + " → 直方图看分布");
      }
      var pieCat = null;
      f.cat.forEach(function (c) {
        var nu = typeof c.nunique === "number" ? c.nunique : 0;
        if (nu >= 3 && nu <= 6 && (pieCat === null || nu < pieCat.nunique)) pieCat = c;
      });
      if (pieCat && f.num.length >= 1) {
        put("tpl-pie", 70,
          "类别列" + q(pieCat.name) + "(基数 " + pieCat.nunique + ") + 占比数值 → 饼图（>6 类请改条形图）");
      }
      if (f.num.length >= 3 && f.hasGroup) {
        put("tpl-pca", 79, "≥3 个数值列 + 分组列 → PCA/降维散点");
      }
      if (f.num.length >= 3) {
        put("tpl-forest", f.hasCorr ? 55 : 48, "多个数值列(效应量/置信区间) → 森林图");
      }
      if (f.binaryCats >= 2 && f.binaryCats <= 3 && f.num.length === 0) {
        put("tpl-venn", 45, "2–3 个二元集合成员列 → Venn/UpSet");
      }
      if (f.num.length >= 2 && f.hasCorr && f.hasStd) {
        put("tpl-taylor", 60, "相关系数 + 标准差列 → Taylor 图");
      }

      // --- 表征谱图模板推荐：只按用户列名声明判断技术（不从数值推断、
      // 不猜峰位/元素归属），命中时排在通用折线之前 ---
      function anyName(re) {
        return columnStats.columns.some(function (c) {
          return re.test(String(c && c.name || ""));
        });
      }
      if (anyName(XPS_RE)) {
        var fitLike = f.num.filter(function (c) {
          return /(fit|base|comp|component|拟合|基线|组分)/i.test(c.name);
        }).length;
        if (fitLike >= 2) {
          put("tpl-xps-highres-fit", 92,
            "检测到结合能列 + " + fitLike + " 个拟合/基线/组分列 → XPS 高分辨拟合谱（曲线列须为您已拟合的结果）");
        } else {
          put("tpl-xps-survey", 90, "检测到结合能列 → XPS 全谱（结合能轴默认反向）");
        }
        put("tpl-xps-two-regions", 55, "结合能数据可作双区域对照（复合 2×1，逐面板映射）");
      }
      if (anyName(RAMAN_RE)) {
        if (f.hasGroup) {
          put("tpl-raman-multi-compare", 91, "拉曼位移列 + 样品分组列 → Raman 多样品对比（模板申报 max_to_unity 渲染归一）");
        }
        put("tpl-raman-single", 89, "检测到拉曼位移列 → Raman 单谱");
      }
      if (anyName(XRD_RE)) put("tpl-xrd", 88, "检测到 2θ/衍射列 → XRD 图谱");
      if (anyName(FTIR_RE)) put("tpl-ftir", 88, "检测到波数/红外列 → FTIR 光谱");
      if (anyName(NMR_RE)) put("tpl-nmr", 88, "检测到化学位移/ppm 列 → NMR 谱（δ 轴默认反向）");
      if (anyName(UVPL_RE)) put("tpl-uvvis-pl", 86, "检测到波长/吸光度/荧光列 → UV-Vis/PL");
      if (anyName(NYQUIST_RE)) {
        put("tpl-eis-nyquist", 90, "Z' 与 -Z'' 数值列 → EIS Nyquist（同单位阻抗平面）");
      } else if (anyName(EIS_RE)) {
        put("tpl-eis-bode", 88, "频率列 + 阻抗列 → EIS Bode（log10 频率轴，非正值剔除并告警）");
      }
      if (anyName(CV_RE)) put("tpl-cv", 85, "检测到电位/电流循环列 → CV 曲线");
      if (anyName(STRESS_RE)) put("tpl-stress-strain", 85, "检测到应变/应力列 → 应力-应变曲线");
      if (anyName(PSD_RE)) put("tpl-particle-size", 85, "检测到粒径列 → 粒径分布直方图");
    }

    var out = [];
    _templates.forEach(function (t) {
      var capability = templateCapability(t);
      if (!capability.can_apply) return;
      var s = scored[t.id];
      out.push({
        template_id: t.id,
        score: s ? s.score : 0,
        reasons: s ? s.reasons.slice() : [],
        capability: capability
      });
    });
    // Stable sort: equal scores keep the template-table order.
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, n);
  }

  // ------------------------------------------------ templateFromStats

  function _xpsFitName(name) {
    return /(^|[^a-z])fit([^a-z]|$)|拟合/i.test(name) &&
      !/baseline|基线|component|组分|(^|[^a-z])comp([._\- ]?\d+|[a-z])?([^a-z]|$)/i.test(name);
  }

  function _mappingPreference(tpl, slot, desc) {
    var scope = tpl.id + " " + desc + " " +
      (tpl.characterization && tpl.characterization.technique || "");
    if (slot === "fit") return function (c) { return _xpsFitName(c.name); };
    if (slot === "baseline") return function (c) { return /baseline|基线/i.test(c.name); };
    if (/^comp\d*$/.test(slot)) {
      return function (c) { return /component|组分|(^|[^a-z])comp([._\- ]?\d+|[a-z])?([^a-z]|$)/i.test(c.name); };
    }
    if (slot === "x" && XPS_RE.test(scope)) return function (c) { return XPS_RE.test(c.name); };
    if (slot === "x" && RAMAN_RE.test(scope)) return function (c) { return RAMAN_RE.test(c.name); };
    if (slot === "x" && XRD_RE.test(scope)) return function (c) { return XRD_RE.test(c.name); };
    if (slot === "x" && FTIR_RE.test(scope)) return function (c) { return FTIR_RE.test(c.name); };
    if (slot === "x" && NMR_RE.test(scope)) return function (c) { return NMR_RE.test(c.name); };
    if (slot === "x" && UVPL_RE.test(scope)) return function (c) { return UVPL_RE.test(c.name); };
    if (slot === "x" && CV_RE.test(scope)) return function (c) { return /potential|电位/i.test(c.name); };
    if (slot === "x" && STRESS_RE.test(scope)) return function (c) { return /strain|应变/i.test(c.name); };
    if (slot === "x" && EIS_RE.test(scope)) return function (c) { return NYQUIST_RE.test(c.name) || /freq|频率/i.test(c.name); };
    if (slot === "x" && PSD_RE.test(scope)) return function (c) { return PSD_RE.test(c.name); };
    if (slot === "y" && /原始强度|强度数值|电流数值|应力数值|信号强度/.test(desc)) {
      return function (c) {
        return /(^|[^a-z])(intensity|counts?|signal|current|stress)([^a-z]|$)|强度|电流|应力/i.test(c.name) &&
          !_xpsFitName(c.name) && !/baseline|基线|component|组分|(^|[^a-z])comp([._\- ]?\d+|[a-z])?([^a-z]|$)/i.test(c.name);
      };
    }
    if (/log2|fold|倍数/i.test(desc)) return function (c) { return LOG2FC_RE.test(c.name); };
    if (/log10|p ?值|pval|p[._\- ]?val|padj|q ?值|qval|fdr|显著/i.test(desc)) {
      return function (c) { return PVAL_RE.test(c.name); };
    }
    if (/时间|序号/.test(desc)) return function (c) { return TIME_RE.test(c.name); };
    if (/分组|模型|个体|条件|系列/.test(desc)) return function (c) { return c.nunique >= 2 && c.nunique <= 6; };
    if (/类别|集合|源|目标/.test(desc)) return function (c) { return c.nunique >= 2; };
    return null;
  }

  // Resolve template.default_mapping slots to concrete column names using
  // column kinds, semantic slots and declared column names. Generic numeric
  // fallback is allowed only with an explicit ambiguity warning.
  function _resolveMapping(tpl, columns, rows, warnings) {
    var infos = _dataKinds(columns, rows);
    var used = {};
    var numericPool = infos.filter(function (c) { return c.numeric; });
    var catPool = infos.filter(function (c) { return !c.numeric; });

    function take(pool, preferFn, allowFallback) {
      var chosen = null;
      var i;
      if (preferFn) {
        for (i = 0; i < pool.length; i++) {
          if (!used[pool[i].index] && preferFn(pool[i])) { chosen = pool[i]; break; }
        }
      }
      if (!chosen && allowFallback !== false) {
        for (i = 0; i < pool.length; i++) {
          if (!used[pool[i].index]) { chosen = pool[i]; break; }
        }
      }
      if (chosen) used[chosen.index] = true;
      return chosen;
    }

    function fallbackWarning(slot, desc, chosen, kind) {
      if (!chosen) return;
      warnings.push("模板「" + tpl.name + "」的映射「" + slot + "」（" + desc +
        "）未能按角色和列名确定，已使用通用" + kind + "列「" + chosen.name +
        "」兜底；请人工确认，这不是语义角色识别结果");
    }

    function preferredName(pool, preferFn) {
      if (!preferFn) return null;
      for (var i = 0; i < pool.length; i++) {
        if (!used[pool[i].index] && preferFn(pool[i])) return pool[i];
      }
      return null;
    }

    function accept(chosen) {
      if (chosen) used[chosen.index] = true;
      return chosen;
    }

    var mapping = {};
    var dm = _isObj(tpl.default_mapping) ? tpl.default_mapping : {};
    Object.keys(dm).forEach(function (slot) {
      var desc = dm[slot];
      if (desc == null) { mapping[slot] = null; return; }
      desc = String(desc);
      var prefer = _mappingPreference(tpl, slot, desc);
      var scope = tpl.id + " " + (tpl.characterization && tpl.characterization.technique || "");
      if (slot === "group" && CV_RE.test(scope)) {
        var cycleName = /cycle|循环|scan|圈/i;
        var cvCat = preferredName(catPool, function (c) {
          return cycleName.test(c.name) && c.nunique >= 1 && c.nunique <= 6;
        });
        var cvNum = preferredName(numericPool, function (c) {
          return cycleName.test(c.name) && c.nunique >= 1 && c.nunique <= 6;
        });
        var cvGroup = accept(cvCat || cvNum);
        if (!cvGroup) {
          cvGroup = take(catPool, prefer, false) || take(numericPool, function (c) {
            return c.nunique >= 1 && c.nunique <= 6;
          }, false);
          fallbackWarning(slot, desc, cvGroup, cvGroup && cvGroup.numeric ? "数值分组" : "类别分组");
        }
        mapping.group = cvGroup ? cvGroup.name : null;
        if (!cvGroup) warnings.push("模板「" + tpl.name + "」缺少可识别的 CV 循环/样品分组列；数字 cycle 仅接受基数 1–6，该映射置为 null");
        return;
      }
      if (/可选/.test(desc)) {
        var any = take(numericPool) || take(catPool);
        fallbackWarning(slot, desc, any, any && any.numeric ? "数值" : "类别");
        mapping[slot] = any ? any.name : null;
        if (!any) warnings.push("模板「" + tpl.name + "」没有可用于可选映射「" + slot + "」的列，该映射置为 null");
        return;
      }
      var isNumSlot = /数值|占比|权重|效应|CI|log2FC|log10|PC[12]|FPR|TPR|生存率|size/i.test(desc);
      if (isNumSlot) {
        var named = preferredName(numericPool, prefer);
        var ncol = named ? accept(named) : take(numericPool);
        if (!named) fallbackWarning(slot, desc, ncol, "数值");
        if (ncol) {
          mapping[slot] = ncol.name;
        } else {
          mapping[slot] = null;
          warnings.push("模板「" + tpl.name + "」缺少适合『" + desc + "』的数值列，该映射置为 null");
        }
      } else {
        var namedCat = preferredName(catPool, prefer);
        var ccol = namedCat ? accept(namedCat) : take(catPool);
        if (!namedCat) fallbackWarning(slot, desc, ccol, "类别");
        if (ccol) {
          mapping[slot] = ccol.name;
        } else {
          mapping[slot] = null;
          warnings.push("模板「" + tpl.name + "」缺少适合『" + desc + "』的类别列，该映射置为 null");
        }
      }
    });
    return mapping;
  }

  function templateFromStats(templateId, data, opts) {
    _requireLoaded();
    if (typeof templateId !== "string" || !templateId) {
      _fail("templateFromStats 的 templateId 必须为非空字符串");
    }
    var tpl = template(templateId);
    if (!tpl) _fail("未找到模板：" + templateId);
    var applicability = validateTemplateCapability(tpl);
    if (!applicability.ok) {
      _fail("模板「" + tpl.name + "」不可应用：" + applicability.errors.join("；"));
    }
    var capability = applicability.capability;
    if (opts == null) opts = {};
    if (!_isObj(opts)) _fail("opts 必须是对象");
    if (opts.legend !== undefined && ["none", "right", "top", "bottom"].indexOf(opts.legend) < 0) {
      _fail("opts.legend 必须是 none/right/top/bottom");
    }
    if (opts.mapping !== undefined && opts.mapping !== null) {
      if (!_isObj(opts.mapping)) _fail("opts.mapping 必须是 {槽位: 列名|null} 对象");
      if (!data || !_isObj(data) || !Array.isArray(data.columns)) {
        _fail("opts.mapping 需要同时提供 data（{columns, rows}）");
      }
    }

    if (tpl.category === "diagram") {
      if (!global.FigDiagram || typeof global.FigDiagram.build !== "function") _fail("FigDiagram 未加载，示意图保持不可应用");
      if (!opts.schematic || typeof opts.schematic !== "object" || Array.isArray(opts.schematic)) {
        _fail("MISSING_MATERIALS: 示意图模板需要 opts.schematic={id,nodes,relations,sources,...}；不从模板名或表格猜实体、方向与来源");
      }
      var rawSpec = opts.schematic;
      rawSpec = JSON.parse(JSON.stringify(rawSpec));
      rawSpec.id = rawSpec.id || templateId;
      rawSpec.template_id = templateId;
      var emptySchematicDoc = {schema_version:"1.0",id:"template-schematic",title:"",
        canvas:{width_mm:183,height_mm:110,dpi:300,background:"#FFFFFF"},elements:[],panels:[],anchors:[],history:[],
        meta:{created:"1970-01-01T00:00:00.000Z",updated:"1970-01-01T00:00:00.000Z",provenance:[],diagrams:{}}};
      var schematicBuilt = global.FigDiagram.build(emptySchematicDoc, rawSpec);
      return {elements:schematicBuilt.doc.elements,chart:null,
        warnings:schematicBuilt.warnings.concat(["这是由原始节点/关系参数生成的可编辑矢量，不是数据驱动图表；示例标签不是论文内容。"]),
        capability:capability,data_bound:false,diagram_meta:schematicBuilt.doc.meta.diagrams[rawSpec.id],
        schematic_contract:schematicBuilt.doc.meta.diagrams[rawSpec.id].contract};
    }

    var warnings = [];
    var journalId = opts.journal_id != null ? opts.journal_id : (tpl.journal_default || null);
    var paletteId = opts.palette_id != null ? opts.palette_id : (tpl.palette_default || null);

    // Canvas geometry from the journal preset (defaults: 120x90mm).
    var W = 120;
    var H = 90;
    var fontFamily = "Arial";
    var basePt = 8;
    if (journalId) {
      var preset = journal(journalId);
      if (!preset) {
        warnings.push("未找到期刊预设「" + journalId + "」，使用默认 120×90mm 画布");
      } else {
        W = preset.width_mm;
        H = preset.height_mm != null ? preset.height_mm : Math.round(preset.width_mm * 0.75);
        if (preset.font_family) fontFamily = preset.font_family;
        if (preset.base_font_pt) basePt = preset.base_font_pt;
      }
    }
    if (paletteId && _isObj(global.FigPalette) &&
        typeof global.FigPalette.get === "function" && !global.FigPalette.get(paletteId)) {
      warnings.push("未找到配色「" + paletteId + "」，图表将使用渲染默认颜色");
    }

    var isComposite = capability.status === "layout";
    var needData = capability.status === "full";

    var columns = [];
    var rows = [];
    if (data != null) {
      if (!_isObj(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
        _fail("data 需要 {columns: [...], rows: [[...]]} 结构");
      }
      columns = data.columns;
      rows = data.rows;
    }
    if (needData && columns.length === 0) {
      warnings.push("模板「" + tpl.name + "」没有可用数据列，生成 mapping 为空的显式空骨架（未绑定数据，不是已生成图表）；不会凭空恢复或绑定数据");
    } else if (needData && rows.length === 0) {
      warnings.push("数据没有数据行，生成未绑定有效数据行的空骨架，不视为已生成图表");
    } else if (isComposite) {
      warnings.push("模板「" + tpl.name + "」只创建空白复合版式，不自动填图；即使传入数据也不会绑定到各面板");
    }

    var mapping = needData && columns.length ? _resolveMapping(tpl, columns, rows, warnings) : {};

    // R02：用户确认的字段映射优先。规则＝「用户确认值优先；未提供才用推断」：
    // 槽位必须是模板 default_mapping 声明的槽；字符串值必须是真实列名；
    // null 显式清空该槽。校验失败立即抛错（不静默回退推断，否则向导里
    // 用户看到的映射与实际生成的图表不一致）。
    if (_isObj(opts.mapping) && needData && columns.length) {
      var allowedSlots = _isObj(tpl.default_mapping) ? Object.keys(tpl.default_mapping) : [];
      Object.keys(opts.mapping).forEach(function (slot) {
        if (allowedSlots.indexOf(slot) < 0) {
          _fail("opts.mapping 的槽位「" + slot + "」不是模板「" + tpl.name +
            "」声明的映射槽（可用：" + (allowedSlots.join("、") || "无") + "）");
        }
        var v = opts.mapping[slot];
        if (v === undefined) return;
        if (v === null) {
          mapping[slot] = null;
          return;
        }
        if (typeof v !== "string" || columns.indexOf(v) < 0) {
          _fail("opts.mapping." + slot + " 引用的列「" + v + "」在数据列中不存在");
        }
        mapping[slot] = v;
      });
    }

    // --- characterization 骨架（表征谱图模板）---
    // tpl.characterization.curves[].column 引用 default_mapping 的槽名；
    // 在这里解析为真实数据列。解析不到的曲线明确告警并移除（不猜列、
    // 不留悬空引用）；校验失败时降级为普通图表并如实告警。
    var charSpec = null;
    if (_isObj(tpl.characterization)) {
      charSpec = _deepCopy(tpl.characterization);
      if (Array.isArray(charSpec.curves)) {
        var keptCurves = [];
        charSpec.curves.forEach(function (cu) {
          if (!_isObj(cu)) return;
          var slot = typeof cu.column === "string" ? cu.column : "";
          var resolved = (slot && _isObj(mapping) && mapping[slot] !== undefined && mapping[slot] !== null)
            ? mapping[slot] : null;
          if (resolved) {
            keptCurves.push({ role: cu.role, column: resolved, label: cu.label || null });
          } else {
            warnings.push("模板「" + tpl.name + "」的 " + (cu.role || "?") +
              " 曲线列（映射槽「" + slot + "」）未能在数据中解析，已从 characterization.curves 移除；请在属性面板手动指定列");
          }
        });
        charSpec.curves = keptCurves;
      }
      if (global.FigData && typeof global.FigData.normalizeCharacterization === "function") {
        var chk = global.FigData.normalizeCharacterization(charSpec, columns);
        if (!chk.ok) {
          warnings.push("模板「" + tpl.name + "」的 characterization 校验失败（" +
            chk.errors.join("；") + "），已降级为普通图表");
          charSpec = null;
        }
      }
    }
    var panelCount = ((Array.isArray(tpl.panels) && tpl.panels[0]) || 1) *
      ((Array.isArray(tpl.panels) && tpl.panels[1]) || 1);
    if (panelCount > 1 && columns.length) {
      warnings.push("多面板模板把同一数据列默认映射到所有面板（源列歧义）：请逐面板确认 mapping 与曲线列后再出图");
    }

    // --- build elements: panel container + optional title + chart(s) ---
    var els = [];
    var margin = 4;
    var titleH = 8;
    var hasTitle = typeof opts.title === "string" && opts.title.length > 0;
    var topY = margin + (hasTitle ? titleH + 4 : 0);
    var panelW = W - margin * 2;
    var panelH = H - topY - margin;
    var cols = (Array.isArray(tpl.panels) && tpl.panels[0]) || 1;
    var rowsN = (Array.isArray(tpl.panels) && tpl.panels[1]) || 1;

    var panelId = _uid("panel");
    var panelEl = {
      id: panelId,
      name: tpl.name,
      type: "panel",
      z: 0,
      transform: { x: margin, y: topY, w: panelW, h: panelH, rotation: 0 },
      style: {},
      children: [],
      panelLayout: {
        cols: cols,
        rows: rowsN,
        gap_mm: 2,
        padding_mm: 2,
        label: null,
        labelPosition: "top-left",
        labelStyle: { fontSizePt: Math.max(basePt, 8), fontWeight: "bold" }
      },
      clip: false
    };
    els.push(panelEl);

    if (hasTitle) {
      els.push({
        id: _uid("text"),
        type: "text",
        z: 2,
        transform: { x: margin, y: margin, w: panelW, h: titleH, rotation: 0 },
        style: {
          fontFamily: fontFamily,
          fontSizePt: Math.max(basePt + 1, 9),
          fontWeight: "bold",
          textAlign: "center",
          textAnchor: "middle",
          verticalAlign: "middle"
        },
        text: opts.title
      });
    }

    // Chart(s) laid out on the panel grid.
    var pad = 2;
    var gap = 2;
    var innerX = margin + pad;
    var innerY = topY + pad;
    var innerW = panelW - pad * 2;
    var innerH = panelH - pad * 2;
    var cellW = (innerW - gap * (cols - 1)) / cols;
    var cellH = (innerH - gap * (rowsN - 1)) / rowsN;
    var total = cols * rowsN;
    var firstChart = null;

    for (var i = 0; i < total; i++) {
      var cx = i % cols;
      var cy = Math.floor(i / cols);
      var label = String.fromCharCode(97 + (i % 26));
      var chartSpec;
      if (isComposite) {
        // Composite skeletons carry no chartType until the user fills panels.
        chartSpec = {};
      } else {
        chartSpec = {
          chartType: tpl.chart_type,
          data: { inline: { columns: columns, rows: rows }, ref: null },
          mapping: _deepCopy(mapping),
          axes: {},
          paletteId: paletteId || null,
          legend: opts.legend !== undefined ? opts.legend :
            ((mapping && mapping.group) || (charSpec && charSpec.curves.length) ? "right" : "none"),
          showValues: false
        };
        if (charSpec) chartSpec.characterization = _deepCopy(charSpec);
        if (firstChart === null) firstChart = chartSpec;
      }
      var chartEl = {
        id: _uid("chart"),
        name: "(" + label + ")",
        type: "chart",
        z: 1,
        parent_id: panelId,
        transform: {
          x: _round2(innerX + cx * (cellW + gap)),
          y: _round2(innerY + cy * (cellH + gap)),
          w: _round2(cellW),
          h: _round2(cellH),
          rotation: 0
        },
        style: {},
        chart: chartSpec
      };
      els.push(chartEl);
      panelEl.children.push(chartEl.id);
    }

    return {
      elements: els,
      chart: firstChart,
      warnings: warnings,
      capability: capability,
      data_bound: needData && columns.length > 0 && rows.length > 0
    };
  }

  // ------------------------------------------------ R07 期刊规则证据与检查
  //
  // journals.json 的 rules[] 每条带官方 URL/核查日期/适用范围/等级/依据；
  // verification != "verified" 的规则即使测量达标也只给 unknown（规则本身
  // 未确认）。未执行的检查不产生 pass；无可测对象 → not_applicable。
  // level=required 违反 → fail；level=recommended 违反 → warning。

  function journalRules(journalId) {
    _requireLoaded();
    if (journalId == null) return _rules.slice();
    if (typeof journalId !== "string") _fail("journalRules 的 journalId 必须为字符串");
    return _rules.filter(function (r) {
      return Array.isArray(r.journal_ids) && r.journal_ids.indexOf(journalId) >= 0;
    });
  }

  function _minFontSizeOf(doc) {
    var min = null;
    (doc.elements || []).forEach(function (el) {
      if (!el) return;
      var candidates = [];
      if (el.type === "text" && el.style && typeof el.style.fontSizePt === "number") {
        candidates.push(el.style.fontSizePt);
      }
      var pres = el.chart && el.chart.presentation;
      if (pres) {
        ["axes", "legend", "series", "peaks"].forEach(function () { /* noop */ });
        if (pres.axes) ["x", "y"].forEach(function (ax) {
          var a = pres.axes[ax];
          if (a && a.title && typeof a.title.fontSizePt === "number") candidates.push(a.title.fontSizePt);
          if (a && a.tick && typeof a.tick.fontSizePt === "number") candidates.push(a.tick.fontSizePt);
        });
        if (pres.legend && typeof pres.legend.fontSizePt === "number") candidates.push(pres.legend.fontSizePt);
        if (pres.peaks) Object.keys(pres.peaks).forEach(function (id) {
          if (pres.peaks[id] && typeof pres.peaks[id].fontSizePt === "number") {
            candidates.push(pres.peaks[id].fontSizePt);
          }
        });
      }
      candidates.forEach(function (v) {
        if (min === null || v < min) min = v;
      });
    });
    return min; // null = 文档无可测字号（图表内部默认字号不在元素上，保持 unknown）
  }

  function _maxFontSizeOf(doc) {
    var max = null;
    (doc.elements || []).forEach(function (el) {
      if (el && el.type === "text" && el.style && typeof el.style.fontSizePt === "number") {
        if (max === null || el.style.fontSizePt > max) max = el.style.fontSizePt;
      }
    });
    return max;
  }

  function _minStrokeWidthOf(doc) {
    var min = null;
    (doc.elements || []).forEach(function (el) {
      if (el && el.style && typeof el.style.strokeWidthPt === "number") {
        if (min === null || el.style.strokeWidthPt < min) min = el.style.strokeWidthPt;
      }
    });
    return min;
  }

  // 位图有效 DPI：仅对带像素尺寸记录的 image 元素可测（pxWidth/pxWidth 由
  // 导入时记录）；无记录 → null（unknown，不用 dpi 标签冒充）。
  function _minRasterDpiOf(doc) {
    var min = null, anyImage = false;
    (doc.elements || []).forEach(function (el) {
      if (!el || el.type !== "image") return;
      anyImage = true;
      if (typeof el.pxWidth !== "number" || typeof el.pxHeight !== "number") return;
      var wMm = el.transform && el.transform.w;
      if (!(wMm > 0)) return;
      var dpi = el.pxWidth / (wMm / 25.4);
      if (min === null || dpi < min) min = dpi;
    });
    return { dpi: min, anyImage: anyImage };
  }

  function checkJournalRules(doc, opts) {
    _requireLoaded();
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      _fail("checkJournalRules 需要有效的 doc");
    }
    opts = opts || {};
    var appliedId = (doc.canvas && doc.canvas.journal_preset_id) ||
      (doc.meta && doc.meta.journal_preset_id) || null;
    // 检查目标：显式指定 > 文档已套用的预设
    var targetId = typeof opts.journal_id === "string" ? opts.journal_id : appliedId;
    if (!targetId) {
      return {
        ok: true, journal_id: null, results: [],
        note: "文档未套用期刊预设；可传 opts.journal_id 显式指定检查目标"
      };
    }
    var rules = journalRules(targetId);
    if (!rules.length) {
      return {
        ok: true, journal_id: targetId, results: [],
        note: "该预设暂无逐条证据规则（沿用预设默认值，投稿前自行核对官方指南）"
      };
    }
    var minFont = _minFontSizeOf(doc);
    var maxFont = _maxFontSizeOf(doc);
    var minStroke = _minStrokeWidthOf(doc);
    var raster = _minRasterDpiOf(doc);
    var canvas = doc.canvas || {};
    var results = rules.map(function (rule) {
      var measured = null, comparable = false, violates = false, applicable = true;
      switch (rule.property) {
        case "figure_width":
          measured = typeof canvas.width_mm === "number" ? canvas.width_mm : null;
          comparable = measured !== null;
          break;
        case "figure_height":
          measured = typeof canvas.height_mm === "number" ? canvas.height_mm : null;
          comparable = measured !== null;
          break;
        case "min_font_size":
          measured = minFont;
          comparable = measured !== null;
          break;
        case "max_font_size":
          measured = maxFont;
          comparable = measured !== null;
          break;
        case "line_width":
          measured = minStroke;
          comparable = measured !== null;
          break;
        case "raster_dpi":
          measured = raster.dpi;
          comparable = measured !== null;
          applicable = raster.anyImage; // 无位图素材 → not_applicable
          break;
        default:
          comparable = false;
      }
      if (comparable) {
        var tol = typeof rule.tolerance === "number" ? rule.tolerance : 0;
        if (rule.operator === "equal") violates = Math.abs(measured - rule.value) > tol;
        else if (rule.operator === "min") violates = measured < rule.value;
        else if (rule.operator === "max") violates = measured > rule.value;
      }
      var status;
      if (!applicable) status = "not_applicable";
      else if (rule.verification !== "verified") status = "unknown";
      else if (!comparable) status = "unknown";
      else if (violates) status = (rule.level === "required") ? "fail" : "warning";
      else status = "pass";
      var suggestion = null;
      if (status === "fail" || status === "warning") {
        suggestion = "调整 " + rule.property + "（当前 " + (measured === null ? "未知" : measured) +
          " " + (rule.unit || "") + "，要求 " + rule.operator + " " + rule.value + "）";
      } else if (status === "unknown" && rule.verification !== "verified") {
        suggestion = "规则值未经官方页面直接核对（" + rule.sourceUrl + "），投稿前自行确认";
      } else if (status === "unknown") {
        suggestion = "文档中无可测量的 " + rule.property + " 对象";
      }
      return {
        rule_id: rule.id, property: rule.property, level: rule.level,
        status: status, measured: measured, required: rule.value,
        unit: rule.unit || null, operator: rule.operator,
        verification: rule.verification, source_url: rule.sourceUrl || null,
        checked_at: rule.checkedAt || null, evidence: rule.evidence || null,
        suggestion: suggestion
      };
    });
    var hardFail = results.some(function (r) { return r.status === "fail"; });
    return {
      ok: !hardFail,
      journal_id: targetId,
      results: results,
      counts: {
        pass: results.filter(function (r) { return r.status === "pass"; }).length,
        fail: results.filter(function (r) { return r.status === "fail"; }).length,
        warning: results.filter(function (r) { return r.status === "warning"; }).length,
        unknown: results.filter(function (r) { return r.status === "unknown"; }).length,
        not_applicable: results.filter(function (r) { return r.status === "not_applicable"; }).length
      }
    };
  }

  // ---------------------------------------------------------- exports

  // R02：图型渲染语义（与 lib/data.js RENDERS 实际行为对应，改动渲染
  // 聚合方式必须同步这里）。向导用它在确认页如实展示统计含义。
  var RENDERER_SEMANTICS = {
    bar: { required: ["x", "y"], aggregation: "category_mean",
      note: "同一分类的重复观测取均值（mean）；误差线来自 chart.statistics 或用户误差列" },
    bar_grouped: { required: ["x", "y", "group"], aggregation: "cell_mean",
      note: "分类×分组单元格内重复观测取均值（mean）" },
    pie: { required: ["x", "y"], aggregation: "category_sum",
      note: "同一分类求和（sum）后归一化为占比" },
    line: { required: ["x", "y"], aggregation: "none",
      note: "不聚合：按 x 排序连线；非数值 y 行被排除" },
    line_multi: { required: ["x", "y", "group"], aggregation: "none",
      note: "不聚合：按 group 拆系列，各自按 x 排序连线" },
    area: { required: ["x", "y"], aggregation: "none",
      note: "不聚合：按 x 排序填充面积" },
    scatter: { required: ["x", "y"], aggregation: "none",
      note: "不聚合：逐行绘制散点；非数值行被排除" },
    histogram: { required: ["x"], aggregation: "binning",
      note: "对 x 数值列分箱计数" },
    heatmap: { required: ["x", "y", "color"], aggregation: "cell_value",
      note: "x×y 类别网格，每格取该 (x,y) 的 color 值" },
    box: { required: ["x", "y"], aggregation: "distribution",
      note: "按 x 分组绘制 y 分布（中位数/四分位，原始值参与计算）" }
  };

  // R02：模板映射槽位定义（向导据此渲染可编辑下拉）。
  // optional 判定沿用 default_mapping 描述里的「可选」标记。
  function mappingSlots(templateId) {
    var tpl = template(templateId);
    if (!tpl) _fail("未找到模板：" + templateId);
    var dm = _isObj(tpl.default_mapping) ? tpl.default_mapping : {};
    return Object.keys(dm).map(function (slot) {
      var desc = dm[slot] == null ? "" : String(dm[slot]);
      return {
        slot: slot,
        description: desc,
        optional: !desc || /可选/.test(desc),
        numeric: /数值|占比|权重|效应|CI|log2FC|log10|PC[12]|FPR|TPR|生存率|size/i.test(desc)
      };
    });
  }

  var FigPresets = {
    load: load,
    journals: journals,
    journal: journal,
    templates: templates,
    template: template,
    templateCapability: templateCapability,
    validateTemplateCapability: validateTemplateCapability,
    pxPerMm: pxPerMm,
    applyCanvas: applyCanvas,
    check: check,
    scaleFonts: scaleFonts,
    inferColumns: inferColumns,
    recommend: recommend,
    templateFromStats: templateFromStats,
    mappingSlots: mappingSlots,
    RENDERER_SEMANTICS: RENDERER_SEMANTICS,
    journalRules: journalRules,
    checkJournalRules: checkJournalRules
  };

  // Older data.js revisions decorate these methods after load. The registry is
  // now implemented here, so do not let that compatibility shim replace the
  // structured public fields or create a second application policy.
  Object.defineProperty(FigPresets, "__figDataCapabilities", {
    value: true, enumerable: false, configurable: false
  });

  global.FigPresets = FigPresets;
})(typeof globalThis !== "undefined" ? globalThis : this);
