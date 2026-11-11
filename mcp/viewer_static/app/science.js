/*
 * SciencePanel — 科学论证工作台（v3 查看器侧栏面板, app/science.js)
 *
 * 把 nature-figure 风格的科学论证合同（question → figure_claim → falsifier →
 * 面板证据角色/独立增益/比较/去向 → 统计声明）做成用户可编辑的两步表单。
 * 本面板不做任何 AI 推断：候选面板来自 FigScience.panelCandidates 的纯几何
 * 排序，统计字段全部留空表示 unknown（绝不默认 n=3 或猜测检验）。
 *
 * 全局 API：
 *   SciencePanel.mount(panelEl)          挂载面板（可重复调用，重建 UI）
 *   SciencePanel.audit()                 运行 FigScience.audit 并渲染结果，返回结果
 *   SciencePanel.reviewContext()         返回 {warnings}（FigScience + FigPresets.check 叠加）
 *   SciencePanel.physicalSizePreview()   以 CSS 96 px/in 参考尺寸临时预览 / 还原
 *
 * 保存走 App.commit([{op:"set_scientific_contract", contract}], {label, source})，
 * 与内核 history / 撤销 / 重做一致；执行器不支持该 OP 时如实 toast，不假装成功。
 *
 * 依赖（script 顺序）：内核 lib/figdoc+ops+science+…+data，app/state.js、app/ui.js、
 * app/editor.js。本文件不改 main/index.html/ai.js（挂载由 main.js 集成）。
 */
