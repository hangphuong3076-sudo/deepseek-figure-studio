/*
 * science.js — FigScience（科学论证内核）
 *
 * nature-figure 风格的科学合同（scientific contract）与审计：
 *   - 合同存于 doc.meta.scientific_contract（经 FigOps 的 set_scientific_contract
 *     操作写入，保留历史与撤销；白名单/长度/结构校验的单一事实来源是
 *     ops.js 的 FigOps.SCIENTIFIC_CONTRACT.normalize，本文件委托它）。
 *   - 真实统计数据只存每个 chart 元素的 chart.statistics；合同的 statistics
 *     映射仅是提交/展示载体，应用时写入对应 chart 并不在 meta 里留镜像，
 *     避免两处失同步。readContract 返回的 statistics 永远由 chart 派生。
 *   - 误差线数学（SD/SEM/95CI/range、Student-t）的单一事实来源是 data.js
 *     （FigData.spreadStats / FigData.cellUncertainty / FigData.studentT975），
 *     本文件复用它们，不另建模型；缺失时退回本地等价实现。
 *   - 审计（reviewContext/audit）只报告事实缺口，绝不从颜色、数值或形状
 *     推断 SD/SEM/检验或结论；缺什么报什么，不代填默认值。
 *
 * 统一 API：
 *   FigScience.validateContract(input[, doc]) -> {ok, errors, warnings, contract}
 *   FigScience.readContract(doc)       -> 合同对象（statistics 由 chart 派生）
 *   FigScience.applyContract(doc, input, ctx?) -> {doc, changed, warnings}
 *   FigScience.panelCandidates(doc)    -> 按自然阅读顺序的面板候选
 *   FigScience.uncertainty(values, type) -> number|null   // SD/SEM/95CI 幅度、range 全宽
 *   FigScience.barUncertainty(ctx, category, group) -> number|null
 *   FigScience.reviewContext(doc)      -> {warnings:[{code,message,element_id?,severity?}]}
 *   FigScience.audit(doc)              -> {ok, scientific_ready, coverage, warnings, checks}
 *
 * 加载顺序：figdoc.js -> ops.js -> science.js -> palette.js -> presets.js -> data.js ...
 * （bridge.js 在 ops 之后、data 之前显式加载本文件。）
 *
 * 无构建、无模块系统、无第三方依赖；95CI 使用精确的 Student-t 双侧分位数
 * （不完全 Beta 连分式 + 二分求根），不用 z 近似代替。
 */
