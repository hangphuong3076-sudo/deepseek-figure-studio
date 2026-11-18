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
  var _styles = null;     // deep copy of styles.json styles array (可选)
  var _diagramThemes = null; // deep copy of diagram_themes.json themes (可选)
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
  var XRD_RE = /(2\s*θ|2.{0,2}theta|xrd|衍射)/i;
  var FTIR_RE = /(wavenumber|波数|ftir|红外|transmittance|透射率|透过率)/i;
  var NMR_RE = /(chemical[.\-_ ]?shift|化学位移|(?<![a-z])ppm(?![a-z])|(?<![a-z])nmr(?![a-z]))/i;
  var UVPL_RE = /(wavelength|absorbance|吸光度|波长|photoluminesc|(?<![a-z])pl(?![a-z])[_ ]|emission|荧光|uv[.\-_ ]?vis)/i;
  var NYQUIST_RE = /(z[’'′]|zprime|z_?re|re\(z\)|[-−]z.{0,3}(im|prime|double)|z[”''″]{1,2}|zimag|z_?im)/i;
  var EIS_RE = /(impedance|阻抗|(?<![a-z])eis(?![a-z])|freq|频率)/i;
  var CV_RE = /(voltammet|循环伏安|potential|电位|(?<![a-z])cv(?![a-z])[_ ])/i;
  var STRESS_RE = /(stress|strain|应力|应变)/i;
  var PSD_RE = /(particle|粒径|粒度|size[.\-_ ]?(dist|distrib)|size[._\-]?nm|diameter|直径|(?<![a-z])d(10|50|90)(?![a-z]))/i;
  // R7：电化学/统计模板的列名规则——与上方 technique 正则同一机制
  // （只认用户列名声明，不从数值推断技术）。
  var LSV_RE = /(linear[.\-_ ]?sweep|(?<![a-z])lsv(?![a-z])|过电位|overpotential|current[.\-_ ]?density|电流密度)/i;
  var BATT_RE = /(capacity|容量|mAh|voltage|电压|cycle|循环|coulombic|库仑|efficiency|效率)/i;
  var TAFEL_RE = /(tafel|exchange[.\-_ ]?current|交换电流|overpotential|过电位)/i;
  var BET_RE = /(bet|isotherm|等温线|relative[.\-_ ]?pressure|相对压力|adsorb|吸附|desorb|脱附)/i;
  var TGA_RE = /(thermogravimetric|失重|weight[.\-_ ]?loss|derivative[.\-_ ]?weight|(?<![a-z])(?:tga|dtg)(?![a-z]))/i;
  var XAS_RE = /(xanes|xas|吸收边|normalized[.\-_ ]?(absorption|edge)|归一化吸收|fluorescence[.\-_ ]?yield)/i;

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

  // R7：chart_overrides 深合并——普通对象递归合并，数组/标量整体替换；
  // dst 不被修改（返回新对象）。
  function _mergeDeep(dst, src) {
    var out = _deepCopy(dst);
    Object.keys(src || {}).forEach(function (k) {
      var sv = src[k];
      if (_isObj(sv) && _isObj(out[k])) {
        out[k] = _mergeDeep(out[k], sv);
      } else {
        out[k] = _deepCopy(sv);
      }
    });
    return out;
  }

  function _round2(v) {
    return Math.round(v * 100) / 100;
  }

  // 告警文案里的元素称呼：优先名称，其次类型中文名（不直接暴露元素 id）
  function _elLabel(el) {
    if (!_isObj(el)) return "元素";
    if (typeof el.name === "string" && el.name.trim()) return el.name;
    if (global.FigDoc && typeof global.FigDoc.elementTypeName === "function") {
      return global.FigDoc.elementTypeName(el.type);
    }
    return String(el.type || "元素");
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
    // styles.json 可选：{styles:[...]} 或裸数组；缺省时 style()/styles() 返回空
    var sv = bundle.styles;
    if (Array.isArray(sv)) sv = { styles: sv };
    _styles = (_isObj(sv) && Array.isArray(sv.styles)) ? _deepCopy(sv.styles) : [];
    // R9：diagram_themes.json 可选：{themes:{id:theme}} 或 {id:theme}；
    // 缺省时 FigDiagram 回退到内核内置同名主题。
    var dt = bundle.diagramThemes || bundle.diagram_themes;
    if (Array.isArray(dt)) dt = { themes: dt };
    _diagramThemes = null;
    if (_isObj(dt)) {
      var raw = _isObj(dt.themes) ? dt.themes : dt;
      _diagramThemes = {};
      Object.keys(raw).forEach(function (k) {
        if (_isObj(raw[k])) _diagramThemes[k] = _deepCopy(raw[k]);
      });
    }
    // R7：模板扩展字段（chart_overrides/hints/preview/group）加载期校验，
    // 非法即 load 报错——宁可模板库整体不可用也不放行坏模板。
    _templates.forEach(_validateTemplateExtras);
  }

  // ------------------------------------------------ R7 模板扩展字段校验
  //
  // chart_overrides 只允许 {presentation, axes, characterization, style_id}；
  // 其中 references/bands/significance/letters 是图表级数据标注键、
  // characterization.peak_annotations 是峰位标注——这些数值必须由用户
  // 填写，模板里出现即拒绝（白名单之外的键同样拒绝）。

  var OV_KEYS = ["presentation", "axes", "characterization", "style_id"];
  var OV_DATA_KEYS = ["references", "bands", "significance", "letters"];
  var OV_PREVIEW_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  // 与 ops.js CP_* 白名单保持一致的子集（加载期只做结构+枚举校验；
  // 完整语义校验在 apply/渲染路径再跑一次）
  var OV_AXES_KEYS = ["xLabel", "yLabel", "xScale", "yScale", "gridlines", "y2",
    "xMin", "xMax", "yMin", "yMax"];
  var OV_AXES_SCALES = ["linear", "log"];
  var OV_PRES_KEYS = ["version", "axes", "legend", "series", "peaks", "plot", "points"];
  var OV_PRES_AXIS_KEYS = ["x", "y"];
  var OV_PRES_PART_KEYS = ["title", "tick"];
  var OV_PRES_TEXT_KEYS = ["fontSizePt", "color", "fontWeight", "hidden"];
  var OV_PRES_LEGEND_KEYS = ["position", "fontSizePt", "color", "frame"];
  var OV_PRES_LEGEND_POS = ["none", "right", "top", "bottom",
    "inside-tr", "inside-tl", "inside-br", "inside-bl", "inside-best", "inline"];
  var OV_PRES_SERIES_KEYS = ["stroke", "strokeWidthPt", "dash", "marker",
    "markerSizePt", "opacity", "hatch", "markerFill"];
  var OV_PRES_HATCH = ["/", "\\", "x", ".", "-", "|"];
  var OV_PRES_MARKERS = ["none", "circle", "square", "triangle", "diamond"];
  var OV_PRES_PEAK_KEYS = ["color", "fontSizePt"];
  var OV_PRES_PLOT_KEYS = ["frame", "tickDirection", "axisWidthPt", "tickLengthPt",
    "markerSizePt", "lineWidthPt", "markerFill", "markerCycle", "dashCycle",
    "background", "gridColor", "seriesColors", "componentFill", "errorStyle"];
  var OV_PRES_ERROR_STYLE = ["bars", "band"];
  var OV_PRES_PLOT_FRAME = ["open", "box"];
  var OV_PRES_TICKDIR = ["out", "in"];
  var OV_PRES_MARKER_FILL = ["solid", "hollow"];
  var OV_PRES_DASH_CYCLE = ["solid", "dash", "dot", "dashdot"];
  var OV_PRES_POINT_KEYS = ["fill", "sizePt", "opacity", "marker", "stroke", "strokeWidthPt"];
  var OV_PRES_POINT_MARKERS = ["circle", "square", "triangle", "diamond"];
  var OV_CHAR_KEYS = ["technique", "x_reverse", "x_scale", "x_label", "y_label",
    "curves", "fit_model", "fit_source", "normalize", "offset_each_series",
    "equal_aspect"]; // 注意：peak_annotations 故意不在列——模板禁止预置峰位
  var OV_CHAR_X_SCALES = ["linear", "log10"];
  var OV_CHAR_NORMALIZE = ["none", "max_to_unity"];
  var OV_FIT_SOURCES = ["provided_by_user_fit"];
  var OV_CURVE_ROLES = ["fit", "component", "baseline"];
  var OV_SC_MODE = ["gradient"];

  function _ovFail(tpl, msg) {
    _fail("模板「" + (tpl && tpl.id || "?") + "」" + msg);
  }
  function _ovIsObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function _ovKeysOnly(obj, allowed, where, tpl) {
    Object.keys(obj).forEach(function (k) {
      if (allowed.indexOf(k) < 0) _ovFail(tpl, "的 " + where + " 含不支持的键「" + k + "」");
    });
  }
  function _ovNum(v) { return typeof v === "number" && isFinite(v); }
  function _ovStr(v, max) { return typeof v === "string" && v.length <= (max || 400); }

  function _validateOvAxes(ax, where, tpl) {
    if (!_ovIsObj(ax)) _ovFail(tpl, "的 " + where + " 必须是对象");
    _ovKeysOnly(ax, OV_AXES_KEYS, where, tpl);
    ["xMin", "xMax", "yMin", "yMax"].forEach(function (k) {
      if (ax[k] !== undefined && ax[k] !== null && !_ovNum(ax[k])) {
        _ovFail(tpl, "的 " + where + "." + k + " 必须是数字或 null");
      }
    });
    ["xLabel", "yLabel"].forEach(function (k) {
      if (ax[k] !== undefined && ax[k] !== null && typeof ax[k] !== "string") {
        _ovFail(tpl, "的 " + where + "." + k + " 必须是字符串");
      }
    });
    ["xScale", "yScale"].forEach(function (k) {
      if (ax[k] !== undefined && ax[k] !== null && OV_AXES_SCALES.indexOf(ax[k]) < 0) {
        _ovFail(tpl, "的 " + where + "." + k + " 只允许 " + OV_AXES_SCALES.join("/") + "，收到「" + ax[k] + "」");
      }
    });
    if (ax.gridlines !== undefined && ax.gridlines !== null && typeof ax.gridlines !== "boolean") {
      _ovFail(tpl, "的 " + where + ".gridlines 必须是 true/false");
    }
    if (ax.y2 !== undefined && ax.y2 !== null) {
      if (!_ovIsObj(ax.y2) || !Array.isArray(ax.y2.series) ||
          ax.y2.series.some(function (s) { return typeof s !== "string" || !s; })) {
        _ovFail(tpl, "的 " + where + ".y2 需要 {series:[系列名…], label?, min?, max?}");
      }
    }
  }

  function _validateOvPres(pres, where, tpl) {
    if (!_ovIsObj(pres)) _ovFail(tpl, "的 " + where + " 必须是对象");
    _ovKeysOnly(pres, OV_PRES_KEYS, where, tpl);
    if (pres.version !== undefined && pres.version !== 1) {
      _ovFail(tpl, "的 " + where + ".version 只允许 1");
    }
    if (pres.axes !== undefined) {
      if (!_ovIsObj(pres.axes)) _ovFail(tpl, "的 " + where + ".axes 必须是对象");
      _ovKeysOnly(pres.axes, OV_PRES_AXIS_KEYS, where + ".axes", tpl);
      OV_PRES_AXIS_KEYS.forEach(function (ax) {
        var a = pres.axes[ax];
        if (a === undefined) return;
        if (!_ovIsObj(a)) _ovFail(tpl, "的 " + where + ".axes." + ax + " 必须是对象");
        _ovKeysOnly(a, OV_PRES_PART_KEYS, where + ".axes." + ax, tpl);
        ["title", "tick"].forEach(function (part) {
          var p = a[part];
          if (p === undefined) return;
          if (!_ovIsObj(p)) _ovFail(tpl, "的 " + where + ".axes." + ax + "." + part + " 必须是对象");
          Object.keys(p).forEach(function (pk) {
            if (OV_PRES_TEXT_KEYS.indexOf(pk) < 0) {
              _ovFail(tpl, "的 " + where + ".axes." + ax + "." + part + " 含不支持的键「" + pk + "」");
            }
            if (pk === "hidden" && typeof p[pk] !== "boolean") {
              _ovFail(tpl, "的 " + where + ".axes." + ax + "." + part + ".hidden 必须是 true/false");
            }
            if (pk === "fontWeight" && ["normal", "bold"].indexOf(p[pk]) < 0) {
              _ovFail(tpl, "的 " + where + ".axes." + ax + "." + part + ".fontWeight 只允许 normal/bold");
            }
          });
        });
      });
    }
    if (pres.legend !== undefined) {
      if (!_ovIsObj(pres.legend)) _ovFail(tpl, "的 " + where + ".legend 必须是对象");
      _ovKeysOnly(pres.legend, OV_PRES_LEGEND_KEYS, where + ".legend", tpl);
      if (pres.legend.position !== undefined &&
          OV_PRES_LEGEND_POS.indexOf(pres.legend.position) < 0) {
        _ovFail(tpl, "的 " + where + ".legend.position 非法：「" + pres.legend.position + "」");
      }
    }
    if (pres.series !== undefined) {
      if (!_ovIsObj(pres.series)) _ovFail(tpl, "的 " + where + ".series 必须是对象");
      Object.keys(pres.series).forEach(function (sk) {
        var sv = pres.series[sk];
        if (!_ovIsObj(sv)) _ovFail(tpl, "的 " + where + ".series[" + sk + "] 必须是对象");
        _ovKeysOnly(sv, OV_PRES_SERIES_KEYS, where + ".series[" + sk + "]", tpl);
        if (sv.marker !== undefined && OV_PRES_MARKERS.indexOf(sv.marker) < 0) {
          _ovFail(tpl, "的 " + where + ".series[" + sk + "].marker 非法");
        }
        if (sv.hatch !== undefined && OV_PRES_HATCH.indexOf(sv.hatch) < 0) {
          _ovFail(tpl, "的 " + where + ".series[" + sk + "].hatch 非法：「" + sv.hatch + "」");
        }
        if (sv.markerFill !== undefined &&
            ["solid", "hollow"].indexOf(sv.markerFill) < 0) {
          _ovFail(tpl, "的 " + where + ".series[" + sk + "].markerFill 只允许 solid/hollow");
        }
      });
    }
    if (pres.peaks !== undefined) {
      if (!_ovIsObj(pres.peaks)) _ovFail(tpl, "的 " + where + ".peaks 必须是对象");
      Object.keys(pres.peaks).forEach(function (pk) {
        var pv = pres.peaks[pk];
        if (!_ovIsObj(pv)) _ovFail(tpl, "的 " + where + ".peaks[" + pk + "] 必须是对象");
        _ovKeysOnly(pv, OV_PRES_PEAK_KEYS, where + ".peaks[" + pk + "]", tpl);
      });
    }
    if (pres.plot !== undefined) {
      if (!_ovIsObj(pres.plot)) _ovFail(tpl, "的 " + where + ".plot 必须是对象");
      _ovKeysOnly(pres.plot, OV_PRES_PLOT_KEYS, where + ".plot", tpl);
      var pl = pres.plot;
      if (pl.frame !== undefined && OV_PRES_PLOT_FRAME.indexOf(pl.frame) < 0) _ovFail(tpl, "frame 非法");
      if (pl.tickDirection !== undefined && OV_PRES_TICKDIR.indexOf(pl.tickDirection) < 0) _ovFail(tpl, "tickDirection 非法");
      if (pl.markerFill !== undefined && OV_PRES_MARKER_FILL.indexOf(pl.markerFill) < 0) _ovFail(tpl, "markerFill 非法");
      if (pl.dashCycle !== undefined && OV_PRES_DASH_CYCLE.indexOf(pl.dashCycle) < 0) _ovFail(tpl, "dashCycle 非法");
      if (pl.errorStyle !== undefined && OV_PRES_ERROR_STYLE.indexOf(pl.errorStyle) < 0) _ovFail(tpl, "errorStyle 非法");
      if (pl.componentFill !== undefined && typeof pl.componentFill !== "boolean") _ovFail(tpl, "componentFill 必须是 true/false");
      if (pl.seriesColors !== undefined) {
        if (!_ovIsObj(pl.seriesColors)) _ovFail(tpl, "seriesColors 必须是对象");
        _ovKeysOnly(pl.seriesColors, ["mode", "palette", "reverse", "colorbar"], where + ".plot.seriesColors", tpl);
        if (pl.seriesColors.mode !== undefined && OV_SC_MODE.indexOf(pl.seriesColors.mode) < 0) {
          _ovFail(tpl, "seriesColors.mode 只允许 gradient");
        }
        if (pl.seriesColors.palette !== undefined && typeof pl.seriesColors.palette !== "string") {
          _ovFail(tpl, "seriesColors.palette 必须是配色 id 字符串");
        }
        if (pl.seriesColors.colorbar !== undefined) {
          if (!_ovIsObj(pl.seriesColors.colorbar)) _ovFail(tpl, "colorbar 必须是对象");
          _ovKeysOnly(pl.seriesColors.colorbar, ["show", "label", "min", "max"], where + ".plot.seriesColors.colorbar", tpl);
          if (pl.seriesColors.colorbar.show !== undefined && typeof pl.seriesColors.colorbar.show !== "boolean") {
            _ovFail(tpl, "colorbar.show 必须是 true/false");
          }
        }
      }
    }
    if (pres.points !== undefined) {
      if (!_ovIsObj(pres.points)) _ovFail(tpl, "的 " + where + ".points 必须是对象");
      Object.keys(pres.points).forEach(function (pk) {
        var pv = pres.points[pk];
        if (!_ovIsObj(pv)) _ovFail(tpl, "的 " + where + ".points[" + pk + "] 必须是对象");
        _ovKeysOnly(pv, OV_PRES_POINT_KEYS, where + ".points[" + pk + "]", tpl);
        if (pv.marker !== undefined && OV_PRES_POINT_MARKERS.indexOf(pv.marker) < 0) {
          _ovFail(tpl, "的 " + where + ".points[" + pk + "].marker 非法");
        }
      });
    }
  }

  function _validateOvChar(ch, where, tpl) {
    if (!_ovIsObj(ch)) _ovFail(tpl, "的 " + where + " 必须是对象");
    _ovKeysOnly(ch, OV_CHAR_KEYS, where, tpl);
    if (ch.technique !== undefined && ch.technique !== null && typeof ch.technique !== "string") {
      _ovFail(tpl, "的 " + where + ".technique 必须是字符串或 null");
    }
    ["x_reverse", "equal_aspect"].forEach(function (k) {
      if (ch[k] !== undefined && ch[k] !== null && typeof ch[k] !== "boolean") {
        _ovFail(tpl, "的 " + where + "." + k + " 必须是 true/false/null");
      }
    });
    // offset_each_series 是叠放位移量（有限数字，数据单位），不是开关
    if (ch.offset_each_series !== undefined && ch.offset_each_series !== null &&
        (typeof ch.offset_each_series !== "number" || !isFinite(ch.offset_each_series))) {
      _ovFail(tpl, "的 " + where + ".offset_each_series 必须是有限数字或 null");
    }
    if (ch.x_scale !== undefined && ch.x_scale !== null && OV_CHAR_X_SCALES.indexOf(ch.x_scale) < 0) {
      _ovFail(tpl, "的 " + where + ".x_scale 只允许 " + OV_CHAR_X_SCALES.join("/") + "，收到「" + ch.x_scale + "」");
    }
    ["x_label", "y_label", "fit_model"].forEach(function (k) {
      if (ch[k] !== undefined && ch[k] !== null && typeof ch[k] !== "string") {
        _ovFail(tpl, "的 " + where + "." + k + " 必须是字符串或 null");
      }
    });
    if (ch.fit_source !== undefined && ch.fit_source !== null && OV_FIT_SOURCES.indexOf(ch.fit_source) < 0) {
      _ovFail(tpl, "的 " + where + ".fit_source 只允许 " + OV_FIT_SOURCES.join("/") + "（拟合曲线必须来自用户已拟合结果）");
    }
    if (ch.normalize !== undefined && ch.normalize !== null && OV_CHAR_NORMALIZE.indexOf(ch.normalize) < 0) {
      _ovFail(tpl, "的 " + where + ".normalize 只允许 " + OV_CHAR_NORMALIZE.join("/") + "，收到「" + ch.normalize + "」");
    }
    if (ch.curves !== undefined) {
      if (!Array.isArray(ch.curves)) _ovFail(tpl, "的 " + where + ".curves 必须是数组");
      ch.curves.forEach(function (cu, i) {
        var w = where + ".curves[" + i + "]";
        if (!_ovIsObj(cu)) _ovFail(tpl, "的 " + w + " 必须是对象");
        _ovKeysOnly(cu, ["role", "column", "label"], w, tpl);
        if (OV_CURVE_ROLES.indexOf(cu.role) < 0) {
          _ovFail(tpl, "的 " + w + ".role 只允许 " + OV_CURVE_ROLES.join("/") + "，收到「" + cu.role + "」");
        }
        if (typeof cu.column !== "string" || !cu.column) {
          _ovFail(tpl, "的 " + w + ".column 必须是非空字符串（真实数据列名，非映射槽）");
        }
      });
    }
  }

  function _validateChartOverrides(ov, tpl) {
    if (ov === undefined || ov === null) return;
    if (!_ovIsObj(ov)) _ovFail(tpl, "的 chart_overrides 必须是对象");
    // 数据标注键即使写在允许键之外也单独点名，报错更直白（先于白名单检查）
    OV_DATA_KEYS.forEach(function (k) {
      if (ov[k] !== undefined) {
        _ovFail(tpl, "的 chart_overrides." + k + " 是数据标注，模板禁止预置——请改用 hints 引导用户填写");
      }
    });
    _ovKeysOnly(ov, OV_KEYS, "chart_overrides", tpl);
    if (ov.presentation !== undefined) _validateOvPres(ov.presentation, "chart_overrides.presentation", tpl);
    if (ov.axes !== undefined) _validateOvAxes(ov.axes, "chart_overrides.axes", tpl);
    if (ov.characterization !== undefined) {
      _validateOvChar(ov.characterization, "chart_overrides.characterization", tpl);
    }
    if (ov.style_id !== undefined) {
      if (typeof ov.style_id !== "string" || !ov.style_id) {
        _ovFail(tpl, "的 chart_overrides.style_id 必须是非空字符串");
      }
      // styles.json 为可选加载项：未加载风格库时无法核对存在性，
      // 跳过存在性校验（应用时由 apply_chart_style 解析/报错）。
      if (_styles && _styles.length) {
        var st = null;
        for (var i = 0; i < _styles.length; i++) {
          if (_styles[i].id === ov.style_id) { st = _styles[i]; break; }
        }
        if (!st) _ovFail(tpl, "的 chart_overrides.style_id「" + ov.style_id + "」不是 styles.json 已有风格");
      }
    }
  }

  function _validateTemplateExtras(tpl) {
    if (!_isObj(tpl)) return;
    if (tpl.hints !== undefined) {
      if (!Array.isArray(tpl.hints) || tpl.hints.length > 4 ||
          tpl.hints.some(function (s) { return typeof s !== "string" || !s || s.length > 60; })) {
        _ovFail(tpl, "的 hints 必须是 ≤4 条、每条 1–60 字的非空字符串数组");
      }
    }
    if (tpl.preview !== undefined &&
        (typeof tpl.preview !== "string" || !OV_PREVIEW_RE.test(tpl.preview))) {
      _ovFail(tpl, "的 preview 必须是小写 slug（如 xrd-stack），收到「" + tpl.preview + "」");
    }
    if (tpl.group !== undefined && typeof tpl.group !== "string") {
      _ovFail(tpl, "的 group 必须是字符串");
    }
    _validateChartOverrides(tpl.chart_overrides, tpl);
  }

  var _rules = [];

  function styles() {
    _requireLoaded();
    return _deepCopy(_styles || []);
  }

  function style(id) {
    _requireLoaded();
    if (typeof id !== "string") _fail("style(id) 的 id 必须为字符串");
    for (var i = 0; i < (_styles || []).length; i++) {
      if (_styles[i].id === id) return _deepCopy(_styles[i]);
    }
    return null;
  }

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
    "pie", "histogram", "heatmap", "box",
    // R10：data.js 已实现的补图型
    "bar_stacked", "violin", "dotplot", "paired", "marginal",
    "volcano", "forest", "survival", "roc", "pca", "venn", "sankey", "taylor"
  ];

  function _rawTemplate(id) {
    for (var i = 0; i < _templates.length; i++) {
      if (_templates[i].id === id) return _templates[i];
    }
    return null;
  }

  function _chartTypeNameZh(chartType) {
    var fd = global.FigData;
    if (fd && typeof fd.chartTypeName === "function") {
      try { return fd.chartTypeName(chartType); } catch (e) { /* 回退 */ }
    }
    return chartType || "图表";
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
      reason = "「" + _chartTypeNameZh(chartType) + "」可以直接用数据画出来；还没导入数据时只生成空的图框";
    } else if (tpl.category === "composite" && chartType === null) {
      status = "layout";
      label = "仅空版式";
      var panels = Array.isArray(tpl.panels) ? tpl.panels : [1, 1];
      reason = "只创建 " + (panels[0] || 1) + "×" + (panels[1] || 1) +
        " 的空白版面，不自动填图，也不会绑定或编造数据";
    } else if (tpl.category === "diagram" && global.FigDiagram &&
        typeof global.FigDiagram.supportsTemplate === "function" &&
        global.FigDiagram.supportsTemplate(tpl).supported === true) {
      var schematic = global.FigDiagram.supportsTemplate(tpl);
      status = "full";
      label = "可编辑示意图";
      reason = schematic.reason + "；不使用数据自动关联，必须提供或确认节点、关系与来源";
    } else if (tpl.category === "diagram") {
      reason = global.FigDiagram && global.FigDiagram.supportsTemplate
        ? global.FigDiagram.supportsTemplate(tpl).reason
        : "实体关系生成器未加载，示意图模板保持不可应用";
    } else {
      reason = "「" + _chartTypeNameZh(chartType || (tpl && tpl.name)) + "」暂时只有示意图，还不能用真实数据绘制，所以不能应用";
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
          message: _elLabel(el) + " 字号 " + pt + "pt 低于" + minSrc + "最小字号 " + minPt + "pt",
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
          message: _elLabel(el) + " 的位置超出所在面板（x=" + x + "，y=" + y + "，w=" + w + "，h=" + h + "）",
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
          message: _elLabel(el) + " 的文字与背景对比度 " + ratio.toFixed(2) + " 低于 4.5",
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
        // R7：统计图模板——按图型判定（显著性/斜线/误差带标注均由用户填写）
        put("tpl-bar-significance", 78,
          "分组类别数据 → 柱状图+显著性版式（括号/字母需您按统计结果填写）");
        put("tpl-bar-hatch", 66,
          "分组类别数据 → 黑白打印柱图（套「黑白印刷」风格+逐系列斜线）");
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
      if (f.num.length >= 1 && f.hasStd) {
        put("tpl-line-band", 68,
          "数值列含标准差/误差来源 → 均值±误差带（误差带需误差数据列）");
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
          put("tpl-raman-multi-compare", 91, "拉曼位移列 + 样品分组列 → Raman 多样品对比（模板申报最大值归一）");
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
      if (anyName(CV_RE)) {
        put("tpl-cv", 85, "检测到电位/电流循环列 → CV 曲线");
        if (f.hasGroup) {
          put("tpl-cv-scanrate", 80, "电位/电流 + 分组列 → CV 多扫速（渐变色标）");
        }
      }
      // R7：表征叠放/渐变模板——复用既有 technique 列名规则，不新造推断
      if (anyName(XRD_RE) && f.hasGroup) {
        put("tpl-xrd-stack", 82, "2θ + 强度 + 样品分组列 → XRD 多样品叠放");
      }
      if (anyName(XPS_RE)) {
        if (fitLike >= 2) {
          put("tpl-xps-fit-filled", 86,
            "结合能列 + 拟合/基线/组分列 → XPS 分峰填充（组分填充+内图例）");
        }
        if (f.hasGroup) {
          put("tpl-xps-stack", 80, "结合能列 + 分组列 → XPS 多样品叠放");
        }
      }
      if (anyName(RAMAN_RE) && f.hasGroup) {
        put("tpl-raman-stack", 82, "拉曼位移 + 强度 + 分组列 → Raman 多样品叠放");
      }
      if (anyName(FTIR_RE) && f.hasGroup) {
        put("tpl-ftir-stack", 82, "波数 + 透过率 + 分组列 → FTIR 多样品叠放（波数轴反向）");
      }
      if (anyName(UVPL_RE)) {
        put("tpl-uvvis-gradient", 78,
          "波长/吸光度 + 系列列 → UV-Vis 渐变色标（viridis）");
        put("tpl-pl-gradient", 74, "波长 + 发射强度 + 系列列 → PL 渐变色标（plasma）");
      }
      if (anyName(NYQUIST_RE)) {
        put("tpl-eis-nyquist-fit", 80,
          "Z′/−Z″ + 可选拟合列 → Nyquist+拟合（等比，局部放大插图）");
      }
      if (anyName(STRESS_RE)) put("tpl-stress-strain", 85, "检测到应变/应力列 → 应力-应变曲线");
      if (anyName(PSD_RE)) put("tpl-particle-size", 85, "检测到粒径列 → 粒径分布直方图");

      // R7：电化学/统计模板——与上方 technique 规则同一机制（只按用户
      // 列名声明匹配，不从数值推断）；分数刻意低于已专用匹配，避免抢占。
      if (anyName(LSV_RE)) {
        put("tpl-lsv-multi", 74,
          "电位/电流密度/过电位列 → LSV 多样品（样品名写在曲线右端）");
      }
      if (anyName(BATT_RE) && f.num.length >= 2) {
        put("tpl-gcd-cycles", f.hasGroup ? 78 : 70,
          "容量/电压/循环列 → 充放电循环曲线（颜色按圈数沿渐变）");
        put("tpl-cycling-dual", 74,
          "容量/库仑效率列 → 循环性能双轴（右轴系列由您在向导指定）");
        put("tpl-rate-capability", 72,
          "倍率/电流密度 + 容量列 → 倍率性能散点");
      }
      if (anyName(TAFEL_RE)) {
        put("tpl-tafel", 76,
          "过电位/log电流密度列 → Tafel 曲线（y 轴 log 刻度，拟合线须为您的列）");
      }
      if (anyName(BET_RE)) {
        put("tpl-bet-isotherm", 76,
          "相对压力/吸附量列 → 吸脱附等温线（分支标记由您逐系列设置）");
      }
      if (anyName(TGA_RE)) {
        put("tpl-tga-dtg", 76,
          "温度/失重/DTG 列 → TGA+DTG 双轴（DTG 系列移右轴）");
      }
      if (anyName(XAS_RE) && f.hasGroup) {
        put("tpl-xanes-stack", 80,
          "能量/吸收列 + 样品分组 → XANES 多样品叠放（前边放大用局部插图）");
      }
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

  // 槽位/兜底列的人话名（与数据向导 SLOT_SHORT 一致；未收录槽位回退其说明文字）
  var MAPPING_SLOT_NAMES = {
    x: "横轴", y: "纵轴", group: "分组", error: "误差列",
    color: "颜色分组", size: "大小", label: "标签",
    fit: "拟合曲线", baseline: "基线"
  };
  function mappingSlotName(slot, desc) {
    if (MAPPING_SLOT_NAMES[slot]) return MAPPING_SLOT_NAMES[slot];
    var m = /^comp(\d*)$/.exec(String(slot));
    if (m) return "组分" + (m[1] || "");
    return desc || String(slot);
  }
  function mappingKindName(kind) {
    return /类别|分组/.test(String(kind)) ? "类别列" : "数值列";
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
      warnings.push("「" + tpl.name + "」的" + mappingSlotName(slot, desc) +
        "没有找到名字明确对应的列，暂时用了" + mappingKindName(kind) + "「" +
        chosen.name + "」，请确认是否正确");
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
      // R10：venn 的 ys 是多列成员标记，无法按单列自动解析——留空由向导多选
      if (slot === "ys") {
        mapping[slot] = null;
        warnings.push("模板「" + tpl.name + "」的成员标记列需在向导中多选 2–3 列（各填 0/1），该映射留空");
        return;
      }
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
        if (!cvGroup) warnings.push("模板「" + tpl.name + "」缺少可识别的循环/样品分组列；用数字列作分组时每组取值需在 1–6 类之间，该映射留空");
        return;
      }
      if (/可选/.test(desc)) {
        var any = take(numericPool) || take(catPool);
        fallbackWarning(slot, desc, any, any && any.numeric ? "数值" : "类别");
        mapping[slot] = any ? any.name : null;
        if (!any) warnings.push("模板「" + tpl.name + "」没有可用于「" + mappingSlotName(slot, desc) + "」的列，该映射留空");
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
          warnings.push("模板「" + tpl.name + "」缺少适合「" + desc + "」的数值列，该映射留空");
        }
      } else {
        var namedCat = preferredName(catPool, prefer);
        var ccol = namedCat ? accept(namedCat) : take(catPool);
        if (!namedCat) fallbackWarning(slot, desc, ccol, "类别");
        if (ccol) {
          mapping[slot] = ccol.name;
        } else {
          mapping[slot] = null;
          warnings.push("模板「" + tpl.name + "」缺少适合「" + desc + "」的类别列，该映射留空");
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
      // R9：模板可自带 schematic 默认结构（占位节点/关系/布局/主题）；
      // 用户 opts.schematic 提供时以用户为准（整体替换，不混合）。
      var rawSpec = opts.schematic;
      if ((!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) &&
          _isObj(tpl.schematic)) {
        rawSpec = tpl.schematic;
      }
      if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
        _fail("MISSING_MATERIALS: 示意图模板需要 opts.schematic={id,nodes,relations,sources,...}（或模板自带 schematic 默认结构）；不从模板名或表格猜实体、方向与来源");
      }
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

    // H1：opts.canvas={width_mm,height_mm} 提供时直接按目标画布排版
    // （W/H 取画布；字号仍取期刊预设或默认 8pt）。不提供时行为不变。
    var useTargetCanvas = false;
    if (opts.canvas !== undefined && opts.canvas !== null) {
      if (!_isObj(opts.canvas) ||
          !(opts.canvas.width_mm > 0) || !(opts.canvas.height_mm > 0)) {
        _fail("opts.canvas 需要 {width_mm, height_mm} 正数");
      }
      W = opts.canvas.width_mm;
      H = opts.canvas.height_mm;
      useTargetCanvas = true;
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
      warnings.push("模板「" + tpl.name + "」没有可用数据列，只生成未绑定数据的空占位（不是已生成的图表）；不会凭空编造或绑定数据");
    } else if (needData && rows.length === 0) {
      warnings.push("数据没有数据行，只生成未绑定数据的空占位，不算已生成图表");
    } else if (isComposite) {
      warnings.push("模板「" + tpl.name + "」只创建空白版面，不自动填图；即使传入数据也不会绑定到各面板");
    }

    var mapping = needData && columns.length ? _resolveMapping(tpl, columns, rows, warnings) : {};

    // R02：用户确认的字段映射优先。规则＝「用户确认值优先；未提供才用推断」：
    // 槽位必须是模板 default_mapping 声明的槽；字符串值必须是真实列名；
    // null 显式清空该槽。校验失败立即抛错（不静默回退推断，否则向导里
    // 用户看到的映射与实际生成的图表不一致）。
    // R4-HB：mapping.ys 是宽表多纵轴特例（列名数组，非模板槽位），先单独校验。
    var wideYs = null;
    if (_isObj(opts.mapping) && needData && columns.length &&
        opts.mapping.ys !== undefined && opts.mapping.ys !== null) {
      var vy = opts.mapping.ys;
      if (!Array.isArray(vy)) _fail("opts.mapping.ys 必须是列名数组");
      var ctypeY = tpl.chart_type;
      // R10：venn 的 ys 是 2–3 个成员标记列（与 line_multi/scatter 的多列纵轴同构传递）
      if (ctypeY !== "line_multi" && ctypeY !== "scatter" && ctypeY !== "venn") {
        _fail("opts.mapping.ys 仅支持 line_multi/scatter/venn 模板（当前：" + ctypeY + "）");
      }
      var seenYs = {}, cleanYs = [];
      vy.forEach(function (yc) {
        if (typeof yc !== "string" || yc === "" || seenYs[yc] || columns.indexOf(yc) < 0) {
          _fail("opts.mapping.ys 含非法、重复或不存在的列：" + String(yc));
        }
        seenYs[yc] = true;
        cleanYs.push(yc);
      });
      if (cleanYs.length < 2) _fail("opts.mapping.ys 至少需要 2 列");
      if (ctypeY === "venn" && cleanYs.length > 3) {
        _fail("venn 最多支持 3 个成员标记列（当前 " + cleanYs.length + " 列）；更多集合请改用 UpSet 类图");
      }
      wideYs = cleanYs;
    }
    if (_isObj(opts.mapping) && needData && columns.length) {
      var allowedSlots = _isObj(tpl.default_mapping) ? Object.keys(tpl.default_mapping) : [];
      Object.keys(opts.mapping).forEach(function (slot) {
        if (slot === "ys") return; // R4-HB：宽表多纵轴已在上面单独处理
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
      if (wideYs) {
        if (mapping.group) {
          _fail("opts.mapping.ys 与 mapping.group 互斥，请把 group 槽清空（null）后再用多列纵轴");
        }
        if (tpl.chart_type === "scatter" && mapping.color) {
          _fail("opts.mapping.ys 与 mapping.color 互斥，请把 color 槽清空（null）后再用多列纵轴");
        }
        mapping.ys = wideYs;
        mapping.y = wideYs[0]; // 兼容：y 恒等于 ys[0]
      }
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
    var cols = (Array.isArray(tpl.panels) && tpl.panels[0]) || 1;
    var rowsN = (Array.isArray(tpl.panels) && tpl.panels[1]) || 1;
    var areas = tpl.areas;
    var panelCount = areas ? areas.length : cols * rowsN;
    if (panelCount > 1 && columns.length) {
      warnings.push("多面板模板把同一数据列默认映射到所有面板（源列歧义）：请逐面板确认 mapping 与曲线列后再出图");
    }

    // --- build elements: panel container + optional title + chart(s) ---
    var els = [];
    var fill = opts.canvas_fill;
    if (fill != null && fill !== 1 && fill !== 0.8) _fail("canvas_fill 必须为 1 或 0.8");
    var margin = fill == null ? 4 : W * (1 - fill) / 2;
    var marginY = fill == null ? 4 : H * (1 - fill) / 2;
    var titleH = 8;
    var hasTitle = typeof opts.title === "string" && opts.title.length > 0;
    var topY = marginY + (hasTitle ? titleH + 4 : 0);
    var panelW = W - margin * 2;
    var panelH = H - topY - marginY;

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
    if (areas) panelEl.panelLayout.areas = _deepCopy(areas);
    els.push(panelEl);

    if (hasTitle) {
      els.push({
        id: _uid("text"),
        type: "text",
        z: 2,
        transform: { x: margin, y: marginY, w: panelW, h: titleH, rotation: 0 },
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
    if (useTargetCanvas && fill == null) {
      // H1：单元格高度上限为宽度 0.8 倍；超出时面板与图表靠上、不拉长
      var cellCap = cellW * 0.8;
      if (cellH > cellCap) {
        cellH = cellCap;
        var usedH = pad * 2 + rowsN * cellH + gap * (rowsN - 1);
        if (usedH < panelH) {
          panelH = usedH;
          panelEl.transform.h = _round2(panelH);
        }
      }
    }
    var firstChart = null;

    for (var i = 0; i < panelCount; i++) {
      var area = areas ? areas[i] : { col: i % cols, row: Math.floor(i / cols), colSpan: 1, rowSpan: 1 };
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
          // H1：默认把映射列名写为坐标轴标题（槽位为空则不写该键）
          axes: (function () {
            var ax = {};
            if (mapping.x) ax.xLabel = mapping.x;
            // R4-HB2：宽表 ys≥2 不写 yLabel=ys[0]，默认标题由渲染层按
            // 左右轴系列名拼接生成。
            if (mapping.y && !(Array.isArray(mapping.ys) && mapping.ys.length >= 2)) {
              ax.yLabel = mapping.y;
            }
            return ax;
          })(),
          paletteId: paletteId || null,
          legend: opts.legend !== undefined ? opts.legend :
            ((mapping && (mapping.group ||
              (Array.isArray(mapping.ys) && mapping.ys.length >= 2))) ||
             (charSpec && charSpec.curves.length) ? "right" : "none"),
          showValues: false
        };
        if (charSpec) chartSpec.characterization = _deepCopy(charSpec);
        // R7：chart_overrides 合并进图表骨架（加载期已校验白名单/枚举；
        // 数据标注键在此之前已被拒绝）。深合并：模板 overrides 的键覆盖
        // 骨架同名键，骨架未提供的键保留。style_id 记录 styleRef，
        // UI 创建路径还会在默认风格之后再发一次 apply_chart_style 保证优先级。
        var ov = _isObj(tpl.chart_overrides) ? tpl.chart_overrides : null;
        if (ov) {
          if (_isObj(ov.axes)) {
            chartSpec.axes = _mergeDeep(_isObj(chartSpec.axes) ? chartSpec.axes : {}, ov.axes);
          }
          if (_isObj(ov.presentation)) {
            chartSpec.presentation = _mergeDeep(
              _isObj(chartSpec.presentation) ? chartSpec.presentation : {}, ov.presentation);
          }
          if (_isObj(ov.characterization)) {
            var mergedChar = _mergeDeep(
              _isObj(chartSpec.characterization) ? chartSpec.characterization : {},
              _deepCopy(ov.characterization));
            if (global.FigData && typeof global.FigData.normalizeCharacterization === "function") {
              var ovChk = global.FigData.normalizeCharacterization(mergedChar, columns);
              if (ovChk.ok) {
                chartSpec.characterization = mergedChar;
              } else {
                warnings.push("模板「" + tpl.name + "」的 characterization 覆盖校验失败（" +
                  ovChk.errors.join("；") + "），已忽略该覆盖");
              }
            } else {
              chartSpec.characterization = mergedChar;
            }
          }
          if (typeof ov.style_id === "string" && ov.style_id) {
            var ovStyle = null;
            for (var osi = 0; osi < (_styles || []).length; osi++) {
              if (_styles[osi].id === ov.style_id) { ovStyle = _styles[osi]; break; }
            }
            chartSpec.styleRef = { id: ov.style_id, name: ovStyle ? ovStyle.name : ov.style_id };
          }
        }
        // R4-HB：opts.axes.y2 透传（右轴配置；仅结构+宽表子集校验，语义由 ops 把关）
        if (_isObj(opts.axes) && opts.axes.y2 !== undefined && opts.axes.y2 !== null) {
          var y2o = opts.axes.y2;
          if (!_isObj(y2o) || !Array.isArray(y2o.series) || !y2o.series.length ||
              y2o.series.some(function (n) { return typeof n !== "string" || n === ""; })) {
            _fail("opts.axes.y2 需要 {series:[系列名…], label?, min?, max?}");
          }
          if (Array.isArray(mapping.ys) && mapping.ys.length) {
            var badY2 = y2o.series.filter(function (n) { return mapping.ys.indexOf(n) < 0; });
            if (badY2.length || y2o.series.length >= mapping.ys.length) {
              _fail("opts.axes.y2.series 必须是 mapping.ys 的子集，且至少保留 1 列在左轴");
            }
          }
          chartSpec.axes.y2 = _deepCopy(y2o);
        }
        if (firstChart === null) firstChart = chartSpec;
      }
      var chartEl = {
        id: _uid("chart"),
        name: "(" + label + ")",
        type: "chart",
        z: 1,
        parent_id: panelId,
        transform: {
          x: _round2(innerX + area.col * (cellW + gap)),
          y: _round2(innerY + area.row * (cellH + gap)),
          w: _round2(cellW * area.colSpan + gap * (area.colSpan - 1)),
          h: _round2(cellH * area.rowSpan + gap * (area.rowSpan - 1)),
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
      data_bound: needData && columns.length > 0 && rows.length > 0,
      hints: Array.isArray(tpl.hints) ? tpl.hints.slice() : [],
      preview: typeof tpl.preview === "string" ? tpl.preview : null
    };
  }

  // ------------------------------------------------ R7 模板覆盖 ops
  //
  // UI 创建路径（模板画廊/导入向导）的统一后处理：「用户默认风格先套，
  // 模板 overrides 后套，以模板为准」。apply_chart_style 是替换式语义，
  // 会重建风格持有键（legend.position、plot 风格键、轴字号等），所以
  // chart_overrides 不能只靠物化时的内嵌——需要在默认风格 op 之后再发：
  //   style_id            → apply_chart_style(style_id)
  //   presentation/axes/characterization → set_chart_properties 补丁
  // targets 形如 [{kind:"id",id:…}] 或 [{kind:"type",type:"chart"}]。
  // 无 chart_overrides 时返回 []。
  function templateOverrideOps(templateId, targets) {
    _requireLoaded();
    if (typeof templateId !== "string" || !templateId) {
      _fail("templateOverrideOps 的 templateId 必须为非空字符串");
    }
    var tpl = _rawTemplate(templateId);
    if (!tpl || !_isObj(tpl.chart_overrides)) return [];
    var ov = tpl.chart_overrides;
    var tgs = Array.isArray(targets) ? targets.filter(Boolean) : [];
    if (!tgs.length) return [];
    var ops = [];
    if (typeof ov.style_id === "string" && ov.style_id) {
      var st = null;
      for (var i = 0; i < (_styles || []).length; i++) {
        if (_styles[i].id === ov.style_id) { st = _styles[i]; break; }
      }
      ops.push({
        op: "apply_chart_style",
        targets: _deepCopy(tgs),
        style_id: ov.style_id,
        style: st ? st.tokens : undefined,
        reason: "应用模板「" + tpl.name + "」指定风格"
      });
    }
    var properties = {};
    if (_isObj(ov.presentation)) properties.presentation = _deepCopy(ov.presentation);
    if (_isObj(ov.axes)) properties.axes = _deepCopy(ov.axes);
    if (_isObj(ov.characterization)) properties.characterization = _deepCopy(ov.characterization);
    if (Object.keys(properties).length) {
      ops.push({
        op: "set_chart_properties",
        targets: _deepCopy(tgs),
        properties: properties,
        reason: "应用模板「" + tpl.name + "」的样式/坐标覆盖"
      });
    }
    return ops;
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

  // R07 修复：期刊规则测量按对象出证——每个可测元素给出
  // {element_id, name, measured}，无法测量的进 unmeasured（带原因），
  // 不再用单一聚合值掩盖「部分对象达标、部分无法测量」的真实覆盖度。
  // 图表字号/线宽经 FigData.describeChartStyle 取渲染器实际生效值
  // （与 ai.js 同一调用形状）；未加载或解析失败 → unmeasured，不猜默认值。

  function _fontSizePass(doc) {
    var items = [], unmeasured = [];
    (doc.elements || []).forEach(function (el) {
      if (!el) return;
      var name = el.name || el.id;
      if (el.type === "text") {
        // 渲染器默认字号 7pt（render.js styleToAttrs），未单独设置按 7 计
        var fs = el.style && typeof el.style.fontSizePt === "number" &&
          isFinite(el.style.fontSizePt) ? el.style.fontSizePt : 7;
        items.push({ element_id: el.id, name: name, sizes: [fs] });
        return;
      }
      if (el.type !== "chart") return; // 其他元素类型不参与字号测量
      if (!(global.FigData && typeof global.FigData.describeChartStyle === "function")) {
        unmeasured.push({ element_id: el.id, name: name, reason: "图表样式无法解析" });
        return;
      }
      var dcs;
      try {
        var st = el.style || {};
        dcs = global.FigData.describeChartStyle(el.chart, {
          fontSizePt: st.fontSizePt,
          fontFamily: st.fontFamily
        });
      } catch (e) {
        unmeasured.push({ element_id: el.id, name: name, reason: "图表样式无法解析" });
        return;
      }
      var font = (dcs && dcs.font) || {};
      var tick = font.tickPt || {};
      var titles = font.axisTitlePt || {};
      var feat = (dcs && dcs.features) || {};
      var tickHidden = feat.tickHidden || {};
      var labels = (dcs && dcs.labels) || {};
      var sizes = [];
      if (!tickHidden.x && typeof tick.x === "number" && isFinite(tick.x)) sizes.push(tick.x);
      if (!tickHidden.y && typeof tick.y === "number" && isFinite(tick.y)) sizes.push(tick.y);
      if (typeof labels.x === "string" && labels.x !== "" &&
          typeof titles.x === "number" && isFinite(titles.x)) sizes.push(titles.x);
      if (typeof labels.y === "string" && labels.y !== "" &&
          typeof titles.y === "number" && isFinite(titles.y)) sizes.push(titles.y);
      var legend = (dcs && dcs.legend) || {};
      if (legend.position !== "none" &&
          typeof legend.fontPt === "number" && isFinite(legend.fontPt)) sizes.push(legend.fontPt);
      var pres = el.chart && el.chart.presentation;
      var pks = pres && pres.peaks;
      if (pks && typeof pks === "object" && !Array.isArray(pks)) {
        Object.keys(pks).forEach(function (id) {
          var p = pks[id];
          if (p && typeof p.fontSizePt === "number" && isFinite(p.fontSizePt)) {
            sizes.push(p.fontSizePt);
          }
        });
      }
      if (sizes.length) {
        items.push({ element_id: el.id, name: name, sizes: sizes });
      }
    });
    return { items: items, unmeasured: unmeasured };
  }

  function _fontSizeAgg(pass, wantMin) {
    var objects = [], value = null;
    pass.items.forEach(function (it) {
      var m = it.sizes[0];
      for (var i = 1; i < it.sizes.length; i++) {
        m = wantMin ? Math.min(m, it.sizes[i]) : Math.max(m, it.sizes[i]);
      }
      if (value === null || (wantMin ? m < value : m > value)) value = m;
      objects.push({ element_id: it.element_id, name: it.name, measured: m });
    });
    return {
      kind: wantMin ? "min" : "max",
      value: value, objects: objects, unmeasured: pass.unmeasured
    };
  }

  function _minFontSizeOf(fontPass) { return _fontSizeAgg(fontPass, true); }
  function _maxFontSizeOf(fontPass) { return _fontSizeAgg(fontPass, false); }

  function _minStrokeWidthOf(doc) {
    var objects = [], unmeasured = [], value = null;
    (doc.elements || []).forEach(function (el) {
      if (!el) return;
      var name = el.name || el.id;
      var candidates = [];
      if (el.style && typeof el.style.strokeWidthPt === "number" &&
          isFinite(el.style.strokeWidthPt)) {
        candidates.push(el.style.strokeWidthPt);
      }
      if (el.type === "chart") {
        if (!(global.FigData && typeof global.FigData.describeChartStyle === "function")) {
          unmeasured.push({ element_id: el.id, name: name, reason: "图表样式无法解析" });
          return;
        }
        var dcs;
        try {
          var st = el.style || {};
          dcs = global.FigData.describeChartStyle(el.chart, {
            fontSizePt: st.fontSizePt,
            fontFamily: st.fontFamily
          });
        } catch (e) {
          unmeasured.push({ element_id: el.id, name: name, reason: "图表样式无法解析" });
          return;
        }
        var axis = (dcs && dcs.axis) || {};
        var marks = (dcs && dcs.marks) || {};
        if (typeof axis.widthPt === "number" && isFinite(axis.widthPt)) {
          candidates.push(axis.widthPt);
        }
        if (typeof marks.lineWidthPt === "number" && isFinite(marks.lineWidthPt)) {
          candidates.push(marks.lineWidthPt);
        }
      }
      if (!candidates.length) return;
      var m = candidates[0];
      for (var i = 1; i < candidates.length; i++) {
        if (candidates[i] < m) m = candidates[i];
      }
      if (value === null || m < value) value = m;
      objects.push({ element_id: el.id, name: name, measured: m });
    });
    return { kind: "min", value: value, objects: objects, unmeasured: unmeasured };
  }

  // 位图有效 DPI：逐图像出证（pxWidth/pxHeight 由导入时记录；缺记录 →
  // unmeasured，不用 dpi 标签冒充）。dpi = min(宽向, 高向有效 dpi)。
  function _minRasterDpiOf(doc) {
    var objects = [], unmeasured = [], value = null, anyImage = false;
    (doc.elements || []).forEach(function (el) {
      if (!el || el.type !== "image") return;
      anyImage = true;
      var name = el.name || el.id;
      var hasPx = typeof el.pxWidth === "number" && isFinite(el.pxWidth) &&
        typeof el.pxHeight === "number" && isFinite(el.pxHeight);
      if (!hasPx) {
        unmeasured.push({ element_id: el.id, name: name, reason: "缺少像素尺寸" });
        return;
      }
      var t = el.transform || {};
      var wOk = typeof t.w === "number" && isFinite(t.w) && t.w > 0;
      var hOk = typeof t.h === "number" && isFinite(t.h) && t.h > 0;
      if (!wOk || !hOk) {
        unmeasured.push({ element_id: el.id, name: name, reason: "缺少放置尺寸" });
        return;
      }
      var dpi = Math.min(el.pxWidth / (t.w / 25.4), el.pxHeight / (t.h / 25.4));
      if (value === null || dpi < value) value = dpi;
      objects.push({ element_id: el.id, name: name, measured: dpi });
    });
    return {
      kind: "min", value: value, objects: objects,
      unmeasured: unmeasured, anyImage: anyImage
    };
  }

  // 建议文案里的测量值保留 1 位小数（结果字段 measured 仍为原值）
  function _fmtNum(v) { return Math.round(v * 10) / 10; }

  var FIGURE_TYPE_NAMES = {
    line_art: "线稿", grayscale: "灰度", halftone_color: "彩色/照片"
  };

  function _figureTypeOfRule(rule) {
    var at = rule && rule.appliesTo;
    return (at && typeof at.figureType === "string" && at.figureType) || "any";
  }

  function _ruleViolates(rule, measured) {
    var tol = typeof rule.tolerance === "number" ? rule.tolerance : 0;
    if (rule.operator === "equal") return Math.abs(measured - rule.value) > tol;
    if (rule.operator === "min") return measured < rule.value;
    if (rule.operator === "max") return measured > rule.value;
    return false;
  }

  function _ruleSatisfied(rule, measured) {
    var tol = typeof rule.tolerance === "number" ? rule.tolerance : 0;
    if (rule.operator === "equal") return Math.abs(measured - rule.value) <= tol;
    if (rule.operator === "min") return measured >= rule.value;
    if (rule.operator === "max") return measured <= rule.value;
    return false;
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
    var fontPass = _fontSizePass(doc); // min/max 共用一次测量
    var minFont = _minFontSizeOf(fontPass);
    var maxFont = _maxFontSizeOf(fontPass);
    var minStroke = _minStrokeWidthOf(doc);
    var raster = _minRasterDpiOf(doc);
    var canvas = doc.canvas || {};
    // 图类别：显式 opts > 文档 meta；未知（null）时 figureType 规则按
    // 「可能属于更严类别」处理，避免把类别未声明误报成 fail。
    var figType = opts.figure_type || (doc.meta && doc.meta.figure_type) || null;
    var results = rules.map(function (rule) {
      var measured = null, comparable = false, violates = false, applicable = true;
      var meas = null;
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
          meas = minFont;
          break;
        case "max_font_size":
          meas = maxFont;
          break;
        case "line_width":
          meas = minStroke;
          break;
        case "raster_dpi":
          meas = raster;
          applicable = raster.anyImage; // 无位图素材 → not_applicable
          break;
        default:
          comparable = false;
      }
      var elementIds = [], unmeasuredIds = [], coverage = "full";
      if (meas) {
        measured = meas.value;
        comparable = measured !== null;
        meas.objects.forEach(function (o) {
          if (_ruleViolates(rule, o.measured)) elementIds.push(o.element_id);
        });
        unmeasuredIds = meas.unmeasured.map(function (u) { return u.element_id; });
        coverage = unmeasuredIds.length ? "partial" : "full";
      }
      if (comparable) violates = _ruleViolates(rule, measured);
      // appliesTo.figureType：已知类别不符 → not_applicable；类别未知时正常
      // 评估，但若违反而同属性的另一类别规则已被实测值满足 → unknown
      // （可能属于更宽松类别，请用户确认图类别），不直接判 fail。
      var ruleFt = _figureTypeOfRule(rule);
      var ftSiblingOk = false;
      if (ruleFt !== "any") {
        if (figType !== null && figType !== ruleFt) {
          applicable = false;
        } else if (figType === null && comparable && violates) {
          ftSiblingOk = rules.some(function (sib) {
            return sib !== rule && sib.id !== rule.id &&
              sib.property === rule.property &&
              _figureTypeOfRule(sib) !== "any" &&
              _ruleSatisfied(sib, measured);
          });
        }
      }
      var status;
      if (!applicable) status = "not_applicable";
      else if (rule.verification !== "verified") status = "unknown";
      else if (!comparable) status = "unknown";
      else if (violates && ftSiblingOk) status = "unknown";
      else if (violates) status = (rule.level === "required") ? "fail" : "warning";
      else if (unmeasuredIds.length) status = "unknown"; // 部分对象无法测量
      else status = "pass";
      var suggestion = null;
      if (status === "fail" || status === "warning") {
        suggestion = "调整 " + rule.property + "（当前 " + (measured === null ? "未知" : _fmtNum(measured)) +
          " " + (rule.unit || "") + "，要求 " + rule.operator + " " + rule.value + "）";
        if (meas && elementIds.length) {
          var badNames = meas.objects.filter(function (o) {
            return elementIds.indexOf(o.element_id) >= 0;
          }).map(function (o) { return o.name; });
          if (badNames.length) suggestion += "（涉及：" + badNames.join("、") + "）";
        }
      } else if (status === "unknown" && rule.verification !== "verified") {
        suggestion = "规则值未经官方页面直接核对（" + rule.sourceUrl + "），投稿前自行确认";
      } else if (status === "unknown" && ftSiblingOk) {
        var dirTxt = meas && meas.kind === "max" ? "当前最高 " :
          meas && meas.kind === "min" ? "当前最低 " : "当前 ";
        var opTxt = rule.operator === "min" ? "≥" : rule.operator === "max" ? "≤" : "=";
        var ftName = FIGURE_TYPE_NAMES[ruleFt] || ruleFt;
        suggestion = dirTxt + _fmtNum(measured) + " " + (rule.unit || "") +
          "；若本图属于「" + ftName + "」需 " + opTxt + rule.value + " " +
          (rule.unit || "") + "，请确认图类别";
      } else if (status === "unknown" && comparable && unmeasuredIds.length) {
        var okCount = meas.objects.length - elementIds.length;
        var um = meas.unmeasured.map(function (u) {
          return u.name + "（" + u.reason + "）";
        });
        suggestion = "已测 " + okCount + " 个对象符合要求；另有 " + unmeasuredIds.length +
          " 个对象无法测量：" + um.join("、");
      } else if (status === "unknown") {
        suggestion = "文档中无可测量的 " + rule.property + " 对象";
        if (meas && unmeasuredIds.length) {
          suggestion += "；" + meas.unmeasured.map(function (u) {
            return u.name + "（" + u.reason + "）";
          }).join("、");
        }
      }
      return {
        rule_id: rule.id, property: rule.property, level: rule.level,
        status: status, measured: measured, required: rule.value,
        unit: rule.unit || null, operator: rule.operator,
        verification: rule.verification, source_url: rule.sourceUrl || null,
        checked_at: rule.checkedAt || null, evidence: rule.evidence || null,
        element_ids: elementIds, unmeasured_ids: unmeasuredIds,
        coverage: coverage,
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
      note: "按 x 分组绘制 y 分布（中位数/四分位，原始值参与计算）" },
    // R10 补图型：聚合/统计口径与 lib/data.js RENDERS 实现一致
    bar_stacked: { required: ["x", "y", "group"], aggregation: "cell_sum",
      note: "同一分类×组分的重复观测求和（sum）后堆叠；stackMode=percent 时按类别归一化为 100%" },
    violin: { required: ["x", "y"], aggregation: "kde",
      note: "每类按 y 值做高斯 KDE（Silverman 带宽，带宽写入 SVG 属性）；内嵌箱线；n<20 时给警告建议改箱线+散点" },
    dotplot: { required: ["x", "y"], aggregation: "count_per_value",
      note: "按（类别×数值）计数画点，点大小∝计数；可选 size/color 列调节" },
    paired: { required: ["x", "y", "group"], aggregation: "none",
      note: "同一 group（个体）跨条件连线；缺任一条件的个体整组排除并在 SVG 属性报告；可选均值±SD 叠加（presentation.plot.pairedSummary）" },
    marginal: { required: ["x", "y"], aggregation: "none",
      note: "散点 + 顶部 x / 右侧 y 直方图边际分布；分箱用 Sturges 法则（写入 SVG 属性）" },
    volcano: { required: ["x", "y"], aggregation: "none",
      note: "x=log2FC、y=-log10(p) 原样使用不改数据；显著性三色需 chart.thresholds={fc,p_neglog10} 用户提供，未填则单色不画阈值线；labelTop 按 y 取前 n 个 label 列标注" },
    forest: { required: ["x", "y"], aggregation: "none",
      note: "y=研究/模型、x=效应量逐行绘制；CI 用 mapping.lo/hi 列或 error 对称半宽；参考竖线 presentation.plot.nullValue（默认 0，比值类设 1）；size 列映射方块权重" },
    survival: { required: ["x", "y"], aggregation: "km_curve",
      note: "x=时间、y=事件列（1=事件/0=删失）、可选 group；Kaplan–Meier 阶梯曲线由渲染器按列计算（注明方法）；不算 HR/log-rank，须由用户提供" },
    roc: { required: ["x", "y"], aggregation: "none",
      note: "x=FPR、y=TPR 为用户已算好的曲线点，按 group 分系列；对角参考线；AUC 按给定点梯形积分并在图例注明" },
    pca: { required: ["x", "y"], aggregation: "none",
      note: "x/y 为用户提供的坐标列（渲染器不做 PCA）；可选 group 着色；presentation.plot.ellipse=true 画 95% 协方差置信椭圆（注明）；轴标题含义由用户负责" },
    venn: { required: [], aggregation: "region_count",
      note: "mapping.ys 为 2–3 个成员标记列（0/1 或 true/false），渲染器统计各交集区域计数；圆固定大小不按面积成比例（注明）；>3 列拒绝并提示 UpSet" },
    sankey: { required: ["x", "y"], aggregation: "flow_layout",
      note: "x=源、y=目标、可选 size=权重列（缺省按行计数 1）；节点按 DAG 最长路径分层、带状流三次贝塞尔；节点 >30 拒绝" },
    taylor: { required: ["x", "y"], aggregation: "none",
      note: "x=标准差、y=相关系数[-1,1]、可选 group；四分之一极坐标（半径=std/maxStd、角度=acos(r)）；chart.reference_std 由用户填，画参考点" }
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

  // R9：示意图主题查询（diagram_themes.json；未加载返回 null，
  // FigDiagram 回退内置主题）
  function diagramTheme(id) {
    if (!_diagramThemes) return null;
    return _diagramThemes[id] ? _deepCopy(_diagramThemes[id]) : null;
  }
  function diagramThemes() {
    if (!_diagramThemes) return [];
    return Object.keys(_diagramThemes).map(function (k) {
      var t = _deepCopy(_diagramThemes[k]);
      t.id = k;
      return t;
    });
  }

  var FigPresets = {
    load: load,
    journals: journals,
    journal: journal,
    styles: styles,
    style: style,
    diagramTheme: diagramTheme,
    diagramThemes: diagramThemes,
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
    templateOverrideOps: templateOverrideOps,
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
