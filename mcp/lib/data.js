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

  var MAPPING_ROLES = ["x", "y", "group", "color", "size", "label", "error"];

  // spread types of chart.statistics (science contract); see lib/science.js
  var SPREAD_TYPES = ["SD", "SEM", "95CI", "range"];
  var UNCERTAINTY_SOURCES = ["replicates", "column"];

  var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  // case-insensitive tokens treated as missing cells on CSV import
  var MISSING_TOKENS = ["", "na", "n/a", "nan", "null", "none", "-"];

  var FALLBACK_PALETTE = [
    "#3C5488", "#E64B35", "#00A087", "#4DBBD5", "#F39B7F", "#8491B4",
    "#91D1C2", "#DC0000", "#7E6148", "#B09C85"
  ];

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

  function detectDelimiter(text) {
    var counts = { ",": 0, ";": 0, "\t": 0 };
    var inQ = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '"') { inQ = !inQ; continue; }
      if (!inQ && counts.hasOwnProperty(ch)) counts[ch] += 1;
    }
    var order = [",", ";", "\t"];
    var best = ",", bestN = 0;
    for (var j = 0; j < order.length; j++) {
      if (counts[order[j]] > bestN) { best = order[j]; bestN = counts[order[j]]; }
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
    opts = opts || {};
    if (typeof text !== "string") throw new Error("parseCSV：输入必须是字符串");
    if (text.length === 0) throw new Error("parseCSV：CSV 内容为空");

    var header = opts.header !== false;
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
        out.push(coerceCell(j < src.length ? src[j] : ""));
      }
      rows.push(out);
    }
    return { columns: columns, rows: rows };
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
      out[role] = (m && m[role] !== undefined) ? m[role] : null;
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
      cleanMapping[role] = v;
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
          yLabel: cleanMapping.y || "",
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
    var l = ctx.chartSpec.legend;
    return (l === "none" || l === "right" || l === "top" || l === "bottom") ? l : "right";
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

  function legendMaxW(items, f) {
    var w = 0;
    for (var i = 0; i < items.length; i++) {
      var lw = textW(items[i].label, f);
      if (lw > w) w = lw;
    }
    return w;
  }

  // cartesian layout: computes paddings from tick labels, axis titles, legend
  function cartesianFrame(ctx, o) {
    var f = tickFontPx(ctx), tf = f * 1.15;
    var padLeft = 8, padRight = 10, padTop = 8, padBottom = 8;
    if (ctx.axes.title) padTop += tf * 1.9;

    var yMaxW = 0;
    var yLabels = o.yTickLabels || [];
    for (var i = 0; i < yLabels.length; i++) {
      var lw = textW(yLabels[i], f);
      if (lw > yMaxW) yMaxW = lw;
    }
    padLeft += yMaxW + 8;
    if (ctx.axes.yLabel) padLeft += tf * 1.7;

    padBottom += f * 1.5;
    if (ctx.axes.xLabel) padBottom += tf * 1.7;

    var legend = o.legend || [];
    if (legend.length && legendPos(ctx) !== "none") {
      var pos = legendPos(ctx);
      if (pos === "right") padRight += 16 + legendMaxW(legend, f) + 10;
      else if (pos === "top") padTop += f * 2.0;
      else if (pos === "bottom") padBottom += f * 2.0;
    }
    if (o.extraRight) padRight += o.extraRight;

    var pw = ctx.W - padLeft - padRight;
    var ph = ctx.H - padTop - padBottom;
    if (pw < 30 || ph < 30) {
      throw new Error("renderChartSVG：画布尺寸过小，无法容纳坐标轴（请提供更大的 width_mm/height_mm）");
    }
    return {
      x0: padLeft, y0: padTop, pw: pw, ph: ph,
      tickF: f, titleF: tf,
      yTickMaxW: yMaxW,
      legend: legend,
      legendX: ctx.W - padRight,
      legendMaxW: legend.length ? legendMaxW(legend, f) : 0
    };
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

    if (ctx.axes.gridlines) {
      for (i = 0; i < o.yTicks.length; i++) {
        t = o.yTicks[i];
        if (t.px > y0 + 0.5 && t.px < yb - 0.5) {
          parts.push(lineEl(x0, t.px, x0 + pw, t.px, "#DDDDDD", ' stroke-width="0.6"'));
        }
      }
    }
    if (o.zeroY != null && o.zeroY > y0 + 0.5 && o.zeroY < yb - 0.5) {
      parts.push(lineEl(x0, o.zeroY, x0 + pw, o.zeroY, "#999999", ' stroke-width="0.8" stroke-dasharray="4 3"'));
    }
    parts.push(lineEl(x0, y0, x0, yb, "#000000", ' stroke-width="1"'));
    parts.push(lineEl(x0, yb, x0 + pw, yb, "#000000", ' stroke-width="1"'));

    for (i = 0; i < o.yTicks.length; i++) {
      t = o.yTicks[i];
      parts.push(lineEl(x0 - 4, t.px, x0, t.px, "#000000", ' stroke-width="1"'));
      parts.push(text(x0 - 6, t.px + f * 0.35, t.label, { anchor: "end", size: f }));
    }

    var xt = thinTicks(o.xTicks, f);
    for (i = 0; i < xt.length; i++) {
      t = xt[i];
      parts.push(lineEl(t.px, yb, t.px, yb + 4, "#000000", ' stroke-width="1"'));
      parts.push(text(t.px, yb + f * 1.25, t.label, { anchor: "middle", size: f }));
    }

    if (ctx.axes.xLabel) {
      parts.push(text(x0 + pw / 2, yb + f * 1.25 + fr.titleF, ctx.axes.xLabel, { anchor: "middle", size: fr.titleF }));
    }
    if (ctx.axes.yLabel) {
      var lx = x0 - fr.yTickMaxW - 10, ly = y0 + ph / 2;
      parts.push(text(lx, ly, ctx.axes.yLabel, {
        anchor: "middle", size: fr.titleF,
        transform: "rotate(-90 " + px(lx) + " " + px(ly) + ")"
      }));
    }
    if (ctx.axes.title) {
      parts.push(text(x0 + pw / 2, y0 - fr.titleF * 0.5, ctx.axes.title, { anchor: "middle", size: fr.titleF, weight: "bold" }));
    }
    return parts.join("");
  }

  function legendSwatch(it, x, y, f) {
    if (it.kind === "line") {
      return lineEl(x, y, x + 12, y, it.color, ' stroke-width="2"');
    }
    return rectEl(x, y - 5, 12, 10, it.color);
  }

  function drawLegend(ctx, fr) {
    var items = fr.legend || [];
    if (!items.length || legendPos(ctx) === "none") return "";
    var f = fr.tickF, parts = [];
    var pos = legendPos(ctx);
    var i, it;
    if (pos === "right") {
      var y = fr.y0 + f;
      for (i = 0; i < items.length; i++) {
        it = items[i];
        parts.push(legendSwatch(it, fr.legendX, y, f));
        parts.push(text(fr.legendX + 16, y + f * 0.35, it.label, { size: f }));
        y += f * 1.7;
      }
    } else {
      var x = fr.x0;
      var yy = pos === "top" ? fr.y0 - f * 1.3 : fr.y0 + fr.ph + f * 2.4;
      for (i = 0; i < items.length; i++) {
        it = items[i];
        parts.push(legendSwatch(it, x, yy, f));
        parts.push(text(x + 16, yy + f * 0.35, it.label, { size: f }));
        x += 16 + textW(it.label, f) + 14;
      }
    }
    return parts.join("");
  }

  function wrap(ctx, parts) {
    var extra = "";
    var diag = ctx.diagAttrs;
    if (Array.isArray(diag)) {
      for (var i = 0; i < diag.length; i++) {
        extra += " " + diag[i][0] + '="' + esc(diag[i][1]) + '"';
      }
    }
    return '<g font-family="' + esc(ctx.fontFamily || "Arial, sans-serif") + '" data-chart-type="' +
      esc(ctx.chartSpec.chartType) + '"' + extra + ">" + parts.join("") + "</g>";
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
      for (var p = 0; p < pas.length; p++) {
        var pa = pas[p];
        if (!pa || typeof pa !== "object" || Array.isArray(pa)) {
          errors.push("peak_annotations[" + p + "] 必须是对象");
          continue;
        }
        var pk = Object.keys(pa);
        for (var r = 0; r < pk.length; r++) {
          if (pk[r] !== "x" && pk[r] !== "label") errors.push("peak_annotations[" + p + "] 含未知字段：" + pk[r]);
        }
        if (typeof pa.x !== "number" || !isFinite(pa.x)) {
          errors.push("peak_annotations[" + p + "].x 必须是有限数字");
        }
        char.peak_annotations.push({ x: pa.x, label: strOrNull(pa.label) });
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
      rawSeries.push({ label: ctx.mapping.y, points: res0.points, kind: "raw" });
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
        rawSeries.push({ label: buckets[i].key, points: charSortSeries(buckets[i].points, char), kind: "raw" });
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
      curveSeries.push({ label: cu.label || cu.column, points: res1.points, kind: cu.role });
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
    var s;
    for (s = 0; s < rawSeries.length; s++) {
      rawSeries[s].color = ctx.palette[s % ctx.palette.length];
    }
    for (s = 0; s < curveSeries.length; s++) {
      curveSeries[s].color = ctx.palette[(rawSeries.length + s) % ctx.palette.length];
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

    // Draw order: components -> baseline -> fit -> raw (raw drawn last, on top).
    var PRIO = { component: 0, baseline: 1, fit: 2, raw: 3 };
    var paintOrder = series.slice().sort(function (a, b) { return PRIO[a.kind] - PRIO[b.kind]; });

    // --- domains (x in transformed space, y after normalize/offset) ---
    var xT = char.x_scale === "log10"
      ? function (v) { return Math.log10(v); }
      : function (v) { return v; };
    var ysAll = [];
    var tMin = Infinity, tMax = -Infinity;
    for (s = 0; s < series.length; s++) {
      var se2 = series[s];
      for (j = 0; j < se2.points.length; j++) {
        ysAll.push(se2.points[j].y * se2.scale + se2.yShift);
        var t = xT(se2.points[j].x);
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    }
    if (!isFinite(tMin)) { tMin = 0; tMax = 1; }
    if (tMin === tMax) { tMin -= 0.5; tMax += 0.5; }
    var dom = valueDomain(ysAll, false);
    var yTicks = niceTicks(dom.min, dom.max, 5);
    dom.min = Math.min(dom.min, yTicks[0]);
    dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);

    var legendItems = [];
    for (s = 0; s < series.length; s++) {
      legendItems.push({ label: series[s].label, color: series[s].color, kind: "line" });
    }
    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: legendItems });
    var sy = linScale(dom.min, dom.max, fr.y0 + fr.ph, fr.y0);
    var sx = char.x_reverse
      ? linScale(tMin, tMax, fr.x0 + fr.pw, fr.x0)   // XPS/NMR: high value on the left
      : linScale(tMin, tMax, fr.x0, fr.x0 + fr.pw);  // Raman/XRD: ascending

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
    var parts = [];
    var strokeWidth = Math.max(1, ctx.dpi / 90);
    var r = Math.max(1.2, ctx.dpi / 170);
    for (s = 0; s < paintOrder.length; s++) {
      var se3 = paintOrder[s];
      if (!se3.points.length) continue;
      var pts = [];
      for (j = 0; j < se3.points.length; j++) {
        pts.push([sx(xT(se3.points[j].x)), sy(se3.points[j].y * se3.scale + se3.yShift)]);
      }
      var w = se3.kind === "raw" ? strokeWidth : strokeWidth * 0.65;
      var extra = "";
      if (se3.kind === "fit") extra = ' stroke-dasharray="6 3"';
      else if (se3.kind === "baseline") extra = ' stroke-dasharray="2 3"';
      else if (se3.kind === "component") extra = ' stroke-opacity="0.85"';
      parts.push('<polyline points="' +
        pts.map(function (p) { return px(p[0]) + "," + px(p[1]); }).join(" ") +
        '" fill="none" stroke="' + se3.color + '" stroke-width="' + px(w) +
        '" stroke-linejoin="round" stroke-linecap="round"' + extra + "/>");
      if (se3.kind === "raw" && pts.length <= 400) {
        for (j = 0; j < pts.length; j++) parts.push(circleEl(pts[j][0], pts[j][1], r, se3.color));
      }
    }

    // --- peak markers: ONLY from peak_annotations, no default peak names ---
    var drawnPeaks = 0, skippedPeaks = 0;
    var f = fr.tickF;
    for (i = 0; i < char.peak_annotations.length; i++) {
      var pa = char.peak_annotations[i];
      if (typeof pa.x !== "number" || !isFinite(pa.x)) { skippedPeaks++; continue; }
      var pt = xT(pa.x);
      if (pt < tMin || pt > tMax) { skippedPeaks++; continue; }
      var ppx = sx(pt);
      parts.push(lineEl(ppx, fr.y0, ppx, fr.y0 + fr.ph, "#888888",
        ' stroke-width="0.8" stroke-dasharray="4 3"'));
      if (pa.label) {
        parts.push(text(ppx, fr.y0 + f * 1.2, pa.label, { anchor: "middle", size: f, fill: "#555555" }));
      }
      drawnPeaks++;
    }

    // Explicit in-plot exclusion warning (log10 guard); also in diag attrs.
    if (excludedLog > 0) {
      parts.push(text(fr.x0 + 4, fr.y0 + f * 1.1,
        "已排除 " + excludedLog + " 个非正 x 点（log10，不计入）",
        { anchor: "start", size: f * 0.95, fill: "#A05A00" }));
    }

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
    var cats = [], seen = {}, sums = [], counts = [];
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
        k = cats.length - 1;
      }
      sums[k] += v;
      counts[k] += 1;
    }
    var vals = [];
    for (var j = 0; j < cats.length; j++) {
      vals.push(mode === "sum" ? sums[j] : sums[j] / counts[j]);
    }
    return { cats: cats, vals: vals };
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

  function buildXTicks(prep, sx) {
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
      var dom = xDomain(prep);
      var ts = niceTicks(dom.min, dom.max, 5);
      for (i = 0; i < ts.length; i++) {
        ticks.push({ px: sx(ts[i]), label: fmtNum(ts[i]) });
      }
    }
    return ticks;
  }

  // shared body for line / line_multi / area
  function drawSeriesChart(ctx, prep, o) {
    var ys = [];
    for (var i = 0; i < prep.points.length; i++) ys.push(prep.points[i].y);
    var dom = valueDomain(ys, false);
    var yTicks = niceTicks(dom.min, dom.max, 5);
    dom.min = Math.min(dom.min, yTicks[0]);
    dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);

    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: o.legendItems || [] });
    var sy = linScale(dom.min, dom.max, fr.y0 + fr.ph, fr.y0);
    var xd = xDomain(prep);
    var sx = linScale(xd.min, xd.max, fr.x0, fr.x0 + fr.pw);
    var xTicks = buildXTicks(prep, sx);

    var parts = [];
    var r = Math.max(1.2, ctx.dpi / 170);
    var strokeWidth = Math.max(1, ctx.dpi / 90);

    for (var s = 0; s < o.series.length; s++) {
      var color = o.colors[s % o.colors.length];
      var pts = [];
      for (i = 0; i < o.series[s].points.length; i++) {
        pts.push([sx(o.series[s].points[i].x), sy(o.series[s].points[i].y)]);
      }
      if (o.fillArea && pts.length > 1) {
        var base = sy(0);
        if (base < fr.y0) base = fr.y0;
        if (base > fr.y0 + fr.ph) base = fr.y0 + fr.ph;
        var d = "M " + pts.map(function (p) { return px(p[0]) + " " + px(p[1]); }).join(" L ") +
          " L " + px(pts[pts.length - 1][0]) + " " + px(base) +
          " L " + px(pts[0][0]) + " " + px(base) + " Z";
        parts.push('<path d="' + d + '" fill="' + color + '" fill-opacity="0.3" stroke="none"/>');
      }
      if (pts.length > 1) {
        parts.push('<polyline points="' +
          pts.map(function (p) { return px(p[0]) + "," + px(p[1]); }).join(" ") +
          '" fill="none" stroke="' + color + '" stroke-width="' + px(strokeWidth) +
          '" stroke-linejoin="round" stroke-linecap="round"/>');
      }
      if (pts.length === 1 || (o.drawPoints && pts.length <= 400)) {
        for (i = 0; i < pts.length; i++) parts.push(circleEl(pts[i][0], pts[i][1], r, color));
      }
    }

    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks,
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
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
    var domVals = agg.vals.slice();
    for (e = 0; e < cells.length; e++) {
      if (cells[e].ok) { domVals.push(agg.vals[e] + cells[e].upper, agg.vals[e] + cells[e].lower); }
    }
    var dom = valueDomain(domVals, true); // zero baseline (negative values supported)
    var yTicks = niceTicks(dom.min, dom.max, 5);
    dom.min = Math.min(dom.min, yTicks[0]);
    dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);

    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: [] });
    var sy = linScale(dom.min, dom.max, fr.y0 + fr.ph, fr.y0);
    var band = fr.pw / agg.cats.length;
    var barW = Math.max(1, band * 0.65);
    var zeroY = sy(0);
    var capW = Math.max(2, Math.min(barW * 0.3, ctx.dpi / 60));
    var ebStroke = Math.max(1, ctx.dpi / 150);

    var parts = [], xTicks = [];
    for (var i = 0; i < agg.cats.length; i++) {
      var cx = fr.x0 + band * (i + 0.5);
      var v = agg.vals[i];
      var yVal = sy(v);
      var top = Math.min(zeroY, yVal);
      var hpx = Math.max(0.5, Math.abs(yVal - zeroY));
      var fill = v >= 0 ? ctx.palette[0] : (ctx.palette[1] || ctx.palette[0]);
      parts.push(rectEl(cx - barW / 2, top, barW, hpx, fill));
      if (cells[i].ok) {
        var lo = v + cells[i].lower, hi = v + cells[i].upper;
        errorBarEl(parts, cx, sy(Math.min(lo, hi)), sy(Math.max(lo, hi)), capW, ebStroke);
      }
      if (showValues(ctx)) {
        parts.push(text(cx, v >= 0 ? top - 3 : top + hpx + fr.tickF, fmtNum(v),
          { anchor: "middle", size: fr.tickF * 0.9 }));
      }
      xTicks.push({ px: cx, label: agg.cats[i] });
    }
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
      if (!cell) cell = mat[ci][gi] = { sum: 0, n: 0 };
      cell.sum += v;
      cell.n += 1;
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

    var vals = [];
    for (i = 0; i < mat.length; i++) {
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
        if (m && c0.ok) {
          var mean0 = m.sum / m.n;
          vals.push(mean0 + c0.upper, mean0 + c0.lower);
        }
      }
    }
    var dom = valueDomain(vals, true);
    var yTicks = niceTicks(dom.min, dom.max, 5);
    dom.min = Math.min(dom.min, yTicks[0]);
    dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);

    var legendItems = [];
    for (i = 0; i < groups.length; i++) {
      legendItems.push({ label: groups[i], color: ctx.palette[i % ctx.palette.length], kind: "rect" });
    }
    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: legendItems });
    var sy = linScale(dom.min, dom.max, fr.y0 + fr.ph, fr.y0);
    var band = fr.pw / cats.length;
    var barW = Math.max(0.8, band * 0.8 / groups.length);
    var zeroY = sy(0);
    var capW = Math.max(1.5, Math.min(barW * 0.3, ctx.dpi / 60));
    var ebStroke = Math.max(1, ctx.dpi / 150);

    var parts = [], xTicks = [];
    cellIdx = 0;
    for (i = 0; i < cats.length; i++) {
      var center = fr.x0 + band * (i + 0.5);
      xTicks.push({ px: center, label: cats[i] });
      for (gj = 0; gj < groups.length; gj++) {
        var c2 = mat[i][gj];
        var cErr = cells[cellIdx++];
        if (!c2) continue;
        var v2 = c2.sum / c2.n;
        var yVal = sy(v2);
        var top = Math.min(zeroY, yVal);
        var hpx = Math.max(0.5, Math.abs(yVal - zeroY));
        var bx = center - barW * groups.length / 2 + gj * barW;
        parts.push(rectEl(bx, top, barW * 0.92, hpx, ctx.palette[gj % ctx.palette.length]));
        if (cErr.ok) {
          // error bars sit on the bar's own center, not the group center
          var bxm = bx + barW * 0.92 / 2;
          var lo = v2 + cErr.lower, hi = v2 + cErr.upper;
          errorBarEl(parts, bxm, sy(Math.min(lo, hi)), sy(Math.max(lo, hi)), capW, ebStroke);
        }
      }
    }
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
    var parts = drawSeriesChart(ctx, prep, {
      series: [{ key: "", points: prep.points }],
      colors: [ctx.palette[0]],
      legendItems: [],
      drawPoints: true
    });
    return wrap(ctx, parts);
  };

  RENDERS.line_multi = function (ctx) {
    var idx = requireCols(ctx, ["x", "y", "group"]);
    if (ctx.chartSpec.characterization) {
      return wrap(ctx, renderCharacterization(ctx, idx));
    }
    var prep = prepareXY(ctx, idx.x, idx.y, idx.group);
    if (!prep.points.length) throw new Error("renderChartSVG：line_multi 没有可绘制的数据点");
    var series = groupPoints(prep.points, "g");
    var legendItems = [];
    for (var i = 0; i < series.length; i++) {
      legendItems.push({ label: series[i].key, color: ctx.palette[i % ctx.palette.length], kind: "line" });
    }
    var parts = drawSeriesChart(ctx, prep, {
      series: series,
      colors: ctx.palette,
      legendItems: legendItems,
      drawPoints: true
    });
    return wrap(ctx, parts);
  };

  RENDERS.area = function (ctx) {
    var idx = requireCols(ctx, ["x", "y"]);
    var prep = prepareXY(ctx, idx.x, idx.y, null);
    if (!prep.points.length) throw new Error("renderChartSVG：area 没有可绘制的数据点");
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
    var idx = requireCols(ctx, ["x", "y"]);
    var colorIdx = colIndex(ctx, "color");
    var pts = [];
    for (var i = 0; i < ctx.rows.length; i++) {
      var xv = toNum(ctx.rows[i][idx.x]);
      var yv = toNum(ctx.rows[i][idx.y]);
      if (isNaN(xv) || isNaN(yv)) continue;
      var g = null;
      if (colorIdx >= 0) {
        g = catLabel(ctx.rows[i][colorIdx]);
        if (g === null) continue;
      }
      pts.push({ x: xv, y: yv, g: g });
    }
    if (!pts.length) {
      throw new Error("renderChartSVG：scatter 没有可绘制的点（mapping.x/mapping.y 必须是数值列）");
    }

    var series = [{ key: "", points: pts }];
    var legendItems = [];
    if (colorIdx >= 0) {
      series = groupPoints(pts, "g");
      for (i = 0; i < series.length; i++) {
        legendItems.push({ label: series[i].key, color: ctx.palette[i % ctx.palette.length], kind: "rect" });
      }
    }

    var xs = [], ys = [];
    for (i = 0; i < pts.length; i++) { xs.push(pts[i].x); ys.push(pts[i].y); }
    var domX = valueDomain(xs, false), domY = valueDomain(ys, false);
    var xTicks = niceTicks(domX.min, domX.max, 5);
    var yTicks = niceTicks(domY.min, domY.max, 5);
    domX.min = Math.min(domX.min, xTicks[0]); domX.max = Math.max(domX.max, xTicks[xTicks.length - 1]);
    domY.min = Math.min(domY.min, yTicks[0]); domY.max = Math.max(domY.max, yTicks[yTicks.length - 1]);

    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: legendItems });
    if (char && charEqualAspect(char)) {
      var equal = equalAspectDomains(fr, domX, domY);
      domX = equal.x;
      domY = equal.y;
    }
    var sx = linScale(domX.min, domX.max, fr.x0, fr.x0 + fr.pw);
    var sy = linScale(domY.min, domY.max, fr.y0 + fr.ph, fr.y0);

    var parts = [];
    var r = Math.max(1.4, ctx.dpi / 150);
    for (i = 0; i < series.length; i++) {
      var color = ctx.palette[i % ctx.palette.length];
      for (var j = 0; j < series[i].points.length; j++) {
        parts.push(circleEl(sx(series[i].points[j].x), sy(series[i].points[j].y), r, color, ' fill-opacity="0.85"'));
      }
    }
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks.map(function (v) { return { px: sx(v), label: fmtNum(v) }; }),
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
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
    if (agg.cats.length === 1) {
      parts.push('<circle cx="' + px(cx) + '" cy="' + px(cy) + '" r="' + px(r) +
        '" fill="' + ctx.palette[0] + '" stroke="#FFFFFF" stroke-width="1"/>');
    } else {
      var a0 = -Math.PI / 2;
      for (i = 0; i < agg.cats.length; i++) {
        var frac = agg.vals[i] / total;
        var a1 = a0 + frac * Math.PI * 2;
        if (frac > 0) {
          parts.push('<path d="' + arcPath(cx, cy, r, a0, a1) +
            '" fill="' + ctx.palette[i % ctx.palette.length] + '" stroke="#FFFFFF" stroke-width="1"/>');
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

    var dom = valueDomain(counts, true);
    var yTicks = niceTicks(dom.min, dom.max, 5);
    dom.min = Math.min(dom.min, yTicks[0]);
    dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);

    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: [] });
    var sy = linScale(dom.min, dom.max, fr.y0 + fr.ph, fr.y0);
    var sx = linScale(min, max, fr.x0, fr.x0 + fr.pw);
    var bw = fr.pw / k;
    var baseY = fr.y0 + fr.ph;

    var parts = [];
    for (i = 0; i < k; i++) {
      if (counts[i] <= 0) continue;
      var top = sy(counts[i]);
      parts.push(rectEl(fr.x0 + i * bw + 0.5, top, Math.max(0.5, bw - 1), Math.max(0.5, baseY - top), ctx.palette[0]));
    }
    var xTicks = [];
    for (i = 0; i <= k; i++) {
      var ev = min + i * w;
      xTicks.push({ px: sx(ev), label: fmtNum(ev) });
    }
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

    var vals = [];
    for (i = 0; i < cells.length; i++) {
      for (var j = 0; j < cells[i].length; j++) {
        if (cells[i][j]) vals.push(cells[i][j].sum / cells[i][j].n);
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
    for (i = 0; i < ycats.length; i += yStride) yShow.push(ycats[i]);
    var cbW = 8, cbLabelW = Math.max(textW(fmtNum(vmin), f), textW(fmtNum(vmax), f));

    var fr = cartesianFrame(ctx, { yTickLabels: yShow, legend: [], extraRight: cbW + cbLabelW + 12 });
    var cw = fr.pw / xcats.length;
    var ch = fr.ph / ycats.length;

    var parts = [];
    var drawCellText = xcats.length * ycats.length <= 30;
    for (i = 0; i < ycats.length; i++) {
      for (j = 0; j < xcats.length; j++) {
        var c3 = cells[i][j];
        if (!c3) continue;
        var m = c3.sum / c3.n;
        var color = colorAt(ctx.palette, (m - vmin) / (vmax - vmin));
        parts.push(rectEl(fr.x0 + j * cw, fr.y0 + i * ch, cw, ch, color, ' stroke="#FFFFFF" stroke-width="0.5"'));
        if (drawCellText) {
          parts.push(text(fr.x0 + (j + 0.5) * cw, fr.y0 + (i + 0.5) * ch + Math.min(f, ch * 0.55) * 0.35,
            fmtNum(m), { anchor: "middle", size: Math.min(f, ch * 0.55), fill: contrastFor(color) }));
        }
      }
    }

    var xTicks = [];
    for (j = 0; j < xcats.length; j += xStride) {
      xTicks.push({ px: fr.x0 + (j + 0.5) * cw, label: xcats[j] });
    }
    var yTicks = [];
    for (i = 0; i < ycats.length; i += yStride) {
      yTicks.push({ px: fr.y0 + (i + 0.5) * ch, label: ycats[i] });
    }
    parts.push(drawFrameAxes(ctx, fr, { xTicks: xTicks, yTicks: yTicks, zeroY: null }));

    // colorbar
    var cbX = fr.x0 + fr.pw + 10, cbY = fr.y0, cbH = fr.ph, steps = 24;
    for (var s = 0; s < steps; s++) {
      var t = 1 - s / steps;
      parts.push(rectEl(cbX, cbY + s * (cbH / steps), cbW, cbH / steps + 0.5, colorAt(ctx.palette, t)));
    }
    parts.push(rectEl(cbX - 0.5, cbY - 0.5, cbW + 1, cbH + 1, "none", ' stroke="#000000" stroke-width="0.8"'));
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

    var allVals = [];
    for (i = 0; i < values.length; i++) {
      for (var j = 0; j < values[i].length; j++) allVals.push(values[i][j]);
    }
    var dom = valueDomain(allVals, false);
    var yTicks = niceTicks(dom.min, dom.max, 5);
    dom.min = Math.min(dom.min, yTicks[0]);
    dom.max = Math.max(dom.max, yTicks[yTicks.length - 1]);

    var fr = cartesianFrame(ctx, { yTickLabels: yTicks.map(fmtNum), legend: [] });
    var sy = linScale(dom.min, dom.max, fr.y0 + fr.ph, fr.y0);
    var band = fr.pw / cats.length;
    var boxW = Math.max(2, band * 0.5);

    var parts = [], xTicks = [];
    for (i = 0; i < cats.length; i++) {
      var center = fr.x0 + band * (i + 0.5);
      xTicks.push({ px: center, label: cats[i] });
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
      parts.push(lineEl(center, sy(lo), center, sy(hi), "#000000", ' stroke-width="1"'));
      parts.push(lineEl(center - boxW / 4, sy(lo), center + boxW / 4, sy(lo), "#000000", ' stroke-width="1"'));
      parts.push(lineEl(center - boxW / 4, sy(hi), center + boxW / 4, sy(hi), "#000000", ' stroke-width="1"'));
      // box
      parts.push(rectEl(center - boxW / 2, sy(q3), boxW, Math.max(0.5, sy(q1) - sy(q3)),
        ctx.palette[0], ' fill-opacity="0.3" stroke="#000000" stroke-width="1"'));
      // median
      parts.push(lineEl(center - boxW / 2, sy(q2), center + boxW / 2, sy(q2), "#000000", ' stroke-width="1.4"'));
      // deterministic jitter points (all observations)
      for (j = 0; j < arr.length; j++) {
        var jx = center + ((j % 5) - 2) * (boxW / 6);
        parts.push(circleEl(jx, sy(arr[j]), Math.max(1, ctx.dpi / 200), "#000000", ' fill-opacity="0.35"'));
      }
    }
    parts.push(drawFrameAxes(ctx, fr, {
      xTicks: xTicks,
      yTicks: yTicks.map(function (v) { return { px: sy(v), label: fmtNum(v) }; }),
      zeroY: null
    }));
    return wrap(ctx, parts);
  };

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
    var parts = [
      rectEl(0, 0, W, H, "#FFF8E8", ' stroke="#A05A00" stroke-width="1"'),
      rectEl(2, 2, W - 4, H - 4, "none", ' stroke="#CC9900" stroke-width="1" stroke-dasharray="4 3"'),
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
      axes: (chartSpec.axes && typeof chartSpec.axes === "object") ? chartSpec.axes : {},
      fontFamily: typeof opts.fontFamily === "string" && opts.fontFamily.trim()
        ? opts.fontFamily : "Arial, sans-serif",
      fontSizePt: typeof opts.fontSizePt === "number" && isFinite(opts.fontSizePt) && opts.fontSizePt > 0
        ? opts.fontSizePt : 7,
      palette: resolvePalette(chartSpec.paletteId),
      chartSpec: chartSpec
    };
    return RENDERS[type](ctx);
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
   * Export
   * ==================================================================== */

  var FigData = {
    UnsupportedChartError: UnsupportedChartError,
    supportsChartType: supportsChartType,
    supportedChartTypes: supportedChartTypes,
    CAPABILITY_TYPES: CAPABILITY_TYPES.slice(),
    templateCapability: templateCapability,
    templateCapabilities: templateCapabilities,
    parseCSV: parseCSV,
    parseJSON: parseJSON,
    columnStats: columnStats,
    inferChartType: inferChartType,
    makeChartElement: makeChartElement,
    renderChartSVG: renderChartSVG,
    getChartPoints: getChartPoints,
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