(function (global) {
  "use strict";

  var ZOOM_96DPI = 96 / 25.4; // CSS 参考换算，不表示显示器物理校准
  var LIMITS = {
    question: 500, claim: 500, falsifier: 500,
    panelText: 300, statText: 200
  };

  var EVIDENCE_ROLES = [
    ["setup", "setup（铺垫/背景）"],
    ["example", "example（示例）"],
    ["primary", "primary（主证据）"],
    ["control", "control（对照）"],
    ["decomposition", "decomposition（分解）"],
    ["stratification", "stratification（分层）"],
    ["orthogonal", "orthogonal（正交验证）"],
    ["perturbation", "perturbation（扰动实验）"],
    ["boundary", "boundary（边界条件）"],
    ["mechanistic", "mechanistic（机理）"]
  ];
  var DESTINATIONS = [
    ["main", "main（主图）"],
    ["extended", "extended（扩展数据）"],
    ["other", "other（其他）"],
    ["discard", "discard（弃用）"]
  ];
  var ARCHETYPES = [
    ["", "未申报"],
    ["quantitative_grid", "quantitative_grid（量化网格）"],
    ["schematic_led_composite", "schematic_led_composite（示意主导复合）"],
    ["image_plate_quant", "image_plate_quant（图像版+定量）"],
    ["asymmetric_mixed", "asymmetric_mixed（非对称混合）"]
  ];
  var SPREADS = [["", "未申报"], ["SD", "SD"], ["SEM", "SEM"], ["95CI", "95CI"], ["range", "range"]];
  var SOURCES = [["", "未申报"], ["replicates", "replicates（原始重复观测）"], ["column", "column（误差列）"]];
  var CENTERS = [["", "未申报"], ["mean", "mean"], ["median", "median"], ["geometric_mean", "geometric_mean"], ["other", "other"]];

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  var rootEl = null;          // panel container
  var refs = {};              // cached element lookups
  var cardsById = {};         // element_id -> built card fields (save reads these)
  var savedZoom = null;       // physical-size preview: zoom before preview
  var previewActive = false;
  var muted = false;          // suppress refresh loops during our own commits

  function has(name) {
    return typeof global[name] !== "undefined" && global[name] !== null;
  }

  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  function toast(text, opts) {
    if (has("Ui") && typeof global.Ui.toast === "function") {
      global.Ui.toast(text, opts || {});
    }
  }

  function requireDoc() {
    if (!has("App") || !global.App.doc) {
      throw new Error("文档尚未初始化，无法使用科学论证工作台");
    }
    return global.App.doc;
  }

  function requireScience() {
    if (!has("FigScience")) {
      throw new Error("缺少内核 FigScience（请先加载 lib/science.js）");
    }
    return global.FigScience;
  }

  // ------------------------------------------------------------------
  // DOM helpers (Ui.h if available, otherwise plain DOM)
  // ------------------------------------------------------------------

  function h(tag, attrs, children) {
    if (has("Ui") && typeof global.Ui.h === "function") {
      return global.Ui.h(tag, attrs, children);
    }
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") el.className = String(v);
        else if (k === "text") el.textContent = String(v);
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    });
    return el;
  }

  function button(opts) {
    if (has("Ui") && typeof global.Ui.button === "function") {
      return global.Ui.button(opts);
    }
    var b = h("button", { class: "ui-btn", text: opts.label || "按钮", title: opts.title || "" });
    if (opts.onClick) b.addEventListener("click", opts.onClick);
    return b;
  }

  // labeled field row; returns {wrap, input}
  function field(label, input, hint) {
    var wrap = h("div", { class: "science-field" });
    var lab = h("label", { class: "science-field-label", text: label });
    wrap.appendChild(lab);
    wrap.appendChild(input);
    if (hint) wrap.appendChild(h("div", { class: "science-field-hint", text: hint }));
    return { wrap: wrap, input: input };
  }

  function inputEl(kind, value, onChange) {
    var el;
    if (kind === "textarea") {
      el = h("textarea", { class: "science-input science-textarea" });
      el.value = value == null ? "" : String(value);
    } else if (kind === "select") {
      el = h("select", { class: "science-input" });
    } else {
      el = h("input", { class: "science-input", type: kind === "number" ? "number" : "text" });
      if (value != null) el.value = String(value);
    }
    if (onChange) el.addEventListener("change", onChange);
    return el;
  }

  function fillSelect(sel, options, value) {
    sel.innerHTML = "";
    options.forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt[0];
      o.textContent = opt[1];
      sel.appendChild(o);
    });
    if (value != null && value !== "") sel.value = String(value);
    return sel;
  }

  // ------------------------------------------------------------------
  // Column typing for the statistics binding (numeric vs categorical)
  // ------------------------------------------------------------------

  function chartInline(chart) {
    return chart && chart.data && chart.data.inline &&
      Array.isArray(chart.data.inline.columns) &&
      Array.isArray(chart.data.inline.rows) ? chart.data.inline : null;
  }

  function isNumericColumn(inline, colIdx) {
    var seen = 0;
    for (var i = 0; i < inline.rows.length; i++) {
      var row = inline.rows[i];
      if (!Array.isArray(row)) continue;
      var v = row[colIdx];
      if (v === null || v === undefined || v === "") continue;
      var n = Number(v);
      if (!isFinite(n)) return false;
      seen++;
    }
    return seen > 0;
  }

  function columnOptions(chartEl) {
    var inline = chartInline(chartEl && chartEl.chart);
    if (!inline) return [];
    var out = [];
    for (var i = 0; i < inline.columns.length; i++) {
      var kind = isNumericColumn(inline, i) ? "numeric" : "categorical";
      out.push({ name: inline.columns[i], kind: kind });
    }
    return out;
  }

  function getChartEl(doc, id) {
    var els = doc.elements || [];
    for (var i = 0; i < els.length; i++) {
      if (els[i].id === id && els[i].type === "chart") return els[i];
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Contract <-> form
  // ------------------------------------------------------------------

  function readContractSafe() {
    var S = requireScience();
    var doc = requireDoc();
    return S.readContract(doc);
  }

  function buildContractFromForm() {
    var candidates = currentCandidates();
    var stats = {};
    var panels = [];
    candidates.forEach(function (cand, idx) {
      var card = cardsById[cand.element_id];
      if (!card) return;
      var role = card.role.value || null;
      var destination = card.destination.value || null;
      var panel = {
        element_id: cand.element_id,
        label: cand.label,
        sequence: cand.sequence
      };
      var question = card.question.value.trim();
      if (question) panel.question = question.slice(0, LIMITS.panelText);
      if (role) panel.evidence_role = role;
      var cmp = card.comparison.value.trim();
      if (cmp) panel.decisive_comparison = cmp.slice(0, LIMITS.panelText);
      var gain = card.gain.value.trim();
      if (gain) panel.unique_gain = gain.slice(0, LIMITS.panelText);
      var dep = card.dependency.value.trim();
      if (dep) panel.claim_dependency = dep.slice(0, LIMITS.panelText);
      if (destination) panel.destination = destination;
      panels.push(panel);

      // statistics: only bind chart elements; 单个空字段不写，整表为空时发送 {} 清除
      var chartEl = getChartEl(requireDoc(), cand.element_id);
      if (!chartEl) return;
      var sf = card.stats;
      if (!sf) return;
      var entry = {};
      var nv = sf.nDefinition.value.trim();
      if (nv) entry.n_definition = nv.slice(0, LIMITS.statText);
      var bio = sf.bio.value;
      if (bio !== "" && bio != null && isFinite(Number(bio))) entry.biological_replicates = Number(bio);
      var tech = sf.tech.value;
      if (tech !== "" && tech != null && isFinite(Number(tech))) entry.technical_replicates = Number(tech);
      var center = sf.center.value;
      if (center) entry.center = center;
      var spread = sf.spread.value;
      if (spread) entry.spread = spread;
      var src = sf.source.value;
      if (src) entry.uncertainty_source = src;
      var col = sf.column.value;
      if (col) entry.uncertainty_column = col;
      var test = sf.test.value.trim();
      if (test) entry.test = test.slice(0, LIMITS.statText);
      var corr = sf.correction.value.trim();
      if (corr) entry.correction = corr.slice(0, LIMITS.statText);
      var comparison = sf.statComparison.value.trim();
      if (comparison) entry.comparison = comparison.slice(0, LIMITS.statText);
      var pv = sf.pValue.value;
      if (pv !== "" && pv != null && isFinite(Number(pv))) {
        var pnum = Number(pv);
        if (pnum >= 0 && pnum <= 1) entry.p_value = pnum;
      }
      var sd = sf.sourceData.value.trim();
      if (sd) entry.source_data = sd.slice(0, LIMITS.statText);
      var ux = sf.unitX.value.trim();
      if (ux) entry.unit_x = ux.slice(0, 50);
      var uy = sf.unitY.value.trim();
      if (uy) entry.unit_y = uy.slice(0, 50);
      // Always send this chart's whole statistics object: an empty form is an
      // explicit {} clear, not an omitted patch that preserves stale values.
      stats[cand.element_id] = entry;
    });

    var contract = {
      results_question: refs.question.value.trim().slice(0, LIMITS.question) || null,
      figure_claim: refs.claim.value.trim().slice(0, LIMITS.claim) || null,
      falsifier: refs.falsifier.value.trim().slice(0, LIMITS.falsifier) || null,
      archetype: refs.archetype.value || null,
      hero_panel: refs.hero.value || null,
      panels: panels,
      statistics: stats
    };
    return contract;
  }

  function fillFormFromContract(contract) {
    refs.question.value = contract.results_question || "";
    refs.claim.value = contract.figure_claim || "";
    refs.falsifier.value = contract.falsifier || "";
    fillSelect(refs.archetype, ARCHETYPES, contract.archetype || "");
    refreshHeroOptions(contract.hero_panel || null);
  }

  // ------------------------------------------------------------------
  // Panel candidates / cards
  // ------------------------------------------------------------------

  function currentCandidates() {
    var S = requireScience();
    var doc = requireDoc();
    return S.panelCandidates(doc);
  }

  function refreshCandidates() {
    var cands = currentCandidates();
    var listEl = refs.cards;
    listEl.innerHTML = "";
    cardsById = {};
    var contract = readContractSafe();
    var statsMap = contract.statistics || {};
    var panelMap = {};
    (contract.panels || []).forEach(function (p) {
      if (p && p.element_id) panelMap[p.element_id] = p;
    });

    if (!cands.length) {
      listEl.appendChild(h("div", {
        class: "science-empty",
        text: "文档内没有 chart/panel 元素：先把图表放进画布，再回来配置面板。"
      }));
      return;
    }

    cands.forEach(function (cand) {
      var card = buildCard(cand, panelMap[cand.element_id] || null, statsMap[cand.element_id] || null);
      cardsById[cand.element_id] = card;
      listEl.appendChild(card.el);
    });
  }

  function buildCard(cand, existingPanel, existingStats) {
    var el = h("div", { class: "science-card" });
    var doc = requireDoc();
    var chartEl = getChartEl(doc, cand.element_id);

    el.appendChild(h("div", { class: "science-card-head" }, [
      h("span", { class: "science-card-badge", text: cand.label }),
      h("span", { class: "science-card-title", text: cand.element_id }),
      h("span", { class: "science-card-meta", text: cand.type + (chartEl && chartEl.chart && chartEl.chart.chartType ? " · " + chartEl.chart.chartType : "") })
    ]));

    // --- evidence fields ---
    var role = inputEl("select");
    fillSelect(role, [["", "未申报"]].concat(EVIDENCE_ROLES), existingPanel ? existingPanel.evidence_role : null);
    var destination = inputEl("select");
    fillSelect(destination, [["", "未申报"]].concat(DESTINATIONS), existingPanel ? existingPanel.destination : null);
    var question = inputEl("text", existingPanel ? existingPanel.question : null);
    var comparison = inputEl("text", existingPanel ? existingPanel.decisive_comparison : null);
    var gain = inputEl("text", existingPanel ? existingPanel.unique_gain : null);
    var dependency = inputEl("text", existingPanel ? existingPanel.claim_dependency : null);

    el.appendChild(field("证据角色 evidence_role", role).wrap);
    el.appendChild(field("该面板回答的问题", question).wrap);
    el.appendChild(field("决定性比较 decisive_comparison", comparison).wrap);
    el.appendChild(field("独立增益 unique_gain（去掉它读者失去什么）", gain).wrap);
    el.appendChild(field("与图级声明的依赖 claim_dependency", dependency).wrap);
    el.appendChild(field("去向 destination", destination).wrap);

    var card = {
      el: el, role: role, destination: destination, question: question,
      comparison: comparison, gain: gain, dependency: dependency, stats: null
    };

    // --- statistics binding（仅 chart 元素；纯图形面板无统计可绑定）---
    if (chartEl) {
      var inline = chartInline(chartEl.chart);
      var statsWrap = h("div", { class: "science-stats" });
      statsWrap.appendChild(h("div", { class: "science-stats-title", text: "统计绑定 chart.statistics" }));
      if (!inline) {
        statsWrap.appendChild(h("div", { class: "science-field-hint", text: "该图表缺少内联数据（chart.data.inline），replicates 模式无法计算误差线。" }));
      }
      var nDefinition = inputEl("text", existingStats ? existingStats.n_definition : null);
      var bio = inputEl("number", existingStats && existingStats.biological_replicates != null ? existingStats.biological_replicates : "");
      var tech = inputEl("number", existingStats && existingStats.technical_replicates != null ? existingStats.technical_replicates : "");
      var center = inputEl("select");
      fillSelect(center, CENTERS, existingStats ? existingStats.center : null);
      var spread = inputEl("select");
      fillSelect(spread, SPREADS, existingStats ? existingStats.spread : null);
      var source = inputEl("select");
      fillSelect(source, SOURCES, existingStats ? existingStats.uncertainty_source : null);
      var column = inputEl("select");
      var colOpts = [["", "未申报"]].concat(columnOptions(chartEl).map(function (c) {
        return [c.name, c.name + "（" + (c.kind === "numeric" ? "数值" : "类别") + "列）"];
      }));
      fillSelect(column, colOpts, existingStats ? existingStats.uncertainty_column : null);
      var test = inputEl("text", existingStats ? existingStats.test : null);
      var correction = inputEl("text", existingStats ? existingStats.correction : null);
      var statComparison = inputEl("text", existingStats ? existingStats.comparison : null);
      var pValue = inputEl("number", existingStats && existingStats.p_value != null ? existingStats.p_value : "");
      var sourceData = inputEl("text", existingStats ? existingStats.source_data : null);
      var unitX = inputEl("text", existingStats ? existingStats.unit_x : null);
      var unitY = inputEl("text", existingStats ? existingStats.unit_y : null);

      statsWrap.appendChild(field("n 的定义 n_definition", nDefinition).wrap);
      var repRow = h("div", { class: "science-rep-row" });
      repRow.appendChild(field("生物学重复", bio, "留空 = unknown，不默认 n=3").wrap);
      repRow.appendChild(field("技术重复", tech).wrap);
      statsWrap.appendChild(repRow);
      statsWrap.appendChild(field("中心量 center", center).wrap);
      statsWrap.appendChild(field("离散度量 spread", spread).wrap);
      statsWrap.appendChild(field("误差来源 uncertainty_source", source).wrap);
      statsWrap.appendChild(field("误差列 uncertainty_column（column 模式）", column,
        inline ? undefined : "需要内联数据列").wrap);
      statsWrap.appendChild(field("检验 test", test).wrap);
      statsWrap.appendChild(field("校正 correction", correction).wrap);
      statsWrap.appendChild(field("比较对象 comparison", statComparison).wrap);
      statsWrap.appendChild(field("p 值 p_value（0–1，不编造）", pValue).wrap);
      statsWrap.appendChild(field("原始数据来源 source_data", sourceData).wrap);
      var unitRow = h("div", { class: "science-rep-row" });
      unitRow.appendChild(field("单位 unit_x", unitX).wrap);
      unitRow.appendChild(field("单位 unit_y", unitY).wrap);
      statsWrap.appendChild(unitRow);

      el.appendChild(statsWrap);
      card.stats = {
        nDefinition: nDefinition, bio: bio, tech: tech, center: center,
        spread: spread, source: source, column: column, test: test,
        correction: correction, statComparison: statComparison, pValue: pValue,
        sourceData: sourceData, unitX: unitX, unitY: unitY
      };
    } else {
      el.appendChild(h("div", {
        class: "science-field-hint",
        text: "非 chart 元素（panel/图元）：无统计绑定，仅申报证据角色与增益。"
      }));
    }

    return card;
  }

  // ------------------------------------------------------------------
  // Hero options
  // ------------------------------------------------------------------

  function refreshHeroOptions(selected) {
    var hero = refs.hero;
    hero.innerHTML = "";
    var cands = [];
    try { cands = currentCandidates(); } catch (e) { cands = []; }
    var opts = [["", "未指定"]];
    cands.forEach(function (c) {
      opts.push([c.element_id, c.label + " · " + c.element_id]);
    });
    opts.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0];
      op.textContent = o[1];
      hero.appendChild(op);
    });
    if (selected) hero.value = String(selected);
  }

  // ------------------------------------------------------------------
  // Save (via App.commit, honest failure)
  // ------------------------------------------------------------------

  function save() {
    var App = global.App;
    var doc = requireDoc();
    var contract = buildContractFromForm();
    var empty = !contract.results_question && !contract.figure_claim && !contract.falsifier &&
      (!contract.panels || !contract.panels.length) &&
      (!contract.statistics || !Object.keys(contract.statistics).length);
    if (empty) {
      toast("合同为空轮廓：请至少填写问题/结论/反证之一，或配置面板", { type: "info" });
      return;
    }
    if (!has("App") || typeof App.commit !== "function") {
      toast("缺少 App.commit，无法保存", { type: "error" });
      return;
    }
    muted = true;
    Promise.resolve(App.commit(
      [{ op: "set_scientific_contract", contract: contract }],
      { label: "更新科学论证", source: "user" }
    )).then(function (result) {
      muted = false;
      var applied = result && typeof result.applied === "number" ? result.applied : 0;
      if (!applied) {
        // 执行器不支持该 OP 或校验失败：如实告知，不假装成功
        toast("未保存：当前内核不支持 set_scientific_contract 或校验未通过（详见错误提示）",
          { type: "error", ms: 5000 });
        renderAudit();
        return;
      }
      var savedDoc = result && result.doc;
      var rev = savedDoc && savedDoc.history && savedDoc.history.length
        ? savedDoc.history[savedDoc.history.length - 1].rev : null;
      toast("已保存科学论证合同" + (rev != null ? "（版本 " + rev + "，可撤销）" : ""), { type: "success" });
      refreshCandidates(); // 回显与 undo/history 一致
      renderAudit();
    }).catch(function (err) {
      muted = false;
      toast("保存失败：" + errText(err), { type: "error", ms: 5000 });
    });
  }

  // ------------------------------------------------------------------
  // Audit rendering
  // ------------------------------------------------------------------

  var SEVERITY_LABEL = { error: "错误", warning: "警告", info: "提示" };

  function renderAudit() {
    var box = refs.auditBox;
    box.innerHTML = "";
    var result;
    try {
      result = SciencePanel.audit();
    } catch (e) {
      box.appendChild(h("div", { class: "science-warn science-warn-error", text: "审计失败：" + errText(e) }));
      return null;
    }
    if (!result) return null;

    // ready 判定 + coverage：不隐藏失败，也不把“不适用”当成通过
    var ready = result.scientific_ready === true;
    box.appendChild(h("div", { class: "science-audit-head" }, [
      h("span", {
        class: "science-ready " + (ready ? "science-ready-ok" : "science-ready-no"),
        text: ready ? "科学论证就绪" : "科学论证未就绪（非 PASS）"
      })
    ]));

    var cov = result.coverage || {};
    var covRow = h("div", { class: "science-coverage" });
    [["question", "问题"], ["panels", "面板"], ["statistics", "统计"], ["final_size", "物理尺寸"]].forEach(function (kv) {
      var v = cov[kv[0]];
      var chip = h("span", {
        class: "science-chip " + (v === true ? "science-chip-ok" : (v === false ? "science-chip-no" : "science-chip-na")),
        text: kv[1] + " " + (v === true ? "✓" : (v === false ? "✗" : "n/a"))
      });
      covRow.appendChild(chip);
    });
    box.appendChild(covRow);

    // checks（含“不适用”明细）
    (result.checks || []).forEach(function (c) {
      box.appendChild(h("div", { class: "science-check science-check-" + (c.status || "warn") }, [
        h("span", { class: "science-check-name", text: c.name }),
        h("span", { class: "science-check-status", text: c.status === "pass" ? "pass" : (c.status === "fail" ? "fail" : (c.status === "na" ? "不适用" : "warn")) }),
        h("span", { class: "science-check-detail", text: c.detail || "" })
      ]));
    });

    var warnings = result.warnings || [];
    if (!warnings.length) {
      box.appendChild(h("div", { class: "science-empty", text: "无告警。" }));
    }
    warnings.forEach(function (w) {
      var sev = SEVERITY_LABEL[w.severity] || w.severity || "警告";
      var line = "[" + sev + "] " + (w.message || "");
      if (w.element_id) line += "（" + w.element_id + "）";
      box.appendChild(h("div", { class: "science-warn science-warn-" + (w.severity || "warning"), text: line }));
    });
    return result;
  }

  // ------------------------------------------------------------------
  // Physical size preview (96dpi)
  // ------------------------------------------------------------------

  function physicalSizePreview() {
    var App = global.App;
    var Editor = global.Editor;
    if (!Editor || typeof Editor.setZoom !== "function") {
      toast("缺少 Editor.setZoom，无法预览物理尺寸", { type: "error" });
      return false;
    }
    if (!previewActive) {
      savedZoom = App && App.ui && typeof App.ui.zoom === "number" ? App.ui.zoom : 1;
      Editor.setZoom(ZOOM_96DPI);
      previewActive = true;
      if (refs.btnPreview) refs.btnPreview.textContent = "还原缩放";
      toast("CSS 参考尺寸预览：1mm = 96/25.4 CSS px；不代表显示器校准或真实物理尺寸。再次点击还原。", { type: "info", ms: 5000 });
    } else {
      Editor.setZoom(savedZoom || 1);
      previewActive = false;
      if (refs.btnPreview) refs.btnPreview.textContent = "CSS 参考尺寸预览";
      toast("已还原缩放 " + Math.round((savedZoom || 1) * 100) + "%", { type: "info" });
    }
    return previewActive;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  var SciencePanel = {

    mount: function (panelEl) {
      if (!panelEl || typeof panelEl.appendChild !== "function") {
        throw new Error("SciencePanel.mount: panelEl 必须是 DOM 元素");
      }
      rootEl = panelEl;
      panelEl.innerHTML = "";
      refs = {};

      panelEl.appendChild(h("div", { class: "ui-panel-title", text: "科学论证" }));
      panelEl.appendChild(h("div", {
        class: "science-intro",
        text: "两步声明：整图问题/结论/反证 → 每个面板的证据角色、独立增益、比较与统计。全部字段由用户填写，留空表示 unknown，本面板不做 AI 推断。"
      }));

      var btnRow = h("div", { class: "ui-btn-row" });
      var btnAudit = button({ label: "审计检查", title: "运行 FigScience.audit（结构 + 统计 + 物理尺寸）", onClick: function () { renderAudit(); } });
      var btnPreview = button({ label: "CSS 参考尺寸预览", title: "按 CSS 96 px/in 换算预览；不校准显示器，再次点击还原", onClick: function () { physicalSizePreview(); } });
      var btnSave = button({ label: "保存到文档", title: "经 set_scientific_contract 写入文档（保留历史，可撤销）", onClick: function () { save(); } });
      refs.btnPreview = btnPreview;
      btnRow.appendChild(btnAudit);
      btnRow.appendChild(btnPreview);
      btnRow.appendChild(btnSave);
      panelEl.appendChild(btnRow);

      // --- step 1: figure level ---
      panelEl.appendChild(h("div", { class: "science-step-title", text: "第一步 · 整图" }));
      refs.question = inputEl("textarea");
      refs.claim = inputEl("textarea");
      refs.falsifier = inputEl("textarea");
      refs.archetype = inputEl("select");
      fillSelect(refs.archetype, ARCHETYPES, "");
      refs.hero = inputEl("select");
      panelEl.appendChild(field("整图问题 results_question", refs.question).wrap);
      panelEl.appendChild(field("图级声明 figure_claim", refs.claim).wrap);
      panelEl.appendChild(field("反证/失效条件 falsifier", refs.falsifier).wrap);
      panelEl.appendChild(field("原型 archetype", refs.archetype).wrap);
      panelEl.appendChild(field("主图 hero_panel", refs.hero).wrap);

      // --- step 2: per-panel cards ---
      panelEl.appendChild(h("div", { class: "science-step-title", text: "第二步 · 面板（按阅读顺序 a,b,c…）" }));
      refs.cards = h("div", { class: "science-cards" });
      panelEl.appendChild(refs.cards);

      panelEl.appendChild(h("div", { class: "science-step-title", text: "审计结果" }));
      refs.auditBox = h("div", { class: "science-audit" });
      panelEl.appendChild(refs.auditBox);

      // 回显已保存合同；随文档变化刷新（不进入我们自己的提交循环）
      try {
        fillFormFromContract(readContractSafe());
      } catch (e) {
        toast("读取合同失败：" + errText(e), { type: "error" });
      }
      try {
        refreshCandidates();
      } catch (e) {
        refs.cards.appendChild(h("div", { class: "science-empty", text: "面板候选读取失败：" + errText(e) }));
      }
      if (has("App") && typeof global.App.on === "function") {
        global.App.on("doc:changed", function () {
          if (muted) return;
          try {
            fillFormFromContract(readContractSafe());
            refreshCandidates();
          } catch (e) { /* doc not ready yet */ }
          // 撤销/外部修改后审计结论同步刷新，不展示过期 PASS
          try { renderAudit(); } catch (e2) { /* audit optional */ }
        });
      }
      renderAudit();
      return panelEl;
    },

    audit: function () {
      var S = requireScience();
      var doc = requireDoc();
      return S.audit(doc);
    },

    reviewContext: function () {
      var S = requireScience();
      var doc = requireDoc();
      var warnings = S.reviewContext(doc).warnings || [];
      // 可叠加 FigPresets.check（同形状 {code,message,element_id?}）
      if (has("FigPresets") && typeof global.FigPresets.check === "function") {
        try {
          var extra = global.FigPresets.check(doc).warnings || [];
          warnings = warnings.concat(extra);
        } catch (e) { /* check 失败不阻断 */ }
      }
      return { warnings: warnings };
    },

    physicalSizePreview: physicalSizePreview
  };

  global.SciencePanel = SciencePanel;
})(typeof globalThis !== "undefined" ? globalThis : this);
