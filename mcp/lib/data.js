/*
 * shared/lib/data.js — FigData
 *
 * Data parsing (CSV/JSON), column statistics, chart type inference,
 * chart element factory (figure-document schema) and a lightweight,
 * dependency-free SVG chart renderer used for v1/v3 previews.
 *
 * No build step, no module system, no third-party dependencies.
 * Everything is attached to globalThis so the file works as a plain
 * <script> (file:// included) and under Node.
 *
 * Loading order (see API.md): figdoc -> ops -> palette -> presets -> data -> ...
 * FigDoc / FigPalette / FigPresets are optional at runtime: every use is
 * guarded with a typeof check and falls back to local implementations.
 *
 * renderChartSVG returns an SVG *content fragment* (a single root <g>) in
 * pixel units (px = mm * dpi / 25.4). To embed it, wrap it as:
 *   <svg width="{width_mm}mm" height="{height_mm}mm"
 *        viewBox="0 0 {Wpx} {Hpx}" xmlns="http://www.w3.org/2000/svg">
 *     ...fragment...
 *   </svg>
 * where Wpx = width_mm * dpi / 25.4 and Hpx = height_mm * dpi / 25.4.
 *
 * Unsupported chart types throw FigData.UnsupportedChartError. The error may
 * carry an explicitly marked unsupported-preview fragment for local template
 * previews, but it is never a successful data render or an export fallback.
 * supportedChartTypes/supportsChartType read the actual RENDERS registry.
 *
 * Characterization spectra (chartSpec.characterization, e.g. XPS/Raman/XRD/
 * NMR/EIS): line / line_multi render raw curves plus user-declared
 * fit/component/baseline curve columns with optional reversed/log10 x,
 * declared-only normalization and positional stacking offsets. Scatter charts
 * also honor characterization axis labels and equal_aspect=true. No fitting,
 * no peak inference; unknown fields are rejected. See normalizeCharacterization.
 */
(function (global) {
  "use strict";

  /* ====================================================================
   * Errors
   * ==================================================================== */

  function UnsupportedChartError(chartType, svgFragment, message) {
    if (!(this instanceof UnsupportedChartError)) {
      return new UnsupportedChartError(chartType, svgFragment, message);
    }
    this.name = "UnsupportedChartError";
    this.chartType = chartType;
    this.svgFragment = svgFragment || null;
    this.message = message || "图表类型「" + chartType +
      "」当前本地渲染器不支持：未生成真实数据图，禁止作为成功结果导出";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, UnsupportedChartError);
    }
  }
  UnsupportedChartError.prototype = Object.create(Error.prototype);
  UnsupportedChartError.prototype.constructor = UnsupportedChartError;

  /* ====================================================================
   * Constants
   * ==================================================================== */

  // chartType enum of figure-document.schema.json
  var CHART_TYPES = [
    "bar", "bar_grouped", "bar_stacked", "line", "line_multi", "scatter",
    "scatter_grouped", "bubble", "box", "violin", "histogram", "heatmap",
    "pie", "donut", "radar", "area", "stacked_area", "dotplot", "roc",
    "volcano", "forest", "marginal", "paired", "sankey", "treemap",
    "network", "diagram_flow", "diagram_architecture", "umap", "pca",
    "survival", "venn", "taylor", "joyplot", "parallel"
  ];

  var CAPABILITY_TYPES = ["full", "layout", "unsupported"];

  // 面向用户的图表类型中文名（界面文案用；未知类型回退原值，不臆造）
  var CHART_TYPE_NAMES = {
    bar: "柱状图", bar_grouped: "分组柱状图", bar_stacked: "堆叠柱状图",
    line: "折线图", line_multi: "多折线图", scatter: "散点图",
    scatter_grouped: "分组散点图", bubble: "气泡图",
    box: "箱线图", violin: "小提琴图", histogram: "直方图", heatmap: "热图",
    pie: "饼图", donut: "环形图", radar: "雷达图",
    area: "面积图", stacked_area: "堆叠面积图", dotplot: "点图", roc: "ROC 曲线",
    volcano: "火山图", forest: "森林图", marginal: "边际散点图", paired: "配对图",
    sankey: "桑基图", treemap: "矩形树图", network: "网络图",
    diagram_flow: "流程图", diagram_architecture: "架构图",
    umap: "UMAP 图", pca: "PCA 图", survival: "生存曲线", venn: "韦恩图",
    taylor: "Taylor 图", joyplot: "山脊图", parallel: "平行坐标图"
  };
  function chartTypeName(type) {
    return CHART_TYPE_NAMES[type] || String(type == null ? "" : type);
  }

  // R10：lo/hi 为 forest 置信区间上下限列；与既有角色不同——为 null 时
  // 不写入 mapping 对象（fullMapping/cleanMapping 跳过），避免给所有既有
  // 图追加 lo:null/hi:null 造成存量断言与文档 churn。
  var MAPPING_ROLES = ["x", "y", "group", "color", "size", "label", "error", "lo", "hi"];
  var NULL_SKIP_ROLES = { lo: true, hi: true };

  // spread types of chart.statistics (science contract); see lib/science.js
  var SPREAD_TYPES = ["SD", "SEM", "95CI", "range"];
  var UNCERTAINTY_SOURCES = ["replicates", "column"];

  /* ====================================================================
   * R04: presentation 语义样式（chart.presentation）
   *
   * 渲染器仍按 mapping/原始数据/科学参数生成几何；presentation 只叠加
   * 展示覆盖（系列颜色/线型/标记、轴标题与刻度文字、图例位置与字号、
   * 峰标注样式）。样式按【稳定语义键】保存，不按 SVG 节点序或数组下标：
   * - 分组系列键  group|<分组字段>|<类型>:<分组值>（line_multi/bar_grouped）
   * - 表征曲线键  curve|<role>|<数据列>（fit/component/baseline）
   * - 原始序列键  raw|<y 列>（表征图 raw 系列）/ series|<y 列>（普通单系列）
   * - 颜色系列键  color|<字段>|<类型>:<值>（scatter color 映射）
   * 数据替换/行序变化后同分组值仍匹配同键 → 局部样式保留；不再匹配的
   * 覆盖保留在 presentation 里（标记暂不适用），不转移给其他系列。
   * ==================================================================== */

  var PRES_VERSION = 1;

  function stableSeriesKey(prefix, field, value) {
    var t = (value === null || value === undefined) ? "n"
      : (typeof value === "number" ? "n" : "s");
    return prefix + "|" + (field || "") + "|" + t + ":" + String(value);
  }

  function presOf(chartSpec) {
    var p = chartSpec && chartSpec.presentation;
    return (p && typeof p === "object" && !Array.isArray(p)) ? p : null;
  }

  // 有效文本样式：默认 ← presentation 覆盖（fontSizePt/color/fontWeight）
  function effTextStyle(base, override) {
    if (!override) return base;
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
    Object.keys(override).forEach(function (k) {
      if (override[k] !== undefined && override[k] !== null) out[k] = override[k];
    });
    return out;
  }

  function presAxisStyle(ctx, axisName) {
    var p = presOf(ctx.chartSpec);
    var ax = p && p.axes && p.axes[axisName];
    return {
      title: (ax && ax.title) || null,
      tick: (ax && ax.tick) || null
    };
  }

  // 系列有效样式：调色板默认 ← presentation.series[key]。曲线与图例色块
  // 共用本函数（同一有效样式来源，禁止两处各算各的）。
  function effSeriesStyle(ctx, key, paletteIndex) {
    var p = presOf(ctx.chartSpec);
    var o = p && p.series && p.series[key] ? p.series[key] : null;
    var plot = effPlot(ctx);
    var u = (typeof ctx.dpi === "number" && ctx.dpi > 0) ? ctx.dpi / 72 : 1;
    var cyc = (plot.markerCycle && plot.markerCycle.length)
      ? plot.markerCycle[((paletteIndex % plot.markerCycle.length) + plot.markerCycle.length) % plot.markerCycle.length]
      : null;
    // R6：渐变系列色——seriesColors.mode="gradient" 时按系列序/数值分组
    // 沿顺序配色插值；显式 series.stroke 仍优先（见下行 o.stroke 分支）。
    var gradStroke = gradSeriesStroke(ctx, key, paletteIndex);
    return {
      stroke: (o && o.stroke) ? o.stroke : (gradStroke || ctx.palette[paletteIndex % ctx.palette.length]),
      strokeWidthPt: (o && typeof o.strokeWidthPt === "number") ? o.strokeWidthPt : null,
      dash: (o && o.dash) ? o.dash : dashCyclePattern(plot.dashCycle, paletteIndex, u),
      marker: (o && o.marker) ? o.marker : (cyc || null)
    };
  }

  function presLegendStyle(ctx) {
    var p = presOf(ctx.chartSpec);
    var l = p && p.legend;
    return {
      position: (l && l.position) || null,
      fontSizePt: (l && typeof l.fontSizePt === "number") ? l.fontSizePt : null,
      color: (l && l.color) || null,
      frame: l && l.frame === true
    };
  }

  // 峰标注稳定 id：同 (x,label) 得同 id；冲突追加序号（确定性补全，
  // 旧记录无 id 时按此规则获得，之后保持不变）。
  function peakId(x, label, seen) {
    var raw = "pk:" + (typeof x === "number" ? x : String(x)) + "|" + String(label == null ? "" : label);
    var h = 0;
    for (var i = 0; i < raw.length; i++) {
      h = (h * 31 + raw.charCodeAt(i)) >>> 0;
    }
    var base = "pk-" + h.toString(36);
    if (!seen[base]) { seen[base] = 1; return base; }
    var n = 2;
    while (seen[base + "-" + n]) n++;
    seen[base + "-" + n] = 1;
    return base + "-" + n;
  }

  function presPeakStyle(ctx, id) {
    var p = presOf(ctx.chartSpec);
    var pk = p && p.peaks && p.peaks[id] ? p.peaks[id] : null;
    return {
      color: (pk && pk.color) || null,
      fontSizePt: (pk && typeof pk.fontSizePt === "number") ? pk.fontSizePt : null
    };
  }

  var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  // case-insensitive tokens treated as missing cells on CSV import
  var MISSING_TOKENS = ["", "na", "n/a", "nan", "null", "none", "-"];

  var FALLBACK_PALETTE = [
    "#3C5488", "#E64B35", "#00A087", "#4DBBD5", "#F39B7F", "#8491B4",
    "#91D1C2", "#DC0000", "#7E6148", "#B09C85"
  ];

  /* ====================================================================
   * H1：渲染默认样式（单位 pt）。u = ctx.dpi / 72 把 pt 换算成像素，
   * 同一 pt 值在不同 dpi 下物理尺寸一致。有渲染值时一律经 effPlot /
   * effSeriesStyle / effPointStyle 解析：默认样式 ← presentation.plot
   * ← presentation.series[键] ← presentation.points[键]。
   * ==================================================================== */

  var STYLE_DEFAULTS = {
    axisWidthPt: 0.75, axisColor: "#000000",
    tickWidthPt: 0.75, tickLengthPt: 3, tickGapPt: 2, tickColor: "#000000",
    gridWidthPt: 0.4, gridColor: "#E0E0E0",
    zeroWidthPt: 0.5, zeroColor: "#888888", zeroDash: "3 2.25",
    lineWidthPt: 1.2, lineMarkerDiaPt: 3.5,
    scatterDiaPt: 4.5, scatterOpacity: 0.85,
    scatterStrokeWidthPt: 0.4, scatterStrokeColor: "#FFFFFF",
    errorWidthPt: 0.75, errorCapRatio: 0.3, errorCapMaxPt: 3,
    legendLineLenPt: 10, legendLineWidthPt: 1.5, legendBlockPt: 7,
    legendGapPt: 4, legendRowRatio: 1.5,
    charLineWidthPt: 1.5
  };

  function numOr(v, d) {
    return (typeof v === "number" && isFinite(v)) ? v : d;
  }

  // 整图外观：默认 ← presentation.plot。frame=box 时补画上、右轴线。
  // R4：默认四边框（box）+ 刻度朝内（in）；显式 presentation.plot 值仍优先。
  function effPlot(ctx) {
    var p = presOf(ctx.chartSpec);
    var pl = p && p.plot;
    pl = (pl && typeof pl === "object" && !Array.isArray(pl)) ? pl : {};
    return {
      frame: (pl.frame === "box" || pl.frame === "open") ? pl.frame : "box",
      tickDirection: (pl.tickDirection === "in" || pl.tickDirection === "out")
        ? pl.tickDirection : "in",
      axisWidthPt: numOr(pl.axisWidthPt, STYLE_DEFAULTS.axisWidthPt),
      tickLengthPt: numOr(pl.tickLengthPt, STYLE_DEFAULTS.tickLengthPt),
      markerSizePt: (typeof pl.markerSizePt === "number") ? pl.markerSizePt : null,
      lineWidthPt: numOr(pl.lineWidthPt, STYLE_DEFAULTS.lineWidthPt),
      // R5 风格库 tokens：标记填充/形状循环、线型循环、绘图区底色与网格色
      markerFill: (pl.markerFill === "hollow" || pl.markerFill === "solid")
        ? pl.markerFill : "solid",
      markerCycle: Array.isArray(pl.markerCycle) ? pl.markerCycle.slice() : null,
      dashCycle: Array.isArray(pl.dashCycle) ? pl.dashCycle.slice() : null,
      background: (typeof pl.background === "string" && pl.background !== "")
        ? pl.background : null,
      gridColor: (typeof pl.gridColor === "string" && pl.gridColor !== "")
        ? pl.gridColor : null
    };
  }

  // dashCycle 的名字 → SVG stroke-dasharray（用户单位）；solid/未知 → null
  var DASH_CYCLE_PATTERNS = {
    solid: null, dash: "4 2", dot: "1.2 1.8", dashdot: "4 2 1.2 1.8"
  };
  function dashCyclePattern(cycle, seriesIndex, u) {
    if (!Array.isArray(cycle) || !cycle.length) return null;
    var name = cycle[((seriesIndex % cycle.length) + cycle.length) % cycle.length];
    var pat = DASH_CYCLE_PATTERNS[name];
    // R5 返工：循环线型按 pt→px 缩放（与 dashPt 同约定），否则 300dpi 下
    // "4 2" 仅 4px 实线段，视觉上接近实线。
    return pat ? dashPt(pat, u || 1) : null;
  }

  // R4-HB：右轴（axes.y2）规范化。series=右轴系列名（宽表列名或长表分组值）。
  function normY2(ctx) {
    var y2 = ctx && ctx.axes && ctx.axes.y2;
    if (!y2 || typeof y2 !== "object" || Array.isArray(y2)) return null;
    var names = [];
    if (Array.isArray(y2.series)) {
      for (var i = 0; i < y2.series.length; i++) {
        var n = y2.series[i];
        if (typeof n === "string" && n !== "" && names.indexOf(n) < 0) names.push(n);
      }
    }
    if (!names.length) return null;
    var set = {};
    names.forEach(function (n) { set[n] = true; });
    function numOrNull(v) {
      return (typeof v === "number" && isFinite(v)) ? v : null;
    }
    return {
      names: names,
      nameSet: set,
      label: typeof y2.label === "string" && y2.label !== "" ? y2.label : null,
      min: numOrNull(y2.min),
      max: numOrNull(y2.max)
    };
  }

  // R4-HB2：宽表多系列默认轴标题。mapping.ys≥2 时，未显式设置的
  // yLabel ← 左轴系列名「 / 」连接；y2.label 为 null ← 右轴系列名同样
  // 连接。显式值优先；非宽表/表征图原样返回（不复制对象）。
  function effectiveWideAxes(axes, mapping, chartType, isChar) {
    var ys = mapping && Array.isArray(mapping.ys)
      ? mapping.ys.filter(function (n) { return typeof n === "string" && n !== ""; })
      : null;
    if (!ys || ys.length < 2) return axes;
    if (chartType !== "line_multi" && chartType !== "scatter") return axes;
    if (isChar) return axes;
    axes = (axes && typeof axes === "object") ? axes : {};
    var y2 = (axes.y2 && typeof axes.y2 === "object" && !Array.isArray(axes.y2)) ? axes.y2 : null;
    var rightSet = {};
    if (y2 && Array.isArray(y2.series)) {
      y2.series.forEach(function (n) { if (typeof n === "string") rightSet[n] = true; });
    }
    var leftNames = ys.filter(function (n) { return !rightSet[n]; });
    var rightNames = ys.filter(function (n) { return rightSet[n]; });
    var needY = !(typeof axes.yLabel === "string" && axes.yLabel !== "");
    var needY2 = rightNames.length > 0 &&
      !(y2 && typeof y2.label === "string" && y2.label !== "");
    if (!needY && !needY2) return axes;
    var out = Object.assign({}, axes);
    if (needY && leftNames.length) out.yLabel = leftNames.join(" / ");
    if (needY2) out.y2 = Object.assign({}, y2 || {}, { label: rightNames.join(" / ") });
    return out;
  }

  // R4-HB：宽表多纵轴序列（mapping.ys）。每列一条系列，g=列名（同时作点键盐）。
  // mode/cats 由「x 有效且至少一列 y 为数值」的行决定，与单 y 口径一致。
  function prepareWideSeries(ctx, xIdx, yColNames) {
    var yIdxs = [];
    for (var c = 0; c < yColNames.length; c++) {
      yIdxs.push(ctx.columns.indexOf(yColNames[c]));
    }
    var xRawAll = [], i, j;
    for (i = 0; i < ctx.rows.length; i++) {
      var row0 = ctx.rows[i];
      var xv0 = row0[xIdx];
      if (xv0 === null || xv0 === undefined || xv0 === "") continue;
      var anyNum = false;
      for (j = 0; j < yIdxs.length; j++) {
        if (!isNaN(toNum(row0[yIdxs[j]]))) { anyNum = true; break; }
      }
      if (anyNum) xRawAll.push(xv0);
    }
    var mode = "cat", allNum = xRawAll.length > 0, allTime = xRawAll.length > 0;
    for (j = 0; j < xRawAll.length; j++) {
      var v = xRawAll[j];
      if (!(typeof v === "number" && isFinite(v)) &&
          !(typeof v === "string" && NUM_RE.test(v.trim()))) allNum = false;
      if (typeof v !== "string" || parseDateTime(v) === null) allTime = false;
    }
    if (allTime) mode = "time"; else if (allNum) mode = "num";
    var cats = null, catSeen = {};
    if (mode === "cat") {
      cats = [];
      for (j = 0; j < xRawAll.length; j++) {
        var lab = String(xRawAll[j]);
        if (!(lab in catSeen)) { catSeen[lab] = cats.length; cats.push(lab); }
      }
    }
    function pxOf(xv) {
      if (mode === "num") return typeof xv === "number" ? xv : Number(xv);
      if (mode === "time") return parseDateTime(xv);
      var k = String(xv);
      return (k in catSeen) ? catSeen[k] : null;
    }
    var series = [];
    for (c = 0; c < yColNames.length; c++) {
      var pts = [];
      for (i = 0; i < ctx.rows.length; i++) {
        var row = ctx.rows[i], xv = row[xIdx];
        if (xv === null || xv === undefined || xv === "") continue;
        var yv = toNum(row[yIdxs[c]]);
        if (isNaN(yv)) continue;
        var xp = pxOf(xv);
        if (xp === null) continue;
        pts.push({ x: xp, y: yv, g: yColNames[c], source_row: i, raw_x: xv, raw_y: row[yIdxs[c]] });
      }
      pts.sort(function (a, b) { return a.x - b.x; });
      series.push({ key: yColNames[c], axisName: yColNames[c], points: pts });
    }
    var allPts = [];
    series.forEach(function (s) { allPts = allPts.concat(s.points); });
    return { series: series, points: allPts, mode: mode, cats: cats };
  }

  // 标记形状 → SVG 图元。返回 {tag, attrs}；circle 走 circleEl 兼容。
  function markerShapeEl(cx, cy, r, fill, extra, marker) {
    var s = r * 2, m = marker || "circle";
    var common = ' fill="' + fill + '"' + (extra || "");
    if (m === "square") {
      return '<rect x="' + px(cx - r) + '" y="' + px(cy - r) + '" width="' + px(s) +
        '" height="' + px(s) + '"' + common + "/>";
    }
    if (m === "triangle") {
      var p1 = px(cx) + "," + px(cy - r), p2 = px(cx + r * 0.9) + "," + px(cy + r * 0.7),
        p3 = px(cx - r * 0.9) + "," + px(cy + r * 0.7);
      return '<polygon points="' + p1 + " " + p2 + " " + p3 + '"' + common + "/>";
    }
    if (m === "diamond") {
      var d = px(cx) + "," + px(cy - r) + " " + px(cx + r) + "," + px(cy) + " " +
        px(cx) + "," + px(cy + r) + " " + px(cx - r) + "," + px(cy);
      return '<polygon points="' + d + '"' + common + "/>";
    }
    return circleEl(cx, cy, r, fill, extra);
  }

  /* ====================================================================
   * Compact marks：标记数超过阈值时，同系列默认样式的散点合并为一条
   * <path data-compact-marks="1">（每个标记一个子路径），逐点覆盖
   * （presentation.points）仍按原样单独输出。命中索引由渲染期收集，
   * 供前端在不解析 DOM 的情况下做最近点选。
   * ==================================================================== */

  // 命中索引按「规格签名 + 渲染尺寸」存储：预览/提交产生的克隆 spec 对象
  // 与 rows 数组不同，但签名相同 → 仍能命中。Map 有界（FIFO），避免泄漏。
  var hitStore = (typeof Map === "function") ? new Map() : null;
  var HIT_STORE_MAX = 16;
  var rowsFpCache = (typeof WeakMap === "function") ? new WeakMap() : null;

  function fnv1aInto(h, s) {
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // rows 指纹：长度 + FNV-1a（含类型标签，避免 1 与 "1" 碰撞）。
  // 结果按 rows 数组身份缓存（WeakMap）；数组被替换才重算。
  function rowsFingerprint(rows) {
    if (!Array.isArray(rows)) return "0:";
    var cached = rowsFpCache && rowsFpCache.get(rows);
    if (cached !== undefined) return cached;
    var h = 0x811c9dc5;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (Array.isArray(row)) {
        for (var j = 0; j < row.length; j++) {
          var v = row[j];
          if (v !== null && v !== undefined) {
            h = fnv1aInto(h, typeof v + "=" + String(v));
          }
          h = Math.imul(h ^ 0x1f, 0x01000193) >>> 0;
        }
      }
      h = Math.imul(h ^ 0x1e, 0x01000193) >>> 0;
    }
    var fp = rows.length + ":" + (h >>> 0).toString(36);
    if (rowsFpCache) rowsFpCache.set(rows, fp);
    return fp;
  }

  // chartSpec 签名：去掉 data.inline.rows 的 JSON + 行指纹。
  // 非 rows 部分每次重算（spec 很小）；rows 指纹按数组身份走 WeakMap。
  // 不按 spec 对象缓存——spec 字段可能原地修改（如 presentation.points），
  // 只有 rows 数组替换才换指纹。
  function chartSignature(chartSpec) {
    if (!chartSpec || typeof chartSpec !== "object" || Array.isArray(chartSpec)) {
      return null;
    }
    var data = chartSpec.data;
    var inline = data && typeof data === "object" ? data.inline : null;
    var rows = inline && Array.isArray(inline.rows) ? inline.rows : null;
    var fp = rowsFingerprint(rows);
    var clone;
    try {
      clone = {};
      var ks = Object.keys(chartSpec);
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        if (k === "data" && data && typeof data === "object") {
          var d2 = {};
          var dks = Object.keys(data);
          for (var a = 0; a < dks.length; a++) {
            var kd = dks[a];
            if (kd === "inline" && inline && typeof inline === "object") {
              var in2 = {};
              var iks = Object.keys(inline);
              for (var b = 0; b < iks.length; b++) {
                var ki = iks[b];
                in2[ki] = (ki === "rows") ? { __rowsFp: fp } : inline[ki];
              }
              d2[kd] = in2;
            } else {
              d2[kd] = data[kd];
            }
          }
          clone[k] = d2;
        } else {
          clone[k] = chartSpec[k];
        }
      }
    } catch (e) { return null; }
    var sig;
    try { sig = JSON.stringify(clone); } catch (e2) { return null; }
    return sig;
  }

  function compactMarksThreshold() {
    var v = (typeof FigData !== "undefined" && FigData &&
      typeof FigData.COMPACT_MARKS_THRESHOLD === "number" &&
      isFinite(FigData.COMPACT_MARKS_THRESHOLD) && FigData.COMPACT_MARKS_THRESHOLD > 0)
      ? FigData.COMPACT_MARKS_THRESHOLD : 2000;
    return v;
  }

  // 与 markerShapeEl 同几何的 path 子路径（px 单位、y 向下）。
  function markerSubpathD(cx, cy, r, marker) {
    var m = marker || "circle";
    if (m === "square") {
      return "M " + px(cx - r) + " " + px(cy - r) +
        " h " + px(2 * r) + " v " + px(2 * r) + " h " + px(-2 * r) + " Z";
    }
    if (m === "triangle") {
      return "M " + px(cx) + " " + px(cy - r) +
        " L " + px(cx + r * 0.9) + " " + px(cy + r * 0.7) +
        " L " + px(cx - r * 0.9) + " " + px(cy + r * 0.7) + " Z";
    }
    if (m === "diamond") {
      return "M " + px(cx) + " " + px(cy - r) +
        " L " + px(cx + r) + " " + px(cy) +
        " L " + px(cx) + " " + px(cy + r) +
        " L " + px(cx - r) + " " + px(cy) + " Z";
    }
    return "M " + px(cx - r) + " " + px(cy) +
      " a " + px(r) + " " + px(r) + " 0 1 0 " + px(2 * r) + " 0" +
      " a " + px(r) + " " + px(r) + " 0 1 0 " + px(-2 * r) + " 0 Z";
  }

  // 命中索引尺寸键：只含影响标记位置的参数（坐标轴布局受字号影响，故带上）。
  // 缺省值与 renderChartSVG 的规范化保持一致。
  function chartHitKey(opts) {
    opts = opts || {};
    var fs = (typeof opts.fontSizePt === "number" && isFinite(opts.fontSizePt) &&
      opts.fontSizePt > 0) ? opts.fontSizePt : 7;
    var ff = (typeof opts.fontFamily === "string" && opts.fontFamily.trim())
      ? opts.fontFamily : "Arial, sans-serif";
    return [opts.width_mm, opts.height_mm, opts.dpi, fs, ff].join("|");
  }

  function chartHitIndex(chartSpec, opts) {
    if (!hitStore || !chartSpec || typeof chartSpec !== "object") return [];
    var sig = chartSignature(chartSpec);
    if (sig === null) return [];
    var hits = hitStore.get(sig + "|" + chartHitKey(opts) + "|" +
      compactMarksThreshold());
    return hits || [];
  }

  // props 面板在无 DOM 节点（compact 点）时读取有效点样式。
  function effectiveMarkStyle(chartSpec, o) {
    return effMarkStyle({ chartSpec: chartSpec }, o || {});
  }

  // 单点/柱有效样式：默认 ← plot ← series[seriesKey] ← points[pointKey]。
  // kind="point" 用点样式；kind="bar" 只取 fill/opacity/stroke/strokeWidthPt。
  function effMarkStyle(ctx, o) {
    var p = presOf(ctx.chartSpec);
    var plot = effPlot(ctx);
    var ser = (p && p.series && o.seriesKey && p.series[o.seriesKey])
      ? p.series[o.seriesKey] : null;
    var pt = (p && p.points && o.pointKey && p.points[o.pointKey])
      ? p.points[o.pointKey] : null;
    var defDia = o.defDiaPt != null ? o.defDiaPt : STYLE_DEFAULTS.scatterDiaPt;
    var sizePt = (pt && typeof pt.sizePt === "number") ? pt.sizePt
      : (ser && typeof ser.markerSizePt === "number") ? ser.markerSizePt
      : (plot.markerSizePt != null) ? plot.markerSizePt : defDia;
    var marker = (pt && pt.marker) || (ser && ser.marker) || o.defMarker || "circle";
    if (["none", "circle", "square", "triangle", "diamond"].indexOf(marker) < 0) {
      marker = "circle";
    }
    var fill = (pt && pt.fill) || (ser && ser.stroke) || o.defFill;
    var stroke = (pt && pt.stroke) || o.defStroke || null;
    var strokeWidthPt = (pt && typeof pt.strokeWidthPt === "number")
      ? pt.strokeWidthPt : (o.defStrokeWidthPt != null ? o.defStrokeWidthPt : null);
    var opacity = (pt && typeof pt.opacity === "number") ? pt.opacity
      : (ser && typeof ser.opacity === "number") ? ser.opacity
      : (o.defOpacity != null ? o.defOpacity : null);
    // R5：markerFill=hollow → 无填充、描边取系列色；仅点标记生效
    // （柱/面积/箱线等 kind!="point" 不受影响）；逐点 fill 覆盖仍优先。
    // R7：series[key].markerFill 覆盖整图 plot.markerFill（如 BET 吸附
    // 实心/脱附空心的逐系列区分）；series 取 solid 时压过 plot hollow。
    var serMF = ser && (ser.markerFill === "hollow" || ser.markerFill === "solid")
      ? ser.markerFill : null;
    var fillMode = serMF || effPlot(ctx).markerFill;
    if (o.kind !== "bar" && fillMode === "hollow" && !(pt && pt.fill)) {
      fill = "none";
      stroke = (pt && pt.stroke) || (ser && ser.stroke) || o.defFill || stroke;
    }
    return {
      fill: fill, marker: marker, sizePt: sizePt,
      stroke: stroke, strokeWidthPt: strokeWidthPt, opacity: opacity
    };
  }

  // 数据点键 pt|<源行号>|<h>；h 与 peakId 同一 31 乘法散列转 36 进制。
  // 覆盖数据被替换后同一行号值变了 → 键不匹配 → 覆盖不生效（保留在文档）。
  function hash31(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }
  function mkPointKey(rowIndex, rawX, rawY, groupVal) {
    var raw = String(rawX) + "\u0001" + String(rawY) + "\u0001" + String(groupVal == null ? "" : groupVal);
    return "pt|" + rowIndex + "|" + hash31(raw);
  }
  function mkBarKey(category, group) {
    return group == null ? "bar|" + String(category) : "bar|" + String(category) + "|" + String(group);
  }

  /* ====================================================================
   * Small utilities
   * ==================================================================== */

  var uidCounter = 0;

  function uid(prefix) {
    var FigDoc = global.FigDoc;
    if (FigDoc && typeof FigDoc.uid === "function") {
      return FigDoc.uid(prefix);
    }
    uidCounter += 1;
    return prefix + "-" + Date.now().toString(36) + "-" + uidCounter.toString(36);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function px(n) {
    return String(Math.round(n * 100) / 100);
  }

  // pt 制虚线样式（"a b"）→ 用户单位（px），按 dpi/72 缩放
  function dashPt(dashStr, u) {
    return String(dashStr).split(/\s+/).map(function (v) {
      return px(parseFloat(v) * u);
    }).join(" ");
  }

  function fmtNum(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    var r = Math.round(v * 1e6) / 1e6;
    if (Math.abs(r) >= 1e7) return r.toExponential(2).replace("e+", "e");
    return String(r);
  }

  // rough text width estimate (CJK ~1em, latin ~0.62em) for layout only
  function textW(s, fontPx) {
    s = String(s);
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      w += (c >= 0x2E80 || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3000 && c <= 0x303F)) ? 1 : 0.62;
    }
    return w * fontPx;
  }

  function fontPx(pt, dpi) {
    return pt * dpi / 72;
  }

  function niceTicks(min, max, count) {
    if (!(max > min)) return [min];
    var span = max - min;
    var step0 = span / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log(step0) / Math.LN10));
    var norm = step0 / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var i0 = Math.ceil(min / step - 1e-9);
    var i1 = Math.floor(max / step + 1e-9);
    var ticks = [];
    for (var i = i0; i <= i1 && ticks.length <= 20; i++) {
      var v = Math.round(i * step * 1e10) / 1e10;
      ticks.push(v === 0 ? 0 : v); // normalize -0
    }
    return ticks;
  }

  function linScale(dMin, dMax, outMin, outMax) {
    var dSpan = dMax - dMin;
    return function (v) {
      return outMin + (v - dMin) / dSpan * (outMax - outMin);
    };
  }

  function valueDomain(vals, includeZero) {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] < min) min = vals[i];
      if (vals[i] > max) max = vals[i];
    }
    if (includeZero) {
      if (min > 0) min = 0;
      if (max < 0) max = 0;
    }
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 1;
    if (min === max) max = min + 1;
    return { min: min, max: max };
  }

  // H1：数据贴边留白（值域两端各外扩数据跨度的比例）。
  function padDomain(dom, loFrac, hiFrac) {
    var span = dom.max - dom.min;
    if (!(span > 0) || !isFinite(span)) return dom;
    dom.min -= span * (loFrac || 0);
    dom.max += span * (hiFrac || 0);
    return dom;
  }
  // 柱状类：零基线一端不留白，非零一端外扩 frac。
  function padDomainNonZero(dom, frac) {
    var span = dom.max - dom.min;
    if (!(span > 0) || !isFinite(span)) return dom;
    if (dom.min !== 0) dom.min -= span * frac;
    if (dom.max !== 0) dom.max += span * frac;
    return dom;
  }

  function equalAspectDomains(frame, domX, domY) {
    var spanX = domX.max - domX.min;
    var spanY = domY.max - domY.min;
    if (!(spanX > 0) || !(spanY > 0) || !isFinite(spanX) || !isFinite(spanY)) {
      throw new Error("renderChartSVG：equal_aspect 需要有效的非零 x/y 数据域");
    }
    var unitPx = Math.min(frame.pw / spanX, frame.ph / spanY);
    if (!(unitPx > 0) || !isFinite(unitPx)) {
      throw new Error("renderChartSVG：equal_aspect 无法计算共同的像素/单位比例");
    }
    var centerX = (domX.min + domX.max) / 2;
    var centerY = (domY.min + domY.max) / 2;
    var expandedX = frame.pw / unitPx;
    var expandedY = frame.ph / unitPx;
    return {
      x: { min: centerX - expandedX / 2, max: centerX + expandedX / 2 },
      y: { min: centerY - expandedY / 2, max: centerY + expandedY / 2 }
    };
  }

  function quantileSorted(sorted, p) {
    if (!sorted.length) return NaN;
    var pos = (sorted.length - 1) * p;
    var base = Math.floor(pos);
    if (base + 1 < sorted.length) {
      return sorted[base] + (pos - base) * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  }

  /* ====================================================================
   * Uncertainty math (science contract; used by bar/bar_grouped renderers
   * and FigScience.audit). No fabricated numbers: every function returns
   * null when its inputs cannot support the requested spread.
   * ==================================================================== */

  // log Gamma (Lanczos), for the regularized incomplete beta below.
  function logGamma(x) {
    var g = [
      676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (x < 0.5) {
      return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    }
    var z = x - 1;
    var a = 0.99999999999980993;
    var t = z + 7.5;
    for (var i = 0; i < g.length; i++) {
      a += g[i] / (z + i + 1);
    }
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
  }

  // continued fraction for the incomplete beta (Lentz, Numerical Recipes).
  // MAXIT/EPS are generous: for large df (x near 1) the direct CF converges
  // slowly, and a premature stop skews t_{0.975} by ~3e-3 at df>=100.
  function betacf(a, b, x) {
    var MAXIT = 1000, EPS = 3e-15, FPMIN = 1e-300;
    var qab = a + b, qap = a + 1, qam = a - 1;
    var c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    var h = d;
    for (var m = 1; m <= MAXIT; m++) {
      var m2 = 2 * m;
      var aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      var del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  // regularized incomplete beta I_x(a, b)
  function betainc(a, b, x) {
    if (!(a > 0) || !(b > 0)) return NaN;
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) +
      a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
    return 1 - bt * betacf(b, a, 1 - x) / b;
  }

  // two-sided 95% quantile of Student t (df degrees of freedom).
  // Single shared implementation for kernel + science.js (science.js
  // tcrit975 delegates here). Deterministic, self-contained, and evaluated
  // from the t CDF, with no normal-distribution substitution.
  // two-sided 95% quantile of Student t (df degrees of freedom), solved
  // numerically from the t CDF (no z approximation, no interpolation table):
  //   one-sided upper tail  P(T > t) = 0.5 * I_{df/(df+t^2)}(df/2, 1/2)
  // so t_{0.975,df} is the root of tail(t) = 0.025. Verified against
  // scipy.stats.t.ppf(0.975, df): |err| < 1e-4 for all df >= 1.
  function studentT975(df) {
    if (typeof df !== "number" || !isFinite(df) || df < 1) return NaN;
    df = Math.floor(df);
    var target = 0.025; // one-sided upper tail
    var lo = 0, hi = 100000;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      var tail = 0.5 * betainc(df / 2, 0.5, df / (df + mid * mid));
      if (tail > target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Spread of a list of replicate observations.
  //   SD   half = sample SD (n-1), n >= 2
  //   SEM  half = SD / sqrt(n),  n >= 2
  //   95CI half = t975(n-1) * SD / sqrt(n), n >= 2 (two-sided Student t)
  //   range lower = min, upper = max, n >= 1
  // Returns null for empty / mixed / insufficient input — never guesses.
  function spreadStats(values, spread) {
    if (!Array.isArray(values) || !values.length) return null;
    if (SPREAD_TYPES.indexOf(spread) < 0) return null;
    var nums = [];
    for (var i = 0; i < values.length; i++) {
      var v = toNum(values[i]);
      if (isNaN(v) || !isFinite(v)) return null; // mixed / non-numeric unit
      nums.push(v);
    }
    var n = nums.length;
    var sum = 0;
    for (var j = 0; j < n; j++) sum += nums[j];
    var mean = sum / n;
    var lower, upper, sd = null;
    if (spread === "range") {
      var mn = Infinity, mx = -Infinity;
      for (var k = 0; k < n; k++) {
        if (nums[k] < mn) mn = nums[k];
        if (nums[k] > mx) mx = nums[k];
      }
      lower = mn; upper = mx;
    } else {
      if (n < 2) return null;
      var ss = 0;
      for (var m = 0; m < n; m++) ss += (nums[m] - mean) * (nums[m] - mean);
      sd = Math.sqrt(ss / (n - 1));
      var half;
      if (spread === "SD") half = sd;
      else if (spread === "SEM") half = sd / Math.sqrt(n);
      else half = studentT975(n - 1) * sd / Math.sqrt(n);
      if (!isFinite(half)) return null;
      lower = mean - half;
      upper = mean + half;
    }
    var out = { spread: spread, n: n, mean: mean, lower: lower, upper: upper };
    if (sd != null) out.sd = sd;
    return out;
  }

  // Uncertainty of one bar cell (category, optional group) for a chart.
  //   stats = chart.statistics (science contract) or null
  //   source "replicates": raw y observations of the cell -> spreadStats
  //   source "column": user-declared absolute spread values taken from
  //     stats.uncertainty_column (or mapping.error); never scaled by any %.
  // Returns {ok:true, ...spreadStats fields, source} or {ok:false, reason}.
  // Reasons (for audit/render diagnostics, never silent):
  //   missing-statistics / missing-source / missing-spread / bad-spread
  //   missing-column / column-not-found / column-no-value / column-ambiguous
  //   no-observations / mixed-values / insufficient-n
  function cellUncertainty(columns, rows, mapping, stats, category, group) {
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
      return { ok: false, reason: "missing-statistics" };
    }
    var source = stats.uncertainty_source;
    var spread = stats.spread;
    if (source !== "replicates" && source !== "column") {
      return { ok: false, reason: "missing-source" };
    }
    if (spread === undefined || spread === null || spread === "") {
      return { ok: false, reason: "missing-spread" };
    }
    if (SPREAD_TYPES.indexOf(spread) < 0) {
      return { ok: false, reason: "bad-spread" };
    }
    var xIdx = columns.indexOf(mapping && typeof mapping.x === "string" ? mapping.x : "");
    var yIdx = columns.indexOf(mapping && typeof mapping.y === "string" ? mapping.y : "");
    var gIdx = (group != null && mapping && typeof mapping.group === "string")
      ? columns.indexOf(mapping.group) : -1;
    if (xIdx < 0 || yIdx < 0) return { ok: false, reason: "mapping-missing" };

    var ys = [], i, lab, g, v;
    for (i = 0; i < rows.length; i++) {
      lab = catLabel(rows[i][xIdx]);
      if (lab !== category) continue;
      if (gIdx >= 0) {
        g = catLabel(rows[i][gIdx]);
        if (g !== group) continue;
      }
      v = toNum(rows[i][yIdx]);
      if (isNaN(v)) return { ok: false, reason: "mixed-values" }; // 含混单元
      ys.push(v);
    }
    if (!ys.length) return { ok: false, reason: "no-observations" };

    if (source === "replicates") {
      var s = spreadStats(ys, spread);
      if (!s) return { ok: false, reason: ys.length < 2 ? "insufficient-n" : "mixed-values" };
      s.ok = true;
      s.source = "replicates";
      return s;
    }

    // column mode: absolute declared spread per cell
    var col = (typeof stats.uncertainty_column === "string" && stats.uncertainty_column)
      ? stats.uncertainty_column
      : (mapping && typeof mapping.error === "string" ? mapping.error : null);
    if (!col) return { ok: false, reason: "missing-column" };
    var ci = columns.indexOf(col);
    if (ci < 0) return { ok: false, reason: "column-not-found" };
    var vals = [], hasNull = false;
    for (i = 0; i < rows.length; i++) {
      lab = catLabel(rows[i][xIdx]);
      if (lab !== category) continue;
      if (gIdx >= 0) {
        g = catLabel(rows[i][gIdx]);
        if (g !== group) continue;
      }
      v = rows[i][ci];
      if (v === null || v === undefined || v === "") { hasNull = true; continue; }
      v = toNum(v);
      if (isNaN(v)) return { ok: false, reason: "mixed-values" };
      vals.push(Math.abs(v)); // 声明的绝对 spread 值，不乘任何百分比
    }
    if (!vals.length) return { ok: false, reason: "column-no-value" };
    if (hasNull) return { ok: false, reason: "mixed-values" };
    var first = vals[0];
    for (var k2 = 1; k2 < vals.length; k2++) {
      if (vals[k2] !== first) return { ok: false, reason: "column-ambiguous" };
    }
    return {
      ok: true, source: "column", spread: spread,
      n: null, mean: null, sd: null,
      lower: -first, upper: first, half: first
    };
  }

  // H1：误差线上下界换算成数据值。replicates 的 lower/upper 已是绝对界
  // （mean±half 或 min/max），column 的是相对偏移（-spread/+spread）。
  // 渲染与值域计算统一走本函数，避免重复测量误差线画在 2×均值附近。
  function errorBounds(cell, mean) {
    return cell.source === "replicates"
      ? { lo: cell.lower, hi: cell.upper }
      : { lo: mean + cell.lower, hi: mean + cell.upper };
  }

  function toNum(v) {
    if (typeof v === "number") return isFinite(v) ? v : NaN;
    if (typeof v === "string" && v.trim() !== "") {
      var t = v.trim();
      if (NUM_RE.test(t)) {
        var n = Number(t);
        if (isFinite(n)) return n;
      }
    }
    return NaN;
  }

  function catLabel(v) {
    if (v === null || v === undefined || v === "") return null;
    return String(v);
  }

  var DATE_RE_DASH = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  var DATE_RE_SLASH = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

  // strict datetime parsing (ISO-ish); returns ms timestamp or null
  function parseDateTime(v) {
    if (typeof v !== "string") return null;
    var m = DATE_RE_DASH.exec(v.trim()) || DATE_RE_SLASH.exec(v.trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
    var dt = new Date(y, mo - 1, d, hh, mi, ss);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt.getTime();
  }

  function hasTimeOfDay(ms) {
    var d = new Date(ms);
    return d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
  }

  function fmtTime(ms, withTime) {
    var d = new Date(ms);
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    var s = d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
    if (withTime) s += " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
    return s;
  }

  function hexToRgbLocal(hex) {
    var h = String(hex).replace(/^#/, "");
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHexLocal(c) {
    function h2(n) {
      var s = Math.round(n).toString(16);
      return s.length < 2 ? "0" + s : s;
    }
    return "#" + h2(c.r) + h2(c.g) + h2(c.b);
  }

  // sample a palette continuously; t in [0,1]
  function colorAt(palette, t) {
    if (t <= 0) return palette[0];
    if (t >= 1) return palette[palette.length - 1];
    var seg = t * (palette.length - 1);
    var i = Math.floor(seg);
    var frac = seg - i;
    var a = hexToRgbLocal(palette[i]);
    var b = hexToRgbLocal(palette[i + 1]);
    if (!a || !b) return palette[i];
    return rgbToHexLocal({
      r: a.r + (b.r - a.r) * frac,
      g: a.g + (b.g - a.g) * frac,
      b: a.b + (b.b - a.b) * frac
    });
  }

  function contrastFor(hex) {
    var c = hexToRgbLocal(hex);
    if (!c) return "#000000";
    function lin(u) {
      u /= 255;
      return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
    }
    var L = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    return L > 0.18 ? "#000000" : "#FFFFFF";
  }

  /* ====================================================================
   * Table helpers shared by parsers
   * ==================================================================== */

  function coerceCell(s) {
    if (s === null || s === undefined) return null;
    var t = String(s).trim();
    if (MISSING_TOKENS.indexOf(t.toLowerCase()) >= 0) return null;
    if (NUM_RE.test(t)) {
      var n = Number(t);
      if (isFinite(n)) return n;
    }
    return t;
  }

  /* ------------------------------------------------------------------
   * 单元格数值写法（numberFormat）
   *   plain            默认，与历史行为逐字节一致
   *   comma_thousands  1,234.5 → 1234.5（逗号是千分位）
   *   comma_decimal    1.234,56 → 1234.56 / 3,14 → 3.14（逗号是小数点）
   * ------------------------------------------------------------------ */
  var NUMBER_FORMATS = ["plain", "comma_thousands", "comma_decimal"];
  var THOUSANDS_CELL_RE = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
  var DECIMAL_CELL_RE = /^[+-]?(\d+|\d{1,3}(\.\d{3})+)(,\d+)?([eE][+-]?\d+)?$/;
  var DECIMAL_DOTNUM_RE = /^[+-]?,\d+([eE][+-]?\d+)?$/;

  function assertNumberFormat(numberFormat, fnName) {
    var fmt = numberFormat === undefined ? "plain" : numberFormat;
    if (NUMBER_FORMATS.indexOf(fmt) < 0) {
      throw new Error(fnName + "：numberFormat 仅支持 \"plain\"、\"comma_thousands\"、\"comma_decimal\"");
    }
    return fmt;
  }

  // 单个单元格的统一转换：trim → 缺失记号 → null → 数字 → 其余字符串。
  // numberFormat 语义见 NUMBER_FORMATS；plain 与 coerceCell 完全一致。
  function parseCell(text, numberFormat) {
    var fmt = assertNumberFormat(numberFormat, "parseCell");
    if (text === null || text === undefined) return null;
    var t = String(text).trim();
    if (MISSING_TOKENS.indexOf(t.toLowerCase()) >= 0) return null;
    if (fmt === "comma_thousands") {
      if (THOUSANDS_CELL_RE.test(t)) {
        var n1 = Number(t.replace(/,/g, ""));
        if (isFinite(n1)) return n1;
      }
      if (NUM_RE.test(t)) {
        var n2 = Number(t);
        if (isFinite(n2)) return n2;
      }
      return t;
    }
    if (fmt === "comma_decimal") {
      if (DECIMAL_CELL_RE.test(t) || DECIMAL_DOTNUM_RE.test(t)) {
        // 形态内的点只可能是千分位；逗号最多一个（正则保证），换成小数点
        var n3 = Number(t.replace(/\./g, "").replace(",", "."));
        if (isFinite(n3)) return n3;
      }
      return t;
    }
    if (NUM_RE.test(t)) {
      var n4 = Number(t);
      if (isFinite(n4)) return n4;
    }
    return t;
  }

  function dedupeColumns(columns) {
    var seen = {};
    return columns.map(function (name) {
      if (seen[name]) {
        var k = 2;
        while (seen[name + "_" + k]) k++;
        name = name + "_" + k;
      }
      seen[name] = true;
      return name;
    });
  }

  function assertTable(data, fnName) {
    if (!data || typeof data !== "object" ||
        !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
      throw new Error(fnName + "：data 须为 {columns: string[], rows: any[][]} 结构");
    }
    for (var c = 0; c < data.columns.length; c++) {
      if (typeof data.columns[c] !== "string") {
        throw new Error(fnName + "：columns 必须全部为字符串（第 " + c + " 列不是）");
      }
    }
    for (var r = 0; r < data.rows.length; r++) {
      var row = data.rows[r];
      if (!Array.isArray(row)) {
        throw new Error(fnName + "：rows[" + r + "] 必须是数组");
      }
      if (row.length !== data.columns.length) {
        throw new Error(fnName + "：rows[" + r + "] 长度 " + row.length +
          " 与列数 " + data.columns.length + " 不一致");
      }
    }
    return data;
  }

  /* ====================================================================
   * parseCSV
   * ==================================================================== */

  // 候选分隔符是否“自洽”：所有非空行字段数相同且 ≥2
  function delimiterConsistent(text, delim) {
    var rows = splitCSV(text, delim);
    var width = -1;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.length === 1 && r[0] === "") continue; // 空行
      if (r.length < 2) return false;
      if (width < 0) width = r.length;
      else if (r.length !== width) return false;
    }
    return width >= 2;
  }

  function detectDelimiter(text) {
    var order = [",", ";", "\t"];
    // 有自洽候选时只在自洽者里按原规则（出现次数最多，平手按 , ; \t 顺序）选；
    // 完全没有自洽候选时回退到原来的纯计数规则。
    var pool = order.filter(function (d) { return delimiterConsistent(text, d); });
    if (!pool.length) pool = order;
    var counts = { ",": 0, ";": 0, "\t": 0 };
    var inQ = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '"') { inQ = !inQ; continue; }
      if (!inQ && counts.hasOwnProperty(ch)) counts[ch] += 1;
    }
    var best = pool[0], bestN = -1;
    for (var j = 0; j < order.length; j++) {
      var d = order[j];
      if (pool.indexOf(d) < 0) continue;
      if (counts[d] > bestN) { best = d; bestN = counts[d]; }
    }
    return best;
  }

  // RFC4180-style state machine; returns array of rows (arrays of raw strings)
  function splitCSV(text, delim) {
    var rows = [], row = [], field = "", inQ = false;
    var i = 0, n = text.length;
    if (text.charCodeAt(0) === 0xFEFF) i = 1; // strip BOM
    function endField() { row.push(field); field = ""; }
    function endRow() { endField(); rows.push(row); row = []; }
    while (i < n) {
      var ch = text.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; }
          else { inQ = false; i += 1; }
        } else { field += ch; i += 1; }
      } else if (ch === '"' && field === "") {
        inQ = true; i += 1;
      } else if (ch === delim) {
        endField(); i += 1;
      } else if (ch === "\n") {
        if (row.length > 0 || field !== "") endRow();
        i += 1;
      } else if (ch === "\r") {
        if (row.length > 0 || field !== "") endRow();
        i += (text.charAt(i + 1) === "\n") ? 2 : 1;
      } else {
        field += ch; i += 1;
      }
    }
    if (field !== "" || row.length > 0 || inQ) endRow();
    return rows;
  }

  function parseCSV(text, opts) {
    return readCSV(text, opts, parseCell);
  }

  function readCSV(text, opts, readCell) {
    opts = opts || {};
    if (typeof text !== "string") throw new Error("parseCSV：输入必须是字符串");
    if (text.length === 0) throw new Error("parseCSV：CSV 内容为空");

    var header = opts.header !== false;
    var numberFormat = assertNumberFormat(opts.numberFormat, "parseCSV");
    var delimiter = opts.delimiter;
    if (delimiter === undefined || delimiter === null || delimiter === "auto") {
      delimiter = detectDelimiter(text);
    } else if (delimiter !== "," && delimiter !== ";" && delimiter !== "\t") {
      throw new Error("parseCSV：delimiter 仅支持 ','、';'、'\\t' 或 \"auto\"");
    }

    var rowsRaw = splitCSV(text, delimiter);
    rowsRaw = rowsRaw.filter(function (r) {
      return !(r.length === 1 && r[0] === ""); // drop blank lines
    });
    if (rowsRaw.length === 0) throw new Error("parseCSV：CSV 中没有数据行");

    var width = 0;
    for (var i = 0; i < rowsRaw.length; i++) {
      if (rowsRaw[i].length > width) width = rowsRaw[i].length;
    }

    var columns, dataRows;
    if (header) {
      columns = [];
      var first = rowsRaw[0];
      for (var c = 0; c < width; c++) {
        var name = (c < first.length && first[c] !== null) ? String(first[c]).trim() : "";
        columns.push(name === "" ? "col" + (c + 1) : name);
      }
      dataRows = rowsRaw.slice(1);
    } else {
      columns = [];
      for (var k = 0; k < width; k++) columns.push("col" + (k + 1));
      dataRows = rowsRaw;
    }
    columns = dedupeColumns(columns);

    var rows = [];
    for (var r = 0; r < dataRows.length; r++) {
      var src = dataRows[r], out = [];
      for (var j = 0; j < width; j++) {
        out.push(readCell(j < src.length ? src[j] : "", numberFormat));
      }
      rows.push(out);
    }
    return { columns: columns, rows: rows };
  }

  /* ====================================================================
   * sniffNumberFormat — 分隔文本里“数字写法”的只读探测（不改数据）
   *   返回 { delimiter, suggestion, ambiguous, columns, example }
   *   suggestion: "comma_decimal" | "comma_thousands" | null
   *   绝不自动应用；由调用方决定是否提示用户。
   * ==================================================================== */

  function sniffNumberFormat(text, opts) {
    opts = opts || {};
    if (typeof text !== "string") throw new Error("sniffNumberFormat：输入必须是字符串");
    var delimiter = opts.delimiter;
    if (delimiter === undefined || delimiter === null || delimiter === "auto") {
      delimiter = detectDelimiter(text);
    } else if (delimiter !== "," && delimiter !== ";" && delimiter !== "\t") {
      throw new Error("sniffNumberFormat：delimiter 仅支持 ','、';'、'\\t' 或 \"auto\"");
    }
    var data;
    try {
      data = readCSV(text, { delimiter: delimiter, header: opts.header !== false },
        function (cell) { return cell.trim(); });
    } catch (e) {
      return { delimiter: delimiter, suggestion: null, ambiguous: false,
        columns: [], example: null };
    }
    var ncols = data.columns.length;
    var tOnly = [], dOnly = [], twoWay = [];
    var exampleOf = {};
    for (var c = 0; c < ncols; c++) {
      var hasCommaCell = false, allT = true, allD = true, saw = false;
      for (var r = 0; r < data.rows.length; r++) {
        var raw = data.rows[r][c];
        if (MISSING_TOKENS.indexOf(raw.toLowerCase()) >= 0) continue;
        saw = true;
        if (raw.indexOf(",") >= 0) {
          hasCommaCell = true;
          if (exampleOf[c] === undefined) exampleOf[c] = raw;
        }
        if (typeof parseCell(raw, "comma_thousands") !== "number") allT = false;
        if (typeof parseCell(raw, "comma_decimal") !== "number") allD = false;
      }
      if (!saw || !hasCommaCell) continue;
      if (allT && allD) twoWay.push(data.columns[c]);
      else if (allT) tOnly.push(data.columns[c]);
      else if (allD) dOnly.push(data.columns[c]);
    }
    var suggestion = null;
    if (dOnly.length && !tOnly.length) suggestion = "comma_decimal";
    else if (tOnly.length && !dOnly.length) suggestion = "comma_thousands";
    var ambiguous = !suggestion &&
      (twoWay.length > 0 || (tOnly.length > 0 && dOnly.length > 0));
    var columns;
    if (suggestion === "comma_decimal") columns = dOnly;
    else if (suggestion === "comma_thousands") columns = tOnly;
    else if (twoWay.length) columns = twoWay;
    else columns = tOnly.concat(dOnly);
    var example = null;
    if (columns.length) {
      var ci = data.columns.indexOf(columns[0]);
      example = exampleOf[ci] !== undefined ? exampleOf[ci] : null;
    }
    return { delimiter: delimiter, suggestion: suggestion, ambiguous: ambiguous,
      columns: columns, example: example };
  }

  /* ====================================================================
   * parseJSON
   * ==================================================================== */

  function normalizeTable(parsed, fnName) {
    var columns, rows, i, j;

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return { columns: [], rows: [] };

      if (Array.isArray(parsed[0])) {
        // 2D array
        var width = 0;
        for (i = 0; i < parsed.length; i++) {
          if (!Array.isArray(parsed[i])) {
            throw new Error(fnName + "：二维数组中的每一项都必须是数组（第 " + i + " 项不是）");
          }
          if (parsed[i].length > width) width = parsed[i].length;
        }
        columns = [];
        for (j = 0; j < width; j++) columns.push("col" + (j + 1));
        rows = [];
        for (i = 0; i < parsed.length; i++) {
          var out = [];
          for (j = 0; j < width; j++) {
            out.push(parsed[i][j] === undefined ? null : parsed[i][j]);
          }
          rows.push(out);
        }
      } else if (typeof parsed[0] === "object" && parsed[0] !== null) {
        // array of objects; columns = union of keys in first-appearance order
        columns = [];
        var keySeen = {};
        for (i = 0; i < parsed.length; i++) {
          var obj = parsed[i];
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            throw new Error(fnName + "：对象数组中的每一项都必须是对象（第 " + i + " 项不是）");
          }
          var keys = Object.keys(obj);
          for (var k = 0; k < keys.length; k++) {
            if (!keySeen[keys[k]]) { keySeen[keys[k]] = true; columns.push(keys[k]); }
          }
        }
        rows = [];
        for (i = 0; i < parsed.length; i++) {
          var r = [];
          for (j = 0; j < columns.length; j++) {
            r.push(parsed[i][columns[j]] === undefined ? null : parsed[i][columns[j]]);
          }
          rows.push(r);
        }
      } else {
        throw new Error(fnName + "：JSON 数据须为对象数组或二维数组");
      }
    } else if (parsed && typeof parsed === "object" &&
               Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      // already in {columns, rows} shape
      columns = [];
      for (i = 0; i < parsed.columns.length; i++) {
        if (typeof parsed.columns[i] !== "string") {
          throw new Error(fnName + "：columns 必须全部为字符串");
        }
        columns.push(parsed.columns[i]);
      }
      rows = [];
      for (i = 0; i < parsed.rows.length; i++) {
        var row = parsed.rows[i];
        if (!Array.isArray(row)) {
          throw new Error(fnName + "：rows[" + i + "] 必须是数组");
        }
        var rr = [];
        for (j = 0; j < columns.length; j++) {
          rr.push(j < row.length && row[j] !== undefined ? row[j] : null);
        }
        rows.push(rr);
      }
    } else {
      throw new Error(fnName + "：JSON 数据须为对象数组或二维数组");
    }

    return { columns: dedupeColumns(columns), rows: rows };
  }

  function parseJSON(text) {
    if (typeof text !== "string") throw new Error("parseJSON：输入必须是字符串");
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error("parseJSON：JSON 解析失败：" + e.message);
    }
    return normalizeTable(parsed, "parseJSON");
  }

  /* ====================================================================
   * columnStats
   * ==================================================================== */

  function statColumn(name, rows, ci) {
    var nonMissing = [], missing = 0, distinct = [], seen = {};
    var i, v;

    for (i = 0; i < rows.length; i++) {
      v = rows[i][ci];
      if (v === null || v === undefined || v === "" ||
          (typeof v === "number" && isNaN(v))) {
        missing++;
        continue;
      }
      nonMissing.push(v);
      var key = typeof v + ":" + String(v);
      if (!seen[key]) { seen[key] = true; distinct.push(v); }
    }

    var n = nonMissing.length;
    var allNumeric = n > 0, allString = n > 0, allDate = n > 0;
    var nums = [];
    for (i = 0; i < n; i++) {
      v = nonMissing[i];
      if (typeof v === "number" && isFinite(v)) {
        nums.push(v);
      } else if (typeof v === "string" && NUM_RE.test(v.trim())) {
        nums.push(Number(v));
      } else {
        allNumeric = false;
      }
      if (typeof v !== "string") {
        allString = false;
        allDate = false;
      } else if (parseDateTime(v) === null) {
        allDate = false;
      }
    }

    var kind;
    if (n === 0) kind = "text";
    else if (allNumeric) kind = "numeric";
    else if (allDate) kind = "datetime";
    else if (allString && distinct.length <= 16 && distinct.length < n) kind = "categorical";
    else kind = "text";

    var min = null, max = null, mean = null;
    if (kind === "numeric" && nums.length) {
      min = Infinity; max = -Infinity;
      var sum = 0;
      for (i = 0; i < nums.length; i++) {
        if (nums[i] < min) min = nums[i];
        if (nums[i] > max) max = nums[i];
        sum += nums[i];
      }
      mean = sum / nums.length;
    }

    return {
      name: name,
      kind: kind,
      nunique: distinct.length,
      missing: missing,
      min: min,
      max: max,
      mean: mean,
      isOrderedCandidate: kind === "numeric" || kind === "datetime",
      sampleValues: nonMissing.slice(0, 5)
    };
  }

  function columnStats(data) {
    assertTable(data, "columnStats");
    var cols = [];
    for (var ci = 0; ci < data.columns.length; ci++) {
      cols.push(statColumn(data.columns[ci], data.rows, ci));
    }
    return { n_rows: data.rows.length, columns: cols };
  }

  /* ====================================================================
   * inferChartType
   * ==================================================================== */

  function fullMapping(m) {
    var out = {};
    for (var i = 0; i < MAPPING_ROLES.length; i++) {
      var role = MAPPING_ROLES[i];
      var v = (m && m[role] !== undefined) ? m[role] : null;
      if (NULL_SKIP_ROLES[role] && v === null) continue;
      out[role] = v;
    }
    return out;
  }

  function inferChartType(stats) {
    if (!stats || typeof stats !== "object" || !Array.isArray(stats.columns)) {
      throw new Error("inferChartType：columnStats 须为 {n_rows, columns} 结构");
    }
    if (stats.columns.length === 0) {
      throw new Error("inferChartType：没有可用的数据列，无法推断图表类型");
    }

    var dateCols = [], numCols = [], catCols = [];
    for (var i = 0; i < stats.columns.length; i++) {
      var c = stats.columns[i];
      var col = (c && typeof c === "object") ? c : { name: String(c), kind: "text" };
      if (!col.name || typeof col.name !== "string") {
        throw new Error("inferChartType：columnStats.columns 中存在缺少 name 的列");
      }
      if (col.kind === "datetime") dateCols.push(col);
      else if (col.kind === "numeric") numCols.push(col);
      else if (col.kind === "categorical") catCols.push(col);
    }

    var reasons = [];

    // rule 1: datetime + numeric -> line / line_multi
    if (dateCols.length && numCols.length) {
      var dx = dateCols[0], dy = numCols[0];
      if (numCols.length > 1) {
        reasons.push("存在 " + numCols.length + " 个数值列，先映射「" + dy.name + "」，其余可在编辑器中追加");
      }
      var g = catCols[0];
      if (g && g.nunique >= 2 && g.nunique <= 6) {
        reasons.push("「" + dx.name + "」为时间列、「" + dy.name + "」为数值列，分组列「" + g.name + "」基数为 " + g.nunique + "（2–6）→ line_multi");
        return { chart_type: "line_multi", mapping: fullMapping({ x: dx.name, y: dy.name, group: g.name }), reasons: reasons };
      }
      reasons.push("「" + dx.name + "」为时间列、「" + dy.name + "」为数值列 → line");
      return { chart_type: "line", mapping: fullMapping({ x: dx.name, y: dy.name }), reasons: reasons };
    }

    // rule 2: two categorical + one numeric -> bar_grouped / heatmap
    if (catCols.length >= 2 && numCols.length >= 1) {
      var a = catCols[0], b = catCols[1];
      var big = a.nunique >= b.nunique ? a : b;
      var small = big === a ? b : a;
      var num = numCols[0];
      if (small.nunique >= 2 && small.nunique <= 4) {
        reasons.push("类别列「" + big.name + "」×「" + small.name + "」+ 数值列「" + num.name + "」，分组基数 " + small.nunique + " ≤ 4 → bar_grouped");
        return { chart_type: "bar_grouped", mapping: fullMapping({ x: big.name, y: num.name, group: small.name }), reasons: reasons };
      }
      reasons.push("两个类别列 + 一个数值列（分组基数 > 4）适合矩阵展示 → heatmap");
      return { chart_type: "heatmap", mapping: fullMapping({ x: big.name, y: small.name, color: num.name }), reasons: reasons };
    }

    // rule 3: >=2 numeric -> scatter (color by first category when present)
    if (numCols.length >= 2) {
      var sx = numCols[0], sy = numCols[1];
      if (numCols.length > 2) {
        reasons.push("另有 " + (numCols.length - 2) + " 个数值列未映射");
      }
      if (catCols.length >= 1) {
        reasons.push("两个数值列「" + sx.name + "」「" + sy.name + "」→ scatter，并以类别列「" + catCols[0].name + "」着色");
        return { chart_type: "scatter", mapping: fullMapping({ x: sx.name, y: sy.name, color: catCols[0].name }), reasons: reasons };
      }
      reasons.push("两个数值列「" + sx.name + "」「" + sy.name + "」→ scatter");
      return { chart_type: "scatter", mapping: fullMapping({ x: sx.name, y: sy.name }), reasons: reasons };
    }

    // rule 4: one categorical + one numeric -> bar
    if (catCols.length >= 1 && numCols.length >= 1) {
      var cx = catCols[0], cy = numCols[0];
      reasons.push("类别列「" + cx.name + "」（基数 " + cx.nunique + "）+ 数值列「" + cy.name + "」→ bar");
      if (cx.nunique > 12) {
        reasons.push("类别基数 " + cx.nunique + " > 12，建议改条形图或折叠类别");
      }
      if (numCols.length > 1) {
        reasons.push("存在 " + numCols.length + " 个数值列，先映射「" + cy.name + "」");
      }
      return { chart_type: "bar", mapping: fullMapping({ x: cx.name, y: cy.name }), reasons: reasons };
    }

    // rule 5: single numeric column -> histogram
    if (numCols.length >= 1) {
      reasons.push("仅有数值列「" + numCols[0].name + "」→ histogram 查看分布");
      return { chart_type: "histogram", mapping: fullMapping({ x: numCols[0].name }), reasons: reasons };
    }

    throw new Error("inferChartType：数据中没有数值列，无法推断图表类型");
  }

  /* ====================================================================
   * makeChartElement
   * ==================================================================== */

  function makeChartElement(data, opts) {
    opts = opts || {};
    assertTable(data, "makeChartElement");

    var chartType = opts.chart_type;
    var mapping = opts.mapping;
    if (chartType === undefined || chartType === null || chartType === "") {
      var inf = inferChartType(columnStats(data));
      chartType = inf.chart_type;
      if (!mapping) mapping = inf.mapping;
    }
    if (typeof chartType !== "string" || CHART_TYPES.indexOf(chartType) < 0) {
      throw new Error("makeChartElement：非法图表类型：" + chartType);
    }
    if (!supportsChartType(chartType)) {
      throw UnsupportedChartError(chartType, null,
        "makeChartElement：图表类型「" + chartType + "」当前没有真实 RENDERS 实现，禁止创建后冒充可导出数据图");
    }
    if (mapping === undefined || mapping === null) mapping = {};
    if (typeof mapping !== "object") {
      throw new Error("makeChartElement：mapping 须为对象");
    }

    var colSet = {};
    for (var c = 0; c < data.columns.length; c++) colSet[data.columns[c]] = true;
    var cleanMapping = {};
    for (var m = 0; m < MAPPING_ROLES.length; m++) {
      var role = MAPPING_ROLES[m];
      var v = mapping[role];
      if (v === undefined) v = null;
      if (v !== null && typeof v !== "string") {
        throw new Error("makeChartElement：mapping." + role + " 须为字符串或 null");
      }
      if (v !== null && !colSet[v]) {
        throw new Error("makeChartElement：mapping." + role + " 引用的列「" + v + "」不存在");
      }
      if (NULL_SKIP_ROLES[role] && v === null) continue;
      cleanMapping[role] = v;
    }

    // R4-HB：宽表多纵轴 mapping.ys（line_multi/scatter 专用；≥2 列、互斥 group/color）
    // R10：venn 的 mapping.ys 是 2–3 个成员标记列（0/1 或 true/false），语义不同，
    // 不与 y/group/color 互斥校验，只要求列存在且 2–3 列。
    if (mapping.ys !== undefined && mapping.ys !== null) {
      if (chartType === "venn") {
        if (!Array.isArray(mapping.ys)) {
          throw new Error("makeChartElement：venn 的 mapping.ys 须为列名数组（2–3 个成员标记列）");
        }
        var seenV = {}, cleanV = [];
        for (var vyi = 0; vyi < mapping.ys.length; vyi++) {
          var vyc = mapping.ys[vyi];
          if (typeof vyc !== "string" || vyc === "" || seenV[vyc] || !colSet[vyc]) {
            throw new Error("makeChartElement：venn mapping.ys 含非法、重复或不存在的列：" + String(vyc));
          }
          seenV[vyc] = true;
          cleanV.push(vyc);
        }
        if (cleanV.length < 2 || cleanV.length > 3) {
          throw new Error("makeChartElement：venn mapping.ys 需要 2–3 列（当前 " + cleanV.length + " 列；>3 请改用 UpSet）");
        }
        cleanMapping.ys = cleanV;
      } else {
      if (chartType !== "line_multi" && chartType !== "scatter") {
        throw new Error("makeChartElement：mapping.ys 仅支持 line_multi/scatter/venn 图表");
      }
      if (!Array.isArray(mapping.ys)) {
        throw new Error("makeChartElement：mapping.ys 须为列名数组");
      }
      var seenY = {}, cleanYs = [];
      for (var yi = 0; yi < mapping.ys.length; yi++) {
        var yc = mapping.ys[yi];
        if (typeof yc !== "string" || yc === "" || seenY[yc] || !colSet[yc]) {
          throw new Error("makeChartElement：mapping.ys 含非法、重复或不存在的列：" + String(yc));
        }
        seenY[yc] = true;
        cleanYs.push(yc);
      }
      if (cleanYs.length < 2) {
        throw new Error("makeChartElement：mapping.ys 至少需要 2 列");
      }
      if (cleanMapping.group) {
        throw new Error("makeChartElement：mapping.ys 与 mapping.group 互斥");
      }
      if (chartType === "scatter" && cleanMapping.color) {
        throw new Error("makeChartElement：mapping.ys 与 mapping.color 互斥");
      }
      cleanMapping.ys = cleanYs;
      cleanMapping.y = cleanYs[0]; // 兼容：y 恒等于 ys[0]
      }
    }

    var transform = { x: 10, y: 10, w: 120, h: 90 };
    if (opts.transform && typeof opts.transform === "object") {
      var keys = ["x", "y", "w", "h"];
      for (var t = 0; t < keys.length; t++) {
        var tv = opts.transform[keys[t]];
        if (typeof tv === "number" && isFinite(tv)) transform[keys[t]] = tv;
      }
    }
    if (!(transform.w > 0) || !(transform.h > 0)) {
      throw new Error("makeChartElement：transform.w/h 必须为正数");
    }

    var preset = null;
    var FigPresets = global.FigPresets;
    if (opts.journal_id && FigPresets && typeof FigPresets.journal === "function") {
      preset = FigPresets.journal(opts.journal_id);
    }

    var element = {
      id: uid("chart"),
      type: "chart",
      transform: { x: transform.x, y: transform.y, w: transform.w, h: transform.h },
      chart: {
        chartType: chartType,
        data: {
          inline: {
            columns: data.columns.slice(),
            rows: data.rows.map(function (r) { return r.slice(); })
          },
          ref: null
        },
        mapping: cleanMapping,
        axes: {
          xLabel: cleanMapping.x || "",
          // R4-HB2：宽表 ys≥2 时不烘焙 yLabel（=ys[0] 会误导），由渲染层
          // 按左/右轴系列名拼「 / 」作默认标题；显式设置仍优先。
          yLabel: (Array.isArray(cleanMapping.ys) && cleanMapping.ys.length >= 2)
            ? "" : (cleanMapping.y || ""),
          xScale: "linear",
          yScale: "linear",
          gridlines: false
        },
        paletteId: opts.palette_id || null,
        journalId: opts.journal_id || null,
        legend: "right",
        showValues: false
      }
    };

    if (preset) {
      element.style = {
        fontFamily: preset.font_family || "Arial",
        fontSizePt: preset.base_font_pt || 7
      };
      if (preset.line_width_pt) element.style.strokeWidthPt = preset.line_width_pt;
    }
    return element;
  }

  /* ====================================================================
   * renderChartSVG — shared drawing helpers
   * ==================================================================== */

  function resolvePalette(paletteId) {
    if (!paletteId) return FALLBACK_PALETTE.slice();
    var FigPalette = global.FigPalette;
    if (FigPalette && typeof FigPalette.colors === "function") {
      var cs = FigPalette.colors(paletteId);
      if (!cs || !cs.length) {
        throw new Error("renderChartSVG：调色板「" + paletteId + "」不存在");
      }
      return cs.slice();
    }
    return FALLBACK_PALETTE.slice();
  }

  function legendPos(ctx) {
    // R04：presentation.legend.position 为受控覆盖（none/right/top/bottom）；
    // 未设置时沿用 chartSpec.legend。
    var pres = presLegendStyle(ctx);
    if (pres.position && ["none", "right", "top", "bottom",
        "inside-tr", "inside-tl", "inside-br", "inside-bl", "inline"].indexOf(pres.position) >= 0) {
      // R6：inline 只适用于有序曲线图型；其他图型回退 right。
      if (pres.position === "inline") {
        var ct = ctx.chartSpec.chartType;
        var okInline = ct === "line" || ct === "line_multi" || ct === "area" ||
          !!ctx.chartSpec.characterization;
        return okInline ? "inline" : "right";
      }
      return pres.position;
    }
    var l = ctx.chartSpec.legend;
    if (l === "none") return "none";
    // R6-E：色标已表达系列色阶时默认不画图例。本分支只在
    // presentation.legend.position 未设时到达；chart.legend 是创建期
    // 字段（多系列恒为 "right" 默认值），不算用户显式选择——要图例+
    // 色标并存请用 legend.position 显式指定。
    if (colorbarWanted(ctx)) return "none";
    return (l === "top" || l === "bottom") ? l : "right";
  }

  function showValues(ctx) {
    return ctx.chartSpec.showValues === true;
  }

  function tickFontPx(ctx) {
    var pt = ctx.axes.tickLabelSizePt;
    if (typeof pt !== "number" || !isFinite(pt) || pt <= 0) pt = ctx.fontSizePt;
    return fontPx((typeof pt === "number" && pt > 0) ? pt : 7, ctx.dpi);
  }

  function text(x, y, s, o) {
    o = o || {};
    var a = 'x="' + px(x) + '" y="' + px(y) + '"';
    if (o.anchor) a += ' text-anchor="' + o.anchor + '"';
    a += ' font-size="' + px(o.size || 10) + '"';
    if (o.fill) a += ' fill="' + o.fill + '"';
    if (o.weight) a += ' font-weight="' + o.weight + '"';
    if (o.opacity != null) a += ' fill-opacity="' + o.opacity + '"';
    if (o.transform) a += ' transform="' + o.transform + '"';
    if (o.part) a += ' data-chart-part="' + esc(o.part) + '"';
    if (o.seriesKey) a += ' data-series-key="' + esc(o.seriesKey) + '"';
    if (o.peakId) a += ' data-peak-id="' + esc(o.peakId) + '"';
    return "<text " + a + ">" + esc(s) + "</text>";
  }

  function rectEl(x, y, w, h, fill, extra) {
    return '<rect x="' + px(x) + '" y="' + px(y) + '" width="' + px(w) + '" height="' + px(h) +
      '" fill="' + fill + '"' + (extra || "") + "/>";
  }

  function circleEl(cx, cy, r, fill, extra) {
    return '<circle cx="' + px(cx) + '" cy="' + px(cy) + '" r="' + px(r) +
      '" fill="' + fill + '"' + (extra || "") + "/>";
  }

  function lineEl(x1, y1, x2, y2, stroke, extra) {
    return '<line x1="' + px(x1) + '" y1="' + px(y1) + '" x2="' + px(x2) + '" y2="' + px(y2) +
      '" stroke="' + stroke + '"' + (extra || "") + "/>";
  }

  // R4-HB：右轴系列图例加「（右轴）」后缀（label 保持原值供点击/定位）
  function legendLabel(it) {
    return (it && it.right === true) ? String(it.label) + "（右轴）" : String(it && it.label);
  }

  function legendMaxW(items, f) {
    var w = 0;
    for (var i = 0; i < items.length; i++) {
      var lw = textW(legendLabel(items[i]), f);
      if (lw > w) w = lw;
    }
    return w;
  }

  /* ====================================================================
   * R6 表征增强：坐标范围 / 隐藏刻度 / 行内标签 / 参考线(标准卡) /
   * 区间底色 / 渐变系列色+色标 / 分峰填充 / 显著性括号 / 字母标注 /
   * 斜线填充 / 误差带。
   *
   * 科学诚信约束：所有标注数值（references/bands/significance/letters）
   * 一律来自 chart 字段（用户或模板提供），渲染器不计算、不推断、不代填。
   * 原始 chart.data.inline.rows 永不修改。
   * ==================================================================== */

  // axes.{x,y}{Min,Max}：number|null。返回 {min,max}（各自可为 null）或 null。
  function axisRangeOf(ctx, which) {
    var ax = ctx.axes || {};
    var lo = which === "x" ? ax.xMin : ax.yMin;
    var hi = which === "x" ? ax.xMax : ax.yMax;
    var hasLo = typeof lo === "number" && isFinite(lo);
    var hasHi = typeof hi === "number" && isFinite(hi);
    if (!hasLo && !hasHi) return null;
    return { min: hasLo ? lo : null, max: hasHi ? hi : null };
  }

  // 把用户范围套到数据域上：给定侧覆盖数据域（zoom-out 也允许），
  // 未给侧保留数据域。退化（min>=max）时整轴回退数据域。
  function applyAxisRange(dom, r) {
    if (!r || !dom) return dom;
    var d = { min: dom.min, max: dom.max };
    if (r.min != null) d.min = r.min;
    if (r.max != null) d.max = r.max;
    if (!(d.min < d.max)) return dom;
    return d;
  }

  // 刻度取 nice 值但不得越出用户给定的那一侧。
  function rangeTicks(dom, r, count) {
    var ts = niceTicks(dom.min, dom.max, count);
    return ts.filter(function (v) {
      if (r && r.min != null && v < r.min - 1e-9) return false;
      if (r && r.max != null && v > r.max + 1e-9) return false;
      return true;
    });
  }

  function inDataRange(v, r) {
    if (!r) return true;
    if (r.min != null && v < r.min) return false;
    if (r.max != null && v > r.max) return false;
    return true;
  }

  // R6-4：x 范围限定时，收集「可见 x 窗口内」的 y 值供 y 自动域重算
  // （Origin 式依数据缩放）。interp=true 用于折线类——线段与窗口边缘的
  // 交点按线性插值计入；interp=false 用于散点——只计窗口内的点。
  // pts 元素需含数值 x/y（x 与 axisRangeOf("x") 同单位）。
  // 返回 null=未限定 x 范围；返回数组（可为空）=限定后可见 y 值集合，
  // 空数组表示窗口内无可见数据（调用方不应回退全量域）。
  function visibleYValues(pts, xr, interp) {
    if (!xr) return null;
    if (!pts || !pts.length) return [];
    var out = [];
    if (!interp) {
      for (var i = 0; i < pts.length; i++) {
        if (inDataRange(pts[i].x, xr)) out.push(pts[i].y);
      }
      return out;
    }
    function yAt(p0, p1, x) {
      if (p1.x === p0.x) return p0.y;
      var t = (x - p0.x) / (p1.x - p0.x);
      return p0.y + (p1.y - p0.y) * t;
    }
    for (i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (i === 0) {
        if (inDataRange(p.x, xr)) out.push(p.y);
        continue;
      }
      var q = pts[i - 1];
      var lo = xr.min != null ? xr.min : -Infinity;
      var hi = xr.max != null ? xr.max : Infinity;
      var xa = Math.min(q.x, p.x), xb = Math.max(q.x, p.x);
      var a = Math.max(xa, lo), b = Math.min(xb, hi);
      if (!(a <= b)) continue;
      out.push(yAt(q, p, a), yAt(q, p, b));
    }
    return out;
  }

  // 类别图（bar/bar_grouped/box/heatmap）的 x 单位 = 类别序号（类别 i
  // 的中心）。x 范围限定时按「类别中心在窗口内」判定可见——与 noteClip
  // 计数、heatmap 绘制跳过使用同一谓词，保证「域/绘制/计数」三者一致。
  function catIdxVisible(i, xr) {
    return inDataRange(i, xr);
  }

  // 记录一个被范围裁掉的点（每个数据点至多计一次：x 或 y 任一越界即计）。
  // checkY=false 用于右轴系列（y2 域独立，yMin/yMax 只管左轴）。
  function noteClip(ctx, x, y, checkY) {
    if (!clipWanted(ctx)) return;
    var xr = axisRangeOf(ctx, "x"), yr = axisRangeOf(ctx, "y");
    var out = !inDataRange(x, xr) || (checkY !== false && !inDataRange(y, yr));
    if (out) ctx.__clipCount = (ctx.__clipCount || 0) + 1;
  }

  function clipWanted(ctx) {
    return !!(axisRangeOf(ctx, "x") || axisRangeOf(ctx, "y"));
  }

  function clipOpenTag(ctx) {
    if (!clipWanted(ctx)) return "";
    if (!ctx.__clipId) ctx.__clipId = uid("figclip");
    return '<g clip-path="url(#' + ctx.__clipId + ')">';
  }

  function clipCloseTag(ctx) {
    return clipWanted(ctx) ? "</g>" : "";
  }

  // clipPath 定义：rect = 绘图区（fr 由 cartesianFrame 记入 ctx.__plotFrame）。
  // sticks 参考带存在时数据区上移，clip 同步收窄到数据区。
  function clipDefsSvg(ctx) {
    if (!clipWanted(ctx)) return "";
    var pf = ctx.__plotFrame;
    if (!pf) return "";
    var bottom = pf.y0 + pf.ph - ((pf.stickBand && pf.stickBand.h) || 0);
    return '<defs><clipPath id="' + ctx.__clipId + '"><rect x="' + px(pf.x0) +
      '" y="' + px(pf.y0) + '" width="' + px(pf.pw) + '" height="' +
      px(Math.max(1, bottom - pf.y0)) + '"/></clipPath></defs>';
  }

  // ---- 数学裁剪（导出路径不依赖 clip-path：PyMuPDF SVG 导入器忽略
  // clip-path/clipPath 与嵌套 svg 视口，屏幕端 clip-path 仍保留作兜底）----
  // 绘图区像素矩形：fr 框 + sticks 参考带占据的底部让位。
  function plotClipRect(ctx, fr) {
    var bottom = fr.y0 + fr.ph - ((fr.stickBand && fr.stickBand.h) || 0);
    return { x0: fr.x0, y0: fr.y0, x1: fr.x0 + fr.pw, y1: bottom };
  }
  // Liang-Barsky 线段-矩形裁剪：返回 [x1,y1,x2,y2] 或 null（完全在外）。
  function clipSegRect(x1, y1, x2, y2, r) {
    var dx = x2 - x1, dy = y2 - y1;
    var t0 = 0, t1 = 1;
    var p = [-dx, dx, -dy, dy];
    var q = [x1 - r.x0, r.x1 - x1, y1 - r.y0, r.y1 - y1];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      var t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return [x1 + dx * t0, y1 + dy * t0, x1 + dx * t1, y1 + dy * t1];
  }
  // Sutherland-Hodgman 多边形-矩形裁剪（clip 矩形凸，subject 可凹）。
  // pts: [{x,y},...] → 返回裁剪后顶点数组（可能为空）。
  function clipPolyRect(pts, r) {
    var out = pts;
    function edge(pts2, inside, intersect) {
      var res = [];
      for (var i = 0; i < pts2.length; i++) {
        var cur = pts2[i], prv = pts2[(i + pts2.length - 1) % pts2.length];
        var ci = inside(cur), pi = inside(prv);
        if (ci) {
          if (!pi) res.push(intersect(prv, cur));
          res.push(cur);
        } else if (pi) {
          res.push(intersect(prv, cur));
        }
      }
      return res;
    }
    function ix(a, b, get, lim, isMin) {
      var va = get(a), vb = get(b);
      var t = (lim - va) / (vb - va);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    var edges = [
      function (p) { return p.x >= r.x0; },
      function (p) { return p.x <= r.x1; },
      function (p) { return p.y >= r.y0; },
      function (p) { return p.y <= r.y1; }
    ];
    var lims = [r.x0, r.x1, r.y0, r.y1];
    var gets = [function (p) { return p.x; }, function (p) { return p.x; },
                function (p) { return p.y; }, function (p) { return p.y; }];
    for (var e = 0; e < 4; e++) {
      if (!out.length) return [];
      var ee = e, ll = lims[ee], gg = gets[ee];
      var isMin = ee % 2 === 0;
      out = edge(out, edges[ee], function (a, b) { return ix(a, b, gg, ll, isMin); });
    }
    return out;
  }
  function inRectPx(x, y, r, pad) {
    var m = pad || 0;
    return x >= r.x0 - m && x <= r.x1 + m && y >= r.y0 - m && y <= r.y1 + m;
  }

  // 数据区底边：sticks 参考带占据绘图区底部 sb.h，数据只画到带顶。
  function plotDataBottom(fr) {
    return fr.y0 + fr.ph - ((fr.stickBand && fr.stickBand.h) || 0);
  }

  // ---- x 值 → 像素：bands/references/significance 共用 ----
  // 各渲染器在算出 sx 后调 noteXScale 登记；cat 轴登记“类别序号→px”。
  function noteXScale(ctx, fn) { ctx.__xPx = fn; }
  function xPxOf(ctx, v) {
    if (ctx.__xPx) return ctx.__xPx(v);
    return NaN;
  }

  function chartReferences(ctx) {
    var r = ctx.chartSpec && ctx.chartSpec.references;
    return Array.isArray(r) ? r : [];
  }
  function chartBands(ctx) {
    var b = ctx.chartSpec && ctx.chartSpec.bands;
    return Array.isArray(b) ? b : [];
  }
  function stickRefs(ctx) {
    return chartReferences(ctx).filter(function (r) { return r && r.style === "sticks"; });
  }
  function lineRefs(ctx) {
    return chartReferences(ctx).filter(function (r) { return r && r.style === "lines"; });
  }

  // sticks 参考带：每组一行，组名+source 在带内左侧，竖线高 ∝ heights(0..1)。
  // 由 drawFrameAxes 在网格之后绘制（盖住网格、位于数据区之下）。
  function drawStickBand(ctx, fr) {
    var groups = stickRefs(ctx);
    if (!groups.length || !fr.stickBand) return "";
    var sb = fr.stickBand, u = ctx.dpi / 72, f = fr.tickF;
    var parts = [];
    var rowH = sb.h / groups.length;
    var baseY = fr.y0 + fr.ph; // 带底 = 绘图区底（数据区已上移）
    var bandTop = baseY - sb.h;
    // 带底衬：与绘图区底色一致，盖住网格
    var bg = effPlot(ctx).background || "#FFFFFF";
    parts.push(rectEl(fr.x0, bandTop, fr.pw, sb.h, bg));
    parts.push(rectEl(fr.x0, bandTop, fr.pw, sb.h, "none",
      ' stroke="#CCCCCC" stroke-width="' + px(0.5 * u) + '"'));
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi], rowY = bandTop + gi * rowH;
      var midY = rowY + rowH * 0.72; // 文字基线附近
      var label = String(g.label || "");
      var src = g.source ? "  " + String(g.source) : "";
      var lab = label + src;
      var col = g.color || "#888888";
      var n = Math.min((g.positions || []).length, 200);
      var hs = (g.heights && g.heights.length === n) ? g.heights : null;
      // R6-5：先画竖线再画组名——组名带底色衬底，竖线不再穿字。
      for (var pi = 0; pi < n; pi++) {
        var xv = g.positions[pi];
        var pxv = xPxOf(ctx, xv);
        if (!isFinite(pxv) || pxv < fr.x0 - 1 || pxv > fr.x0 + fr.pw + 1) continue;
        var hFrac = hs ? hs[pi] : 1;
        if (!(hFrac > 0)) continue;
        var yTop = midY - hFrac * (rowH * 0.62);
        parts.push(lineEl(pxv, midY, pxv, yTop, col,
          ' stroke-width="' + px(0.9 * u) + '" data-chart-part="reference"'));
      }
      var lx = fr.x0 + 3 * u;
      var labW = textW(lab, f * 0.82);
      parts.push(rectEl(lx - 1.5 * u, rowY + 0.8 * u, labW + 3 * u, rowH - 1.6 * u, bg));
      parts.push(text(lx, midY, lab, {
        anchor: "start", size: f * 0.82, fill: "#444444", part: "reference"
      }));
    }
    return '<g data-chart-part="references">' + parts.join("") + "</g>";
  }

  // lines 风格参考线：贯穿数据区的虚线竖线，label 写在顶部。
  function drawLineRefs(ctx, fr) {
    var groups = lineRefs(ctx);
    if (!groups.length) return "";
    var u = ctx.dpi / 72, f = fr.tickF;
    var dataBottom = fr.y0 + fr.ph - ((fr.stickBand && fr.stickBand.h) || 0);
    var parts = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var col = g.color || "#888888";
      var n = Math.min((g.positions || []).length, 200);
      for (var pi = 0; pi < n; pi++) {
        var pxv = xPxOf(ctx, g.positions[pi]);
        if (!isFinite(pxv) || pxv < fr.x0 - 1 || pxv > fr.x0 + fr.pw + 1) continue;
        parts.push(lineEl(pxv, fr.y0, pxv, dataBottom, col,
          ' stroke-width="' + px(0.7 * u) + '" stroke-dasharray="' +
          dashPt("4 2.5", u) + '" data-chart-part="reference"'));
        if (g.label && pi === 0) {
          parts.push(text(pxv + 2 * u, fr.y0 + f * 1.1, String(g.label), {
            anchor: "start", size: f * 0.85, fill: col, part: "reference"
          }));
        }
      }
    }
    return parts.length ? '<g data-chart-part="references">' + parts.join("") + "</g>" : "";
  }

  // 区间底色：画在网格之上、数据之下（underlay 层）。
  function drawBandsUnderlay(ctx, fr) {
    var bands = chartBands(ctx);
    if (!bands.length) return "";
    var u = ctx.dpi / 72;
    var parts = [];
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      var x0 = xPxOf(ctx, b.x0), x1 = xPxOf(ctx, b.x1);
      if (!isFinite(x0) || !isFinite(x1)) continue;
      if (x0 > x1) { var t = x0; x0 = x1; x1 = t; }
      var bx0 = Math.max(fr.x0, Math.min(x0, x1));
      var bx1 = Math.min(fr.x0 + fr.pw, Math.max(x0, x1));
      if (bx1 - bx0 < 0.5) continue;
      var col = b.color || "#90CAF9";
      var op = (typeof b.opacity === "number") ? b.opacity : 0.15;
      var extra = ' fill-opacity="' + px(Math.max(0, Math.min(1, op))) + '"';
      var bandBottom = plotDataBottom(fr);
      parts.push(rectEl(bx0, fr.y0, bx1 - bx0, Math.max(1, bandBottom - fr.y0), col, extra));
      if (b.label) {
        parts.push(text(bx0 + 3 * u, fr.y0 + fr.tickF * 1.1, String(b.label), {
          anchor: "start", size: fr.tickF * 0.85, fill: "#555555",
          opacity: 0.9, part: "band-label"
        }));
      }
    }
    return parts.length ? '<g data-chart-part="bands">' + parts.join("") + "</g>" : "";
  }

  // ---- 斜线填充（hatch）：线段在生成期即裁剪到矩形内 ----
  // R6-A：PyMuPDF 不认 clip-path，斜线必须用几何裁剪，保证导出
  // 与屏幕一致、线不越出柱/形状矩形。hatch ∈ "/" "\\" "x" "." "-" "|"。
  function hatchSvg(ctx, x, y, w, h, hatch, color) {
    if (!hatch || w <= 0 || h <= 0) return "";
    var u = ctx.dpi / 72;
    // R6-H：线距≈1.2mm（300dpi≈14px=3.4u），线宽≈0.5pt。
    // 斜线线族参数 c 的垂直间距 = 步进/√2，故斜线循环步进 gap*√2。
    var gap = 3.4 * u;
    var sw = Math.max(0.5 * u, 0.4);
    var col = color || "#000000";
    var paths = [];
    var r = { x0: x, y0: y, x1: x + w, y1: y + h };
    function seg(x1, y1, x2, y2) {
      var c = clipSegRect(x1, y1, x2, y2, r);
      if (!c) return;
      // 退化段（端点重合）不画，避免圆点形伪影
      var dx = c[2] - c[0], dy = c[3] - c[1];
      if (dx * dx + dy * dy < 0.01) return;
      paths.push("M " + px(c[0]) + " " + px(c[1]) + " L " + px(c[2]) + " " + px(c[3]));
    }
    if (hatch === "/" || hatch === "\\" || hatch === "x") {
      // R6-H 修复：旧实现所有斜线段共线（端点和恒为 x+y+h），每柱只画出
      // 一条线。改为按线族不变量 c 均布："/" 为 x+y=c、"\\" 为 y-x=c，
      // c 步进 gap*√2 → 相邻线垂直间距恰为 gap；长段交给 clipSegRect 裁剪。
      var s = Math.SQRT2, L = w + h, cstep = gap * s;
      var c;
      if (hatch === "/" || hatch === "x") {
        for (c = x + y; c <= x + y + w + h + cstep; c += cstep) {
          seg(x, c - x, x + L, c - x - L);
        }
      }
      if (hatch === "\\" || hatch === "x") {
        for (c = y - x - w; c <= y - x + h + cstep; c += cstep) {
          seg(x, x + c, x + L, x + c + L);
        }
      }
    } else if (hatch === "-") {
      for (var yy = y + gap / 2; yy < y + h; yy += gap) seg(x, yy, x + w, yy);
    } else if (hatch === "|") {
      for (var xx = x + gap / 2; xx < x + w; xx += gap) seg(xx, y, xx, y + h);
    } else if (hatch === ".") {
      var rr = sw * 0.9;
      for (var dy = y + gap / 2; dy < y + h; dy += gap) {
        for (var dx = x + gap / 2; dx < x + w; dx += gap) {
          if (dx - rr < x || dx + rr > x + w || dy - rr < y || dy + rr > y + h) continue;
          paths.push("M " + px(dx - sw) + " " + px(dy) + " L " + px(dx + sw) + " " + px(dy));
        }
      }
    }
    if (!paths.length) return "";
    return '<path d="' + paths.join(" ") + '" fill="none" stroke="' +
      col + '" stroke-width="' + px(sw) + '" stroke-opacity="0.55"/>';
  }

  function seriesHatch(ctx, key) {
    var p = presOf(ctx.chartSpec);
    var s = p && p.series && p.series[key];
    return (s && typeof s.hatch === "string") ? s.hatch : null;
  }

  // ---- 行内图例（legend.position="inline"）----
  // 各系列渲染时登记右端点 ctx.__seriesEnds；drawLegend 据此写系列名。
  function noteSeriesEnd(ctx, key, x, y, above) {
    var arr = ctx.__seriesEnds || (ctx.__seriesEnds = []);
    arr.push({ key: key, x: x, y: y, above: above === true });
  }

  function drawInlineLegend(ctx, fr, items) {
    var ends = ctx.__seriesEnds || [];
    var u = ctx.dpi / 72;
    var lp = presLegendStyle(ctx);
    var size = (typeof lp.fontSizePt === "number") ? fontPx(lp.fontSizePt, ctx.dpi) : fr.tickF;
    var fill = lp.color || undefined;
    // R6-C：标签写在绘图区右框外（fr.inlineX 已含右轴让位），垂直位置
    // 仍跟随各曲线右端；框内放不下时不再往框内挤。
    // 每个图例项找同 key 的系列末端；找不到的跳过（不虚构位置）
    var placed = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i], end = null;
      for (var j = ends.length - 1; j >= 0; j--) {
        if (ends[j].key === it.key) { end = ends[j]; break; }
      }
      if (!end) continue;
      var lx = fr.inlineX != null ? fr.inlineX : (fr.x0 + fr.pw + 2.5 * u);
      var ly = end.above ? end.y - size * 0.9 : end.y + size * 0.35;
      ly = Math.max(ly, fr.y0 + size * 0.5); // 不越出绘图区上缘
      placed.push({ it: it, lx: lx, ly: ly, ny: ly, ey: end.y,
        label: legendLabel(it), color: it.color, size: size });
    }
    // 纵向防重叠：最小间距 = 字高×1.2。相邻标签重叠时沿连线双向推开
    // （上方的上推、下方的下推），迭代松弛至无重叠；整体超出绘图区时
    // 先整体平移，跨度仍放不下才均布兜底（不虚构重叠）。
    placed.sort(function (a, b) { return a.ly - b.ly; });
    var minGap = size * 1.2;
    var loY = fr.y0 + size * 0.5;
    var hiY = fr.y0 + fr.ph - (fr.stickBand ? fr.stickBand.h : 0) - size * 0.4;
    for (var iter = 0; iter < 24; iter++) {
      var moved = false;
      for (var k = 1; k < placed.length; k++) {
        var d = placed[k].ly - placed[k - 1].ly;
        if (d < minGap) {
          var push = (minGap - d) / 2;
          placed[k - 1].ly -= push;
          placed[k].ly += push;
          moved = true;
        }
      }
      if (!moved) break;
    }
    var firstY = placed.length ? placed[0].ly : 0;
    var lastY = placed.length ? placed[placed.length - 1].ly : 0;
    if (placed.length && lastY - firstY > hiY - loY) {
      // 跨度放不下：均布（间距可能 < minGap，但有界且不越界）
      for (var k3 = 0; k3 < placed.length; k3++) {
        placed[k3].ly = placed.length === 1 ? (loY + hiY) / 2
          : loY + (hiY - loY) * k3 / (placed.length - 1);
      }
    } else if (placed.length) {
      // 整体平移进 [loY,hiY]（间距不变）；浮点残差逐个钳制
      var shift = Math.min(Math.max(0, loY - firstY), hiY - lastY);
      for (var k4 = 0; k4 < placed.length; k4++) {
        placed[k4].ly = Math.max(loY, Math.min(hiY, placed[k4].ly + shift));
      }
    }
    var parts = [];
    var frameRight = fr.x0 + fr.pw;
    for (var m = 0; m < placed.length; m++) {
      var p = placed[m];
      // 标签被防重叠推离自然位置时画细引线（从绘图区右框边该曲线
      // 高度引到标签）；未被推动的标签不画，避免视觉噪声。
      if (Math.abs(p.ly - p.ny) > p.size * 0.35) {
        parts.push('<line x1="' + px(frameRight) + '" y1="' + px(p.ey) +
          '" x2="' + px(p.lx - 1.4 * u) + '" y2="' + px(p.ly) +
          '" stroke="' + (p.color || fill || "#666666") + '" stroke-width="' +
          px(0.5 * u) + '" stroke-opacity="0.5"/>');
      }
      parts.push(text(p.lx, p.ly, p.label, {
        anchor: "start", size: p.size, fill: p.color || fill,
        weight: "bold", part: "legend", seriesKey: p.it.key
      }));
    }
    return '<g data-legend-pos="inline">' + parts.join("") + "</g>";
  }

  // ---- 渐变系列色 ----
  function gradSpec(ctx) {
    var p = presOf(ctx.chartSpec);
    var pl = p && p.plot;
    var sc = pl && pl.seriesColors;
    if (!sc || sc.mode !== "gradient" || typeof sc.palette !== "string" || !sc.palette) return null;
    var colors = null;
    var FP = global.FigPalette;
    if (FP && typeof FP.colors === "function") {
      try { colors = FP.colors(sc.palette); } catch (e) { colors = null; }
    }
    if (!colors || !colors.length) {
      var FigPresets = global.FigPresets;
      if (FigPresets && typeof FigPresets.palette === "function") {
        try {
          var pal = FigPresets.palette(sc.palette);
          if (pal && Array.isArray(pal.colors)) colors = pal.colors;
        } catch (e2) { /* fallthrough */ }
      }
    }
    if (!colors || colors.length < 2) return null;
    return {
      colors: colors,
      reverse: sc.reverse === true,
      colorbar: (sc.colorbar && typeof sc.colorbar === "object") ? sc.colorbar : null
    };
  }

  // 渐变取色：t∈[0,1] 沿配色插值（colorAt 已有连续采样）。
  function gradColorAt(ctx, t) {
    var g = gradSpec(ctx);
    if (!g) return null;
    var tt = g.reverse ? 1 - t : t;
    return colorAt(g.colors, Math.max(0, Math.min(1, tt)));
  }

  // 数值分组检测：series 标签全为数值 → 返回 {min,max}，否则 null。
  function numericGroupRange(labels) {
    var vals = [], allNum = labels.length > 0;
    for (var i = 0; i < labels.length; i++) {
      var v = toNum(labels[i]);
      if (isNaN(v)) { allNum = false; break; }
      vals.push(v);
    }
    if (!allNum) return null;
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    return { min: mn, max: mx };
  }

  // ---- 显著性括号 + 字母标注 ----
  // bar/bar_grouped/box 渲染时把每柱/箱的顶部像素登记到 ctx.__annotMarks：
  // {cat, group, x, yTop, yErrTop}（yErrTop 含误差线顶，无误差=null）。
  function noteAnnotMark(ctx, cat, group, x, yTop, yErrTop, up) {
    var arr = ctx.__annotMarks || (ctx.__annotMarks = []);
    arr.push({ cat: String(cat), group: group == null ? null : String(group),
      x: x, yTop: yTop, yErrTop: yErrTop, up: up !== false });
  }

  function findAnnotMark(ctx, cat, group) {
    var arr = ctx.__annotMarks || [];
    var best = null;
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (m.cat !== String(cat)) continue;
      if (group != null && m.group !== String(group)) continue;
      if (group == null && m.group != null) {
        // 未指定分组：取该类别中顶部最高（yTop 最小）的柱
        if (!best || m.yTop < best.yTop) best = m;
      } else if (!best) best = m;
    }
    return best;
  }

  // 绘制显著性括号与字母。marks 已含像素位置；y 头room 已在值域中预留。
  function drawAnnotLayer(ctx, fr, u) {
    var spec = ctx.chartSpec || {};
    var sigs = Array.isArray(spec.significance) ? spec.significance : [];
    var letters = (spec.letters && typeof spec.letters === "object" && !Array.isArray(spec.letters))
      ? spec.letters : null;
    if (!sigs.length && !letters) return "";
    var marks = ctx.__annotMarks || [];
    if (!marks.length) return "";
    var f = fr.tickF;
    var parts = [];
    var lineCol = "#333333";
    var lw = Math.max(0.6 * u, 0.8);

    // R8b：先定位字母（贴柱/误差线顶），再放显著性括号——
    // 括号层在字母之上且不重叠：括号 yTop 计入跨越范围内的字母字形顶。
    var letterEls = [];
    var letterTops = []; // {x0,x1,yTop} 字形顶部（px，越小越高）
    if (letters) {
      var keys = Object.keys(letters);
      for (var li = 0; li < keys.length; li++) {
        var kk = keys[li];
        var kp = kk.split("|");
        var mk = findAnnotMark(ctx, kp[0], kp[1] != null ? kp[1] : null);
        if (!mk) continue;
        var top = mk.yErrTop != null ? Math.min(mk.yTop, mk.yErrTop) : mk.yTop;
        // 字母在标记「值端」外侧——正值柱向上、负值柱向下。
        var awayL = (mk.up === false) ? 1 : -1;
        var ly = top + awayL * 4 * u + (awayL > 0 ? f * 0.9 : 0);
        letterEls.push(text(mk.x, ly, String(letters[kk]), {
          anchor: "middle", size: f, fill: "#222222", weight: "bold",
          part: "letter"
        }));
        // 字形顶部估计：baseline ly，字高≈f；向上字母顶≈ly-0.85f，
        // 向下（负柱）字母底≈ly+0.25f——括号只需避开向上的。
        if (awayL < 0) {
          letterTops.push({ x0: mk.x - 4 * u, x1: mk.x + 4 * u, yTop: ly - f * 0.85 });
        }
      }
    }

    // ---- 显著性括号：按 x 区间贪心分层 ----
    // R6-G：括号底必须高于跨越范围内所有柱/误差线顶 + 间隙；R8b：
    // 还要高于范围内所有字母字形顶，保证括号层整体在字母之上。
    var tiers = []; // 每层已占 x 区间
    var sigEls = [];
    for (var si = 0; si < sigs.length; si++) {
      var s = sigs[si];
      var ma = findAnnotMark(ctx, s.a, s.group);
      var mb = findAnnotMark(ctx, s.b, s.group);
      if (!ma || !mb) continue; // 校验已挡类别不存在；渲染期再兜底
      var xa = ma.x, xb = mb.x;
      if (xa > xb) { var tt = xa; xa = xb; xb = tt; }
      var xPad = 3 * u;
      var yTop = Infinity;
      for (var mi = 0; mi < marks.length; mi++) {
        var mk2 = marks[mi];
        if (mk2.x < xa - xPad || mk2.x > xb + xPad) continue;
        var t2 = mk2.yTop;
        if (mk2.yErrTop != null) t2 = Math.min(t2, mk2.yErrTop);
        if (t2 < yTop) yTop = t2;
      }
      for (var lti = 0; lti < letterTops.length; lti++) {
        var lt2 = letterTops[lti];
        if (lt2.x1 < xa - xPad || lt2.x0 > xb + xPad) continue;
        if (lt2.yTop < yTop) yTop = lt2.yTop;
      }
      if (!isFinite(yTop)) yTop = Math.min(ma.yTop, mb.yTop);
      var away = -1; // 括号永远画在所有标记上方
      // 选最小不冲突层
      var tier = 0;
      for (;;) {
        var used = tiers[tier] || (tiers[tier] = []);
        var conflict = false;
        for (var ui = 0; ui < used.length; ui++) {
          if (xa < used[ui].x1 + 4 * u && xb > used[ui].x0 - 4 * u) { conflict = true; break; }
        }
        if (!conflict) { used.push({ x0: xa, x1: xb }); break; }
        tier++;
        if (tier > 30) break;
      }
      var stepY = (f * 1.5 + 4 * u);
      var yLine = yTop + away * (3 * u + tier * stepY);
      var arm = Math.min(5 * u, (xb - xa) / 2);
      var armDir = away; // 括号短臂朝数据端
      sigEls.push(lineEl(xa, yLine, xb, yLine, lineCol,
        ' stroke-width="' + px(lw) + '" data-chart-part="significance"'));
      sigEls.push(lineEl(xa, yLine, xa, yLine + armDir * 3.5 * u, lineCol,
        ' stroke-width="' + px(lw) + '"'));
      sigEls.push(lineEl(xb, yLine, xb, yLine + armDir * 3.5 * u, lineCol,
        ' stroke-width="' + px(lw) + '"'));
      // R6-G：标注字号用刻度字号 f（原 f*0.9 太小）；away=-1 → 文字在
      // 横线上方（baseline 抬高），away=+1 → 在横线下方。
      var sigY = (away < 0) ? yLine - 2 * u : yLine + f + 2 * u;
      sigEls.push(text((xa + xb) / 2, sigY,
        String(s.label), {
          anchor: "middle", size: f, fill: lineCol, weight: "bold",
          part: "significance"
        }));
    }

    // 字母先画、括号后画：SVG 后画者在上，括号层视觉上也在字母之上。
    parts = letterEls.concat(sigEls);
    return parts.length ? '<g data-chart-part="annotations">' + parts.join("") + "</g>" : "";
  }

  // 显著性/字母需要的 y 头room（数据单位）：在 niceTicks 前调用，
  // 按层数估算并上扩 dom.max。返回需要上扩的量（>=0）。
  function annotHeadroom(ctx, dom, estPhPx) {
    var spec = ctx.chartSpec || {};
    var sigs = Array.isArray(spec.significance) ? spec.significance : [];
    var letters = spec.letters && typeof spec.letters === "object" ? spec.letters : null;
    var n = sigs.length + (letters ? Object.keys(letters).length : 0);
    if (!n) return 0;
    var span = dom.max - dom.min;
    if (!(span > 0)) return 0;
    // R8b：层数按「括号层数 + 字母层」估（原把每个标注都当一层，
    // 小图上 needPx/ph 爆炸把 y 轴撑到数十倍数据范围）。
    var u = ctx.dpi / 72;
    var f = tickFontPx(ctx);
    var stepPx = f * 1.5 + 4 * u;
    var layers = Math.min(Math.max(sigs.length, 0) + (letters ? 1 : 0) || 1, 6);
    var needPx = layers * stepPx + (letters ? f * 1.6 : 0) + 6 * u;
    // R8b：绘图区高估为图高 62%（原 ctx.H-110u 在 <50mm 小图上只剩
    // 十几 px，头room 反而爆炸）；estPhPx>0 时优先用调用方实测值。
    var ph = estPhPx > 0 ? estPhPx : Math.max(ctx.H * 0.62, 40 * u);
    if (!(ph > 0)) return span * 0.15;
    return Math.min(span * (needPx / ph), span * 0.9);
  }

  // ---- 误差带（errorStyle:"band"，仅 line/line_multi）----
  // 与误差栏同一不确定性来源（chart.statistics → cellUncertainty）。
  // seriesBands: [{key,color,group,pts:[{px,xlab,y}]}]，由 drawSeriesChart
  // 在 sx/sy 就绪后整理好传入；无法解析的单元格跳过（不虚构）。
  function drawErrorBands(ctx, seriesBands) {
    var p = presOf(ctx.chartSpec);
    var pl = p && p.plot;
    if (!pl || pl.errorStyle !== "band") return "";
    var type = ctx.chartSpec.chartType;
    if (type !== "line" && type !== "line_multi") return "";
    // 宽表（mapping.ys）无 group 列，cellUncertainty 无法按系列分单元格
    if (Array.isArray(ctx.mapping.ys) && ctx.mapping.ys.length >= 2) return "";
    var stats = (ctx.chartSpec && typeof ctx.chartSpec.statistics === "object")
      ? ctx.chartSpec.statistics : null;
    if (!stats) return "";
    var mapping = ctx.mapping || {};
    var columns = ctx.columns, rows = ctx.rows;
    var parts = [];
    for (var si = 0; si < seriesBands.length; si++) {
      var sb2 = seriesBands[si];
      // 按 x 类别归并（同 x 多点取均值，与折线同 x 语义一致）
      var byX = {}, order = [];
      for (var j = 0; j < sb2.pts.length; j++) {
        var pt = sb2.pts[j];
        if (!byX[pt.xlab]) { byX[pt.xlab] = { sum: 0, n: 0, px: pt.px, xlab: pt.xlab }; order.push(pt.xlab); }
        byX[pt.xlab].sum += pt.y; byX[pt.xlab].n += 1;
      }
      if (order.length < 2) continue;
      // order 需按 x 像素排序
      order.sort(function (a, b) { return byX[a].px - byX[b].px; });
      var cells = [];
      var okAny = false;
      for (var k = 0; k < order.length; k++) {
        var xl = order[k], agg = byX[xl];
        var meanY = agg.sum / agg.n;
        var cell = cellUncertainty(columns, rows, mapping, stats, xl, sb2.group);
        if (cell.ok) {
          var eb = errorBounds(cell, meanY);
          cells.push({ px: agg.px, hi: eb.hi, lo: eb.lo });
          okAny = true;
        } else {
          cells.push({ px: agg.px, hi: meanY, lo: meanY });
        }
      }
      if (!okAny) continue;
      // 连续段（缺带处断开——这里所有点都有值，整段成带）
      var syB = sb2.sy || function (v) { return v; };
      var bpts = cells.map(function (c) { return { x: c.px, y: syB(c.hi) }; });
      var bl = cells.slice().reverse().map(function (c) { return { x: c.px, y: syB(c.lo) }; });
      for (var bi = 0; bi < bl.length; bi++) bpts.push(bl[bi]);
      // R6-A：导出无 clip-path，误差带多边形须数学裁剪到绘图区
      // （无条件裁剪：数据超出自动域/误差带越界时同样不得出框）
      var clipR = ctx.__plotFrame
        ? (function (pf) {
            var bt = pf.y0 + pf.ph - ((pf.stickBand && pf.stickBand.h) || 0);
            return { x0: pf.x0, y0: pf.y0, x1: pf.x0 + pf.pw, y1: bt };
          })(ctx.__plotFrame)
        : null;
      if (clipR) bpts = clipPolyRect(bpts, clipR);
      if (bpts.length < 3) continue;
      var d = "M " + bpts.map(function (p) { return px(p.x) + " " + px(p.y); }).join(" L ") + " Z";
      parts.push('<path d="' + d + '" fill="' + sb2.color + '" fill-opacity="0.2" stroke="none"' +
        ' data-chart-part="error-band" data-series-key="' + esc(sb2.key) + '"/>');
    }
    return parts.length ? '<g data-chart-part="error-bands">' + parts.join("") + "</g>" : "";
  }

  // 渐变系列色：renderer 在确定系列顺序后调用一次，登记每系列 t∈[0,1]。
  // entries = [{key,label}]（label 用于数值分组检测）。
  function setupSeriesGradient(ctx, entries) {
    ctx.__gradT = null; ctx.__gradN = 0; ctx.__gradMin = null; ctx.__gradMax = null;
    if (!gradSpec(ctx) || !entries || !entries.length) return;
    var nr = numericGroupRange(entries.map(function (e) { return e.label; }));
    var t = {}, i;
    if (nr) {
      var span = nr.max - nr.min;
      for (i = 0; i < entries.length; i++) {
        var v = toNum(entries[i].label);
        t[entries[i].key] = (span > 0) ? (v - nr.min) / span : 0.5;
      }
      ctx.__gradMin = nr.min; ctx.__gradMax = nr.max;
    } else {
      for (i = 0; i < entries.length; i++) {
        t[entries[i].key] = entries.length > 1 ? i / (entries.length - 1) : 0;
      }
    }
    ctx.__gradT = t; ctx.__gradN = entries.length;
  }

  // effSeriesStyle 用：渐变模式下的默认 stroke（显式 series.stroke 仍优先）。
  function gradSeriesStroke(ctx, key, paletteIndex) {
    if (!gradSpec(ctx)) return null;
    var t = 0;
    if (ctx.__gradT && typeof ctx.__gradT[key] === "number") t = ctx.__gradT[key];
    else if (ctx.__gradN > 1) t = paletteIndex / (ctx.__gradN - 1);
    return gradColorAt(ctx, t);
  }

  // ---- cartesianFrame 扩展：sticks 参考带 + 色标预留 ----
  function refsLayout(ctx) {
    var groups = stickRefs(ctx);
    if (!groups.length) return null;
    var u = ctx.dpi / 72;
    var f = tickFontPx(ctx);
    // 每组一行：行高 ≈ 字号*1.3 + 2u，上限 ~26% plot 高
    var rowH = Math.max(f * 1.35, 9 * u);
    var h = Math.min(groups.length * rowH + 3 * u, ctx.H * 0.26);
    return { h: h, groups: groups };
  }

  function colorbarWanted(ctx) {
    var g = gradSpec(ctx);
    return !!(g && g.colorbar && g.colorbar.show === true);
  }

  // 竖直色标：画在绘图区右侧预留区内。min/max 取 colorbar 显式值，
  // 否则数值分组的 min/max，非数值分组画两端系列名（不推断数值）。
  function drawColorbar(ctx, fr) {
    if (!colorbarWanted(ctx)) return "";
    var g = gradSpec(ctx);
    var cb = g.colorbar;
    var u = ctx.dpi / 72, f = fr.tickF;
    var barW = 7 * u;
    // 色条顶让出端值/标题行；端值与标题画在绘图区上缘之外的预留区
    // （cartesianFrame 已把同额高度计入 padTop），不再压色条顶端。
    var top = fr.y0 + f * 0.5;
    var bot = plotDataBottom(fr) - 2 * u;
    var h = bot - top;
    if (h < 8) return "";
    // 端值标注：colorbar.min/max 显式值 > 数值分组范围 > 两端系列名
    var minL, maxL;
    if (ctx.__gradMin != null && ctx.__gradMax != null) {
      minL = (typeof cb.min === "number" && isFinite(cb.min)) ? fmtNum(cb.min) : fmtNum(ctx.__gradMin);
      maxL = (typeof cb.max === "number" && isFinite(cb.max)) ? fmtNum(cb.max) : fmtNum(ctx.__gradMax);
    } else {
      var items = fr.legend || [];
      minL = items.length ? legendLabel(items[0]) : "";
      maxL = items.length ? legendLabel(items[items.length - 1]) : "";
    }
    // R6-E：色标用分段小矩形而非 linearGradient——MuPDF SVG 导入器不支持
    // 渐变原语，url(#) 填充会退化成黑色。
    var nSeg = 28, segH = h / nSeg;
    // 色条位置：优先贴绘图区右缘；端值标签半宽不得越出画布右缘
    var labW = 0;
    [minL, maxL].forEach(function (s2) {
      var w2 = s2 ? textW(s2, f * 0.8) : 0;
      if (w2 > labW) labW = w2;
    });
    var cbLabW = cb.label ? textW(String(cb.label), f * 0.85) : 0;
    if (cbLabW > labW) labW = cbLabW;
    var x = fr.x0 + fr.pw + 3 * u;
    var maxCx = ctx.W - 2 * u - labW / 2;
    if (x + barW / 2 > maxCx) x = maxCx - barW / 2;
    var parts = [];
    for (var si = 0; si < nSeg; si++) {
      var t = si / (nSeg - 1);
      var sy0 = top + si * segH;
      var sh = (si === nSeg - 1) ? (bot - sy0) : segH + 0.5; // 相邻微叠防缝
      parts.push(rectEl(x, sy0, barW, sh, gradColorAt(ctx, t)));
    }
    parts.push('<rect x="' + px(x) + '" y="' + px(top) + '" width="' + px(barW) +
      '" height="' + px(h) + '" fill="none" stroke="#999999" stroke-width="' +
      px(0.5 * u) + '"/>');
    // 端值/标题基线统一从 top 向上排：maxL 在 top-1.0f，标题再高 1.15f；
    // top=fr.y0+0.5f → 全部落在 cartesianFrame 预留的 padTop 条带内。
    var maxBase = top - f * 1.0;
    if (cb.label) {
      parts.push(text(x + barW / 2, maxBase - f * 1.15, String(cb.label), {
        anchor: "middle", size: f * 0.85, fill: "#444444", part: "colorbar-label"
      }));
    }
    if (minL) parts.push(text(x + barW / 2, bot + f * 1.0, minL, {
      anchor: "middle", size: f * 0.8, fill: "#444444", part: "colorbar-tick"
    }));
    if (maxL) parts.push(text(x + barW / 2, maxBase, maxL, {
      anchor: "middle", size: f * 0.8, fill: "#444444", part: "colorbar-tick"
    }));
    return '<g data-chart-part="colorbar">' + parts.join("") + "</g>";
  }

  // cartesian layout: computes paddings from tick labels, axis titles, legend
  // H1：间距/刻度度量按 pt（×u=px/pt），与字号同单位，dpi 间布局一致。
  function cartesianFrame(ctx, o) {
    var u = ctx.dpi / 72;
    var f = tickFontPx(ctx), tf = f * 1.15;
    var plot = effPlot(ctx);
    var tickLen = plot.tickLengthPt * u;
    var tickGap = STYLE_DEFAULTS.tickGapPt * u;
    var padLeft = 2 * u, padRight = 3 * u, padTop = 2 * u, padBottom = 2 * u;
    if (ctx.axes.title) padTop += tf * 1.9;
    // 极坐标类图型（taylor）不画笛卡尔刻度/轴标题：noCartesianPads 时
    // 只保留呼吸边距，把空间还给极区（否则 padBottom 的 xLabel 预留会让
    // 半径被压到绘图区宽度的 ~75%，图显得缩在一角）。
    var noCP = !!(o && o.noCartesianPads);

    var yMaxW = 0;
    var yLabels = noCP ? [] : (o.yTickLabels || []);
    for (var i = 0; i < yLabels.length; i++) {
      var lw = textW(yLabels[i], f);
      if (lw > yMaxW) yMaxW = lw;
    }
    padLeft += yMaxW + (noCP ? 0 : (tickLen + tickGap + u));
    if (!noCP && ctx.axes.yLabel) padLeft += tf * 1.7;

    // R4-HB：右轴标签与标题预留右侧边距（与左轴对称）；y2BlockW 记下
    // 「脊线→右轴标题外缘」的占用宽度，右图例须排在其右侧（HB2 修复重叠）。
    // HB2：右轴标题为 rotate(-90) 文本，其水平半宽≈0.6×titleF，块宽按
    // 「labOff + 标签宽 + 间距 + 半宽 + 标题字高」计。
    var tdirF = plot.tickDirection === "in" ? 1 : -1;
    var labOffF = tdirF === 1 ? tickGap : (tickLen + tickGap);
    var y2MaxW = 0;
    var y2Labels = o.y2TickLabels || [];
    for (var j2 = 0; j2 < y2Labels.length; j2++) {
      var lw2 = textW(y2Labels[j2], f);
      if (lw2 > y2MaxW) y2MaxW = lw2;
    }
    var y2BlockW = 0;
    if (y2Labels.length) {
      y2BlockW = labOffF + y2MaxW + u +
        (o.y2Title ? (tickGap + tf * 0.6 + tf * 1.2 + u) : 0);
      padRight += y2BlockW;
    }

    if (!noCP) padBottom += f * 1.5 + tickLen + tickGap;
    if (!noCP && ctx.axes.xLabel) padBottom += tf * 1.7;

    var legend = o.legend || [];
    // R10：新图型单系列默认不画图例——单项图例只是 y 列名等冗余信息，
    // 且预留的 padRight 会白白压缩绘图区；用户经
    // presentation.legend.position 显式指定时保留（含 "none" 之外的任意位）。
    // 只作用于 R10 图型，既有图型行为不变。
    if (legend.length === 1 &&
        ["bar_stacked", "violin", "dotplot", "paired", "marginal", "volcano",
         "forest", "survival", "roc", "pca", "venn", "sankey", "taylor"]
          .indexOf(ctx.chartSpec.chartType) >= 0 &&
        !(presLegendStyle(ctx).position)) {
      legend = [];
    }
    if (legend.length && legendPos(ctx) !== "none") {
      var pos = legendPos(ctx);
      if (pos === "right") padRight += 6 * u + (STYLE_DEFAULTS.legendLineLenPt + STYLE_DEFAULTS.legendGapPt + 2) * u + legendMaxW(legend, f) + 4 * u; // H1：图例与绘图区间 6pt
      else if (pos === "top") padTop += f * 2.0;
      else if (pos === "bottom") padBottom += f * 2.0;
      else if (pos === "inline") {
        // R6-C：行内标签写在绘图区右框外，按最长系列名预留宽度，
        // 否则标签会超出画布被截断。
        var inlW = legendMaxW(legend, f);
        padRight += inlW + 6 * u;
      }
    }
    // R6：sticks 参考带占绘图区底部（fr.stickBand），数据区相应上移；
    // 色标 show 时右侧预留条宽+端值标签宽。
    var sref = o.noStickBand ? null : refsLayout(ctx);
    var cbStripW = 0;
    if (colorbarWanted(ctx)) {
      var cbg = gradSpec(ctx), cbl = cbg.colorbar;
      // R6-E：色标端值/标题画在绘图区上缘之外——padTop 须预留对应高度，
      // 否则标签压到上框/标题区（与 drawColorbar 的 headH 口径一致）。
      padTop += f * (cbl.label ? 2.8 : 1.6);
      var endTxts = [];
      if (ctx.__gradMin != null && ctx.__gradMax != null) {
        endTxts = [fmtNum(ctx.__gradMin), fmtNum(ctx.__gradMax)];
      } else if (legend.length) {
        endTxts = [legendLabel(legend[0]), legendLabel(legend[legend.length - 1])];
      }
      var cbEndW = 0;
      for (var ei = 0; ei < endTxts.length; ei++) {
        var ew = textW(endTxts[ei], f * 0.8);
        if (ew > cbEndW) cbEndW = ew;
      }
      var cbLabW = cbl.label ? textW(String(cbl.label), f * 0.85) : 0;
      cbStripW = 7 * u + 3 * u + Math.max(cbEndW, cbLabW) + 4 * u;
      padRight += cbStripW;
    }
    if (o.extraRight) padRight += o.extraRight;

    var pw = ctx.W - padLeft - padRight;
    var ph = ctx.H - padTop - padBottom;
    if (pw < 30 || ph < 30) {
      throw new Error("renderChartSVG：画布尺寸过小，无法容纳坐标轴（请提供更大的 width_mm/height_mm）");
    }
    // H1：右图例起点在绘图区右缘之外再留 6pt；HB2：右轴存在时图例再让过
    // 右轴刻度标签与标题区（y2BlockW），避免与「20」类刻度字/轴标题重叠。
    var legXGap = (legend.length && legendPos(ctx) === "right") ? 6 * u : 0;
    var legendX = ctx.W - padRight + legXGap + ((legend.length && legendPos(ctx) === "right") ? y2BlockW : 0);
    var fr = {
      x0: padLeft, y0: padTop, pw: pw, ph: ph,
      tickF: f, titleF: tf,
      yTickMaxW: yMaxW,
      y2TickMaxW: y2MaxW,
      legend: legend,
      legendX: legendX,
      legendMaxW: legend.length ? legendMaxW(legend, f) : 0,
      y2BlockW: y2BlockW,
      cbStripW: cbStripW,
      stickBand: sref ? { h: sref.h } : null
    };
    // R6-C：行内标签起点=绘图区右缘之外（让过右轴块与色标条），
    // 宽度已在 padRight 预留
    fr.inlineX = fr.x0 + fr.pw + 2.5 * u + (fr.y2BlockW || 0) + (fr.cbStripW || 0);
    // R5：绘图区底色需要压在所有系列之下，由 wrap() 统一前置输出
    ctx.__plotFrame = fr;
    return fr;
  }

  function thinTicks(ticks, f) {
    var kept = [], lastX = -Infinity, lastW = 0;
    for (var i = 0; i < ticks.length; i++) {
      var t = ticks[i];
      if (kept.length === 0 || t.px - lastX > lastW + 8) {
        kept.push(t);
        lastX = t.px;
        lastW = textW(t.label, f);
      }
    }
    return kept;
  }

  function drawFrameAxes(ctx, fr, o) {
    var parts = [];
    var x0 = fr.x0, y0 = fr.y0, pw = fr.pw, ph = fr.ph, f = fr.tickF;
    var yb = y0 + ph;
    var i, t;
    var u = ctx.dpi / 72;
    var plot = effPlot(ctx);
    var axW = plot.axisWidthPt * u;
    var tickLen = plot.tickLengthPt * u;
    var tickGap = STYLE_DEFAULTS.tickGapPt * u;
    var tickDir = plot.tickDirection === "in" ? 1 : -1;
    var axExtra = ' stroke-width="' + px(axW) + '"';
    // R4：刻度朝内时刻度线伸进绘图区，标签贴轴线 tickGap；
    // 朝外时标签仍在 tickLen + tickGap 处（轴外）。
    var labOff = tickDir === 1 ? tickGap : (tickLen + tickGap);

    // R04：轴标题/刻度展示覆盖（只改字号/颜色/字重，不改几何与数据）
    var presX = presAxisStyle(ctx, "x");
    var presY = presAxisStyle(ctx, "y");
    var tickStyleX = effTextStyle({}, presX.tick);
    var tickStyleY = effTextStyle({}, presY.tick);
    var titleStyleX = effTextStyle({}, presX.title);
    var titleStyleY = effTextStyle({}, presY.title);

    // R6：presentation.axes.{x,y}.tick.hidden → 该轴不画刻度线与刻度数字
    // （轴线/边框/轴标题保留；网格线属 axes.gridlines，不受影响）。
    var hideYTick = !!(presY.tick && presY.tick.hidden === true);
    var hideXTick = !!(presX.tick && presX.tick.hidden === true);

    if (ctx.axes.gridlines) {
      var gridCol = plot.gridColor || STYLE_DEFAULTS.gridColor;
      for (i = 0; i < o.yTicks.length; i++) {
        t = o.yTicks[i];
        if (t.px > y0 + 0.5 && t.px < yb - 0.5) {
          parts.push(lineEl(x0, t.px, x0 + pw, t.px, gridCol,
            ' stroke-width="' + px(STYLE_DEFAULTS.gridWidthPt * u) + '"'));
        }
      }
    }
    // R6：sticks 参考带垫在网格之上、数据区之下（带内自带底色盖住网格）
    parts.push(drawStickBand(ctx, fr));
    if (o.zeroY != null && o.zeroY > y0 + 0.5 && o.zeroY < yb - 0.5) {
      parts.push(lineEl(x0, o.zeroY, x0 + pw, o.zeroY, STYLE_DEFAULTS.zeroColor,
        ' stroke-width="' + px(STYLE_DEFAULTS.zeroWidthPt * u) +
        '" stroke-dasharray="' + dashPt(STYLE_DEFAULTS.zeroDash, u) + '"'));
    }
    // R5：axisWidthPt=0 → 不画轴线/框线（刻度线宽度独立回退，刻度仍可见）
    var tickW = axW > 0 ? axW : STYLE_DEFAULTS.tickWidthPt * u;
    if (axW > 0) {
      parts.push(lineEl(x0, y0, x0, yb, STYLE_DEFAULTS.axisColor, axExtra));
      parts.push(lineEl(x0, yb, x0 + pw, yb, STYLE_DEFAULTS.axisColor, axExtra));
      if (plot.frame === "box") {
        parts.push(lineEl(x0, y0, x0 + pw, y0, STYLE_DEFAULTS.axisColor, axExtra));
        parts.push(lineEl(x0 + pw, y0, x0 + pw, yb, STYLE_DEFAULTS.axisColor, axExtra));
      }
    }
    var tickExtra = ' stroke-width="' + px(tickW) + '"';

    if (!hideYTick) {
      for (i = 0; i < o.yTicks.length; i++) {
        t = o.yTicks[i];
        // tickDirection=out 朝左（画布外），in 朝右（绘图区内）；刻度文字恒在轴外
        // R5：tickLengthPt=0 → 不画刻度线，标签保留
        if (tickLen > 0) {
          parts.push(lineEl(tickDir === 1 ? x0 : x0 - tickLen, t.px,
            tickDir === 1 ? x0 + tickLen : x0, t.px, STYLE_DEFAULTS.tickColor,
            tickExtra));
        }
        parts.push(text(x0 - labOff, t.px + f * 0.35, t.label, {
          anchor: "end",
          size: (typeof tickStyleY.fontSizePt === "number") ? fontPx(tickStyleY.fontSizePt, ctx.dpi) : f,
          fill: tickStyleY.color || undefined,
          weight: tickStyleY.fontWeight || undefined,
          part: "axis-tick-y"
        }));
      }
    }

    // R4-HB：右轴刻度（仅在有 y2 时绘制；顶/右边框线本身无刻度，仅 y2 刻度画在右脊）
    if (o.y2Ticks && o.y2Ticks.length) {
      var xr = x0 + pw;
      for (i = 0; i < o.y2Ticks.length; i++) {
        t = o.y2Ticks[i];
        if (tickLen > 0) {
          parts.push(lineEl(tickDir === 1 ? xr - tickLen : xr, t.px,
            tickDir === 1 ? xr : xr + tickLen, t.px, STYLE_DEFAULTS.tickColor,
            tickExtra));
        }
        parts.push(text(xr + labOff, t.px + f * 0.35, t.label, {
          anchor: "start",
          size: (typeof tickStyleY.fontSizePt === "number") ? fontPx(tickStyleY.fontSizePt, ctx.dpi) : f,
          fill: tickStyleY.color || undefined,
          weight: tickStyleY.fontWeight || undefined,
          part: "axis-tick-y2"
        }));
      }
      if (o.y2Label) {
        // HB2：旋转标题的水平半宽≈0.6×titleF，中心须让出「半宽+间距」，
        // 否则标题左缘会压进最宽刻度标签（镜像左轴同一修正）。
        var rx = xr + labOff + (fr.y2TickMaxW || 0) + tickGap + fr.titleF * 0.6,
            ry = y0 + ph / 2;
        parts.push(text(rx, ry, o.y2Label, {
          anchor: "middle",
          size: (typeof titleStyleY.fontSizePt === "number") ? fontPx(titleStyleY.fontSizePt, ctx.dpi) : fr.titleF,
          fill: titleStyleY.color || undefined,
          weight: titleStyleY.fontWeight || undefined,
          transform: "rotate(-90 " + px(rx) + " " + px(ry) + ")",
          part: "axis-title-y2"
        }));
      }
    }

    // R8b：类别轴（bar/bar_grouped/box 等 xTicks 带 cat:true）不抽稀——
    // 抽稀会丢类别（如 Low）；放不下时统一旋转 -45°。
    var xt = o.xTicks || [];
    var xCat = xt.length > 0 && xt[0].cat === true;
    var xRot = false;
    if (!xCat) xt = thinTicks(xt, f);
    else {
      for (i = 1; i < xt.length; i++) {
        var wA = textW(xt[i - 1].label, f), wB = textW(xt[i].label, f);
        if (xt[i].px - xt[i - 1].px < (wA + wB) * 0.5 + 4 * u) { xRot = true; break; }
      }
    }
    if (!hideXTick) {
      for (i = 0; i < xt.length; i++) {
        t = xt[i];
        if (tickLen > 0) {
          parts.push(lineEl(t.px, tickDir === 1 ? yb - tickLen : yb, t.px, tickDir === 1 ? yb : yb + tickLen,
            STYLE_DEFAULTS.tickColor, tickExtra));
        }
        var tickSize = (typeof tickStyleX.fontSizePt === "number") ? fontPx(tickStyleX.fontSizePt, ctx.dpi) : f;
        if (xRot) {
          // 旋转 -45°：锚点在刻度正下方，文字向左上延伸
          var rx0 = t.px, ry0 = yb + f * 1.1 + tickSize * 1.5;
          parts.push(text(rx0, ry0, t.label, {
            anchor: "end",
            size: tickSize,
            fill: tickStyleX.color || undefined,
            weight: tickStyleX.fontWeight || undefined,
            transform: "rotate(-45 " + px(rx0) + " " + px(ry0) + ")",
            part: "axis-tick-x"
          }));
        } else {
          parts.push(text(t.px, yb + f * 1.25, t.label, {
            anchor: "middle",
            size: tickSize,
            fill: tickStyleX.color || undefined,
            weight: tickStyleX.fontWeight || undefined,
            part: "axis-tick-x"
          }));
        }
      }
    }

    if (ctx.axes.xLabel) {
      parts.push(text(x0 + pw / 2, yb + f * 1.25 + fr.titleF, ctx.axes.xLabel, {
        anchor: "middle",
        size: (typeof titleStyleX.fontSizePt === "number") ? fontPx(titleStyleX.fontSizePt, ctx.dpi) : fr.titleF,
        fill: titleStyleX.color || undefined,
        weight: titleStyleX.fontWeight || undefined,
        part: "axis-title-x"
      }));
    }
    if (ctx.axes.yLabel) {
      // HB2：与右轴标题同一修正——旋转标题半宽≈0.6×titleF，中心让出
      // 「半宽+间距」避免压住最宽刻度标签。
      var lx = x0 - labOff - fr.yTickMaxW - tickGap - fr.titleF * 0.6,
          ly = y0 + ph / 2;
      parts.push(text(lx, ly, ctx.axes.yLabel, {
        anchor: "middle",
        size: (typeof titleStyleY.fontSizePt === "number") ? fontPx(titleStyleY.fontSizePt, ctx.dpi) : fr.titleF,
        fill: titleStyleY.color || undefined,
        weight: titleStyleY.fontWeight || undefined,
        transform: "rotate(-90 " + px(lx) + " " + px(ly) + ")",
        part: "axis-title-y"
      }));
    }
    if (ctx.axes.title) {
      parts.push(text(x0 + pw / 2, y0 - fr.titleF * 0.5, ctx.axes.title, { anchor: "middle", size: fr.titleF, weight: "bold" }));
    }
    // R6：lines 风格参考线（虚线竖线+顶部 label）与渐变色标，画在最上层
    parts.push(drawLineRefs(ctx, fr));
    parts.push(drawColorbar(ctx, fr));
    return parts.join("");
  }

  // 图例色块宽（pt→px），供 drawLegend 排版文字位置
  function legendSwatchW(ctx, it) {
    var u = ctx.dpi / 72, D = STYLE_DEFAULTS;
    return (it.kind === "line" ? D.legendLineLenPt : D.legendBlockPt) * u;
  }

  function legendSwatch(ctx, it, x, y, maxDiaPx) {
    var u = ctx.dpi / 72, D = STYLE_DEFAULTS;
    if (it.kind === "line") {
      return lineEl(x, y, x + D.legendLineLenPt * u, y, it.color,
        ' stroke-width="' + px(D.legendLineWidthPt * u) + '"');
    }
    if (it.kind === "marker") {
      // H1：散点图例标记直径＝该系列点实际直径，但不超过图例字号
      var dia = (typeof it.diaPt === "number") ? it.diaPt * u : D.legendBlockPt * u;
      if (typeof maxDiaPx === "number" && dia > maxDiaPx) dia = maxDiaPx;
      var r = dia / 2;
      return markerShapeEl(x + r, y, r, it.color, "", it.marker || "circle");
    }
    var b = D.legendBlockPt * u;
    return rectEl(x, y - b / 2, b, b, it.color);
  }

  /* ====================================================================
   * R5 返工：inside-best 图例定位。系列绘制时把数据几何（点/折线/柱/误差线）
   * 记入 ctx.__geom，drawLegend 之前由 pickInsideLegend 给四个内角打分，
   * 选重叠最小者；全部超阈值则退回 right（预留宽度由二次渲染完成）。
   * ==================================================================== */

  var GEOM_MAX = 9000;
  function noteGeom(ctx, g) {
    if (!ctx) return;
    var arr = ctx.__geom || (ctx.__geom = []);
    if (arr.length < GEOM_MAX) arr.push(g);
  }

  // 图例内角度量：条目宽度/字号/行高与 drawLegend 实际排版同一来源。
  function legendInsideMetrics(ctx, fr) {
    var items = fr.legend || [];
    var u = ctx.dpi / 72;
    var lp = presLegendStyle(ctx);
    var size = (typeof lp.fontSizePt === "number") ? fontPx(lp.fontSizePt, ctx.dpi) : fr.tickF;
    var gap = STYLE_DEFAULTS.legendGapPt * u;
    var rowH = size * STYLE_DEFAULTS.legendRowRatio;
    var infos = [];
    var maxW = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var swW = legendSwatchW(ctx, it);
      var lb = legendLabel(it);
      var w = swW + gap + textW(lb, size);
      infos.push({ it: it, swW: swW, lb: lb, w: w });
      if (w > maxW) maxW = w;
    }
    return { infos: infos, maxW: maxW, size: size, gap: gap, rowH: rowH,
      pad: 4 * u, u: u, fill: lp.color || undefined, frame: lp.frame === true };
  }

  // 第 i 行在给定内角的 cy（顶部两角自上而下，底部两角自下而上）。
  function insideCornerCy(m, fr, corner, i) {
    var n = m.infos.length;
    if (corner === "inside-bl" || corner === "inside-br") {
      var cyLast = plotDataBottom(fr) - m.pad - m.size * 0.45;
      return cyLast - (n - 1 - i) * m.rowH;
    }
    return fr.y0 + m.pad + m.size * 0.8 + i * m.rowH;
  }

  function insideCornerBox(m, fr, corner) {
    var n = m.infos.length;
    if (!n) return null;
    var right = fr.x0 + fr.pw - m.pad;
    var left = fr.x0 + m.pad;
    var anchorRight = corner === "inside-tr" || corner === "inside-br";
    var x0 = anchorRight ? right - m.maxW : left;
    var x1 = anchorRight ? right : left + m.maxW;
    var y0 = insideCornerCy(m, fr, corner, 0) - m.size * 0.9;
    var y1 = insideCornerCy(m, fr, corner, n - 1) + m.size * 0.45;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  var INSIDE_LEGEND_CORNERS = ["inside-tl", "inside-tr", "inside-bl", "inside-br"];

  function rectOverlapArea(a, b) {
    var x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
    var x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
    return (x1 > x0 && y1 > y0) ? (x1 - x0) * (y1 - y0) : 0;
  }

  function ptOverlap(box, x, y, r) {
    return rectOverlapArea(box, { x0: x - r, y0: y - r, x1: x + r, y1: y + r });
  }

  // 线段按 ~6px 采样成小点矩形计重叠（折线/误差线共用）。
  // 采样半径 2.2px ≈ 线宽+描边的视觉覆盖，避免细线穿过图例漏计。
  // 返回 {area,hits}：hits=与框相交的采样点数——细几何（线/点）穿过
  // 图例时面积占比很小但视觉遮挡明显，hits 供 pickInsideLegend 加罚。
  function segOverlap(box, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.max(1, Math.min(32, Math.ceil(len / 6)));
    var area = 0, hits = 0;
    for (var k = 0; k <= steps; k++) {
      var t = k / steps;
      var a = ptOverlap(box, x1 + dx * t, y1 + dy * t, 2.2);
      area += a;
      if (a > 0) hits++;
    }
    return { area: area, hits: hits };
  }

  function legendGeomScore(geom, box) {
    var area = 0, hits = 0;
    for (var i = 0; i < geom.length; i++) {
      var g = geom[i];
      if (g.t === "rect") {
        var ra = rectOverlapArea(g, box);
        area += ra;
        if (ra > 0) hits++;
      } else if (g.t === "pt") {
        var pa = ptOverlap(box, g.x, g.y, g.r || 2);
        area += pa;
        if (pa > 0) hits++;
      } else if (g.t === "seg") {
        var s = segOverlap(box, g.x1, g.y1, g.x2, g.y2);
        area += s.area; hits += s.hits;
      } else if (g.t === "line") {
        var p = g.pts;
        for (var j = 0; j < p.length; j++) {
          var la = ptOverlap(box, p[j].x, p[j].y, 2.5);
          area += la;
          if (la > 0) hits++;
          if (j + 1 < p.length) {
            var ls = segOverlap(box, p[j].x, p[j].y, p[j + 1].x, p[j + 1].y);
            area += ls.area; hits += ls.hits;
          }
        }
      }
    }
    return { area: area, hits: hits };
  }

  // inside-best 解析：返回 "inside-tl|tr|bl|br" 或 "right"。
  // 阈值 = 图例框面积的 20%（小阈值）；四角全超 → 退回 right 由外侧预留宽度。
  function pickInsideLegend(ctx, fr) {
    if (!fr || !(fr.legend || []).length) return "inside-tl";
    var m = legendInsideMetrics(ctx, fr);
    var geom = ctx.__geom || [];
    var best = null, bestScore = Infinity, bestArea = 1;
    for (var ci = 0; ci < INSIDE_LEGEND_CORNERS.length; ci++) {
      var c = INSIDE_LEGEND_CORNERS[ci];
      var b = insideCornerBox(m, fr, c);
      if (!b) continue;
      var mb = { x0: b.x0 - m.pad, y0: b.y0 - m.pad, x1: b.x1 + m.pad, y1: b.y1 + m.pad };
      var gs = legendGeomScore(geom, mb);
      var area = (b.x1 - b.x0) * (b.y1 - b.y0);
      // 面积分 + 命中数罚：细线/散点穿过图例时面积占比小但遮挡明显，
      // 每个相交采样按图例面积 1% 计罚（画廊小预览实测修正）。
      var sc = gs.area + gs.hits * area * 0.01;
      if (sc < bestScore) { bestScore = sc; best = c; bestArea = area; }
    }
    if (!best) return "inside-tl";
    if (bestScore > bestArea * 0.2) return "right";
    return best;
  }

  function drawLegend(ctx, fr) {
    var items = fr.legend || [];
    var pos = legendPos(ctx);
    if (!items.length || pos === "none") return "";
    // R6：inline —— 不画图例框，系列名写在各曲线右端（legendPos 已保证
    // 仅 line/line_multi/area/characterization 可达此分支）。
    if (pos === "inline") return drawInlineLegend(ctx, fr, items);
    var f = fr.tickF, u = ctx.dpi / 72;
    // R04：图例展示覆盖（字号/颜色），与系列共用 legendPos 单一来源
    var lp = presLegendStyle(ctx);
    var size = (typeof lp.fontSizePt === "number") ? fontPx(lp.fontSizePt, ctx.dpi) : f;
    var fill = lp.color || undefined;
    var rowH = size * STYLE_DEFAULTS.legendRowRatio;
    var gap = STYLE_DEFAULTS.legendGapPt * u;
    var entries = [];
    var i, it;
    if (pos === "inside-tr" || pos === "inside-tl" ||
        pos === "inside-br" || pos === "inside-bl") {
      // R5：绘图区内角落图例，带内边距；可选白底细框。
      // 返工：四角统一由 legendInsideMetrics/insideCornerCy 排版，
      // 底部两角自下而上堆叠。
      var lm = legendInsideMetrics(ctx, fr);
      var right = fr.x0 + fr.pw - lm.pad;
      var left = fr.x0 + lm.pad;
      var anchorRight = pos === "inside-tr" || pos === "inside-br";
      for (i = 0; i < lm.infos.length; i++) {
        var inf = lm.infos[i];
        var lx = anchorRight ? right - inf.w : left;
        var cy = insideCornerCy(lm, fr, pos, i);
        var sw = legendSwatch(ctx, inf.it, lx, cy, lm.size);
        var tx = lx + inf.swW + lm.gap;
        var txEl = text(tx, cy + lm.size * 0.35, inf.lb,
          { size: lm.size, fill: lm.fill, part: "legend", seriesKey: inf.it.key });
        entries.push({
          svg: sw + txEl,
          x0: lx, y0: cy - lm.size * 0.9, x1: tx + textW(inf.lb, lm.size), y1: cy + lm.size * 0.45
        });
      }
    } else if (pos === "right") {
      var y = fr.y0 + size;
      for (i = 0; i < items.length; i++) {
        it = items[i];
        var swW2 = legendSwatchW(ctx, it);
        var lb2 = legendLabel(it);
        var tx2 = fr.legendX + swW2 + gap;
        entries.push({
          svg: legendSwatch(ctx, it, fr.legendX, y, size) +
            text(tx2, y + size * 0.35, lb2,
              { size: size, fill: fill, part: "legend", seriesKey: it.key }),
          x0: fr.legendX, y0: y - size * 0.9,
          x1: tx2 + textW(lb2, size), y1: y + size * 0.45
        });
        y += rowH;
      }
    } else {
      var x = fr.x0;
      var yy = pos === "top" ? fr.y0 - f * 1.3 : fr.y0 + fr.ph + f * 2.4;
      for (i = 0; i < items.length; i++) {
        it = items[i];
        var swW3 = legendSwatchW(ctx, it);
        var lb3 = legendLabel(it);
        var tx3 = x + swW3 + gap;
        entries.push({
          svg: legendSwatch(ctx, it, x, yy, size) +
            text(tx3, yy + size * 0.35, lb3,
              { size: size, fill: fill, part: "legend", seriesKey: it.key }),
          x0: x, y0: yy - size * 0.9,
          x1: tx3 + textW(lb3, size), y1: yy + size * 0.45
        });
        x = tx3 + textW(lb3, size) + gap * 2;
      }
    }
    var parts = [];
    // R5：legend.frame → 白底细框包住图例块
    if (lp.frame && entries.length) {
      var fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
      for (i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.x0 < fx0) fx0 = e.x0;
        if (e.y0 < fy0) fy0 = e.y0;
        if (e.x1 > fx1) fx1 = e.x1;
        if (e.y1 > fy1) fy1 = e.y1;
      }
      var m = 2 * u;
      parts.push(rectEl(fx0 - m, fy0 - m, (fx1 - fx0) + 2 * m, (fy1 - fy0) + 2 * m,
        "#FFFFFF", ' stroke="#000000" stroke-width="' + px(0.5 * u) + '"'));
    }
    for (i = 0; i < entries.length; i++) parts.push(entries[i].svg);
    // data-legend-pos 供测试/诊断读取实际生效的图例位置（inside-best 已解析为具体角）
    return '<g data-legend-pos="' + esc(pos) + '">' + parts.join("") + "</g>";
  }

  function wrap(ctx, parts) {
    var extra = "";
    var diag = ctx.diagAttrs;
    if (Array.isArray(diag)) {
      for (var i = 0; i < diag.length; i++) {
        extra += " " + diag[i][0] + '="' + esc(diag[i][1]) + '"';
      }
    }
    // R6：坐标范围裁切计数——被 x/y 范围裁到绘图区外而未显示的数据点数。
    // 诚实报告：0 也输出计数，便于调用方/测试确认裁剪生效。
    if (clipWanted(ctx)) {
      var cc = ctx.__clipCount || 0;
      extra += ' data-range-clipped="' + cc + '"';
      if (cc > 0) {
        extra += ' data-range-warning="' + esc("范围外 " + cc + " 个点未显示") + '"';
      }
    }
    var head = "";
    // R5：绘图区底色垫底（cartesianFrame 记录的框），盖住网格/边框之下
    var pf = ctx.__plotFrame;
    var pb = pf && effPlot(ctx).background;
    if (pf && pb) {
      head = rectEl(pf.x0, pf.y0, pf.pw, pf.ph, pb);
    }
    // R6：区间底色 bands——数据之下的底层（网格线仍按既有次序压在最上，
    // 与网格压数据的既有行为一致；bands 自身已钳到绘图区内）。
    if (pf) head += drawBandsUnderlay(ctx, pf);
    // R6：坐标范围激活时的数据区 clipPath 定义
    head = clipDefsSvg(ctx) + head;
    return '<g font-family="' + esc(ctx.fontFamily || "Arial, sans-serif") + '" data-chart-type="' +
      esc(ctx.chartSpec.chartType) + '"' + extra + ">" + head + parts.join("") + "</g>";
  }

  // Error bar (vertical line + both caps) drawn as real stroked elements.
  function errorBarEl(parts, x, yLow, yHigh, capW, strokeWidth) {
    parts.push(lineEl(x, yLow, x, yHigh, "#000000", ' stroke-width="' + px(strokeWidth) + '"'));
    parts.push(lineEl(x - capW, yHigh, x + capW, yHigh, "#000000", ' stroke-width="' + px(strokeWidth) + '"'));
    parts.push(lineEl(x - capW, yLow, x + capW, yLow, "#000000", ' stroke-width="' + px(strokeWidth) + '"'));
  }

  // Diagnostics for chart <g> attributes: which uncertainty source/spread is
  // drawn (or why nothing was drawn — never silently omit an error bar).
  function errorDiagAttrs(cells) {
    var drawn = 0, reasons = {};
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].ok) drawn++;
      else reasons[cells[i].reason] = (reasons[cells[i].reason] || 0) + 1;
    }
    var attrs = [];
    if (!cells.length) {
      attrs.push(["data-error-bars", "none"], ["data-error-note", "no-cells"]);
      return attrs;
    }
    var first = null;
    for (var j = 0; j < cells.length; j++) {
      if (cells[j].ok) { first = cells[j]; break; }
    }
    if (!drawn) {
      attrs.push(["data-error-bars", "none"]);
    } else {
      attrs.push(["data-error-bars", first.source + ":" + first.spread]);
    }
    var notes = [];
    if (drawn < cells.length) {
      var keys = Object.keys(reasons);
      for (var k = 0; k < keys.length; k++) notes.push(keys[k] + "x" + reasons[keys[k]]);
    }
    attrs.push(["data-error-note", notes.length ? (drawn + "/" + cells.length + " " + notes.join(",")) : "all"]);
    return attrs;
  }

  /* ====================================================================
   * Characterization spectra (XPS / Raman / XRD / NMR / EIS / FTIR ...)
   *
   * chartSpec.characterization contract — all fields optional, unknown
   * fields are rejected (never guessed, never silently dropped):
   *   technique          string, user/模板 declared
   *   x_reverse          boolean (XPS 结合能 / NMR ppm 反转轴)
   *   x_scale            "linear" | "log10"（log10：x<=0 的点不计入，
   *                      明确排除计数，原始 inline rows 永不修改）
   *   x_label / y_label  字符串，含用户申报的真实单位；缺失只 warning
   *   curves             [{role:"fit"|"component"|"baseline", column, label}]
   *                      全部是用户已产生的曲线列；本渲染器不做任何拟合
   *                      或峰位推断，缺列报错
   *   fit_model/fit_source  字符串，用户申报；缺 fit_source 只 warning，
   *                      绝不代填（fit_source='provided_by_user_fit' 由
   *                      用户/模板申报，不由渲染器自造）
   *   peak_annotations   [{x:number, label:string}]；峰标注只来自这里，
   *                      未申报不给任何默认峰名（无 D/G、无 C-C）
   *   normalize          "none" | "max_to_unity"（仅渲染时缩放，inline
   *                      原始数据不变；只有用户/模板显式声明才生效）
   *   offset_each_series number，仅作视觉堆叠位移（positional only），
   *                      位移后的差值不是数据、不得用于统计/显著性
   *   equal_aspect      boolean，scatter 使用共同 px/数据单位并居中扩展
   *                      显示域；EIS Nyquist 名称提供等比兼容默认值
   * ==================================================================== */

  var CHAR_ROLES = ["fit", "component", "baseline"];
  var CHAR_FIELDS = ["technique", "x_reverse", "x_scale", "x_label", "y_label",
    "curves", "fit_model", "fit_source", "peak_annotations", "normalize",
    "offset_each_series", "equal_aspect"];
  var CHAR_CURVE_KEYS = ["role", "column", "label"];
  var CHAR_NORMALIZE_MODES = ["none", "max_to_unity"];
  var CHAR_X_SCALES = ["linear", "log10"];

  // Validate + normalize a characterization spec. Returns
  // {ok, errors, warnings, char}；char 为规范化副本（原 chartSpec 不改）。
  // columns 可选：提供时校验曲线列是否真实存在（缺列=error，不会画错列）。
  function normalizeCharacterization(input, columns) {
    var errors = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, errors: ["characterization 必须是对象"], warnings: [], char: null };
    }
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) {
      if (CHAR_FIELDS.indexOf(keys[i]) < 0) errors.push("characterization 含未知字段：" + keys[i]);
    }
    function strOrNull(v) { return typeof v === "string" ? v : null; }
    var char = {
      technique: strOrNull(input.technique),
      x_reverse: input.x_reverse === undefined || input.x_reverse === null ? false : input.x_reverse,
      x_scale: (input.x_scale === undefined || input.x_scale === null || input.x_scale === "")
        ? "linear" : input.x_scale,
      x_label: strOrNull(input.x_label),
      y_label: strOrNull(input.y_label),
      curves: [],
      fit_model: strOrNull(input.fit_model),
      fit_source: strOrNull(input.fit_source),
      peak_annotations: [],
      normalize: (input.normalize === undefined || input.normalize === null || input.normalize === "")
        ? "none" : input.normalize,
      offset_each_series: null,
      equal_aspect: input.equal_aspect === undefined || input.equal_aspect === null
        ? false : input.equal_aspect
    };
    if (typeof char.x_reverse !== "boolean") errors.push("characterization.x_reverse 必须是 boolean");
    if (typeof char.equal_aspect !== "boolean") errors.push("characterization.equal_aspect 必须是 boolean");
    if (CHAR_X_SCALES.indexOf(char.x_scale) < 0) errors.push("characterization.x_scale 必须是 linear/log10");
    if (CHAR_NORMALIZE_MODES.indexOf(char.normalize) < 0) errors.push("characterization.normalize 必须是 none/max_to_unity");
    if (input.offset_each_series !== undefined && input.offset_each_series !== null) {
      if (typeof input.offset_each_series !== "number" || !isFinite(input.offset_each_series)) {
        errors.push("characterization.offset_each_series 必须是有限数字");
      } else {
        char.offset_each_series = input.offset_each_series;
      }
    }

    var curves = input.curves;
    if (curves !== undefined && curves !== null && !Array.isArray(curves)) {
      errors.push("characterization.curves 必须是数组");
    } else if (Array.isArray(curves)) {
      for (var c = 0; c < curves.length; c++) {
        var cv = curves[c];
        if (!cv || typeof cv !== "object" || Array.isArray(cv)) {
          errors.push("characterization.curves[" + c + "] 必须是对象");
          continue;
        }
        var ck = Object.keys(cv);
        for (var q = 0; q < ck.length; q++) {
          if (CHAR_CURVE_KEYS.indexOf(ck[q]) < 0) errors.push("curves[" + c + "] 含未知字段：" + ck[q]);
        }
        if (CHAR_ROLES.indexOf(cv.role) < 0) {
          errors.push("curves[" + c + "].role 必须是 fit/component/baseline 之一");
        }
        if (typeof cv.column !== "string" || cv.column === "") {
          errors.push("curves[" + c + "].column 必须是数据列名");
        } else if (Array.isArray(columns) && columns.indexOf(cv.column) < 0) {
          errors.push("curves[" + c + "].column 引用的列「" + cv.column + "」不存在");
        }
        char.curves.push({ role: cv.role || null, column: cv.column, label: strOrNull(cv.label) });
      }
    }

    var pas = input.peak_annotations;
    if (pas !== undefined && pas !== null && !Array.isArray(pas)) {
      errors.push("characterization.peak_annotations 必须是数组");
    } else if (Array.isArray(pas)) {
      // R04：峰标注可选稳定 id（presentation.peaks 按此引用）。缺省时按
      // (x,label) 确定性补全——同值同 id，旧记录无需迁移即获得稳定身份。
      var seenPeakIds = {};
      for (var p = 0; p < pas.length; p++) {
        var pa = pas[p];
        if (!pa || typeof pa !== "object" || Array.isArray(pa)) {
          errors.push("peak_annotations[" + p + "] 必须是对象");
          continue;
        }
        var pk = Object.keys(pa);
        for (var r = 0; r < pk.length; r++) {
          if (pk[r] !== "x" && pk[r] !== "label" && pk[r] !== "id") {
            errors.push("peak_annotations[" + p + "] 含未知字段：" + pk[r]);
          }
        }
        if (typeof pa.x !== "number" || !isFinite(pa.x)) {
          errors.push("peak_annotations[" + p + "].x 必须是有限数字");
        }
        if (pa.id !== undefined && pa.id !== null &&
            (typeof pa.id !== "string" || !/^pk-[A-Za-z0-9-]{1,40}$/.test(pa.id))) {
          errors.push("peak_annotations[" + p + "].id 必须是 pk- 前缀的稳定 id");
        }
        var explicitId = typeof pa.id === "string" && /^pk-[A-Za-z0-9-]{1,40}$/.test(pa.id);
        var pid;
        if (explicitId) {
          if (seenPeakIds[pa.id]) {
            errors.push("peak_annotations[" + p + "].id 重复：" + pa.id);
            continue;
          }
          pid = pa.id;
        } else {
          pid = peakId(pa.x, pa.label, seenPeakIds); // 自动分配自维护去重
        }
        seenPeakIds[pid] = true;
        char.peak_annotations.push({ x: pa.x, label: strOrNull(pa.label), id: pid });
      }
    }
    return { ok: errors.length === 0, errors: errors, warnings: [], char: char };
  }

  function charEqualAspect(char) {
    return char.equal_aspect === true || /EIS\s+Nyquist/i.test(char.technique || "");
  }

  // Validate using the already-normalized char; returns the SVG <g> diag
  // attributes describing normalization / curve sources / exclusions.
  function charDiagAttrs(char, info) {
    var attrs = [];
    var meta = [
      "technique=" + (char.technique || "undeclared"),
      "x_scale=" + char.x_scale,
      "x_reverse=" + (char.x_reverse ? "true" : "false"),
      "normalize=" + char.normalize,
      "equal_aspect=" + (charEqualAspect(char) ? "true" : "false")
    ];
    if (char.fit_source) meta.push("fit_source=" + char.fit_source);
    if (char.fit_model) meta.push("fit_model=" + char.fit_model);
    if (char.offset_each_series !== null) meta.push("offset_each_series=" + char.offset_each_series);
    attrs.push(["data-characterization", meta.join(";")]);
    var curveDesc = [];
    for (var i = 0; i < char.curves.length; i++) {
      curveDesc.push(char.curves[i].role + ":" + char.curves[i].column);
    }
    attrs.push(["data-characterization-curves", curveDesc.length ? curveDesc.join(",") : "none"]);
    if (char.normalize === "max_to_unity") {
      attrs.push(["data-normalize", "max_to_unity (render-time only; inline rows unchanged)"]);
    }
    if (char.offset_each_series !== null) {
      attrs.push(["data-offset", "positional stacking only; offset differences are not data"]);
    }
    if (info && info.excludedLog > 0) {
      attrs.push(["data-excluded-points", "log10 x<=0: " + info.excludedLog]);
    }
    if (info && info.skippedNonFinite > 0) {
      attrs.push(["data-skipped-points", "non-finite: " + info.skippedNonFinite]);
    }
    if (info && (info.drawnPeaks > 0 || info.skippedPeaks > 0)) {
      attrs.push(["data-peak-annotations", info.drawnPeaks + "/" + (info.drawnPeaks + info.skippedPeaks)]);
    }
    var warns = [];
    if (!char.technique) warns.push("technique missing");
    if (!char.x_label) warns.push("x_label/unit missing");
    if (!char.y_label) warns.push("y_label/unit missing");
    var hasFitCurve = false;
    for (var j = 0; j < char.curves.length; j++) {
      if (char.curves[j].role === "fit" || char.curves[j].role === "component") hasFitCurve = true;
    }
    if (hasFitCurve && !char.fit_source) warns.push("fit_source missing");
    if (warns.length) attrs.push(["data-characterization-warning", warns.join(";")]);
    return attrs;
  }

  // Scatter/histogram keep their series semantics, but declared characterization
  // axis titles take precedence over generic axes labels before frame layout.
  function applyCharacterizationMetadata(ctx) {
    var ch = normalizeCharacterization(ctx.chartSpec.characterization, ctx.columns);
    if (!ch.ok) {
      throw new Error("renderChartSVG：characterization 校验失败：" + ch.errors.join("；"));
    }
    ctx.axes = Object.assign({}, ctx.axes, {
      xLabel: ch.char.x_label || ctx.axes.xLabel || "",
      yLabel: ch.char.y_label || ctx.axes.yLabel || ""
    });
    ctx.diagAttrs = charDiagAttrs(ch.char, null);
    return ch.char;
  }

  function charPreservesMeasurementOrder(char) {
    return /(^|[^a-z])cv([^a-z]|$)|voltammet|循环伏安/i.test(char.technique || "");
  }

  function charSortSeries(points, char) {
    if (!charPreservesMeasurementOrder(char)) {
      points.sort(function (a, b) { return a.x - b.x; });
    }
    return points;
  }

  // Collect finite (x, y) points for one column pair. Spectra are sorted per
  // series after collection; CV retains acquisition order to preserve loops.
  // Only render-time point copies are sorted, never inline rows.
  function charCollectPoints(ctx, xIdx, yIdx, char) {
    var points = [];
    var excludedLog = 0, skippedNonFinite = 0;
    for (var i = 0; i < ctx.rows.length; i++) {
      var xv = toNum(ctx.rows[i][xIdx]);
      if (isNaN(xv)) { skippedNonFinite++; continue; }
      if (char.x_scale === "log10" && xv <= 0) { excludedLog++; continue; }
      var yv = toNum(ctx.rows[i][yIdx]);
      if (isNaN(yv)) { skippedNonFinite++; continue; }
      points.push({ x: xv, y: yv });
    }
    return { points: charSortSeries(points, char), excludedLog: excludedLog, skippedNonFinite: skippedNonFinite };
  }

  // Full characterization scope renderer for chartType line / line_multi:
  // raw curves from mapping.y (split by mapping.group for line_multi) plus
  // user-declared fit/component/baseline curve columns, reversed / log10 x,
  // optional render-time max_to_unity normalization, optional positional
  // stacking offset for raw series, peak markers from peak_annotations only.
  function renderCharacterization(ctx, idx) {
    var spec = ctx.chartSpec;
    var ch = normalizeCharacterization(spec.characterization, ctx.columns);
    if (!ch.ok) {
      throw new Error("renderChartSVG：characterization 校验失败：" + ch.errors.join("；"));
    }
    var char = ch.char;
    var isMulti = spec.chartType === "line_multi";

    // Axis titles: characterization x_label/y_label (user-declared, with real
    // units) take precedence over generic axes.xLabel/yLabel for this render.
    ctx.axes = Object.assign({}, ctx.axes, {
      xLabel: char.x_label || ctx.axes.xLabel || "",
      yLabel: char.y_label || ctx.axes.yLabel || ""
    });

    // --- raw series ---
    var rawSeries = [];
    var excludedLog = 0, skippedNonFinite = 0;
    if (!isMulti) {
      var res0 = charCollectPoints(ctx, idx.x, idx.y, char);
      excludedLog += res0.excludedLog;
      skippedNonFinite += res0.skippedNonFinite;
      rawSeries.push({ label: ctx.mapping.y, points: res0.points, kind: "raw",
        key: stableSeriesKey("raw", ctx.mapping.y, ctx.mapping.y) });
    } else {
      var gIdx = ctx.columns.indexOf(ctx.mapping.group);
      if (gIdx < 0) {
        throw new Error("renderChartSVG：line_multi characterization 需要 mapping.group 列");
      }
      var buckets = [], seen = {};
      for (var i = 0; i < ctx.rows.length; i++) {
        var g = catLabel(ctx.rows[i][gIdx]);
        if (g === null) continue;
        var xv = toNum(ctx.rows[i][idx.x]);
        if (isNaN(xv)) { skippedNonFinite++; continue; }
        if (char.x_scale === "log10" && xv <= 0) { excludedLog++; continue; }
        var yv = toNum(ctx.rows[i][idx.y]);
        if (isNaN(yv)) { skippedNonFinite++; continue; }
        var k = seen[g];
        if (k === undefined) {
          seen[g] = buckets.length;
          k = buckets.length;
          buckets.push({ key: g, points: [] });
        }
        buckets[k].points.push({ x: xv, y: yv });
      }
      for (i = 0; i < buckets.length; i++) {
        rawSeries.push({ label: buckets[i].key, points: charSortSeries(buckets[i].points, char), kind: "raw",
          key: stableSeriesKey("group", ctx.mapping.group, buckets[i].key) });
      }
    }

    // --- user-declared curve series (fit / component / baseline) ---
    var curveSeries = [];
    for (i = 0; i < char.curves.length; i++) {
      var cu = char.curves[i];
      var ci = ctx.columns.indexOf(cu.column);
      if (ci < 0) {
        throw new Error("renderChartSVG：characterization.curves[" + i +
          "] 引用的列「" + cu.column + "」不存在");
      }
      var res1 = charCollectPoints(ctx, idx.x, ci, char);
      excludedLog += res1.excludedLog;
      skippedNonFinite += res1.skippedNonFinite;
      curveSeries.push({ label: cu.label || cu.column, points: res1.points, kind: cu.role,
        key: stableSeriesKey("curve", cu.role, cu.column) });
    }

    if (!rawSeries.length && !curveSeries.length) {
      throw new Error("renderChartSVG：characterization 没有可绘制的数据点");
    }
    // 全部点被排除（如 log10 下 x 全为非正值）→ 明确报错，绝不渲染空图假装通过
    var totalPts = 0;
    for (s = 0; s < rawSeries.length; s++) totalPts += rawSeries[s].points.length;
    for (s = 0; s < curveSeries.length; s++) totalPts += curveSeries[s].points.length;
    if (totalPts === 0) {
      throw new Error("renderChartSVG：characterization 数据点全部被排除" +
        (excludedLog > 0 ? "（log10 非正 x：" + excludedLog + "）" : "") +
        "，无法渲染（原始数据未修改）");
    }

    // Colors: raw series take the palette head so raw keeps the leading
    // visual role; curve series get following palette entries but are drawn
    // thinner/beneath — components never override the raw/fit hierarchy.
    // R04：颜色经 effSeriesStyle（presentation.series[稳定键] 优先，曲线
    // 与图例同源），线宽/虚线覆盖一并生效。
    // R6：渐变系列色须在 effSeriesStyle 着色前登记。
    setupSeriesGradient(ctx, rawSeries.concat(curveSeries).map(function (se) {
      return { key: se.key, label: se.label };
    }));
    var s;
    for (s = 0; s < rawSeries.length; s++) {
      rawSeries[s].style = effSeriesStyle(ctx, rawSeries[s].key, s);
      rawSeries[s].color = rawSeries[s].style.stroke;
    }
    for (s = 0; s < curveSeries.length; s++) {
      curveSeries[s].style = effSeriesStyle(ctx, curveSeries[s].key, rawSeries.length + s);
      curveSeries[s].color = curveSeries[s].style.stroke;
    }
    var series = rawSeries.concat(curveSeries);

    // Render-time normalization (declared only; inline rows untouched) and
    // positional stacking offset for RAW series (index in raw order).
    // Single-spectrum charts (chartType line): the declared fit/component/
    // baseline columns share the RAW series' max so the decomposition overlay
    // stays aligned with the raw curve after normalization. line_multi keeps
    // the per-series own max (multi-spectrum compare).
    var singleSpectrumMax = 0;
    if (rawSeries.length === 1) {
      for (j = 0; j < rawSeries[0].points.length; j++) {
        var ar = Math.abs(rawSeries[0].points[j].y);
        if (ar > singleSpectrumMax) singleSpectrumMax = ar;
      }
    }
    for (s = 0; s < series.length; s++) {
      var se = series[s];
      var maxAbs = 0;
      for (var j = 0; j < se.points.length; j++) {
        var ay = Math.abs(se.points[j].y);
        if (ay > maxAbs) maxAbs = ay;
      }
      var effMax = (rawSeries.length === 1) ? singleSpectrumMax : maxAbs;
      se.scale = (char.normalize === "max_to_unity" && effMax > 0) ? 1 / effMax : 1;
      se.yShift = (char.offset_each_series !== null && se.kind === "raw")
        ? s * char.offset_each_series : 0; // s < rawSeries.length here for raw
    }

    // Draw order: components -> baseline -> raw -> fit (fit drawn last, on top,
    // so the model curve stays visible where it converges with the raw trace).
    var PRIO = { component: 0, baseline: 1, raw: 2, fit: 3 };
    var paintOrder = series.slice().sort(function (a, b) { return PRIO[a.kind] - PRIO[b.kind]; });

    // --- domains (x in transformed space, y after normalize/offset) ---
    var xT = char.x_scale === "log10"
      ? function (v) { return Math.log10(v); }
      : function (v) { return v; };
    // R6：xMin/xMax 用户单位 → 变换空间（log10 取对数）；非正 log 下界忽略该侧
    var xr = axisRangeOf(ctx, "x"), yr = axisRangeOf(ctx, "y");
    var xrT = null;
    if (xr) {
      var xlo = xr.min != null ? xT(xr.min) : null;
      var xhi = xr.max != null ? xT(xr.max) : null;
      if ((xlo != null && !isFinite(xlo)) || (xhi != null && !isFinite(xhi))) {
        xlo = null; xhi = null;
      }
      if (xlo != null || xhi != null) xrT = { min: xlo, max: xhi };
      // log10 下界非法（如 xMin<=0）→ 该侧范围整体不可用，避免 clip 计数
      // 与实际绘制不一致（ctx.axes 已是本渲染副本，可安全清理）。
      if (!xrT) { ctx.axes.xMin = null; ctx.axes.xMax = null; }
    }
    var ysAll = [];
    var tMin = Infinity, tMax = -Infinity;
    for (s = 0; s < series.length; s++) {
      var se2 = series[s];
      // R6-4：x 范围限定时 y 自动域只按可见 x 窗口内的数据计算
      // （折线类按窗口边缘线性插值，与 drawSeriesChart 同规则）。
      var visY = null;
      if (xrT) {
        var mp = new Array(se2.points.length);
        for (j = 0; j < se2.points.length; j++) {
          mp[j] = { x: xT(se2.points[j].x),
            y: se2.points[j].y * se2.scale + se2.yShift };
        }
        visY = visibleYValues(mp, xrT, true);
        for (j = 0; j < visY.length; j++) ysAll.push(visY[j]);
      } else {
        for (j = 0; j < se2.points.length; j++) {
          ysAll.push(se2.points[j].y * se2.scale + se2.yShift);
        }
      }
      for (j = 0; j < se2.points.length; j++) {
        var t = xT(se2.points[j].x);
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    }
    if (!isFinite(tMin)) { tMin = 0; tMax = 1; }
    if (tMin === tMax) { tMin -= 0.5; tMax += 0.5; }
    var tDom = applyAxisRange({ min: tMin, max: tMax }, xrT);
    tMin = tDom.min; tMax = tDom.max;
    var dom = valueDomain(ysAll, false);
    dom = applyAxisRange(dom, yr);
    // R6-I：有峰标注时 y 上界自动留头部空间，曲线与标注不贴/越上框
    var hasPeakLabels = false;
    for (i = 0; i < char.peak_annotations.length; i++) {
      if (char.peak_annotations[i] && char.peak_annotations[i].label) { hasPeakLabels = true; break; }
    }
    if (hasPeakLabels && (!yr || yr.max == null) && isFinite(dom.max) && isFinite(dom.min)) {
      var yspan0 = dom.max - dom.min;
      if (yspan0 > 0) dom.max += yspan0 * 0.07;
    }
    var yTicks = rangeTicks(dom, yr, 5);
    if ((!yr || yr.min == null) && yTicks.length) dom.min = Math.min(dom.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);
    yTicks = yTicks.filter(function (v) { return v >= dom.min - 1e-9 && v <= dom.max + 1e-9; });

    var legendItems = [];
    for (s = 0; s < series.length; s++) {
      legendItems.push({ label: series[s].label, color: series[s].color, kind: "line",
        key: series[s].key });
    }
    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: legendItems });
    // R7：等比展示（characterization.equal_aspect 或 EIS Nyquist technique）——
    // 与 scatter 共用 equalAspectDomains；x 在变换空间展开，用户显式范围
    // 在扩域后仍优先（与 scatter 同一语义，可能破坏等比但尊重用户范围）。
    if (charEqualAspect(char)) {
      var eq = equalAspectDomains(fr, { min: tMin, max: tMax }, dom);
      tMin = eq.x.min; tMax = eq.x.max;
      var tDomEq = applyAxisRange({ min: tMin, max: tMax }, xrT);
      tMin = tDomEq.min; tMax = tDomEq.max;
      dom = applyAxisRange(eq.y, yr);
    }
    var sy = linScale(dom.min, dom.max, plotDataBottom(fr), fr.y0);
    var sx = char.x_reverse
      ? linScale(tMin, tMax, fr.x0 + fr.pw, fr.x0)   // XPS/NMR: high value on the left
      : linScale(tMin, tMax, fr.x0, fr.x0 + fr.pw);  // Raman/XRD: ascending
    // R6：references/bands/significance 共用 x→px（positions 为原始 x 单位）
    noteXScale(ctx, function (v) { return sx(xT(v)); });

    var xTicks;
    if (char.x_scale === "log10") {
      xTicks = [];
      var lo = Math.ceil(tMin - 1e-9), hi = Math.floor(tMax + 1e-9);
      for (var e = lo; e <= hi; e++) {
        xTicks.push({ px: sx(e), label: fmtNum(Math.pow(10, e)) });
      }
      if (xTicks.length < 2) { // less than one decade: place midpoints
        var ts2 = niceTicks(tMin, tMax, 4);
        xTicks = ts2.map(function (t2) { return { px: sx(t2), label: fmtNum(Math.pow(10, t2)) }; });
      }
    } else {
      xTicks = niceTicks(tMin, tMax, 5).map(function (v) { return { px: sx(v), label: fmtNum(v) }; });
    }
    // x_reverse puts tick px positions in descending order; sort by px so the
    // shared tick thinning (ascending-px assumption) keeps the axis labels.
    xTicks.sort(function (a, b) { return a.px - b.px; });

    // --- paint curves ---
    var u = ctx.dpi / 72;
    // 表征谱线密、系列多；线宽取可读下限，保证低分辨率导出仍有实心像素。
    // plot.lineWidthPt 显式设置时优先，否则用 charLineWidthPt；series 级
    // strokeWidthPt 仍在下方逐系列覆盖。
    var p0 = presOf(spec), pl0 = p0 && p0.plot;
    var charLW = (pl0 && typeof pl0.lineWidthPt === "number" && isFinite(pl0.lineWidthPt))
      ? pl0.lineWidthPt : STYLE_DEFAULTS.charLineWidthPt;
    var strokeWidth = charLW * u;
    var r = (72 / 170) * u;
    // R6：componentFill——component 曲线向基线填充（有 baseline 曲线按其
    // 折线插值，否则 y=0 在域内取 0、域外取下界）。系列色、opacity 0.3。
    var compFillOn = !!(pl0 && pl0.componentFill === true);
    var baseSamples = null, fillBaseVal = null;
    if (compFillOn) {
      fillBaseVal = (dom.min <= 0 && dom.max >= 0) ? 0 : dom.min;
      for (s = 0; s < series.length; s++) {
        var bse = series[s];
        if (bse.kind === "baseline" && bse.points.length > 1) {
          baseSamples = bse.points.map(function (bp) {
            return { tx: xT(bp.x), y: bp.y * bse.scale + bse.yShift };
          }).sort(function (a, b) { return a.tx - b.tx; });
          break;
        }
      }
    }
    function baseYAt(tx) {
      if (!baseSamples) return null;
      var lo = 0, hi = baseSamples.length - 1;
      if (tx <= baseSamples[0].tx) return baseSamples[0].y;
      if (tx >= baseSamples[hi].tx) return baseSamples[hi].y;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (baseSamples[mid].tx <= tx) lo = mid; else hi = mid;
      }
      var a = baseSamples[lo], b = baseSamples[hi];
      var tt = (tx - a.tx) / (b.tx - a.tx || 1);
      return a.y + (b.y - a.y) * tt;
    }
    var parts = [clipOpenTag(ctx)];
    // R6-A：数学裁剪——导出（PyMuPDF）不认 clip-path，曲线/填充/标记
    // 须在生成期落在绘图区内（xMin/xMax 或 yMin/yMax 裁切时尤为关键）。
    var clipR = plotClipRect(ctx, fr);
    var clipActive = true; // R6-A：恒裁剪（clip-path 在导出中不生效）
    for (s = 0; s < paintOrder.length; s++) {
      var se3 = paintOrder[s];
      if (!se3.points.length) continue;
      var pts = [], endIdx = 0;
      for (j = 0; j < se3.points.length; j++) {
        var dp = se3.points[j];
        noteClip(ctx, dp.x, dp.y * se3.scale + se3.yShift, true); // R6：范围外点计数
        pts.push([sx(xT(dp.x)), sy(dp.y * se3.scale + se3.yShift)]);
        if (pts[j][0] > pts[endIdx][0]) endIdx = j;
      }
      // R6：inline 图例用——登记系列右端（像素）
      noteSeriesEnd(ctx, se3.key, pts[endIdx][0], pts[endIdx][1], se3.yShift !== 0);
      if (compFillOn && se3.kind === "component" && pts.length > 1) {
        // R6-F：只填「组分高于基线」的区段——按 comp−base 差值符号分段，
        // 过零点在变换空间线性插值出 crossing，逐段成多边形后整体裁剪。
        function diffAt(jj) {
          var cyy = se3.points[jj].y * se3.scale + se3.yShift;
          var bby = baseSamples ? baseYAt(xT(se3.points[jj].x)) : null;
          return cyy - ((bby != null) ? bby : fillBaseVal);
        }
        function basePixAt(jj, tt) {
          // tt∈[0,1] 在点 jj→jj+1 上的插值基线像素 y
          var tx0 = xT(se3.points[jj].x), tx1 = xT(se3.points[jj + 1].x);
          var b0 = baseSamples ? baseYAt(tx0) : null;
          var b1 = baseSamples ? baseYAt(tx1) : null;
          var bv = (b0 != null && b1 != null) ? b0 + (b1 - b0) * tt : fillBaseVal;
          return sy(bv);
        }
        function emitFillRun(i0, i1, leftX, rightX) {
          // i0..i1 点下标闭区间；leftX/rightX 为可选 crossing 像素点
          // {cx,cy(comp),cb(base)}，cy/cb 为像素 y
          var topD = [], botD = [];
          if (leftX) { topD.push({ x: leftX.cx, y: leftX.cy }); botD.push({ x: leftX.cx, y: leftX.cb }); }
          for (j = i0; j <= i1; j++) {
            var byy = baseSamples ? baseYAt(xT(se3.points[j].x)) : null;
            topD.push({ x: pts[j][0], y: pts[j][1] });
            botD.unshift({ x: pts[j][0], y: sy((byy != null) ? byy : fillBaseVal) });
          }
          if (rightX) { topD.push({ x: rightX.cx, y: rightX.cy }); botD.unshift({ x: rightX.cx, y: rightX.cb }); }
          if (topD.length < 3) return;
          var poly = topD.concat(botD);
          if (clipActive) poly = clipPolyRect(poly, clipR);
          if (poly.length < 3) return;
          parts.push('<path d="M ' + poly.map(function (p) {
            return px(p.x) + " " + px(p.y);
          }).join(" L ") + ' Z" fill="' + se3.color + '" fill-opacity="0.3" stroke="none"' +
            ' data-chart-part="series" data-series-key="' + esc(se3.key) + '" data-component-fill="1"/>');
        }
        var runI0 = -1, runLeft = null;
        for (j = 0; j < pts.length; j++) {
          var inside = diffAt(j) > 0;
          if (inside && runI0 < 0) {
            runI0 = j; runLeft = null;
            if (j > 0) {
              // run 起点是 crossing：j-1 在外、j 在内
              var dl = diffAt(j - 1), dr = diffAt(j);
              if (dr !== dl) {
                var tl = dl / (dl - dr);
                runLeft = {
                  cx: pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * tl,
                  cy: pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * tl,
                  cb: basePixAt(j - 1, tl)
                };
              }
            }
            continue;
          }
          if (!inside && runI0 >= 0) {
            var runRight = null, jEnd = j - 1;
            var dA = diffAt(jEnd), dB = diffAt(j);
            if (jEnd >= runI0 && dB !== dA) {
              var tr = dA / (dA - dB);
              runRight = {
                cx: pts[jEnd][0] + (pts[j][0] - pts[jEnd][0]) * tr,
                cy: pts[jEnd][1] + (pts[j][1] - pts[jEnd][1]) * tr,
                cb: basePixAt(jEnd, tr)
              };
            }
            emitFillRun(runI0, jEnd, runLeft, runRight);
            runI0 = -1; runLeft = null;
          }
        }
        if (runI0 >= 0) emitFillRun(runI0, pts.length - 1, runLeft, null);
      }
      var w = strokeWidth;
      if (se3.style && typeof se3.style.strokeWidthPt === "number") {
        w = se3.style.strokeWidthPt * u;
      }
      var extra = "";
      if (se3.kind === "fit") extra = ' stroke-dasharray="' + dashPt("4.5 2.25", u) + '"';
      else if (se3.kind === "baseline") extra = ' stroke-dasharray="' + dashPt("1.5 2.25", u) + '"';
      else if (se3.kind === "component") extra = ' stroke-opacity="0.85"';
      if (se3.style && se3.style.dash) extra = ' stroke-dasharray="' + esc(se3.style.dash) + '"';
      if (se3.style && se3.style.marker === "none") extra += ' data-no-marker="1"';
      // R6-A：折线按段裁剪到绘图区（与 drawSeriesChart 同法）。
      // 注意用 clipR（框）而非描边内缩框：顶点落在框边缘时内缩裁剪会
      // 断开折线并多出桥接点，破坏下游对 polyline 点数=数据行数的契约
      // （selftest XPS 断言）；框边描边外伸半线宽与误差线/轴框一致可接受。
      var clipRLc = clipR;
      // 逐段裁剪后按「连续 run」重建：相邻裁剪段在共享端点处相接则并入
      // 同一 run（折线可等价表达）；仅当线段整体出框形成真实断口时才分 run。
      var runs = [], curRun = null, lastPt = null;
      for (j = 0; j + 1 < pts.length; j++) {
        var ca = pts[j], cb2 = pts[j + 1];
        var cs2 = clipActive ? clipSegRect(ca[0], ca[1], cb2[0], cb2[1], clipRLc)
                             : [ca[0], ca[1], cb2[0], cb2[1]];
        if (!cs2) { curRun = null; lastPt = null; continue; }
        var sPt = [cs2[0], cs2[1]], ePt = [cs2[2], cs2[3]];
        var connected = curRun && lastPt &&
          Math.abs(sPt[0] - lastPt[0]) < 1e-6 && Math.abs(sPt[1] - lastPt[1]) < 1e-6;
        if (!connected) {
          curRun = [];
          runs.push(curRun);
          curRun.push(sPt);
        }
        curRun.push(ePt);
        lastPt = ePt;
      }
      if (runs.length) {
        var cAttrs = ' fill="none" stroke="' + se3.color +
          '" stroke-width="' + px(w) +
          '" stroke-linejoin="round" stroke-linecap="round" data-chart-part="series"' +
          ' data-series-key="' + esc(se3.key) + '"' + extra;
        if (runs.length === 1) {
          parts.push('<polyline points="' +
            runs[0].map(function (p) { return px(p[0]) + "," + px(p[1]); }).join(" ") +
            '"' + cAttrs + "/>");
        } else {
          var cpath = "";
          for (j = 0; j < runs.length; j++) {
            cpath += "M " + px(runs[j][0][0]) + " " + px(runs[j][0][1]);
            for (var q = 1; q < runs[j].length; q++) {
              cpath += " L " + px(runs[j][q][0]) + " " + px(runs[j][q][1]);
            }
          }
          parts.push('<path d="' + cpath + '"' + cAttrs + "/>");
        }
      }
      if (se3.kind === "raw" && pts.length <= 400 && !(se3.style && se3.style.marker === "none")) {
        // R7：标记样式走 effMarkStyle——series[key].marker/markerSizePt/
        // markerFill（hollow）逐系列生效（如 BET 吸附实心/脱附空心）；
        // 表征点无 source_row → pointKey=null，仅到 series 级覆盖。
        // 默认直径沿用旧值（144/170 pt ≈ 0.85pt），markerSizePt 可调大。
        var mDefMarker = (se3.style && se3.style.marker) || "circle";
        for (j = 0; j < pts.length; j++) {
          var ms2 = effMarkStyle(ctx, {
            kind: "point", seriesKey: se3.key, pointKey: null,
            defFill: se3.color, defMarker: mDefMarker, defDiaPt: 144 / 170,
            defStroke: null, defStrokeWidthPt: null, defOpacity: null
          });
          if (ms2.marker === "none") continue;
          var mr2 = ms2.sizePt * u / 2;
          // R6-A：标记整只留在绘图区内（中心距边 >= 半径+描边）
          if (clipActive && !inRectPx(pts[j][0], pts[j][1], clipR, -(mr2 + 1))) continue;
          var mExtra2 = "";
          if (ms2.stroke) {
            mExtra2 += ' stroke="' + ms2.stroke + '" stroke-width="' +
              px((ms2.strokeWidthPt != null ? ms2.strokeWidthPt : 0.6) * u) + '"';
          }
          if (typeof ms2.opacity === "number") mExtra2 += ' fill-opacity="' + px(ms2.opacity) + '"';
          parts.push(markerShapeEl(pts[j][0], pts[j][1], mr2, ms2.fill, mExtra2, ms2.marker));
        }
      }
    }

    // --- peak markers: ONLY from peak_annotations, no default peak names ---
    // R04：峰标注带稳定 id（normalizeCharacterization 确定性补全），
    // presentation.peaks[id] 覆盖标签颜色/字号。
    var drawnPeaks = 0, skippedPeaks = 0;
    var f = fr.tickF;
    for (i = 0; i < char.peak_annotations.length; i++) {
      var pa = char.peak_annotations[i];
      if (typeof pa.x !== "number" || !isFinite(pa.x)) { skippedPeaks++; continue; }
      var pt = xT(pa.x);
      if (pt < tMin || pt > tMax) { skippedPeaks++; continue; }
      var ppx = sx(pt);
      var pkStyle = presPeakStyle(ctx, pa.id);
      // R6：峰线止于数据区底（不压进 sticks 参考带）；tMin/tMax 已按
      // 用户范围收紧，范围外峰计入 skippedPeaks 如实报告。
      parts.push(lineEl(ppx, fr.y0, ppx, plotDataBottom(fr), "#888888",
        ' stroke-width="' + px(STYLE_DEFAULTS.zeroWidthPt * u) +
        '" stroke-dasharray="' + dashPt("3 2.25", u) +
        '" data-chart-part="peak"' +
        (pa.id ? ' data-peak-id="' + esc(pa.id) + '"' : "")));
      if (pa.label) {
        parts.push(text(ppx, fr.y0 + f * 1.2, pa.label, {
          anchor: "middle",
          size: (typeof pkStyle.fontSizePt === "number") ? fontPx(pkStyle.fontSizePt, ctx.dpi) : f,
          fill: pkStyle.color || "#555555",
          part: "peak",
          peakId: pa.id
        }));
      }
      drawnPeaks++;
    }

    // Explicit in-plot exclusion warning (log10 guard); also in diag attrs.
    if (excludedLog > 0) {
      parts.push(text(fr.x0 + 4, fr.y0 + f * 1.1,
        "已排除 " + excludedLog + " 个非正 x 点（log10，不计入）",
        { anchor: "start", size: f * 0.95, fill: "#A05A00" }));
    }
    parts.push(clipCloseTag(ctx));

    ctx.diagAttrs = charDiagAttrs(char, {
      excludedLog: excludedLog,
      skippedNonFinite: skippedNonFinite,
      drawnPeaks: drawnPeaks,
      skippedPeaks: skippedPeaks
    });

    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks,
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    parts.push(drawLegend(ctx, fr));
    return parts;
  }

  /* ====================================================================
   * renderChartSVG — data preparation helpers
   * ==================================================================== */

  function colIndex(ctx, role) {
    var name = ctx.mapping[role];
    if (typeof name !== "string" || name === "") return -1;
    var i = ctx.columns.indexOf(name);
    if (i < 0) {
      throw new Error("renderChartSVG：mapping." + role + " 引用的列「" + name + "」不存在");
    }
    return i;
  }

  function requireCols(ctx, roles) {
    var idx = {};
    for (var i = 0; i < roles.length; i++) {
      var role = roles[i];
      var name = ctx.mapping[role];
      if (typeof name !== "string" || name === "") {
        throw new Error("renderChartSVG：" + ctx.chartSpec.chartType +
          " 需要 " + roles.map(function (r) { return "mapping." + r; }).join("、"));
      }
      idx[role] = colIndex(ctx, role);
    }
    return idx;
  }

  // aggregate numeric y per category; mode "mean" (default) or "sum"
  function collectCategories(rows, xIdx, yIdx, mode) {
    var cats = [], seen = {}, sums = [], counts = [], rowIdxs = [];
    for (var i = 0; i < rows.length; i++) {
      var lab = catLabel(rows[i][xIdx]);
      var v = toNum(rows[i][yIdx]);
      if (lab === null || isNaN(v)) continue;
      var k = seen[lab];
      if (k === undefined) {
        seen[lab] = cats.length;
        cats.push(lab);
        sums.push(0);
        counts.push(0);
        rowIdxs.push([]);
        k = cats.length - 1;
      }
      sums[k] += v;
      counts[k] += 1;
      rowIdxs[k].push(i);
    }
    var vals = [];
    for (var j = 0; j < cats.length; j++) {
      vals.push(mode === "sum" ? sums[j] : sums[j] / counts[j]);
    }
    return { cats: cats, vals: vals, rows: rowIdxs };
  }

  // prepare x/y points for line/area; determines x scale mode (time/num/cat)
  function prepareXY(ctx, xIdx, yIdx, groupIdx) {
    var points = [], xRaw = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var xv = ctx.rows[i][xIdx];
      var yv = toNum(ctx.rows[i][yIdx]);
      if (xv === null || xv === undefined || xv === "" || isNaN(yv)) continue;
      var g = null;
      if (groupIdx != null) {
        g = catLabel(ctx.rows[i][groupIdx]);
        if (g === null) continue;
      }
      xRaw.push(xv);
      points.push({ x: xv, y: yv, g: g, source_row: i, raw_x: xv, raw_y: ctx.rows[i][yIdx] });
    }

    var allNum = xRaw.length > 0, allTime = xRaw.length > 0;
    for (var j = 0; j < xRaw.length; j++) {
      var v = xRaw[j];
      if (!(typeof v === "number" && isFinite(v)) &&
          !(typeof v === "string" && NUM_RE.test(v.trim()))) allNum = false;
      if (typeof v !== "string" || parseDateTime(v) === null) allTime = false;
    }

    var mode;
    if (allTime) mode = "time";
    else if (allNum) mode = "num";
    else mode = "cat";

    var cats = null;
    if (mode === "num") {
      for (j = 0; j < points.length; j++) {
        points[j].x = typeof points[j].x === "number" ? points[j].x : Number(points[j].x);
      }
    } else if (mode === "time") {
      for (j = 0; j < points.length; j++) points[j].x = parseDateTime(points[j].x);
    } else {
      cats = [];
      var seen = {};
      for (j = 0; j < points.length; j++) {
        var l = String(points[j].x);
        if (!(l in seen)) { seen[l] = cats.length; cats.push(l); }
        points[j].x = seen[l];
      }
    }
    points.sort(function (a, b) { return a.x - b.x; });
    return { points: points, mode: mode, cats: cats };
  }

  function groupPoints(points, keyField) {
    var series = [], seen = {};
    for (var i = 0; i < points.length; i++) {
      var key = points[i][keyField];
      if (!(key in seen)) { seen[key] = series.length; series.push({ key: key, points: [] }); }
      series[seen[key]].points.push(points[i]);
    }
    return series;
  }

  function xDomain(prep) {
    if (prep.mode === "cat") return { min: -0.5, max: prep.cats.length - 0.5 };
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < prep.points.length; i++) {
      if (prep.points[i].x < min) min = prep.points[i].x;
      if (prep.points[i].x > max) max = prep.points[i].x;
    }
    if (min === max) { min -= 0.5; max += 0.5; }
    return { min: min, max: max };
  }

  function buildXTicks(prep, sx, domOverride) {
    var ticks = [];
    var i;
    if (prep.mode === "cat") {
      for (i = 0; i < prep.cats.length; i++) {
        ticks.push({ px: sx(i), label: prep.cats[i] });
      }
    } else if (prep.mode === "time") {
      var times = [], seen = {};
      for (i = 0; i < prep.points.length; i++) {
        if (!seen[prep.points[i].x]) { seen[prep.points[i].x] = true; times.push(prep.points[i].x); }
      }
      times.sort(function (a, b) { return a - b; });
      var stride = Math.max(1, Math.ceil(times.length / 5));
      var withTime = false;
      for (i = 0; i < times.length; i++) {
        if (hasTimeOfDay(times[i])) { withTime = true; break; }
      }
      for (i = 0; i < times.length; i += stride) {
        ticks.push({ px: sx(times[i]), label: fmtTime(times[i], withTime) });
      }
    } else {
      var dom = domOverride || xDomain(prep);
      var ts = niceTicks(dom.min, dom.max, 5);
      for (i = 0; i < ts.length; i++) {
        ticks.push({ px: sx(ts[i]), label: fmtNum(ts[i]) });
      }
    }
    return ticks;
  }

  // shared body for line / line_multi / area
  function drawSeriesChart(ctx, prep, o) {
    // R4-HB：双纵轴——按系列 axisName（宽表列名/长表分组值）分到左右两域；
    // 无 y2 或右域为空时全部走左域，行为与单轴完全一致。
    var y2 = normY2(ctx);
    var leftYs = [], rightYs = [], rightAny = false;
    // R6-4：xMin/xMax 限定时 y 自动域只按可见 x 窗口内的数据计算
    // （线段与窗口边缘线性插值；Origin 式依数据缩放，inset 放大即靠此）。
    var xrDom = axisRangeOf(ctx, "x");
    var yPadFrac = xrDom ? 0.05 : 0.04;
    for (var si = 0; si < o.series.length; si++) {
      var sName = o.series[si].axisName !== undefined ? o.series[si].axisName : o.series[si].key;
      var sRight = !!(y2 && y2.nameSet[sName]);
      o.series[si]._right = sRight;
      if (sRight) rightAny = true;
      var pool = sRight ? rightYs : leftYs;
      var visY = visibleYValues(o.series[si].points, xrDom, true);
      if (visY) {
        for (var pi = 0; pi < visY.length; pi++) pool.push(visY[pi]);
      } else {
        for (pi = 0; pi < o.series[si].points.length; pi++) pool.push(o.series[si].points[pi].y);
      }
    }
    if (!rightAny || !rightYs.length) { y2 = null; rightYs = []; }

    function yDomainOf(vals, ov) {
      var d = valueDomain(vals, false);
      padDomain(d, yPadFrac, yPadFrac); // H1：y 两端留白；x 范围重算时 5%（R6-4）
      if (ov) {
        if (ov.min != null) d.min = ov.min;
        if (ov.max != null) d.max = ov.max;
      }
      var tk = niceTicks(d.min, d.max, 5);
      if (!ov || ov.min == null) d.min = Math.min(d.min, tk[0]);
      if (!ov || ov.max == null) d.max = Math.max(d.max, tk[tk.length - 1]);
      // 显式 min/max 时刻度可能越界，裁掉域外刻度
      tk = tk.filter(function (v) { return v >= d.min - 1e-9 && v <= d.max + 1e-9; });
      return { dom: d, ticks: tk };
    }

    // R6：yMin/yMax 只约束左轴（右轴有独立 y2.min/max 覆盖）
    var ld = yDomainOf(leftYs, axisRangeOf(ctx, "y"));
    var dom = ld.dom, yTicks = ld.ticks;
    var rd = y2 ? yDomainOf(rightYs, y2) : null;
    var domR = rd ? rd.dom : null, y2Ticks = rd ? rd.ticks : null;

    // R6：渐变系列色——须在图例色解析（effSeriesStyle）之前登记 t 值；
    // 调用方（RENDERS.*）已先行 setupSeriesGradient 时此处为幂等补齐。
    if (gradSpec(ctx) && !ctx.__gradT) {
      setupSeriesGradient(ctx, o.series.map(function (sEntry, sIdx) {
        var k = o.seriesKeyOf ? o.seriesKeyOf(sEntry, sIdx)
          : (o.groupKeyed
            ? stableSeriesKey("group", ctx.mapping.group, sEntry.key)
            : stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y));
        return { key: k, label: sEntry.key };
      }));
    }

    var fr = cartesianFrame(ctx, {
      yTickLabels: yTicks.map(fmtNum),
      y2TickLabels: y2Ticks ? y2Ticks.map(fmtNum) : [],
      y2Title: y2 ? y2.label : null,
      legend: o.legendItems || []
    });
    var sy = linScale(dom.min, dom.max, plotDataBottom(fr), fr.y0);
    var syR = domR ? linScale(domR.min, domR.max, plotDataBottom(fr), fr.y0) : null;
    var xd = xDomain(prep);
    if (prep.mode !== "cat") padDomain(xd, 0.02, 0.02); // H1：num/time x 两端各 2%，cat 不变
    xd = applyAxisRange(xd, axisRangeOf(ctx, "x")); // R6：xMin/xMax 覆盖（cat=类别序号）
    var sx = linScale(xd.min, xd.max, fr.x0, fr.x0 + fr.pw);
    noteXScale(ctx, sx);
    var xTicks = buildXTicks(prep, sx, xd);
    // 刻度不得越出绘图区（用户范围裁掉的类别/越界刻度不画标签）
    xTicks = xTicks.filter(function (t) {
      return t.px >= fr.x0 - 1 && t.px <= fr.x0 + fr.pw + 1;
    });

    var parts = [clipOpenTag(ctx)];
    var i;
    var u = ctx.dpi / 72;
    var plot = effPlot(ctx);
    var defMarkerDia = STYLE_DEFAULTS.lineMarkerDiaPt;
    var errBands = [];
    var wantErrBand = effPlot(ctx) && presOf(ctx.chartSpec) && presOf(ctx.chartSpec).plot &&
      presOf(ctx.chartSpec).plot.errorStyle === "band" &&
      !(Array.isArray(ctx.mapping.ys) && ctx.mapping.ys.length >= 2); // 宽表无 group 列，单元格不可分

    for (var s = 0; s < o.series.length; s++) {
      // R04：系列样式经稳定键从 presentation 解析；默认沿用 colors 序。
      // series[s].key 为分组值（单系列时为 ""），groupKeyed 标记分组来源。
      // R4-HB：o.seriesKeyOf 供宽表逐列给稳定键。
      var seKey = o.seriesKeyOf ? o.seriesKeyOf(o.series[s], s)
        : (o.groupKeyed
          ? stableSeriesKey("group", ctx.mapping.group, o.series[s].key)
          : stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y));
      var syS = (o.series[s]._right && syR) ? syR : sy;
      // 透传渐变状态（__gradT/__gradN）：否则 gradSeriesStroke 落到 t=0，
      // 所有系列都取配色首色（深紫）——图例走真 ctx 正常、曲线全紫的 bug。
      var sStyle = effSeriesStyle({
        palette: o.colors, chartSpec: ctx.chartSpec, dpi: ctx.dpi,
        __gradT: ctx.__gradT, __gradN: ctx.__gradN,
        __gradMin: ctx.__gradMin, __gradMax: ctx.__gradMax
      }, seKey, s);
      var color = sStyle.stroke;
      var strokeW = (typeof sStyle.strokeWidthPt === "number")
        ? sStyle.strokeWidthPt * u : plot.lineWidthPt * u;
      var dashAttr = sStyle.dash ? ' stroke-dasharray="' + esc(sStyle.dash) + '"' : "";
      var pts = [];
      var bandPts = [];
      for (i = 0; i < o.series[s].points.length; i++) {
        var sp = o.series[s].points[i];
        var pxp = sx(sp.x), pyp = syS(sp.y);
        pts.push({ px: pxp, py: pyp, src: sp });
        noteClip(ctx, sp.x, sp.y, !o.series[s]._right); // R6：范围外计数
        bandPts.push({ px: pxp, xlab: catLabel(sp.raw_x != null ? sp.raw_x : sp.x), y: sp.y });
      }
      // R6：inline 图例的系列右端点
      if (pts.length) {
        noteSeriesEnd(ctx, seKey, pts[pts.length - 1].px, pts[pts.length - 1].py,
          o.endAbove === true);
      }
      if (wantErrBand && bandPts.length) {
        errBands.push({
          key: seKey, color: color,
          group: o.groupKeyed ? o.series[s].key : null,
          pts: bandPts, sy: syS
        });
      }
      // inside-best：折线顶点即标记位置，记录折线段供图例避让打分
      if (pts.length) {
        noteGeom(ctx, { t: "line", pts: pts.map(function (p) { return { x: p.px, y: p.py }; }) });
      }
      // R6-A：数学裁剪——导出（PyMuPDF）不认 clip-path，几何必须在
      // 生成期就落在绘图区内。折线按段 Liang-Barsky 裁切、面积/误差带
      // 按 Sutherland-Hodgman 裁切、标记中心在框外即跳过。
      var clipR = plotClipRect(ctx, fr);
      var clipActive = true; // R6-A：恒裁剪（clip-path 在导出中不生效）
      // 折线描边有宽度：裁剪框内缩半个线宽，外缘才真正不出绘图区
      var clipRL = clipActive ? {
        x0: clipR.x0 + strokeW / 2, y0: clipR.y0 + strokeW / 2,
        x1: clipR.x1 - strokeW / 2, y1: clipR.y1 - strokeW / 2
      } : null;
      if (clipRL && !(clipRL.x1 > clipRL.x0 && clipRL.y1 > clipRL.y0)) clipRL = clipR;
      if (o.fillArea && pts.length > 1) {
        var base = syS(0);
        if (base < fr.y0) base = fr.y0;
        if (base > fr.y0 + fr.ph) base = fr.y0 + fr.ph;
        var fpts = pts.map(function (p) { return { x: p.px, y: p.py }; });
        fpts.push({ x: pts[pts.length - 1].px, y: base },
                  { x: pts[0].px, y: base });
        if (clipActive) fpts = clipPolyRect(fpts, clipR);
        if (fpts.length >= 3) {
          var d = "M " + fpts.map(function (p) { return px(p.x) + " " + px(p.y); }).join(" L ") + " Z";
          parts.push('<path d="' + d + '" fill="' + color + '" fill-opacity="0.3" stroke="none"' +
            ' data-chart-part="series" data-series-key="' + esc(seKey) + '"/>');
        }
      }
      if (pts.length > 1) {
        // 裁切折线：相邻点逐段裁剪，连续在内段合并为子路径
        var dSeg = "";
        var curOpen = false;
        for (i = 0; i + 1 < pts.length; i++) {
          var a = pts[i], b = pts[i + 1];
          var cs = clipActive ? clipSegRect(a.px, a.py, b.px, b.py, clipRL || clipR) : null;
          if (!clipActive) cs = [a.px, a.py, b.px, b.py];
          if (!cs) { curOpen = false; continue; }
          var fullyIn = !clipActive ||
            (cs[0] === a.px && cs[1] === a.py && cs[2] === b.px && cs[3] === b.py);
          if (!curOpen) { dSeg += "M " + px(cs[0]) + " " + px(cs[1]); curOpen = true; }
          else if (fullyIn) { /* 延续上一段 */ }
          else { dSeg += "M " + px(cs[0]) + " " + px(cs[1]); }
          dSeg += " L " + px(cs[2]) + " " + px(cs[3]);
          if (!fullyIn) curOpen = false;
        }
        if (dSeg) {
          parts.push('<path d="' + dSeg + '" fill="none" stroke="' + color +
            '" stroke-width="' + px(strokeW) +
            '" stroke-linejoin="round" stroke-linecap="round"' + dashAttr +
            ' data-chart-part="series" data-series-key="' + esc(seKey) + '"/>');
        }
      }
      // H1：折线标记逐点解析（series.markerSizePt/marker + points[pt键] 覆盖），
      // 输出 data-point-key/data-row/data-size-pt/data-marker 供点选编辑。
      var sMarker = sStyle.marker || "circle";
      if (sMarker !== "none" &&
          (pts.length === 1 || (o.drawPoints && pts.length <= 400))) {
        for (i = 0; i < pts.length; i++) {
          var sp2 = pts[i].src;
          var mk = (sp2 && sp2.source_row != null)
            ? mkPointKey(sp2.source_row, sp2.raw_x, sp2.raw_y, sp2.g) : null;
          var ms = effMarkStyle(ctx, {
            kind: "point", seriesKey: seKey, pointKey: mk,
            defFill: color, defMarker: sMarker, defDiaPt: defMarkerDia,
            defStroke: null, defStrokeWidthPt: null, defOpacity: null
          });
          if (ms.marker === "none") continue;
          var mr = ms.sizePt * u / 2;
          // R6-A：标记须整只留在绘图区内（中心距边 >= 半径+描边），
          // 否则导出中标记墨迹会越出图框
          if (clipActive && !inRectPx(pts[i].px, pts[i].py, clipR, -(mr + 1))) continue;
          var mExtra = ' data-chart-part="series" data-series-key="' + esc(seKey) + '"';
          if (mk) {
            mExtra += ' data-point-key="' + esc(mk) + '" data-row="' + sp2.source_row + '"';
          }
          mExtra += ' data-size-pt="' + px(ms.sizePt) + '" data-marker="' + ms.marker + '"';
          if (ms.stroke) {
            mExtra += ' stroke="' + ms.stroke + '" stroke-width="' +
              px((ms.strokeWidthPt != null ? ms.strokeWidthPt : 0) * u) + '"';
          }
          if (typeof ms.opacity === "number") mExtra += ' fill-opacity="' + px(ms.opacity) + '"';
          parts.push(markerShapeEl(pts[i].px, pts[i].py, mr, ms.fill, mExtra, ms.marker));
        }
      }
    }

    // R6：误差带（errorStyle:"band"）画在数据之上、轴框之下
    parts.push(drawErrorBands(ctx, errBands));
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks,
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      y2Ticks: y2Ticks ? y2Ticks.map(function (v) { return { px: syR(v), label: fmtNum(v) }; }) : null,
      y2Label: y2 ? y2.label : null,
      zeroY: null
    }));
    parts.push(drawLegend(ctx, fr));
    return parts;
  }

  /* ====================================================================
   * renderChartSVG — per-type renderers
   * ==================================================================== */

  var RENDERS = {};

  RENDERS.bar = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var agg = collectCategories(ctx.rows, idx.x, idx.y, "mean");
    if (!agg.cats.length) throw new Error("renderChartSVG：bar 没有可绘制的数据点");

    // science contract: chart.statistics drives per-category error bars
    var stats = (ctx.chartSpec && typeof ctx.chartSpec.statistics === "object")
      ? ctx.chartSpec.statistics : null;
    var cells = [];
    for (var e = 0; e < agg.cats.length; e++) {
      cells.push(cellUncertainty(ctx.columns, ctx.rows, ctx.mapping, stats, agg.cats[e], null));
    }
    ctx.diagAttrs = errorDiagAttrs(cells);

    // error bounds enter the value domain so caps never clip at the top
    // R6-4：x 范围限定（x 单位=类别序号）时 y 域只按可见类别重算
    var xr = axisRangeOf(ctx, "x");
    var domVals = [];
    for (e = 0; e < agg.cats.length; e++) {
      if (!catIdxVisible(e, xr)) continue;
      domVals.push(agg.vals[e]);
      if (cells[e].ok) {
        var eb0 = errorBounds(cells[e], agg.vals[e]);
        domVals.push(eb0.hi, eb0.lo);
      }
    }
    if (!domVals.length) domVals = agg.vals.slice(); // 全排除→回退全域防空域
    var dom = valueDomain(domVals, true); // zero baseline (negative values supported)
    padDomainNonZero(dom, 0.05); // H1：非零一端留 5%，零基线端不留白
    // R6：yMin/yMax 覆盖 + 显著性/字母头room（仅在用户未固定该侧时上扩）
    var yr = axisRangeOf(ctx, "y");
    dom = applyAxisRange(dom, yr);
    var hr = annotHeadroom(ctx, dom, 0);
    if (hr > 0 && (!yr || yr.max == null)) dom.max += hr;
    var yTicks = rangeTicks(dom, yr, 5);
    if ((!yr || yr.min == null) && yTicks.length) dom.min = Math.min(dom.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);
    yTicks = yTicks.filter(function (v) { return v >= dom.min - 1e-9 && v <= dom.max + 1e-9; });

    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: [] });
    var sy = linScale(dom.min, dom.max, plotDataBottom(fr), fr.y0);
    var band = fr.pw / agg.cats.length;
    var barW = Math.max(1, band * 0.65);
    var zeroY = sy(0);
    var u = ctx.dpi / 72;
    var capW = Math.max(0.5, Math.min(barW * 0.3, STYLE_DEFAULTS.errorCapMaxPt * u));
    var ebStroke = STYLE_DEFAULTS.errorWidthPt * u;
    // R6：bands/references 的 x 单位 = 类别序号（0..n-1，柱中心）
    noteXScale(ctx, function (v) { return fr.x0 + band * (v + 0.5); });

    var parts = [clipOpenTag(ctx)], xTicks = [];
    // R04：单系列柱色可被 presentation.series["series|<y列>|<y列>"] 覆盖；
    // H1：每根柱另有 bar|<类别> 标记键可被 presentation.points 单独覆盖。
    var barKey = stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y);
    // R6-A：yMin/yMax 裁切后柱体/误差线/标注只画可见部分（导出无 clip-path）
    var clipR = plotClipRect(ctx, fr); // R6-A：恒裁剪（导出无 clip-path）
    for (var i = 0; i < agg.cats.length; i++) {
      var cx = fr.x0 + band * (i + 0.5);
      var v = agg.vals[i];
      // R6-4：x 范围外的类别不画（域已按可见类别收紧，画出会顶破框）；
      // noteClip 计数前移，避免重复计数。
      noteClip(ctx, i, v, true);
      if (!catIdxVisible(i, xr)) continue;
      var yVal = sy(v);
      var top = Math.min(zeroY, yVal);
      var hpx = Math.max(0.5, Math.abs(yVal - zeroY));
      var markKey = mkBarKey(agg.cats[i], null);
      var bs = effMarkStyle(ctx, {
        kind: "bar", seriesKey: barKey, pointKey: markKey,
        defFill: v >= 0 ? ctx.palette[0] : (ctx.palette[1] || ctx.palette[0]),
        defStroke: null, defStrokeWidthPt: null, defOpacity: null
      });
      var barExtra = ' data-chart-part="series" data-series-key="' + esc(barKey) +
        '" data-point-key="' + esc(markKey) + '" data-row="' +
        esc((agg.rows[i] || []).join(",")) + '"';
      if (typeof bs.opacity === "number") barExtra += ' fill-opacity="' + px(bs.opacity) + '"';
      if (bs.stroke) {
        barExtra += ' stroke="' + bs.stroke + '" stroke-width="' +
          px((bs.strokeWidthPt != null ? bs.strokeWidthPt : 0.75) * u) + '"';
      }
      var bx = cx - barW / 2;
      // R6-A：柱矩形裁到绘图区（y 范围裁切时柱顶/底可能越界）
      var drawTop = top, drawBot = top + hpx;
      if (clipR) {
        drawTop = Math.max(drawTop, clipR.y0);
        drawBot = Math.min(drawBot, clipR.y1);
        if (clipR.x0 > bx || clipR.x1 < bx + barW) { drawTop = drawBot; }
      }
      var drawH = Math.max(0, drawBot - drawTop);
      if (drawH > 0.3) {
        parts.push(rectEl(bx, drawTop, barW, drawH, bs.fill, barExtra));
        // R6：斜线填充（series[key].hatch），线段已按矩形几何裁剪
        var hch = seriesHatch(ctx, barKey);
        if (hch) parts.push(hatchSvg(ctx, bx, drawTop, barW, drawH, hch, bs.stroke || "#333333"));
      }
      // inside-best：柱矩形 + 误差线进入避让几何
      noteGeom(ctx, { t: "rect", x0: bx, y0: top, x1: bx + barW, y1: top + hpx });
      var errTopPx = null;
      if (cells[i].ok) {
        var eb1 = errorBounds(cells[i], v);
        // 像素 y 向下：值大→像素小。eyTop=误差上端(大值), eyBot=下端(小值)
        var eyTop = sy(Math.max(eb1.lo, eb1.hi)), eyBot = sy(Math.min(eb1.lo, eb1.hi));
        if (clipR) { eyTop = Math.max(eyTop, clipR.y0); eyBot = Math.min(eyBot, clipR.y1); }
        errTopPx = eyTop;
        noteGeom(ctx, { t: "rect", x0: cx - capW, y0: eyTop, x1: cx + capW, y1: eyBot });
        if (eyBot - eyTop > 0.3) errorBarEl(parts, cx, eyTop, eyBot, capW, ebStroke);
      }
      // R6：显著性/字母标注登记（yTop=可见值端像素，yErrTop=误差线顶）
      var annotTop = v >= 0 ? top : top + hpx;
      if (clipR) annotTop = v >= 0 ? Math.max(annotTop, clipR.y0)
                                  : Math.min(annotTop, clipR.y1);
      noteAnnotMark(ctx, agg.cats[i], null, cx, annotTop, errTopPx, v >= 0);
      if (showValues(ctx)) {
        parts.push(text(cx, v >= 0 ? top - 3 : top + hpx + fr.tickF, fmtNum(v),
          { anchor: "middle", size: fr.tickF * 0.9 }));
      }
      xTicks.push({ px: cx, label: agg.cats[i], cat: true });
    }
    // R6：显著性括号 + 字母标注（clip 内、轴框之下）
    parts.push(drawAnnotLayer(ctx, fr, u));
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks,
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: zeroY
    }));
    return wrap(ctx, parts);
  };

  RENDERS.bar_grouped = function (ctx) {
    var idx = requireCols(ctx, ["x", "y", "group"]);
    var cats = [], catSeen = {}, groups = [], groupSeen = {}, mat = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var lab = catLabel(ctx.rows[i][idx.x]);
      var g = catLabel(ctx.rows[i][idx.group]);
      var v = toNum(ctx.rows[i][idx.y]);
      if (lab === null || g === null || isNaN(v)) continue;
      var ci = catSeen[lab];
      if (ci === undefined) { catSeen[lab] = cats.length; ci = cats.length; cats.push(lab); mat.push([]); }
      var gi = groupSeen[g];
      if (gi === undefined) { groupSeen[g] = groups.length; gi = groups.length; groups.push(g); }
      var cell = mat[ci][gi];
      if (!cell) cell = mat[ci][gi] = { sum: 0, n: 0, rows: [] };
      cell.sum += v;
      cell.n += 1;
      cell.rows.push(i);
    }
    if (!cats.length || !groups.length) {
      throw new Error("renderChartSVG：bar_grouped 没有可绘制的数据点");
    }

    // science contract: per (category, group) cell error bars
    var stats = (ctx.chartSpec && typeof ctx.chartSpec.statistics === "object")
      ? ctx.chartSpec.statistics : null;
    var cells = [];
    for (i = 0; i < cats.length; i++) {
      for (var gj = 0; gj < groups.length; gj++) {
        cells.push(cellUncertainty(ctx.columns, ctx.rows, ctx.mapping, stats, cats[i], groups[gj]));
      }
    }
    ctx.diagAttrs = errorDiagAttrs(cells);

    // R6-4：x 范围限定（x 单位=类别序号）时 y 域只按可见类别重算
    var xr = axisRangeOf(ctx, "x");
    var vals = [];
    for (i = 0; i < mat.length; i++) {
      if (!catIdxVisible(i, xr)) continue;
      for (var j = 0; j < mat[i].length; j++) {
        if (mat[i][j]) vals.push(mat[i][j].sum / mat[i][j].n);
      }
    }
    // error bounds enter the value domain so caps never clip at the top
    var cellIdx = 0;
    for (i = 0; i < cats.length; i++) {
      for (gj = 0; gj < groups.length; gj++) {
        var m = mat[i][gj];
        var c0 = cells[cellIdx++];
        if (m && c0.ok && catIdxVisible(i, xr)) {
          var mean0 = m.sum / m.n;
          var ebm = errorBounds(c0, mean0);
          vals.push(ebm.hi, ebm.lo);
        }
      }
    }
    if (!vals.length) { // 全部类别被范围排除 → 回退全域防空域
      for (i = 0; i < mat.length; i++) {
        for (var j2 = 0; j2 < mat[i].length; j2++) {
          if (mat[i][j2]) vals.push(mat[i][j2].sum / mat[i][j2].n);
        }
      }
    }
    var dom = valueDomain(vals, true);
    padDomainNonZero(dom, 0.05); // H1：非零一端留 5%，零基线端不留白
    // R6：yMin/yMax 覆盖 + 显著性/字母头room
    var yr = axisRangeOf(ctx, "y");
    dom = applyAxisRange(dom, yr);
    var hr = annotHeadroom(ctx, dom, 0);
    if (hr > 0 && (!yr || yr.max == null)) dom.max += hr;
    var yTicks = rangeTicks(dom, yr, 5);
    if ((!yr || yr.min == null) && yTicks.length) dom.min = Math.min(dom.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);
    yTicks = yTicks.filter(function (v) { return v >= dom.min - 1e-9 && v <= dom.max + 1e-9; });

    var legendItems = [];
    // R04：分组系列稳定键（group|<分组列>|<类型>:<组名>），图例与柱色同源
    // R6：渐变系列色须在图例色解析前登记（label=分组值）
    setupSeriesGradient(ctx, groups.map(function (gName, gi) {
      return { key: stableSeriesKey("group", ctx.mapping.group, gName), label: gName };
    }));
    var groupKeys = [];
    for (i = 0; i < groups.length; i++) {
      groupKeys.push(stableSeriesKey("group", ctx.mapping.group, groups[i]));
      legendItems.push({ label: groups[i], kind: "rect", key: groupKeys[i],
        color: effSeriesStyle(ctx, groupKeys[i], i).stroke });
    }
    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: legendItems });
    var sy = linScale(dom.min, dom.max, plotDataBottom(fr), fr.y0);
    var band = fr.pw / cats.length;
    var barW = Math.max(0.8, band * 0.8 / groups.length);
    var zeroY = sy(0);
    var u = ctx.dpi / 72;
    var capW = Math.max(0.5, Math.min(barW * 0.3, STYLE_DEFAULTS.errorCapMaxPt * u));
    var ebStroke = STYLE_DEFAULTS.errorWidthPt * u;
    noteXScale(ctx, function (v) { return fr.x0 + band * (v + 0.5); });

    var parts = [clipOpenTag(ctx)], xTicks = [];
    // R6-A：yMin/yMax 裁切后柱体/误差线/标注只画可见部分（导出无 clip-path）
    var clipR = plotClipRect(ctx, fr); // R6-A：恒裁剪（导出无 clip-path）
    cellIdx = 0;
    for (i = 0; i < cats.length; i++) {
      var center = fr.x0 + band * (i + 0.5);
      // R6-4：x 范围外类别整组不画（y 域已按可见类别收紧，画出会顶破框）；
      // 逐格 noteClip 计数，口径与绘制时一致。
      if (!catIdxVisible(i, xr)) {
        cellIdx += groups.length; // cells 按 (类别×组) 拍平，跳类须同步推进
        for (var gjx = 0; gjx < groups.length; gjx++) {
          var cm = mat[i][gjx];
          if (cm) noteClip(ctx, i, cm.sum / cm.n, true);
        }
        continue;
      }
      xTicks.push({ px: center, label: cats[i], cat: true });
      for (gj = 0; gj < groups.length; gj++) {
        var c2 = mat[i][gj];
        var cErr = cells[cellIdx++];
        if (!c2) continue;
        var v2 = c2.sum / c2.n;
        var yVal = sy(v2);
        var top = Math.min(zeroY, yVal);
        var hpx = Math.max(0.5, Math.abs(yVal - zeroY));
        var bx = center - barW * groups.length / 2 + gj * barW;
        var markKey = mkBarKey(cats[i], groups[gj]);
        var bs = effMarkStyle(ctx, {
          kind: "bar", seriesKey: groupKeys[gj], pointKey: markKey,
          defFill: ctx.palette[gj % ctx.palette.length],
          defStroke: null, defStrokeWidthPt: null, defOpacity: null
        });
        var barExtra = ' data-chart-part="series" data-series-key="' + esc(groupKeys[gj]) +
          '" data-point-key="' + esc(markKey) + '" data-row="' +
          esc((c2.rows || []).join(",")) + '"';
        if (typeof bs.opacity === "number") barExtra += ' fill-opacity="' + px(bs.opacity) + '"';
        if (bs.stroke) {
          barExtra += ' stroke="' + bs.stroke + '" stroke-width="' +
            px((bs.strokeWidthPt != null ? bs.strokeWidthPt : 0.75) * u) + '"';
        }
        var bw = barW * 0.92;
        // R6-A：柱矩形裁到绘图区
        var drawTop = top, drawBot = top + hpx;
        if (clipR) {
          drawTop = Math.max(drawTop, clipR.y0);
          drawBot = Math.min(drawBot, clipR.y1);
          if (clipR.x0 > bx || clipR.x1 < bx + bw) drawTop = drawBot;
        }
        var drawH = Math.max(0, drawBot - drawTop);
        if (drawH > 0.3) {
          parts.push(rectEl(bx, drawTop, bw, drawH, bs.fill, barExtra));
          var hch = seriesHatch(ctx, groupKeys[gj]);
          if (hch) parts.push(hatchSvg(ctx, bx, drawTop, bw, drawH, hch, bs.stroke || "#333333"));
        }
        // inside-best：柱矩形 + 误差线进入避让几何
        noteGeom(ctx, { t: "rect", x0: bx, y0: top, x1: bx + bw, y1: top + hpx });
        var errTopPx = null;
        if (cErr.ok) {
          // error bars sit on the bar's own center, not the group center
          var bxm = bx + bw / 2;
          var ebe = errorBounds(cErr, v2);
          // 像素 y 向下：值大→像素小。eyTopG=误差上端(大值), eyBotG=下端(小值)
          var eyTopG = sy(Math.max(ebe.lo, ebe.hi)), eyBotG = sy(Math.min(ebe.lo, ebe.hi));
          if (clipR) { eyTopG = Math.max(eyTopG, clipR.y0); eyBotG = Math.min(eyBotG, clipR.y1); }
          errTopPx = eyTopG;
          noteGeom(ctx, { t: "rect", x0: bxm - capW, y0: eyTopG, x1: bxm + capW, y1: eyBotG });
          if (eyBotG - eyTopG > 0.3) errorBarEl(parts, bxm, eyTopG, eyBotG, capW, ebStroke);
        }
        // R6：显著性/字母标注登记（含分组；yTop=可见值端像素）
        var annotTop = v2 >= 0 ? top : top + hpx;
        if (clipR) annotTop = v2 >= 0 ? Math.max(annotTop, clipR.y0)
                                    : Math.min(annotTop, clipR.y1);
        noteAnnotMark(ctx, cats[i], groups[gj], bx + bw / 2, annotTop, errTopPx, v2 >= 0);
        noteClip(ctx, i, v2, true);
      }
    }
    // R6：显著性括号 + 字母标注
    parts.push(drawAnnotLayer(ctx, fr, u));
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks,
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: zeroY
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  RENDERS.line = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    if (ctx.chartSpec.characterization) {
      return wrap(ctx, renderCharacterization(ctx, idx));
    }
    var prep = prepareXY(ctx, idx.x, idx.y, null);
    if (!prep.points.length) throw new Error("renderChartSVG：line 没有可绘制的数据点");
    // R6：渐变系列色（单系列 t=0）
    setupSeriesGradient(ctx, [{
      key: stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y), label: ctx.mapping.y
    }]);
    var parts = drawSeriesChart(ctx, prep, {
      series: [{ key: "", points: prep.points }],
      colors: [ctx.palette[0]],
      legendItems: [],
      drawPoints: true
    });
    return wrap(ctx, parts);
  };

  RENDERS.line_multi = function (ctx) {
    var mapping = ctx.mapping || {};
    var wideYs = Array.isArray(mapping.ys)
      ? mapping.ys.filter(function (n) { return typeof n === "string" && n !== ""; })
      : null;
    if (ctx.chartSpec.characterization) {
      var idxC = requireCols(ctx, ["x", "y", "group"]);
      return wrap(ctx, renderCharacterization(ctx, idxC));
    }
    // R4-HB：宽表（mapping.ys）——每列一条系列，互斥 group；y2 按列名分轴
    if (wideYs && wideYs.length >= 2) {
      var xw = ctx.columns.indexOf(mapping.x);
      if (xw < 0) throw new Error("renderChartSVG：缺少映射列 x");
      var prepW = prepareWideSeries(ctx, xw, wideYs);
      if (!prepW.points.length) throw new Error("renderChartSVG：line_multi 没有可绘制的数据点");
      var y2w = normY2(ctx);
      // R6：渐变系列色须在图例色解析前登记
      setupSeriesGradient(ctx, prepW.series.map(function (sEntry) {
        return { key: stableSeriesKey("series", sEntry.key, sEntry.key), label: sEntry.key };
      }));
      var legendW = [];
      for (var iw = 0; iw < prepW.series.length; iw++) {
        var kw = stableSeriesKey("series", prepW.series[iw].key, prepW.series[iw].key);
        var rightW = !!(y2w && y2w.nameSet[prepW.series[iw].key]);
        legendW.push({ label: prepW.series[iw].key, kind: "line", key: kw, right: rightW,
          color: effSeriesStyle(ctx, kw, iw).stroke });
      }
      var partsW = drawSeriesChart(ctx, prepW, {
        series: prepW.series,
        colors: ctx.palette,
        legendItems: legendW,
        drawPoints: true,
        seriesKeyOf: function (sEntry) {
          return stableSeriesKey("series", sEntry.key, sEntry.key);
        }
      });
      return wrap(ctx, partsW);
    }
    var idx = requireCols(ctx, ["x", "y", "group"]);
    var prep = prepareXY(ctx, idx.x, idx.y, idx.group);
    if (!prep.points.length) throw new Error("renderChartSVG：line_multi 没有可绘制的数据点");
    var series = groupPoints(prep.points, "g");
    // R04：图例与曲线共用稳定键 + effSeriesStyle（同一有效样式来源）
    var y2l = normY2(ctx);
    // R6：渐变系列色须在图例色解析前登记（label=分组值，数值分组按值插值）
    setupSeriesGradient(ctx, series.map(function (sEntry) {
      return { key: stableSeriesKey("group", ctx.mapping.group, sEntry.key), label: sEntry.key };
    }));
    var legendItems = [];
    for (var i = 0; i < series.length; i++) {
      var k = stableSeriesKey("group", ctx.mapping.group, series[i].key);
      legendItems.push({ label: series[i].key, kind: "line", key: k,
        right: !!(y2l && y2l.nameSet[series[i].key]),
        color: effSeriesStyle(ctx, k, i).stroke });
    }
    var parts = drawSeriesChart(ctx, prep, {
      series: series,
      colors: ctx.palette,
      legendItems: legendItems,
      drawPoints: true,
      groupKeyed: true
    });
    return wrap(ctx, parts);
  };

  RENDERS.area = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var prep = prepareXY(ctx, idx.x, idx.y, null);
    if (!prep.points.length) throw new Error("renderChartSVG：area 没有可绘制的数据点");
    setupSeriesGradient(ctx, [{
      key: stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y), label: ctx.mapping.y
    }]);
    var parts = drawSeriesChart(ctx, prep, {
      series: [{ key: "", points: prep.points }],
      colors: [ctx.palette[0]],
      legendItems: [],
      drawPoints: false,
      fillArea: true
    });
    return wrap(ctx, parts);
  };

  RENDERS.scatter = function (ctx) {
    // Characterization only changes display metadata and declared equal scaling;
    // point rows, grouping, palette assignment and legend order stay untouched.
    var char = ctx.chartSpec.characterization ? applyCharacterizationMetadata(ctx) : null;
    var mapping = ctx.mapping || {};
    var wideYs = Array.isArray(mapping.ys)
      ? mapping.ys.filter(function (n) { return typeof n === "string" && n !== ""; })
      : null;
    var wide = !!(wideYs && wideYs.length >= 2);
    var idx = wide ? null : requireCols(ctx, ["x", "y"]);
    var colorIdx = wide ? -1 : colIndex(ctx, "color");
    var pts = [];
    var i, j;
    if (wide) {
      // R4-HB：宽表散点——每列一条系列（x,y 均须数值）；互斥 group/color 由上游保证
      var xw = ctx.columns.indexOf(mapping.x);
      if (xw < 0) throw new Error("renderChartSVG：缺少映射列 x");
      var yIdxs = [];
      for (i = 0; i < wideYs.length; i++) {
        var yw = ctx.columns.indexOf(wideYs[i]);
        if (yw < 0) throw new Error("renderChartSVG：mapping.ys 引用的列不存在：" + wideYs[i]);
        yIdxs.push(yw);
      }
      for (i = 0; i < ctx.rows.length; i++) {
        var rv = ctx.rows[i];
        var xwv = toNum(rv[xw]);
        if (isNaN(xwv)) continue;
        for (j = 0; j < yIdxs.length; j++) {
          var ywv = toNum(rv[yIdxs[j]]);
          if (isNaN(ywv)) continue;
          pts.push({ x: xwv, y: ywv, g: wideYs[j], source_row: i,
            raw_x: rv[xw], raw_y: rv[yIdxs[j]] });
        }
      }
      if (!pts.length) {
        throw new Error("renderChartSVG：scatter 没有可绘制的点（mapping.x/mapping.ys 必须是数值列）");
      }
    } else {
      for (i = 0; i < ctx.rows.length; i++) {
        var xv = toNum(ctx.rows[i][idx.x]);
        var yv = toNum(ctx.rows[i][idx.y]);
        if (isNaN(xv) || isNaN(yv)) continue;
        var g = null;
        if (colorIdx >= 0) {
          g = catLabel(ctx.rows[i][colorIdx]);
          if (g === null) continue;
        }
        pts.push({ x: xv, y: yv, g: g, source_row: i,
          raw_x: ctx.rows[i][idx.x], raw_y: ctx.rows[i][idx.y] });
      }
      if (!pts.length) {
        throw new Error("renderChartSVG：scatter 没有可绘制的点（mapping.x/mapping.y 必须是数值列）");
      }
    }

    var colorKeyed = !wide && colorIdx >= 0;
    var series = (wide || colorKeyed) ? groupPoints(pts, "g") : [{ key: "", points: pts }];
    if (wide || colorKeyed) {
      for (i = 0; i < series.length; i++) series[i].axisName = series[i].key;
    }
    // R6：渐变系列色须在图例色解析前登记
    setupSeriesGradient(ctx, series.map(function (sEntry, sIdx) {
      var gk = wide ? stableSeriesKey("series", sEntry.key, sEntry.key)
        : (colorKeyed ? stableSeriesKey("color", ctx.mapping.color, sEntry.key)
        : stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y));
      return { key: gk, label: sEntry.key };
    }));

    // R4-HB：右轴归属（y2.series 名 = 宽表列名 / 颜色分组值）
    var y2 = normY2(ctx);
    var rightAny = false;
    for (i = 0; i < series.length; i++) {
      var sNm = series[i].axisName !== undefined ? series[i].axisName : series[i].key;
      series[i]._right = !!(y2 && y2.nameSet[sNm]);
      if (series[i]._right) rightAny = true;
    }
    if (!rightAny) y2 = null;

    var legendItems = [];
    if (wide) {
      for (i = 0; i < series.length; i++) {
        var kw = stableSeriesKey("series", series[i].key, series[i].key);
        var kwS = effSeriesStyle(ctx, kw, i);
        var kwm = effMarkStyle(ctx, { kind: "point", seriesKey: kw, pointKey: null,
          defFill: null, defMarker: kwS.marker || "circle", defDiaPt: STYLE_DEFAULTS.scatterDiaPt });
        legendItems.push({ label: series[i].key, kind: "marker", key: kw, right: series[i]._right,
          marker: kwm.marker === "none" ? "circle" : kwm.marker,
          diaPt: kwm.sizePt,
          color: kwS.stroke });
      }
    } else if (colorKeyed) {
      for (i = 0; i < series.length; i++) {
        // R04：颜色分组系列用 color|<字段>|<值> 稳定键（与点绘制同源）
        var ck = stableSeriesKey("color", ctx.mapping.color, series[i].key);
        var ckS = effSeriesStyle(ctx, ck, i);
        var cm = effMarkStyle(ctx, { kind: "point", seriesKey: ck, pointKey: null,
          defFill: null, defMarker: ckS.marker || "circle", defDiaPt: STYLE_DEFAULTS.scatterDiaPt });
        legendItems.push({ label: series[i].key, kind: "marker", key: ck,
          right: series[i]._right,
          marker: cm.marker === "none" ? "circle" : cm.marker,
          diaPt: cm.sizePt,
          color: ckS.stroke });
      }
    }

    var xs = [], ysL = [], ysR = [];
    for (i = 0; i < pts.length; i++) { xs.push(pts[i].x); }
    // R6-4：xMin/xMax 限定时 y 自动域只按窗口内散点重算（无插值——
    // 散点是离散标记，窗外的点本就不画）。
    var xr0 = axisRangeOf(ctx, "x");
    for (i = 0; i < series.length; i++) {
      var pool2 = series[i]._right ? ysR : ysL;
      var visS = visibleYValues(series[i].points, xr0, false);
      if (visS) {
        for (j = 0; j < visS.length; j++) pool2.push(visS[j]);
      } else {
        for (j = 0; j < series[i].points.length; j++) pool2.push(series[i].points[j].y);
      }
    }
    var domX = valueDomain(xs, false);
    var domY = valueDomain(ysL.length ? ysL : ysR, false), domYR = null;
    padDomain(domX, 0.04, 0.04); padDomain(domY, xr0 ? 0.05 : 0.04, xr0 ? 0.05 : 0.04); // H1：散点 x/y 两端留白
    // R6：xMin/xMax/yMin/yMax 覆盖（y 只管左轴；y2 有独立 min/max）
    var xr = xr0, yr = axisRangeOf(ctx, "y");
    domX = applyAxisRange(domX, xr);
    domY = applyAxisRange(domY, yr);
    var xTicks = rangeTicks(domX, xr, 5);
    var yTicks = rangeTicks(domY, yr, 5);
    if ((!xr || xr.min == null) && xTicks.length) domX.min = Math.min(domX.min, xTicks[0]);
    if ((!xr || xr.max == null) && xTicks.length) domX.max = Math.max(domX.max, xTicks[xTicks.length - 1]);
    if ((!yr || yr.min == null) && yTicks.length) domY.min = Math.min(domY.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) domY.max = Math.max(domY.max, yTicks[yTicks.length - 1]);
    var y2Ticks = null;
    if (y2 && ysR.length) {
      domYR = valueDomain(ysR, false);
      padDomain(domYR, 0.04, 0.04);
      if (y2.min != null) domYR.min = y2.min;
      if (y2.max != null) domYR.max = y2.max;
      var rt = niceTicks(domYR.min, domYR.max, 5);
      if (y2.min == null) domYR.min = Math.min(domYR.min, rt[0]);
      if (y2.max == null) domYR.max = Math.max(domYR.max, rt[rt.length - 1]);
      y2Ticks = rt.filter(function (v) { return v >= domYR.min - 1e-9 && v <= domYR.max + 1e-9; });
    }

    var fr = cartesianFrame(ctx, {
      yTickLabels: yTicks.map(fmtNum),
      y2TickLabels: y2Ticks ? y2Ticks.map(fmtNum) : [],
      y2Title: y2 ? y2.label : null,
      legend: legendItems
    });
    if (char && charEqualAspect(char) && !y2) {
      var equal = equalAspectDomains(fr, domX, domY);
      domX = equal.x;
      domY = equal.y;
      // R6：equal_aspect 展域后用户范围仍优先
      domX = applyAxisRange(domX, xr);
      domY = applyAxisRange(domY, yr);
    }
    var sx = linScale(domX.min, domX.max, fr.x0, fr.x0 + fr.pw);
    var sy = linScale(domY.min, domY.max, plotDataBottom(fr), fr.y0);
    var syR = domYR ? linScale(domYR.min, domYR.max, plotDataBottom(fr), fr.y0) : null;
    noteXScale(ctx, sx);
    // R6：范围裁掉的刻度不画标签
    xTicks = xTicks.filter(function (v) {
      var pxv = sx(v); return pxv >= fr.x0 - 1 && pxv <= fr.x0 + fr.pw + 1;
    });
    yTicks = yTicks.filter(function (v) {
      var pyv = sy(v); return pyv >= fr.y0 - 1 && pyv <= plotDataBottom(fr) + 1;
    });

    var parts = [clipOpenTag(ctx)];
    // R6-A：数学裁剪——导出（PyMuPDF）不认 clip-path，框外的点不画
    var clipR = plotClipRect(ctx, fr);
    var clipActive = true; // R6-A：恒裁剪（clip-path 在导出中不生效）
    var u = ctx.dpi / 72;
    var totalMarks = 0;
    for (i = 0; i < series.length; i++) totalMarks += series[i].points.length;
    var compact = ctx.compactMarks === true && totalMarks > compactMarksThreshold();
    var presPts = compact ? presOf(ctx.chartSpec) : null;
    presPts = presPts && presPts.points && typeof presPts.points === "object"
      ? presPts.points : null;
    var hitBuf = compact ? [] : null;
    for (i = 0; i < series.length; i++) {
      var sk = wide
        ? stableSeriesKey("series", series[i].key, series[i].key)
        : (colorKeyed
          ? stableSeriesKey("color", ctx.mapping.color, series[i].key)
          : stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y));
      var syS = (series[i]._right && syR) ? syR : sy;
      var sSty = effSeriesStyle(ctx, sk, i);
      var color = sSty.stroke;
      // 系列默认标记样式（points 无覆盖时的有效样式），compact path 用它。
      // R5 返工：markerCycle 形状作为 defMarker 进入散点（此前只到折线）。
      var sDef = compact ? effMarkStyle(ctx, {
        kind: "point", seriesKey: sk, pointKey: null,
        defFill: color, defMarker: sSty.marker || "circle",
        defDiaPt: STYLE_DEFAULTS.scatterDiaPt,
        defStroke: STYLE_DEFAULTS.scatterStrokeColor,
        defStrokeWidthPt: STYLE_DEFAULTS.scatterStrokeWidthPt,
        defOpacity: STYLE_DEFAULTS.scatterOpacity
      }) : null;
      var compactD = compact ? [] : null;
      var ovParts = compact ? [] : null;
      for (var j = 0; j < series[i].points.length; j++) {
        var sp = series[i].points[j];
        var mk = mkPointKey(sp.source_row, sp.raw_x, sp.raw_y, sp.g);
        var px0 = sx(sp.x), py0 = syS(sp.y);
        noteClip(ctx, sp.x, sp.y, !series[i]._right); // R6：范围外点计数
        // R6-A：点心须连同半径留在绘图区内，否则整点跳过（导出无 clip-path）
        var mrEst = ((compact ? sDef.sizePt : STYLE_DEFAULTS.scatterDiaPt) * u) / 2;
        if (clipActive && !inRectPx(px0, py0, clipR, -mrEst)) continue;
        if (compact && !(presPts && presPts[mk])) {
          if (sDef.marker === "none") continue;
          var cr = sDef.sizePt * u / 2;
          compactD.push(markerSubpathD(px0, py0, cr, sDef.marker));
          noteGeom(ctx, { t: "pt", x: px0, y: py0, r: cr });
          if (hitBuf) hitBuf.push({
            x: px0, y: py0, r: cr, row: sp.source_row, key: mk, seriesKey: sk
          });
          continue;
        }
        var ms = effMarkStyle(ctx, {
          kind: "point", seriesKey: sk, pointKey: mk,
          defFill: color, defMarker: sSty.marker || "circle",
          defDiaPt: STYLE_DEFAULTS.scatterDiaPt,
          defStroke: STYLE_DEFAULTS.scatterStrokeColor,
          defStrokeWidthPt: STYLE_DEFAULTS.scatterStrokeWidthPt,
          defOpacity: STYLE_DEFAULTS.scatterOpacity
        });
        if (ms.marker === "none") continue;
        var pr = ms.sizePt * u / 2;
        noteGeom(ctx, { t: "pt", x: px0, y: py0, r: pr });
        var pExtra = ' data-chart-part="series" data-series-key="' + esc(sk) +
          '" data-point-key="' + esc(mk) + '" data-row="' + sp.source_row +
          '" data-size-pt="' + px(ms.sizePt) + '" data-marker="' + ms.marker + '"';
        if (ms.stroke) {
          pExtra += ' stroke="' + ms.stroke + '" stroke-width="' +
            px(ms.strokeWidthPt * u) + '"';
        }
        if (typeof ms.opacity === "number") pExtra += ' fill-opacity="' + px(ms.opacity) + '"';
        var el = markerShapeEl(px0, py0, pr, ms.fill, pExtra, ms.marker);
        if (hitBuf) hitBuf.push({
          x: px0, y: py0, r: pr, row: sp.source_row, key: mk, seriesKey: sk
        });
        if (compact) ovParts.push(el); else parts.push(el);
      }
      if (compact && compactD.length) {
        var cAttrs = ' fill="' + sDef.fill + '"';
        if (typeof sDef.opacity === "number") {
          cAttrs += ' fill-opacity="' + px(sDef.opacity) + '"';
        }
        if (sDef.stroke) {
          cAttrs += ' stroke="' + sDef.stroke + '" stroke-width="' +
            px(sDef.strokeWidthPt * u) + '"';
        }
        parts.push('<path d="' + compactD.join(" ") + '"' + cAttrs +
          ' data-compact-marks="1" data-chart-part="series" data-series-key="' +
          esc(sk) + '"/>');
        for (var k = 0; k < ovParts.length; k++) parts.push(ovParts[k]);
      } else if (compact) {
        for (var k2 = 0; k2 < ovParts.length; k2++) parts.push(ovParts[k2]);
      }
    }
    if (hitBuf && hitBuf.length) ctx.__compactHits = hitBuf;
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks.map(function (v) { return { px: sx(v), label: fmtNum(v) }; }),
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      y2Ticks: y2Ticks ? y2Ticks.map(function (v) { return { px: syR(v), label: fmtNum(v) }; }) : null,
      y2Label: y2 ? y2.label : null,
      zeroY: null
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  function arcPath(cx, cy, r, a0, a1) {
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    return "M " + px(cx) + " " + px(cy) +
      " L " + px(x0) + " " + px(y0) +
      " A " + px(r) + " " + px(r) + " 0 " + large + " 1 " + px(x1) + " " + px(y1) + " Z";
  }

  RENDERS.pie = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var agg = collectCategories(ctx.rows, idx.x, idx.y, "sum");
    if (!agg.cats.length) throw new Error("renderChartSVG：pie 没有可绘制的数据点");
    var total = 0, i;
    for (i = 0; i < agg.vals.length; i++) {
      if (agg.vals[i] < 0) {
        throw new Error("renderChartSVG：pie 数据包含负值（" + agg.cats[i] + " = " + agg.vals[i] + "），无法渲染");
      }
      total += agg.vals[i];
    }
    if (!(total > 0)) throw new Error("renderChartSVG：pie 数据总和必须大于 0");

    var f = tickFontPx(ctx);
    var pos = legendPos(ctx);
    var legendItems = [];
    for (i = 0; i < agg.cats.length; i++) {
      legendItems.push({ label: agg.cats[i], color: ctx.palette[i % ctx.palette.length], kind: "rect" });
    }
    var legW = 0;
    if (legendItems.length && pos === "right") legW = 16 + legendMaxW(legendItems, f) + 8;

    var availW = ctx.W - legW;
    var cx = availW / 2, cy = ctx.H / 2;
    var r = Math.min(availW, ctx.H) / 2 - f * 2.8;
    if (r < 12) throw new Error("renderChartSVG：画布尺寸过小，无法渲染 pie");

    var parts = [];
    var u = ctx.dpi / 72;
    var sepSw = ' stroke-width="' + px(STYLE_DEFAULTS.axisWidthPt * u) + '"';
    if (agg.cats.length === 1) {
      parts.push('<circle cx="' + px(cx) + '" cy="' + px(cy) + '" r="' + px(r) +
        '" fill="' + ctx.palette[0] + '" stroke="#FFFFFF"' + sepSw + '"/>');
    } else {
      var a0 = -Math.PI / 2;
      for (i = 0; i < agg.cats.length; i++) {
        var frac = agg.vals[i] / total;
        var a1 = a0 + frac * Math.PI * 2;
        if (frac > 0) {
          parts.push('<path d="' + arcPath(cx, cy, r, a0, a1) +
            '" fill="' + ctx.palette[i % ctx.palette.length] + '" stroke="#FFFFFF"' + sepSw + '"/>');
        }
        if (agg.cats.length <= 8 && frac > 0) {
          var mid = (a0 + a1) / 2;
          var lx = cx + (r + f * 0.6) * Math.cos(mid);
          var ly = cy + (r + f * 0.6) * Math.sin(mid);
          var cosM = Math.cos(mid);
          var anchor = cosM > 0.15 ? "start" : (cosM < -0.15 ? "end" : "middle");
          parts.push(text(lx, ly + f * 0.35,
            agg.cats[i] + " " + (Math.round(frac * 1000) / 10) + "%",
            { anchor: anchor, size: f * 0.95 }));
        }
        a0 = a1;
      }
    }

    // pseudo-frame so the shared legend renderer can be reused
    var fr = {
      x0: 8,
      y0: pos === "top" ? f * 2.6 : 8,
      ph: ctx.H - 16 - ((pos === "top" || pos === "bottom") ? f * 2.6 : 0),
      pw: availW - 16,
      tickF: f,
      legend: legendItems,
      legendX: ctx.W - legW + 4
    };
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  RENDERS.histogram = function (ctx) {
    if (ctx.chartSpec.characterization) {
      applyCharacterizationMetadata(ctx);
    }
    var idx = requireCols(ctx, ["x"]);
    var vals = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var v = toNum(ctx.rows[i][idx.x]);
      if (!isNaN(v)) vals.push(v);
    }
    if (!vals.length) {
      throw new Error("renderChartSVG：histogram 需要数值列（mapping.x），且至少要有一个有效数值");
    }

    var n = vals.length;
    var k = Math.max(5, Math.min(30, Math.ceil(Math.log(n) / Math.LN2) + 1)); // Sturges, clamped
    var min = Infinity, max = -Infinity;
    for (i = 0; i < n; i++) {
      if (vals[i] < min) min = vals[i];
      if (vals[i] > max) max = vals[i];
    }
    if (max === min) max = min + 1;
    var w = (max - min) / k;
    var counts = [];
    for (i = 0; i < k; i++) counts.push(0);
    for (i = 0; i < n; i++) {
      var bi = Math.floor((vals[i] - min) / w);
      if (bi < 0) bi = 0;
      if (bi >= k) bi = k - 1;
      counts[bi] += 1;
    }

    // R6：yMin/yMax 约束柱高（counts 轴）；xMin/xMax 约束 bin 值域
    var yr = axisRangeOf(ctx, "y"), xr = axisRangeOf(ctx, "x");
    // R6-4：x 范围限定时 counts 轴只按与窗口相交的 bin 重算
    var domCounts = counts;
    if (xr) {
      var visCounts = [];
      for (i = 0; i < k; i++) {
        var bLo = min + i * w, bHi = bLo + w;
        if (bHi >= (xr.min != null ? xr.min : -Infinity) &&
            bLo <= (xr.max != null ? xr.max : Infinity)) visCounts.push(counts[i]);
      }
      if (visCounts.length) domCounts = visCounts;
    }
    var dom = valueDomain(domCounts, true);
    padDomainNonZero(dom, 0.05); // H1：非零一端留 5%，零基线端不留白
    dom = applyAxisRange(dom, yr);
    var yTicks = rangeTicks(dom, yr, 5);
    if ((!yr || yr.min == null) && yTicks.length) dom.min = Math.min(dom.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);
    yTicks = yTicks.filter(function (v) { return v >= dom.min - 1e-9 && v <= dom.max + 1e-9; });
    // R6：范围外观测计数（x 越界的原始值逐个计）
    if (xr) {
      var outN = 0;
      for (i = 0; i < vals.length; i++) if (!inDataRange(vals[i], xr)) outN++;
      if (outN) ctx.__clipCount = (ctx.__clipCount || 0) + outN;
    }

    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: [] });
    var sy = linScale(dom.min, dom.max, plotDataBottom(fr), fr.y0);
    var xDom = applyAxisRange({ min: min, max: max }, xr);
    var sx = linScale(xDom.min, xDom.max, fr.x0, fr.x0 + fr.pw);
    noteXScale(ctx, sx);
    var bw = fr.pw / k;
    var baseY = plotDataBottom(fr);

    var parts = [clipOpenTag(ctx)];
    // R6-A：yMin/yMax 裁切后柱体只画可见部分（导出无 clip-path）
    var clipR = plotClipRect(ctx, fr); // R6-A：恒裁剪（导出无 clip-path）
    var clipBins = 0;
    for (i = 0; i < k; i++) {
      if (counts[i] <= 0) continue;
      if (yr && !inDataRange(counts[i], { min: yr.min, max: yr.max })) clipBins++;
      var top = sy(counts[i]);
      var bt = baseY, bb = Math.max(0.5, baseY - top);
      if (clipR) {
        top = Math.max(top, clipR.y0);
        bt = Math.min(bt, clipR.y1);
        bb = bt - top;
        if (bb <= 0.3) continue;
      }
      parts.push(rectEl(fr.x0 + i * bw + 0.5, top, Math.max(0.5, bw - 1), bb, ctx.palette[0]));
    }
    if (clipBins) ctx.__clipCount = (ctx.__clipCount || 0) + clipBins;
    var xTicks = [];
    for (i = 0; i <= k; i++) {
      var ev = min + i * w;
      var evpx = sx(ev);
      if (evpx < fr.x0 - 1 || evpx > fr.x0 + fr.pw + 1) continue;
      xTicks.push({ px: evpx, label: fmtNum(ev) });
    }
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks,
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    return wrap(ctx, parts);
  };

  RENDERS.heatmap = function (ctx) {
    var idx = requireCols(ctx, ["x", "y", "color"]);
    var xcats = [], xSeen = {}, ycats = [], ySeen = {}, cells = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var xl = catLabel(ctx.rows[i][idx.x]);
      var yl = catLabel(ctx.rows[i][idx.y]);
      var v = toNum(ctx.rows[i][idx.color]);
      if (xl === null || yl === null || isNaN(v)) continue;
      var ci = xSeen[xl];
      if (ci === undefined) { xSeen[xl] = xcats.length; ci = xcats.length; xcats.push(xl); }
      var ri = ySeen[yl];
      if (ri === undefined) { ySeen[yl] = ycats.length; ri = ycats.length; ycats.push(yl); cells.push([]); }
      var cell = cells[ri][ci];
      if (!cell) cell = cells[ri][ci] = { sum: 0, n: 0 };
      cell.sum += v;
      cell.n += 1;
    }
    if (!xcats.length || !ycats.length) {
      throw new Error("renderChartSVG：heatmap 没有可绘制的单元格");
    }

    // R6：x/y 范围按类别序号空间解释（0 起）；sticks 参考带不适用于热图
    var hxr = axisRangeOf(ctx, "x"), hyr = axisRangeOf(ctx, "y");
    // R6-4：色标值域只按可见单元格重算（与下方绘制跳过同一谓词）
    var vals = [];
    for (i = 0; i < cells.length; i++) {
      for (var j = 0; j < cells[i].length; j++) {
        if (!cells[i][j]) continue;
        if ((hxr && !inDataRange(j, hxr)) || (hyr && !inDataRange(i, hyr))) continue;
        vals.push(cells[i][j].sum / cells[i][j].n);
      }
    }
    if (!vals.length) { // 全部单元格被范围排除 → 回退全域防空域
      for (i = 0; i < cells.length; i++) {
        for (j = 0; j < cells[i].length; j++) {
          if (cells[i][j]) vals.push(cells[i][j].sum / cells[i][j].n);
        }
      }
    }
    var vmin = Infinity, vmax = -Infinity;
    for (i = 0; i < vals.length; i++) {
      if (vals[i] < vmin) vmin = vals[i];
      if (vals[i] > vmax) vmax = vals[i];
    }
    if (vmin === vmax) vmax = vmin + 1;

    var f = tickFontPx(ctx);
    var xStride = Math.max(1, Math.ceil(xcats.length / 24));
    var yStride = Math.max(1, Math.ceil(ycats.length / 24));
    var yShow = [];
    for (i = 0; i < ycats.length; i += yStride) {
      if (hyr && !inDataRange(i, hyr)) continue;
      yShow.push(ycats[i]);
    }
    var cbW = 8, cbLabelW = Math.max(textW(fmtNum(vmin), f), textW(fmtNum(vmax), f));

    var fr = cartesianFrame(ctx, { yTickLabels: yShow, legend: [], extraRight: cbW + cbLabelW + 12,
      noStickBand: true });
    var cw = fr.pw / xcats.length;
    var ch = fr.ph / ycats.length;
    var u = ctx.dpi / 72;
    var cellSw = ' stroke-width="' + px(STYLE_DEFAULTS.gridWidthPt * u) + '"';
    // R6：bands/references 的 x 单位 = 类别序号
    noteXScale(ctx, function (v) { return fr.x0 + (v + 0.5) * cw; });

    var parts = [clipOpenTag(ctx)];
    var drawCellText = xcats.length * ycats.length <= 30;
    for (i = 0; i < ycats.length; i++) {
      for (j = 0; j < xcats.length; j++) {
        var c3 = cells[i][j];
        if (!c3) continue;
        // R6：范围外单元格不画并计数
        if ((hxr && !inDataRange(j, hxr)) || (hyr && !inDataRange(i, hyr))) {
          ctx.__clipCount = (ctx.__clipCount || 0) + 1;
          continue;
        }
        var m = c3.sum / c3.n;
        var color = colorAt(ctx.palette, (m - vmin) / (vmax - vmin));
        parts.push(rectEl(fr.x0 + j * cw, fr.y0 + i * ch, cw, ch, color, ' stroke="#FFFFFF"' + cellSw));
        if (drawCellText) {
          parts.push(text(fr.x0 + (j + 0.5) * cw, fr.y0 + (i + 0.5) * ch + Math.min(f, ch * 0.55) * 0.35,
            fmtNum(m), { anchor: "middle", size: Math.min(f, ch * 0.55), fill: contrastFor(color) }));
        }
      }
    }
    parts.push(clipCloseTag(ctx));

    var xTicks = [];
    for (j = 0; j < xcats.length; j += xStride) {
      if (hxr && !inDataRange(j, hxr)) continue;
      xTicks.push({ px: fr.x0 + (j + 0.5) * cw, label: xcats[j] });
    }
    var yTicks = [];
    for (i = 0; i < ycats.length; i += yStride) {
      if (hyr && !inDataRange(i, hyr)) continue;
      yTicks.push({ px: fr.y0 + (i + 0.5) * ch, label: ycats[i] });
    }
    parts.push(drawFrameAxes(ctx, fr, { xTicks: xTicks, yTicks: yTicks, zeroY: null }));

    // colorbar
    var cbX = fr.x0 + fr.pw + 10, cbY = fr.y0, cbH = fr.ph, steps = 24;
    for (var s = 0; s < steps; s++) {
      var t = 1 - s / steps;
      parts.push(rectEl(cbX, cbY + s * (cbH / steps), cbW, cbH / steps + 0.5, colorAt(ctx.palette, t)));
    }
    parts.push(rectEl(cbX - 0.5, cbY - 0.5, cbW + 1, cbH + 1, "none",
      ' stroke="#000000" stroke-width="' + px(STYLE_DEFAULTS.axisWidthPt * u) + '"'));
    parts.push(text(cbX + cbW + 4, cbY + f * 0.8, fmtNum(vmax), { size: f }));
    parts.push(text(cbX + cbW + 4, cbY + cbH, fmtNum(vmin), { size: f }));

    return wrap(ctx, parts);
  };

  RENDERS.box = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var cats = [], seen = {}, values = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var lab = catLabel(ctx.rows[i][idx.x]);
      var v = toNum(ctx.rows[i][idx.y]);
      if (lab === null || isNaN(v)) continue;
      var k = seen[lab];
      if (k === undefined) { seen[lab] = cats.length; k = cats.length; cats.push(lab); values.push([]); }
      values[k].push(v);
    }
    if (!cats.length) throw new Error("renderChartSVG：box 没有可绘制的数据点");

    // R6-4：x 范围限定（x 单位=类别序号）时 y 域只按可见类别重算
    var xr = axisRangeOf(ctx, "x");
    var allVals = [];
    for (i = 0; i < values.length; i++) {
      if (!catIdxVisible(i, xr)) continue;
      for (var j = 0; j < values[i].length; j++) allVals.push(values[i][j]);
    }
    if (!allVals.length) { // 全部类别被范围排除 → 回退全域防空域
      for (i = 0; i < values.length; i++) {
        for (j = 0; j < values[i].length; j++) allVals.push(values[i][j]);
      }
    }
    var dom = valueDomain(allVals, false);
    // R6：yMin/yMax 覆盖 + 显著性/字母头room；padDomain 由 niceTicks 扩展取代
    var yr = axisRangeOf(ctx, "y");
    dom = applyAxisRange(dom, yr);
    var hr = annotHeadroom(ctx, dom, 0);
    if (hr > 0 && (!yr || yr.max == null)) dom.max += hr;
    var yTicks = rangeTicks(dom, yr, 5);
    if ((!yr || yr.min == null) && yTicks.length) dom.min = Math.min(dom.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);
    yTicks = yTicks.filter(function (v) { return v >= dom.min - 1e-9 && v <= dom.max + 1e-9; });

    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: [] });
    var sy = linScale(dom.min, dom.max, plotDataBottom(fr), fr.y0);
    var band = fr.pw / cats.length;
    var boxW = Math.max(2, band * 0.5);
    noteXScale(ctx, function (v) { return fr.x0 + band * (v + 0.5); });
    // R6：渐变/斜线填充的系列键（单系列约定同 bar）
    var boxKey = stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y);
    setupSeriesGradient(ctx, [{ key: boxKey, label: ctx.mapping.y }]);
    var boxCol = gradColorAt(ctx, 0) || ctx.palette[0];
    var boxHatch = seriesHatch(ctx, boxKey);

    var parts = [clipOpenTag(ctx)], xTicks = [];
    var u = ctx.dpi / 72;
    // R6-A：yMin/yMax 裁切——须线/箱体/抖动点数学裁剪（导出无 clip-path）
    var clipR = plotClipRect(ctx, fr); // R6-A：恒裁剪（导出无 clip-path）
    var bxSw = ' stroke-width="' + px(STYLE_DEFAULTS.axisWidthPt * u) + '"';
    var medSw = ' stroke-width="' + px(STYLE_DEFAULTS.lineWidthPt * u) + '"';
    var jitR = STYLE_DEFAULTS.scatterDiaPt * u / 4;
    function clipVLine(x, yA, yB, swAttr) {
      if (!clipR) { parts.push(lineEl(x, yA, x, yB, "#000000", swAttr)); return; }
      var c = clipSegRect(x, yA, x, yB, clipR);
      if (c) parts.push(lineEl(c[0], c[1], c[2], c[3], "#000000", swAttr));
    }
    function clipHLine(y, xA, xB, swAttr) {
      if (!clipR) { parts.push(lineEl(xA, y, xB, y, "#000000", swAttr)); return; }
      var c = clipSegRect(xA, y, xB, y, clipR);
      if (c) parts.push(lineEl(c[0], c[1], c[2], c[3], "#000000", swAttr));
    }
    for (i = 0; i < cats.length; i++) {
      // R6-4：x 范围外类别不画（y 域已按可见类别收紧）；逐观测计数
      if (!catIdxVisible(i, xr)) {
        var arrH = values[i];
        for (var jh = 0; jh < arrH.length; jh++) noteClip(ctx, i, arrH[jh], true);
        continue;
      }
      var center = fr.x0 + band * (i + 0.5);
      xTicks.push({ px: center, label: cats[i], cat: true });
      var arr = values[i].slice().sort(function (a, b) { return a - b; });
      var q1 = quantileSorted(arr, 0.25), q2 = quantileSorted(arr, 0.5), q3 = quantileSorted(arr, 0.75);
      var iqr = q3 - q1;
      var loFence = q1 - 1.5 * iqr, hiFence = q3 + 1.5 * iqr;
      var lo = null, hi = null;
      for (j = 0; j < arr.length; j++) {
        if (arr[j] >= loFence && (lo === null || arr[j] < lo)) lo = arr[j];
        if (arr[j] <= hiFence && (hi === null || arr[j] > hi)) hi = arr[j];
      }
      if (lo === null) lo = arr[0];
      if (hi === null) hi = arr[arr.length - 1];

      // whiskers
      clipVLine(center, sy(lo), sy(hi), bxSw);
      clipHLine(sy(lo), center - boxW / 4, center + boxW / 4, bxSw);
      clipHLine(sy(hi), center - boxW / 4, center + boxW / 4, bxSw);
      // box
      var boxY = sy(q3), boxH = Math.max(0.5, sy(q1) - sy(q3));
      var dTop = boxY, dBot = boxY + boxH;
      if (clipR) { dTop = Math.max(dTop, clipR.y0); dBot = Math.min(dBot, clipR.y1); }
      var dH = dBot - dTop;
      if (dH > 0.3) {
        parts.push(rectEl(center - boxW / 2, dTop, boxW, dH,
          boxCol, ' fill-opacity="0.3" stroke="#000000"' + bxSw));
        if (boxHatch) {
          parts.push(hatchSvg(ctx, center - boxW / 2, dTop, boxW, dH, boxHatch, "#333333"));
        }
      }
      // median
      clipHLine(sy(q2), center - boxW / 2, center + boxW / 2, medSw);
      // deterministic jitter points (all observations)
      for (j = 0; j < arr.length; j++) {
        var jx = center + ((j % 5) - 2) * (boxW / 6);
        var jyp = sy(arr[j]);
        noteClip(ctx, i, arr[j], true); // R6：范围外观测计数
        if (clipR && !inRectPx(jx, jyp, clipR, -jitR)) continue;
        parts.push(circleEl(jx, jyp, jitR, "#000000", ' fill-opacity="0.35"'));
      }
      // R6：字母/显著性标注登记（箱顶=上须顶端像素；裁切时取可见顶）
      var boxTopPx = clipR ? Math.max(sy(hi), clipR.y0) : sy(hi);
      noteAnnotMark(ctx, cats[i], null, center, boxTopPx, null);
    }
    // R6：显著性括号 + 字母标注
    parts.push(drawAnnotLayer(ctx, fr, u));
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks,
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    return wrap(ctx, parts);
  };

  /* ====================================================================
   * R10 补图型渲染器（bar_stacked/violin/dotplot/paired/marginal/volcano/
   * forest/survival/roc/pca/venn/sankey/taylor）。
   *
   * 诚信约定：凡渲染器自行计算的统计量（KDE、KM、AUC、椭圆、分箱、Sankey
   * 层级、Taylor 极坐标）一律写入根 <g> 的 data-* 诊断属性（wrap 统一输出），
   * 并在图内/图例中注明方法与参数；不计算检验 p 值、HR、log-rank 等推断
   * 统计量。逐元素可编辑性沿用 data-chart-part / data-series-key /
   * data-point-key / data-row 约定。
   * ==================================================================== */

  function diagAttr(ctx, k, v) {
    ctx.diagAttrs = ctx.diagAttrs || [];
    ctx.diagAttrs.push([k, String(v)]);
  }

  // 高斯 KDE（渲染器计算）：N(0,1) 核，Silverman 经验带宽
  // h = 0.9 * min(sd, iqr/1.34) * n^(-1/5)；grid 上求值。
  function kdeEval(samples, grid) {
    var n = samples.length;
    var mean = 0, m2 = 0;
    for (var i = 0; i < n; i++) mean += samples[i];
    mean /= n;
    for (i = 0; i < n; i++) { var d = samples[i] - mean; m2 += d * d; }
    var sd = Math.sqrt(m2 / Math.max(1, n - 1));
    var sorted = samples.slice().sort(function (a, b) { return a - b; });
    var iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
    var sig = Math.min(sd, iqr / 1.34);
    if (!(sig > 0)) sig = sd > 0 ? sd : (sorted[n - 1] - sorted[0] > 0 ? (sorted[n - 1] - sorted[0]) / 4 : 1);
    var h = 0.9 * sig * Math.pow(n, -0.2);
    if (!(h > 0)) h = 1e-6;
    var inv = 1 / (n * h * Math.sqrt(2 * Math.PI));
    var out = new Array(grid.length);
    for (var g = 0; g < grid.length; g++) {
      var x = grid[g], s = 0;
      for (i = 0; i < n; i++) {
        var z = (x - samples[i]) / h;
        s += Math.exp(-0.5 * z * z);
      }
      out[g] = s * inv;
    }
    return { values: out, bandwidth: h, n: n };
  }

  // 类别行收集（x=类别, y=数值）：返回 {cats, vals:[[...]], rowIdxs}
  function collectByCat(rows, xIdx, yIdx) {
    var cats = [], seen = {}, vals = [], rowIdxs = [];
    for (var i = 0; i < rows.length; i++) {
      var lab = catLabel(rows[i][xIdx]);
      var v = toNum(rows[i][yIdx]);
      if (lab === null || isNaN(v)) continue;
      var k = seen[lab];
      if (k === undefined) {
        seen[lab] = cats.length; k = cats.length;
        cats.push(lab); vals.push([]); rowIdxs.push([]);
      }
      vals[k].push(v); rowIdxs[k].push(i);
    }
    return { cats: cats, vals: vals, rows: rowIdxs };
  }

  // 通用类别轴 frame：cats 在 x 方向等距分带，返回 {fr,sxCat(centerFn),xTicks,yTicks…}
  // yTickLabels 可覆盖（dotplot/forest 的 y 轴是类别标签，不是数值刻度）
  function catFrame(ctx, cats, yDom, legendItems, yTickCount, yTickLabels) {
    var fr = cartesianFrame(ctx, {
      yTickLabels: yTickLabels ||
        rangeTicks(yDom, axisRangeOf(ctx, "y"), yTickCount || 5).map(fmtNum),
      legend: legendItems || []
    });
    var band = fr.pw / Math.max(1, cats.length);
    function catCx(i) { return fr.x0 + band * (i + 0.5); }
    return { fr: fr, band: band, catCx: catCx };
  }

  function catTicks(cats, cf, f) {
    var out = [];
    for (var i = 0; i < cats.length; i++) {
      out.push({ px: cf.catCx(i), label: cats[i], cat: true });
    }
    return out;
  }

  // ---- bar_stacked：x 类别 / group 组分 / y 数值，同格多行求和 ----
  RENDERS.bar_stacked = function (ctx) {
    var idx = requireCols(ctx, ["x", "y", "group"]);
    var plot = effPlot(ctx);
    var stackMode = (presOf(ctx.chartSpec) && presOf(ctx.chartSpec).plot &&
      presOf(ctx.chartSpec).plot.stackMode === "percent") ? "percent" : "value";
    var cells = {}; // cat -> group -> {sum, rows}
    var cats = [], gSeen = {}, groups = [];
    var dupSum = 0;
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var lab = catLabel(row[idx.x]), gl = catLabel(row[idx.group]);
      var v = toNum(row[idx.y]);
      if (lab === null || gl === null || isNaN(v)) continue;
      if (!cells[lab]) { cells[lab] = {}; cats.push(lab); }
      if (gSeen[gl] === undefined) { gSeen[gl] = groups.length; groups.push(gl); }
      var c = cells[lab][gl];
      if (c) { c.sum += v; c.n++; dupSum++; } else { cells[lab][gl] = { sum: v, n: 1 }; }
    }
    if (!cats.length) throw new Error("renderChartSVG：bar_stacked 没有可绘制的数据点");
    diagAttr(ctx, "data-aggregation", "sum-per-cell");
    if (dupSum) diagAttr(ctx, "data-duplicate-rows-summed", dupSum);
    diagAttr(ctx, "data-stack-mode", stackMode);

    // percent 归一化分母 = 该类别组分原始合计（缺组分时其余组分自动补齐到 100%）
    var totals = cats.map(function (c) {
      var t = 0;
      groups.forEach(function (g) { var cc = cells[c][g]; if (cc) t += cc.sum; });
      return t;
    });
    var dom = stackMode === "percent" ? { min: 0, max: 100 } : valueDomain(totals, true);
    var yr = axisRangeOf(ctx, "y");
    dom = applyAxisRange(dom, yr);
    var yTicks = rangeTicks(dom, yr, 5);
    if ((!yr || yr.min == null) && yTicks.length) dom.min = Math.min(dom.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);

    var legendItems = groups.map(function (g, gi) {
      var k = stableSeriesKey("group", ctx.mapping.group, g);
      var s = effSeriesStyle(ctx, k, gi);
      return { label: g, kind: "rect", key: k, color: s.stroke };
    });
    var cf = catFrame(ctx, cats, dom, legendItems, 5);
    var fr = cf.fr;
    var sy = linScale(dom.min, dom.max, plotDataBottom(fr), fr.y0);
    noteXScale(ctx, function (v) { return fr.x0 + cf.band * (v + 0.5); });
    var yTicksPx = yTicks.filter(function (v) {
      var p = sy(v); return p >= fr.y0 - 1 && p <= plotDataBottom(fr) + 1;
    });
    var parts = [clipOpenTag(ctx)];
    var clipR = plotClipRect(ctx, fr);
    var u = ctx.dpi / 72;
    var zeroY = sy(Math.max(dom.min, Math.min(0, dom.max)));
    for (var ci = 0; ci < cats.length; ci++) {
      var cx = cf.catCx(ci), bw = cf.band * 0.62;
      var acc = 0;
      for (var gi = 0; gi < groups.length; gi++) {
        var cell = cells[cats[ci]][groups[gi]];
        if (!cell) continue;
        var val = stackMode === "percent" ? (totals[ci] ? cell.sum / totals[ci] * 100 : 0) : cell.sum;
        var yTop = sy(acc + val), yBot = sy(acc);
        acc += val;
        var dTop = Math.max(yTop, clipR ? clipR.y0 : -1e9);
        var dBot = Math.min(yBot, clipR ? clipR.y1 : 1e9);
        if (dBot - dTop < 0.3) continue;
        var k = stableSeriesKey("group", ctx.mapping.group, groups[gi]);
        var sty = effSeriesStyle(ctx, k, gi);
        parts.push(rectEl(cx - bw / 2, dTop, bw, dBot - dTop, sty.stroke,
          ' data-chart-part="series" data-series-key="' + esc(k) + '" data-category="' + esc(cats[ci]) + '"'));
      }
    }
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: catTicks(cats, cf, fr.tickF),
      yTicks: yTicksPx.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: (dom.min < 0 && dom.max > 0) ? sy(0) : null
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  // ---- violin：每类高斯 KDE（Silverman），内嵌箱线；n<20 警告 ----
  RENDERS.violin = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var cc = collectByCat(ctx.rows, idx.x, idx.y);
    if (!cc.cats.length) throw new Error("renderChartSVG：violin 没有可绘制的数据点");
    var all = [];
    for (var i = 0; i < cc.vals.length; i++) for (var j = 0; j < cc.vals[i].length; j++) all.push(cc.vals[i][j]);
    var dom = valueDomain(all, false);
    var yr = axisRangeOf(ctx, "y");
    dom = applyAxisRange(dom, yr);
    var yTicks = rangeTicks(dom, yr, 5);
    if ((!yr || yr.min == null) && yTicks.length) dom.min = Math.min(dom.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);

    var minN = Infinity, maxBw = 0, warned = false;
    var kdes = cc.cats.map(function (c, i) {
      var s = cc.vals[i].slice().sort(function (a, b) { return a - b; });
      var n = s.length;
      if (n < minN) minN = n;
      if (n < 20) warned = true;
      var lo = s[0], hi = s[n - 1];
      // Silverman 带宽只依赖数据（与网格无关），先取 bw 再定网格范围，
      // 保证网格两端各覆盖 ≥3 倍带宽，KDE 数值积分≈1。
      var bw0 = kdeEval(s, [lo, hi]).bandwidth;
      var pad = Math.max((hi - lo) * 0.15, bw0 * 3) + 1e-9;
      var grid = [];
      for (var g = 0; g <= 48; g++) grid.push(lo - pad + (hi - lo + 2 * pad) * g / 48);
      var k = kdeEval(s, grid);
      if (k.bandwidth > maxBw) maxBw = k.bandwidth;
      var integ = 0;
      for (var gi2 = 1; gi2 < k.values.length; gi2++) {
        integ += (k.values[gi2] + k.values[gi2 - 1]) / 2 * (grid[gi2] - grid[gi2 - 1]);
      }
      return { grid: grid, dens: k.values, bw: k.bandwidth, n: n, integral: integ };
    });
    diagAttr(ctx, "data-method", "gaussian-kde");
    diagAttr(ctx, "data-kde-rule", "silverman");
    diagAttr(ctx, "data-kde-bandwidth-max", maxBw.toFixed(6));
    if (warned) diagAttr(ctx, "data-warning", "violin-n-lt-20-suggest-box-strip");

    var legendItems = [{ label: ctx.mapping.y, kind: "line", key: stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y) }];
    var cf = catFrame(ctx, cc.cats, dom, legendItems, 5);
    var fr = cf.fr;
    var sy = linScale(dom.min, dom.max, plotDataBottom(fr), fr.y0);
    noteXScale(ctx, function (v) { return fr.x0 + cf.band * (v + 0.5); });
    var yTicksPx = rangeTicks(dom, yr, 5).filter(function (v) {
      var p = sy(v); return p >= fr.y0 - 1 && p <= plotDataBottom(fr) + 1;
    });
    var parts = [clipOpenTag(ctx)];
    var clipR = plotClipRect(ctx, fr);
    var u = ctx.dpi / 72;
    var maxD = 0;
    for (i = 0; i < kdes.length; i++) for (j = 0; j < kdes[i].dens.length; j++) {
      if (kdes[i].dens[j] > maxD) maxD = kdes[i].dens[j];
    }
    if (!(maxD > 0)) maxD = 1;
    var vioW = cf.band * 0.42;
    var sty = effSeriesStyle(ctx, stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y), 0);
    var vCol = sty.stroke;
    for (i = 0; i < cc.cats.length; i++) {
      var cx = cf.catCx(i), kd = kdes[i];
      var left = [], right = [];
      for (j = 0; j < kd.grid.length; j++) {
        var half = vioW * (kd.dens[j] / maxD);
        var py = sy(kd.grid[j]);
        left.push({ x: cx - half, y: py }); right.push({ x: cx + half, y: py });
      }
      // KDE 网格向数据范围外延伸（pad≥3×带宽），轮廓须数学裁剪到绘图区——
      // 导出路径不依赖 clip-path，未裁剪会画出轴框/画布之外。
      var vpoly = left.concat(right.reverse());
      var vclip = clipPolyRect(vpoly, clipR);
      if (vclip && vclip.length >= 3) {
        var d = "M" + vclip.map(function (p) { return px(p.x) + " " + px(p.y); }).join(" L") + " Z";
        var key = stableSeriesKey("series", ctx.mapping.y, cc.cats[i]);
        parts.push('<path d="' + d + '" fill="' + vCol + '" fill-opacity="0.28" stroke="' + vCol +
          '" stroke-width="' + px(0.8 * u) + '" data-chart-part="violin" data-series-key="' + esc(key) +
          '" data-bandwidth="' + kd.bw.toFixed(6) + '" data-n="' + kd.n +
          '" data-kde-integral="' + kd.integral.toFixed(4) + '"/>');
      }
      // 内嵌箱线（IQR + 中位线 + 须）
      var arr = cc.vals[i].slice().sort(function (a, b) { return a - b; });
      var q1 = quantileSorted(arr, 0.25), q2 = quantileSorted(arr, 0.5), q3 = quantileSorted(arr, 0.75);
      var iqr = q3 - q1, loF = q1 - 1.5 * iqr, hiF = q3 + 1.5 * iqr;
      var lo = arr[0], hi = arr[arr.length - 1];
      for (j = 0; j < arr.length; j++) {
        if (arr[j] >= loF && arr[j] < lo) lo = arr[j];
        if (arr[j] <= hiF && arr[j] > hi) hi = arr[j];
      }
      var bw2 = vioW * 0.22;
      parts.push(lineEl(cx, sy(hi), cx, sy(lo), "#000000", ' stroke-width="' + px(0.6 * u) + '" data-chart-part="whisker"'));
      parts.push(lineEl(cx - bw2, sy(hi), cx + bw2, sy(hi), "#000000", ' stroke-width="' + px(0.6 * u) + '"'));
      parts.push(lineEl(cx - bw2, sy(lo), cx + bw2, sy(lo), "#000000", ' stroke-width="' + px(0.6 * u) + '"'));
      var bTop = Math.max(sy(q3), clipR ? clipR.y0 : -1e9);
      var bBot = Math.min(sy(q1), clipR ? clipR.y1 : 1e9);
      if (bBot - bTop > 0.3) {
        parts.push(rectEl(cx - bw2, bTop, bw2 * 2, bBot - bTop, vCol, ' fill-opacity="0.85" stroke="#ffffff" stroke-width="' + px(0.5 * u) + '" data-chart-part="iqr-box"'));
      }
      parts.push(lineEl(cx - bw2, sy(q2), cx + bw2, sy(q2), "#000000", ' stroke-width="' + px(0.9 * u) + '" data-chart-part="median"'));
    }
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: catTicks(cc.cats, cf, fr.tickF),
      yTicks: yTicksPx.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  // ---- dotplot（Cleveland 点图）：x 数值 / y 类别，按 (类别,值) 计数 ----
  RENDERS.dotplot = function (ctx) {
    var idx = requireCols(ctx, ["x"]);
    var yIdx = colIndex(ctx, "y");
    var sizeIdx = colIndex(ctx, "size");
    var colorIdx = colIndex(ctx, "color");
    var counts = {}, cats = [], cSeen = {};
    var xs = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var xv = toNum(row[idx.x]);
      var lab = catLabel(row[yIdx]);
      if (isNaN(xv) || lab === null) continue;
      if (cSeen[lab] === undefined) { cSeen[lab] = cats.length; cats.push(lab); }
      var key = lab + "" + xv;
      var cell = counts[key];
      if (!cell) { cell = { cat: lab, x: xv, n: 0, sizeSum: 0, sizeN: 0, color: null }; counts[key] = cell; }
      cell.n++;
      xs.push(xv);
      if (sizeIdx >= 0) { var sv = toNum(row[sizeIdx]); if (!isNaN(sv)) { cell.sizeSum += sv; cell.sizeN++; } }
      if (colorIdx >= 0 && cell.color === null) { cell.color = catLabel(row[colorIdx]); }
    }
    var cells = Object.keys(counts).map(function (k) { return counts[k]; });
    if (!cells.length) throw new Error("renderChartSVG：dotplot 没有可绘制的数据点");
    diagAttr(ctx, "data-aggregation", "count-per-category-value");
    diagAttr(ctx, "data-points", cells.length);

    var dom = valueDomain(xs, false);
    var xr = axisRangeOf(ctx, "x");
    dom = applyAxisRange(dom, xr);
    var xTicks = rangeTicks(dom, xr, 5);
    if ((!xr || xr.min == null) && xTicks.length) dom.min = Math.min(dom.min, xTicks[0]);
    if ((!xr || xr.max == null) && xTicks.length) dom.max = Math.max(dom.max, xTicks[xTicks.length - 1]);

    // 颜色分组图例
    var colorGroups = [];
    if (colorIdx >= 0) {
      var cgSeen = {};
      cells.forEach(function (c) {
        var g = c.color || "(无)";
        if (cgSeen[g] === undefined) { cgSeen[g] = colorGroups.length; colorGroups.push(g); }
      });
    }
    var legendItems = colorGroups.map(function (g, gi) {
      var k = stableSeriesKey("color", ctx.mapping.color, g);
      var s = effSeriesStyle(ctx, k, gi);
      return { label: g, kind: "marker", key: k, color: s.stroke };
    });
    // y 轴为类别：类别标签直接传给 frame 预留左边距（内容只影响宽度）
    var cf = catFrame(ctx, cats, dom, legendItems, 5, cats.slice());
    var fr = cf.fr;
    var sx = linScale(dom.min, dom.max, fr.x0, fr.x0 + fr.pw);
    noteXScale(ctx, sx);
    var maxN = 0;
    cells.forEach(function (c) { if (c.n > maxN) maxN = c.n; });
    var parts = [clipOpenTag(ctx)];
    var clipR = plotClipRect(ctx, fr);
    var u = ctx.dpi / 72;
    // 横向类别轴（y）：行高按绘图区高度均分，不能用 catFrame 的 x 向 band
    // （pw/ncats 在宽图上会让末行溢出底部被裁掉）。
    var rowH = (plotDataBottom(fr) - fr.y0) / Math.max(1, cats.length);
    // 类别引导线（细浅色行分隔，不是粗色带）
    for (var ci = 0; ci < cats.length; ci++) {
      var cy = fr.y0 + rowH * (ci + 0.5);
      parts.push(lineEl(fr.x0, cy, fr.x0 + fr.pw, cy, "#E2E8F0",
        ' stroke-width="' + px(0.7 * u) + '" data-chart-part="guide"'));
    }
    cells.forEach(function (c) {
      var ci = cSeen[c.cat];
      var cy = fr.y0 + rowH * (ci + 0.5);
      var pxv = sx(c.x);
      var r = 1.6 * u * Math.sqrt(c.n / maxN) + 0.8 * u;
      if (sizeIdx >= 0 && c.sizeN) r *= (0.6 + 0.8 * (c.sizeSum / c.sizeN) / 10);
      if (clipR && !inRectPx(pxv, cy, clipR, -r)) return;
      var fill = "#4C72B0";
      var skey = "";
      if (colorIdx >= 0) {
        skey = stableSeriesKey("color", ctx.mapping.color, c.color || "(无)");
        fill = effSeriesStyle(ctx, skey, cgSeen[c.color || "(无)"]).stroke;
      } else {
        skey = stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y);
        fill = effSeriesStyle(ctx, skey, 0).stroke;
      }
      parts.push(circleEl(pxv, cy, Math.min(r, rowH * 0.42), fill,
        ' data-chart-part="dot" data-series-key="' + esc(skey) + '" data-count="' + c.n + '" data-x="' + esc(c.x) + '"'));
      if (showValues(ctx) && c.n > 1) {
        parts.push(text(pxv, cy - r - 1.5 * u, String(c.n), {
          anchor: "middle", size: fr.tickF * 0.85, fill: "#374151",
          weight: "600", part: "dot-count"
        }));
      }
    });
    parts.push(clipCloseTag(ctx));
    var xTicksPx = xTicks.filter(function (v) {
      var p = sx(v); return p >= fr.x0 - 1 && p <= fr.x0 + fr.pw + 1;
    });
    // y 轴刻度=类别
    var yTicksOut = [];
    for (ci = 0; ci < cats.length; ci++) {
      yTicksOut.push({ px: fr.y0 + rowH * (ci + 0.5), label: cats[ci], cat: true });
    }
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicksPx.map(function (v) { return { px: sx(v), label: fmtNum(v) }; }),
      yTicks: yTicksOut,
      zeroY: null
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  // ---- paired：条件 × 个体配对连线；可选均值±SD ----
  RENDERS.paired = function (ctx) {
    var idx = requireCols(ctx, ["x", "y", "group"]);
    var conds = [], cSeen = {}, subj = {}, order = [];
    var rowsOK = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var cl = catLabel(row[idx.x]), yv = toNum(row[idx.y]), gl = catLabel(row[idx.group]);
      if (cl === null || isNaN(yv) || gl === null) continue;
      if (cSeen[cl] === undefined) { cSeen[cl] = conds.length; conds.push(cl); }
      var s = subj[gl];
      if (!s) { s = { id: gl, pts: {} }; subj[gl] = s; order.push(s); }
      s.pts[cSeen[cl]] = { x: cSeen[cl], y: yv, row: i, raw: row[idx.y] };
      rowsOK.push(i);
    }
    if (!conds.length) throw new Error("renderChartSVG：paired 没有可绘制的数据点");
    // 完整配对个体（覆盖全部条件）；缺条件个体计入排除并报告
    var subjects = order.filter(function (s) {
      for (var k = 0; k < conds.length; k++) if (!s.pts[k]) return false;
      return true;
    });
    var unpaired = order.length - subjects.length;
    diagAttr(ctx, "data-method", "paired-subject-lines");
    diagAttr(ctx, "data-subjects", subjects.length);
    if (unpaired > 0) diagAttr(ctx, "data-unpaired-subjects", unpaired);
    if (subjects.length === 0) {
      throw new Error("renderChartSVG：paired 没有覆盖全部条件的个体（缺配对个体 " + unpaired + " 个）");
    }

    var allY = [];
    subjects.forEach(function (s) {
      for (var k = 0; k < conds.length; k++) allY.push(s.pts[k].y);
    });
    var dom = valueDomain(allY, false);
    var yr = axisRangeOf(ctx, "y");
    dom = applyAxisRange(dom, yr);
    var yTicks = rangeTicks(dom, yr, 5);
    if ((!yr || yr.min == null) && yTicks.length) dom.min = Math.min(dom.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);

    var presPlotEarly = presOf(ctx.chartSpec) && presOf(ctx.chartSpec).plot;
    var wantSummary = !!(presPlotEarly && presPlotEarly.pairedSummary === true);
    var legendItems = [{ label: ctx.mapping.group, kind: "line",
      key: stableSeriesKey("series", ctx.mapping.group, ctx.mapping.group) }];
    if (wantSummary) legendItems.push({ label: "均值±SD", kind: "line",
      key: stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y) });
    var cf = catFrame(ctx, conds, dom, legendItems, 5);
    var fr = cf.fr;
    var sy = linScale(dom.min, dom.max, plotDataBottom(fr), fr.y0);
    noteXScale(ctx, function (v) { return fr.x0 + cf.band * (v + 0.5); });
    var parts = [clipOpenTag(ctx)];
    var clipR = plotClipRect(ctx, fr);
    var u = ctx.dpi / 72;
    var lineCol = "#9AA5B1";
    subjects.forEach(function (s, si) {
      var key = stableSeriesKey("group", ctx.mapping.group, s.id);
      var sty = effSeriesStyle(ctx, key, si % Math.max(1, ctx.palette.length));
      var prev = null;
      for (var k = 0; k < conds.length; k++) {
        var pt = s.pts[k];
        var pxv = cf.catCx(k), pyv = sy(pt.y);
        noteClip(ctx, k, pt.y, true);
        if (prev) {
          var c = clipR ? clipSegRect(prev[0], prev[1], pxv, pyv, clipR) : [prev[0], prev[1], pxv, pyv];
          if (c) parts.push(lineEl(c[0], c[1], c[2], c[3], lineCol,
            ' stroke-width="' + px(0.7 * u) + '" data-chart-part="pair-link" data-series-key="' + esc(key) + '"'));
        }
        if (!clipR || inRectPx(pxv, pyv, clipR, 2 * u)) {
          parts.push(circleEl(pxv, pyv, 1.9 * u, sty.stroke,
            ' data-chart-part="point" data-series-key="' + esc(key) + '" data-row="' + pt.row + '"'));
        }
        prev = [pxv, pyv];
      }
    });
    // 可选均值±SD 叠加（presentation.plot.pairedSummary === true）
    var presPlot = presPlotEarly;
    if (wantSummary) {
      diagAttr(ctx, "data-summary", "mean-sd-overlay");
      var sumKey = stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y);
      var sumSty = effSeriesStyle(ctx, sumKey, 0);
      for (var k2 = 0; k2 < conds.length; k2++) {
        var vals = subjects.map(function (s) { return s.pts[k2].y; });
        var mean = 0; vals.forEach(function (v) { mean += v; }); mean /= vals.length;
        var sd = 0; vals.forEach(function (v) { sd += (v - mean) * (v - mean); });
        sd = Math.sqrt(sd / Math.max(1, vals.length - 1));
        var cx2 = cf.catCx(k2);
        var yM = sy(mean), yS1 = sy(mean + sd), yS2 = sy(mean - sd);
        // mean±SD 可能超出数据域，逐段数学裁剪（导出不依赖 clip-path）
        var sdR = clipR || { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
        var capW = cf.band * 0.18, barW = cf.band * 0.3;
        [[cx2 - capW, yS1, cx2 + capW, yS1], [cx2 - capW, yS2, cx2 + capW, yS2],
         [cx2, yS1, cx2, yS2], [cx2 - barW, yM, cx2 + barW, yM]].forEach(function (sg, si2) {
          var c = clipSegRect(sg[0], sg[1], sg[2], sg[3], sdR);
          if (!c) return;
          var isMean = si2 === 3;
          parts.push(lineEl(c[0], c[1], c[2], c[3], isMean ? "#111827" : sumSty.stroke,
            ' stroke-width="' + px((isMean ? 1.1 : 0.8) * u) + '" data-chart-part="' +
            (isMean ? "summary-mean" : "summary-sd") + '"'));
        });
      }
    }
    parts.push(clipCloseTag(ctx));
    var yTicksPx = yTicks.filter(function (v) {
      var p = sy(v); return p >= fr.y0 - 1 && p <= plotDataBottom(fr) + 1;
    });
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: catTicks(conds, cf, fr.tickF),
      yTicks: yTicksPx.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  // ---- marginal：散点 + 顶部 x 直方图 + 右侧 y 直方图（Sturges 分箱）----
  RENDERS.marginal = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var pts = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var xv = toNum(ctx.rows[i][idx.x]), yv = toNum(ctx.rows[i][idx.y]);
      if (isNaN(xv) || isNaN(yv)) continue;
      pts.push({ x: xv, y: yv, row: i });
    }
    if (!pts.length) throw new Error("renderChartSVG：marginal 没有可绘制的散点");
    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var domX = valueDomain(xs, false), domY = valueDomain(ys, false);
    padDomain(domX, 0.04, 0.04); padDomain(domY, 0.04, 0.04);
    var xr = axisRangeOf(ctx, "x"), yr = axisRangeOf(ctx, "y");
    domX = applyAxisRange(domX, xr); domY = applyAxisRange(domY, yr);
    var xTicks = rangeTicks(domX, xr, 5), yTicks = rangeTicks(domY, yr, 5);

    // 先取整图 frame，再划出边际条带
    var frFull = cartesianFrame(ctx, {
      yTickLabels: yTicks.map(fmtNum), legend: []
    });
    var topH = frFull.ph * 0.2, rightW = frFull.pw * 0.2;
    var fr = {
      x0: frFull.x0, y0: frFull.y0 + topH,
      pw: frFull.pw - rightW, ph: frFull.ph - topH,
      tickF: frFull.tickF, titleF: frFull.titleF,
      yTickMaxW: frFull.yTickMaxW, y2TickMaxW: 0, legend: [],
      legendX: frFull.legendX, legendMaxW: 0, y2BlockW: 0, cbStripW: 0,
      stickBand: null
    };
    ctx.__plotFrame = fr;
    // 主绘图区（供测试断言边际直方图不与之相交）
    diagAttr(ctx, "data-main-plot",
      [fr.x0, fr.y0, fr.x0 + fr.pw, plotDataBottom(fr)]
        .map(function (v) { return +v.toFixed(2); }).join(","));
    var sx = linScale(domX.min, domX.max, fr.x0, fr.x0 + fr.pw);
    var sy = linScale(domY.min, domY.max, plotDataBottom(fr), fr.y0);
    noteXScale(ctx, sx);
    var u = ctx.dpi / 72;

    // Sturges 分箱
    function sturges(vals, d0, d1) {
      var n = vals.length;
      var k = Math.max(1, Math.ceil(Math.log2(n)) + 1);
      var w = (d1 - d0) / k, bins = new Array(k).fill(0);
      vals.forEach(function (v) {
        var b = Math.floor((v - d0) / w);
        if (b < 0) b = 0; if (b >= k) b = k - 1;
        bins[b]++;
      });
      return { bins: bins, w: w, k: k };
    }
    var hx = sturges(xs, domX.min, domX.max);
    var hy = sturges(ys, domY.min, domY.max);
    diagAttr(ctx, "data-marginal-bins", "sturges");
    diagAttr(ctx, "data-marginal-x-bins", hx.k);
    diagAttr(ctx, "data-marginal-y-bins", hy.k);

    var parts = [];
    var sSty = effSeriesStyle(ctx, stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y), 0);
    var pCol = sSty.stroke;
    var maxHx = Math.max.apply(null, hx.bins), maxHy = Math.max.apply(null, hy.bins);
    // 顶部 x 直方图：条带 = [fr.y0-topH, fr.y0)，列底贴主图上框（共享 x 刻度）
    for (var b = 0; b < hx.k; b++) {
      var bx0 = sx(domX.min + b * hx.w), bx1 = sx(domX.min + (b + 1) * hx.w);
      var bh = (hx.bins[b] / maxHx) * topH * 0.92;
      parts.push(rectEl(bx0 + 0.5, fr.y0 - bh, Math.max(0.5, bx1 - bx0 - 1), bh,
        pCol, ' fill-opacity="0.55" data-chart-part="marginal-x"'));
    }
    // 右侧 y 直方图（水平条）
    for (b = 0; b < hy.k; b++) {
      var by1 = sy(domY.min + (b + 1) * hy.w), by0 = sy(domY.min + b * hy.w);
      var bwid = (hy.bins[b] / maxHy) * rightW * 0.92;
      parts.push(rectEl(fr.x0 + fr.pw + (rightW - bwid), by1, bwid, Math.max(0.5, by0 - by1 - 1),
        pCol, ' fill-opacity="0.45" data-chart-part="marginal-y"'));
    }
    // 主散点（数学裁剪到主绘图区）
    var clipR = { x0: fr.x0, y0: fr.y0, x1: fr.x0 + fr.pw, y1: plotDataBottom(fr) };
    var mr = STYLE_DEFAULTS.scatterDiaPt * u / 2;
    pts.forEach(function (p, pi) {
      var pxv = sx(p.x), pyv = sy(p.y);
      noteClip(ctx, p.x, p.y, true);
      if (!inRectPx(pxv, pyv, clipR, -mr)) return;
      var mk = mkPointKey(p.row, p.x, p.y, null);
      var ms = effMarkStyle(ctx, {
        kind: "point", seriesKey: stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y),
        pointKey: mk, defFill: pCol, defMarker: "circle",
        defDiaPt: STYLE_DEFAULTS.scatterDiaPt
      });
      if (ms.marker === "none") return;
      var pr = ms.sizePt * u / 2;
      parts.push(markerShapeEl(pxv, pyv, pr, ms.fill,
        ' data-chart-part="series" data-point-key="' + esc(mk) + '" data-row="' + p.row + '"', ms.marker));
    });
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks.filter(function (v) { var p = sx(v); return p >= fr.x0 - 1 && p <= fr.x0 + fr.pw + 1; })
        .map(function (v) { return { px: sx(v), label: fmtNum(v) }; }),
      yTicks: yTicks.filter(function (v) { var p = sy(v); return p >= fr.y0 - 1 && p <= plotDataBottom(fr) + 1; })
        .map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    return wrap(ctx, parts);
  };

  // ---- volcano：x=log2FC / y=-log10(p) 原样使用；阈值来自 chartSpec.thresholds ----
  RENDERS.volcano = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var labelIdx = colIndex(ctx, "label");
    var pts = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var xv = toNum(row[idx.x]), yv = toNum(row[idx.y]);
      if (isNaN(xv) || isNaN(yv)) continue;
      pts.push({ x: xv, y: yv, row: i, label: labelIdx >= 0 ? catLabel(row[labelIdx]) : null });
    }
    if (!pts.length) throw new Error("renderChartSVG：volcano 没有可绘制的点（x/y 须为数值列）");
    var th = ctx.chartSpec && ctx.chartSpec.thresholds;
    var hasTh = th && typeof th === "object" &&
      typeof th.fc === "number" && isFinite(th.fc) && th.fc > 0 &&
      typeof th.p_neglog10 === "number" && isFinite(th.p_neglog10);
    if (!hasTh) diagAttr(ctx, "data-warning", "no-thresholds-all-points-neutral");
    diagAttr(ctx, "data-method", "volcano-threshold-colors");

    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var domX = valueDomain(xs, false), domY = valueDomain(ys, false);
    padDomain(domX, 0.04, 0.04); padDomain(domY, 0.04, 0.04);
    var xr = axisRangeOf(ctx, "x"), yr = axisRangeOf(ctx, "y");
    domX = applyAxisRange(domX, xr); domY = applyAxisRange(domY, yr);
    var xTicks = rangeTicks(domX, xr, 5), yTicks = rangeTicks(domY, yr, 5);
    if ((!xr || xr.min == null) && xTicks.length) domX.min = Math.min(domX.min, xTicks[0]);
    if ((!xr || xr.max == null) && xTicks.length) domX.max = Math.max(domX.max, xTicks[xTicks.length - 1]);
    if ((!yr || yr.min == null) && yTicks.length) domY.min = Math.min(domY.min, yTicks[0]);
    if ((!yr || yr.max == null) && yTicks.length) domY.max = Math.max(domY.max, yTicks[yTicks.length - 1]);

    var groups = hasTh ? ["up", "down", "ns"] : ["all"];
    var legendItems = groups.map(function (g, gi) {
      var lab = g === "up" ? "上调" : g === "down" ? "下调" : g === "ns" ? "不显著" : ctx.mapping.y;
      var k = stableSeriesKey("series", "volcano", g);
      var s = effSeriesStyle(ctx, k, gi);
      return { label: lab, kind: "marker", key: k, color: s.stroke };
    });
    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: legendItems });
    var sx = linScale(domX.min, domX.max, fr.x0, fr.x0 + fr.pw);
    var sy = linScale(domY.min, domY.max, plotDataBottom(fr), fr.y0);
    noteXScale(ctx, sx);
    var u = ctx.dpi / 72;
    var clipR = plotClipRect(ctx, fr);
    // 语义色：up=palette0 / down=palette1 / ns=灰（用户 series 覆盖优先）
    var colOf = {
      up: effSeriesStyle(ctx, stableSeriesKey("series", "volcano", "up"), 0).stroke,
      down: effSeriesStyle(ctx, stableSeriesKey("series", "volcano", "down"), 1).stroke,
      ns: "#9AA5B1",
      all: effSeriesStyle(ctx, stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y), 0).stroke
    };
    if (!hasTh) colOf.all = colOf.up; // 无阈值时单色（palette0）
    function clsOf(p) {
      if (!hasTh) return "all";
      if (p.x > th.fc && p.y > th.p_neglog10) return "up";
      if (p.x < -th.fc && p.y > th.p_neglog10) return "down";
      return "ns";
    }
    var parts = [clipOpenTag(ctx)];
    // 阈值线（用户提供才画）
    if (hasTh) {
      var thx1 = sx(-th.fc), thx2 = sx(th.fc), thy = sy(th.p_neglog10);
      var dashA = ' stroke-dasharray="' + (3 * u) + ' ' + (2 * u) + '" stroke-width="' + px(0.7 * u) + '"';
      if (clipR) {
        var c1 = clipSegRect(thx1, fr.y0, thx1, plotDataBottom(fr), clipR);
        var c2 = clipSegRect(thx2, fr.y0, thx2, plotDataBottom(fr), clipR);
        var c3 = clipSegRect(fr.x0, thy, fr.x0 + fr.pw, thy, clipR);
        if (c1) parts.push(lineEl(c1[0], c1[1], c1[2], c1[3], "#B91C1C", dashA + ' data-chart-part="threshold"'));
        if (c2) parts.push(lineEl(c2[0], c2[1], c2[2], c2[3], "#B91C1C", dashA + ' data-chart-part="threshold"'));
        if (c3) parts.push(lineEl(c3[0], c3[1], c3[2], c3[3], "#B91C1C", dashA + ' data-chart-part="threshold"'));
      }
    }
    pts.forEach(function (p) {
      var pxv = sx(p.x), pyv = sy(p.y);
      noteClip(ctx, p.x, p.y, true);
      if (clipR && !inRectPx(pxv, pyv, clipR, 2 * u)) return;
      var g = clsOf(p);
      var k = stableSeriesKey("series", "volcano", hasTh ? g : "all");
      var mk = mkPointKey(p.row, p.x, p.y, g);
      var ms = effMarkStyle(ctx, {
        kind: "point", seriesKey: k, pointKey: mk,
        defFill: colOf[g], defMarker: "circle", defDiaPt: STYLE_DEFAULTS.scatterDiaPt
      });
      if (ms.marker === "none") return;
      parts.push(markerShapeEl(pxv, pyv, ms.sizePt * u / 2, ms.fill,
        ' data-chart-part="series" data-series-key="' + esc(k) + '" data-point-key="' + esc(mk) +
        '" data-row="' + p.row + '" data-class="' + g + '"', ms.marker));
      p._px = pxv; p._py = pyv; p._g = g;
    });
    // labelTop：按 y 取前 n 个点标注 label 列（防重叠：贪心最小间距）
    var presPlot = presOf(ctx.chartSpec) && presOf(ctx.chartSpec).plot;
    var topN = presPlot && typeof presPlot.labelTop === "number" && presPlot.labelTop > 0
      ? Math.floor(presPlot.labelTop) : 0;
    if (topN > 0 && labelIdx >= 0) {
      var cands = pts.filter(function (p) { return p.label && p._px !== undefined; })
        .sort(function (a, b) { return b.y - a.y; });
      var placed = [];
      var minGap = fr.tickF * 1.35;
      for (var li = 0; li < cands.length && placed.length < topN; li++) {
        var cp = cands[li], ok = true;
        for (var pj = 0; pj < placed.length; pj++) {
          if (Math.abs(placed[pj]._py - cp._py) < minGap && Math.abs(placed[pj]._px - cp._px) < fr.pw * 0.2) { ok = false; break; }
        }
        if (!ok) continue;
        placed.push(cp);
        parts.push(text(cp._px + 2 * u, cp._py - 2 * u, cp.label, {
          anchor: "start", size: fr.tickF * 0.9, fill: colOf[cp._g] || "#111827",
          weight: "600", part: "volcano-label"
        }));
      }
      diagAttr(ctx, "data-label-top", placed.length);
    } else if (topN > 0) {
      diagAttr(ctx, "data-warning", "labelTop-no-label-column");
    }
    parts.push(clipCloseTag(ctx));
    var xTicksPx = xTicks.filter(function (v) { var p = sx(v); return p >= fr.x0 - 1 && p <= fr.x0 + fr.pw + 1; });
    var yTicksPx = yTicks.filter(function (v) { var p = sy(v); return p >= fr.y0 - 1 && p <= plotDataBottom(fr) + 1; });
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicksPx.map(function (v) { return { px: sx(v), label: fmtNum(v) }; }),
      yTicks: yTicksPx.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: (domY.min < 0 && domY.max > 0) ? sy(0) : null
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  // ---- forest：y=研究/模型、x=效应量；lo/hi 列或 error 对称半宽；参考竖线 ----
  RENDERS.forest = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var errIdx = colIndex(ctx, "error");
    var loIdx = colIndex(ctx, "lo"), hiIdx = colIndex(ctx, "hi");
    var sizeIdx = colIndex(ctx, "size");
    var hasCI = (loIdx >= 0 && hiIdx >= 0) || errIdx >= 0;
    if (!hasCI) diagAttr(ctx, "data-warning", "no-ci-columns");
    diagAttr(ctx, "data-ci-source", (loIdx >= 0 && hiIdx >= 0) ? "lo-hi-columns" : (errIdx >= 0 ? "error-column" : "none"));

    var items = [];
    var xs = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var yv = catLabel(row[idx.y]), xv = toNum(row[idx.x]);
      if (yv === null || isNaN(xv)) continue;
      var lo = null, hi = null;
      if (loIdx >= 0 && hiIdx >= 0) {
        var lv = toNum(row[loIdx]), hv = toNum(row[hiIdx]);
        if (!isNaN(lv) && !isNaN(hv)) { lo = lv; hi = hv; }
      }
      if ((lo === null || hi === null) && errIdx >= 0) {
        var ev = toNum(row[errIdx]);
        if (!isNaN(ev)) { lo = xv - ev; hi = xv + ev; }
      }
      var w = 1;
      if (sizeIdx >= 0) { var sv = toNum(row[sizeIdx]); if (!isNaN(sv) && sv > 0) w = sv; }
      items.push({ label: yv, est: xv, lo: lo, hi: hi, w: w, row: i });
      xs.push(xv);
      if (lo !== null) { xs.push(lo); xs.push(hi); }
    }
    if (!items.length) throw new Error("renderChartSVG：forest 没有可绘制的数据点");
    var dom = valueDomain(xs, false);
    var presPlot = presOf(ctx.chartSpec) && presOf(ctx.chartSpec).plot;
    var nullV = presPlot && typeof presPlot.nullValue === "number" && isFinite(presPlot.nullValue)
      ? presPlot.nullValue : 0;
    dom.min = Math.min(dom.min, nullV); dom.max = Math.max(dom.max, nullV);
    var xr = axisRangeOf(ctx, "x");
    dom = applyAxisRange(dom, xr);
    var xTicks = rangeTicks(dom, xr, 5);
    if ((!xr || xr.min == null) && xTicks.length) dom.min = Math.min(dom.min, xTicks[0]);
    if ((!xr || xr.max == null) && xTicks.length) dom.max = Math.max(dom.max, xTicks[xTicks.length - 1]);

    var cats = items.map(function (it) { return it.label; });
    var cf = catFrame(ctx, cats, dom, [], 5, cats.slice());
    var fr = cf.fr;
    var sx = linScale(dom.min, dom.max, fr.x0, fr.x0 + fr.pw);
    noteXScale(ctx, sx);
    var u = ctx.dpi / 72;
    var clipR = plotClipRect(ctx, fr);
    var maxW = 0;
    items.forEach(function (it) { if (it.w > maxW) maxW = it.w; });
    var parts = [clipOpenTag(ctx)];
    // 横向类别轴（y）：行高按绘图区高度均分，不能用 catFrame 的 x 向 band
    // （pw/ncats 在宽图上会让末行溢出底部被裁掉）。
    var rowH = (plotDataBottom(fr) - fr.y0) / Math.max(1, cats.length);
    items.forEach(function (it, ii) {
      var cy = fr.y0 + rowH * (ii + 0.5);
      var key = stableSeriesKey("series", ctx.mapping.y, it.label);
      var sty = effSeriesStyle(ctx, key, ii % Math.max(1, ctx.palette.length));
      var estPx = sx(it.est);
      // CI 横线 + 端帽
      if (it.lo !== null) {
        var lx = sx(it.lo), hx = sx(it.hi);
        var c = clipR ? clipSegRect(lx, cy, hx, cy, clipR) : [lx, cy, hx, cy];
        if (c) parts.push(lineEl(c[0], c[1], c[2], c[3], sty.stroke,
          ' stroke-width="' + px(1.0 * u) + '" data-chart-part="ci" data-row="' + it.row + '"'));
        [lx, hx].forEach(function (ex) {
          var capH = Math.min(rowH * 0.22, 4 * u);
          parts.push(lineEl(ex, cy - capH, ex, cy + capH, sty.stroke,
            ' stroke-width="' + px(0.8 * u) + '" data-chart-part="ci-cap"'));
        });
      }
      // 方块估计量（size 列→权重映射半径）
      var r = (2.2 + 3.4 * Math.sqrt(it.w / (maxW || 1))) * u;
      if (clipR && inRectPx(estPx, cy, clipR, -r)) {
        parts.push('<rect x="' + px(estPx - r) + '" y="' + px(cy - r) + '" width="' + px(r * 2) +
          '" height="' + px(r * 2) + '" fill="' + sty.stroke + '" data-chart-part="estimate" data-row="' +
          it.row + '"/>');
      }
      // 行标签由 drawFrameAxes 的 yTicks 输出（轴层，不被数据裁剪）
    });
    // 参考竖线（默认 0；比值类由用户设 nullValue=1）
    var nx = sx(nullV);
    if (clipR) {
      var c = clipSegRect(nx, fr.y0, nx, plotDataBottom(fr), clipR);
      if (c) parts.push(lineEl(c[0], c[1], c[2], c[3], "#111827",
        ' stroke-width="' + px(0.8 * u) + '" stroke-dasharray="' + (3 * u) + ' ' + (2 * u) + '" data-chart-part="null-line" data-null-value="' + nullV + '"'));
    }
    parts.push(clipCloseTag(ctx));
    var yTicksOut = [];
    for (var yi = 0; yi < cats.length; yi++) {
      yTicksOut.push({ px: fr.y0 + rowH * (yi + 0.5), label: cats[yi] });
    }
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks.filter(function (v) { var p = sx(v); return p >= fr.x0 - 1 && p <= fr.x0 + fr.pw + 1; })
        .map(function (v) { return { px: sx(v), label: fmtNum(v) }; }),
      yTicks: yTicksOut,
      zeroY: null
    }));
    return wrap(ctx, parts);
  };

  // ---- survival：Kaplan–Meier 阶梯曲线 + 删失刻度（渲染器按时间/事件列计算）----
  RENDERS.survival = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var gIdx = colIndex(ctx, "group");
    // 事件判定：1/true/"1"/"true"/"事件"/"yes" 视为事件；0/false/"0"/"false"/"删失"/"no" 删失；
    // 其他数值 >0 视为事件（如 2=竞争风险也按事件处理并注明）。
    function isEvent(v) {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v > 0;
      var s = String(v).trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes" || s === "y" || s === "事件" || s === "event") return true;
      if (s === "0" || s === "false" || s === "no" || s === "n" || s === "删失" || s === "censor" || s === "") return false;
      var n = Number(s);
      return !isNaN(n) && n > 0;
    }
    var groups = {}, gOrder = [];
    var nTotal = 0;
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var tv = toNum(row[idx.x]);
      if (isNaN(tv)) continue;
      var ev = isEvent(row[idx.y]);
      var gl = gIdx >= 0 ? catLabel(row[gIdx]) : null;
      var gkey = (gIdx >= 0 && gl !== null) ? gl : "";
      if (gIdx >= 0 && gl === null) continue;
      if (!groups[gkey]) { groups[gkey] = []; gOrder.push(gkey); }
      groups[gkey].push({ t: tv, e: ev, row: i });
      nTotal++;
    }
    if (!nTotal) throw new Error("renderChartSVG：survival 没有可绘制的数据点（x 时间须数值，y 事件列 1=事件/0=删失）");
    diagAttr(ctx, "data-method", "kaplan-meier");
    diagAttr(ctx, "data-estimated-by", "renderer-from-time-event-columns");
    diagAttr(ctx, "data-n", nTotal);
    diagAttr(ctx, "data-inference", "none-no-hr-no-logrank");

    // 每组 KM 曲线：排序时间、事件时点乘积极限
    var curves = gOrder.map(function (g, gi) {
      var obs = groups[g].slice().sort(function (a, b) { return a.t - b.t; });
      var times = [];
      obs.forEach(function (o) { if (o.e && times.indexOf(o.t) < 0) times.push(o.t); });
      times.sort(function (a, b) { return a - b; });
      var S = 1, pts = [{ t: obs[0].t, s: 1 }], censored = [];
      var ti = 0;
      for (var k = 0; k < times.length; k++) {
        var t = times[k];
        var atRisk = 0, d = 0;
        for (var j = 0; j < obs.length; j++) {
          if (obs[j].t >= t) atRisk++;
          if (obs[j].t === t && obs[j].e) d++;
        }
        if (atRisk > 0 && d > 0) S *= (1 - d / atRisk);
        pts.push({ t: t, s: S });
      }
      // 曲线延伸到该组最后一个观测时刻（含纯删失尾部）
      var lastT = obs[obs.length - 1].t;
      if (pts[pts.length - 1].t < lastT) pts.push({ t: lastT, s: S });
      obs.forEach(function (o) { if (!o.e) censored.push({ t: o.t }); });
      // 删失点取该时刻的 S（插值到最近事件后水平段）
      censored.forEach(function (c) {
        var sv = 1;
        for (var p = 0; p < pts.length; p++) if (pts[p].t <= c.t) sv = pts[p].s;
        c.s = sv;
      });
      return { key: g, pts: pts, censored: censored, n: obs.length, gi: gi };
    });
    var maxT = 0;
    curves.forEach(function (c) { c.pts.forEach(function (p) { if (p.t > maxT) maxT = p.t; }); });
    if (!(maxT > 0)) maxT = 1;
    var domX = { min: 0, max: maxT * 1.02 };
    var domY = { min: 0, max: 1 };
    var xr = axisRangeOf(ctx, "x"), yr = axisRangeOf(ctx, "y");
    domX = applyAxisRange(domX, xr); domY = applyAxisRange(domY, yr);
    var xTicks = rangeTicks(domX, xr, 5), yTicks = [0, 0.25, 0.5, 0.75, 1];
    var legendItems = curves.map(function (c, gi) {
      if (gIdx < 0) return null;
      var k = stableSeriesKey("group", ctx.mapping.group, c.key);
      var s = effSeriesStyle(ctx, k, gi);
      return { label: c.key, kind: "line", key: k, color: s.stroke };
    }).filter(function (x) { return !!x; });
    // y 轴语义：事件列名（makeChartElement 自动烘焙的 mapping.y）不是生存率
    // 标题——仅当 yLabel 仍是该烘焙值时替换为 Survival probability；用户自定义
    // 标题（≠列名）原样保留。
    if (ctx.axes.yLabel === ctx.mapping.y) {
      ctx.axes = Object.assign({}, ctx.axes, { yLabel: "Survival probability" });
    }
    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(function (v) { return fmtNum(v); }), legend: legendItems });
    var sx = linScale(domX.min, domX.max, fr.x0, fr.x0 + fr.pw);
    var sy = linScale(domY.min, domY.max, plotDataBottom(fr), fr.y0);
    noteXScale(ctx, sx);
    var u = ctx.dpi / 72;
    var clipR = plotClipRect(ctx, fr);
    var parts = [clipOpenTag(ctx)];
    curves.forEach(function (c) {
      var key = gIdx >= 0 ? stableSeriesKey("group", ctx.mapping.group, c.key)
        : stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y);
      var sty = effSeriesStyle(ctx, key, c.gi % Math.max(1, ctx.palette.length));
      var col = sty.stroke;
      // 阶梯：先水平后垂直（事件后下跌约定）
      var d = "";
      var prevT = c.pts[0].t, prevS = c.pts[0].s;
      d += "M" + px(sx(prevT)) + " " + px(sy(prevS));
      for (var p = 1; p < c.pts.length; p++) {
        d += " L" + px(sx(c.pts[p].t)) + " " + px(sy(prevS)) +
             " L" + px(sx(c.pts[p].t)) + " " + px(sy(c.pts[p].s));
        prevS = c.pts[p].s;
      }
      parts.push('<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="' +
        px(1.3 * u) + '" data-chart-part="km-curve" data-series-key="' + esc(key) +
        '" data-n="' + c.n + '" data-km="' +
        c.pts.map(function (p) { return p.t + ":" + (+p.s.toFixed(4)); }).join(";") + '"/>');
      // 删失刻度（曲线点处竖短线，±4.5u 长、1.0u 宽保证可见）
      c.censored.forEach(function (cz) {
        var cxp = sx(cz.t), cyp = sy(cz.s);
        if (clipR) {
          var cc2 = clipSegRect(cxp, cyp - 4.5 * u, cxp, cyp + 4.5 * u, clipR);
          if (cc2) parts.push(lineEl(cc2[0], cc2[1], cc2[2], cc2[3], col,
            ' stroke-width="' + px(1.0 * u) + '" data-chart-part="censor-tick"'));
        }
      });
    });
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks.filter(function (v) { var p = sx(v); return p >= fr.x0 - 1 && p <= fr.x0 + fr.pw + 1; })
        .map(function (v) { return { px: sx(v), label: fmtNum(v) }; }),
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  // ---- roc：x=FPR / y=TPR（用户已算好的点）；AUC 梯形积分注明方法 ----
  RENDERS.roc = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var gIdx = colIndex(ctx, "group");
    var groups = {}, gOrder = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var xv = toNum(row[idx.x]), yv = toNum(row[idx.y]);
      if (isNaN(xv) || isNaN(yv)) continue;
      var gl = gIdx >= 0 ? catLabel(row[gIdx]) : null;
      if (gIdx >= 0 && gl === null) continue;
      var gkey = (gIdx >= 0 && gl !== null) ? gl : "";
      if (!groups[gkey]) { groups[gkey] = []; gOrder.push(gkey); }
      groups[gkey].push({ x: xv, y: yv, row: i });
    }
    if (!gOrder.length) throw new Error("renderChartSVG：roc 没有可绘制的点（x=FPR、y=TPR 须为数值列）");
    diagAttr(ctx, "data-method", "roc-user-points");
    diagAttr(ctx, "data-auc-method", "trapezoid-on-given-points");

    var curves = gOrder.map(function (g, gi) {
      var pts = groups[g].slice().sort(function (a, b) { return a.x - b.x; });
      var auc = 0;
      for (var k = 1; k < pts.length; k++) {
        auc += (pts[k].x - pts[k - 1].x) * (pts[k].y + pts[k - 1].y) / 2;
      }
      return { key: g, pts: pts, auc: auc, gi: gi };
    });
    // ROC 空间含 [0,1]：域取数据与单位区间的并集
    var domX = { min: 0, max: 1 }, domY = { min: 0, max: 1 };
    var partialCoverage = false;
    curves.forEach(function (c) {
      var hasStart = false, hasEnd = false;
      c.pts.forEach(function (p) {
        domX.min = Math.min(domX.min, p.x); domX.max = Math.max(domX.max, p.x);
        domY.min = Math.min(domY.min, p.y); domY.max = Math.max(domY.max, p.y);
        if (p.x <= 0.01 && p.y <= 0.01) hasStart = true;
        if (p.x >= 0.99 && p.y >= 0.99) hasEnd = true;
      });
      // 诚信：AUC 只按给定点梯形积分；缺 (0,0)/(1,1) 端点时如实警告，
      // 不自动补点（补点会改变用户提供的曲线语义）。
      if (!(hasStart && hasEnd)) partialCoverage = true;
    });
    if (partialCoverage) {
      diagAttr(ctx, "data-warning", "auc-partial-coverage");
      diagAttr(ctx, "data-auc-note", "AUC 仅按给定点积分，曲线未覆盖 [0,1]");
    }
    padDomain(domX, 0.03, 0.03); padDomain(domY, 0.03, 0.03);
    var xr = axisRangeOf(ctx, "x"), yr = axisRangeOf(ctx, "y");
    domX = applyAxisRange(domX, xr); domY = applyAxisRange(domY, yr);
    var xTicks = rangeTicks(domX, xr, 5), yTicks = rangeTicks(domY, yr, 5);
    var legendItems = curves.map(function (c, gi) {
      if (gIdx < 0) return null;
      var k = stableSeriesKey("group", ctx.mapping.group, c.key);
      var s = effSeriesStyle(ctx, k, gi);
      return { label: c.key + "（AUC=" + c.auc.toFixed(3) + "）", kind: "line", key: k, color: s.stroke };
    }).filter(function (x) { return !!x; });
    // 单组 roc：图例项只剩 AUC 数值——单项图例会被 R10 抑制规则吃掉，
    // 改为绘图区内标注，保证「AUC 按给定点梯形积分」的方法说明始终可见。
    var aucNote = null;
    if (gIdx < 0) {
      legendItems = [];
      aucNote = "AUC=" + curves[0].auc.toFixed(3) + "（按给定点梯形积分）";
    }
    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: legendItems });
    var sx = linScale(domX.min, domX.max, fr.x0, fr.x0 + fr.pw);
    var sy = linScale(domY.min, domY.max, plotDataBottom(fr), fr.y0);
    noteXScale(ctx, sx);
    var u = ctx.dpi / 72;
    var clipR = plotClipRect(ctx, fr);
    var parts = [clipOpenTag(ctx)];
    // 对角参考线 y=x
    var c0 = clipR ? clipSegRect(sx(0), sy(0), sx(1), sy(1), clipR) : null;
    if (c0) parts.push(lineEl(c0[0], c0[1], c0[2], c0[3], "#9AA5B1",
      ' stroke-width="' + px(0.8 * u) + '" stroke-dasharray="' + (3 * u) + ' ' + (2 * u) + '" data-chart-part="diagonal"'));
    curves.forEach(function (c) {
      var key = gIdx >= 0 ? stableSeriesKey("group", ctx.mapping.group, c.key)
        : stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y);
      var sty = effSeriesStyle(ctx, key, c.gi % Math.max(1, ctx.palette.length));
      var d = "";
      c.pts.forEach(function (p, pi) {
        var pxv = sx(p.x), pyv = sy(p.y);
        noteClip(ctx, p.x, p.y, true);
        d += (pi ? " L" : "M") + px(pxv) + " " + px(pyv);
        if (clipR && inRectPx(pxv, pyv, clipR, 2 * u)) {
          parts.push(circleEl(pxv, pyv, 1.4 * u, sty.stroke,
            ' data-chart-part="point" data-series-key="' + esc(key) + '" data-row="' + p.row + '"'));
        }
      });
      // 折线本身按 clipSegRect 逐段裁剪太繁——ROC 点在 [0,1]² 内，整体画
      parts.push('<path d="' + d + '" fill="none" stroke="' + sty.stroke + '" stroke-width="' +
        px(1.2 * u) + '" data-chart-part="roc-curve" data-series-key="' + esc(key) +
        '" data-auc="' + c.auc.toFixed(4) + '"/>');
    });
    parts.push(clipCloseTag(ctx));
    if (aucNote) {
      parts.push(text(fr.x0 + 5 * u, fr.y0 + fr.tickF * 1.15, aucNote, {
        anchor: "start", size: fr.tickF * 0.85, fill: "#374151", weight: "600",
        part: "auc-note"
      }));
    }
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks.filter(function (v) { var p = sx(v); return p >= fr.x0 - 1 && p <= fr.x0 + fr.pw + 1; })
        .map(function (v) { return { px: sx(v), label: fmtNum(v) }; }),
      yTicks: yTicks.filter(function (v) { var p = sy(v); return p >= fr.y0 - 1 && p <= plotDataBottom(fr) + 1; })
        .map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  // ---- pca：用户提供的坐标列（不做 PCA）；可选 95% 协方差置信椭圆 ----
  RENDERS.pca = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var gIdx = colIndex(ctx, "group");
    var pts = [];
    var groups = {}, gOrder = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var xv = toNum(row[idx.x]), yv = toNum(row[idx.y]);
      if (isNaN(xv) || isNaN(yv)) continue;
      var gl = gIdx >= 0 ? catLabel(row[gIdx]) : null;
      if (gIdx >= 0 && gl === null) continue;
      var gkey = (gIdx >= 0 && gl !== null) ? gl : "";
      if (gIdx >= 0 && !groups[gkey]) { groups[gkey] = []; gOrder.push(gkey); }
      var p = { x: xv, y: yv, row: i, g: gkey };
      pts.push(p);
      if (gIdx >= 0) groups[gkey].push(p);
    }
    if (!pts.length) throw new Error("renderChartSVG：pca 没有可绘制的点（x/y 须为用户提供的坐标数值列）");
    diagAttr(ctx, "data-method", "user-provided-coords-no-pca-in-renderer");

    var presPlot = presOf(ctx.chartSpec) && presOf(ctx.chartSpec).plot;
    var wantEllipse = !!(presPlot && presPlot.ellipse === true);
    if (wantEllipse) diagAttr(ctx, "data-ellipse", "cov95-chi2-5.991");

    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var domX = valueDomain(xs, false), domY = valueDomain(ys, false);
    padDomain(domX, 0.05, 0.05); padDomain(domY, 0.05, 0.05);
    var xr = axisRangeOf(ctx, "x"), yr = axisRangeOf(ctx, "y");
    domX = applyAxisRange(domX, xr); domY = applyAxisRange(domY, yr);
    var xTicks = rangeTicks(domX, xr, 5), yTicks = rangeTicks(domY, yr, 5);
    var legendItems = [];
    if (gIdx >= 0) {
      gOrder.forEach(function (g, gi) {
        var k = stableSeriesKey("group", ctx.mapping.group, g);
        var s = effSeriesStyle(ctx, k, gi);
        legendItems.push({ label: g, kind: "marker", key: k, color: s.stroke });
      });
    }
    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: legendItems });
    var sx = linScale(domX.min, domX.max, fr.x0, fr.x0 + fr.pw);
    var sy = linScale(domY.min, domY.max, plotDataBottom(fr), fr.y0);
    noteXScale(ctx, sx);
    var u = ctx.dpi / 72;
    var clipR = plotClipRect(ctx, fr);
    var parts = [clipOpenTag(ctx)];

    // 95% 协方差椭圆：样本协方差矩阵特征分解，半轴 = sqrt(χ²₂(0.95)=5.991 × λ)，
    // 数据空间参数化后经 x/y 比例尺分别变换；64 边形近似经数学裁剪到绘图区
    // （导出路径不依赖 clip-path），rx/ry/angle（数据单位）写进属性供核对。
    function ellipsePath(cxD, cyD, covXX, covXY, covYY) {
      var tr = covXX + covYY, det = covXX * covYY - covXY * covXY;
      var disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      var l1 = tr / 2 + disc, l2 = tr / 2 - disc;
      if (!(l1 > 0) || !(l2 > 0)) return null;
      var ang = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
      var rx = Math.sqrt(5.991 * l1), ry = Math.sqrt(5.991 * l2);
      var cosA = Math.cos(ang), sinA = Math.sin(ang);
      var poly = [];
      for (var k = 0; k < 64; k++) {
        var t = k / 64 * 2 * Math.PI;
        var ex = rx * Math.cos(t), ey = ry * Math.sin(t);
        poly.push({
          x: sx(cxD + ex * cosA - ey * sinA),
          y: sy(cyD + ex * sinA + ey * cosA)
        });
      }
      var cp = clipPolyRect(poly, plotClipRect(ctx, fr));
      if (!cp || cp.length < 3) return null;
      var d = "M" + cp.map(function (q) { return px(q.x) + " " + px(q.y); }).join(" L") + " Z";
      return { d: d, rx: rx, ry: ry, ang: ang };
    }
    function ellipseAttrs(e) {
      return ' data-ellipse-rx="' + (+e.rx.toFixed(5)) + '" data-ellipse-ry="' +
        (+e.ry.toFixed(5)) + '" data-ellipse-angle="' + (+e.ang.toFixed(5)) + '"';
    }
    if (wantEllipse && gIdx >= 0) {
      gOrder.forEach(function (g, gi) {
        var gp = groups[g];
        if (gp.length < 3) return;
        var mx = 0, my = 0;
        gp.forEach(function (p) { mx += p.x; my += p.y; });
        mx /= gp.length; my /= gp.length;
        var sxx = 0, syy = 0, sxy = 0;
        gp.forEach(function (p) {
          var dx = p.x - mx, dy = p.y - my;
          sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
        });
        var n1 = gp.length - 1;
        var key = stableSeriesKey("group", ctx.mapping.group, g);
        var sty = effSeriesStyle(ctx, key, gi);
        var e = ellipsePath(mx, my, sxx / n1, sxy / n1, syy / n1);
        if (e) parts.push('<path d="' + e.d + '" fill="' + sty.stroke + '" fill-opacity="0.08" stroke="' +
          sty.stroke + '" stroke-width="' + px(0.8 * u) + '" data-chart-part="ellipse95" data-series-key="' +
          esc(key) + '"' + ellipseAttrs(e) + '/>');
      });
    } else if (wantEllipse && gIdx < 0 && pts.length >= 3) {
      var mx2 = 0, my2 = 0;
      pts.forEach(function (p) { mx2 += p.x; my2 += p.y; });
      mx2 /= pts.length; my2 /= pts.length;
      var axx = 0, ayy = 0, axy = 0;
      pts.forEach(function (p) {
        var dx = p.x - mx2, dy = p.y - my2;
        axx += dx * dx; ayy += dy * dy; axy += dx * dy;
      });
      var nn = pts.length - 1;
      var sty0 = effSeriesStyle(ctx, stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y), 0);
      var e0 = ellipsePath(mx2, my2, axx / nn, axy / nn, ayy / nn);
      if (e0) parts.push('<path d="' + e0.d + '" fill="' + sty0.stroke + '" fill-opacity="0.08" stroke="' +
        sty0.stroke + '" stroke-width="' + px(0.8 * u) + '" data-chart-part="ellipse95"' +
        ellipseAttrs(e0) + '/>');
    }
    pts.forEach(function (p) {
      var pxv = sx(p.x), pyv = sy(p.y);
      noteClip(ctx, p.x, p.y, true);
      if (clipR && !inRectPx(pxv, pyv, clipR, 2 * u)) return;
      var key = gIdx >= 0 ? stableSeriesKey("group", ctx.mapping.group, p.g)
        : stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y);
      var gi = gIdx >= 0 ? gOrder.indexOf(p.g) : 0;
      var sty = effSeriesStyle(ctx, key, Math.max(0, gi) % Math.max(1, ctx.palette.length));
      var mk = mkPointKey(p.row, p.x, p.y, p.g || null);
      var ms = effMarkStyle(ctx, {
        kind: "point", seriesKey: key, pointKey: mk,
        defFill: sty.stroke, defMarker: "circle", defDiaPt: STYLE_DEFAULTS.scatterDiaPt
      });
      if (ms.marker === "none") return;
      parts.push(markerShapeEl(pxv, pyv, ms.sizePt * u / 2, ms.fill,
        ' data-chart-part="series" data-series-key="' + esc(key) + '" data-point-key="' + esc(mk) +
        '" data-row="' + p.row + '"', ms.marker));
    });
    parts.push(clipCloseTag(ctx));
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks.filter(function (v) { var p = sx(v); return p >= fr.x0 - 1 && p <= fr.x0 + fr.pw + 1; })
        .map(function (v) { return { px: sx(v), label: fmtNum(v) }; }),
      yTicks: yTicks.filter(function (v) { var p = sy(v); return p >= fr.y0 - 1 && p <= plotDataBottom(fr) + 1; })
        .map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  // ---- venn：mapping.ys = 2–3 个成员标记列（0/1 或 true/false），固定大小圆 ----
  RENDERS.venn = function (ctx) {
    var ys = Array.isArray(ctx.mapping && ctx.mapping.ys)
      ? ctx.mapping.ys.filter(function (n) { return typeof n === "string" && n !== ""; }) : [];
    if (ys.length < 2) {
      throw new Error("renderChartSVG：venn 需要 mapping.ys 提供 2–3 个成员标记列（0/1 或 true/false）");
    }
    if (ys.length > 3) {
      throw new Error("renderChartSVG：venn 最多支持 3 个集合（当前 " + ys.length + " 列）；更多集合请改用 UpSet 类图");
    }
    var yIdxs = ys.map(function (n) {
      var ci = ctx.columns.indexOf(n);
      if (ci < 0) throw new Error("renderChartSVG：mapping.ys 引用的列「" + n + "」不存在");
      return ci;
    });
    diagAttr(ctx, "data-method", "venn-region-counts");
    diagAttr(ctx, "data-scale", "fixed-circle-size-not-area-proportional");

    function truthy(v) {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      var s = String(v).trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "y";
    }
    var k = ys.length;
    var regionCount = {};
    var total = 0;
    for (var i = 0; i < ctx.rows.length; i++) {
      var mask = 0, any = false;
      for (var j = 0; j < k; j++) {
        if (truthy(ctx.rows[i][yIdxs[j]])) { mask |= (1 << j); any = true; }
      }
      if (!any) continue; // 不属于任何集合的行不计入区域（仍计入总行）
      total++;
      regionCount[mask] = (regionCount[mask] || 0) + 1;
    }
    if (!total) throw new Error("renderChartSVG：venn 没有可绘制的数据行（成员标记列全为假值）");
    diagAttr(ctx, "data-members", total);

    var fr = cartesianFrame(ctx, { yTickLabels: [], legend: [] });
    var u = ctx.dpi / 72;
    var f = fr.tickF;
    var cx = fr.x0 + fr.pw / 2;
    // 三角布局上下不对称（顶圆心 cy-0.62R、底圆心 cy+0.36R）：布局中心下移
    // 0.13R 使外延对称为 ±1.49R；半径同时受顶部集合标签净空、画布边界与
    // 左右越界约束，否则圆与标签会画出画布（导出无 clip-path）。
    var k3 = k === 3;
    var halfPh = fr.ph / 2;
    var padTopNeed = 6 * u + f * 0.95 + 4;
    var rTop = (halfPh - padTopNeed) / (k3 ? 1.49 : 1.0);
    var rBot = (halfPh - 2 * u) / (k3 ? 1.49 : 1.0);
    var rX = fr.pw / (k === 2 ? 3.1 : 3.2);
    var R = Math.max(20 * u, Math.min(rTop, rBot, rX, Math.min(fr.pw, fr.ph) * 0.42));
    var cy = fr.y0 + halfPh + (k3 ? 0.13 * R : 0);
    // 经典布局：2 集左右相交；3 集三角
    var centers;
    if (k === 2) {
      centers = [[cx - R * 0.55, cy], [cx + R * 0.55, cy]];
    } else {
      centers = [[cx, cy - R * 0.62], [cx - R * 0.6, cy + R * 0.36], [cx + R * 0.6, cy + R * 0.36]];
    }
    var parts = [];
    var f = fr.tickF;
    // 区域计数标签位置（按位掩码的代表点：各圆心按 mask 均值）
    var regionPos = {};
    for (var mask = 1; mask < (1 << k); mask++) {
      var mx = 0, my = 0, cnt = 0;
      for (var j2 = 0; j2 < k; j2++) {
        if (mask & (1 << j2)) { mx += centers[j2][0]; my += centers[j2][1]; cnt++; }
      }
      regionPos[mask] = [mx / cnt, my / cnt];
    }
    // 画圆（后画的覆盖前面的透明叠加，重叠区自然加深）
    for (j = k - 1; j >= 0; j--) {
      var key = stableSeriesKey("series", ys[j], ys[j]);
      var sty = effSeriesStyle(ctx, key, j % Math.max(1, ctx.palette.length));
      parts.push(circleEl(centers[j][0], centers[j][1], R, sty.stroke,
        ' fill-opacity="0.22" stroke="' + sty.stroke + '" stroke-width="' + px(1.0 * u) +
        '" data-chart-part="venn-set" data-set="' + esc(ys[j]) + '" data-series-key="' + esc(key) + '"'));
    }
    // 集合名标签：2 集放各圆上方；3 集沿「布局中心→圆心」径向外置
    // （顶圆在上、底两圆斜下外），避免标签落进三圆重叠区。
    for (j = 0; j < k; j++) {
      var lx, ly;
      if (k3) {
        var ddx = centers[j][0] - cx, ddy = centers[j][1] - cy;
        var dl = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        lx = centers[j][0] + ddx / dl * (R + 8 * u);
        ly = centers[j][1] + ddy / dl * (R + 8 * u) + f * 0.35;
      } else {
        lx = centers[j][0]; ly = centers[j][1] - R - 6 * u;
      }
      parts.push(text(lx, ly, ys[j], {
        anchor: "middle", size: f * 1.15, fill: "#111827", weight: "700",
        part: "venn-label"
      }));
    }
    // 区域计数
    for (mask = 1; mask < (1 << k); mask++) {
      var c = regionCount[mask] || 0;
      var rp = regionPos[mask];
      parts.push(text(rp[0], rp[1] + f * 0.35, String(c), {
        anchor: "middle", size: f * 1.3, fill: "#111827", weight: "700",
        part: "venn-count"
      }));
    }
    parts.push(text(cx, cy + (k3 ? 1.36 : 1.0) * R + 12 * u,
      "n=" + total + "（圆大小固定，不按面积成比例）", {
        anchor: "middle", size: f * 0.85, fill: "#6B7280", part: "venn-note"
      }));
    return wrap(ctx, parts);
  };

  // ---- sankey：x 源 / y 目标 / size 权重；节点按 DAG 层级；≤30 节点 ----
  RENDERS.sankey = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var sizeIdx = colIndex(ctx, "size");
    var links = [];
    var nodeMap = {}, nodeOrder = [];
    function nodeOf(name) {
      if (!nodeMap[name]) {
        nodeMap[name] = { name: name, out: [], inn: [], layer: -1 };
        nodeOrder.push(name);
      }
      return nodeMap[name];
    }
    var totalW = 0;
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var s = catLabel(row[idx.x]), t = catLabel(row[idx.y]);
      if (s === null || t === null || s === t) continue;
      var w = 1;
      if (sizeIdx >= 0) { var wv = toNum(row[sizeIdx]); if (!isNaN(wv) && wv > 0) w = wv; }
      var a = nodeOf(s), b = nodeOf(t);
      var lk = { s: a, t: b, w: w, row: i };
      a.out.push(lk); b.inn.push(lk);
      links.push(lk); totalW += w;
    }
    if (!links.length) throw new Error("renderChartSVG：sankey 没有可绘制的连线（x 源、y 目标须为类别值）");
    if (nodeOrder.length > 30) {
      throw new Error("renderChartSVG：sankey 节点数 " + nodeOrder.length + " > 30，图会不可读，请先合并类别");
    }
    diagAttr(ctx, "data-method", "sankey-dag-layers-bezier");
    diagAttr(ctx, "data-nodes", nodeOrder.length);
    diagAttr(ctx, "data-links", links.length);

    // 层级：最长路径（拓扑序）；环上节点回退到出现顺序层
    var indeg = {};
    nodeOrder.forEach(function (n) { indeg[n] = nodeMap[n].inn.length; });
    var queue = nodeOrder.filter(function (n) { return indeg[n] === 0; });
    var topo = [];
    while (queue.length) {
      var n0 = queue.shift();
      topo.push(n0);
      nodeMap[n0].out.forEach(function (lk) {
        var tn = lk.t.name;
        if (--indeg[tn] === 0) queue.push(tn);
      });
    }
    // 环处理：未入拓扑序的节点按出现顺序追加，层级取已定层级最大值+1
    var maxLayer = 0;
    topo.forEach(function (n) {
      var preds = nodeMap[n].inn.map(function (lk) { return lk.s; });
      var L = 0;
      preds.forEach(function (p) { if (p.layer >= 0 && p.layer + 1 > L) L = p.layer + 1; });
      nodeMap[n].layer = L;
      if (L > maxLayer) maxLayer = L;
    });
    nodeOrder.forEach(function (n, ni) {
      if (nodeMap[n].layer < 0) nodeMap[n].layer = Math.min(maxLayer + 1, ni % (maxLayer + 2));
    });
    var nLayers = 0;
    nodeOrder.forEach(function (n) { if (nodeMap[n].layer + 1 > nLayers) nLayers = nodeMap[n].layer + 1; });

    // 布局：x 按层等分；y 按节点流量（in+out 的 max）在层内堆叠。
    // 节点标签画在条外侧（末列向右），先按最长标签宽预留 extraRight。
    var u = ctx.dpi / 72;
    var fEst = tickFontPx(ctx) * 0.9;
    var maxLabW = 0;
    nodeOrder.forEach(function (n) {
      var w = textW(n, fEst) + 6 * u;
      if (w > maxLabW) maxLabW = w;
    });
    var fr = cartesianFrame(ctx, { yTickLabels: [], legend: [], extraRight: maxLabW });
    var nodeW = Math.min(fr.pw * 0.04, 14 * u);
    var layerX = function (L) {
      if (nLayers <= 1) return fr.x0 + fr.pw / 2 - nodeW / 2;
      return fr.x0 + (L + 0.5) * fr.pw / nLayers - nodeW / 2;
    };
    var layerNodes = {};
    nodeOrder.forEach(function (n) {
      var L = nodeMap[n].layer;
      (layerNodes[L] = layerNodes[L] || []).push(n);
    });
    var maxFlow = 1;
    nodeOrder.forEach(function (n) {
      var f = 0;
      nodeMap[n].out.forEach(function (lk) { f += lk.w; });
      nodeMap[n].inn.forEach(function (lk) { f += lk.w; });
      if (f > maxFlow) maxFlow = f;
    });
    // 节点流量 = (入+出)/2；高度按全局统一比例（不是逐层铺满），
    // 最高流量层占绘图区约 82%，其余层相应变矮并垂直居中——
    // 逐层各自铺满会让所有列都顶到顶底、流带被挤成一片看不见。
    function nodeFlow(nm) {
      var f = 0;
      nodeMap[nm].out.forEach(function (lk) { f += lk.w; });
      nodeMap[nm].inn.forEach(function (lk) { f += lk.w; });
      return Math.max(f / 2, 1e-9);
    }
    var layerTotals = {};
    Object.keys(layerNodes).forEach(function (L) {
      var t = 0;
      layerNodes[L].forEach(function (n) { t += nodeFlow(n); });
      layerTotals[L] = t;
    });
    var maxLayerTotal = 1e-9;
    Object.keys(layerTotals).forEach(function (L) {
      if (layerTotals[L] > maxLayerTotal) maxLayerTotal = layerTotals[L];
    });
    var gap = 6 * u;
    var gScale = (fr.ph * 0.82) / maxLayerTotal;
    var layout = {};
    Object.keys(layerNodes).forEach(function (L) {
      // 层内节点按流量（入+出）降序堆叠，大流量在上
      var nodes = layerNodes[L].slice().sort(function (a, b) {
        return nodeFlow(b) - nodeFlow(a);
      });
      var hs = nodes.map(function (n) { return Math.max(2 * u, nodeFlow(n) * gScale); });
      var layerH = hs.reduce(function (a, b) { return a + b; }, 0) + gap * (nodes.length - 1);
      var y = fr.y0 + Math.max(0, (fr.ph - layerH) / 2);
      nodes.forEach(function (n, ni2) {
        layout[n] = { x: layerX(Number(L)), y: y, w: nodeW, h: hs[ni2], layer: Number(L) };
        y += hs[ni2] + gap;
      });
    });
    // 端口排序：出/入连线按对端节点纵向中心排序后再分配槽位，减少流带交叉
    nodeOrder.forEach(function (n) {
      function cyOf(nm) { var d = layout[nm]; return d ? d.y + d.h / 2 : 0; }
      nodeMap[n].out.sort(function (a, b) { return cyOf(a.t.name) - cyOf(b.t.name); });
      nodeMap[n].inn.sort(function (a, b) { return cyOf(a.s.name) - cyOf(b.s.name); });
    });
    // 每节点出/入连线的纵向槽位分配（按排序后顺序累计）
    nodeOrder.forEach(function (n) {
      var nd = layout[n];
      var acc = 0;
      nodeMap[n].out.forEach(function (lk) {
        var slotH = nd.h * (lk.w / (nd._outSum || (nd._outSum = nodeMap[n].out.reduce(function (a, b) { return a + b.w; }, 0))));
        lk._y1 = nd.y + acc; lk._h1 = slotH; acc += slotH;
      });
      acc = 0;
      nodeMap[n].inn.forEach(function (lk) {
        var slotH = nd.h * (lk.w / (nd._inSum || (nd._inSum = nodeMap[n].inn.reduce(function (a, b) { return a + b.w; }, 0))));
        lk._y2 = nd.y + acc; lk._h2 = slotH; acc += slotH;
      });
    });
    var maxLinkW = 0;
    links.forEach(function (lk) { if (lk.w > maxLinkW) maxLinkW = lk.w; });
    var parts = [];
    var clipR = { x0: fr.x0, y0: fr.y0, x1: fr.x0 + fr.pw, y1: fr.y0 + fr.ph };
    links.forEach(function (lk) {
      var a = layout[lk.s.name], b = layout[lk.t.name];
      var wpx = Math.max(0.8 * u, (lk.w / maxLinkW) * Math.min(a.h, b.h) * 0.8);
      var y1a = lk._y1, y1b = lk._y1 + lk._h1;
      var y2a = lk._y2, y2b = lk._y2 + lk._h2;
      var x1 = a.x + a.w, x2 = b.x;
      var dx = Math.max(6 * u, (x2 - x1) * 0.45);
      var key = stableSeriesKey("series", lk.s.name, lk.s.name);
      var sty = effSeriesStyle(ctx, key, nodeOrder.indexOf(lk.s.name) % Math.max(1, ctx.palette.length));
      var d = "M" + px(x1) + " " + px(y1a) +
        " C" + px(x1 + dx) + " " + px(y1a) + " " + px(x2 - dx) + " " + px(y2a) + " " + px(x2) + " " + px(y2a) +
        " L" + px(x2) + " " + px(y2b) +
        " C" + px(x2 - dx) + " " + px(y2b) + " " + px(x1 + dx) + " " + px(y1b) + " " + px(x1) + " " + px(y1b) + " Z";
      parts.push('<path d="' + d + '" fill="' + sty.stroke + '" fill-opacity="0.3" stroke="none"' +
        ' data-chart-part="flow" data-row="' + lk.row + '" data-weight="' + lk.w + '"/>');
    });
    // 已放置标签的 bbox（标签互不重叠约束；右置标签还需避开节点条）
    var placedLabs = [];
    function labClash(x0, y0, x1, y1) {
      for (var q = 0; q < placedLabs.length; q++) {
        var b = placedLabs[q];
        if (x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0) return true;
      }
      return false;
    }
    nodeOrder.forEach(function (n) {
      var nd = layout[n];
      var key = stableSeriesKey("series", n, n);
      var sty = effSeriesStyle(ctx, key, nodeOrder.indexOf(n) % Math.max(1, ctx.palette.length));
      parts.push(rectEl(nd.x, nd.y, nd.w, nd.h, sty.stroke,
        ' data-chart-part="node" data-node="' + esc(n) + '" data-layer="' + nd.layer +
        '" data-series-key="' + esc(key) + '"'));
      // 标签在节点条外侧：首列（无入边）在条左；其余在条右、白底衬底防压流带。
      // 首列放不下时退回右侧白底。右置标签伸进下一列时避让节点条与已放标签。
      var fS = f2(fr) * 0.88;
      var ly = nd.y + nd.h / 2 + fS * 0.35;
      var labW = textW(n, fS);
      var labY0 = function (cy2) { return cy2 - fS * 0.95; };
      var labY1 = function (cy2) { return cy2 + fS * 0.35; };
      function labelRight() {
        var tx = nd.x + nd.w + 3 * u;
        var lx0 = tx - u, lx1 = tx + labW + u;
        var bars = [];
        nodeOrder.forEach(function (nm2) {
          var b = layout[nm2];
          if (b && lx0 < b.x + b.w && lx1 > b.x) bars.push(b);
        });
        var hitBar = function (yy0, yy1) {
          for (var bi = 0; bi < bars.length; bi++) {
            var b = bars[bi];
            if (yy0 < b.y + b.h && yy1 > b.y) return true;
          }
          return false;
        };
        var okAt = function (cy2) {
          var a = labY0(cy2), b = labY1(cy2);
          return a >= 2 && b <= ctx.H - 2 && !hitBar(a, b) && !labClash(lx0, a, lx1, b);
        };
        var cands = [ly];
        bars.forEach(function (b) {
          cands.push(b.y - fS * 0.55, b.y + b.h + fS * 1.05);
        });
        placedLabs.forEach(function (b) {
          if (lx0 < b.x1 && lx1 > b.x0) cands.push(b.y0 - fS * 0.4, b.y1 + fS * 0.4);
        });
        var best = ly, bestD = 1e18, found = okAt(ly);
        if (!found) {
          cands.forEach(function (c2) {
            var d = Math.abs(c2 - ly);
            if (d < bestD && okAt(c2)) { bestD = d; best = c2; found = true; }
          });
        }
        ly = best;
        placedLabs.push({ x0: lx0, y0: labY0(ly), x1: lx1, y1: labY1(ly) });
        parts.push(rectEl(tx - u, ly - fS * 0.95, labW + 2 * u, fS * 1.3, "#FFFFFF",
          ' data-chart-part="node-label-bg"'));
        parts.push(text(tx, ly, n, {
          anchor: "start", size: fS, fill: "#111827", weight: "600", part: "node-label"
        }));
      }
      if (!nodeMap[n].inn.length && nd.x - fr.x0 - 3 * u >= labW + u) {
        // 左置标签：仅与已放标签避让（左侧无后续列节点条）
        var lx0 = nd.x - 3 * u - labW - u, lx1 = nd.x - 3 * u;
        var tries = [ly, ly - fS * 1.4, ly + fS * 1.4, ly - fS * 2.8, ly + fS * 2.8];
        for (var ti = 0; ti < tries.length; ti++) {
          var t2 = tries[ti];
          if (!labClash(lx0, labY0(t2), lx1, labY1(t2))) { ly = t2; break; }
        }
        placedLabs.push({ x0: lx0, y0: labY0(ly), x1: lx1, y1: labY1(ly) });
        parts.push(text(nd.x - 3 * u, ly, n, {
          anchor: "end", size: fS, fill: "#111827", weight: "600", part: "node-label"
        }));
      } else {
        labelRight();
      }
    });
    return wrap(ctx, parts);
  };

  function f2(fr) { return fr.tickF; }

  // ---- taylor：x=标准差 / y=相关系数 / group=模型；四分之一极坐标 ----
  RENDERS.taylor = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var gIdx = colIndex(ctx, "group");
    var pts = [];
    var groups = {}, gOrder = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i];
      var sd = toNum(row[idx.x]), r = toNum(row[idx.y]);
      if (isNaN(sd) || isNaN(r) || sd < 0 || r < -1 || r > 1) continue;
      var gl = gIdx >= 0 ? catLabel(row[gIdx]) : null;
      if (gIdx >= 0 && gl === null) continue;
      var gkey = (gIdx >= 0 && gl !== null) ? gl : "";
      if (gIdx >= 0 && !groups[gkey]) { groups[gkey] = []; gOrder.push(gkey); }
      var p = { sd: sd, r: r, row: i, g: gkey };
      pts.push(p);
      if (gIdx >= 0) groups[gkey].push(p);
    }
    if (!pts.length) throw new Error("renderChartSVG：taylor 没有可绘制的点（x=标准差≥0、y=相关系数∈[-1,1] 须为数值列）");
    diagAttr(ctx, "data-method", "taylor-polar");
    diagAttr(ctx, "data-coords", "radius=std/maxStd angle=acos(correlation)");

    var refStd = ctx.chartSpec && typeof ctx.chartSpec.reference_std === "number" &&
      isFinite(ctx.chartSpec.reference_std) && ctx.chartSpec.reference_std > 0
      ? ctx.chartSpec.reference_std : null;
    if (refStd === null) diagAttr(ctx, "data-warning", "no-reference-std");
    else diagAttr(ctx, "data-reference-std", refStd);

    var maxSd = 0;
    pts.forEach(function (p) { if (p.sd > maxSd) maxSd = p.sd; });
    if (refStd !== null && refStd > maxSd) maxSd = refStd;
    if (!(maxSd > 0)) maxSd = 1;

    var legendItems = [];
    if (gIdx >= 0) {
      gOrder.forEach(function (g, gi) {
        var k = stableSeriesKey("group", ctx.mapping.group, g);
        var s = effSeriesStyle(ctx, k, gi);
        legendItems.push({ label: g, kind: "marker", key: k, color: s.stroke });
      });
    }
    var fr = cartesianFrame(ctx, { yTickLabels: [], legend: legendItems, noCartesianPads: true });
    var u = ctx.dpi / 72;
    var f = fr.tickF;
    // 全非负相关用标准四分之一圆（r∈[0,1]→角∈[0,90°]，极区宽=高=R，
    // 能把绘图区填满）；出现负相关才退回半圆（r∈[-1,1]→角∈[0,180°]）。
    var hasNeg = pts.some(function (p) { return p.r < -1e-9; });
    var half = hasNeg;
    diagAttr(ctx, "data-polar-span", half ? "half-neg-corr" : "quarter-nonneg-corr");

    // 极区外延与边距：四分圆占 [cx,cx+R]×[cy-R,cy]；半圆占 [cx,cx+R]×[cy-R,cy+R]。
    // 左侧留旋转轴标题位，右侧留模型标签外伸，上/下留刻度与标签外溢。
    var labF = f * 0.85;
    var maxLabHalf = 0;
    gOrder.forEach(function (g) {
      var w = textW(g, labF) / 2;
      if (w > maxLabHalf) maxLabHalf = w;
    });
    var mLeft = f * 1.9, mRight = maxLabHalf + f * 1.0 + 3 * u;
    // 上/下边距从紧：四分圆高=R 是宽度瓶颈，mTop+mBottom 须 ≤ ph-0.8pw
    // 才能让极区宽度占绘图区 ≥80%；放不下的顶部标签由角向偏移消化。
    var mTop = f * 0.9, mBottom = f * 0.9;
    var availW = fr.pw - mLeft - mRight;
    var availH = fr.ph - mTop - mBottom;
    var R = Math.min(availW, half ? availH / 2 : availH);
    if (!(R > 30)) R = Math.max(24, Math.min(availW, availH) * 0.5);
    R = Math.max(R, 20 * u);
    var cx = fr.x0 + mLeft;
    var cy = half ? fr.y0 + fr.ph / 2 : fr.y0 + fr.ph - mBottom;
    diagAttr(ctx, "data-polar-rect",
      [cx, cy - R, cx + R, half ? cy + R : cy].map(function (v) { return +v.toFixed(2); }).join(","));
    diagAttr(ctx, "data-polar-w-frac", (R / fr.pw).toFixed(4));

    function pol(sdV, rV) {
      var rn = sdV / maxSd;
      var th = Math.acos(Math.max(-1, Math.min(1, rV)));
      return [cx + R * rn * Math.sin(th), cy - R * rn * Math.cos(th)];
    }
    var parts = [];
    var fixedBoxes = []; // 固定元素 bbox，供模型标签避让
    function fixedTB(x, yBase, w, fs2) { // anchor=middle 文本的近似 bbox
      fixedBoxes.push({ x0: x - w / 2, y0: yBase - fs2 * 0.85, x1: x + w / 2, y1: yBase + fs2 * 0.3 });
    }
    // r=1 径向轴（标准差方向，竖直）与 r=0 径向（右水平）+ 外弧边界
    parts.push(lineEl(cx, cy - R, cx, cy + (half ? R : 0), "#D1D5DB",
      ' stroke-width="' + px(0.6 * u) + '" data-chart-part="taylor-axis-std"'));
    parts.push(lineEl(cx, cy, cx + R, cy, "#D1D5DB",
      ' stroke-width="' + px(0.6 * u) + '" data-chart-part="taylor-axis-corr0"'));
    if (half) {
      parts.push('<path d="M' + px(cx) + ' ' + px(cy - R) +
        ' A' + px(R) + ' ' + px(R) + ' 0 0 1 ' + px(cx + R) + ' ' + px(cy) +
        ' A' + px(R) + ' ' + px(R) + ' 0 0 1 ' + px(cx) + ' ' + px(cy + R) +
        '" fill="none" stroke="#D1D5DB" stroke-width="' + px(0.6 * u) +
        '" data-chart-part="taylor-outer"/>');
    } else {
      parts.push('<path d="M' + px(cx) + ' ' + px(cy - R) +
        ' A' + px(R) + ' ' + px(R) + ' 0 0 1 ' + px(cx + R) + ' ' + px(cy) +
        '" fill="none" stroke="#D1D5DB" stroke-width="' + px(0.6 * u) +
        '" data-chart-part="taylor-outer"/>');
    }
    // 标准差弧：四分圆单段弧 / 半圆两段弧；标签放弧内 45° 斜线上
    var sdTicks = niceTicks(0, maxSd, 5);
    sdTicks.forEach(function (v) {
      if (!(v > 0)) return;
      var rr = R * (v / maxSd);
      var dArc;
      if (half) {
        dArc = "M" + px(cx) + " " + px(cy - rr) +
          " A" + px(rr) + " " + px(rr) + " 0 0 1 " + px(cx + rr) + " " + px(cy) +
          " A" + px(rr) + " " + px(rr) + " 0 0 1 " + px(cx) + " " + px(cy + rr);
      } else {
        dArc = "M" + px(cx) + " " + px(cy - rr) +
          " A" + px(rr) + " " + px(rr) + " 0 0 1 " + px(cx + rr) + " " + px(cy);
      }
      parts.push('<path d="' + dArc + '" fill="none" stroke="#E5E7EB" stroke-width="' +
        px(0.5 * u) + '" data-chart-part="grid-std" data-std="' + v + '"/>');
      var lx = cx + rr * Math.SQRT1_2 * 0.72, ly = cy - rr * Math.SQRT1_2 * 0.72;
      var sv = fmtNum(v);
      parts.push(text(lx, ly + f * 0.3, sv, {
        anchor: "middle", size: f * 0.8, fill: "#6B7280", part: "std-tick"
      }));
      fixedTB(lx, ly + f * 0.3, textW(sv, f * 0.8), f * 0.8);
    });
    // 相关系数刻度：弧内径向短线 + 标签在 R-14u 圈上；
    // 全非负只标 [1,.75,.5,.25,0]，半圆标 [1,.5,0,-.5,-1]
    var corrLblR = R - 14 * u;
    var corrSet = half ? [1, 0.5, 0, -0.5, -1] : [1, 0.75, 0.5, 0.25, 0];
    corrSet.forEach(function (rv) {
      var th = Math.acos(rv);
      var sTh = Math.sin(th), cTh = Math.cos(th);
      parts.push(lineEl(cx + (R - 4 * u) * sTh, cy - (R - 4 * u) * cTh,
        cx + (R - 0.5 * u) * sTh, cy - (R - 0.5 * u) * cTh, "#9CA3AF",
        ' stroke-width="' + px(0.6 * u) + '" data-chart-part="corr-tick"'));
      var lx = cx + corrLblR * sTh, ly = cy - corrLblR * cTh + f * 0.3;
      var sv = String(rv);
      parts.push(text(lx, ly, sv, {
        anchor: "middle", size: f * 0.85, fill: "#374151", weight: "600", part: "corr-tick-label"
      }));
      fixedTB(lx, ly, textW(sv, f * 0.85), f * 0.85);
    });
    // 参考点（reference_std 在相关系数=1 方向，即竖直径向）
    if (refStd !== null) {
      var rp = pol(refStd, 1);
      parts.push(circleEl(rp[0], rp[1], 2.6 * u, "#111827",
        ' data-chart-part="reference" data-reference-std="' + refStd + '"'));
      var rlx = rp[0] + 4 * u, rly = rp[1] + f * 0.3;
      var rlt = "参考 " + fmtNum(refStd);
      var rlw = textW(rlt, f * 0.85);
      parts.push(text(rlx, rly, rlt, {
        anchor: "start", size: f * 0.85, fill: "#111827", weight: "600", part: "reference-label"
      }));
      fixedBoxes.push({ x0: rlx, y0: rly - f * 0.85 * 0.85, x1: rlx + rlw, y1: rly + f * 0.3 });
    }
    // 数据点 + 模型标签候选（沿数据点径向外侧）
    var labItems = [];
    pts.forEach(function (p) {
      var rp2 = pol(p.sd, p.r);
      var key = gIdx >= 0 ? stableSeriesKey("group", ctx.mapping.group, p.g)
        : stableSeriesKey("series", ctx.mapping.y, ctx.mapping.y);
      var gi = gIdx >= 0 ? gOrder.indexOf(p.g) : 0;
      var sty = effSeriesStyle(ctx, key, Math.max(0, gi) % Math.max(1, ctx.palette.length));
      parts.push(circleEl(rp2[0], rp2[1], 2.2 * u, sty.stroke,
        ' data-chart-part="series" data-series-key="' + esc(key) + '" data-row="' + p.row +
        '" data-sd="' + p.sd + '" data-r="' + p.r + '"'));
      if (gIdx >= 0 && p.g) {
        labItems.push({
          px: rp2[0], py: rp2[1],
          th: Math.acos(Math.max(-1, Math.min(1, p.r))),
          rn: p.sd / maxSd, g: p.g, key: key
        });
      }
    });
    // 轴标题（先登记避让盒）：标准差沿竖直轴左侧旋转；
    // 相关系数——四分圆放 r=0 水平轴下方，半圆放左侧竖排。
    if (half) {
      parts.push(text(cx - f * 0.95, cy - R * 0.32, "标准差", {
        anchor: "middle", size: f * 0.9, fill: "#111827", weight: "600",
        part: "axis-title-radial",
        transform: "rotate(-90 " + px(cx - f * 0.95) + " " + px(cy - R * 0.32) + ")"
      }));
      parts.push(text(cx - f * 0.95, cy + R * 0.32, "相关系数", {
        anchor: "middle", size: f * 0.9, fill: "#6B7280", part: "axis-title-angular",
        transform: "rotate(-90 " + px(cx - f * 0.95) + " " + px(cy + R * 0.32) + ")"
      }));
      fixedBoxes.push({ x0: cx - f * 1.6, y0: cy - R * 0.32 - 45, x1: cx - f * 0.3, y1: cy - R * 0.32 + 45 });
      fixedBoxes.push({ x0: cx - f * 1.6, y0: cy + R * 0.32 - 50, x1: cx - f * 0.3, y1: cy + R * 0.32 + 50 });
    } else {
      parts.push(text(cx - f * 0.95, cy - R * 0.45, "标准差", {
        anchor: "middle", size: f * 0.9, fill: "#111827", weight: "600",
        part: "axis-title-radial",
        transform: "rotate(-90 " + px(cx - f * 0.95) + " " + px(cy - R * 0.45) + ")"
      }));
      var ctw = textW("相关系数", f * 0.9);
      parts.push(text(cx + R * 0.55, cy + f * 0.7, "相关系数", {
        anchor: "middle", size: f * 0.9, fill: "#6B7280", part: "axis-title-angular"
      }));
      fixedBoxes.push({ x0: cx - f * 1.6, y0: cy - R * 0.45 - 45, x1: cx - f * 0.3, y1: cy - R * 0.45 + 45 });
      fixedBoxes.push({ x0: cx + R * 0.55 - ctw / 2, y0: cy + f * 0.7 - f * 0.9,
        x1: cx + R * 0.55 + ctw / 2, y1: cy + f * 0.7 + f * 0.35 });
    }
    // 模型标签贪心避让：候选 = 径向外侧原位 + 角向/径向偏移序列；
    // 偏移成功画细引线连回数据点，全部失败退回原位（仍在画布内）。
    var placed = fixedBoxes.slice();
    var OFFS = [[0, 0], [0.12, 0], [-0.12, 0], [0.12, 1], [-0.12, 1],
                [0.25, 0], [-0.25, 0], [0.25, 1], [-0.25, 1],
                [0.4, 1], [-0.4, 1], [0, 2], [0.55, 2], [-0.55, 2], [0, 3]];
    labItems.sort(function (a, b) { return a.th - b.th || b.rn - a.rn; });
    labItems.forEach(function (c) {
      var w = textW(c.g, labF), h = labF * 1.2;
      var chosen = null, chosenOff = null;
      for (var oi = 0; oi < OFFS.length && !chosen; oi++) {
        var dA = OFFS[oi][0], dR = OFFS[oi][1];
        var lr = c.rn * R + f * 1.3 + dR * f * 1.4;
        var lx = cx + lr * Math.sin(c.th + dA);
        var ly = cy - lr * Math.cos(c.th + dA) + f * 0.35;
        var x0 = lx - w / 2, x1 = lx + w / 2;
        var y0 = ly - h * 0.8, y1 = ly + h * 0.3;
        if (x0 < fr.x0 + 1 || x1 > fr.x0 + fr.pw - 1 ||
            y0 < fr.y0 + 1 || y1 > fr.y0 + fr.ph - 1) continue;
        var clash = false;
        for (var bi = 0; bi < placed.length; bi++) {
          var b = placed[bi];
          if (x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0) { clash = true; break; }
        }
        if (!clash) { chosen = { lx: lx, ly: ly }; chosenOff = OFFS[oi]; }
      }
      if (!chosen) {
        var lr2 = c.rn * R + f * 1.3;
        chosen = { lx: cx + lr2 * Math.sin(c.th), ly: cy - lr2 * Math.cos(c.th) + f * 0.35 };
        chosenOff = [0, 0];
      }
      if (chosenOff[0] !== 0 || chosenOff[1] !== 0) {
        parts.push(lineEl(c.px, c.py, chosen.lx, chosen.ly - f * 0.2, "#9CA3AF",
          ' stroke-width="' + px(0.5 * u) + '" data-chart-part="model-leader"'));
      }
      var gi2 = Math.max(0, gOrder.indexOf(c.g)) % Math.max(1, ctx.palette.length);
      parts.push(text(chosen.lx, chosen.ly, c.g, {
        anchor: "middle", size: labF, fill: "#111827", weight: "600",
        part: "model-label", seriesKey: c.key
      }));
      placed.push({ x0: chosen.lx - w / 2, y0: chosen.ly - h * 0.8,
                    x1: chosen.lx + w / 2, y1: chosen.ly + h * 0.3 });
    });
    parts.push(drawLegend(ctx, fr));
    return wrap(ctx, parts);
  };

  /* ====================================================================
   * renderableRows — row-level draw/exclude census for the data wizard.
   *
   * G07：向导的「被排除行数」必须与渲染器实际绘制的行一致（例如全日期 x
   * 会被 prepareXY 解析成时间轴而不是被当作非数值排除）。这里直接复用
   * 渲染器自身的 prep/筛选原语（prepareXY / catLabel / toNum），逐图型
   * 镜像各 RENDERS 入口的行接受条件；line 系直接调用 prepareXY 本体。
   * mapping 为 {role: 列名}；返回 {total, drawn, excluded, reasons}，
   * 必填映射缺失或映射列不存在时 drawn/excluded 为 null 并在 reasons
   * 说明原因（与渲染器抛错前的状态一致，不臆造数字）。
   * ==================================================================== */

  // required mapping roles per chart type — mirrors the requireCols()
  // calls inside each RENDERS entry; keep in sync when renderers change.
  var RENDERABLE_ROLES = {
    bar: ["x", "y"],
    bar_grouped: ["x", "y", "group"],
    line: ["x", "y"],
    line_multi: ["x", "y", "group"],
    area: ["x", "y"],
    scatter: ["x", "y"],
    pie: ["x", "y"],
    histogram: ["x"],
    heatmap: ["x", "y", "color"],
    box: ["x", "y"],
    // R10 补图型（venn 用 mapping.ys 多列，在 renderableRows 内单独处理）
    bar_stacked: ["x", "y", "group"],
    violin: ["x", "y"],
    dotplot: ["x", "y"],
    paired: ["x", "y", "group"],
    marginal: ["x", "y"],
    volcano: ["x", "y"],
    forest: ["x", "y"],
    survival: ["x", "y"],
    roc: ["x", "y"],
    pca: ["x", "y"],
    sankey: ["x", "y"],
    taylor: ["x", "y"]
  };

  function renderableRows(chartType, data, mapping) {
    var out = { total: 0, drawn: null, excluded: null, reasons: [] };
    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
      out.reasons.push("data 需要 {columns, rows} 数组");
      return out;
    }
    out.total = data.rows.length;
    var type = typeof chartType === "string" ? chartType : "";
    if (!supportsChartType(type)) {
      out.reasons.push("未知图表类型：" + (chartType || ""));
      return out;
    }
    var roles = RENDERABLE_ROLES[type];
    // R10：venn 用 mapping.ys（2–3 个成员标记列）而非单列角色，单独统计
    if (type === "venn") {
      var vys = Array.isArray(mapping.ys)
        ? mapping.ys.filter(function (n) { return typeof n === "string" && n !== ""; }) : [];
      if (vys.length < 2) {
        out.reasons.push("venn 需要 mapping.ys 提供 2–3 个成员标记列");
        return out;
      }
      if (vys.length > 3) {
        out.reasons.push("venn 最多支持 3 个集合（当前 " + vys.length + " 列）");
        return out;
      }
      var vidx = [];
      for (var vi = 0; vi < vys.length; vi++) {
        var vci = data.columns.indexOf(vys[vi]);
        if (vci < 0) {
          out.reasons.push("映射列「" + vys[vi] + "」不存在于数据");
          return out;
        }
        vidx.push(vci);
      }
      function vennTruthy(v) {
        if (typeof v === "boolean") return v;
        if (typeof v === "number") return v !== 0;
        var s = String(v).trim().toLowerCase();
        return s === "1" || s === "true" || s === "yes" || s === "y";
      }
      var vdrawn = 0;
      for (var vr = 0; vr < data.rows.length; vr++) {
        var vrow = data.rows[vr], vany = false;
        for (var vj = 0; vj < vidx.length; vj++) {
          if (vennTruthy(vrow ? vrow[vidx[vj]] : null)) { vany = true; break; }
        }
        if (vany) vdrawn++;
      }
      out.drawn = vdrawn;
      out.excluded = out.total - vdrawn;
      return out;
    }
    // R10：paired 只画覆盖全部条件的个体——先求完整个体集合再数行
    if (type === "paired") {
      var needRoles = ["x", "y", "group"];
      var pidx = {};
      for (var pr = 0; pr < needRoles.length; pr++) {
        var prName = mapping[needRoles[pr]];
        if (typeof prName !== "string" || prName === "") {
          out.reasons.push("缺少映射槽：" + needRoles[pr]);
          return out;
        }
        var pci = data.columns.indexOf(prName);
        if (pci < 0) {
          out.reasons.push("映射列「" + prName + "」不存在于数据");
          return out;
        }
        pidx[needRoles[pr]] = pci;
      }
      var condSeen = {}, subjConds = {};
      var validRows = [];
      for (var pi = 0; pi < data.rows.length; pi++) {
        var prow = data.rows[pi];
        var pcl = catLabel(prow && prow[pidx.x]);
        var pyv = toNum(prow && prow[pidx.y]);
        var pgl = catLabel(prow && prow[pidx.group]);
        if (pcl === null || isNaN(pyv) || pgl === null) continue;
        if (condSeen[pcl] === undefined) condSeen[pcl] = 1; else condSeen[pcl]++;
        if (!subjConds[pgl]) subjConds[pgl] = {};
        subjConds[pgl][pcl] = true;
        validRows.push(pi);
      }
      var nConds = Object.keys(condSeen).length;
      var complete = {};
      Object.keys(subjConds).forEach(function (g) {
        if (Object.keys(subjConds[g]).length >= nConds) complete[g] = true;
      });
      var pdrawn = 0;
      for (var pv = 0; pv < data.rows.length; pv++) {
        var pvRow = data.rows[pv];
        var pvCl = catLabel(pvRow && pvRow[pidx.x]);
        var pvY = toNum(pvRow && pvRow[pidx.y]);
        var pvG = catLabel(pvRow && pvRow[pidx.group]);
        if (pvCl === null || isNaN(pvY) || pvG === null) continue;
        if (complete[pvG]) pdrawn++;
      }
      out.drawn = pdrawn;
      out.excluded = out.total - pdrawn;
      return out;
    }
    if (!roles) {
      out.reasons.push("图表类型「" + type + "」暂无行数统计");
      return out;
    }
    mapping = (mapping && typeof mapping === "object") ? mapping : {};
    // R4-HB：宽表 mapping.ys——x + 每个 ys 列；行可绘制 = x 有效且至少一列 y 为数值
    var wideYsR = (type === "line_multi" || type === "scatter") &&
      Array.isArray(mapping.ys)
      ? mapping.ys.filter(function (n) { return typeof n === "string" && n !== ""; })
      : null;
    if (wideYsR && wideYsR.length >= 2) {
      var xNameR = mapping.x;
      if (typeof xNameR !== "string" || xNameR === "") {
        out.reasons.push("缺少映射槽：x");
        return out;
      }
      var xiR = data.columns.indexOf(xNameR);
      if (xiR < 0) {
        out.reasons.push("映射列「" + xNameR + "」不存在于数据");
        return out;
      }
      var yIdxsR = [];
      for (var wiR = 0; wiR < wideYsR.length; wiR++) {
        var yiR = data.columns.indexOf(wideYsR[wiR]);
        if (yiR < 0) {
          out.reasons.push("映射列「" + wideYsR[wiR] + "」不存在于数据");
          return out;
        }
        yIdxsR.push(yiR);
      }
      var rowsR = data.rows, drawnR = 0;
      for (var rwR = 0; rwR < rowsR.length; rwR++) {
        var rowR = rowsR[rwR];
        var xvR = rowR ? rowR[xiR] : null;
        var xokR = type === "scatter"
          ? !isNaN(toNum(xvR))
          : (xvR !== null && xvR !== undefined && xvR !== "");
        if (!xokR) continue;
        for (var wjR = 0; wjR < yIdxsR.length; wjR++) {
          if (!isNaN(toNum(rowR ? rowR[yIdxsR[wjR]] : null))) { drawnR++; break; }
        }
      }
      out.drawn = drawnR;
      out.excluded = out.total - drawnR;
      return out;
    }
    var idx = {};
    for (var i = 0; i < roles.length; i++) {
      var role = roles[i];
      var name = mapping[role];
      if (typeof name !== "string" || name === "") {
        out.reasons.push("缺少映射槽：" + role);
        return out;
      }
      var ci = data.columns.indexOf(name);
      if (ci < 0) {
        out.reasons.push("映射列「" + name + "」不存在于数据");
        return out;
      }
      idx[role] = ci;
    }
    // scatter 额外读取可选 color 列：colIndex 对不存在的映射列会抛错，
    // 这里如实报原因而不是静默忽略。
    if (type === "scatter" && typeof mapping.color === "string" && mapping.color !== "") {
      var cci = data.columns.indexOf(mapping.color);
      if (cci < 0) {
        out.reasons.push("映射列「" + mapping.color + "」不存在于数据");
        return out;
      }
      idx.color = cci;
    }
    // R10：新图型的可选映射列——已映射但列不存在时报原因（与渲染器抛错一致）
    var R10_OPTIONAL = {
      dotplot: ["size", "color"], volcano: ["label"],
      forest: ["error", "lo", "hi", "size"],
      survival: ["group"], roc: ["group"], pca: ["group"],
      sankey: ["size"], taylor: ["group"]
    };
    var optRoles = R10_OPTIONAL[type] || [];
    for (var oi = 0; oi < optRoles.length; oi++) {
      var oname = mapping[optRoles[oi]];
      if (typeof oname === "string" && oname !== "" && data.columns.indexOf(oname) < 0) {
        out.reasons.push("映射列「" + oname + "」不存在于数据");
        return out;
      }
    }
    // 可选 group 列的行接受条件（survival/roc/pca/taylor：映射了 group 时
    // 空 group 行与渲染器一致被排除）
    var optGroupIdx = -1;
    if ((type === "survival" || type === "roc" || type === "pca" || type === "taylor") &&
        typeof mapping.group === "string" && mapping.group !== "") {
      optGroupIdx = data.columns.indexOf(mapping.group);
    }

    var rows = data.rows;
    var drawn = 0;
    if (type === "line" || type === "line_multi" || type === "area") {
      // 直接复用渲染器自己的 prepareXY：空值、非数值 y、空 group 标签
      // 的跳过规则与 x 的 time/num/cat 判定完全一致。
      var prep = prepareXY({ rows: rows }, idx.x, idx.y,
        type === "line_multi" ? idx.group : null);
      drawn = prep.points.length;
    } else {
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var ok = true;
        if (type === "bar" || type === "pie" || type === "box") {
          // collectCategories / box 同一条件：catLabel(x) 非空且 y 为数值
          ok = catLabel(row && row[idx.x]) !== null &&
               !isNaN(toNum(row && row[idx.y]));
        } else if (type === "bar_grouped") {
          ok = catLabel(row && row[idx.x]) !== null &&
               catLabel(row && row[idx.group]) !== null &&
               !isNaN(toNum(row && row[idx.y]));
        } else if (type === "heatmap") {
          ok = catLabel(row && row[idx.x]) !== null &&
               catLabel(row && row[idx.y]) !== null &&
               !isNaN(toNum(row && row[idx.color]));
        } else if (type === "histogram") {
          ok = !isNaN(toNum(row && row[idx.x]));
        } else if (type === "scatter") {
          ok = !isNaN(toNum(row && row[idx.x])) &&
               !isNaN(toNum(row && row[idx.y]));
          if (ok && idx.color !== undefined) {
            ok = catLabel(row && row[idx.color]) !== null;
          }
        } else if (type === "bar_stacked") {
          ok = catLabel(row && row[idx.x]) !== null &&
               catLabel(row && row[idx.group]) !== null &&
               !isNaN(toNum(row && row[idx.y]));
        } else if (type === "violin") {
          ok = catLabel(row && row[idx.x]) !== null &&
               !isNaN(toNum(row && row[idx.y]));
        } else if (type === "dotplot") {
          ok = !isNaN(toNum(row && row[idx.x])) &&
               catLabel(row && row[idx.y]) !== null;
        } else if (type === "marginal" || type === "volcano" || type === "roc") {
          ok = !isNaN(toNum(row && row[idx.x])) &&
               !isNaN(toNum(row && row[idx.y]));
          if (ok && optGroupIdx >= 0 && (type === "roc")) {
            ok = catLabel(row && row[optGroupIdx]) !== null;
          }
        } else if (type === "pca") {
          ok = !isNaN(toNum(row && row[idx.x])) &&
               !isNaN(toNum(row && row[idx.y]));
          if (ok && optGroupIdx >= 0) {
            ok = catLabel(row && row[optGroupIdx]) !== null;
          }
        } else if (type === "taylor") {
          var tx = toNum(row && row[idx.x]), ty = toNum(row && row[idx.y]);
          ok = !isNaN(tx) && tx >= 0 && !isNaN(ty) && ty >= -1 && ty <= 1;
          if (ok && optGroupIdx >= 0) {
            ok = catLabel(row && row[optGroupIdx]) !== null;
          }
        } else if (type === "forest") {
          ok = catLabel(row && row[idx.y]) !== null &&
               !isNaN(toNum(row && row[idx.x]));
        } else if (type === "survival") {
          ok = !isNaN(toNum(row && row[idx.x]));
          if (ok && optGroupIdx >= 0) {
            ok = catLabel(row && row[optGroupIdx]) !== null;
          }
        } else if (type === "sankey") {
          var sxv = catLabel(row && row[idx.x]), sxv2 = catLabel(row && row[idx.y]);
          ok = sxv !== null && sxv2 !== null && sxv !== sxv2;
        }
        if (ok) drawn++;
      }
    }
    out.drawn = drawn;
    out.excluded = out.total - drawn;
    return out;
  }

  /* ====================================================================
   * duplicateXStats — 折线/面积图“同一条线同一横轴多个点”（折返）统计。
   * 复用渲染器自己的 prepareXY/groupPoints，与 renderableRows 的行接受
   * 规则一致；只提示，不改映射。仅对 line / line_multi / area 有意义。
   * ==================================================================== */

  // splitColumns 只收“像分组列”的候选：全同值（无法区分）或近乎逐行唯一
  // （如误差/数值列，拆开等于每点一条线）都不算可用的合并分组列。
  var SPLIT_MAX_DISTINCT = 24;

  function dupXVerifySplit(points, rows, candColIdx) {
    // 把候选列值并入现有分组键后，要求每个（子系列, 归一化 x）至多 1 点。
    var bySeries = {};
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var row = rows[p.source_row];
      var cv = catLabel(row ? row[candColIdx] : null);
      var g = (p.g === null || p.g === undefined) ? "" : String(p.g);
      var key = g + "\u0001" + (cv === null ? "\u0001" : cv);
      (bySeries[key] = bySeries[key] || []).push(p);
    }
    for (var k in bySeries) {
      var byX = {};
      var pts = bySeries[k];
      for (var j = 0; j < pts.length; j++) {
        var xk = String(pts[j].x);
        byX[xk] = (byX[xk] || 0) + 1;
        if (byX[xk] > 1) return false;
      }
    }
    return true;
  }

  function duplicateXStats(chartType, data, mapping) {
    var type = typeof chartType === "string" ? chartType : "";
    if (type !== "line" && type !== "line_multi" && type !== "area") {
      return { applicable: false };
    }
    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
      return { applicable: false };
    }
    mapping = (mapping && typeof mapping === "object") ? mapping : {};
    var rows = data.rows;
    var seriesArr = null, prepPoints = null, usedColIdx = null;
    // R4-HB：宽表 line_multi（mapping.ys）——每列一条系列，与渲染同源
    var wideYsD = (type === "line_multi" && Array.isArray(mapping.ys))
      ? mapping.ys.filter(function (n) { return typeof n === "string" && n !== ""; })
      : null;
    if (wideYsD && wideYsD.length >= 2) {
      var xiW = typeof mapping.x === "string" ? data.columns.indexOf(mapping.x) : -1;
      if (xiW < 0) return { applicable: false };
      var prepW = prepareWideSeries({ columns: data.columns, rows: rows }, xiW, wideYsD);
      seriesArr = prepW.series;
      prepPoints = prepW.points;
      usedColIdx = {};
      usedColIdx[xiW] = true;
      for (var wci = 0; wci < wideYsD.length; wci++) {
        var wcii = data.columns.indexOf(wideYsD[wci]);
        if (wcii >= 0) usedColIdx[wcii] = true;
      }
    } else {
      var roles = RENDERABLE_ROLES[type];
      var idx = {};
      for (var i = 0; i < roles.length; i++) {
        var role = roles[i];
        var name = mapping[role];
        if (typeof name !== "string" || name === "") return { applicable: false };
        var ci = data.columns.indexOf(name);
        if (ci < 0) return { applicable: false };
        idx[role] = ci;
      }
      var groupIdx = (type === "line_multi" && idx.group !== undefined) ? idx.group : null;
      var prep = prepareXY({ rows: rows }, idx.x, idx.y, groupIdx);
      seriesArr = groupPoints(prep.points, "g");
      prepPoints = prep.points;
      usedColIdx = {};
      for (var ri = 0; ri < roles.length; ri++) usedColIdx[idx[roles[ri]]] = true;
    }

    var dupX = 0, dupPoints = 0, maxPerX = 0;
    for (var s = 0; s < seriesArr.length; s++) {
      var byX = {};
      var pts = seriesArr[s].points;
      for (var j = 0; j < pts.length; j++) {
        var xk = String(pts[j].x);
        (byX[xk] = byX[xk] || []).push(pts[j]);
      }
      for (var xk2 in byX) {
        var cnt = byX[xk2].length;
        if (cnt > 1) {
          dupX++;
          dupPoints += cnt;
          if (cnt > maxPerX) maxPerX = cnt;
        }
      }
    }

    var splitColumns = [];
    if (dupX > 0) {
      for (var c = 0; c < data.columns.length && splitColumns.length < 3; c++) {
        if (usedColIdx[c]) continue;
        var distinct = {};
        for (var rr = 0; rr < rows.length; rr++) {
          var v = catLabel(rows[rr] ? rows[rr][c] : null);
          if (v !== null) distinct[v] = true;
        }
        var dc = 0;
        for (var dv in distinct) dc++;
        if (dc < 2 || dc > SPLIT_MAX_DISTINCT) continue;
        if (dupXVerifySplit(prepPoints, rows, c)) {
          splitColumns.push(data.columns[c]);
        }
      }
    }

    return {
      applicable: true,
      series: seriesArr.length,
      dupX: dupX,
      dupPoints: dupPoints,
      maxPerX: maxPerX,
      splitColumns: splitColumns
    };
  }

  /* ====================================================================
   * Chart/template capability (the RENDERS registry is the only source)
   * ==================================================================== */

  function supportsChartType(type) {
    return typeof type === "string" && typeof RENDERS[type] === "function";
  }

  function supportedChartTypes() {
    return Object.keys(RENDERS).filter(function (type) {
      return typeof RENDERS[type] === "function";
    });
  }

  function fallbackTemplateCapability(template) {
    var chartType = typeof template.chart_type === "string" && template.chart_type
      ? template.chart_type : null;
    var status = template.category === "composite" && chartType === null ? "layout"
      : (template.category !== "diagram" && supportsChartType(chartType) ? "full" : "unsupported");
    return {
      template_id: template.id || null,
      chart_type: chartType,
      status: status,
      label: status === "full" ? "本地可生成" : (status === "layout" ? "仅空版式" : "仅示意 · 不可应用"),
      can_generate: status === "full",
      can_apply: status !== "unsupported",
      requires_data: status === "full",
      can_preview: true,
      reason: status === "full"
        ? "chartType " + chartType + " 已有本地实际 SVG 渲染器；无数据时只生成未绑定数据的空骨架"
        : status === "layout"
          ? "只创建空白复合版式，不自动填图、不绑定或伪造数据"
          : "chartType " + (chartType || "(未声明)") + " 当前没有本地实际 SVG 渲染器，只供示意预览，禁止应用"
    };
  }

  function templateCapability(template) {
    if (global.FigPresets && typeof global.FigPresets.templateCapability === "function") {
      return global.FigPresets.templateCapability(template);
    }
    if (typeof template === "string" && global.FigPresets &&
        typeof global.FigPresets.template === "function") {
      template = global.FigPresets.template(template);
    }
    if (!template || typeof template !== "object" || Array.isArray(template)) {
      throw new Error("templateCapability：需要模板对象或已加载的 template_id");
    }
    return fallbackTemplateCapability(template);
  }

  function decorateTemplate(template) {
    var out = Object.assign({}, template);
    out.capability = templateCapability(template);
    return out;
  }

  function templateCapabilities(templates) {
    if (templates === undefined && global.FigPresets &&
        typeof global.FigPresets.templates === "function") {
      templates = global.FigPresets.templates();
    }
    if (!Array.isArray(templates)) throw new Error("templateCapabilities：templates 必须是数组");
    return templates.map(decorateTemplate);
  }

  function installTemplateCapabilities() {
    var presets = global.FigPresets;
    if (!presets || presets.__figDataCapabilities === true ||
        typeof presets.templateCapability === "function") return;
    var baseTemplates = typeof presets.templates === "function" ? presets.templates : null;
    var baseTemplate = typeof presets.template === "function" ? presets.template : null;
    var baseRecommend = typeof presets.recommend === "function" ? presets.recommend : null;
    var baseBuild = typeof presets.templateFromStats === "function" ? presets.templateFromStats : null;
    if (baseTemplates) presets.templates = function (opts) {
      return baseTemplates.call(presets, opts).map(decorateTemplate);
    };
    if (baseTemplate) presets.template = function (id) {
      var template = baseTemplate.call(presets, id);
      return template ? decorateTemplate(template) : null;
    };
    if (baseRecommend) presets.recommend = function (columnStats, opts) {
      return baseRecommend.call(presets, columnStats, opts).map(function (rec) {
        var out = Object.assign({}, rec);
        var template = baseTemplate ? baseTemplate.call(presets, rec.template_id) : null;
        out.capability = template ? templateCapability(template) : null;
        return out;
      }).filter(function (rec) {
        return rec.capability && rec.capability.can_apply;
      });
    };
    if (baseBuild) presets.templateFromStats = function (templateId, data, opts) {
      var template = baseTemplate ? baseTemplate.call(presets, templateId) : null;
      if (!template) throw new Error("templateFromStats：未找到模板：" + templateId);
      var cap = templateCapability(template);
      if (!cap.can_apply) {
        throw UnsupportedChartError(cap.chart_type, null,
          "模板「" + (template.name || templateId) + "」（" + templateId + "）：" + cap.reason);
      }
      var built = baseBuild.call(presets, templateId, data, opts);
      if (cap.status === "layout") built.warnings = [cap.reason].concat(built.warnings || []);
      return built;
    };
    Object.defineProperty(presets, "__figDataCapabilities", {
      value: true, enumerable: false, configurable: false
    });
  }

  /* ====================================================================
   * renderChartSVG — entry point
   * ==================================================================== */

  function unsupportedPreviewFragment(chartType, width_mm, height_mm, dpi) {
    var W = width_mm * dpi / 25.4;
    var H = height_mm * dpi / 25.4;
    var f = fontPx(9, dpi);
    var u = dpi / 72;
    var parts = [
      rectEl(0, 0, W, H, "#FFF8E8", ' stroke="#A05A00" stroke-width="' + px(0.75 * u) + '"'),
      rectEl(2, 2, W - 4, H - 4, "none", ' stroke="#CC9900" stroke-width="' + px(0.75 * u) +
        '" stroke-dasharray="' + dashPt("3 2.25", u) + '"'),
      text(W / 2, H / 2 - f * 1.2, "暂不支持真实生成 · 仅示意", { anchor: "middle", size: f, fill: "#8A4B00" }),
      text(W / 2, H / 2 + f * 0.2, "chartType: " + chartType, { anchor: "middle", size: f * 0.85, fill: "#8A4B00" }),
      text(W / 2, H / 2 + f * 1.4, "禁止应用与成功导出", { anchor: "middle", size: f * 0.8, fill: "#8A4B00" })
    ];
    return '<g data-chart-type="' + esc(chartType) +
      '" data-render="unsupported-preview" data-real-data="false">' + parts.join("") + "</g>";
  }

  function positiveNumberOption(opts, name, fallback) {
    var value = opts[name] === undefined ? fallback : opts[name];
    if (typeof value !== "number" || !isFinite(value) || !(value > 0)) {
      throw new Error("renderChartSVG：" + name + " 必须是有限正数，实际为 " + String(value));
    }
    return value;
  }

  // 克隆 chartSpec 仅替换 presentation.legend.position（浅拷贝，不改原对象）。
  function specWithLegendPos(chartSpec, pos) {
    var pres = (chartSpec.presentation && typeof chartSpec.presentation === "object")
      ? chartSpec.presentation : {};
    var leg = (pres.legend && typeof pres.legend === "object" && !Array.isArray(pres.legend))
      ? pres.legend : {};
    var pres2 = Object.assign({}, pres, {
      legend: Object.assign({}, leg, { position: pos })
    });
    return Object.assign({}, chartSpec, { presentation: pres2 });
  }

  function renderChartSVG(chartSpec, opts) {
    opts = opts || {};
    if (!chartSpec || typeof chartSpec !== "object" || Array.isArray(chartSpec) ||
        typeof chartSpec.chartType !== "string" || !chartSpec.chartType) {
      throw new Error("renderChartSVG：chartSpec 须为包含非空 chartType 的对象");
    }
    var type = chartSpec.chartType;
    var width_mm = positiveNumberOption(opts, "width_mm", 120);
    var height_mm = positiveNumberOption(opts, "height_mm", 90);
    var dpi = positiveNumberOption(opts, "dpi", 300);

    if (!supportsChartType(type)) {
      throw UnsupportedChartError(type, unsupportedPreviewFragment(type, width_mm, height_mm, dpi));
    }

    var W = width_mm * dpi / 25.4;
    var H = height_mm * dpi / 25.4;
    var data = chartSpec.data;
    if (!data || !data.inline || !Array.isArray(data.inline.columns) || !Array.isArray(data.inline.rows)) {
      throw new Error("renderChartSVG：图表类型「" + type +
        "」缺少 chart.data.inline 内联数据（ref 外部引用暂不支持）");
    }
    assertTable(data.inline, "renderChartSVG");
    var columns = data.inline.columns;
    var rows = data.inline.rows;
    if (rows.length === 0) {
      throw new Error("renderChartSVG：图表类型「" + type + "」未绑定数据行，不能作为真实数据图渲染");
    }

    var ctx = {
      W: W,
      H: H,
      dpi: dpi,
      columns: columns,
      rows: rows,
      mapping: (chartSpec.mapping && typeof chartSpec.mapping === "object") ? chartSpec.mapping : {},
      axes: effectiveWideAxes(
        (chartSpec.axes && typeof chartSpec.axes === "object") ? chartSpec.axes : {},
        (chartSpec.mapping && typeof chartSpec.mapping === "object") ? chartSpec.mapping : {},
        type, !!chartSpec.characterization),
      fontFamily: typeof opts.fontFamily === "string" && opts.fontFamily.trim()
        ? opts.fontFamily : "Arial, sans-serif",
      fontSizePt: typeof opts.fontSizePt === "number" && isFinite(opts.fontSizePt) && opts.fontSizePt > 0
        ? opts.fontSizePt : 7,
      palette: resolvePalette(chartSpec.paletteId),
      chartSpec: chartSpec,
      compactMarks: opts.compactMarks === true
    };
    var svg;
    // R5 返工：legend.position="inside-best" 先用无避让的 inside-tl 探测渲染
    // 一次收集数据几何（ctx.__geom/__plotFrame），再按四角重叠挑出最优位置
    // 重渲染；全超阈值时解析为 right（此时帧计算会预留图例宽度）。
    // R6-E：色标占用右侧预留区时，right 图例会与色标重叠——改走
    // inside-best 避让；inside-best 兜底 right 再降级为 inside-tl，
    // 保证图例与色标永不争位。
    var cbOn = colorbarWanted(ctx);
    var wantBest = presLegendStyle(ctx).position === "inside-best" ||
      (cbOn && legendPos(ctx) === "right");
    if (wantBest) {
      var specProbe = specWithLegendPos(chartSpec, "inside-tl");
      var ctxProbe = Object.assign({}, ctx, { chartSpec: specProbe });
      RENDERS[type](ctxProbe);
      var resolvedPos = pickInsideLegend(ctxProbe, ctxProbe.__plotFrame);
      if (cbOn && resolvedPos === "right") resolvedPos = "inside-tl";
      var specEff = resolvedPos === "inside-tl" ? specProbe : specWithLegendPos(chartSpec, resolvedPos);
      var ctxEff = Object.assign({}, ctx, { chartSpec: specEff });
      svg = RENDERS[type](ctxEff);
      if (ctxEff.__compactHits) ctx.__compactHits = ctxEff.__compactHits;
      if (ctxEff.diagAttrs) ctx.diagAttrs = ctxEff.diagAttrs;
    } else {
      svg = RENDERS[type](ctx);
    }
    if (hitStore) {
      var sig = chartSignature(chartSpec);
      var hitKey = sig === null ? null : sig + "|" + chartHitKey({
        width_mm: width_mm, height_mm: height_mm, dpi: dpi,
        fontSizePt: ctx.fontSizePt, fontFamily: ctx.fontFamily
      }) + "|" + compactMarksThreshold();
      if (hitKey !== null) {
        if (ctx.__compactHits && ctx.__compactHits.length) {
          if (hitStore.size >= HIT_STORE_MAX) {
            hitStore.delete(hitStore.keys().next().value);
          }
          hitStore.set(hitKey, ctx.__compactHits);
        } else if (ctx.compactMarks === true) {
          // 仅 compact 渲染产出命中；非 compact 渲染（导出/预览）不清缓存，
          // 因为命中几何与渲染模式无关，同 key 的逐点渲染不应误删。
          hitStore.delete(hitKey);
        }
      }
    }
    return svg;
  }

  /* ====================================================================
   * getChartPoints — read-only data lineage for the real renderers above.
   * Values, row identifiers and render-time transformations are kept distinct;
   * no input rows or chart specifications are modified.
   * ==================================================================== */

  function lineageJSONValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (Array.isArray(v)) return v.map(lineageJSONValue);
    if (typeof v === "object") {
      var out = {};
      Object.keys(v).forEach(function (k) { out[k] = lineageJSONValue(v[k]); });
      return out;
    }
    return null;
  }

  function lineageRawPoint(ctx, sourceRow) {
    var row = ctx.rows[sourceRow];
    var values = {};
    var lineageStats = ctx.chartSpec && typeof ctx.chartSpec.statistics === "object"
      ? ctx.chartSpec.statistics : null;
    for (var i = 0; i < MAPPING_ROLES.length; i++) {
      var role = MAPPING_ROLES[i];
      var name = ctx.mapping[role];
      if (role === "error" && lineageStats && lineageStats.uncertainty_source === "column" &&
          typeof lineageStats.uncertainty_column === "string" && lineageStats.uncertainty_column) {
        name = lineageStats.uncertainty_column;
      }
      var ci = typeof name === "string" && name !== "" ? ctx.columns.indexOf(name) : -1;
      values[role] = ci >= 0 ? lineageJSONValue(row[ci]) : null;
    }
    var byColumn = {};
    for (var c = 0; c < ctx.columns.length; c++) byColumn[ctx.columns[c]] = lineageJSONValue(row[c]);
    var out = {
      source_row: sourceRow,
      row_index: sourceRow,
      row: lineageJSONValue(row),
      values: values,
      values_by_column: byColumn,
      x: values.x,
      y: values.y,
      group: values.group,
      color: values.color,
      error: values.error
    };
    return out;
  }

  function lineageSeriesKey(role, value) {
    return role === null ? "series:default" : "series:" + role + ":" + String(value);
  }

  function lineageSemanticKey(x, group) {
    return JSON.stringify({ x: x === undefined ? null : x, group: group === undefined ? null : group });
  }

  function lineageRawGlyph(ctx, sourceRow, x, y, group, role, kind, pointId) {
    var raw = lineageRawPoint(ctx, sourceRow);
    return {
      point_id: pointId,
      kind: kind,
      role: role || "raw",
      x: lineageJSONValue(x),
      y: lineageJSONValue(y),
      value: lineageJSONValue(y),
      raw_x: raw.x,
      raw_y: raw.y,
      rendered_value: lineageJSONValue(y),
      aggregate: null,
      count: 1,
      source_row: sourceRow,
      source_rows: [sourceRow],
      source_row_indices: [sourceRow],
      raw_values: [raw.y],
      raw_points: [raw],
      series_key: lineageSeriesKey(role === "raw" && ctx.mapping.group ? "group" :
        (role === "raw" && ctx.mapping.color ? "color" : null), group),
      series_label: group === null || group === undefined ? String(ctx.mapping.y || "series") : String(group),
      semantic_key: lineageSemanticKey(raw.x, group),
      transforms: { sort: { applied: false }, normalize: { mode: "none", scale: 1 }, offset: 0 }
    };
  }

  function lineageSeries(points) {
    var out = [], seen = {};
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var k = p.series_key;
      if (seen[k] === undefined) {
        seen[k] = out.length;
        out.push({
          series_key: k,
          semantic_key: k,
          label: p.series_label,
          kind: p.kind,
          role: p.role,
          points: [],
          point_ids: [],
          source_row_indices: [],
          endpoints: []
        });
      }
      var se = out[seen[k]];
      se.points.push(p);
      se.point_ids.push(p.point_id);
      for (var j = 0; j < p.source_rows.length; j++) {
        if (se.source_row_indices.indexOf(p.source_rows[j]) < 0) se.source_row_indices.push(p.source_rows[j]);
      }
    }
    for (i = 0; i < out.length; i++) {
      var s = out[i];
      if (s.points.length) {
        s.endpoints = [
          { position: "first", point_id: s.points[0].point_id, source_rows: s.points[0].source_rows.slice() },
          { position: "last", point_id: s.points[s.points.length - 1].point_id,
            source_rows: s.points[s.points.length - 1].source_rows.slice() }
        ];
      }
      delete s.points;
    }
    return out;
  }

  function getChartPoints(chartSpec) {
    if (!chartSpec || typeof chartSpec !== "object" || Array.isArray(chartSpec) ||
        typeof chartSpec.chartType !== "string" || !chartSpec.chartType) {
      throw new Error("getChartPoints：chartSpec 须为包含非空 chartType 的对象");
    }
    var type = chartSpec.chartType;
    var supported = ["bar", "bar_grouped", "line", "line_multi", "area", "scatter"];
    if (supported.indexOf(type) < 0) {
      throw new Error("getChartPoints：图表类型「" + type + "」暂无逐行 lineage 提取支持");
    }
    var data = chartSpec.data;
    if (!data || !data.inline || !Array.isArray(data.inline.columns) || !Array.isArray(data.inline.rows)) {
      throw new Error("getChartPoints：图表类型「" + type + "」缺少 chart.data.inline 内联数据");
    }
    assertTable(data.inline, "getChartPoints");
    var ctx = {
      columns: data.inline.columns,
      rows: data.inline.rows,
      mapping: (chartSpec.mapping && typeof chartSpec.mapping === "object" && !Array.isArray(chartSpec.mapping))
        ? chartSpec.mapping : {},
      chartSpec: chartSpec
    };
    var points = [], i, j, g, ci, roles;
    function add(p) {
      p.point_id = type + ":" + points.length + ":" + p.point_id;
      points.push(p);
      return p;
    }
    function aggregatePoint(category, group, sourceRows, value, role, pointId, idx) {
      var raws = sourceRows.map(function (r) { return lineageRawPoint(ctx, r); });
      var vals = sourceRows.map(function (r) { return toNum(ctx.rows[r][idx.y]); });
      return add({
        point_id: pointId,
        kind: "bar",
        role: "raw",
        x: category,
        y: value,
        value: value,
        raw_x: null,
        raw_y: null,
        rendered_value: value,
        aggregate: "mean",
        count: sourceRows.length,
        source_row: null,
        source_rows: sourceRows.slice(),
        source_row_indices: sourceRows.slice(),
        raw_values: vals,
        raw_points: raws,
        series_key: lineageSeriesKey(role, group),
        series_label: group === null ? String(ctx.mapping.y) : String(group),
        semantic_key: lineageSemanticKey(category, group),
        transforms: { sort: { applied: false }, normalize: { mode: "none", scale: 1 }, offset: 0 },
        uncertainty: lineageJSONValue(cellUncertainty(ctx.columns, ctx.rows, ctx.mapping,
          chartSpec.statistics || null, category, role === "group" ? group : null))
      });
    }
    function requireRenderable(kind) {
      if (!points.length) throw new Error("getChartPoints：" + kind + " 没有可绘制的数据点");
    }

    if (type === "bar" || type === "bar_grouped") {
      roles = type === "bar" ? ["x", "y"] : ["x", "y", "group"];
      var bi = requireCols(ctx, roles);
      var categories = [], groups = [], cells = {};
      for (i = 0; i < ctx.rows.length; i++) {
        var category = catLabel(ctx.rows[i][bi.x]);
        g = type === "bar" ? null : catLabel(ctx.rows[i][bi.group]);
        var by = toNum(ctx.rows[i][bi.y]);
        if (category === null || (type === "bar_grouped" && g === null) || isNaN(by)) continue;
        if (categories.indexOf(category) < 0) categories.push(category);
        if (type === "bar_grouped" && groups.indexOf(g) < 0) groups.push(g);
        var bk = lineageSemanticKey(category, g);
        if (!cells[bk]) cells[bk] = { rows: [], sum: 0 };
        cells[bk].rows.push(i);
        cells[bk].sum += by;
      }
      if (type === "bar") {
        var agg = collectCategories(ctx.rows, bi.x, bi.y, "mean");
        for (i = 0; i < agg.cats.length; i++) {
          var ak = lineageSemanticKey(agg.cats[i], null);
          aggregatePoint(agg.cats[i], null, cells[ak].rows, agg.vals[i], null, "category:" + i, bi);
        }
      } else {
        for (i = 0; i < categories.length; i++) {
          for (j = 0; j < groups.length; j++) {
            var gk = lineageSemanticKey(categories[i], groups[j]);
            if (cells[gk]) {
              aggregatePoint(categories[i], groups[j], cells[gk].rows,
                cells[gk].sum / cells[gk].rows.length, "group", "category:" + i + ":group:" + j, bi);
            }
          }
        }
      }
      requireRenderable(type);
    } else if ((type === "line" || type === "line_multi") && chartSpec.characterization) {
      var ch = normalizeCharacterization(chartSpec.characterization, ctx.columns);
      if (!ch.ok) throw new Error("getChartPoints：characterization 校验失败：" + ch.errors.join("；"));
      var char = ch.char;
      var li = requireCols(ctx, type === "line" ? ["x", "y"] : ["x", "y", "group"]);
      var rawSeries = [], curveSeries = [];
      function collectChar(rowsIdx, xIdx, yIdx) {
        var cp = [];
        for (var q = 0; q < rowsIdx.length; q++) {
          var sr = rowsIdx[q], xv = toNum(ctx.rows[sr][xIdx]), yv = toNum(ctx.rows[sr][yIdx]);
          if (isNaN(xv) || (char.x_scale === "log10" && xv <= 0) || isNaN(yv)) continue;
          var rp = lineageRawPoint(ctx, sr);
          cp.push({ x: xv, y: yv, source_row: sr, raw_x: rp.x, raw_y: rp.y, group: rp.group });
        }
        charSortSeries(cp, char);
        return cp;
      }
      if (type === "line") {
        rawSeries.push({ label: ctx.mapping.y, group: null, points: collectChar(ctx.rows.map(function (_r, n) { return n; }), li.x, li.y) });
      } else {
        var buckets = [], bseen = {};
        for (i = 0; i < ctx.rows.length; i++) {
          g = catLabel(ctx.rows[i][li.group]);
          if (g === null) continue;
          if (bseen[g] === undefined) { bseen[g] = buckets.length; buckets.push({ label: g, group: g, rows: [] }); }
          buckets[bseen[g]].rows.push(i);
        }
        for (i = 0; i < buckets.length; i++) {
          rawSeries.push({ label: buckets[i].label, group: buckets[i].group,
            points: collectChar(buckets[i].rows, li.x, li.y) });
        }
      }
      for (i = 0; i < char.curves.length; i++) {
        ci = ctx.columns.indexOf(char.curves[i].column);
        if (ci < 0) throw new Error("getChartPoints：characterization 曲线列不存在：" + char.curves[i].column);
        curveSeries.push({ label: char.curves[i].label || char.curves[i].column, group: null,
          role: char.curves[i].role, column: char.curves[i].column,
          points: collectChar(ctx.rows.map(function (_r, n) { return n; }), li.x, ci) });
      }
      var allCharSeries = rawSeries.concat(curveSeries), totalCharPoints = 0;
      for (i = 0; i < allCharSeries.length; i++) totalCharPoints += allCharSeries[i].points.length;
      if (!totalCharPoints) throw new Error("getChartPoints：characterization 没有可绘制的数据点");
      var singleMax = 0;
      if (rawSeries.length === 1) {
        for (i = 0; i < rawSeries[0].points.length; i++) singleMax = Math.max(singleMax, Math.abs(rawSeries[0].points[i].y));
      }
      for (i = 0; i < allCharSeries.length; i++) {
        var cs = allCharSeries[i], ownMax = 0;
        cs.role = cs.role || "raw";
        for (j = 0; j < cs.points.length; j++) ownMax = Math.max(ownMax, Math.abs(cs.points[j].y));
        var effMax = rawSeries.length === 1 ? singleMax : ownMax;
        var scale = char.normalize === "max_to_unity" && effMax > 0 ? 1 / effMax : 1;
        var shift = char.offset_each_series !== null && cs.role === "raw" ? i * char.offset_each_series : 0;
        for (j = 0; j < cs.points.length; j++) {
          var cpp = cs.points[j], isRawSeries = i < rawSeries.length;
          var rawGroup = isRawSeries && type === "line_multi" ? cs.group : null;
          var cpGlyph = lineageRawGlyph(ctx, cpp.source_row, cpp.raw_x, cpp.y, rawGroup,
            cs.role, cs.role + "_point", "series:" + i + ":point:" + j);
          cpGlyph.raw_y = cpp.y;
          cpGlyph.raw_values = [cpp.y];
          cpGlyph.source_columns = { x: ctx.mapping.x, y: cs.column || ctx.mapping.y,
            group: type === "line_multi" ? ctx.mapping.group : null };
          cpGlyph.series_key = cs.role === "raw" && type === "line_multi"
            ? lineageSeriesKey("group", cs.group) : (cs.role === "raw" ? "series:raw" : "series:" + cs.role + ":" + cs.label);
          cpGlyph.series_label = cs.label;
          cpGlyph.semantic_key = lineageSemanticKey(cpp.raw_x, rawGroup);
          cpGlyph.rendered_value = cpp.y * scale + shift;
          cpGlyph.rendered_x = char.x_scale === "log10" ? Math.log10(cpp.x) : cpp.x;
          cpGlyph.transforms = {
            sort: { applied: !charPreservesMeasurementOrder(char), by: "x" },
            normalize: { mode: char.normalize, scale: scale, raw_y: cpp.y, normalized_y: cpp.y * scale },
            offset: shift,
            x_scale: char.x_scale,
            x_reverse: char.x_reverse,
            fit: { role: cs.role, column: cs.column || null, source: char.fit_source || null,
              source_status: char.fit_source ? "user_declared" : "unknown" }
          };
          add(cpGlyph);
        }
      }
    } else if (type === "line" || type === "line_multi" || type === "area") {
      var xyRoles = type === "line_multi" ? ["x", "y", "group"] : ["x", "y"];
      var xi = requireCols(ctx, xyRoles), prep;
      if (type === "line_multi") prep = prepareXY(ctx, xi.x, xi.y, xi.group);
      else prep = prepareXY(ctx, xi.x, xi.y, null);
      for (i = 0; i < prep.points.length; i++) {
        var pp = prep.points[i], lp = lineageRawGlyph(ctx, pp.source_row, pp.x, pp.y, pp.g,
          "raw", type + "_point", "point:" + i);
        lp.series_key = lineageSeriesKey(type === "line_multi" ? "group" : null, pp.g);
        lp.series_label = pp.g === null ? String(ctx.mapping.y) : String(pp.g);
        lp.semantic_key = lineageSemanticKey(pp.raw_x, pp.g);
        lp.transforms = { sort: { applied: true, by: "x", mode: prep.mode },
          normalize: { mode: "none", scale: 1 }, offset: 0 };
        add(lp);
      }
      requireRenderable(type);
    } else if (type === "scatter") {
      var si = requireCols(ctx, ["x", "y"]);
      if (chartSpec.characterization) {
        var sc = normalizeCharacterization(chartSpec.characterization, ctx.columns);
        if (!sc.ok) throw new Error("getChartPoints：characterization 校验失败：" + sc.errors.join("；"));
      }
      ci = colIndex(ctx, "color");
      for (i = 0; i < ctx.rows.length; i++) {
        var sx = toNum(ctx.rows[i][si.x]), sy = toNum(ctx.rows[i][si.y]);
        if (isNaN(sx) || isNaN(sy)) continue;
        g = ci >= 0 ? catLabel(ctx.rows[i][ci]) : null;
        if (ci >= 0 && g === null) continue;
        var sp = lineageRawGlyph(ctx, i, sx, sy, g, "raw", "scatter_point", "point:" + i);
        sp.series_key = lineageSeriesKey(ci >= 0 ? "color" : null, g);
        sp.series_label = ci >= 0 ? String(g) : String(ctx.mapping.y);
        sp.semantic_key = lineageSemanticKey(sp.raw_x, g);
        add(sp);
      }
      requireRenderable(type);
    }
    return {
      chartType: type,
      mapping: lineageJSONValue(ctx.mapping),
      columns: ctx.columns.slice(),
      row_count: ctx.rows.length,
      coverage: "mapped",
      points: points,
      series: lineageSeries(points),
      raw_rows_preserved: true
    };
  }

  /* ====================================================================
   * R04: seriesIdentity — 稳定系列身份清单（UI/AI/校验共用）
   *
   * 返回渲染顺序的系列：[{key, label, kind}]。key 与渲染器内部的
   * stableSeriesKey 规则一致；数据替换后分组值不变则 key 不变。
   * 不渲染几何，只读 mapping/characterization/inline 数据。
   * ==================================================================== */
  function seriesIdentity(chartSpec) {
    if (!chartSpec || typeof chartSpec !== "object") {
      throw new Error("seriesIdentity：需要 chartSpec 对象");
    }
    var type = chartSpec.chartType;
    var mapping = chartSpec.mapping || {};
    var inline = chartSpec.data && chartSpec.data.inline;
    var out = [];
    function uniqValues(colName) {
      var seen = {}, vals = [];
      if (!inline || !Array.isArray(inline.rows) || !Array.isArray(inline.columns)) return vals;
      var at = inline.columns.indexOf(colName);
      if (at < 0) return vals;
      for (var i = 0; i < inline.rows.length; i++) {
        var row = inline.rows[i];
        if (!Array.isArray(row)) continue;
        var v = catLabel(row[at]);
        if (v === null) continue;
        if (!seen[v]) { seen[v] = true; vals.push(v); }
      }
      return vals;
    }
    if (chartSpec.characterization) {
      var ch = normalizeCharacterization(chartSpec.characterization,
        inline && inline.columns || []);
      var char = ch.ok ? ch.char : normalizeCharacterization(
        { technique: null, x_reverse: false, x_scale: "linear", curves: [], peak_annotations: [] }, []);
      if (type === "line_multi") {
        uniqValues(mapping.group).forEach(function (g) {
          out.push({ key: stableSeriesKey("group", mapping.group, g), label: String(g), kind: "raw" });
        });
      } else {
        out.push({ key: stableSeriesKey("raw", mapping.y, mapping.y), label: mapping.y, kind: "raw" });
      }
      (char.curves || []).forEach(function (cu) {
        out.push({ key: stableSeriesKey("curve", cu.role, cu.column),
          label: cu.label || cu.column, kind: cu.role });
      });
      return out;
    }
    // R4-HB：宽表（mapping.ys）每列一条系列，键与渲染/样式覆盖同源
    if ((type === "line_multi" || type === "scatter") &&
        Array.isArray(mapping.ys) && mapping.ys.length) {
      mapping.ys.forEach(function (col) {
        if (typeof col === "string" && col !== "") {
          out.push({ key: stableSeriesKey("series", col, col), label: col, kind: "series" });
        }
      });
      return out;
    }
    if (type === "line_multi" || type === "bar_grouped") {
      uniqValues(mapping.group).forEach(function (g) {
        out.push({ key: stableSeriesKey("group", mapping.group, g), label: String(g), kind: "group" });
      });
      return out;
    }
    if (type === "scatter" && mapping.color) {
      uniqValues(mapping.color).forEach(function (g) {
        out.push({ key: stableSeriesKey("color", mapping.color, g), label: String(g), kind: "color" });
      });
      if (out.length) return out;
    }
    out.push({ key: stableSeriesKey("series", mapping.y, mapping.y),
      label: mapping.y || "", kind: "series" });
    return out;
  }

  // H1：数据点键 pt|<源行号>|<h>。返回该行在 chartSpec 下会被画出的数据点键；
  // 该行不产生可绘制点（缺列/非数值/分组缺失）或图型无逐点标记时返回 null。
  // 与渲染器逐点 mkPointKey 同一 hash31，数据替换后同一行号值变 → 键不匹配。
  function pointKey(chartSpec, rowIndex) {
    if (!chartSpec || typeof chartSpec !== "object") return null;
    var type = chartSpec.chartType;
    if (["scatter", "line", "line_multi", "area"].indexOf(type) < 0) return null;
    var mapping = chartSpec.mapping || {};
    var inline = chartSpec.data && chartSpec.data.inline;
    if (!inline || !Array.isArray(inline.rows) || !Array.isArray(inline.columns)) return null;
    var row = inline.rows[rowIndex];
    if (!Array.isArray(row)) return null;
    function idxOf(name) {
      return (typeof name === "string" && name !== "") ? inline.columns.indexOf(name) : -1;
    }
    var xIdx = idxOf(mapping.x), yIdx = idxOf(mapping.y);
    if (xIdx < 0 || yIdx < 0) return null;
    var groupField = null;
    if (type === "line_multi") groupField = mapping.group;
    else if (type === "scatter" && mapping.color) groupField = mapping.color;
    var gIdx = idxOf(groupField);
    var xv = row[xIdx], yv = row[yIdx];
    if (isNaN(toNum(yv))) return null;
    var gVal = null;
    if (gIdx >= 0) {
      gVal = catLabel(row[gIdx]);
      if (gVal === null) return null;
    }
    if (type === "scatter") {
      if (isNaN(toNum(xv))) return null;
    } else if (xv === null || xv === undefined || xv === "") {
      return null;
    }
    return mkPointKey(rowIndex, xv, yv, gVal);
  }

  /* ====================================================================
   * H2：当前实际生效样式摘要（单位 pt）。复用渲染器同一批常量与解析函数
   * （STYLE_DEFAULTS / effPlot / effSeriesStyle / presLegendStyle /
   * presAxisStyle / legendPos / resolvePalette / seriesIdentity），
   * 未单独设置的项按渲染器默认值给出；不含原始数据行或单元格值。
   * ==================================================================== */
  function describeChartStyle(chartSpec, opts) {
    opts = opts || {};
    if (!chartSpec || typeof chartSpec !== "object" || Array.isArray(chartSpec)) {
      throw new Error("describeChartStyle：需要 chartSpec 对象");
    }
    var axes = (chartSpec.axes && typeof chartSpec.axes === "object") ? chartSpec.axes : {};
    var fontSizePt = (typeof opts.fontSizePt === "number" && isFinite(opts.fontSizePt) && opts.fontSizePt > 0)
      ? opts.fontSizePt : 7;
    var fontFamily = (typeof opts.fontFamily === "string" && opts.fontFamily.trim())
      ? opts.fontFamily : "Arial, sans-serif";
    var type = typeof chartSpec.chartType === "string" ? chartSpec.chartType : "";
    var isChar = !!chartSpec.characterization;
    // R4-HB2：宽表默认轴标题（与 renderChartSVG 同一 effectiveWideAxes 口径）
    axes = effectiveWideAxes(axes,
      (chartSpec.mapping && typeof chartSpec.mapping === "object") ? chartSpec.mapping : {},
      type, isChar);
    var ctx = {
      dpi: 300, // pt 数值与 dpi 无关；dpi 仅满足依赖它的辅助函数签名
      columns: (chartSpec.data && chartSpec.data.inline && chartSpec.data.inline.columns) || [],
      rows: [],
      mapping: (chartSpec.mapping && typeof chartSpec.mapping === "object") ? chartSpec.mapping : {},
      axes: axes,
      fontFamily: fontFamily,
      fontSizePt: fontSizePt,
      palette: resolvePalette(chartSpec.paletteId),
      chartSpec: chartSpec
    };
    var plot = effPlot(ctx);
    var pres = presOf(chartSpec) || {};

    // ---- 字号：tick 基准 ← axes.tickLabelSizePt 或 fontSizePt(默认7)；
    // 轴标题默认 = 基准×1.15；presentation.axes.{x,y}.{tick,title}.fontSizePt 覆盖。
    function posPt(v) { return (typeof v === "number" && isFinite(v) && v > 0) ? v : null; }
    var baseTickPt = posPt(axes.tickLabelSizePt) || fontSizePt || 7;
    var presX = presAxisStyle(ctx, "x"), presY = presAxisStyle(ctx, "y");
    function axisFont(axisPres) {
      var tick = axisPres.tick && posPt(axisPres.tick.fontSizePt);
      var title = axisPres.title && posPt(axisPres.title.fontSizePt);
      return {
        tickPt: tick || baseTickPt,
        axisTitlePt: title || Math.round(baseTickPt * 1.15 * 100) / 100
      };
    }
    var fx = axisFont(presX), fy = axisFont(presY);

    // ---- 轴：effPlot + axes.gridlines
    var axis = {
      widthPt: plot.axisWidthPt,
      tickLengthPt: plot.tickLengthPt,
      tickDirection: plot.tickDirection,
      frame: plot.frame,
      gridlines: axes.gridlines === true
    };

    // ---- 轴标题 / 刻度类型（表征图 x 轴可 log10）
    var labels = { x: axes.xLabel || "", y: axes.yLabel || "" };
    var scales = {
      x: (axes.xScale === "log" || axes.xScale === "log10") ? "log" : "linear",
      y: (axes.yScale === "log" || axes.yScale === "log10") ? "log" : "linear"
    };
    if (isChar) {
      try {
        var ch = normalizeCharacterization(chartSpec.characterization, ctx.columns);
        var char = ch && ch.ok ? ch.char : null;
        if (char) {
          labels.x = char.x_label || labels.x;
          labels.y = char.y_label || labels.y;
          scales.x = (char.x_scale === "log10" || char.x_scale === "log") ? "log" : "linear";
          scales.y = "linear";
        }
      } catch (e) { /* 表征参数非法时退回 axes 标签 */ }
    }

    // ---- 图例：legendPos + presLegendStyle（fontPt 默认=刻度基准）
    var lp = presLegendStyle(ctx);
    var legend = {
      position: legendPos(ctx),
      fontPt: (typeof lp.fontSizePt === "number" && isFinite(lp.fontSizePt) && lp.fontSizePt > 0)
        ? lp.fontSizePt : baseTickPt
    };

    // ---- 标记：该图型默认线宽/点直径，plot 覆盖优先
    var MARKER_DIA = { scatter: STYLE_DEFAULTS.scatterDiaPt,
      line: STYLE_DEFAULTS.lineMarkerDiaPt,
      line_multi: STYLE_DEFAULTS.lineMarkerDiaPt,
      area: STYLE_DEFAULTS.lineMarkerDiaPt };
    var LINE_TYPES = { line: 1, line_multi: 1, area: 1 };
    var pl0 = (pres.plot && typeof pres.plot === "object") ? pres.plot : {};
    var plotLineExplicit = typeof pl0.lineWidthPt === "number" && isFinite(pl0.lineWidthPt);
    var lineWidthPt = null;
    if (isChar) {
      lineWidthPt = plotLineExplicit ? pl0.lineWidthPt : STYLE_DEFAULTS.charLineWidthPt;
    } else if (LINE_TYPES[type]) {
      lineWidthPt = plot.lineWidthPt; // effPlot：显式 plot.lineWidthPt 否则 lineWidthPt(1.2)
    }
    var markerSizePt = (plot.markerSizePt != null) ? plot.markerSizePt
      : (MARKER_DIA[type] != null ? MARKER_DIA[type] : null);
    var marks = { lineWidthPt: lineWidthPt, markerSizePt: markerSizePt };

    // ---- 系列：seriesIdentity 顺序，最多 12；color=实际生效色
    var series = [];
    try {
      var ident = seriesIdentity(chartSpec) || [];
      // 渐变系列色：先按 ident 顺序登记 t 值，否则摘要里所有系列都是首色。
      var styleCtx = { palette: ctx.palette, chartSpec: chartSpec };
      setupSeriesGradient(styleCtx, ident.map(function (s2) {
        return { key: s2.key, label: s2.label };
      }));
      for (var i = 0; i < ident.length && series.length < 12; i++) {
        var s = ident[i];
        // 不传 dpi → u=1：dashCyclePattern 返回 pt 制原始样式，与本函数
        // "单位 pt" 的摘要口径一致（渲染侧由 drawSeriesChart 按 dpi 缩放）。
        var sStyle = effSeriesStyle(styleCtx, s.key, i);
        var serOv = (pres.series && pres.series[s.key]) || {};
        var entry = { key: s.key, label: s.label, color: sStyle.stroke };
        if (typeof sStyle.strokeWidthPt === "number") entry.lineWidthPt = sStyle.strokeWidthPt;
        if (typeof serOv.markerSizePt === "number" && isFinite(serOv.markerSizePt)) {
          entry.markerSizePt = serOv.markerSizePt;
        }
        if (sStyle.marker) entry.marker = sStyle.marker;
        if (sStyle.dash) entry.dash = sStyle.dash;
        if (typeof serOv.opacity === "number" && isFinite(serOv.opacity)) entry.opacity = serOv.opacity;
        if (typeof serOv.hatch === "string" && serOv.hatch) entry.hatch = serOv.hatch;
        series.push(entry);
      }
    } catch (e) { /* seriesIdentity 失败时给空数组 */ }

    // ---- R4-HB：右轴 y2——系列归属 + 有效右域/刻度（与渲染同一 nice-tick 逻辑）
    var y2info = null, y2n = null;
    try {
      y2n = normY2(ctx);
      if (y2n && (type === "line_multi" || type === "scatter") && !isChar) {
        for (var si2 = 0; si2 < series.length; si2++) {
          if (y2n.nameSet[series[si2].label] !== undefined) series[si2].axis = "right";
        }
        var inl = chartSpec.data && chartSpec.data.inline;
        var rightVals = [];
        if (inl && Array.isArray(inl.rows) && Array.isArray(inl.columns)) {
          var md = ctx.mapping;
          if (Array.isArray(md.ys) && md.ys.length) {
            y2n.names.forEach(function (n) {
              var ci = inl.columns.indexOf(n);
              if (ci < 0) return;
              for (var ri = 0; ri < inl.rows.length; ri++) {
                var rv = toNum(inl.rows[ri] ? inl.rows[ri][ci] : null);
                if (!isNaN(rv)) rightVals.push(rv);
              }
            });
          } else {
            var yi2 = typeof md.y === "string" ? inl.columns.indexOf(md.y) : -1;
            var gi2 = type === "line_multi" && typeof md.group === "string"
              ? inl.columns.indexOf(md.group) : -1;
            var ci2 = type === "scatter" && typeof md.color === "string"
              ? inl.columns.indexOf(md.color) : -1;
            var gIdx2 = gi2 >= 0 ? gi2 : ci2;
            if (yi2 >= 0 && gIdx2 >= 0) {
              for (var rj = 0; rj < inl.rows.length; rj++) {
                var rowj = inl.rows[rj];
                var gv = catLabel(rowj ? rowj[gIdx2] : null);
                if (gv === null || y2n.nameSet[String(gv)] === undefined) continue;
                var yv2 = toNum(rowj ? rowj[yi2] : null);
                if (!isNaN(yv2)) rightVals.push(yv2);
              }
            }
          }
        }
        var rd2 = { min: null, max: null }, rt2 = [];
        if (rightVals.length) {
          rd2 = valueDomain(rightVals, false);
          padDomain(rd2, 0.04, 0.04);
          if (y2n.min != null) rd2.min = y2n.min;
          if (y2n.max != null) rd2.max = y2n.max;
          var tk2 = niceTicks(rd2.min, rd2.max, 5);
          if (y2n.min == null) rd2.min = Math.min(rd2.min, tk2[0]);
          if (y2n.max == null) rd2.max = Math.max(rd2.max, tk2[tk2.length - 1]);
          rt2 = tk2.filter(function (v) { return v >= rd2.min - 1e-9 && v <= rd2.max + 1e-9; });
        }
        y2info = {
          series: y2n.names.slice(),
          label: y2n.label,
          min: y2n.min,
          max: y2n.max,
          domain: rightVals.length ? { min: rd2.min, max: rd2.max } : null,
          ticks: rt2.map(fmtNum)
        };
      }
    } catch (e) { /* y2 统计失败时省略 */ }

    // ---- 覆盖统计（只给键数，不给键内容，避免泄漏标记键细节）
    var overrides = {
      points: (pres.points && typeof pres.points === "object") ? Object.keys(pres.points).length : 0,
      peaks: (pres.peaks && typeof pres.peaks === "object") ? Object.keys(pres.peaks).length : 0
    };

    // ---- R6 表征/范围特性摘要（数值全部来自用户/模板字段，不推断）
    var ranges = null;
    ["xMin", "xMax", "yMin", "yMax"].forEach(function (k) {
      var v = axes[k];
      if (typeof v === "number" && isFinite(v)) {
        ranges = ranges || {};
        ranges[k] = v;
      }
    });
    var sc = pl0.seriesColors;
    var features = {
      ranges: ranges,
      tickHidden: {
        x: !!(presX.tick && presX.tick.hidden === true),
        y: !!(presY.tick && presY.tick.hidden === true)
      },
      annotations: {
        references: Array.isArray(chartSpec.references) ? chartSpec.references.length : 0,
        bands: Array.isArray(chartSpec.bands) ? chartSpec.bands.length : 0,
        significance: Array.isArray(chartSpec.significance) ? chartSpec.significance.length : 0,
        letters: (chartSpec.letters && typeof chartSpec.letters === "object" && !Array.isArray(chartSpec.letters))
          ? Object.keys(chartSpec.letters).length : 0
      },
      seriesColors: (sc && typeof sc === "object" && sc.mode === "gradient") ? {
        mode: "gradient", palette: sc.palette, reverse: sc.reverse === true,
        colorbar: !!(sc.colorbar && sc.colorbar.show === true)
      } : null,
      componentFill: pl0.componentFill === true,
      errorStyle: (pl0.errorStyle === "band") ? "band" : "bars"
    };

    return {
      chartType: type,
      font: {
        family: fontFamily,
        tickPt: { x: fx.tickPt, y: fy.tickPt },
        axisTitlePt: { x: fx.axisTitlePt, y: fy.axisTitlePt }
      },
      axis: axis,
      labels: labels,
      scales: scales,
      legend: legend,
      marks: marks,
      series: series,
      y2: y2info,
      overrides: overrides,
      features: features
    };
  }

  /* ====================================================================
   * Export
   * ==================================================================== */

  var FigData = {
    UnsupportedChartError: UnsupportedChartError,
    supportsChartType: supportsChartType,
    supportedChartTypes: supportedChartTypes,
    CAPABILITY_TYPES: CAPABILITY_TYPES.slice(),
    CHART_TYPE_NAMES: CHART_TYPE_NAMES,
    chartTypeName: chartTypeName,
    templateCapability: templateCapability,
    templateCapabilities: templateCapabilities,
    parseCSV: parseCSV,
    parseCell: parseCell,
    detectDelimiter: detectDelimiter,
    sniffNumberFormat: sniffNumberFormat,
    parseJSON: parseJSON,
    columnStats: columnStats,
    inferChartType: inferChartType,
    makeChartElement: makeChartElement,
    renderChartSVG: renderChartSVG,
    chartHitIndex: chartHitIndex,
    chartSignature: chartSignature,
    effectiveMarkStyle: effectiveMarkStyle,
    COMPACT_MARKS_THRESHOLD: 2000,
    getChartPoints: getChartPoints,
    renderableRows: renderableRows,
    duplicateXStats: duplicateXStats,
    seriesIdentity: seriesIdentity,
    stableSeriesKey: stableSeriesKey,
    pointKey: pointKey,
    describeChartStyle: describeChartStyle,
    SPREAD_TYPES: SPREAD_TYPES,
    UNCERTAINTY_SOURCES: UNCERTAINTY_SOURCES,
    studentT975: studentT975,
    spreadStats: spreadStats,
    cellUncertainty: cellUncertainty,
    CHARACTERIZATION_FIELDS: CHAR_FIELDS,
    CHAR_CURVE_ROLES: CHAR_ROLES,
    CHAR_NORMALIZE_MODES: CHAR_NORMALIZE_MODES,
    normalizeCharacterization: normalizeCharacterization
  };

  global.FigData = FigData;
  installTemplateCapabilities();
})(typeof globalThis !== "undefined" ? globalThis : this);