(function (global) {
  "use strict";

  // ------------------------------------------------------------------
  // 常量（与 ops.js 的 FigOps.SCIENTIFIC_CONTRACT 保持一致；ops 缺席时兜底）
  // ------------------------------------------------------------------

  var SCHEMA_VERSION = 1;

  var CONTRACT_KEYS = [
    "schema_version", "results_question", "figure_claim", "falsifier",
    "archetype", "hero_panel", "panels", "statistics"
  ];

  var ARCHETYPES = [
    "quantitative_grid", "schematic_led_composite",
    "image_plate_quant", "asymmetric_mixed"
  ];

  var PANEL_KEYS = [
    "element_id", "label", "sequence", "question", "evidence_role",
    "decisive_comparison", "unique_gain", "claim_dependency", "destination"
  ];

  var EVIDENCE_ROLES = [
    "setup", "example", "primary", "control", "decomposition",
    "stratification", "orthogonal", "perturbation", "boundary", "mechanistic"
  ];

  var DESTINATIONS = ["main", "extended", "other", "discard"];

  var STAT_KEYS = [
    "n_definition", "biological_replicates", "technical_replicates",
    "center", "spread", "uncertainty_source", "uncertainty_column",
    "test", "correction", "comparison", "p_value", "source_data",
    "unit_x", "unit_y"
  ];

  var SPREADS = ["SD", "SEM", "95CI", "range"];
  var UNCERTAINTY_SOURCES = ["replicates", "column"];

  // 柱图误差线当前承诺的渲染 scope
  var ERRORBAR_CHART_TYPES = ["bar", "bar_grouped"];

  var FONT_FLOOR_PT = 5;       // 字形物理下限（文献指南，非硬性规则）
  var SCRIPT_RATIO = 0.7;      // 数学上下标的近似渲染比例
  var LINE_WIDTH_FLOOR_PT = 0.3;
  var ERRORBAR_MIN_N = 2;      // SD/SEM/95CI 的最小样本数

  var ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

  // ------------------------------------------------------------------
  // 小工具
  // ------------------------------------------------------------------

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function clone(v) {
    if (v === undefined) return undefined;
    return JSON.parse(JSON.stringify(v));
  }

  function assertDoc(doc, fnName) {
    if (!isObj(doc) || !Array.isArray(doc.elements)) {
      throw new Error((fnName || "FigScience") + "：doc 须为含 elements 数组的文档对象");
    }
  }

  function catLabel(v) {
    if (v === null || v === undefined || v === "") return null;
    return String(v);
  }

  var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  function toNum(v) {
    if (typeof v === "number") return isFinite(v) ? v : NaN;
    if (typeof v === "string" && v.trim() !== "" && NUM_RE.test(v.trim())) {
      var n = Number(v);
      if (isFinite(n)) return n;
    }
    return NaN;
  }

  function contractEnums() {
    var sc = global.FigOps && global.FigOps.SCIENTIFIC_CONTRACT;
    if (sc) {
      return {
        keys: sc.KEYS || CONTRACT_KEYS,
        archetypes: sc.ARCHETYPES || ARCHETYPES,
        roles: sc.EVIDENCE_ROLES || EVIDENCE_ROLES,
        destinations: sc.DESTINATIONS || DESTINATIONS,
        panelKeys: sc.PANEL_KEYS || PANEL_KEYS,
        statKeys: sc.STATS_KEYS || STAT_KEYS,
        spreads: sc.SPREADS || SPREADS,
        sources: sc.SOURCES || UNCERTAINTY_SOURCES,
        schemaVersion: sc.SCHEMA_VERSION !== undefined ? sc.SCHEMA_VERSION : SCHEMA_VERSION
      };
    }
    return {
      keys: CONTRACT_KEYS, archetypes: ARCHETYPES, roles: EVIDENCE_ROLES,
      destinations: DESTINATIONS, panelKeys: PANEL_KEYS, statKeys: STAT_KEYS,
      spreads: SPREADS, sources: UNCERTAINTY_SOURCES, schemaVersion: SCHEMA_VERSION
    };
  }

  // ------------------------------------------------------------------
  // Student-t 双侧 0.975 分位数（本地兜底；优先用 FigData.studentT975）
  // ------------------------------------------------------------------

  function lgamma(x) {
    var g = [
      676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (x < 0.5) {
      return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    }
    var z = x - 1;
    var a = 0.99999999999980993;
    var t = z + 7.5;
    for (var i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
  }

  function betacf(a, b, x) {
    var MAXIT = 300, EPS = 3e-16, FPMIN = 1e-300;
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

  function betai(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) +
      a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
    return 1 - bt * betacf(b, a, 1 - x) / b;
  }

  function studentTCDF(t, df) {
    if (df <= 0) return NaN;
    if (t === 0) return 0.5;
    var x = df / (df + t * t);
    var p = 0.5 * betai(df / 2, 0.5, x); // 上尾概率 P(T > |t|)
    return t > 0 ? 1 - p : p;
  }

  function tcrit975(df) {
    if (!(df >= 1)) return NaN;
    var FD = global.FigData;
    if (FD && typeof FD.studentT975 === "function") return FD.studentT975(Math.floor(df));
    var lo = 0, hi = 1e4;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (studentTCDF(mid, df) < 0.975) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------
  // uncertainty(values, type)：SD / SEM / 95CI / range
  // 优先复用 FigData.spreadStats（单一事实来源）；混入缺失或非数值、
  // n < 2（range 除外）→ null。返回误差幅度：SD/SEM/95CI 为半宽，
  // range 为全宽（max-min）。
  // ------------------------------------------------------------------

  function uncertainty(values, type) {
    var FD = global.FigData;
    if (FD && typeof FD.spreadStats === "function") {
      var s = FD.spreadStats(values, type);
      if (!s) return null;
      if (type === "SD") return isFinite(s.sd) ? s.sd : null;
      if (type === "SEM" || type === "95CI") {
        return isFinite(s.mean) && isFinite(s.upper) ? s.upper - s.mean : null;
      }
      if (type === "range") return isFinite(s.upper) && isFinite(s.lower) ? s.upper - s.lower : null;
      return null;
    }
    // 本地兜底实现（语义与 FigData.spreadStats 一致）
    if (!Array.isArray(values)) return null;
    var nums = [];
    for (var i = 0; i < values.length; i++) {
      var v = toNum(values[i]);
      if (isNaN(v)) return null; // 含缺失/非数值的混合样本一律返回 null
      nums.push(v);
    }
    var n = nums.length;
    if (type === "range") {
      if (n < 1) return null;
      var mn = Infinity, mx = -Infinity;
      for (var r = 0; r < n; r++) {
        if (nums[r] < mn) mn = nums[r];
        if (nums[r] > mx) mx = nums[r];
      }
      return mx - mn;
    }
    if (n < ERRORBAR_MIN_N) return null;
    var sum = 0, j;
    for (j = 0; j < n; j++) sum += nums[j];
    var mean = sum / n;
    var ss = 0;
    for (j = 0; j < n; j++) ss += (nums[j] - mean) * (nums[j] - mean);
    var sd = Math.sqrt(ss / (n - 1)); // 样本标准差（n-1）
    if (type === "SD") return sd;
    if (type === "SEM") return sd / Math.sqrt(n);
    if (type === "95CI") {
      var t = tcrit975(n - 1);
      if (!isFinite(t)) return null;
      return t * sd / Math.sqrt(n);
    }
    return null;
  }

  // ------------------------------------------------------------------
  // barUncertainty(ctx, category, group)
  // ctx 为 renderChartSVG 的渲染上下文（至少含 chartSpec/columns/rows/mapping）。
  // 复用 FigData.cellUncertainty（与渲染同一套判定），返回该单元的误差
  // 幅度；无法可靠计算时返回 null，由 audit 给出中文告警（缺 n、列缺失、
  // 含缺失观测等），绝不静默补齐。
  //   - uncertainty_source=replicates：同 category(+group) 的原始重复观测
  //     计算 SD(n-1) / SEM=SD/√n / 95CI（精确 t）/ range(min…max)
  //   - uncertainty_source=column：用户申报列（statistics.uncertainty_column
  //     或 mapping.error）的绝对数据值，不乘任何百分比
  // ------------------------------------------------------------------

  function barUncertainty(ctx, category, group) {
    if (!isObj(ctx)) return null;
    var spec = ctx.chartSpec;
    var stats = spec && isObj(spec.statistics) ? spec.statistics : null;
    if (!stats) return null;
    var columns = Array.isArray(ctx.columns) ? ctx.columns : [];
    var rows = Array.isArray(ctx.rows) ? ctx.rows : [];
    var mapping = isObj(ctx.mapping) ? ctx.mapping : {};
    var FD = global.FigData;
    if (FD && typeof FD.cellUncertainty === "function") {
      var cell = FD.cellUncertainty(columns, rows, mapping, stats, String(category),
        (group === null || group === undefined) ? null : String(group));
      if (!cell || !cell.ok) return null;
      if (cell.spread === "range") {
        return isFinite(cell.upper) && isFinite(cell.lower) ? cell.upper - cell.lower : null;
      }
      if (typeof cell.half === "number" && isFinite(cell.half)) return cell.half;
      if (isFinite(cell.mean) && isFinite(cell.upper)) return cell.upper - cell.mean;
      return null;
    }
    // 本地兜底（与 FigData.cellUncertainty 判定语义一致）
    var source = stats.uncertainty_source;
    var spread = stats.spread;
    if (UNCERTAINTY_SOURCES.indexOf(source) < 0) return null;
    if (SPREADS.indexOf(spread) < 0) return null;
    function colIdx(name) {
      if (typeof name !== "string" || name === "") return -1;
      return columns.indexOf(name);
    }
    var xIdx = colIdx(mapping.x), yIdx = colIdx(mapping.y), gIdx = -1;
    if (xIdx < 0 || yIdx < 0) return null;
    if (group !== null && group !== undefined) {
      gIdx = colIdx(mapping.group);
      if (gIdx < 0) return null;
    }
    var cat = String(category);
    var grp = (group === null || group === undefined) ? null : String(group);
    var values = [], colVals = [], mixed = false, i, row;
    for (i = 0; i < rows.length; i++) {
      row = Array.isArray(rows[i]) ? rows[i] : [];
      var lab = catLabel(row[xIdx]);
      if (lab === null || lab !== cat) continue;
      if (grp !== null) {
        var gl = catLabel(row[gIdx]);
        if (gl === null || gl !== grp) continue;
      }
      var yv = toNum(row[yIdx]);
      if (isNaN(yv)) { mixed = true; continue; }
      values.push(yv);
      if (source === "column") {
        var colName = (typeof stats.uncertainty_column === "string" &&
          stats.uncertainty_column !== "") ? stats.uncertainty_column : mapping.error;
        var eIdx = colIdx(colName);
        if (eIdx < 0) return null;
        var ev = toNum(row[eIdx]);
        if (isNaN(ev)) { mixed = true; continue; }
        colVals.push(ev);
      }
    }
    if (mixed) return null;
    if (source === "column") {
      if (!colVals.length) return null;
      var uniq = {};
      for (var k = 0; k < colVals.length; k++) uniq[String(colVals[k])] = true;
      if (Object.keys(uniq).length !== 1) return null;
      return Math.abs(colVals[0]);
    }
    if (values.length < ERRORBAR_MIN_N) return null;
    return uncertainty(values, spread);
  }

  // ------------------------------------------------------------------
  // 合同校验：委托 FigOps.SCIENTIFIC_CONTRACT.normalize（单一事实来源），
  // ops.js 缺席时退回本地白名单检查。
  // ------------------------------------------------------------------

  function validateContract(input, doc) {
    var Ops = global.FigOps;
    if (Ops && Ops.SCIENTIFIC_CONTRACT && typeof Ops.SCIENTIFIC_CONTRACT.normalize === "function") {
      var norm = Ops.SCIENTIFIC_CONTRACT.normalize(input, doc);
      return { ok: norm.ok, errors: norm.errors || [], warnings: [], contract: norm.contract };
    }
    // 本地兜底：仅做保守结构检查（枚举与长度以本地常量为准）
    var E = contractEnums();
    var errors = [];
    if (!isObj(input)) {
      return { ok: false, errors: ["contract 必须是 JSON 对象"], warnings: [], contract: null };
    }
    var keys = Object.keys(input), i;
    for (i = 0; i < keys.length; i++) {
      if (E.keys.indexOf(keys[i]) < 0) errors.push("contract 含未知字段：" + keys[i]);
    }
    if (input.schema_version !== undefined && input.schema_version !== null &&
        input.schema_version !== E.schemaVersion) {
      errors.push("contract.schema_version 只支持 " + E.schemaVersion);
    }
    if (input.archetype !== undefined && input.archetype !== null && input.archetype !== "" &&
        E.archetypes.indexOf(input.archetype) < 0) {
      errors.push("archetype 必须是 " + E.archetypes.join("/") + " 之一");
    }
    if (input.panels !== undefined && input.panels !== null) {
      if (!Array.isArray(input.panels)) errors.push("panels 必须是数组");
      else {
        for (i = 0; i < input.panels.length; i++) {
          var p = input.panels[i];
          if (!isObj(p)) { errors.push("panels[" + i + "] 必须是对象"); continue; }
          var pk = Object.keys(p);
          for (var q = 0; q < pk.length; q++) {
            if (E.panelKeys.indexOf(pk[q]) < 0) errors.push("panels[" + i + "] 含未知字段：" + pk[q]);
          }
          if (p.evidence_role && E.roles.indexOf(p.evidence_role) < 0) {
            errors.push("panels[" + i + "].evidence_role 非法");
          }
          if (p.destination && E.destinations.indexOf(p.destination) < 0) {
            errors.push("panels[" + i + "].destination 非法");
          }
        }
      }
    }
    if (input.statistics !== undefined && input.statistics !== null) {
      if (!isObj(input.statistics)) {
        errors.push("statistics 必须是 {element_id: {...}} 映射对象");
      } else {
        var sids = Object.keys(input.statistics);
        for (i = 0; i < sids.length; i++) {
          var s = input.statistics[sids[i]];
          if (s === null) continue; // null 与 {} 均表示清除该图的统计对象
          if (!isObj(s)) { errors.push("statistics[" + sids[i] + "] 必须是对象或 null"); continue; }
          var sk = Object.keys(s);
          for (var r = 0; r < sk.length; r++) {
            if (E.statKeys.indexOf(sk[r]) < 0) {
              errors.push("statistics[" + sids[i] + "] 含未知字段：" + sk[r]);
            }
          }
          if (s.spread && E.spreads.indexOf(s.spread) < 0) {
            errors.push("statistics[" + sids[i] + "].spread 非法");
          }
          if (s.uncertainty_source && E.sources.indexOf(s.uncertainty_source) < 0) {
            errors.push("statistics[" + sids[i] + "].uncertainty_source 非法");
          }
        }
      }
    }
    return { ok: errors.length === 0, errors: errors, warnings: [], contract: null };
  }

  // ------------------------------------------------------------------
  // readContract：默认空轮廓与已存合同结构一致（schema_version=1、
  // 规范空值）；statistics 永远由 chart.statistics 派生（单一事实来源）。
  // ------------------------------------------------------------------

  function emptyContract() {
    return {
      schema_version: SCHEMA_VERSION,
      results_question: null,
      figure_claim: null,
      falsifier: null,
      archetype: null,
      hero_panel: null,
      panels: [],
      statistics: {}
    };
  }

  function readContract(doc) {
    assertDoc(doc, "FigScience.readContract");
    var out = emptyContract();
    var meta = isObj(doc.meta) ? doc.meta : {};
    var stored = isObj(meta.scientific_contract) ? meta.scientific_contract : null;
    if (stored) {
      out.schema_version = stored.schema_version !== undefined && stored.schema_version !== null
        ? stored.schema_version : SCHEMA_VERSION;
      var scalarKeys = ["results_question", "figure_claim", "falsifier", "archetype", "hero_panel"];
      for (var i = 0; i < scalarKeys.length; i++) {
        var k = scalarKeys[i];
        out[k] = stored[k] !== undefined && stored[k] !== null ? stored[k] : null;
      }
      out.panels = Array.isArray(stored.panels) ? clone(stored.panels) : [];
    }
    var elements = doc.elements;
    for (var j = 0; j < elements.length; j++) {
      var el = elements[j];
      if (!el || el.type !== "chart" || !isObj(el.chart)) continue;
      var st = el.chart.statistics;
      if (isObj(st) && Object.keys(st).length) {
        out.statistics[el.id] = clone(st);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // panelCandidates：自然阅读顺序（先上后下、同行先左后右），标签 a,b,c…
  // 纯几何排序，不做任何 AI 推断；candidates 仅供用户挑选与编辑。
  // ------------------------------------------------------------------

  function resolveTopLeft(doc, el) {
    var t = el.transform || { x: 0, y: 0, w: 0, h: 0 };
    var x = t.x, y = t.y;
    if (el.style && el.style.panelRelative === true && el.parent_id) {
      var p = global.FigDoc ? global.FigDoc.get(doc, el.parent_id) : null;
      if (p && p.type === "panel") {
        var lay = isObj(p.panelLayout) ? p.panelLayout : {};
        var pad = typeof lay.padding_mm === "number" ? lay.padding_mm : 0;
        var pt = p.transform || { x: 0, y: 0, w: 0, h: 0 };
        x = pt.x + pad + t.x * Math.max(0, pt.w - 2 * pad);
        y = pt.y + pad + t.y * Math.max(0, pt.h - 2 * pad);
      }
    }
    return { x: x, y: y };
  }

  function seqLabel(j) {
    var a = String.fromCharCode(97 + (j % 26));
    if (j < 26) return a;
    return String.fromCharCode(97 + (Math.floor(j / 26) - 1)) + a;
  }

  function panelCandidates(doc) {
    assertDoc(doc, "FigScience.panelCandidates");
    var els = [];
    for (var i = 0; i < doc.elements.length; i++) {
      var el = doc.elements[i];
      if (!el || (el.type !== "chart" && el.type !== "panel")) continue;
      if (el.visible === false) continue;
      var pos = resolveTopLeft(doc, el);
      els.push({ el: el, x: pos.x, y: pos.y });
    }
    els.sort(function (a, b) {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });
    var out = [];
    for (var j = 0; j < els.length; j++) {
      var e = els[j].el;
      out.push({
        element_id: e.id,
        label: seqLabel(j), // a,b,c…；>26 时 aa,ab,…，保证不重复
        sequence: j + 1,
        type: e.type,
        name: typeof e.name === "string" ? e.name : null
      });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // applyContract：经 FigOps.apply 走 set_scientific_contract 操作
  // （校验、历史与撤销语义都在 FigOps 内），这里只补追加溯源提示。
  // ------------------------------------------------------------------

  function applyContract(doc, input, ctx) {
    assertDoc(doc, "FigScience.applyContract");
    var Ops = global.FigOps;
    if (!Ops || typeof Ops.apply !== "function") {
      throw new Error("FigScience.applyContract 依赖 FigOps，请先加载 ops.js");
    }
    var v = validateContract(input, doc);
    if (!v.ok) {
      throw new Error("科学论证合同校验失败：" + v.errors.join("；"));
    }
    var op = { op: "set_scientific_contract", contract: input };
    var res = Ops.apply(doc, op, ctx || {});
    var warnings = [];
    var stats = isObj(input.statistics) ? input.statistics : {};
    var ids = Object.keys(stats);
    for (var i = 0; i < ids.length; i++) {
      var el = global.FigDoc && typeof global.FigDoc.get === "function"
        ? global.FigDoc.get(res.doc, ids[i]) : null;
      if (!el || el.type !== "chart" || !isObj(el.chart)) {
        warnings.push({
          code: "STATS_NOT_ATTACHED",
          message: "statistics 中 " + ids[i] + " 未写入任何 chart 元素（元素不存在或不是 chart），该组统计无处落地",
          element_id: ids[i],
          severity: "warning"
        });
      }
    }
    return { doc: res.doc, changed: res.changed, warnings: warnings };
  }

  // ------------------------------------------------------------------
  // reviewContext：审计告警（可与 FigPresets.check 叠加）
  // severity: "error" | "warning" | "info"
  // ------------------------------------------------------------------

  function pushW(list, code, message, element_id, severity) {
    var w = { code: code, message: message, severity: severity || "warning" };
    if (element_id) w.element_id = element_id;
    list.push(w);
    return w;
  }

  function statsBasePresent(st) {
    return isObj(st) && Object.keys(st).length > 0;
  }

  // 图面显著性标记探测：文本元素含 */ns/p=… 且与图表同容器或 20mm 内
  function significanceMarkNear(doc, chartEl) {
    var els = doc.elements || [];
    var t = isObj(chartEl.transform) ? chartEl.transform : null;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || el.type !== "text" || typeof el.text !== "string") continue;
      if (!/(^|[^A-Za-z0-9*])\*{1,3}([^A-Za-z0-9*]|$)/.test(el.text) &&
          !/p\s*[<=>]\s*0?\.\d+/i.test(el.text) &&
          !/(^|\s)ns($|[\s,.;])/i.test(el.text)) continue;
      if (el.parent_id && chartEl.parent_id && el.parent_id === chartEl.parent_id) {
        return el.text;
      }
      if (t && isObj(el.transform)) {
        var a = el.transform;
        var dx = Math.max(0, Math.max(t.x - (a.x + (a.w || 0)), a.x - (t.x + (t.w || 0))));
        var dy = Math.max(0, Math.max(t.y - (a.y + (a.h || 0)), a.y - (t.y + (t.h || 0))));
        if (Math.sqrt(dx * dx + dy * dy) <= 20) return el.text;
      }
    }
    return null;
  }

  // 沿 parent 链向上找最近的显式字号（数学 script 继承估计用）
  function nearestAncestorFontPt(doc, el) {
    var pid = el.parent_id;
    var guard = 0;
    while (pid && guard++ < 16) {
      var p = global.FigDoc && typeof global.FigDoc.get === "function"
        ? global.FigDoc.get(doc, pid) : null;
      if (!p) return null;
      if (isObj(p.style) && typeof p.style.fontSizePt === "number" &&
          isFinite(p.style.fontSizePt) && p.style.fontSizePt > 0) {
        return p.style.fontSizePt;
      }
      pid = p.parent_id;
    }
    return null;
  }

  function statsHasSummary(st) {    return (typeof st.center === "string" && st.center !== "") &&
      (typeof st.spread === "string" && st.spread !== "");
  }

  function statsHasN(st) {
    return (typeof st.n_definition === "string" && st.n_definition !== "") ||
      (typeof st.biological_replicates === "number" && isFinite(st.biological_replicates)) ||
      (typeof st.technical_replicates === "number" && isFinite(st.technical_replicates));
  }

  // cellUncertainty 失败原因 -> 中文（与 data.js 的 reason 集合一致）
  var CELL_REASON_ZH = {
    "missing-statistics": "未申报统计",
    "missing-source": "未申报误差来源（uncertainty_source）",
    "missing-spread": "未申报误差类型（spread）",
    "bad-spread": "误差类型非法",
    "mapping-missing": "mapping.x/mapping.y 引用的列不存在",
    "missing-column": "未申报误差列（uncertainty_column/mapping.error）",
    "column-not-found": "申报的误差列不存在",
    "column-no-value": "误差列在该单元没有数值",
    "column-ambiguous": "误差列在同一单元内数值不一致",
    "no-observations": "单元内没有有效观测",
    "mixed-values": "单元内含缺失或非数值观测",
    "insufficient-n": "n<2，不足以计算该误差类型"
  };

  // 逐单元计算误差线可用性，返回中文摘要（不可用单元列表）或 null
  function errorbarCellReport(chartSpec, stats) {
    var columns = chartSpec.data && isObj(chartSpec.data.inline)
      ? chartSpec.data.inline.columns : null;
    var rows = chartSpec.data && isObj(chartSpec.data.inline)
      ? chartSpec.data.inline.rows : null;
    if (!Array.isArray(columns) || !Array.isArray(rows)) return null;
    var mapping = isObj(chartSpec.mapping) ? chartSpec.mapping : {};
    var FD = global.FigData;
    var unavailable = [];
    var i, j;
    var hasCell = FD && typeof FD.cellUncertainty === "function";

    function check(cat, grp, label) {
      var cell = hasCell
        ? FD.cellUncertainty(columns, rows, mapping, stats, cat, grp)
        : { ok: barUncertainty({ chartSpec: chartSpec, columns: columns, rows: rows, mapping: mapping }, cat, grp) !== null ? { ok: true } : { ok: false, reason: "unavailable" } };
      if (!cell.ok) {
        var zh = CELL_REASON_ZH[cell.reason] || "无法可靠计算";
        unavailable.push(label + "（" + zh + "）");
      }
    }

    if (chartSpec.chartType === "bar_grouped") {
      var cats = {}, groups = {};
      var xIdx = columns.indexOf(mapping.x);
      var gIdx = columns.indexOf(mapping.group);
      if (xIdx < 0 || gIdx < 0) return "mapping.x/mapping.group 引用的列不存在";
      for (i = 0; i < rows.length; i++) {
        var xl = catLabel(rows[i][xIdx]);
        var gl = catLabel(rows[i][gIdx]);
        if (xl !== null) cats[xl] = true;
        if (gl !== null) groups[gl] = true;
      }
      var catKeys = Object.keys(cats), grpKeys = Object.keys(groups);
      for (i = 0; i < catKeys.length; i++) {
        for (j = 0; j < grpKeys.length; j++) {
          check(catKeys[i], grpKeys[j], "(" + catKeys[i] + "," + grpKeys[j] + ")");
        }
      }
    } else {
      var xIdx2 = columns.indexOf(mapping.x);
      if (xIdx2 < 0) return "mapping.x 引用的列不存在";
      var cats2 = {};
      for (i = 0; i < rows.length; i++) {
        var xl2 = catLabel(rows[i][xIdx2]);
        if (xl2 !== null) cats2[xl2] = true;
      }
      var catKeys2 = Object.keys(cats2);
      for (i = 0; i < catKeys2.length; i++) {
        check(catKeys2[i], null, catKeys2[i]);
      }
    }
    if (!unavailable.length) return null;
    return "以下单元的误差线无法计算、未绘制（不做静默补齐）：" + unavailable.join("、");
  }

  function reviewCharacterization(warnings, cel) {
    var charMeta = cel.chart && isObj(cel.chart.characterization)
      ? cel.chart.characterization : null;
    if (!charMeta) return;
    if (!charMeta.technique) {
      pushW(warnings, "CHAR_TECHNIQUE_MISSING",
        "图表 " + cel.id + " 声明了 characterization 但缺少 technique；不猜测谱学类型",
        cel.id, "warning");
    }
    var charHasFit = false;
    if (Array.isArray(charMeta.curves)) {
      for (var cc = 0; cc < charMeta.curves.length; cc++) {
        if (charMeta.curves[cc] && (charMeta.curves[cc].role === "fit" ||
            charMeta.curves[cc].role === "component")) charHasFit = true;
      }
    }
    if (charHasFit && !charMeta.fit_source) {
      pushW(warnings, "CHAR_FIT_SOURCE_MISSING",
        "图表 " + cel.id + " 声明了拟合/组分曲线列但未申报 fit_source；拟合来源不得推断或冒充软件输出",
        cel.id, "warning");
    }
    if (charMeta.normalize === "max_to_unity") {
      pushW(warnings, "CHAR_NORMALIZE_DECLARED",
        "图表 " + cel.id + " 申报了 max_to_unity 归一化（仅渲染时缩放，inline 原始数据不变）；归一化后纵轴无量纲，统计请用原始值",
        cel.id, "info");
    }
    if (typeof charMeta.offset_each_series === "number" && isFinite(charMeta.offset_each_series)) {
      pushW(warnings, "CHAR_OFFSET_POSITIONAL",
        "图表 " + cel.id + " 的 offset_each_series 仅作视觉堆叠位移（positional only）；位移后的差值不是数据，不得用于统计/显著性",
        cel.id, "info");
    }
  }

  function reviewContext(doc) {
    assertDoc(doc, "FigScience.reviewContext");
    var warnings = [];
    var contract = readContract(doc);
    var elements = doc.elements;
    var canvas = isObj(doc.canvas) ? doc.canvas : {};

    // --- 合同三个根基：question / claim / falsifier ---
    if (!contract.results_question) {
      pushW(warnings, "MISSING_QUESTION", "缺少整图问题（results_question）：这张图要回答的科学问题尚未申报", null, "warning");
    }
    if (!contract.figure_claim) {
      pushW(warnings, "MISSING_CLAIM", "缺少图级声明（figure_claim）：该图支持的结论尚未申报", null, "warning");
    }
    if (!contract.falsifier) {
      pushW(warnings, "MISSING_FALSIFIER", "缺少反证/失效条件（falsifier）：什么结果会推翻该声明尚未申报", null, "warning");
    }

    // --- 面板逐一检查 ---
    var panels = contract.panels;
    var roleCounts = {};
    var anyComparison = false;
    var i, p;
    for (i = 0; i < panels.length; i++) {
      p = panels[i];
      var pid = p.element_id || ("panels[" + i + "]");
      var el = global.FigDoc && typeof global.FigDoc.get === "function"
        ? global.FigDoc.get(doc, p.element_id) : null;
      if (p.element_id && !el) {
        pushW(warnings, "PANEL_TARGET_MISSING",
          "面板 " + (p.label || pid) + " 绑定的元素 " + pid + " 不存在（可能已被删除）", pid, "warning");
      } else if (el && el.type !== "chart" && el.type !== "panel") {
        pushW(warnings, "PANEL_TARGET_NOT_CHART",
          "面板 " + (p.label || pid) + " 绑定的是 " + el.type + " 元素：导入 SVG 的统计口径无法识别，需人工标注 scope", pid, "warning");
      }
      if (!p.evidence_role) {
        pushW(warnings, "PANEL_MISSING_ROLE",
          "面板 " + (p.label || pid) + " 未申报证据角色（evidence_role）", pid, "warning");
      } else {
        roleCounts[p.evidence_role] = (roleCounts[p.evidence_role] || 0) + 1;
      }
      if (!p.unique_gain) {
        pushW(warnings, "PANEL_MISSING_GAIN",
          "面板 " + (p.label || pid) + " 未申报独立增益（unique_gain）：去掉该面板读者会失去什么", pid, "warning");
      }
      if (p.decisive_comparison) anyComparison = true;
      if (!p.destination) {
        pushW(warnings, "PANEL_MISSING_DESTINATION",
          "面板 " + (p.label || pid) + " 未申报去向（destination：main/extended/other/discard）", pid, "warning");
      }
    }

    // 相同证据角色且无独立增益的复核旗标（review，不强制判错）
    var dupRoles = [];
    var roleKeys = Object.keys(roleCounts);
    for (i = 0; i < roleKeys.length; i++) {
      if (roleCounts[roleKeys[i]] > 1) dupRoles.push(roleKeys[i]);
    }
    if (dupRoles.length) {
      pushW(warnings, "ROLE_DUPLICATE_REVIEW",
        "多个面板申报了相同证据角色（" + dupRoles.join("/") + "）：同一角色下可有相似指标，但请复核每个面板的独立增益（unique_gain），此项为人工复核提示而非错误",
        null, "warning");
    }

    // 多面板无比较组 → NOT_AUDITABLE（不可审计，非 PASS）
    if (panels.length >= 2 && !anyComparison) {
      pushW(warnings, "NOT_AUDITABLE",
        "多面板图（" + panels.length + " 个面板）未申报任何决定性比较（decisive_comparison），科学论证不可审计（NOT_AUDITABLE）",
        null, "error");
    }

    // hero_panel 必须是合同面板中仍存在的 chart/panel，不能只凭非空字符串通过。
    if (contract.hero_panel) {
      var heroDeclared = false;
      for (i = 0; i < panels.length; i++) {
        if (panels[i].element_id === contract.hero_panel) heroDeclared = true;
      }
      var heroEl = global.FigDoc && typeof global.FigDoc.get === "function"
        ? global.FigDoc.get(doc, contract.hero_panel) : null;
      if (!heroDeclared) {
        pushW(warnings, "HERO_PANEL_NOT_DECLARED",
          "hero_panel " + contract.hero_panel + " 不在合同 panels 中，主图引用不可审计",
          contract.hero_panel, "error");
      }
      if (!heroEl) {
        pushW(warnings, "HERO_PANEL_MISSING",
          "hero_panel 引用的元素 " + contract.hero_panel + " 不存在或已删除",
          contract.hero_panel, "error");
      } else if (heroEl.type !== "chart" && heroEl.type !== "panel") {
        pushW(warnings, "HERO_PANEL_TARGET_NOT_CHART",
          "hero_panel 引用的是 " + heroEl.type + " 元素，必须指向 chart/panel",
          contract.hero_panel, "error");
      }
    }

    // hero_panel 建议（不做 AI 推断，仅基于已申报的角色）
    if (panels.length > 0 && !contract.hero_panel) {
      var primary = null;
      for (i = 0; i < panels.length; i++) {
        if (panels[i].evidence_role === "primary") { primary = panels[i]; break; }
      }
      if (primary) {
        pushW(warnings, "HERO_PANEL_SUGGEST",
          "建议把申报了 primary 角色的面板 " + (primary.label || primary.element_id) + " 指定为主图（hero_panel）",
          primary.element_id, "info");
      } else {
        pushW(warnings, "HERO_PANEL_SUGGEST",
          "多面板图未指定 hero_panel，建议从面板中指定一张主图", null, "info");
      }
    }

    // --- 图表统计：追溯、单位、误差申报、显著性、误差线可用性 ---
    var hasAnyStats = false;
    for (i = 0; i < elements.length; i++) {
      var cel = elements[i];
      if (!cel || cel.type !== "chart" || !isObj(cel.chart)) continue;
      var st = cel.chart.statistics;
      var ctype = typeof cel.chart.chartType === "string" ? cel.chart.chartType : "";
      reviewCharacterization(warnings, cel);
      var declared = statsBasePresent(st);
      var dataReview = cel.chart.statistics_review;
      if (isObj(dataReview) && dataReview.status === "required") {
        var missingReview = Array.isArray(dataReview.missing) && dataReview.missing.length
          ? "；尚缺：" + dataReview.missing.join("、") : "";
        pushW(warnings, "DATA_STATS_REVIEW_REQUIRED",
          "图表 " + cel.id + " 的 inline 数据来源/版本已变更，旧统计声明原样保留但必须重新人工复核，不能直接视为仍适用" + missingReview,
          cel.id, "error");
      }

      if (!declared) {
        if (cel.chart.data && isObj(cel.chart.data.inline) &&
            Array.isArray(cel.chart.data.inline.rows) && cel.chart.data.inline.rows.length) {
          pushW(warnings, "STATS_NO_TRACE",
            "图表 " + cel.id + "（" + ctype + "）有内联数据但未申报统计（n/center/spread），数据→图的溯源缺失",
            cel.id, "warning");
        }
        continue;
      }
      hasAnyStats = true;

      if (!statsHasN(st)) {
        pushW(warnings, "STATS_MISSING_N",
          "图表 " + cel.id + " 的统计缺少样本量申报（n_definition 或 biological_replicates/technical_replicates）；不得默认 n=3",
          cel.id, "warning");
      }
      if (!statsHasSummary(st)) {
        pushW(warnings, "STATS_MISSING_SUMMARY",
          "图表 " + cel.id + " 的统计缺少 center/spread 申报（中心量与离散度量）", cel.id, "warning");
      }
      if (!st.source_data) {
        pushW(warnings, "STATS_SOURCE_MISSING",
          "图表 " + cel.id + " 的统计未申报 source_data（原始数据来源），无法溯源", cel.id, "warning");
      }
      // 单位：优先 statistics.unit_x/unit_y；表征图（chart.characterization）
      // 已申报的 x_label/y_label 可作为单位回退（用户显式申报，含单位）。
      // 都缺失时如实报 UNIT_MISSING，绝不替用户猜测单位。
      var charMeta = (cel.chart.characterization &&
        typeof cel.chart.characterization === "object" &&
        !Array.isArray(cel.chart.characterization)) ? cel.chart.characterization : null;
      var unitX = st.unit_x || (charMeta &&
        typeof charMeta.x_label === "string" && charMeta.x_label ? charMeta.x_label : null);
      var unitY = st.unit_y || (charMeta &&
        typeof charMeta.y_label === "string" && charMeta.y_label ? charMeta.y_label : null);
      if (!unitX || !unitY) {
        var missingUnits = [];
        if (!unitX) missingUnits.push("unit_x");
        if (!unitY) missingUnits.push("unit_y");
        pushW(warnings, "UNIT_MISSING",
          "图表 " + cel.id + " 的统计缺少坐标单位（" + missingUnits.join("、") +
          " 缺失，表征轴标签也未申报）；不得替用户猜测单位",
          cel.id, "warning");
      } else if (charMeta && (!st.unit_x || !st.unit_y)) {
        pushW(warnings, "CHAR_UNIT_FALLBACK",
          "图表 " + cel.id + " 的统计缺 unit_x/unit_y，审计单位由 characterization 轴标签补齐" +
            "（x: " + unitX + "；y: " + unitY + "；来源为用户申报的轴标签，非推断）",
          cel.id, "info");
      }
      // 表征元数据告警已在统计分支之前统一检查，缺统计不会遮蔽拟合来源问题。
      if (st.uncertainty_source && !st.spread) {
        pushW(warnings, "UNCERTAINTY_SOURCE_WITHOUT_SPREAD",
          "图表 " + cel.id + " 申报了误差来源（uncertainty_source=" + st.uncertainty_source + "）但未申报误差类型（spread：SD/SEM/95CI/range）",
          cel.id, "warning");
      }
      if (st.p_value !== undefined && st.p_value !== null &&
          (!st.test || !st.correction || !st.comparison)) {
        pushW(warnings, "SIGNIFICANCE_WITHOUT_TEST",
          "图表 " + cel.id + " 申报了 p_value 但缺少检验设置（test/correction/comparison），显著性声明不可追溯",
          cel.id, "error");
      }
      // 图面显著性标记（*/ns/p=…）但检验设置缺失：不能从图面推断检验
      if ((!st.test || !st.comparison) &&
          (st.p_value === undefined || st.p_value === null)) {
        var mark = significanceMarkNear(doc, cel);
        if (mark) {
          pushW(warnings, "SIGNIFICANCE_MARK_WITHOUT_TEST",
            "图表 " + cel.id + " 附近有显著性标记（\"" + mark + "\"），但统计缺少 test/correction/comparison 声明（不得从颜色/形状/标记推断检验）",
            cel.id, "error");
        }
      }
      // 误差线 scope 与可用性（仅 bar/bar_grouped 在承诺范围内）
      if (st.uncertainty_source) {
        if (ERRORBAR_CHART_TYPES.indexOf(ctype) < 0) {
          pushW(warnings, "SCOPE_NOT_COVERED",
            "图表 " + cel.id + " 的类型为 " + (ctype || "未知") + "：误差线渲染当前只承诺 bar/bar_grouped，该图不视为已覆盖（not covered，不判 PASS）",
            cel.id, "warning");
        } else {
          var cellWarn = errorbarCellReport(cel.chart, st);
          if (cellWarn) {
            pushW(warnings, "ERRORBAR_CELL_UNAVAILABLE",
              "图表 " + cel.id + "：" + cellWarn,
              cel.id, "warning");
          }
        }
      }
    }

    // 统计声明边界：永远提示（无论是否已申报统计）
    pushW(warnings, "STATS_INFERENCE_DISCLAIMER",
      "统计摘要（SD/SEM/95CI/检验）只能来自用户申报的原始数据与检验设置；不能从颜色、数值大小或形状推断 SD、SEM、检验或结论",
      null, "info");

    // 导入 SVG 等纯图元文档：统计无法识别，如实标注 scope（不判 PASS）
    var chartCountAll = 0;
    for (i = 0; i < elements.length; i++) {
      if (elements[i] && elements[i].type === "chart") chartCountAll++;
    }
    if (chartCountAll === 0 && elements.length >= 3) {
      pushW(warnings, "SVG_IMPORT_SCOPE",
        "文档没有 chart 元素（可能是导入的 SVG 图元）：统计无法识别，审计 scope 仅覆盖 chart 元素，此处 not covered（非 PASS）",
        null, "info");
    }

    // --- 物理尺寸：字号下限、数学 script 风险、线宽、元素越界 ---
    var W = typeof canvas.width_mm === "number" ? canvas.width_mm : null;
    var H = typeof canvas.height_mm === "number" ? canvas.height_mm : null;
    for (i = 0; i < elements.length; i++) {
      var el2 = elements[i];
      if (!el2) continue;
      var stl = isObj(el2.style) ? el2.style : null;
      var fs = stl ? stl.fontSizePt : undefined;
      if (typeof fs === "number" && isFinite(fs) && fs > 0) {
        var script = stl.script;
        var isScript = script === "sub" || script === "super" ||
          script === "subscript" || script === "superscript";
        if (isScript && fs * SCRIPT_RATIO < FONT_FLOOR_PT) {
          pushW(warnings, "SCRIPT_FONT_RISK",
            "元素 " + el2.id + " 为数学 script 文本：" + fs + "pt×" + SCRIPT_RATIO + "=" +
              (Math.round(fs * SCRIPT_RATIO * 100) / 100) + "pt，低于 " + FONT_FLOOR_PT + "pt 字形下限",
            el2.id, "warning");
        } else if (!isScript && el2.type === "text" && fs < FONT_FLOOR_PT) {
          pushW(warnings, "FONT_TOO_SMALL",
            "文本元素 " + el2.id + " 字号 " + fs + "pt 低于 " + FONT_FLOOR_PT + "pt 字形物理下限（文献指南）",
            el2.id, "warning");
        }
      } else if (el2.type === "text" && stl &&
                 (stl.script === "sub" || stl.script === "super" ||
                  stl.script === "subscript" || stl.script === "superscript")) {
        // 未显式声明字号的数学 script：按 parent 字号 × 0.7 估计渲染尺寸
        var parentPt = nearestAncestorFontPt(doc, el2);
        if (parentPt != null && parentPt * SCRIPT_RATIO < FONT_FLOOR_PT) {
          pushW(warnings, "SCRIPT_FONT_RISK",
            "数学 script 文本 " + el2.id + " 无显式字号，按 parent " + parentPt + "pt×" + SCRIPT_RATIO + "=" +
              (Math.round(parentPt * SCRIPT_RATIO * 100) / 100) + "pt 渲染，低于 " + FONT_FLOOR_PT + "pt 字形下限",
            el2.id, "warning");
        }
      }
      var sw = stl ? stl.strokeWidthPt : undefined;
      if (typeof sw === "number" && isFinite(sw) && sw > 0 && sw < LINE_WIDTH_FLOOR_PT) {
        pushW(warnings, "LINE_WIDTH_TOO_SMALL",
          "元素 " + el2.id + " 线宽 " + sw + "pt 低于 " + LINE_WIDTH_FLOOR_PT + "pt（印刷可见性）",
          el2.id, "warning");
      }
      // 元素越界（bbox 超出画布）
      if (W !== null && H !== null) {
        var bb = null;
        if (global.FigDoc && typeof global.FigDoc.bbox === "function") {
          try { bb = global.FigDoc.bbox(doc, el2.id, { recursive: true }); } catch (e) { bb = null; }
        }
        if (!bb && isObj(el2.transform)) {
          var t2 = el2.transform;
          bb = { x: t2.x, y: t2.y, w: t2.w, h: t2.h };
        }
        if (bb && isFinite(bb.x) && isFinite(bb.y) && isFinite(bb.w) && isFinite(bb.h)) {
          var eps = 1e-6;
          if (bb.x < -eps || bb.y < -eps ||
              bb.x + bb.w > W + eps || bb.y + bb.h > H + eps) {
            pushW(warnings, "ELEMENT_OUT_OF_CANVAS",
              "元素 " + el2.id + " 的边界（" +
                [bb.x, bb.y, bb.x + bb.w, bb.y + bb.h].map(function (n) {
                  return Math.round(n * 100) / 100;
                }).join(", ") + "）超出画布 " + W + "×" + H + "mm（溢出）",
              el2.id, "warning");
          }
        }
      }
    }

    return { warnings: warnings };
  }

  // ------------------------------------------------------------------
  // audit：reviewContext 的完整报告（coverage + checks + ready 判定）
  // ------------------------------------------------------------------

  function hasAnyComparison(contract) {
    for (var i = 0; i < contract.panels.length; i++) {
      if (contract.panels[i].decisive_comparison) return true;
    }
    return false;
  }

  function hasSignificanceError(warnings) {
    for (var i = 0; i < warnings.length; i++) {
      if (warnings[i].code === "SIGNIFICANCE_WITHOUT_TEST") return true;
    }
    return false;
  }

  function audit(doc) {
    var rc = reviewContext(doc);
    var warnings = rc.warnings;
    var contract = readContract(doc);

    var hasError = false;
    for (var i = 0; i < warnings.length; i++) {
      if (warnings[i].severity === "error") { hasError = true; break; }
    }

    // coverage：question / panels / statistics / final_size
    var panelsOk = contract.panels.length > 0;
    if (panelsOk) {
      for (i = 0; i < contract.panels.length; i++) {
        var p = contract.panels[i];
        if (!p.evidence_role || !p.unique_gain) { panelsOk = false; break; }
      }
    }
    var chartCount = 0;
    var statsCovered = 0;
    var elements = doc.elements || [];
    for (i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el || el.type !== "chart" || !isObj(el.chart)) continue;
      var chartType = typeof el.chart.chartType === "string" ? el.chart.chartType : "";
      if (!chartType || chartType.indexOf("diagram_") === 0) continue;
      chartCount++;
      var st = el.chart.statistics;
      var reviewPending = isObj(el.chart.statistics_review) && el.chart.statistics_review.status === "required";
      if (!reviewPending && isObj(st) && statsHasSummary(st) && statsHasN(st)) statsCovered++;
    }
    var statsOk = chartCount > 0 && statsCovered === chartCount;
    var heroOk = true;
    for (i = 0; i < warnings.length; i++) {
      if (warnings[i].code !== "HERO_PANEL_SUGGEST" &&
          warnings[i].code.indexOf("HERO_PANEL_") === 0) heroOk = false;
    }
    var canvas = isObj(doc.canvas) ? doc.canvas : {};
    var finalSizeOk = typeof canvas.width_mm === "number" && canvas.width_mm > 0 &&
      typeof canvas.height_mm === "number" && canvas.height_mm > 0 &&
      typeof canvas.dpi === "number" && canvas.dpi > 0;

    var coverage = {
      question: !!contract.results_question,
      panels: panelsOk,
      statistics: statsOk,
      hero_panel: heroOk,
      final_size: finalSizeOk
    };

    // scientific_ready：根基齐备 + 无 error 级告警（缺证据绝不假装通过）
    var multiPanelWithoutComparison = contract.panels.length >= 2 && !hasAnyComparison(contract);
    var ready = coverage.question && !!contract.figure_claim && !!contract.falsifier &&
      coverage.panels && coverage.statistics && coverage.hero_panel &&
      !multiPanelWithoutComparison && !hasError;

    var checks = [
      {
        name: "question_claim_falsifier",
        status: coverage.question && contract.figure_claim && contract.falsifier ? "pass" : "warn",
        detail: "整图问题/图级声明/反证条件" +
          (!coverage.question ? "：缺 results_question" : "") +
          (!contract.figure_claim ? "：缺 figure_claim" : "") +
          (!contract.falsifier ? "：缺 falsifier" : "")
      },
      {
        name: "panel_evidence_roles",
        status: contract.panels.length === 0 ? "na" : (panelsOk ? "pass" : "warn"),
        detail: contract.panels.length === 0
          ? "未配置任何面板：多面板论证审计不适用（不视为通过）"
          : contract.panels.length + " 个面板，逐一面板角色与独立增益" + (panelsOk ? "齐备" : "存在缺口")
      },
      {
        name: "decisive_comparisons",
        status: contract.panels.length < 2 ? "na" : (hasAnyComparison(contract) ? "pass" : "fail"),
        detail: contract.panels.length < 2
          ? "面板数 <2，比较组审计不适用"
          : (hasAnyComparison(contract) ? "已申报决定性比较" : "多面板无决定性比较 → NOT_AUDITABLE")
      },
      {
        name: "statistics_trace",
        status: chartCount === 0 ? "na" : (statsOk ? "pass" : "warn"),
        detail: chartCount === 0
          ? "文档内没有需要统计的 chart 元素"
          : statsCovered + "/" + chartCount + " 个 chart 已覆盖 n/center/spread 溯源" +
            (statsOk ? "，全部成立" : "，必须逐图补齐，不能由任一图替代其他图")
      },
      {
        name: "hero_panel_reference",
        status: heroOk ? "pass" : "fail",
        detail: contract.hero_panel
          ? (heroOk ? "hero_panel 已绑定合同中存在的 chart/panel" : "hero_panel 悬挂、未声明或类型非法")
          : "未指定 hero_panel（可建议，但不自动推断）"
      },
      {
        name: "significance_declarations",
        status: hasSignificanceError(warnings) ? "fail" : "pass",
        detail: hasSignificanceError(warnings)
          ? "存在 p_value 但 test/correction/comparison 缺失"
          : "显著性声明与检验设置一致（或未申报 p_value）"
      },
      {
        name: "physical_size",
        status: finalSizeOk ? "pass" : "warn",
        detail: finalSizeOk
          ? "画布 " + canvas.width_mm + "×" + canvas.height_mm + "mm @" + canvas.dpi + "dpi，物理尺寸检查可执行"
          : "画布宽/高/dpi 缺失或非法，物理尺寸检查不可执行"
      }
    ];

    return {
      ok: !hasError,
      scientific_ready: ready,
      coverage: coverage,
      warnings: warnings,
      checks: checks
    };
  }

  // ------------------------------------------------------------------
  // Export
  // ------------------------------------------------------------------

  var FigScience = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    ARCHETYPES: ARCHETYPES,
    EVIDENCE_ROLES: EVIDENCE_ROLES,
    DESTINATIONS: DESTINATIONS,
    SPREADS: SPREADS,
    UNCERTAINTY_SOURCES: UNCERTAINTY_SOURCES,
    STAT_KEYS: STAT_KEYS,
    PANEL_KEYS: PANEL_KEYS,
    CONTRACT_KEYS: CONTRACT_KEYS,
    ERRORBAR_CHART_TYPES: ERRORBAR_CHART_TYPES,
    validateContract: validateContract,
    readContract: readContract,
    emptyContract: emptyContract,
    applyContract: applyContract,
    panelCandidates: panelCandidates,
    uncertainty: uncertainty,
    barUncertainty: barUncertainty,
    reviewContext: reviewContext,
    audit: audit,
    studentTCDF: studentTCDF,
    tcrit975: tcrit975
  };

  global.FigScience = FigScience;
})(typeof globalThis !== "undefined" ? globalThis : this);
