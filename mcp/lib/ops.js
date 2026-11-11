/* =====================================================================
 * ops.js — FigOps
 *
 * The single mutation entry point for AI and UI. Every edit is expressed
 * as EditOp[] (see shared/schema/edit-op.schema.json), validated, applied
 * and recorded into doc.history. Undo / redo / revert prefer the
 * non-enumerable doc.__snapshots runtime cache, then replay events forward
 * from persisted meta.history_origin={rev,doc}; the origin contains neither
 * history nor recursive recovery/runtime/credential fields.
 *
 * Depends on FigDoc (figdoc.js, loaded first). FigPalette / FigPresets are
 * required only by the recolor / apply_template / apply_journal ops; FigDiagram
 * is required only by schematic/data-content operations.
 *
 * No build step, no module system, no third-party dependencies.
 * ===================================================================== */
(function (global) {
  "use strict";

  // ------------------------------------------------------------------
  // Runtime whitelist: base EditOps plus bundle schematic/data operations.
  // ------------------------------------------------------------------

  var OP_TYPES = [
    "move", "resize", "rotate", "set_text", "set_style", "set_color",
    "add_element", "delete", "group", "ungroup", "align", "distribute",
    "z_order", "add_anchor", "remove_anchor", "update_anchor",
    "apply_template", "apply_journal", "recolor", "panel_layout",
    "set_canvas", "note", "set_scientific_contract", "set_chart_properties",
    "apply_schematic", "layout_schematic", "set_chart_data"
  ];

  var MAX_HISTORY = 200;

  var ELEMENT_TYPES = ["rect", "ellipse", "line", "arrow", "path", "text",
    "image", "chart", "group", "panel", "connector"];
  var ALIGN_MODES = ["left", "center", "right", "top", "middle", "bottom"];
  var ORIENTATIONS = ["horizontal", "vertical"];
  var Z_ORDER_TO = ["front", "back", "forward", "backward"];
  var RECOLOR_STRATEGIES = ["byOrder", "byHue", "byRole"];

  // Ops that address existing elements through op.targets
  var TARGET_OPS = ["move", "resize", "rotate", "set_text", "set_style",
    "set_color", "delete", "group", "ungroup", "align", "distribute",
    "z_order", "panel_layout", "set_chart_properties", "set_chart_data"];

  // ------------------------------------------------------------------
  // set_chart_properties — chartSpec 白名单补丁（表征参数编辑的唯一入口）
  // 只允许 axes 的既有键与 characterization 的统一数据契约字段；从不触及
  // chartType 与 data.inline（原始数据永不被本操作改写）。
  // ------------------------------------------------------------------

  var CP_AXES_KEYS = ["xLabel", "yLabel", "xScale", "yScale", "gridlines"];
  var CP_AXES_SCALES = ["linear", "log"]; // 与 figure-document.schema.json 一致
  var CP_CHAR_KEYS = ["technique", "x_reverse", "x_scale", "x_label", "y_label",
    "curves", "fit_model", "fit_source", "peak_annotations", "normalize",
    "offset_each_series", "equal_aspect"];
  var CP_CURVE_KEYS = ["role", "column", "label"];
  var CP_CURVE_ROLES = ["fit", "component", "baseline"];
  var CP_CHAR_X_SCALES = ["linear", "log10"];
  var CP_CHAR_NORMALIZE = ["none", "max_to_unity"];
  // 来源申报固定值：拟合曲线必须来自用户已产生的拟合结果，而非本工具推断
  var CP_FIT_SOURCES = ["provided_by_user_fit"];

  var ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

  // ------------------------------------------------------------------
  // set_scientific_contract — 科学论证合同（lib/science.js 的持久层）
  // 统计数据的唯一来源是 chart.statistics；meta.scientific_contract 不留
  // statistics 镜像。字段白名单 + 合理长度限制，全部字段 optional。
  // ------------------------------------------------------------------

  var SC_CONTRACT_KEYS = [
    "schema_version", "results_question", "figure_claim", "falsifier",
    "archetype", "hero_panel", "panels", "statistics"
  ];
  var SC_ARCHETYPES = ["quantitative_grid", "schematic_led_composite",
    "image_plate_quant", "asymmetric_mixed"];
  var SC_EVIDENCE_ROLES = ["setup", "example", "primary", "control", "decomposition",
    "stratification", "orthogonal", "perturbation", "boundary", "mechanistic"];
  var SC_DESTINATIONS = ["main", "extended", "other", "discard"];
  var SC_PANEL_KEYS = ["element_id", "label", "sequence", "question", "evidence_role",
    "decisive_comparison", "unique_gain", "claim_dependency", "destination"];
  var SC_STATS_KEYS = ["n_definition", "biological_replicates", "technical_replicates",
    "center", "spread", "uncertainty_source", "uncertainty_column",
    "test", "correction", "comparison", "p_value", "source_data",
    "unit_x", "unit_y"];
  var SC_SPREADS = ["SD", "SEM", "95CI", "range"];
  var SC_SOURCES = ["replicates", "column"];
  var SC_LIMITS = {
    results_question: 500, figure_claim: 500, falsifier: 500,
    panel_label: 60, panel_question: 300, panel_comparison: 300,
    panel_gain: 300, panel_dependency: 300, stat_string: 200, hero_panel: 120,
    element_id: 120
  };
  var SC_SCHEMA_VERSION = 1;

  function scClamp(v, max) {
    if (v === undefined || v === null || v === "") return null;
    var s = String(v);
    return s.length > max ? s.slice(0, max) : s;
  }

  function scNum(v) {
    if (v === undefined || v === null || v === "") return null;
    var n = Number(v);
    return isFinite(n) && n >= 0 && Math.floor(n) === n ? n : null;
  }

  function scHas(input, key) {
    return Object.prototype.hasOwnProperty.call(input, key);
  }

  function currentScientificContract(doc) {
    var out = {
      schema_version: SC_SCHEMA_VERSION,
      results_question: null,
      figure_claim: null,
      falsifier: null,
      archetype: null,
      hero_panel: null,
      panels: [],
      statistics: {}
    };
    var meta = doc && doc.meta && typeof doc.meta === "object" ? doc.meta : {};
    var stored = meta.scientific_contract && typeof meta.scientific_contract === "object" &&
      !Array.isArray(meta.scientific_contract) ? meta.scientific_contract : {};
    var scalarKeys = ["results_question", "figure_claim", "falsifier", "archetype", "hero_panel"];
    out.schema_version = stored.schema_version != null ? stored.schema_version : SC_SCHEMA_VERSION;
    for (var i = 0; i < scalarKeys.length; i++) {
      var key = scalarKeys[i];
      if (stored[key] !== undefined) out[key] = deepCopy(stored[key]);
    }
    if (Array.isArray(stored.panels)) out.panels = deepCopy(stored.panels);
    var elements = doc && Array.isArray(doc.elements) ? doc.elements : [];
    for (var j = 0; j < elements.length; j++) {
      var el = elements[j];
      if (!el || el.type !== "chart" || !el.chart || typeof el.chart !== "object") continue;
      var st = el.chart.statistics;
      if (st && typeof st === "object" && !Array.isArray(st) && Object.keys(st).length) {
        out.statistics[el.id] = deepCopy(st);
      }
    }
    return out;
  }

  // Whitelist + clamp + structural checks. The result is the complete merged
  // view needed by validation/apply, but only explicitly supplied input fields
  // participate in the patch. A single chart statistics object is replaced as
  // a whole; null and {} clear it, and statistics:null clears every chart.
  function normalizeScientificContract(input, doc) {
    var errors = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, errors: ["set_scientific_contract 需要 contract 对象"], contract: null };
    }
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) {
      if (SC_CONTRACT_KEYS.indexOf(keys[i]) < 0) {
        errors.push("contract 含未知字段：" + keys[i]);
      }
    }
    if (input.schema_version !== undefined && input.schema_version !== null &&
        input.schema_version !== SC_SCHEMA_VERSION) {
      errors.push("contract.schema_version 只支持 " + SC_SCHEMA_VERSION);
    }
    var out = currentScientificContract(doc);
    if (scHas(input, "schema_version")) out.schema_version = SC_SCHEMA_VERSION;

    var scalarKeys = ["results_question", "figure_claim", "falsifier", "hero_panel"];
    for (i = 0; i < scalarKeys.length; i++) {
      var scalar = scalarKeys[i];
      if (scHas(input, scalar)) out[scalar] = scClamp(input[scalar], SC_LIMITS[scalar]);
    }
    if (scHas(input, "archetype")) {
      out.archetype = null;
      if (input.archetype !== undefined && input.archetype !== null && input.archetype !== "") {
        if (SC_ARCHETYPES.indexOf(input.archetype) < 0) {
          errors.push("archetype 必须是 " + SC_ARCHETYPES.join("/") + " 之一");
        } else {
          out.archetype = input.archetype;
        }
      }
    }
    if (scHas(input, "panels")) {
      out.panels = [];
      if (input.panels !== undefined && input.panels !== null && !Array.isArray(input.panels)) {
        errors.push("panels 必须是数组");
      }
      var panels = Array.isArray(input.panels) ? input.panels : [];
      for (var p = 0; p < panels.length; p++) {
        var raw = panels[p];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          errors.push("panels[" + p + "] 必须是对象");
          continue;
        }
        var pk = Object.keys(raw);
        for (var q = 0; q < pk.length; q++) {
          if (SC_PANEL_KEYS.indexOf(pk[q]) < 0) errors.push("panels[" + p + "] 含未知字段：" + pk[q]);
        }
        var panel = {
          element_id: scClamp(raw.element_id, SC_LIMITS.element_id),
          label: scClamp(raw.label, SC_LIMITS.panel_label),
          sequence: scNum(raw.sequence),
          question: scClamp(raw.question, SC_LIMITS.panel_question),
          evidence_role: scClamp(raw.evidence_role, 40),
          decisive_comparison: scClamp(raw.decisive_comparison, SC_LIMITS.panel_comparison),
          unique_gain: scClamp(raw.unique_gain, SC_LIMITS.panel_gain),
          claim_dependency: scClamp(raw.claim_dependency, SC_LIMITS.panel_dependency),
          destination: scClamp(raw.destination, 40)
        };
        if (panel.evidence_role !== null && SC_EVIDENCE_ROLES.indexOf(panel.evidence_role) < 0) {
          errors.push("panels[" + p + "].evidence_role 必须是 " + SC_EVIDENCE_ROLES.join("/") + " 之一");
        }
        if (panel.destination !== null && SC_DESTINATIONS.indexOf(panel.destination) < 0) {
          errors.push("panels[" + p + "].destination 必须是 " + SC_DESTINATIONS.join("/") + " 之一");
        }
        out.panels.push(panel);
      }
    }
    if (scHas(input, "statistics")) {
      var stats = input.statistics;
      if (stats === null) {
        out.statistics = {};
      } else if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
        errors.push("statistics 必须是 {element_id: {...}}、null 映射或 null");
      } else {
        var sids = Object.keys(stats);
        for (var s = 0; s < sids.length; s++) {
          var sid = sids[s];
          var rawS = stats[sid];
          if (rawS === null) {
            delete out.statistics[sid];
            continue;
          }
          if (!rawS || typeof rawS !== "object" || Array.isArray(rawS)) {
            errors.push("statistics[" + sid + "] 必须是对象或 null");
            continue;
          }
          var sk = Object.keys(rawS);
          for (var t = 0; t < sk.length; t++) {
            if (SC_STATS_KEYS.indexOf(sk[t]) < 0) errors.push("statistics[" + sid + "] 含未知字段：" + sk[t]);
          }
          var entry = {};
          for (var u = 0; u < SC_STATS_KEYS.length; u++) {
            var key = SC_STATS_KEYS[u];
            var val = rawS[key];
            if (val === undefined || val === null || val === "") continue;
            if (key === "biological_replicates" || key === "technical_replicates") {
              var nv = scNum(val);
              if (nv === null) errors.push("statistics[" + sid + "]." + key + " 必须是非负整数");
              else entry[key] = nv;
            } else if (key === "spread") {
              if (SC_SPREADS.indexOf(val) < 0) {
                errors.push("statistics[" + sid + "].spread 必须是 " + SC_SPREADS.join("/") + " 之一");
              } else entry[key] = val;
            } else if (key === "uncertainty_source") {
              if (SC_SOURCES.indexOf(val) < 0) {
                errors.push("statistics[" + sid + "].uncertainty_source 必须是 " + SC_SOURCES.join("/") + " 之一");
              } else entry[key] = val;
            } else {
              var sv = scClamp(val, SC_LIMITS.stat_string);
              if (sv !== null) entry[key] = sv;
            }
          }
          if (Object.keys(entry).length) out.statistics[sid] = entry;
          else delete out.statistics[sid];
        }
      }
    }
    return { ok: errors.length === 0, errors: errors, contract: out };
  }

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  function figdoc() {
    var F = global.FigDoc;
    if (!F) throw new Error("FigOps 依赖 FigDoc，请先加载 figdoc.js");
    return F;
  }

  function nowIso() { return new Date().toISOString(); }

  function safeStr(v) {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function cloneDoc(obj) {
    var c;
    if (typeof structuredClone === "function") {
      try { c = structuredClone(obj); } catch (e) { c = JSON.parse(JSON.stringify(obj)); }
    } else {
      c = JSON.parse(JSON.stringify(obj));
    }
    // __snapshots is a runtime cache and must never leak into copies.
    if (c && typeof c === "object" && Object.prototype.hasOwnProperty.call(c, "__snapshots")) {
      try { delete c.__snapshots; } catch (e) { /* ignore */ }
    }
    return c;
  }

  function deepCopy(obj) { return cloneDoc(obj); }

  function stableStringify(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    var t = typeof value;
    if (t === "number" || t === "boolean" || t === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    if (t === "object") {
      var keys = Object.keys(value).sort();
      return "{" + keys.map(function (k) {
        return JSON.stringify(k) + ":" + stableStringify(value[k]);
      }).join(",") + "}";
    }
    return String(value);
  }

  function deepEq(a, b) { return stableStringify(a) === stableStringify(b); }

  // ------------------------------------------------------------------
  // Snapshot cache (doc.__snapshots, non-enumerable runtime cache)
  // ------------------------------------------------------------------

  function getCache(doc) {
    if (!doc || typeof doc !== "object") return null;
    return doc.__snapshots || null;
  }

  function attachCache(doc, cache) {
    if (!doc || typeof doc !== "object" || !cache) return doc;
    try {
      Object.defineProperty(doc, "__snapshots", {
        value: cache, enumerable: false, configurable: true, writable: true
      });
    } catch (e) {
      try { doc.__snapshots = cache; } catch (e2) { /* ignore */ }
    }
    return doc;
  }

  function ensureCache(doc) {
    var c = getCache(doc);
    if (!c) { c = Object.create(null); attachCache(doc, c); }
    return c;
  }

  function assertDoc(doc) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error("doc 不能为空");
    }
    if (!Array.isArray(doc.elements)) throw new Error("doc.elements 必须是数组");
  }

  function lastRevOf(doc) {
    var hist = (doc && doc.history) || [];
    return hist.length ? (hist[hist.length - 1].rev || 0) : 0;
  }

  // The rev of the document content the caller currently sees. Revert
  // records (kind === "revert") are bookkeeping only, so the content
  // playhead jumps to their revert_to target.
  function contentRevOf(doc) {
    var hist = (doc && doc.history) || [];
    if (!hist.length) return 0;
    var rec = hist[hist.length - 1];
    var visited = Object.create(null);
    while (rec && rec.kind === "revert" && !visited[rec.rev]) {
      visited[rec.rev] = true;
      var t = rec.revert_to == null ? 0 : rec.revert_to;
      var next = null;
      for (var i = 0; i < hist.length; i++) {
        if (hist[i].rev === t) { next = hist[i]; break; }
      }
      if (!next) return t; // pruned record: fall back to the numeric rev
      rec = next;
    }
    return rec ? (rec.rev || 0) : 0;
  }

  // A persisted recovery checkpoint contains content, never another history
  // timeline or runtime/credential field. Build the JSON-shaped copy before
  // cloning so a DOM value (if supplied by a host app) is excluded by key.
  function checkpointCopy(value, root) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map(function (item) { return checkpointCopy(item, false); });
    }
    var out = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === "history_origin" || key === "__snapshots" ||
          key === "key" || key === "DOM" || key === "saveToken" ||
          (root && key === "history")) continue;
      out[key] = checkpointCopy(value[key], false);
    }
    return out;
  }

  // Return a document equipped with a durable replay base at its actual
  // content playhead. This is also the public API for storage/import code.
  function captureHistoryOrigin(doc, explicitRev) {
    assertDoc(doc);
    var rev = explicitRev === undefined || explicitRev === null
      ? contentRevOf(doc) : explicitRev;
    if (typeof rev !== "number" || !isFinite(rev) || Math.floor(rev) !== rev || rev < 0) {
      throw new Error("history_origin.rev 必须是非负整数");
    }
    var next = cloneDoc(doc);
    next.meta = next.meta || {};
    next.meta.history_origin = {
      rev: rev,
      doc: checkpointCopy(doc, true)
    };
    return next;
  }

  function historyOriginOf(doc) {
    var origin = doc && doc.meta && doc.meta.history_origin;
    if (origin === undefined || origin === null) return null;
    if (typeof origin !== "object" || Array.isArray(origin) ||
        typeof origin.rev !== "number" || !isFinite(origin.rev) ||
        Math.floor(origin.rev) !== origin.rev || origin.rev < 0 ||
        !origin.doc || typeof origin.doc !== "object" || Array.isArray(origin.doc) ||
        !Array.isArray(origin.doc.elements)) {
      throw new Error("meta.history_origin 持久化检查点无效，无法用于历史恢复");
    }
    return origin;
  }

  function inheritHistoryOrigin(target, source) {
    var origin = source && source.meta && source.meta.history_origin;
    if (!origin) return target;
    target.meta = target.meta || {};
    target.meta.history_origin = deepCopy(origin);
    return target;
  }

  // Forward replay starts at the persisted origin when an older version is
  // requested. Ops are not invertible, so a pre-origin target without an
  // exact runtime cache is always an explicit checkpoint-compatibility error.
  function ensureSnapshot(doc, rev, cache) {
    if (cache[rev] != null) return cache[rev];
    var P = contentRevOf(doc);
    var origin = historyOriginOf(doc);
    if (origin && rev < origin.rev) {
      throw new Error("无法恢复版本 " + rev + "：缺少该版本的 older cache；持久化 history_origin 检查点位于 rev " +
        origin.rev + "，目标早于检查点，不能从不完整历史伪造恢复");
    }
    if (rev === P) {
      cache[P] = cloneDoc(doc);
      return cache[P];
    }

    var state = null;
    var cur = null;
    if (rev > P) {
      state = cloneDoc(doc);
      cur = P;
    } else if (origin && origin.rev <= rev) {
      state = cloneDoc(origin.doc);
      cur = origin.rev;
    } else {
      throw new Error("无法恢复版本 " + rev +
        "：缺少可重放的 history_origin 持久化检查点或运行期快照，旧版本不能逆向恢复");
    }

    var hist = (doc.history || []).slice().sort(function (a, b) { return a.rev - b.rev; });
    for (var i = 0; i < hist.length; i++) {
      var r = hist[i];
      var rv = r.rev || 0;
      if (rv <= cur || rv > rev) continue;
      if (r.kind === "revert") {
        var t = r.revert_to == null ? 0 : r.revert_to;
        ensureSnapshot(doc, t, cache);
        state = cloneDoc(cache[t]);
      } else {
        if (r.base_rev != null && r.base_rev !== cur) {
          throw new Error("无法恢复版本 " + rev + "：从检查点 rev " + cur +
            " 向前重放失败，历史记录不连续");
        }
        var ops = r.ops || [];
        for (var j = 0; j < ops.length; j++) {
          state = apply(state, ops[j], {
            replay: true, ts: r.ts, source: r.source
          }).doc;
        }
        state.meta = state.meta || {};
        state.meta.updated = r.ts;
      }
      cur = rv;
    }
    if (cur === rev) {
      inheritHistoryOrigin(state, doc);
      cache[rev] = cloneDoc(state);
      return cache[rev];
    }
    throw new Error("无法恢复版本 " + rev + "：从检查点 rev " + cur +
      " 向前重放的历史不完整，缺少目标版本记录");
  }

  function copyCache(cache) {
    var copy = Object.create(null);
    if (!cache) return copy;
    for (var rev in cache) {
      if (Object.prototype.hasOwnProperty.call(cache, rev)) copy[rev] = cache[rev];
    }
    return copy;
  }

  function replaceCacheContents(target, source) {
    if (!target) return;
    for (var rev in target) {
      if (Object.prototype.hasOwnProperty.call(target, rev) &&
          !Object.prototype.hasOwnProperty.call(source, rev)) delete target[rev];
    }
    for (var next in source) {
      if (Object.prototype.hasOwnProperty.call(source, next)) target[next] = source[next];
    }
  }

  function requiredOriginRev(doc, hist) {
    var origin = historyOriginOf(doc);
    var current = origin ? origin.rev : 0;
    // Start with the oldest reference, not with the current origin: after
    // pruning rev1, rev2.base_rev (and any retained revert target) is the base
    // that must survive JSON serialization.
    var required = null;
    for (var j = 0; j < hist.length; j++) {
      var kept = hist[j] || {};
      var base = kept.kind === "revert"
        ? (kept.revert_to == null ? 0 : kept.revert_to) : kept.base_rev;
      if (typeof base !== "number" || !isFinite(base) || base < current) continue;
      if (required === null || base < required) required = base;
    }
    return required === null ? current : required;
  }

  // Check the exact retained timeline from its proposed durable origin. This
  // includes revert targets and post-origin base_rev links; no inverse ops are
  // inferred. The caller verifies a clone before deleting anything.
  function verifyRetainedHistory(doc) {
    var origin = historyOriginOf(doc);
    if (!origin) {
      throw new Error("缺少可持久化 history_origin，无法建立裁剪后的恢复基线");
    }
    var state = cloneDoc(origin.doc);
    var cur = origin.rev;
    var snapshots = Object.create(null);
    snapshots[cur] = cloneDoc(state);
    var hist = (doc.history || []).slice().sort(function (a, b) { return a.rev - b.rev; });
    for (var i = 0; i < hist.length; i++) {
      var rec = hist[i];
      var rev = rec.rev || 0;
      if (rev <= cur) continue;
      if (rec.kind === "revert") {
        var target = rec.revert_to == null ? 0 : rec.revert_to;
        if (snapshots[target] == null) {
          throw new Error("revert rev " + rev + " 仍需 rev " + target +
            "，但该恢复基线早于 origin 或没有真实文档");
        }
        state = cloneDoc(snapshots[target]);
      } else {
        if (rec.base_rev != null && rec.base_rev !== cur) {
          throw new Error("rev " + rev + " 的 base_rev=" + rec.base_rev +
            " 与恢复播放头 rev " + cur + " 不连续");
        }
        var ops = rec.ops || [];
        for (var j = 0; j < ops.length; j++) {
          state = apply(state, ops[j], {
            replay: true, ts: rec.ts, source: rec.source
          }).doc;
        }
        state.meta = state.meta || {};
        state.meta.updated = rec.ts;
      }
      cur = rev;
      snapshots[cur] = cloneDoc(state);
    }
  }

  function pruneHistory(work, cache) {
    var original = work.history || (work.history = []);
    if (original.length <= MAX_HISTORY) return;
    var planned = cloneDoc(work);
    var plannedCache = copyCache(cache);
    while (planned.history.length > MAX_HISTORY) {
      var idx = -1;
      for (var i = 0; i < planned.history.length; i++) {
        if (!planned.history[i].checkpoint) { idx = i; break; }
      }
      if (idx < 0) break; // all remaining records are checkpoints
      var remaining = planned.history.filter(function (rec, i) { return i !== idx; });
      var nextOriginRev = requiredOriginRev(planned, remaining);
      var oldOrigin = historyOriginOf(planned);
      var oldOriginRev = oldOrigin ? oldOrigin.rev : 0;
      var candidate = cloneDoc(planned);
      candidate.history = remaining;
      try {
        if (nextOriginRev > oldOriginRev || !oldOrigin) {
          var base = ensureSnapshot(planned, nextOriginRev, plannedCache);
          candidate.meta = candidate.meta || {};
          candidate.meta.history_origin = {
            rev: nextOriginRev,
            doc: checkpointCopy(base, true)
          };
        }
        verifyRetainedHistory(candidate);
      } catch (e) {
        throw new Error("无法裁剪历史：保留当前恢复能力所需的物化基线无法构造；" +
          "未删除历史或快照。原因：" + e.message);
      }
      planned = candidate;
      var keep = Object.create(null);
      keep[nextOriginRev] = true;
      for (var j = 0; j < remaining.length; j++) {
        var rec = remaining[j] || {};
        if (rec.rev != null) keep[rec.rev] = true;
        var ref = rec.kind === "revert"
          ? (rec.revert_to == null ? 0 : rec.revert_to) : rec.base_rev;
        if (ref != null) keep[ref] = true;
      }
      for (var rev in plannedCache) {
        if (!keep[rev]) delete plannedCache[rev];
      }
    }
    work.history = planned.history;
    if (planned.meta && planned.meta.history_origin) {
      work.meta = work.meta || {};
      work.meta.history_origin = planned.meta.history_origin;
    }
    replaceCacheContents(cache, plannedCache);
  }

  function touchDoc(work, ts) {
    work.meta = work.meta || {};
    work.meta.updated = ts || nowIso();
  }

  // ------------------------------------------------------------------
  // Element helpers
  // ------------------------------------------------------------------

  function getEl(doc, id) {
    var els = doc.elements;
    for (var i = 0; i < els.length; i++) if (els[i].id === id) return els[i];
    return null;
  }

  function findAnchor(doc, id) {
    var list = doc.anchors || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function maxZOf(doc, excludeId) {
    var z = 0;
    for (var i = 0; i < doc.elements.length; i++) {
      var el = doc.elements[i];
      if (excludeId != null && el.id === excludeId) continue;
      var ez = el.z || 0;
      if (ez > z) z = ez;
    }
    return z;
  }

  function minZOf(doc, excludeId) {
    var z = 0;
    for (var i = 0; i < doc.elements.length; i++) {
      var el = doc.elements[i];
      if (excludeId != null && el.id === excludeId) continue;
      var ez = el.z || 0;
      if (ez < z) z = ez;
    }
    return z;
  }

  function unionBbox(a, b) {
    var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
    var x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // Inner (padding-relative) rect of a panel, in mm.
  function panelInnerRect(panel) {
    var t = panel.transform || { x: 0, y: 0, w: 0, h: 0 };
    var pad = (panel.panelLayout && panel.panelLayout.padding_mm) || 0;
    return {
      x: t.x + pad,
      y: t.y + pad,
      w: Math.max(0.1, t.w - 2 * pad),
      h: Math.max(0.1, t.h - 2 * pad)
    };
  }

  function findParentPanelOf(doc, id) {
    var F = figdoc();
    var anc = F.ancestors(doc, id) || [];
    for (var i = 0; i < anc.length; i++) if (anc[i].type === "panel") return anc[i];
    return null;
  }

  // Shift an element by (dx, dy) mm and recursively shift its children.
  // Children listed in `skip` are not touched here (they are targets of
  // the same op and get shifted by their own iteration). Panel-relative
  // children keep their normalized geometry when an ancestor translates.
  function shiftRecursive(doc, el, dx, dy, skip) {
    var t = el.transform;
    if (!t || typeof t !== "object") t = el.transform = { x: 0, y: 0, w: 0, h: 0 };
    if (el.style && el.style.panelRelative === true) {
      var panel = findParentPanelOf(doc, el.id);
      if (panel) {
        var inner = panelInnerRect(panel);
        t.x += dx / (inner.w || 1);
        t.y += dy / (inner.h || 1);
      } else {
        t.x += dx; t.y += dy;
      }
    } else {
      t.x += dx; t.y += dy;
    }
    var F = figdoc();
    var kids = F.children(doc, el.id) || [];
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (!kid) continue;
      if (skip && skip.has(kid.id)) continue;
      if (kid.style && kid.style.panelRelative === true) continue;
      shiftRecursive(doc, kid, dx, dy, skip);
    }
  }

  function collectDescendants(map, id, out) {
    var el = map[id];
    if (!el || !Array.isArray(el.children)) return;
    for (var i = 0; i < el.children.length; i++) {
      var cid = el.children[i];
      if (out[cid]) continue;
      out[cid] = true;
      collectDescendants(map, cid, out);
    }
  }

  // Remove an element, its descendants, dangling children references and
  // anchor element_ids references (cascade, mirroring FigDoc semantics).
  function removeCascade(doc, id) {
    var F = figdoc();
    var doomed = Object.create(null);
    doomed[id] = true;
    var desc = F.descendants(doc, id, { includeSelf: false }) || [];
    for (var i = 0; i < desc.length; i++) doomed[desc[i].id] = true;
    var stranded = [];
    doc.elements.forEach(function (el) {
      if (!el || el.type !== "connector" || doomed[el.id] || !el.relation) return;
      var diagramId = el.diagramId || el.diagram_id;
      var missing = [el.relation.source, el.relation.target].some(function (ref) {
        if (doomed[ref]) return true;
        return doc.elements.some(function (node) {
          return node && node.type === "group" && node.diagramNodeId === ref &&
            (node.diagramId || node.diagram_id) === diagramId && doomed[node.id];
        });
      });
      if (!missing) return;
      stranded.push({ action: "remove_stranded_connector", connector_id: el.id,
        source: el.relation.source, target: el.relation.target, reason: "referenced node removed" });
      doomed[el.id] = true;
      if (typeof el.label_element_id === "string") doomed[el.label_element_id] = true;
    });
    if (stranded.length) {
      doc.meta = doc.meta || {};
      if (!Array.isArray(doc.meta.connector_audit)) doc.meta.connector_audit = [];
      doc.meta.connector_audit = doc.meta.connector_audit.concat(stranded);
    }
    var kept = [];
    for (var j = 0; j < doc.elements.length; j++) {
      if (!doomed[doc.elements[j].id]) kept.push(doc.elements[j]);
    }
    doc.elements = kept;
    for (var k = 0; k < doc.elements.length; k++) {
      var el = doc.elements[k];
      if (Array.isArray(el.children) && el.children.length) {
        el.children = el.children.filter(function (cid) { return !doomed[cid]; });
      }
    }
    var anchors = doc.anchors || [];
    for (var m = 0; m < anchors.length; m++) {
      if (Array.isArray(anchors[m].element_ids) && anchors[m].element_ids.length) {
        anchors[m].element_ids = anchors[m].element_ids.filter(function (cid) {
          return !doomed[cid];
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Target resolution
  // ------------------------------------------------------------------

  // targets item forms:
  //   "el-1"                 element id
  //   "@anchor-a"            anchor reference: its element_ids, or (when the
  //                          anchor has no element_ids) elements whose bbox
  //                          center falls inside the anchor bbox_mm
  //   {kind:"all"}           every element
  //   {kind:"type", type}    every element of that type
  // Returns a deduplicated list of element ids (input order preserved for
  // explicit ids, document order for selectors). Missing element ids are
  // passed through so that apply() can degrade to changed=false; missing
  // anchors contribute nothing.
  function resolveTargets(doc, targets) {
    assertDoc(doc);
    if (targets == null) return [];
    if (!Array.isArray(targets)) throw new Error("targets 必须是数组");
    var F = figdoc();
    var out = [];
    var seen = Object.create(null);
    function push(id) {
      if (id != null && !seen[id]) { seen[id] = true; out.push(id); }
    }
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (typeof t === "string") {
        if (t.charAt(0) === "@") {
          var anchor = findAnchor(doc, t.slice(1));
          if (!anchor) continue; // missing anchor: resolves to nothing
          var refIds = Array.isArray(anchor.element_ids) ? anchor.element_ids : [];
          if (refIds.length) {
            for (var j = 0; j < refIds.length; j++) {
              if (F.get(doc, refIds[j])) push(refIds[j]);
            }
          } else if (anchor.bbox_mm) {
            var bb = anchor.bbox_mm;
            var els = doc.elements || [];
            for (var k = 0; k < els.length; k++) {
              var b = F.bbox(doc, els[k].id, { recursive: true });
              if (!b) continue;
              var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
              if (cx >= bb.x && cx <= bb.x + bb.w && cy >= bb.y && cy <= bb.y + bb.h) {
                push(els[k].id);
              }
            }
          }
        } else {
          push(t);
        }
      } else if (t && typeof t === "object") {
        if (t.kind === "all") {
          for (var m = 0; m < doc.elements.length; m++) push(doc.elements[m].id);
        } else if (t.kind === "type") {
          var typed = F.byType(doc, t.type) || [];
          for (var n = 0; n < typed.length; n++) push(typed[n].id);
        } else {
          throw new Error("无法识别的选择器: " + safeStr(t));
        }
      } else {
        throw new Error("无法识别的目标: " + safeStr(t));
      }
    }
    return out;
  }

  function anchorIdFromOp(op) {
    if (op.anchor && op.anchor.id) return op.anchor.id;
    if (op.id) return op.id;
    if (Array.isArray(op.targets)) {
      for (var i = 0; i < op.targets.length; i++) {
        var t = op.targets[i];
        if (typeof t === "string" && t.charAt(0) === "@") return t.slice(1);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Op handlers (each mutates `work` and returns changed; except
  // opApplyJournal which returns {doc, changed})
  // ------------------------------------------------------------------

  function opMove(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var skip = new Set(ids);
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el || !el.transform) continue;
      var dx, dy;
      if (op.x != null || op.y != null) {
        var nx = op.x != null ? op.x : el.transform.x;
        var ny = op.y != null ? op.y : el.transform.y;
        dx = nx - el.transform.x;
        dy = ny - el.transform.y;
      } else {
        dx = op.dx || 0;
        dy = op.dy || 0;
      }
      if (dx === 0 && dy === 0) continue;
      shiftRecursive(doc, el, dx, dy, skip);
      if (el.diagramNodeId) {
        el.layout_override = true;
        el.diagram_manual_layout = true;
        el.declared_transform = deepCopy(el.transform);
        doc.meta = doc.meta || {};
        var stored = doc.meta.diagrams && doc.meta.diagrams[el.diagramId];
        if (stored) {
          if (!stored.layout_overrides) stored.layout_overrides = {};
          stored.layout_overrides[el.diagramNodeId] = deepCopy(el.transform);
        }
      }
      any = true;
    }
    return any;
  }

  function opResize(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el) continue;
      var t = el.transform;
      if (!t || typeof t !== "object") t = el.transform = { x: 0, y: 0, w: 0, h: 0 };
      if (op.w != null) { t.w = Math.max(0.1, op.w); any = true; }
      if (op.h != null) { t.h = Math.max(0.1, op.h); any = true; }
    }
    return any;
  }

  function opRotate(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el) continue;
      var t = el.transform;
      if (!t || typeof t !== "object") t = el.transform = { x: 0, y: 0, w: 0, h: 0 };
      if (op.rotation != null) {
        t.rotation = op.rotation;
        any = true;
      } else if (typeof op.angle === "number") {
        t.rotation = (t.rotation || 0) + op.angle;
        any = true;
      }
    }
    return any;
  }

  function opSetText(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el || el.type !== "text") continue; // set_text only applies to text
      el.text = op.text;
      any = true;
    }
    return any;
  }

  function opSetStyle(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var patch = op.style;
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el) continue;
      el.style = Object.assign({}, el.style || {}, patch);
      any = true;
    }
    return any;
  }

  function opSetColor(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el) continue;
      var st = el.style = Object.assign({}, el.style || {});
      if (op.color !== undefined) { st.fill = op.color; any = true; }
      if (op.stroke !== undefined) { st.stroke = op.stroke; any = true; }
    }
    return any;
  }

  function opAddElement(doc, op) {
    var src = op.element;
    if (!src || typeof src !== "object" || Array.isArray(src)) {
      throw new Error("add_element 缺少 element 对象");
    }
    if (!src.type || ELEMENT_TYPES.indexOf(src.type) < 0) {
      throw new Error("add_element 的元素类型非法: " + safeStr(src.type));
    }
    var el = deepCopy(src);
    el.id = el.id || op.id || figdoc().uid("el");
    op.element.id = el.id; // history/replay must retain the first normalized id
    if (!ID_PATTERN.test(el.id)) throw new Error("元素 id 含非法字符: " + el.id);
    if (getEl(doc, el.id)) throw new Error("元素 id 已存在: " + el.id);
    if (findAnchor(doc, el.id)) throw new Error("元素 id 与锚点 id 冲突: " + el.id);
    if (el.parent_id != null) {
      var parent = getEl(doc, el.parent_id);
      if (!parent) throw new Error("父元素不存在: " + el.parent_id);
      if (parent.type !== "group" && parent.type !== "panel") {
        throw new Error("父元素必须是 group 或 panel: " + el.parent_id);
      }
    }
    if (!el.transform || typeof el.transform !== "object") {
      throw new Error("add_element 的元素缺少 transform");
    }
    if (el.z == null) el.z = maxZOf(doc) + 1;
    doc.elements.push(el);
    if (el.parent_id != null) {
      var p = getEl(doc, el.parent_id);
      if (p) {
        if (!Array.isArray(p.children)) p.children = [];
        if (p.children.indexOf(el.id) < 0) p.children.push(el.id);
      }
    }
    return true;
  }

  function opDelete(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      if (!getEl(doc, ids[i])) continue;
      removeCascade(doc, ids[i]);
      any = true;
    }
    return any;
  }

  function opGroup(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var F = figdoc();
    // Drop ids that live inside another target: they follow their parent.
    var keep = ids.filter(function (id) {
      var anc = F.ancestors(doc, id) || [];
      var ancIds = anc.map(function (a) { return a.id; });
      return !ids.some(function (other) {
        return other !== id && ancIds.indexOf(other) >= 0;
      });
    });
    if (!keep.length) return false;
    var groupId = op.id || F.uid("group");
    if (!ID_PATTERN.test(groupId)) throw new Error("元素 id 含非法字符: " + groupId);
    if (getEl(doc, groupId)) throw new Error("元素 id 已存在: " + groupId);
    if (findAnchor(doc, groupId)) throw new Error("元素 id 与锚点 id 冲突: " + groupId);
    var members = keep.map(function (id) { return getEl(doc, id); })
      .filter(Boolean)
      .sort(function (a, b) { return (a.z || 0) - (b.z || 0); }); // stable: ties keep doc order
    if (!members.length) return false;
    var bb = null;
    for (var i = 0; i < members.length; i++) {
      var b = F.bbox(doc, members[i].id, { recursive: true });
      bb = bb ? unionBbox(bb, b) : { x: b.x, y: b.y, w: b.w, h: b.h };
    }
    var parents = members.map(function (m) { return m.parent_id || null; });
    var commonParent = parents.every(function (p) { return p === parents[0]; }) ? parents[0] : null;
    var maxZ = 0;
    for (var j = 0; j < members.length; j++) if ((members[j].z || 0) > maxZ) maxZ = members[j].z || 0;
    var group = {
      id: groupId,
      type: "group",
      transform: { x: bb.x, y: bb.y, w: bb.w, h: bb.h, rotation: 0 },
      children: members.map(function (m) { return m.id; }),
      z: maxZ + 1,
      parent_id: commonParent,
      style: {}
    };
    doc.elements.push(group);
    if (commonParent) {
      var p = getEl(doc, commonParent);
      if (p) {
        if (!Array.isArray(p.children)) p.children = [];
        p.children.push(groupId);
      }
    }
    for (var k = 0; k < members.length; k++) {
      var m = members[k];
      if (m.parent_id && m.parent_id !== groupId) {
        var old = getEl(doc, m.parent_id);
        if (old && Array.isArray(old.children)) {
          old.children = old.children.filter(function (cid) { return cid !== m.id; });
        }
      }
      m.parent_id = groupId;
    }
    return true;
  }

  function opUngroup(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el || (el.type !== "group" && el.type !== "panel")) continue;
      var grandParentId = el.parent_id || null;
      var kids = Array.isArray(el.children) ? el.children.slice() : [];
      for (var j = 0; j < kids.length; j++) {
        var child = getEl(doc, kids[j]);
        if (!child) continue;
        // Panel-relative children must be converted to world mm coordinates.
        if (child.style && child.style.panelRelative === true && el.type === "panel") {
          var inner = panelInnerRect(el);
          var t = child.transform || (child.transform = { x: 0, y: 0, w: 0, h: 0 });
          child.transform = {
            x: inner.x + t.x * inner.w,
            y: inner.y + t.y * inner.h,
            w: t.w * inner.w,
            h: t.h * inner.h,
            rotation: t.rotation || 0
          };
          child.style = Object.assign({}, child.style);
          child.style.panelRelative = false;
        }
        child.parent_id = grandParentId;
        if (grandParentId) {
          var gp = getEl(doc, grandParentId);
          if (gp) {
            if (!Array.isArray(gp.children)) gp.children = [];
            if (gp.children.indexOf(child.id) < 0) gp.children.push(child.id);
          }
        }
      }
      doc.elements = doc.elements.filter(function (e) { return e.id !== el.id; });
      if (grandParentId) {
        var p = getEl(doc, grandParentId);
        if (p && Array.isArray(p.children)) {
          p.children = p.children.filter(function (cid) { return cid !== el.id; });
        }
      }
      var anchors = doc.anchors || [];
      for (var m = 0; m < anchors.length; m++) {
        if (Array.isArray(anchors[m].element_ids)) {
          anchors[m].element_ids = anchors[m].element_ids.filter(function (cid) {
            return cid !== el.id;
          });
        }
      }
      any = true;
    }
    return any;
  }

  function opAlign(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var F = figdoc();
    var rects = [];
    for (var i = 0; i < ids.length; i++) {
      if (!getEl(doc, ids[i])) continue;
      rects.push({ id: ids[i], bb: F.bbox(doc, ids[i], { recursive: true }) });
    }
    if (!rects.length) return false;
    var target;
    if (rects.length === 1) {
      // A single target aligns to the canvas.
      target = { x: 0, y: 0, w: doc.canvas.width_mm, h: doc.canvas.height_mm };
    } else {
      target = rects[0].bb;
      for (var j = 1; j < rects.length; j++) target = unionBbox(target, rects[j].bb);
    }
    var skip = new Set(ids);
    var any = false;
    for (var k = 0; k < rects.length; k++) {
      var r = rects[k];
      var dx = 0, dy = 0;
      switch (op.mode) {
        case "left": dx = target.x - r.bb.x; break;
        case "center": dx = (target.x + target.w / 2) - (r.bb.x + r.bb.w / 2); break;
        case "right": dx = (target.x + target.w) - (r.bb.x + r.bb.w); break;
        case "top": dy = target.y - r.bb.y; break;
        case "middle": dy = (target.y + target.h / 2) - (r.bb.y + r.bb.h / 2); break;
        case "bottom": dy = (target.y + target.h) - (r.bb.y + r.bb.h); break;
      }
      if (dx === 0 && dy === 0) continue;
      var el = getEl(doc, r.id);
      if (!el) continue;
      shiftRecursive(doc, el, dx, dy, skip);
      any = true;
    }
    return any;
  }

  function opDistribute(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (ids.length < 3) return false; // takes effect with 3+ targets only
    var F = figdoc();
    var vertical = op.orientation === "vertical";
    var key = vertical ? "y" : "x";
    var sizeKey = vertical ? "h" : "w";
    var items = [];
    for (var i = 0; i < ids.length; i++) {
      if (!getEl(doc, ids[i])) continue;
      items.push({ id: ids[i], bb: F.bbox(doc, ids[i], { recursive: true }) });
    }
    if (items.length < 3) return false;
    items.sort(function (a, b) { return a.bb[key] - b.bb[key]; });
    var first = items[0], last = items[items.length - 1];
    var span = (last.bb[key] + last.bb[sizeKey]) - first.bb[key];
    var sum = 0;
    for (var j = 0; j < items.length; j++) sum += items[j].bb[sizeKey];
    var gap = (span - sum) / (items.length - 1);
    var skip = new Set(ids);
    var any = false;
    var cursor = first.bb[key] + first.bb[sizeKey];
    for (var k = 1; k < items.length - 1; k++) {
      var desired = cursor + gap;
      var delta = desired - items[k].bb[key];
      if (delta !== 0) {
        var el = getEl(doc, items[k].id);
        if (el) {
          if (vertical) shiftRecursive(doc, el, 0, delta, skip);
          else shiftRecursive(doc, el, delta, 0, skip);
          any = true;
        }
      }
      cursor = desired + items[k].bb[sizeKey];
    }
    return any;
  }

  function opZOrder(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el) continue;
      var oldZ = el.z || 0;
      if (op.to === "front") {
        var nz = maxZOf(doc, el.id) + 1;
        if (nz !== oldZ) { el.z = nz; any = true; }
      } else if (op.to === "back") {
        var bz = minZOf(doc, el.id) - 1;
        if (bz !== oldZ) { el.z = bz; any = true; }
      } else {
        var dir = op.to === "forward" ? 1 : -1;
        var cands = [];
        for (var j = 0; j < doc.elements.length; j++) {
          var other = doc.elements[j];
          if (other.id === el.id) continue;
          var oz = other.z || 0;
          if (dir === 1 ? oz > oldZ : oz < oldZ) cands.push(other);
        }
        if (!cands.length) continue; // already at the edge
        var best = dir === 1 ? Infinity : -Infinity;
        for (var k = 0; k < cands.length; k++) {
          var cz = cands[k].z || 0;
          if (dir === 1 ? cz < best : cz > best) best = cz;
        }
        var swap = null;
        for (var m = 0; m < doc.elements.length; m++) {
          if (doc.elements[m] !== el && (doc.elements[m].z || 0) === best) { swap = doc.elements[m]; break; }
        }
        el.z = best;
        if (swap) swap.z = oldZ;
        any = true;
      }
    }
    return any;
  }

  function opAddAnchor(doc, op) {
    var a = op.anchor ? deepCopy(op.anchor) : {};
    a.id = a.id || op.id || figdoc().uid("anchor");
    if (findAnchor(doc, a.id)) throw new Error("锚点 id 已存在: " + a.id);
    var W = doc.canvas.width_mm, H = doc.canvas.height_mm;
    if (!a.bbox_mm && a.bbox_norm) {
      a.bbox_mm = {
        x: a.bbox_norm.x * W, y: a.bbox_norm.y * H,
        w: a.bbox_norm.w * W, h: a.bbox_norm.h * H
      };
    } else if (!a.bbox_norm && a.bbox_mm) {
      a.bbox_norm = {
        x: a.bbox_mm.x / W, y: a.bbox_mm.y / H,
        w: a.bbox_mm.w / W, h: a.bbox_mm.h / H
      };
    } else if (!a.bbox_mm && !a.bbox_norm) {
      throw new Error("add_anchor 需要 bbox_mm 或 bbox_norm");
    }
    if (!Array.isArray(doc.anchors)) doc.anchors = [];
    doc.anchors.push(a);
    return true;
  }

  function opRemoveAnchor(doc, op) {
    var aid = anchorIdFromOp(op);
    if (!aid) return false;
    var list = doc.anchors || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === aid) {
        list.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function opUpdateAnchor(doc, op) {
    var aid = anchorIdFromOp(op);
    if (!aid) return false;
    var a = findAnchor(doc, aid);
    if (!a) return false;
    var patch = op.anchor || {};
    var touchedBboxNorm = false, touchedBboxMm = false;
    for (var key in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      if (key === "id") continue;
      a[key] = deepCopy(patch[key]);
      if (key === "bbox_norm") touchedBboxNorm = true;
      if (key === "bbox_mm") touchedBboxMm = true;
    }
    // Keep the two bbox representations consistent after a partial update.
    var W = doc.canvas.width_mm, H = doc.canvas.height_mm;
    if (touchedBboxNorm && !touchedBboxMm && a.bbox_norm) {
      a.bbox_mm = {
        x: a.bbox_norm.x * W, y: a.bbox_norm.y * H,
        w: a.bbox_norm.w * W, h: a.bbox_norm.h * H
      };
    } else if (touchedBboxMm && !touchedBboxNorm && a.bbox_mm) {
      a.bbox_norm = {
        x: a.bbox_mm.x / W, y: a.bbox_mm.y / H,
        w: a.bbox_mm.w / W, h: a.bbox_mm.h / H
      };
    }
    return true;
  }

  function templateApplicability(templateId) {
    var GP = global.FigPresets;
    if (!GP || typeof GP.validateTemplateCapability !== "function") {
      return { ok: false, errors: ["FigPresets 模板能力注册未加载，拒绝应用模板"], capability: null };
    }
    try {
      var verdict = GP.validateTemplateCapability(templateId);
      if (!verdict || typeof verdict.ok !== "boolean" || !Array.isArray(verdict.errors)) {
        return { ok: false, errors: ["模板能力注册返回无效结果，拒绝应用模板"], capability: null };
      }
      return verdict;
    } catch (e) {
      return { ok: false, errors: ["模板能力校验失败：" + e.message], capability: null };
    }
  }

  function materializedTemplate(op) {
    var mat = op.materialized_template;
    if (mat === undefined || mat === null) return null;
    if (typeof mat !== "object" || Array.isArray(mat) || !Array.isArray(mat.elements) ||
        !mat.elements.length) {
      throw new Error("materialized_template 必须包含非空 elements 数组");
    }
    if (mat.template_id !== op.template_id) {
      throw new Error("materialized_template.template_id 与 apply_template.template_id 不一致");
    }
    var seen = Object.create(null);
    for (var i = 0; i < mat.elements.length; i++) {
      var el = mat.elements[i];
      if (!el || typeof el !== "object" || Array.isArray(el) ||
          typeof el.id !== "string" || !ID_PATTERN.test(el.id)) {
        throw new Error("materialized_template.elements[" + i + "] 缺少合法 id");
      }
      if (seen[el.id]) throw new Error("materialized_template 含重复元素 id: " + el.id);
      seen[el.id] = true;
      if (!el.type || ELEMENT_TYPES.indexOf(el.type) < 0 ||
          !el.transform || typeof el.transform !== "object" || Array.isArray(el.transform)) {
        throw new Error("materialized_template.elements[" + i + "] 的类型或 transform 非法");
      }
    }
    return mat;
  }

  function opApplyTemplate(doc, op, ctx) {
    var applicability = templateApplicability(op.template_id);
    if (!applicability.ok) {
      throw new Error("模板不可应用，当前文档保持不变：" + applicability.errors.join("；"));
    }
    var mat = materializedTemplate(op);
    if (!mat && ctx && ctx.replay === true) {
      throw new Error("旧历史中的 apply_template 缺少 materialized_template 物化结果，无法确定性重放；请重新应用模板生成兼容历史");
    }
    if (!mat) {
      var GP = global.FigPresets;
      if (!GP || typeof GP.template !== "function" || typeof GP.templateFromStats !== "function") {
        throw new Error("FigPresets 未加载，无法应用模板");
      }
      var tpl = GP.template(op.template_id);
      if (!tpl) throw new Error("模板不存在: " + op.template_id);
      if (op.data !== undefined && op.data !== null &&
          (typeof op.data !== "object" || Array.isArray(op.data) ||
           !Array.isArray(op.data.columns) || !Array.isArray(op.data.rows))) {
        throw new Error("apply_template.data 需要 {columns, rows} 或 null");
      }
      if (op.options !== undefined && op.options !== null &&
          (typeof op.options !== "object" || Array.isArray(op.options))) {
        throw new Error("apply_template.options 必须是对象或 null");
      }
      var built = GP.templateFromStats(op.template_id, op.data == null ? null : op.data,
        op.options || {});
      op.materialized_template = {
        template_id: tpl.id,
        template_name: tpl.name,
        elements: deepCopy(built.elements)
      };
      if (built.diagram_meta) {
        op.materialized_template.diagram_id = built.diagram_meta.contract.id;
        op.materialized_template.diagram_meta = deepCopy(built.diagram_meta);
      }
      mat = op.materialized_template;
    }
    // History replay clones the exact first materialization. It never calls a
    // generator or issues new ids, even if the template library has changed.
    doc.elements = deepCopy(mat.elements);
    doc.meta = doc.meta || {};
    doc.meta.template_id = mat.template_id;
    doc.meta.template_name = mat.template_name !== undefined ? mat.template_name : null;
    if (mat.diagram_meta && mat.diagram_id) {
      if (!doc.meta.diagrams || typeof doc.meta.diagrams !== "object" || Array.isArray(doc.meta.diagrams)) doc.meta.diagrams = {};
      doc.meta.diagrams[mat.diagram_id] = deepCopy(mat.diagram_meta);
    }
    var ids = doc.elements.map(function (el) { return el.id; });
    (doc.anchors || []).forEach(function (anchor) {
      if (Array.isArray(anchor.element_ids)) {
        anchor.element_ids = anchor.element_ids.filter(function (id) { return ids.indexOf(id) >= 0; });
      }
    });
    return true;
  }

  function modeFontSize(doc) {
    var counts = Object.create(null);
    var best = null, bestN = 0;
    for (var i = 0; i < doc.elements.length; i++) {
      var el = doc.elements[i];
      if (el.type !== "text" || !el.style || el.style.fontSizePt == null) continue;
      var v = el.style.fontSizePt;
      counts[v] = (counts[v] || 0) + 1;
      if (counts[v] > bestN) { bestN = counts[v]; best = v; }
    }
    return best;
  }

  function opApplyJournal(doc, op, ctx) {
    var GP = global.FigPresets;
    if (!GP || typeof GP.journal !== "function") {
      throw new Error("FigPresets 未加载，无法套用期刊预设");
    }
    var preset = GP.journal(op.journal_preset_id);
    if (!preset) throw new Error("期刊预设不存在: " + op.journal_preset_id);
    if (preset.width_mm != null) doc.canvas.width_mm = preset.width_mm;
    if (preset.height_mm != null) doc.canvas.height_mm = preset.height_mm;
    doc.canvas.journal_preset_id = preset.id;
    // Scale text font sizes: ratio = preset base / current user base.
    var fromPt = (doc.meta && doc.meta.base_font_pt != null) ? doc.meta.base_font_pt : modeFontSize(doc);
    if (fromPt != null && preset.base_font_pt != null && fromPt !== preset.base_font_pt) {
      if (typeof GP.scaleFonts === "function") {
        doc = GP.scaleFonts(doc, fromPt, preset.base_font_pt);
      } else {
        var ratio = preset.base_font_pt / fromPt;
        for (var i = 0; i < doc.elements.length; i++) {
          var el = doc.elements[i];
          if (el.type === "text" && el.style && el.style.fontSizePt != null) {
            el.style.fontSizePt = el.style.fontSizePt * ratio;
          }
        }
      }
    }
    doc.meta = doc.meta || {};
    doc.meta.journal_preset_id = preset.id;
    doc.meta.base_font_pt = preset.base_font_pt;
    return { doc: doc, changed: true };
  }

  // Neutral colors (white / transparent / black stroke / gray) never take
  // part in recoloring, mirroring FigPalette.isNeutral.
  function isRecolorable(color, GP) {
    if (color == null) return false;
    if (typeof color !== "string") return false;
    var c = color.trim();
    if (!c || c.toLowerCase() === "none") return false;
    if (GP && typeof GP.isNeutral === "function") return !GP.isNeutral(c);
    var up = c.toUpperCase();
    return up !== "#FFF" && up !== "#FFFFFF" && up !== "#000" && up !== "#000000" && up !== "#808080";
  }

  function normHex(color, GP) {
    if (GP && typeof GP.hexToRgb === "function" && typeof GP.rgbToHex === "function") {
      try { return GP.rgbToHex(GP.hexToRgb(color)); } catch (e) { /* fall through */ }
    }
    return String(color).trim().toUpperCase();
  }

  function opRecolor(doc, op) {
    var GP = global.FigPalette;
    if (!GP || typeof GP.get !== "function") {
      throw new Error("FigPalette 未加载，无法应用配色");
    }
    var pal = GP.get(op.palette_id);
    if (!pal) throw new Error("配色不存在: " + op.palette_id);
    var colors = (typeof GP.colors === "function" ? GP.colors(op.palette_id) : null) || pal.colors || [];
    if (!colors.length) throw new Error("配色为空: " + op.palette_id);
    var strategy = op.recolor_strategy || "byHue";

    // Collect distinct colors in first-appearance order (fill first, then
    // stroke, scanning elements in document order).
    var entries = [];
    var byNorm = Object.create(null);
    for (var i = 0; i < doc.elements.length; i++) {
      var st = doc.elements[i].style;
      if (!st) continue;
      var channels = ["fill", "stroke"];
      for (var c = 0; c < channels.length; c++) {
        var color = st[channels[c]];
        if (!isRecolorable(color, GP)) continue;
        var norm = normHex(color, GP);
        var ent = byNorm[norm];
        if (!ent) {
          ent = { norm: norm, refs: [] };
          byNorm[norm] = ent;
          entries.push(ent);
        }
        ent.refs.push({ el: doc.elements[i], key: channels[c] });
      }
    }

    // byOrder: appearance order pairs the palette in order.
    // byHue: appearance order is hue-sorted first, then paired in order.
    // byRole: elements whose style.role / role hits the palette roles map
    //         take that color; everything else falls back to byHue.
    var seq = entries.slice();
    if (strategy === "byHue" || strategy === "byRole") {
      var sorted;
      if (typeof GP.sortByHue === "function") {
        sorted = GP.sortByHue(entries.map(function (e) { return e.norm; }));
      } else {
        sorted = entries.map(function (e) { return e.norm; });
      }
      var order = Object.create(null);
      for (var s = 0; s < sorted.length; s++) order[sorted[s]] = s;
      seq.sort(function (a, b) { return (order[a.norm] || 0) - (order[b.norm] || 0); });
    }
    var mapping = Object.create(null);
    for (var m = 0; m < seq.length; m++) mapping[seq[m].norm] = colors[m % colors.length];

    for (var n = 0; n < doc.elements.length; n++) {
      var el = doc.elements[n];
      if (!el.style) continue;
      var role = el.style.role !== undefined ? el.style.role : el.role;
      if (strategy === "byRole" && role != null && typeof GP.roleColor === "function") {
        var rc = GP.roleColor(op.palette_id, role);
        if (rc && isRecolorable(el.style.fill, GP)) {
          el.style.fill = rc;
          if (el.chart) el.chart.paletteId = op.palette_id;
          continue;
        }
      }
      for (var d = 0; d < 2; d++) {
        var key = d === 0 ? "fill" : "stroke";
        var cur = el.style[key];
        if (!isRecolorable(cur, GP)) continue;
        var nc = mapping[normHex(cur, GP)];
        if (nc) el.style[key] = nc;
      }
      if (el.chart) el.chart.paletteId = op.palette_id;
    }
    doc.meta = doc.meta || {};
    doc.meta.palette_id = op.palette_id;
    return true;
  }

  function opPanelLayout(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var patch = op.panel || {};
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el || el.type !== "panel") continue;
      el.panelLayout = Object.assign({}, el.panelLayout || {}, patch);
      relayoutPanelChildren(doc, el);
      any = true;
    }
    return any;
  }

  // Rearrange the panel children on the cols x rows grid. Children flagged
  // style.panelRelative get normalized values (relative to the padded inner
  // area, 0..1); the others get absolute mm values.
  function relayoutPanelChildren(doc, panel) {
    var layout = panel.panelLayout || {};
    var cols = Math.max(1, layout.cols || 1);
    var rows = Math.max(1, layout.rows || 1);
    var gap = layout.gap_mm != null ? layout.gap_mm : 2;
    var pad = layout.padding_mm || 0;
    var t = panel.transform || { x: 0, y: 0, w: 0, h: 0 };
    var innerW = Math.max(0.1, t.w - 2 * pad);
    var innerH = Math.max(0.1, t.h - 2 * pad);
    var cellW = Math.max(0.1, (innerW - (cols - 1) * gap) / cols);
    var cellH = Math.max(0.1, (innerH - (rows - 1) * gap) / rows);
    var kids = Array.isArray(panel.children) ? panel.children : [];
    for (var i = 0; i < kids.length; i++) {
      var child = getEl(doc, kids[i]);
      if (!child) continue;
      var col = i % cols, row = Math.floor(i / cols);
      var ct = child.transform || (child.transform = { x: 0, y: 0, w: 0, h: 0 });
      if (child.style && child.style.panelRelative === true) {
        ct.x = (col * (cellW + gap)) / innerW;
        ct.y = (row * (cellH + gap)) / innerH;
        ct.w = cellW / innerW;
        ct.h = cellH / innerH;
      } else {
        ct.x = t.x + pad + col * (cellW + gap);
        ct.y = t.y + pad + row * (cellH + gap);
        ct.w = cellW;
        ct.h = cellH;
      }
    }
  }

  function opSetCanvas(doc, op) {
    var patch = op.canvas;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("set_canvas 缺少 canvas 补丁");
    }
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
      doc.canvas[keys[i]] = deepCopy(patch[keys[i]]);
    }
    return keys.length > 0;
  }

  function actorOf(source) {
    if (source === "ai" || source === "user") return source;
    return "system";
  }

  function opNote(doc, op, ctx) {
    var text = op.note != null ? op.note : op.reason;
    if (!Array.isArray(doc.meta.provenance)) doc.meta.provenance = [];
    doc.meta.provenance.push({
      ts: (ctx && ctx.ts) || nowIso(),
      actor: actorOf(ctx && ctx.source),
      action: "note",
      detail: text || ""
    });
    return true;
  }

  // Persist the science contract. ONLY two things may change: the affected
  // charts' chart.statistics and doc.meta.scientific_contract (mirror of
  // statistics removed — chart.statistics is the single source of truth).
  // History / undo / snapshot replay stay intact because the op itself is
  // replayed verbatim by FigOps.ensureSnapshot. Statistics entries whose
  // element is missing/non-chart are skipped here (validate reports them);
  // this matches FigScience.applyContract's STATS_NOT_ATTACHED behavior.
  function opSetScientificContract(doc, op) {
    var norm = normalizeScientificContract(op.contract, doc);
    if (!norm.ok) {
      throw new Error("set_scientific_contract 校验失败：" + norm.errors.join("；"));
    }
    var before = currentScientificContract(doc);
    delete before.statistics;
    var contract = norm.contract;
    var stats = deepCopy(contract.statistics);
    delete contract.statistics; // 镜像不入 meta：chart.statistics 是唯一来源
    var contractChanged = !deepEq(before, contract);
    var changed = contractChanged;
    for (var i = 0; i < doc.elements.length; i++) {
      var el = doc.elements[i];
      if (!el || el.type !== "chart") continue;
      el.chart = el.chart || {};
      var hasNext = Object.prototype.hasOwnProperty.call(stats, el.id);
      var previous = el.chart.statistics && typeof el.chart.statistics === "object" &&
        !Array.isArray(el.chart.statistics) && Object.keys(el.chart.statistics).length
        ? el.chart.statistics : undefined;
      var next = hasNext ? stats[el.id] : undefined;
      if (deepEq(previous, next)) continue;
      if (hasNext) el.chart.statistics = deepCopy(next);
      else delete el.chart.statistics;
      changed = true;
    }
    if (contractChanged) {
      doc.meta = doc.meta || {};
      doc.meta.scientific_contract = contract;
    }
    return changed;
  }

  // ------------------------------------------------------------------
  // set_chart_properties — chartSpec 白名单补丁（表征参数编辑的唯一入口）
  // properties.axes 与既有 chart.axes 逐键合并；properties.characterization
  // 与 chart.characterization 逐键合并（数组字段整体替换，深拷贝），显式
  // null 清除表征块（回到通用渲染，可 undo）。永不修改 chartType 与
  // data.inline；补丁未引起实际变化时不记录变更。
  // ------------------------------------------------------------------

  function cpPatchAxes(current, patch) {
    var next = Object.assign({}, current || {});
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (CP_AXES_KEYS.indexOf(k) < 0) continue; // 未知键由 validate 拦截
      var v = patch[k];
      if (v === undefined) continue;
      next[k] = typeof v === "object" ? deepCopy(v) : v;
    }
    return next;
  }

  function cpPatchCharacterization(current, patch) {
    var next = (current && typeof current === "object" && !Array.isArray(current))
      ? deepCopy(current) : {};
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (CP_CHAR_KEYS.indexOf(k) < 0) continue;
      var v = patch[k];
      if (v === undefined) continue;
      next[k] = Array.isArray(v) ? deepCopy(v) : v;
    }
    return next;
  }

  function opSetChartProperties(doc, op) {
    var ids = resolveTargets(doc, op.targets);
    if (!ids.length) return false;
    var props = op.properties;
    var any = false;
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]);
      if (!el || el.type !== "chart") continue;
      var chart = el.chart = el.chart || {};
      if (props.axes) {
        var nextAxes = cpPatchAxes(chart.axes, props.axes);
        if (!deepEq(chart.axes || {}, nextAxes)) {
          chart.axes = nextAxes;
          any = true;
        }
      }
      if (props.characterization !== undefined) {
        if (props.characterization === null) {
          if (chart.characterization !== undefined) {
            delete chart.characterization;
            any = true;
          }
        } else {
          var nextChar = cpPatchCharacterization(chart.characterization,
            props.characterization);
          if (!deepEq(chart.characterization || {}, nextChar)) {
            chart.characterization = nextChar;
            any = true;
          }
        }
      }
    }
    return any;
  }

  function diagramModule() {
    var D = global.FigDiagram;
    if (!D || typeof D.build !== "function") throw new Error("FigDiagram 未加载，无法应用实体关系示意图");
    return D;
  }

  function schematicContract(op, doc) {
    var D = diagramModule(), candidates = [];
    ["contract", "spec", "diagram"].forEach(function (key) {
      if (op[key] !== undefined && op[key] !== null) candidates.push({ key: key, value: op[key] });
    });
    if (!candidates.length && op.op === "layout_schematic") {
      var sid = op.diagram_id || op.scene_id || op.id;
      var entry = doc.meta && doc.meta.diagrams && doc.meta.diagrams[sid];
      if (!entry) throw new Error("layout_schematic 找不到已有示意图：" + String(sid));
      return deepCopy(entry.contract || entry.spec);
    }
    if (!candidates.length) throw new Error(op.op + " 需要 contract（完整 nodes/relations/sources 合同）");
    for (var i = 1; i < candidates.length; i++) {
      if (!D.sameContract(candidates[0].value, candidates[i].value)) {
        throw new Error("contract/spec/diagram 别名内容冲突");
      }
    }
    return candidates[0].value;
  }

  function materializedSchematic(op, ctx) {
    var mat = op.materialized_schematic;
    if (!mat || typeof mat !== "object" || Array.isArray(mat) || !Array.isArray(mat.elements) ||
        !mat.elements.length || !mat.contract || !mat.diagram_meta) {
      throw new Error("materialized_schematic 必须保存 contract、diagram_meta 和非空 elements");
    }
    var D = diagramModule(), normalized = D.normalize(mat.contract);
    if (mat.contract_sha256 !== D.hash(normalized)) throw new Error("materialized_schematic 契约哈希不匹配，拒绝重放");
    mat.elements.forEach(function (el, i) {
      if (!el || typeof el !== "object" || typeof el.id !== "string" || !ID_PATTERN.test(el.id) ||
          el.diagram_id !== normalized.id || ELEMENT_TYPES.indexOf(el.type) < 0 ||
          !el.transform || typeof el.transform !== "object") {
        throw new Error("materialized_schematic.elements[" + i + "] 类型、归属或 id 非法");
      }
    });
    if (ctx && ctx.replay === true && (typeof mat.generated_at !== "string" || !mat.generated_at)) {
      throw new Error("历史示意图物化结果缺少正常 commit 的 generated_at，拒绝伪造生成时间");
    }
    return mat;
  }

  function installSchematic(doc, mat) {
    var sid = mat.contract.id, doomed = Object.create(null);
    doc.elements.forEach(function (el) { if (el && el.diagram_id === sid) doomed[el.id] = true; });
    var kept = doc.elements.filter(function (el) { return !doomed[el.id]; });
    var occupied = Object.create(null);
    kept.forEach(function (el) { occupied[el.id] = true; });
    mat.elements.forEach(function (el) {
      if (occupied[el.id]) throw new Error("示意图物化元素与无关文档元素 id 冲突：" + el.id);
    });
    kept.forEach(function (el) {
      if (Array.isArray(el.children)) el.children = el.children.filter(function (id) { return !doomed[id]; });
    });
    doc.elements = kept.concat(deepCopy(mat.elements));
    (doc.anchors || []).forEach(function (a) {
      if (Array.isArray(a.element_ids)) a.element_ids = a.element_ids.filter(function (id) { return !doomed[id]; });
    });
    if (Array.isArray(doc.panels)) doc.panels = doc.panels.filter(function (p) { return !doomed[p.element_id]; });
    doc.canvas = Object.assign({}, doc.canvas, deepCopy(diagramModule().normalize(mat.contract).canvas));
    doc.meta = doc.meta || {};
    if (!doc.meta.diagrams || typeof doc.meta.diagrams !== "object" || Array.isArray(doc.meta.diagrams)) doc.meta.diagrams = {};
    doc.meta.diagrams[sid] = deepCopy(mat.diagram_meta);
  }

  function opApplySchematic(doc, op, ctx) {
    var D = diagramModule(), normalized = D.normalize(schematicContract(op, doc)), auto = op.auto_layout === true;
    op.contract = deepCopy(normalized);
    var existing = doc.meta && doc.meta.diagrams && doc.meta.diagrams[normalized.id];
    if (existing && !auto && D.sameContract(existing.contract || existing.spec, normalized)) return { doc: doc, changed: false };

    var mat = op.materialized_schematic == null ? null : materializedSchematic(op, ctx);
    if (!mat) {
      if (ctx && ctx.replay === true) {
        throw new Error("历史 apply_schematic 缺少 materialized_schematic，不能重新生成 id 或覆盖手动布局");
      }
      var ts = (ctx && ctx.ts) || (ctx && ctx.validation ? null : nowIso());
      var built = D.build(doc, normalized, { auto_layout: auto, generated_at: ts });
      mat = {
        schema_version: D.SCHEMA_VERSION, contract: deepCopy(normalized),
        elements: deepCopy(built.doc.elements.filter(function (el) { return el.diagram_id === normalized.id; })),
        diagram_meta: deepCopy(built.doc.meta.diagrams[normalized.id]),
        warnings: deepCopy(built.warnings), contract_sha256: D.hash(normalized), generated_at: ts
      };
      op.materialized_schematic = deepCopy(mat);
    } else if (!(ctx && ctx.replay === true) && ctx && ctx.ts) {
      mat.generated_at = ctx.ts;
      mat.diagram_meta.generated_at = ctx.ts;
      op.materialized_schematic.generated_at = ctx.ts;
      op.materialized_schematic.diagram_meta.generated_at = ctx.ts;
    }
    if (!mat.diagram_meta || typeof mat.diagram_meta !== "object") throw new Error("示意图物化结果缺少 meta.diagrams 条目");
    mat.diagram_meta.generated_at = mat.generated_at;
    installSchematic(doc, mat);
    op.contract = deepCopy(mat.contract);
    op.warnings = deepCopy(mat.warnings || []);
    return { doc: doc, changed: true };
  }

  function normalizeInlineData(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        !Array.isArray(input.columns) || !Array.isArray(input.rows)) {
      throw new Error("set_chart_data.data 必须是 {columns,rows}");
    }
    ["columns", "rows", "source_ref", "sourceRef", "version"].forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(input, k) && k !== "columns" && k !== "rows") return;
    });
    Object.keys(input).forEach(function (k) {
      if (["columns", "rows", "source_ref", "sourceRef", "version",
           "raw_source_sha256", "source_info"].indexOf(k) < 0) {
        throw new Error("set_chart_data.data 含未知字段：" + k);
      }
    });
    var columns = input.columns.map(function (c, i) {
      if (typeof c !== "string" || !c.trim()) throw new Error("数据第 " + (i + 1) + " 列名必须是非空字符串");
      return c;
    });
    if ((new Set(columns)).size !== columns.length) throw new Error("数据列名不能重复");
    var rows = input.rows.map(function (row, ri) {
      if (!Array.isArray(row) || row.length !== columns.length) throw new Error("数据第 " + (ri + 1) + " 行长度与 columns 不一致");
      return row.map(function (v, ci) {
        if (typeof v === "number" && !isFinite(v)) throw new Error("数据第 " + (ri + 1) + " 行第 " + (ci + 1) + " 列不是有限数");
        if (v !== null && ["string", "number", "boolean"].indexOf(typeof v) < 0) throw new Error("数据单元格只接受 string/number/boolean/null");
        return v;
      });
    });
    return { columns: columns, rows: rows };
  }

  function rawSha256(value, where, errors) {
    if (typeof value !== "string") {
      errors.push(where + " 必须是 64 位 SHA-256 hex 或 sha256: 前缀字符串");
      return null;
    }
    var match = /^sha256:([0-9a-fA-F]{64})$/.exec(value) || /^([0-9a-fA-F]{64})$/.exec(value);
    if (!match) {
      errors.push(where + " 必须是有效的 raw source SHA-256，不能是 unknown 或 inline content hash 别名");
      return null;
    }
    return match[1].toLowerCase();
  }

  function validateSourceMetadataJson(value, where, errors) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!isFinite(value)) errors.push(where + " 不能包含 NaN/Infinity");
      return;
    }
    if (!value || typeof value !== "object") {
      errors.push(where + " 只接受 JSON 数据");
      return;
    }
    Object.keys(value).forEach(function (key) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        errors.push(where + " 含不安全键：" + key);
      } else {
        validateSourceMetadataJson(value[key], where + "." + key, errors);
      }
    });
  }

  function replacementSourceIdentity(op, declaredSource, declaredVersion, nextData) {
    var inputData = op.data || {}, errors = [];
    var explicit = scHas(op, "raw_source_sha256") || scHas(inputData, "raw_source_sha256") ||
      scHas(op, "source_info") || scHas(inputData, "source_info");
    var suppliedHashes = [];
    if (scHas(op, "raw_source_sha256")) suppliedHashes.push([op.raw_source_sha256, "raw_source_sha256"]);
    if (scHas(inputData, "raw_source_sha256")) suppliedHashes.push([inputData.raw_source_sha256, "data.raw_source_sha256"]);
    var rawInfo = scHas(op, "source_info") ? op.source_info : undefined;
    if (scHas(inputData, "source_info")) {
      if (rawInfo !== undefined && !deepEq(rawInfo, inputData.source_info)) {
        errors.push("data.source_info 与 op.source_info 冲突");
      }
      rawInfo = inputData.source_info;
    }
    var info = null;
    if (rawInfo !== undefined && rawInfo !== null) {
      if (!rawInfo || typeof rawInfo !== "object" || Array.isArray(rawInfo)) {
        errors.push("source_info 必须是对象或 null");
      } else {
        info = deepCopy(rawInfo);
        validateSourceMetadataJson(info, "source_info", errors);
        ["sha256", "raw_source_sha256", "source_sha256"].forEach(function (key) {
          if (scHas(info, key)) suppliedHashes.push([info[key], "source_info." + key]);
        });
        ["kind", "source_type", "format", "locator", "uri", "path", "ref", "id",
         "file_name", "source_identity"].forEach(function (key) {
          if (info[key] !== undefined && info[key] !== null &&
              (typeof info[key] !== "string" || !info[key].trim())) {
            errors.push("source_info." + key + " 必须是非空字符串或 null");
          }
        });
        ["version", "source_version"].forEach(function (key) {
          if (info[key] !== undefined && info[key] !== null &&
              (typeof info[key] !== "string" || !info[key].trim())) {
            errors.push("source_info." + key + " 必须是非空字符串或 null");
          }
          if (typeof info[key] === "string" && info[key] && info[key] !== declaredVersion) {
            errors.push("source_info." + key + " 与新 version 不一致");
          }
        });
        var locators = ["locator", "uri", "path", "ref", "id", "file_name"].filter(function (key) {
          return typeof info[key] === "string" && info[key];
        }).map(function (key) { return info[key]; });
        if (locators.length && typeof declaredSource === "string" && locators.indexOf(declaredSource) < 0) {
          errors.push("source_info locator/file_name 与新 source_ref 不一致");
        }
        if (info.bytes !== undefined && info.bytes !== null &&
            (typeof info.bytes !== "number" || !isFinite(info.bytes) || info.bytes < 0 || Math.floor(info.bytes) !== info.bytes)) {
          errors.push("source_info.bytes 必须是非负整数或 null");
        }
        if (info.verification_status !== undefined && info.verification_status !== null &&
            (typeof info.verification_status !== "string" || !info.verification_status.trim())) {
          errors.push("source_info.verification_status 必须是非空字符串或 null");
        }
        if (info.verification_status === "verified") {
          errors.push("set_chart_data 不能把未读取 raw 字节的声明标为 verified");
        } else if (!info.verification_status) {
          info.verification_status = "user_provided_source_metadata_unverified";
        }
      }
    }
    var sha = null;
    suppliedHashes.forEach(function (entry) {
      var normalized = rawSha256(entry[0], entry[1], errors);
      if (normalized && sha && normalized !== sha) errors.push("本次替换的 raw source SHA 声明互相冲突");
      if (normalized) sha = normalized;
    });
    if (info) {
      ["sha256", "raw_source_sha256", "source_sha256"].forEach(function (key) {
        if (scHas(info, key) && typeof info[key] === "string") {
          var parsed = /^sha256:([0-9a-fA-F]{64})$/.exec(info[key]) || /^([0-9a-fA-F]{64})$/.exec(info[key]);
          if (parsed) info[key] = parsed[1].toLowerCase();
        }
      });
      if (info.content_version && sha && info.content_version !== "sha256:" + sha) {
        errors.push("source_info.content_version 与 raw source SHA 不一致");
      }
      if (info.value_fingerprint !== undefined && info.value_fingerprint !== null) {
        var fp = info.value_fingerprint;
        if (!fp || typeof fp !== "object" || Array.isArray(fp)) {
          errors.push("source_info.value_fingerprint 必须是对象或 null");
        } else {
          var contentHash = global.FigDiagram && typeof global.FigDiagram.hash === "function"
            ? global.FigDiagram.hash(nextData) : null;
          if (fp.algorithm !== "canonical_columns_rows_json_sha256" ||
              fp.sha256 !== contentHash || !deepEq(fp.columns, nextData.columns) ||
              fp.row_count !== nextData.rows.length) {
            errors.push("source_info.value_fingerprint 必须与本次 columns/rows 完全一致，不能沿用旧 inline 指纹");
          }
        }
      }
    }
    return { explicit: explicit, sha256: sha, source_info: info, errors: errors };
  }

  function chartDataProblems(doc, op) {
    var errors = [];
    if (op.approved !== true) errors.push("set_chart_data 只有用户显式 approved=true 才能替换 inline 数据");
    var next = null;
    try { next = normalizeInlineData(op.data); } catch (e) { errors.push(e.message); }
    if (op.source_ref !== undefined && op.source_ref !== null && typeof op.source_ref !== "string") errors.push("source_ref 必须是字符串或 null");
    if (op.sourceRef !== undefined && op.sourceRef !== null && typeof op.sourceRef !== "string") errors.push("sourceRef 必须是字符串或 null");
    if (op.source_ref !== undefined && op.sourceRef !== undefined && op.source_ref !== op.sourceRef) errors.push("source_ref/sourceRef 值冲突");
    if (op.version !== undefined && op.version !== null && typeof op.version !== "string") errors.push("version 必须是字符串或 null");
    if (!op.data || typeof op.data !== "object") return errors;
    if (op.data.source_ref !== undefined && op.source_ref !== undefined && op.data.source_ref !== op.source_ref) errors.push("data.source_ref 与 op.source_ref 冲突");
    if (op.data.sourceRef !== undefined && op.sourceRef !== undefined && op.data.sourceRef !== op.sourceRef) errors.push("data.sourceRef 与 op.sourceRef 冲突");
    if (op.data.version !== undefined && op.version !== undefined && op.data.version !== op.version) errors.push("data.version 与 op.version 冲突");
    var declaredSource = op.source_ref !== undefined ? op.source_ref : op.sourceRef;
    if (declaredSource === undefined) declaredSource = op.data.source_ref !== undefined ? op.data.source_ref : op.data.sourceRef;
    var declaredVersion = op.version !== undefined ? op.version : op.data.version;
    if (typeof declaredSource !== "string" || !declaredSource.trim()) errors.push("set_chart_data 必须提供非空 source_ref，明确本次 inline 数据的来源");
    if (typeof declaredVersion !== "string" || !declaredVersion.trim()) errors.push("set_chart_data 必须提供非空 version，禁止用来源变化暗中冒充版本更新");
    if (!next) return errors;
    var identity = replacementSourceIdentity(op, declaredSource, declaredVersion, next);
    identity.errors.forEach(function (message) { errors.push(message); });
    var ids = [];
    try { ids = resolveTargets(doc, op.targets); } catch (e) { errors.push(e.message); }
    ids.forEach(function (id) {
      var el = getEl(doc, id);
      if (!el || el.type !== "chart" || !el.chart) { errors.push("目标不是有效 chart：" + id); return; }
      var mapping = el.chart.mapping || {};
      Object.keys(mapping).forEach(function (role) {
        var col = mapping[role];
        if (col !== null && col !== undefined && col !== "" &&
            (typeof col !== "string" || next.columns.indexOf(col) < 0)) {
          errors.push("目标 " + id + " 的 mapping." + role + " 引用了新数据中不存在的列：" + String(col));
        }
      });
      var curves = el.chart.characterization && el.chart.characterization.curves;
      if (Array.isArray(curves)) curves.forEach(function (curve) {
        if (curve && typeof curve.column === "string" && next.columns.indexOf(curve.column) < 0) {
          errors.push("目标 " + id + " 的表征曲线引用不存在列：" + curve.column);
        }
      });
    });
    return errors;
  }

  function opSetChartData(doc, op) {
    var problems = chartDataProblems(doc, op);
    if (problems.length) throw new Error("set_chart_data 校验失败：" + problems.join("；"));
    var nextData = normalizeInlineData(op.data), inputData = op.data;
    var suppliedSource = op.source_ref !== undefined ? op.source_ref : op.sourceRef;
    if (suppliedSource === undefined && inputData.source_ref !== undefined) suppliedSource = inputData.source_ref;
    if (suppliedSource === undefined && inputData.sourceRef !== undefined) suppliedSource = inputData.sourceRef;
    var suppliedVersion = op.version !== undefined ? op.version : inputData.version;
    var declaredSource = suppliedSource === undefined ? inputData.source_ref : suppliedSource;
    var identity = replacementSourceIdentity(op, declaredSource, suppliedVersion, nextData);
    op.data = { columns: deepCopy(nextData.columns), rows: deepCopy(nextData.rows) };
    if (suppliedSource !== undefined) op.source_ref = suppliedSource;
    if (suppliedVersion !== undefined) op.version = suppliedVersion;
    if (identity.explicit) op.raw_source_sha256 = identity.sha256 || "unknown";
    if (identity.source_info) op.source_info = deepCopy(identity.source_info);
    var ids = resolveTargets(doc, op.targets), any = false, notices = [];
    op.originals = op.originals || {};
    for (var i = 0; i < ids.length; i++) {
      var el = getEl(doc, ids[i]), chart = el.chart;
      if (!Object.prototype.hasOwnProperty.call(op.originals, el.id)) {
        op.originals[el.id] = {
          inline: deepCopy(chart.data && chart.data.inline || null),
          source_ref: chart.data && chart.data.source_ref !== undefined ? chart.data.source_ref : chart.data && chart.data.ref || null,
          version: chart.data && chart.data.version !== undefined ? chart.data.version : null,
          data: deepCopy(chart.data || {})
        };
      }
      var source = suppliedSource === undefined
        ? (chart.data && chart.data.source_ref !== undefined ? chart.data.source_ref : chart.data && chart.data.ref || null) : suppliedSource;
      var version = suppliedVersion === undefined ? (chart.data && chart.data.version !== undefined ? chart.data.version : null) : suppliedVersion;
      var previousSource = chart.data && chart.data.source_ref !== undefined
        ? chart.data.source_ref : chart.data && chart.data.ref;
      var previousVersion = chart.data && chart.data.version !== undefined ? chart.data.version : null;
      var previousData = chart.data || {}, previousInfo = previousData.source_info;
      var previousRaw = null;
      [previousData.raw_source_sha256, previousData.source_sha256,
       previousInfo && previousInfo.sha256, previousInfo && previousInfo.raw_source_sha256,
       previousInfo && previousInfo.source_sha256].forEach(function (candidate) {
        if (previousRaw || typeof candidate !== "string") return;
        var match = /^sha256:([0-9a-fA-F]{64})$/.exec(candidate) || /^([0-9a-fA-F]{64})$/.exec(candidate);
        if (match) previousRaw = match[1].toLowerCase();
      });
      var identitySame = !identity.explicit || (previousRaw === identity.sha256 &&
        deepEq(previousInfo === undefined ? null : previousInfo, identity.source_info));
      if (deepEq(previousData.inline, nextData) && deepEq(previousSource, source) &&
          deepEq(previousVersion, version) && identitySame) continue;
      chart.data = previousData;
      if (!Array.isArray(chart.data_history)) chart.data_history = [];
      chart.data_history.push({
        data: deepCopy(chart.data), mapping: deepCopy(chart.mapping || {}),
        archived_at: null, reason: "set_chart_data 替换前版本（含 raw source hash/file_name/source_info）；仅供回溯，不参与当前渲染"
      });
      chart.data.inline = deepCopy(nextData);
      chart.data.source_ref = source;
      chart.data.ref = source;
      chart.data.version = version;
      delete chart.data.source_version;
      delete chart.data.source_sha256;
      delete chart.data.source_info;
      delete chart.data.raw_source;
      delete chart.data.source;
      chart.data.raw_source_sha256 = identity.explicit && identity.sha256 ? identity.sha256 : "unknown";
      if (identity.explicit && identity.source_info) chart.data.source_info = deepCopy(identity.source_info);
      chart.data.field_mapping = nextData.columns.map(function (column, index) {
        return { column: column, column_index: index };
      });
      chart.data.row_mapping = nextData.rows.map(function (row, index) {
        return { inline_row_index: index, source_row_index: null };
      });
      if (global.FigDiagram && typeof global.FigDiagram.hash === "function") {
        chart.data.content_sha256 = global.FigDiagram.hash(nextData);
      }
      var stats = chart.statistics || {}, missing = [];
      if (!stats.n_definition && stats.biological_replicates == null && stats.technical_replicates == null) missing.push("样本量 n");
      var hasUnit = function (declared, label) {
        if (typeof declared === "string" && declared.trim()) return true;
        return typeof label === "string" && (/[\[(][^\])]+[\])]/.test(label) || /[%°Ωμ]/.test(label));
      };
      if (!hasUnit(stats.unit_x, chart.axes && chart.axes.xLabel || chart.characterization && chart.characterization.x_label) ||
          !hasUnit(stats.unit_y, chart.axes && chart.axes.yLabel || chart.characterization && chart.characterization.y_label)) missing.push("坐标单位");
      chart.statistics_review = {
        status: "required", reason: "approved inline 数据已替换；mapping/style/原始统计 metadata 不变，须重新复核",
        missing: missing, source_ref: source, version: version,
        raw_source_sha256: chart.data.raw_source_sha256
      };
      notices.push(el.id + "：" + (missing.length ? missing.join("、") + "待复核" : "统计定义、样本量与单位仍待复核"));
      any = true;
    }
    op.review_notices = notices;
    return any;
  }

  // Dispatch one op against a mutable working copy.
  function execOp(work, op, ctx) {
    switch (op.op) {
      case "move": return { doc: work, changed: opMove(work, op) };
      case "resize": return { doc: work, changed: opResize(work, op) };
      case "rotate": return { doc: work, changed: opRotate(work, op) };
      case "set_text": return { doc: work, changed: opSetText(work, op) };
      case "set_style": return { doc: work, changed: opSetStyle(work, op) };
      case "set_color": return { doc: work, changed: opSetColor(work, op) };
      case "add_element": return { doc: work, changed: opAddElement(work, op) };
      case "delete": return { doc: work, changed: opDelete(work, op) };
      case "group": return { doc: work, changed: opGroup(work, op) };
      case "ungroup": return { doc: work, changed: opUngroup(work, op) };
      case "align": return { doc: work, changed: opAlign(work, op) };
      case "distribute": return { doc: work, changed: opDistribute(work, op) };
      case "z_order": return { doc: work, changed: opZOrder(work, op) };
      case "add_anchor": return { doc: work, changed: opAddAnchor(work, op) };
      case "remove_anchor": return { doc: work, changed: opRemoveAnchor(work, op) };
      case "update_anchor": return { doc: work, changed: opUpdateAnchor(work, op) };
      case "apply_template": return { doc: work, changed: opApplyTemplate(work, op, ctx) };
      case "apply_journal": return opApplyJournal(work, op, ctx);
      case "recolor": return { doc: work, changed: opRecolor(work, op) };
      case "panel_layout": return { doc: work, changed: opPanelLayout(work, op) };
      case "set_canvas": return { doc: work, changed: opSetCanvas(work, op) };
      case "note": return { doc: work, changed: opNote(work, op, ctx) };
      case "set_scientific_contract": return { doc: work, changed: opSetScientificContract(work, op) };
      case "set_chart_properties": return { doc: work, changed: opSetChartProperties(work, op) };
      case "apply_schematic":
      case "layout_schematic": return opApplySchematic(work, op, ctx);
      case "set_chart_data": return { doc: work, changed: opSetChartData(work, op) };
      default:
        throw new Error("未知操作类型: " + safeStr(op.op));
    }
  }

  // ------------------------------------------------------------------
  // Public: apply / applyAll
  // ------------------------------------------------------------------

  // Apply a single op. Falls through silently (changed=false) when the
  // targets resolve to nothing; structural errors throw (Chinese message).
  function apply(doc, op, ctx) {
    assertDoc(doc);
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      throw new Error("op 必须是对象");
    }
    if (typeof op.op !== "string" || OP_TYPES.indexOf(op.op) < 0) {
      throw new Error("未知操作类型: " + safeStr(op.op));
    }
    var cache = getCache(doc);
    var work = cloneDoc(doc);
    var r = execOp(work, op, ctx || {});
    if (r.changed && !(ctx && ctx.replay === true)) {
      if (!(r.doc.meta && r.doc.meta.history_origin)) {
        var initialized = captureHistoryOrigin(doc, contentRevOf(doc));
        r.doc.meta = r.doc.meta || {};
        r.doc.meta.history_origin = deepCopy(initialized.meta.history_origin);
      }
      touchDoc(r.doc, ctx && ctx.ts);
    } else if (r.changed) {
      touchDoc(r.doc, ctx && ctx.ts);
    }
    if (cache) attachCache(r.doc, cache);
    return { doc: r.doc, changed: r.changed };
  }

  function validateAll(ops, doc) {
    if (!Array.isArray(ops)) return { ok: false, errors: ["ops 必须是数组"] };
    var errors = [];
    var simulated = null;
    for (var i = 0; i < ops.length; i++) {
      var state = simulated || doc;
      var v = validate(ops[i], state);
      for (var j = 0; j < v.errors.length; j++) {
        errors.push("ops[" + i + "] " + v.errors[j]);
      }
      if (v.ok) {
        if (!simulated) simulated = cloneDoc(doc);
        try {
          simulated = apply(simulated, ops[i], { validation: true }).doc;
        } catch (e) {
          errors.push("ops[" + i + "] 应用失败: " + e.message);
          break;
        }
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function applyAll(doc, ops, opts) {
    assertDoc(doc);
    var o = opts || {};
    if (!Array.isArray(ops)) throw new Error("ops 必须是数组");
    var v = validateAll(ops, doc);
    if (!v.ok) {
      throw new Error("操作校验失败，未应用任何变更: " + v.errors.join("；"));
    }
    var ts = o.ts || nowIso();
    var source = o.source || "ai";
    var label = o.label || "";
    // Fork the cache until both the redo trim and durable-origin pruning pass.
    // A rejected prune must leave the caller's snapshots and redo tail intact.
    var originalCache = getCache(doc);
    var cache = copyCache(originalCache);
    var work = cloneDoc(doc);
    attachCache(work, cache);

    var P = contentRevOf(work);
    var base_rev = P;
    if (cache[base_rev] == null) cache[base_rev] = cloneDoc(work);

    var changed = false;
    var applied = 0;
    for (var i = 0; i < ops.length; i++) {
      var r = apply(work, ops[i], { ts: ts, source: source });
      work = r.doc;
      if (r.changed) { applied++; changed = true; }
    }
    // A no-op is neither a new revision nor a new branch: preserve the exact
    // document, redo tail, snapshots and updated timestamp.
    if (applied === 0) return { doc: doc, changed: false, applied: 0 };

    // Only a real edit truncates the redo tail.
    if (Array.isArray(work.history) && work.history.length) {
      work.history = work.history.filter(function (r) { return (r.rev || 0) <= P; });
      for (var key in cache) {
        if (Number(key) > P) delete cache[key];
      }
    } else {
      work.history = [];
    }

    var lastRev = work.history.length ? (work.history[work.history.length - 1].rev || 0) : 0;
    var rev = lastRev + 1;
    work.history.push({
      rev: rev,
      ts: ts,
      label: label,
      source: source,
      base_rev: base_rev,
      ops: deepCopy(ops),
      doc_sha256: null,
      checkpoint: !!o.checkpoint
    });
    touchDoc(work, ts);
    cache[rev] = cloneDoc(work);
    attachCache(work, cache);
    pruneHistory(work, cache);
    replaceCacheContents(originalCache, cache);
    return { doc: work, changed: changed, applied: applied };
  }

  // Fill in doc_sha256 for one history record (async, WebCrypto via FigDoc).
  function finalizeHistory(doc, rev) {
    var F = figdoc();
    assertDoc(doc);
    var rec = null;
    var hist = doc.history || [];
    for (var i = 0; i < hist.length; i++) {
      if (hist[i].rev === rev) { rec = hist[i]; break; }
    }
    if (!rec) throw new Error("历史记录不存在: rev " + rev);
    var work = cloneDoc(doc);
    var wrec = null;
    for (var j = 0; j < work.history.length; j++) {
      if (work.history[j].rev === rev) { wrec = work.history[j]; break; }
    }
    return Promise.resolve()
      .then(function () { return F.sha256(work); })
      .then(function (hash) {
        wrec.doc_sha256 = hash;
        var cache = getCache(doc);
        if (cache) attachCache(work, cache);
        return work;
      });
  }

  // ------------------------------------------------------------------
  // Public: undo / redo / revertTo
  // ------------------------------------------------------------------

  function revertToRev(doc, rev, kind) {
    var originalCache = getCache(doc);
    var cache = copyCache(originalCache);
    var snap = cache ? cache[rev] : null;
    if (!snap) throw new Error("无法回到版本 " + rev + "：缺少运行期快照");
    var hist = doc.history || [];
    var C = lastRevOf(doc);
    // Content comes from the snapshot; history is kept in full (append a
    // revert record, then advance origin before any pruning is committed).
    var work = cloneDoc(snap);
    work.id = doc.id;
    work.history = deepCopy(hist);
    inheritHistoryOrigin(work, doc);
    var labelMap = { undo: "撤销", redo: "重做", revert: "回退" };
    work.history.push({
      rev: C + 1,
      ts: nowIso(),
      label: labelMap[kind] + "：回到版本 " + rev,
      source: "system",
      base_rev: C,
      ops: [],
      doc_sha256: null,
      checkpoint: false,
      kind: "revert",
      revert_to: rev,
      revert_kind: kind
    });
    touchDoc(work);
    cache[C + 1] = cloneDoc(work);
    attachCache(work, cache);
    pruneHistory(work, cache);
    replaceCacheContents(originalCache, cache);
    return work;
  }

  function undo(doc) {
    assertDoc(doc);
    var hist = doc.history || [];
    if (!hist.length) throw new Error("没有可撤销的操作");
    var cache = ensureCache(doc);
    var P = contentRevOf(doc);
    if (cache[P] == null) cache[P] = cloneDoc(doc);
    var target = null;
    for (var i = hist.length - 1; i >= 0; i--) {
      var r = hist[i];
      if ((r.rev || 0) > P) continue;
      if (r.kind === "revert") continue;
      target = r;
      break;
    }
    if (!target) throw new Error("没有可撤销的操作");
    var T = target.base_rev == null ? 0 : target.base_rev;
    ensureSnapshot(doc, T, cache);
    return revertToRev(doc, T, "undo");
  }

  function redo(doc) {
    assertDoc(doc);
    var hist = doc.history || [];
    if (!hist.length) throw new Error("没有可重做的操作");
    var cache = ensureCache(doc);
    var P = contentRevOf(doc);
    if (cache[P] == null) cache[P] = cloneDoc(doc);
    var target = null;
    for (var i = 0; i < hist.length; i++) {
      var r = hist[i];
      if ((r.rev || 0) <= P) continue;
      if (r.kind === "revert") continue;
      target = r;
      break;
    }
    if (!target) throw new Error("没有可重做的操作");
    ensureSnapshot(doc, target.rev, cache);
    return revertToRev(doc, target.rev, "redo");
  }

  function revertTo(doc, rev) {
    assertDoc(doc);
    if (typeof rev !== "number" || !isFinite(rev) || Math.floor(rev) !== rev || rev < 0) {
      throw new Error("rev 必须是非负整数");
    }
    var cache = ensureCache(doc);
    var C = lastRevOf(doc);
    if (rev > C) throw new Error("目标版本不存在: " + rev);
    ensureSnapshot(doc, rev, cache);
    return revertToRev(doc, rev, "revert");
  }

  // ------------------------------------------------------------------
  // Public: diff (structural difference -> replayable EditOp[])
  // ------------------------------------------------------------------

  function diffKeys(a, b) {
    var keys = Object.create(null);
    var k;
    for (k in (a || {})) keys[k] = true;
    for (k in (b || {})) keys[k] = true;
    var patch = {};
    var aOnly = false;
    for (k in keys) {
      var av = a ? a[k] : undefined;
      var bv = b ? b[k] : undefined;
      if (!deepEq(av, bv)) {
        if (bv === undefined) aOnly = true; // merged patches cannot delete keys
        else patch[k] = deepCopy(bv);
      }
    }
    return { changed: Object.keys(patch).length > 0 || aOnly, aOnly: aOnly, patch: patch };
  }

  function diff(docA, docB) {
    if (!docA || typeof docA !== "object" || !docB || typeof docB !== "object") {
      throw new Error("diff 需要两个文档对象");
    }
    var ops = [];
    var nAdd = 0, nDel = 0, nMod = 0;
    var nAnchorAdd = 0, nAnchorDel = 0, nAnchorMod = 0;
    var canvasChanged = false;

    // --- canvas ---
    var canvasPatch = {};
    var ckeys = Object.create(null);
    var ck;
    for (ck in (docA.canvas || {})) ckeys[ck] = true;
    for (ck in (docB.canvas || {})) ckeys[ck] = true;
    for (ck in ckeys) {
      var av = docA.canvas ? docA.canvas[ck] : undefined;
      var bv = docB.canvas ? docB.canvas[ck] : undefined;
      if (!deepEq(av, bv)) canvasPatch[ck] = bv === undefined ? null : deepCopy(bv);
    }
    if (Object.keys(canvasPatch).length) {
      ops.push({ op: "set_canvas", canvas: canvasPatch });
      canvasChanged = true;
    }

    // --- elements ---
    var mapA = Object.create(null), mapB = Object.create(null);
    var i;
    for (i = 0; i < docA.elements.length; i++) mapA[docA.elements[i].id] = docA.elements[i];
    for (i = 0; i < docB.elements.length; i++) mapB[docB.elements[i].id] = docB.elements[i];

    var addedEls = [];
    for (i = 0; i < docB.elements.length; i++) {
      if (!mapA[docB.elements[i].id]) addedEls.push(docB.elements[i]);
    }

    var rebuild = Object.create(null);
    function markRebuild(id) {
      if (rebuild[id]) return;
      rebuild[id] = true;
      collectDescendants(mapA, id, rebuild);
      collectDescendants(mapB, id, rebuild);
    }
    // Removed elements (and their descendants, which the cascade delete in
    // replay would take with them) must be emitted as delete ops.
    for (i = 0; i < docA.elements.length; i++) {
      if (!mapB[docA.elements[i].id]) markRebuild(docA.elements[i].id);
    }

    var moveCands = [];
    var HANDLED = { id: 1, transform: 1, style: 1, text: 1, panelLayout: 1 };
    for (i = 0; i < docA.elements.length; i++) {
      var a = docA.elements[i];
      var b = mapB[a.id];
      if (!b || rebuild[a.id]) continue;
      var ta = a.transform || {}, tb = b.transform || {};
      var xCh = !deepEq(ta.x, tb.x), yCh = !deepEq(ta.y, tb.y);
      var wCh = !deepEq(ta.w, tb.w), hCh = !deepEq(ta.h, tb.h);
      var rCh = !deepEq(ta.rotation || 0, tb.rotation || 0);
      var textCh = !deepEq(a.text, b.text);
      var styleD = diffKeys(a.style, b.style);
      var plD = diffKeys(a.panelLayout, b.panelLayout);
      var otherCh = false;
      var keys = Object.create(null), kk;
      for (kk in a) keys[kk] = true;
      for (kk in b) keys[kk] = true;
      for (kk in keys) {
        if (HANDLED[kk]) continue;
        if (!deepEq(a[kk], b[kk])) { otherCh = true; break; }
      }
      if (!xCh && !yCh && !wCh && !hCh && !rCh && !textCh && !styleD.changed && !plD.changed && !otherCh) continue;
      if (otherCh || styleD.aOnly || plD.aOnly) { markRebuild(a.id); continue; }
      if (xCh || yCh) moveCands.push({ id: a.id, dx: (tb.x || 0) - (ta.x || 0), dy: (tb.y || 0) - (ta.y || 0) });
      if (wCh || hCh) ops.push({ op: "resize", targets: [a.id], w: tb.w != null ? tb.w : null, h: tb.h != null ? tb.h : null });
      if (rCh) ops.push({ op: "rotate", targets: [a.id], rotation: tb.rotation || 0 });
      if (textCh) ops.push({ op: "set_text", targets: [a.id], text: b.text });
      if (styleD.changed && Object.keys(styleD.patch).length) {
        ops.push({ op: "set_style", targets: [a.id], style: styleD.patch });
      }
      if (plD.changed && Object.keys(plD.patch).length) {
        ops.push({ op: "panel_layout", targets: [a.id], panel: plD.patch });
      }
      nMod++;
    }

    // Skip descendant moves that a container move already implies.
    var candById = Object.create(null);
    var ci;
    for (ci = 0; ci < moveCands.length; ci++) candById[moveCands[ci].id] = moveCands[ci];
    for (ci = 0; ci < moveCands.length; ci++) {
      var cand = moveCands[ci];
      var pid = mapB[cand.id] ? mapB[cand.id].parent_id : null;
      var implied = false;
      while (pid) {
        var pc = candById[pid];
        if (pc && pc.dx === cand.dx && pc.dy === cand.dy) { implied = true; break; }
        pid = mapB[pid] ? mapB[pid].parent_id : null;
      }
      if (implied) continue;
      if (cand.dx !== 0 || cand.dy !== 0) {
        ops.push({ op: "move", targets: [cand.id], x: null, y: null, dx: cand.dx, dy: cand.dy });
      }
    }

    // Deletes first (cascade covers descendants), containers before members.
    function hasAncestorIn(id, set, map) {
      var pid = map[id] ? map[id].parent_id : null;
      while (pid) {
        if (set[pid]) return true;
        pid = map[pid] ? map[pid].parent_id : null;
      }
      return false;
    }
    for (i = 0; i < docA.elements.length; i++) {
      var da = docA.elements[i];
      if (rebuild[da.id] && !hasAncestorIn(da.id, rebuild, mapA)) {
        ops.push({ op: "delete", targets: [da.id] });
        nDel++;
      }
    }

    // Adds next: rebuilt survivors and brand-new elements, parents first.
    var addSet = Object.create(null);
    for (var rid in rebuild) if (mapB[rid]) addSet[rid] = true;
    for (i = 0; i < addedEls.length; i++) addSet[addedEls[i].id] = true;
    function depthInB(el) {
      var d = 0;
      var pid = el.parent_id;
      while (pid && mapB[pid]) { d++; pid = mapB[pid].parent_id; }
      return d;
    }
    var addList = [];
    for (var aid in addSet) if (mapB[aid]) addList.push(mapB[aid]);
    addList.sort(function (x, y) { return depthInB(x) - depthInB(y); });
    for (i = 0; i < addList.length; i++) {
      var el = deepCopy(addList[i]);
      if (el.parent_id && !mapB[el.parent_id]) el.parent_id = null;
      ops.push({ op: "add_element", element: el });
      nAdd++;
    }

    // --- anchors ---
    var ancA = Object.create(null), ancB = Object.create(null);
    var listA = docA.anchors || [], listB = docB.anchors || [];
    for (i = 0; i < listA.length; i++) ancA[listA[i].id] = listA[i];
    for (i = 0; i < listB.length; i++) ancB[listB[i].id] = listB[i];
    for (i = 0; i < listA.length; i++) {
      if (!ancB[listA[i].id]) {
        ops.push({ op: "remove_anchor", anchor: { id: listA[i].id } });
        nAnchorDel++;
      }
    }
    var AKEYS = ["label", "bbox_norm", "bbox_mm", "note", "element_ids"];
    for (i = 0; i < listB.length; i++) {
      var ab = listB[i];
      if (!ancA[ab.id]) {
        ops.push({ op: "add_anchor", anchor: deepCopy(ab) });
        nAnchorAdd++;
        continue;
      }
      var aa = ancA[ab.id];
      var patch = {};
      for (var q = 0; q < AKEYS.length; q++) {
        if (!deepEq(aa[AKEYS[q]], ab[AKEYS[q]])) patch[AKEYS[q]] = deepCopy(ab[AKEYS[q]]);
      }
      if (Object.keys(patch).length) {
        patch.id = ab.id;
        ops.push({ op: "update_anchor", anchor: patch });
        nAnchorMod++;
      }
    }

    var parts = [];
    if (nAdd) parts.push("新增 " + nAdd + " 个元素");
    if (nDel) parts.push("删除 " + nDel + " 个元素");
    if (nMod) parts.push("修改 " + nMod + " 个元素");
    if (canvasChanged) parts.push("画布已修改");
    if (nAnchorAdd) parts.push("新增 " + nAnchorAdd + " 个锚点");
    if (nAnchorDel) parts.push("删除 " + nAnchorDel + " 个锚点");
    if (nAnchorMod) parts.push("更新 " + nAnchorMod + " 个锚点");
    var summary = parts.length ? parts.join("，") : "无结构差异";
    return { ops: ops, summary: summary };
  }

  // ------------------------------------------------------------------
  // Public: validate / validateAll
  // ------------------------------------------------------------------

  function numOrNull(v) { return v === null || typeof v === "number"; }

  // set_chart_properties 的 characterization 补丁逐键类型校验。
  // technique / fit_model / fit_source / peak_annotations 只接受用户申报的
  // 值：峰位与拟合模型不做任何推断，缺申报即校验失败，绝不默认 D/G、C-C。
  function validateCharPatch(patch, errors) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      errors.push("properties.characterization 必须是对象或 null");
      return;
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      errors.push("properties.characterization 不能为空对象");
      return;
    }
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], v = patch[k];
      if (CP_CHAR_KEYS.indexOf(k) < 0) {
        errors.push("characterization 不允许的键: " + safeStr(k));
        continue;
      }
      if (v === undefined) continue;
      switch (k) {
        case "technique":
        case "fit_model":
          if (typeof v !== "string" || !v.trim()) {
            errors.push("characterization." + k + " 必须是非空字符串（由用户申报）");
          }
          break;
        case "x_label":
        case "y_label":
          if (typeof v !== "string") errors.push("characterization." + k + " 必须是字符串");
          break;
        case "x_reverse":
        case "equal_aspect":
          if (typeof v !== "boolean") errors.push("characterization." + k + " 必须是布尔值");
          break;
        case "x_scale":
          if (CP_CHAR_X_SCALES.indexOf(v) < 0) {
            errors.push("characterization.x_scale 必须是 linear/log10");
          }
          break;
        case "normalize":
          if (CP_CHAR_NORMALIZE.indexOf(v) < 0) {
            errors.push("characterization.normalize 必须是 none/max_to_unity");
          }
          break;
        case "offset_each_series":
          if (typeof v !== "number" || !isFinite(v)) {
            errors.push("characterization.offset_each_series 必须是有限数字（仅表示视觉位置，不参与统计）");
          }
          break;
        case "fit_source":
          if (CP_FIT_SOURCES.indexOf(v) < 0) {
            errors.push("characterization.fit_source 必须是 provided_by_user_fit（拟合曲线只能来自用户已提供的拟合结果）");
          }
          break;
        case "curves":
          if (!Array.isArray(v)) { errors.push("characterization.curves 必须是数组"); break; }
          for (var c = 0; c < v.length; c++) {
            var cv = v[c];
            if (!cv || typeof cv !== "object" || Array.isArray(cv)) {
              errors.push("curves[" + c + "] 必须是对象");
              continue;
            }
            var cks = Object.keys(cv);
            for (var ck = 0; ck < cks.length; ck++) {
              if (CP_CURVE_KEYS.indexOf(cks[ck]) < 0) {
                errors.push("curves[" + c + "] 不允许的键: " + safeStr(cks[ck]));
              }
            }
            if (CP_CURVE_ROLES.indexOf(cv.role) < 0) {
              errors.push("curves[" + c + "].role 必须是 fit/component/baseline");
            }
            if (typeof cv.column !== "string" || !cv.column.trim()) {
              errors.push("curves[" + c + "].column 必须是非空字符串（用户已导入的数据列）");
            }
            if (cv.label !== undefined && cv.label !== null && typeof cv.label !== "string") {
              errors.push("curves[" + c + "].label 必须是字符串");
            }
          }
          break;
        case "peak_annotations":
          if (!Array.isArray(v)) { errors.push("characterization.peak_annotations 必须是数组"); break; }
          for (var p = 0; p < v.length; p++) {
            var pv = v[p];
            if (!pv || typeof pv !== "object" || Array.isArray(pv)) {
              errors.push("peak_annotations[" + p + "] 必须是对象");
              continue;
            }
            var pks = Object.keys(pv);
            for (var pk = 0; pk < pks.length; pk++) {
              if (pks[pk] !== "x" && pks[pk] !== "label") {
                errors.push("peak_annotations[" + p + "] 不允许的键: " + safeStr(pks[pk]));
              }
            }
            if (typeof pv.x !== "number" || !isFinite(pv.x)) {
              errors.push("peak_annotations[" + p + "].x 必须是有限数字（峰位只能由用户申报）");
            }
            if (typeof pv.label !== "string" || !pv.label.trim()) {
              errors.push("peak_annotations[" + p + "].label 必须是非空字符串");
            }
          }
          break;
      }
    }
  }

  function checkTargets(op, doc, errors) {
    var raw = op.targets;
    if (!Array.isArray(raw) || raw.length === 0) {
      errors.push("缺少 targets");
      return;
    }
    var F = global.FigDoc;
    var i, t;
    for (i = 0; i < raw.length; i++) {
      t = raw[i];
      if (typeof t === "string") {
        if (t.charAt(0) === "@") {
          if (!findAnchor(doc, t.slice(1))) errors.push("锚点不存在: " + t);
        } else if (!F.get(doc, t)) {
          errors.push("目标不存在: " + t);
        }
      } else if (t && typeof t === "object") {
        if (t.kind === "type") {
          if (!t.type || ELEMENT_TYPES.indexOf(t.type) < 0) {
            errors.push("未知元素类型: " + safeStr(t.type));
          }
        } else if (t.kind !== "all") {
          errors.push("无法识别的选择器: " + safeStr(t));
        }
      } else {
        errors.push("无法识别的目标: " + safeStr(t));
      }
    }
    try {
      if (!resolveTargets(doc, raw).length) errors.push("targets 未解析到任何元素");
    } catch (e) {
      errors.push(e.message);
    }
  }

  function checkResolvedTypes(op, doc, errors, type) {
    try {
      var ids = resolveTargets(doc, op.targets);
      for (var i = 0; i < ids.length; i++) {
        var el = global.FigDoc.get(doc, ids[i]);
        if (el && el.type !== type) {
          errors.push("目标 " + ids[i] + " 不是 " + type + " 元素");
        }
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  function validate(op, doc) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return { ok: false, errors: ["doc 不能为空"] };
    }
    if (!global.FigDoc) return { ok: false, errors: ["FigDoc 未加载，无法校验"] };
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      return { ok: false, errors: ["op 必须是对象"] };
    }
    var errors = [];
    var type = op.op;
    if (typeof type !== "string" || OP_TYPES.indexOf(type) < 0) {
      return { ok: false, errors: ["未知操作类型: " + safeStr(type)] };
    }
    var F = global.FigDoc;

    if (TARGET_OPS.indexOf(type) >= 0) checkTargets(op, doc, errors);

    var i;
    switch (type) {
      case "move":
        if (op.dx == null && op.dy == null && op.x == null && op.y == null) {
          errors.push("move 需要 dx/dy 或 x/y");
        }
        ["dx", "dy"].forEach(function (k) {
          if (op[k] != null && typeof op[k] !== "number") errors.push(k + " 必须是数字");
        });
        ["x", "y"].forEach(function (k) {
          if (op[k] !== undefined && !numOrNull(op[k])) errors.push(k + " 必须是数字或 null");
        });
        break;
      case "resize":
        if (op.w == null && op.h == null) errors.push("resize 需要 w 或 h");
        ["w", "h"].forEach(function (k) {
          if (op[k] != null && (typeof op[k] !== "number" || op[k] <= 0)) {
            errors.push("resize 的 " + k + " 必须是大于 0 的数字");
          }
        });
        break;
      case "rotate":
        if (op.rotation == null && op.angle == null) errors.push("rotate 需要 rotation 或 angle");
        if (op.rotation !== undefined && op.rotation !== null && typeof op.rotation !== "number") {
          errors.push("rotation 必须是数字或 null");
        }
        if (op.angle != null && typeof op.angle !== "number") errors.push("angle 必须是数字");
        break;
      case "set_text":
        if (typeof op.text !== "string") errors.push("set_text 需要字符串 text");
        checkResolvedTypes(op, doc, errors, "text");
        break;
      case "set_style":
        if (!op.style || typeof op.style !== "object" || Array.isArray(op.style)
            || !Object.keys(op.style).length) {
          errors.push("set_style 需要非空 style 对象");
        }
        break;
      case "set_color":
        if (op.color === undefined && op.stroke === undefined) {
          errors.push("set_color 需要 color 或 stroke");
        }
        ["color", "stroke"].forEach(function (k) {
          if (op[k] !== undefined && op[k] !== null && typeof op[k] !== "string") {
            errors.push("set_color 的 " + k + " 必须是字符串或 null");
          }
        });
        break;
      case "add_element": {
        var el = op.element;
        if (!el || typeof el !== "object" || Array.isArray(el)) {
          errors.push("add_element 缺少 element 对象");
          break;
        }
        if (!el.type || ELEMENT_TYPES.indexOf(el.type) < 0) {
          errors.push("add_element 的元素类型非法: " + safeStr(el.type));
        }
        if (!el.transform || typeof el.transform !== "object") {
          errors.push("add_element 的元素缺少 transform");
        } else {
          ["x", "y", "w", "h"].forEach(function (k) {
            if (typeof el.transform[k] !== "number") {
              errors.push("add_element 的 transform." + k + " 必须是数字");
            }
          });
        }
        var newId = el.id || op.id;
        if (newId) {
          if (!ID_PATTERN.test(newId)) errors.push("元素 id 含非法字符: " + newId);
          if (F.get(doc, newId)) errors.push("元素 id 已存在: " + newId);
        }
        if (el.parent_id != null) {
          var parent = F.get(doc, el.parent_id);
          if (!parent) errors.push("父元素不存在: " + el.parent_id);
          else if (parent.type !== "group" && parent.type !== "panel") {
            errors.push("父元素必须是 group 或 panel: " + el.parent_id);
          }
        }
        break;
      }
      case "group": {
        var gid = op.id;
        if (gid) {
          if (!ID_PATTERN.test(gid)) errors.push("元素 id 含非法字符: " + gid);
          if (F.get(doc, gid)) errors.push("元素 id 已存在: " + gid);
        }
        break;
      }
      case "ungroup":
        checkResolvedTypes(op, doc, errors, "group");
        try {
          var uids = resolveTargets(doc, op.targets);
          for (var u = 0; u < uids.length; u++) {
            var ue = F.get(doc, uids[u]);
            if (ue && ue.type !== "group" && ue.type !== "panel") {
              errors.push("目标 " + uids[u] + " 不是 group/panel，无法解组");
            }
          }
        } catch (e) { errors.push(e.message); }
        break;
      case "align":
        if (!op.mode || ALIGN_MODES.indexOf(op.mode) < 0) {
          errors.push("align 需要 mode（left/center/right/top/middle/bottom）");
        }
        break;
      case "distribute":
        if (!op.orientation || ORIENTATIONS.indexOf(op.orientation) < 0) {
          errors.push("distribute 需要 orientation（horizontal/vertical）");
        }
        break;
      case "z_order":
        if (!op.to || Z_ORDER_TO.indexOf(op.to) < 0) {
          errors.push("z_order 需要 to（front/back/forward/backward）");
        }
        break;
      case "add_anchor": {
        var an = op.anchor ? op.anchor : {};
        var anId = an.id || op.id;
        if (!an.id && !op.id) errors.push("add_anchor 需要 anchor.id 或 id");
        if (anId && findAnchor(doc, anId)) errors.push("锚点 id 已存在: " + anId);
        var hasNorm = an.bbox_norm != null, hasMm = an.bbox_mm != null;
        if (!hasNorm && !hasMm) {
          errors.push("add_anchor 需要 bbox_mm 或 bbox_norm");
        } else {
          ["bbox_norm", "bbox_mm"].forEach(function (k) {
            if (an[k] == null) return;
            ["x", "y", "w", "h"].forEach(function (f) {
              if (typeof an[k][f] !== "number") {
                errors.push("add_anchor 的 " + k + "." + f + " 必须是数字");
              }
            });
          });
        }
        break;
      }
      case "remove_anchor": {
        var rid = anchorIdFromOp(op);
        if (!rid) errors.push("remove_anchor 需要 anchor.id、id 或 @锚点 targets");
        else if (!findAnchor(doc, rid)) errors.push("锚点不存在: " + rid);
        break;
      }
      case "update_anchor": {
        var uid2 = anchorIdFromOp(op);
        if (!uid2) errors.push("update_anchor 需要 anchor.id、id 或 @锚点 targets");
        else if (!findAnchor(doc, uid2)) errors.push("锚点不存在: " + uid2);
        var patchKeys = 0;
        if (op.anchor) {
          for (var pk in op.anchor) {
            if (pk !== "id" && Object.prototype.hasOwnProperty.call(op.anchor, pk)) patchKeys++;
          }
        }
        if (!patchKeys) errors.push("update_anchor 缺少要更新的字段");
        break;
      }
      case "apply_template": {
        if (!op.template_id || typeof op.template_id !== "string") {
          errors.push("apply_template 需要 template_id");
          break;
        }
        var applicability = templateApplicability(op.template_id);
        if (!applicability.ok) {
          for (var ac = 0; ac < applicability.errors.length; ac++) {
            errors.push("模板不可应用：" + applicability.errors[ac]);
          }
        }
        try { materializedTemplate(op); }
        catch (e) { errors.push(e.message); }
        break;
      }
      case "apply_journal": {
        if (!op.journal_preset_id || typeof op.journal_preset_id !== "string") {
          errors.push("apply_journal 需要 journal_preset_id");
          break;
        }
        var GPj = global.FigPresets;
        if (!GPj || typeof GPj.journal !== "function") {
          errors.push("FigPresets 未加载，无法套用期刊预设");
        } else if (!GPj.journal(op.journal_preset_id)) {
          errors.push("期刊预设不存在: " + op.journal_preset_id);
        }
        break;
      }
      case "recolor": {
        if (!op.palette_id || typeof op.palette_id !== "string") {
          errors.push("recolor 需要 palette_id");
          break;
        }
        if (op.recolor_strategy != null && RECOLOR_STRATEGIES.indexOf(op.recolor_strategy) < 0) {
          errors.push("recolor_strategy 必须是 byOrder/byHue/byRole");
        }
        var GPr = global.FigPalette;
        if (!GPr || typeof GPr.get !== "function") {
          errors.push("FigPalette 未加载，无法应用配色");
        } else if (!GPr.get(op.palette_id)) {
          errors.push("配色不存在: " + op.palette_id);
        }
        break;
      }
      case "panel_layout":
        if (!op.panel || typeof op.panel !== "object" || Array.isArray(op.panel)
            || !Object.keys(op.panel).length) {
          errors.push("panel_layout 需要非空 panel 对象");
        }
        checkResolvedTypes(op, doc, errors, "panel");
        break;
      case "set_canvas": {
        var cv = op.canvas;
        if (!cv || typeof cv !== "object" || Array.isArray(cv) || !Object.keys(cv).length) {
          errors.push("set_canvas 需要非空 canvas 对象");
          break;
        }
        ["width_mm", "height_mm", "dpi"].forEach(function (k) {
          if (cv[k] !== undefined && (typeof cv[k] !== "number" || cv[k] <= 0)) {
            errors.push("set_canvas 的 " + k + " 必须是大于 0 的数字");
          }
        });
        if (cv.background !== undefined && cv.background !== null && typeof cv.background !== "string") {
          errors.push("set_canvas 的 background 必须是字符串");
        }
        break;
      }
      case "note":
        if (!(typeof op.note === "string" && op.note.length)
            && !(typeof op.reason === "string" && op.reason.length)) {
          errors.push("note 需要 note 或 reason 字段");
        }
        break;
      case "set_scientific_contract": {
        var norm = normalizeScientificContract(op.contract, doc);
        for (var se = 0; se < norm.errors.length; se++) errors.push(norm.errors[se]);
        break;
      }
      case "set_chart_properties": {
        var cp = op.properties;
        if (!cp || typeof cp !== "object" || Array.isArray(cp) || !Object.keys(cp).length) {
          errors.push("set_chart_properties 需要非空 properties 对象");
          break;
        }
        var cpTop = Object.keys(cp);
        for (var ct = 0; ct < cpTop.length; ct++) {
          if (cpTop[ct] !== "axes" && cpTop[ct] !== "characterization") {
            errors.push("properties 不允许的键: " + safeStr(cpTop[ct]));
          }
        }
        if (cp.axes !== undefined && cp.axes !== null) {
          if (typeof cp.axes !== "object" || Array.isArray(cp.axes)) {
            errors.push("properties.axes 必须是对象");
          } else if (!Object.keys(cp.axes).length) {
            errors.push("properties.axes 不能为空对象");
          } else {
            var axesKeys = Object.keys(cp.axes);
            for (var ai = 0; ai < axesKeys.length; ai++) {
              var akey = axesKeys[ai], aval = cp.axes[akey];
              if (CP_AXES_KEYS.indexOf(akey) < 0) {
                errors.push("axes 不允许的键: " + safeStr(akey));
                continue;
              }
              if (aval === undefined) continue;
              if (akey === "xLabel" || akey === "yLabel") {
                if (typeof aval !== "string") errors.push("axes." + akey + " 必须是字符串");
              } else if (akey === "xScale" || akey === "yScale") {
                if (CP_AXES_SCALES.indexOf(aval) < 0) {
                  errors.push("axes." + akey + " 必须是 linear/log");
                }
              } else if (akey === "gridlines") {
                if (typeof aval !== "boolean") errors.push("axes.gridlines 必须是布尔值");
              }
            }
          }
        }
        if (cp.characterization !== undefined && cp.characterization !== null) {
          validateCharPatch(cp.characterization, errors);
        }
        try {
          var cids = resolveTargets(doc, op.targets);
          var hasCurves = cp.characterization && typeof cp.characterization === "object"
            && Array.isArray(cp.characterization.curves);
          for (var ci = 0; ci < cids.length; ci++) {
            var cel = F.get(doc, cids[ci]);
            if (!cel) continue;
            if (cel.type !== "chart") {
              errors.push("目标 " + cids[ci] + " 不是 chart 元素");
              continue;
            }
            if (hasCurves && cel.chart && cel.chart.data && cel.chart.data.inline
                && Array.isArray(cel.chart.data.inline.columns)) {
              var cols = cel.chart.data.inline.columns;
              for (var cvi = 0; cvi < cp.characterization.curves.length; cvi++) {
                var cvc = cp.characterization.curves[cvi];
                var colName = cvc && typeof cvc.column === "string" ? cvc.column : null;
                if (colName && cols.indexOf(colName) < 0) {
                  errors.push("目标 " + cids[ci] + " 的内联数据中不存在曲线列「" + colName + "」");
                }
              }
            }
          }
        } catch (e) {
          errors.push(e.message);
        }
        break;
      }
      case "apply_schematic":
      case "layout_schematic": {
        try {
          op.contract = deepCopy(diagramModule().normalize(schematicContract(op, doc)));
          if (op.auto_layout !== undefined && typeof op.auto_layout !== "boolean") errors.push("auto_layout 必须是布尔值");
          if (op.materialized_schematic !== undefined && op.materialized_schematic !== null) materializedSchematic(op, {});
        } catch (e) { errors.push(e.message); }
        break;
      }
      case "set_chart_data": {
        var dataProblems = chartDataProblems(doc, op);
        for (var dpe = 0; dpe < dataProblems.length; dpe++) errors.push(dataProblems[dpe]);
        break;
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // ------------------------------------------------------------------
  // Public: describe (human readable Chinese)
  // ------------------------------------------------------------------

  function targetLabel(op) {
    var ts = op && op.targets;
    if (!Array.isArray(ts) || ts.length === 0) return "目标";
    if (ts.length === 1) {
      var t = ts[0];
      if (typeof t === "string") {
        return t.charAt(0) === "@" ? ("锚点 " + t.slice(1) + " 内的元素") : t;
      }
      if (t && typeof t === "object") {
        if (t.kind === "all") return "全部元素";
        if (t.kind === "type") return (t.type || "指定类型") + " 元素";
      }
      return "目标";
    }
    return ts.length + " 个元素";
  }

  var ALIGN_NAMES = { left: "左", center: "水平居中", right: "右", top: "上", middle: "垂直居中", bottom: "下" };
  var Z_NAMES = { front: "置于最前", back: "置于最后", forward: "上移一层", backward: "下移一层" };

  function truncate(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function describe(op, doc) {
    if (!op || typeof op !== "object" || typeof op.op !== "string") return "无效操作";
    var name = targetLabel(op);
    switch (op.op) {
      case "move": {
        if (op.x != null || op.y != null) {
          return "把 " + name + " 移到 (" + (op.x != null ? op.x : "不变") + ", " + (op.y != null ? op.y : "不变") + ")mm";
        }
        var dx = op.dx || 0, dy = op.dy || 0;
        if (dx !== 0 && dy === 0) return "把 " + name + (dx > 0 ? " 右移 " : " 左移 ") + Math.abs(dx) + "mm";
        if (dy !== 0 && dx === 0) return "把 " + name + (dy > 0 ? " 下移 " : " 上移 ") + Math.abs(dy) + "mm";
        return "把 " + name + " 平移 (" + dx + ", " + dy + ")mm";
      }
      case "resize":
        return "把 " + name + " 尺寸设为 " + (op.w != null ? op.w : "不变") + "×" + (op.h != null ? op.h : "不变") + "mm";
      case "rotate":
        if (op.rotation != null) return "把 " + name + " 旋转到 " + op.rotation + "°";
        return "把 " + name + " 旋转 " + (op.angle || 0) + "°";
      case "set_text":
        return "把 " + name + " 的文本设为“" + truncate(op.text, 20) + "”";
      case "set_style": {
        var keys = op.style ? Object.keys(op.style) : [];
        var head = keys.slice(0, 3).map(function (k) { return k + "=" + truncate(op.style[k], 12); }).join(", ");
        return "把 " + name + " 的样式更新（" + head + (keys.length > 3 ? " 等" : "") + "）";
      }
      case "set_color": {
        var segs = [];
        if (op.color !== undefined) segs.push("填充色设为 " + safeStr(op.color));
        if (op.stroke !== undefined) segs.push("描边色设为 " + safeStr(op.stroke));
        return "把 " + name + " 的 " + segs.join("、");
      }
      case "add_element":
        return "添加 " + (op.element && op.element.type ? op.element.type : "元素") + " 元素 " + (op.id || (op.element && op.element.id) || "");
      case "delete":
        return "删除 " + name;
      case "group":
        return "把 " + name + " 编组为 " + (op.id || "新组");
      case "ungroup":
        return "解组 " + name;
      case "align": {
        var mn = ALIGN_NAMES[op.mode] || op.mode;
        var single = Array.isArray(op.targets) && op.targets.length === 1;
        return single ? ("把 " + name + " 在画布内" + mn + "对齐") : ("把 " + name + " 按" + mn + "对齐");
      }
      case "distribute":
        return (op.orientation === "vertical" ? "纵向" : "横向") + "等间距分布 " + name;
      case "z_order":
        return "把 " + name + (Z_NAMES[op.to] ? Z_NAMES[op.to] : "调整层级");
      case "add_anchor":
        return "添加锚点 " + ((op.anchor && op.anchor.id) || op.id || "");
      case "remove_anchor":
        return "删除锚点 " + ((op.anchor && op.anchor.id) || op.id || "");
      case "update_anchor":
        return "更新锚点 " + ((op.anchor && op.anchor.id) || op.id || "");
      case "apply_template":
        return "应用模板 " + op.template_id;
      case "apply_journal":
        return "套用期刊预设 " + op.journal_preset_id;
      case "recolor":
        return "按 " + (op.recolor_strategy || "byHue") + " 策略将文档配色换为 " + op.palette_id;
      case "panel_layout": {
        var pl = op.panel || {};
        return "设置 " + name + " 的面板布局（" + (pl.cols || "?") + "×" + (pl.rows || "?") + "）";
      }
      case "set_canvas":
        return "修改画布（" + (op.canvas ? Object.keys(op.canvas).join(", ") : "") + "）";
      case "note":
        return "备注：" + truncate(op.note != null ? op.note : op.reason, 40);
      case "set_scientific_contract": {
        var c = op.contract || {};
        var parts = [];
        if (c.results_question) parts.push("问题");
        if (c.figure_claim) parts.push("结论");
        if (c.falsifier) parts.push("反证条件");
        if (Array.isArray(c.panels) && c.panels.length) parts.push(c.panels.length + " 个面板");
        if (c.statistics && Object.keys(c.statistics).length) parts.push(Object.keys(c.statistics).length + " 项统计");
        return "更新科学论证合同（" + (parts.length ? parts.join("、") : "空轮廓") + "）";
      }
      case "set_chart_properties": {
        var dcp = op.properties || {};
        var dbits = [];
        if (dcp.axes && Object.keys(dcp.axes).length) {
          dbits.push("坐标轴（" + Object.keys(dcp.axes).join(", ") + "）");
        }
        if (dcp.characterization === null) {
          dbits.push("清除表征参数");
        } else if (dcp.characterization && Object.keys(dcp.characterization).length) {
          dbits.push("表征参数（" + Object.keys(dcp.characterization).join(", ") + "）");
        }
        return "更新 " + name + " 的图表属性（" + (dbits.join("、") || "无变更") + "）";
      }
      case "apply_schematic":
      case "layout_schematic": {
        var schematic = op.contract || {};
        var scene = schematic.id || op.diagram_id || op.scene_id || op.id || "未命名";
        return (op.op === "layout_schematic" ? "重排" : "应用") + "实体关系示意图 " + scene +
          "（" + (Array.isArray(schematic.nodes) ? schematic.nodes.length : 0) + " 节点，" +
          (Array.isArray(schematic.relations) ? schematic.relations.length : 0) + " 关系）";
      }
      case "set_chart_data":
        return "经用户批准替换 " + name + " 的 inline 数据，保留 mapping/style 与原始统计声明并要求重审";
      default:
        return "未知操作 " + op.op;
    }
  }

  // ------------------------------------------------------------------
  // Export
  // ------------------------------------------------------------------

  var FigOps = {
    OP_TYPES: OP_TYPES,
    MAX_HISTORY: MAX_HISTORY,
    validate: validate,
    validateAll: validateAll,
    apply: apply,
    applyAll: applyAll,
    captureHistoryOrigin: captureHistoryOrigin,
    contentRev: contentRevOf,
    ensureSnapshot: ensureSnapshot,
    finalizeHistory: finalizeHistory,
    undo: undo,
    redo: redo,
    revertTo: revertTo,
    diff: diff,
    describe: describe,
    resolveTargets: resolveTargets,
    CHART_PROPERTIES: {
      AXES_KEYS: CP_AXES_KEYS,
      AXES_SCALES: CP_AXES_SCALES,
      CHARACTERIZATION_KEYS: CP_CHAR_KEYS,
      CURVE_KEYS: CP_CURVE_KEYS,
      CURVE_ROLES: CP_CURVE_ROLES,
      CHAR_X_SCALES: CP_CHAR_X_SCALES,
      CHAR_NORMALIZE: CP_CHAR_NORMALIZE,
      FIT_SOURCES: CP_FIT_SOURCES
    },
    SCIENTIFIC_CONTRACT: {
      KEYS: SC_CONTRACT_KEYS,
      ARCHETYPES: SC_ARCHETYPES,
      EVIDENCE_ROLES: SC_EVIDENCE_ROLES,
      DESTINATIONS: SC_DESTINATIONS,
      PANEL_KEYS: SC_PANEL_KEYS,
      STATS_KEYS: SC_STATS_KEYS,
      SPREADS: SC_SPREADS,
      SOURCES: SC_SOURCES,
      SCHEMA_VERSION: SC_SCHEMA_VERSION,
      normalize: normalizeScientificContract
    }
  };

  global.FigOps = FigOps;
})(typeof globalThis !== "undefined" ? globalThis : this);
