/*
 * data-wizard.js — DataWizard（R02 数据映射向导）
 *
 * CSV/JSON/TSV 与 Excel 共用的「数据预览 → 字段映射 → 图表和画布预览 → 创建」
 * 向导。解析与推荐继续由 import.js / FigData / spreadsheet 服务负责；本模块
 * 只承载对话框内的草稿状态：
 *
 *   DataWizard.open({
 *     filename, data, recommendations, sourceInfo, appName,
 *     currentCanvas,            // 当前 App 画布（保持模式的有效画布）
 *     buildDraft(templateId, mapping, canvasChoice, title)
 *       -> {elements, chart, warnings, capability, data_bound, effectiveCanvas}
 *       // 唯一构建入口：内部调用 FigPresets.templateFromStats(templateId,
 *       // data, {mapping, title, journal_id}) + 画布选择 + fitIntoCanvas。
 *       // 预览与最终创建共用同一函数，保证预览=最终。
 *     onCreate(templateId, mapping, canvasChoice, title)
 *       -> Promise<true|false>   // 一笔 App.commit；false 保持对话框打开
 *   }) -> handle
 *
 * handle（供 GUI 与 headless 测试共用）：
 *   draft() 当前草稿；selectTemplate/setMapping/setCanvasChoice/setTitle；
 *   step() 当前步骤（1-4）；goTo(n) 跳转；quickCreate() 按推荐直接创建；
 *   refreshPreview() 重建预览与统计摘要；create() 触发 onCreate 一次；
 *   closeModal()。所有控件是原生 select/input/radio/button，键盘可达。
 *
 * 约束（R02）：
 * - 草稿只存在于对话框内；预览不调用 App.commit、不写历史/工程；
 * - 自动推断只作默认值，用户确认值优先（kernel opts.mapping）；
 * - 渲染聚合方式、缺失值、被排除行数在确认页如实展示（RENDERER_SEMANTICS）；
 * - 模板期刊默认只作为建议显示，未经确认不改变用户画布；
 * - 被排除行数以 FigData.renderableRows（复用渲染器自身 prep）为准，
 *   不再维护平行规则（G07）。
 */
(function (global) {
  'use strict';

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function fail(msg) {
    throw new Error('DataWizard：' + msg);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function h(tag, attrs, children) {
    return global.Ui.h(tag, attrs, children);
  }

  function toast(text, type) {
    try {
      if (global.Ui && typeof global.Ui.toast === 'function') {
        global.Ui.toast(text, { type: type || 'info' });
        return;
      }
    } catch (e) { /* fall through */ }
    if (global.console) console.log('[DataWizard] ' + text);
  }

  function focusEl(el) {
    try {
      if (el && typeof el.focus === 'function') el.focus();
    } catch (e) { /* best effort */ }
  }

  function addClass(el, cls) {
    var cur = el.className || '';
    if ((' ' + cur + ' ').indexOf(' ' + cls + ' ') < 0) el.className = cur ? cur + ' ' + cls : cls;
  }

  function removeClass(el, cls) {
    var cur = el.className || '';
    el.className = (' ' + cur + ' ').split(' ' + cls + ' ').join(' ').trim();
  }

  // ---- 数据统计（缺失/类型） -------------------------------------------

  function columnMissing(data, name) {
    var idx = data.columns.indexOf(name);
    if (idx < 0) return null;
    var miss = 0;
    for (var i = 0; i < data.rows.length; i++) {
      var row = data.rows[i];
      if (!Array.isArray(row)) { miss++; continue; }
      var v = row[idx];
      if (v === null || v === undefined || v === '') miss++;
    }
    return miss;
  }

  // 旧版平行规则，仅在 FigData.renderableRows 不可用（旧内核）时兜底；
  // 正常路径一律以渲染器自身 prep 为准（G07）。
  function isNumericValue(v) {
    if (typeof v === 'number') return isFinite(v);
    if (typeof v === 'string') return v.trim() !== '' && isFinite(Number(v));
    return false;
  }

  function excludedRowCount(data, requiredSlots, mapping, numericSlots) {
    var idx = {};
    var allOk = requiredSlots.every(function (slot) {
      var col = mapping[slot];
      if (!col) return false;
      var at = data.columns.indexOf(col);
      if (at < 0) return false;
      idx[slot] = at;
      return true;
    });
    if (!allOk) return null; // 必填槽缺失时无法计算
    var excluded = 0;
    for (var i = 0; i < data.rows.length; i++) {
      var row = data.rows[i];
      if (!Array.isArray(row)) { excluded++; continue; }
      var bad = requiredSlots.some(function (slot) {
        var v = row[idx[slot]];
        if (v === null || v === undefined || v === '') return true;
        if (numericSlots.indexOf(slot) >= 0 && !isNumericValue(v)) return true;
        return false;
      });
      if (bad) excluded++;
    }
    return excluded;
  }

  // ---- 渲染语义（与内核 RENDERER_SEMANTICS 同源） ---------------------

  function semanticsFor(chartType) {
    var P = global.FigPresets;
    if (P && P.RENDERER_SEMANTICS && P.RENDERER_SEMANTICS[chartType]) {
      return P.RENDERER_SEMANTICS[chartType];
    }
    return null;
  }

  // 各图型哪些映射槽必须是数值列（与 RENDERS 各入口的 toNum/catLabel
  // 条件一致）：仅用于拖拽放错类型时的提示标红，不阻止操作。
  function numericSlotsFor(chartType) {
    // R10 补图型：与各 RENDERS 入口的 toNum/catLabel 条件一致
    var NUM = {
      bar_stacked: ['y'], violin: ['y'], dotplot: ['x', 'size'],
      paired: ['y'], marginal: ['x', 'y'], volcano: ['x', 'y'],
      forest: ['x', 'error', 'lo', 'hi', 'size'],
      survival: ['x', 'y'], roc: ['x', 'y'], pca: ['x', 'y'],
      sankey: ['size'], taylor: ['x', 'y']
    };
    if (NUM[chartType]) return NUM[chartType];
    if (chartType === 'scatter') return ['x', 'y'];
    if (chartType === 'histogram') return ['x'];
    if (chartType === 'heatmap') return ['color'];
    return ['y']; // bar/bar_grouped/line/line_multi/area/pie/box：y 必须数值
  }

  // 聚合方式的人话说明（技术细节 sem.note 进 ⓘ）。
  var AGG_PLAIN = {
    category_mean: '同一分类有多次测量时取平均值',
    cell_mean: '同一分类×分组的单元格内取平均值',
    category_sum: '同一分类的数值会相加，归一化为占比',
    none: '不做汇总，逐点画出',
    binning: '把数值分成若干区间计数',
    cell_value: '每个分类组合取对应数值（重复测量取平均）',
    distribution: '按分类展示数值分布（中位数、四分位）'
  };

  // 槽位的人话名（拖拽放置框与确认页共用）。
  var SLOT_SHORT = {
    x: '横轴', y: '纵轴', group: '分组', error: '误差列',
    color: '颜色值', size: '大小', label: '标签'
  };
  var SLOT_LABELS = {
    x: '横轴（x）', y: '纵轴数值（y）', group: '分组 / 系列',
    error: '误差列', color: '按颜色分组（可选）'
  };

  function slotLabel(slotDef) {
    if (SLOT_LABELS[slotDef.slot]) return SLOT_LABELS[slotDef.slot];
    return slotDef.description || slotDef.slot;
  }

  // 槽位名（如 'y'）→ 中文标签；查不到时退回 SLOT_SHORT，绝不直出槽位 id。
  function slotNameLabel(tpl, slotName) {
    try {
      var defs = tpl && global.FigPresets && typeof global.FigPresets.mappingSlots === 'function'
        ? global.FigPresets.mappingSlots(tpl.id || tpl.template_id || '') : [];
      for (var i = 0; i < defs.length; i++) {
        if (defs[i] && defs[i].slot === slotName) return slotLabel(defs[i]);
      }
    } catch (e) { /* 忽略 */ }
    return SLOT_SHORT[slotName] || slotName;
  }

  function humanMapText(mapping, tpl) {
    var slots = [];
    if (tpl && global.FigPresets && typeof global.FigPresets.mappingSlots === 'function') {
      try {
        slots = global.FigPresets.mappingSlots(tpl.id || tpl.template_id || '');
      } catch (e) { slots = []; }
    }
    var order = slots.length ? slots.map(function (s) { return s.slot; })
      : Object.keys(mapping || {});
    var parts = [];
    // R4-HB：mapping.ys 宽表多列纵轴单独展示（y=ys[0] 不再重复列出）
    if (mapping && Array.isArray(mapping.ys) && mapping.ys.length) {
      var ysZh = mapping.ys.filter(function (c) {
        return typeof c === 'string' && c !== '';
      });
      if (ysZh.length) parts.push('纵轴（多列）：' + ysZh.join('、'));
    }
    order.forEach(function (slot) {
      if (slot === 'ys') return;
      if (slot === 'y' && mapping && Array.isArray(mapping.ys) && mapping.ys.length) return;
      var col = mapping && mapping[slot];
      if (col) parts.push((SLOT_SHORT[slot] || slot) + '：' + col);
    });
    Object.keys(mapping || {}).forEach(function (slot) {
      if (slot === 'ys') return;
      if (slot === 'y' && mapping && Array.isArray(mapping.ys) && mapping.ys.length) return;
      if (order.indexOf(slot) < 0 && mapping[slot]) {
        parts.push((SLOT_SHORT[slot] || slot) + '：' + mapping[slot]);
      }
    });
    return parts.length ? parts.join('；') : '（未映射）';
  }

  // ---- 上次映射记忆（localStorage LRU，不可用时静默跳过） --------------

  var MEM_PREFIX = 'figwizard:last:';
  var MEM_MAX = 50;

  function memStore() {
    try {
      var s = global.localStorage;
      return s && typeof s.getItem === 'function' ? s : null;
    } catch (e) { return null; }
  }

  function memHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(16);
  }

  function memKeyFor(filename, columns) {
    return MEM_PREFIX + String(filename || '') + '|' +
      memHash((columns || []).join('\u001f'));
  }

  function readMemory(key) {
    var s = memStore();
    if (!s) return null;
    try {
      var raw = s.getItem(key);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && typeof o === 'object' && typeof o.templateId === 'string' &&
          o.mapping && typeof o.mapping === 'object') return o;
    } catch (e) { /* 损坏记录忽略 */ }
    return null;
  }

  function writeMemory(key, rec) {
    var s = memStore();
    if (!s) return;
    try {
      s.setItem(key, JSON.stringify(rec));
      if (typeof s.length === 'number' && typeof s.key === 'function' &&
          typeof s.removeItem === 'function') {
        var keys = [];
        for (var i = 0; i < s.length; i++) {
          var k = s.key(i);
          if (k && k.indexOf(MEM_PREFIX) === 0) keys.push(k);
        }
        if (keys.length > MEM_MAX) {
          var ts = {};
          keys.forEach(function (k) {
            try { ts[k] = (JSON.parse(s.getItem(k)) || {}).ts || 0; }
            catch (e) { ts[k] = 0; }
          });
          keys.sort(function (a, b) { return ts[a] - ts[b]; });
          for (var j = 0; j < keys.length - MEM_MAX; j++) s.removeItem(keys[j]);
        }
      }
    } catch (e) { /* 存储不可用时静默跳过 */ }
  }

  function memoryColumnsExist(mapping, columns) {
    var bad = false;
    Object.keys(mapping || {}).forEach(function (slot) {
      var col = mapping[slot];
      // R4-HB：mapping.ys 是列名数组，逐元素校验
      if (Array.isArray(col)) {
        col.forEach(function (c) {
          if (c != null && columns.indexOf(c) < 0) bad = true;
        });
        return;
      }
      if (col != null && columns.indexOf(col) < 0) bad = true;
    });
    return !bad;
  }

  // ---- 向导主体 ---------------------------------------------------------

  function cloneTable(data) {
    return {
      columns: (data.columns || []).slice(),
      rows: (data.rows || []).map(function (r) {
        return Array.isArray(r) ? r.slice() : r;
      })
    };
  }

  function open(opts) {
    if (!isObj(opts)) fail('open 需要选项对象');
    if (!isObj(opts.data) || !Array.isArray(opts.data.columns)) fail('缺少 data');
    if (typeof opts.buildDraft !== 'function') fail('缺少 buildDraft 构建入口');
    if (typeof opts.onCreate !== 'function') fail('缺少 onCreate 提交入口');
    // data / parsedData / colStats / colKind / recommendations 均可经
    // reloadData 重建（读取方式切换、单元格修改后的原地刷新）。
    var data = opts.data;
    var parsedData = cloneTable(opts.parsedData || opts.data);
    var cellEdits = [];          // [{row, column, from, to}]，row 为 0 基数据行号
    var shownRows = 50;
    var allowCellEdit = opts.allowCellEdit !== false;
    var reuseNote = typeof opts.reuseNote === 'string' ? opts.reuseNote : null;
    var skipMemory = opts.skipMemory === true;
    // parse 接缝：仅分隔文本来源提供；{options, reparse, detectedDelimiter, hint}
    var parseCfg = isObj(opts.parse) ? opts.parse : null;
    var parseState = {
      delimiter: 'auto',
      numberFormat: 'plain'
    };
    var detectedDelimiter = parseCfg && typeof parseCfg.detectedDelimiter === 'string'
      ? parseCfg.detectedDelimiter : null;
    var numberHint = parseCfg && isObj(parseCfg.hint) ? parseCfg.hint : null;
    var recommendations = Array.isArray(opts.recommendations) && opts.recommendations.length
      ? opts.recommendations : [];
    if (!recommendations.length) fail('没有可推荐的模板');

    var P = global.FigPresets;
    if (!P || typeof P.mappingSlots !== 'function') {
      fail('模板功能未加载，无法读取列映射规则');
    }

    function recomputeStats() {
      var stats = null;
      try {
        if (global.FigData && typeof global.FigData.columnStats === 'function') {
          stats = global.FigData.columnStats(data);
        }
      } catch (e) { stats = null; }
      return stats;
    }
    function statsToKind(stats) {
      var map = {};
      if (stats && Array.isArray(stats.columns)) {
        stats.columns.forEach(function (c) {
          if (c && c.name) map[c.name] = c.kind;
        });
      }
      return map;
    }
    function defaultRecommendations() {
      var stats = recomputeStats();
      if (typeof opts.recommend === 'function') {
        try {
          var list = opts.recommend(data);
          if (Array.isArray(list) && list.length) return list;
        } catch (e) { /* 回退下方推荐 */ }
      }
      return recommendations;
    }

    // 列类型统计（FigData.columnStats 可选；不可用时不显示类型标签、
    // 也不做拖拽类型标红）。
    var colStats = recomputeStats();
    var colKind = statsToKind(colStats);
    function kindLabel(kind) {
      if (kind === 'numeric') return '数值';
      if (typeof kind === 'string' && /date|time/i.test(kind)) return '日期';
      return '文本';
    }
    function kindIsNumeric(kind) { return kind === 'numeric'; }

    // ---- 记忆上次映射：仅 create 成功后写入；打开时校验模板在推荐
    // 列表内且映射列都存在才套用；画布不存（每次默认 keep）。
    // G21 复用模式（skipMemory）从推荐开始，不套用记忆。
    var memKey = memKeyFor(opts.filename, data.columns);
    var memRec = skipMemory ? null : readMemory(memKey);
    var recIds = recommendations.map(function (r) { return r.template_id; });
    var memApplied = false;

    var draft = {
      templateId: recommendations[0].template_id,
      mapping: null,            // null = 未确认（用内核推断为默认）
      canvasChoice: { mode: 'keep' },
      title: opts.appName || '',
      placeIn: null,           // 'new-tab' | 'current'；null=按默认解析
      y2Right: []              // R4-HB：分配到右轴的列名（仅 mapping.ys ≥2 时生效）
    };
    // R3 #5：当前画布已有内容且查看器在线时，允许把新图放进新标签页
    var canPlaceNewTab = opts.canPlaceNewTab === true;
    function placeInChoice() {
      if (draft.placeIn === 'new-tab' || draft.placeIn === 'current') return draft.placeIn;
      return canPlaceNewTab ? 'new-tab' : 'current';
    }
    if (memRec && recIds.indexOf(memRec.templateId) >= 0 &&
        memoryColumnsExist(memRec.mapping, data.columns)) {
      draft.templateId = memRec.templateId;
      draft.mapping = JSON.parse(JSON.stringify(memRec.mapping));
      draft.y2Right = Array.isArray(memRec.y2right) ? memRec.y2right.slice() : [];
      memApplied = true;
    }

    // inferred mapping（内核 _resolveMapping 的结果，经 templateFromStats 无
    // mapping 调用获得），作为下拉默认值展示给用户确认。
    function inferredMapping(templateId) {
      try {
        var built = opts.buildDraft(templateId, null, { mode: 'keep' }, draft.title, ctxForCreate());
        return built && built.chart && isObj(built.chart.mapping)
          ? JSON.parse(JSON.stringify(built.chart.mapping)) : {};
      } catch (e) {
        return {};
      }
    }

    var selectEls = {};        // slot -> <select>（键盘/读屏备选）
    var slotUI = {};           // slot -> {box, warn, baseClass}
    var templateRadios = [];   // {radio, id}
    var stepBtns = [];
    var panels = [];
    var currentStep = 1;
    var previewBox = null;
    var statsHost = null;
    var tipHost = null;
    var summaryHost = null;
    var tip4Host = null;
    var memHintEl = null;
    var canvasPresetRadio = null;
    var canvasKeepRadio = null;
    var canvasSizeRadio = null;
    var widthInput = null;
    var heightInput = null;
    var titleInput = null;
    var mappingWrapHost = null;
    var canvasHost = null;
    var lastBuild = null;
    var previewTimer = null;
    // G19/G20：第 1 步「读取方式」与单元格编辑的宿主/状态
    var parseReparseHost = null;
    var dataTableHost = null;
    var recCardHost = null;
    var templateListHost = null;
    var chipsHost = null;
    var editsHost = null;
    var showMoreHost = null;
    var cellFocusIdx = 0;       // roving tabindex：当前可聚焦格的扁平序号
    var lastEditedFocus = null; // {row, column} 最近编辑的格子（reloadData 后恢复焦点）

    function currentTemplate() {
      return P.template(draft.templateId) || null;
    }

    // 不变量：data 永远是生效表（解析表 + 单元格修改），parsedData 是解析原表。
    function applyEdits(base, edits) {
      if (!edits || !edits.length) return cloneTable(base);
      var next = cloneTable(base);
      edits.forEach(function (e) {
        var ci = next.columns.indexOf(e.column);
        if (ci < 0 || e.row < 0 || e.row >= next.rows.length) return;
        var row = next.rows[e.row];
        if (Array.isArray(row)) row[ci] = e.to;
      });
      return next;
    }
    function effectiveData() { return data; }

    function parseOptionsForCommit() {
      // 仅当用户把分隔符改成非“自动”或数字写法不是 plain 时非 null。
      var nf = parseState.numberFormat;
      var dl = parseState.delimiter;
      if (nf === 'plain' && (dl === 'auto' || dl === detectedDelimiter)) return null;
      var delimChar = dl === 'auto' ? (detectedDelimiter || ',') : dl;
      return { delimiter: delimChar, numberFormat: nf };
    }

    function ctxForCreate() {
      return {
        data: effectiveData(),
        parsedData: cloneTable(parsedData),
        edits: cellEdits.map(function (e) {
          return { row: e.row, column: e.column, from: e.from, to: e.to };
        }),
        parseOptions: parseOptionsForCommit(),
        placeIn: placeInChoice(),
        axesExtra: axesExtraForCreate()   // R4-HB：右轴配置透传给 buildDraft
      };
    }

    // R4-HB：右轴系列 → opts.axes.y2；无右轴系列或全在右轴时返回 null
    function axesExtraForCreate() {
      var m = isObj(draft.mapping) ? draft.mapping : {};
      var ys = Array.isArray(m.ys)
        ? m.ys.filter(function (n) { return typeof n === 'string' && n !== ''; }) : null;
      if (!ys || ys.length < 2) return null;
      var rights = (draft.y2Right || []).filter(function (c) { return ys.indexOf(c) >= 0; });
      if (!rights.length || rights.length >= ys.length) return null;
      return { y2: { series: rights.slice(), label: null, min: null, max: null } };
    }

    // ---- reloadData：单元格修改 / 读取方式切换后原地重建 ----------------
    // 不变量：调用前 data/parsedData/cellEdits/recommendations 已是最新；
    // 本函数只按当前 data 重算统计、推荐、徽标并重建各宿主（保留滚动与焦点）。
    function reloadData(opts2) {
      opts2 = opts2 || {};
      var focusInfo = opts2.focusRef || lastEditedFocus;
      colStats = recomputeStats();
      colKind = statsToKind(colStats);
      var fresh = defaultRecommendations();
      if (Array.isArray(fresh) && fresh.length) recommendations = fresh;
      var newIds = recommendations.map(function (r) { return r.template_id; });
      var mappingCols = currentMapping();
      var mappingOk = true;
      Object.keys(mappingCols).forEach(function (slot) {
        var col = mappingCols[slot];
        // R4-HB：mapping.ys 数组逐元素校验
        if (Array.isArray(col)) {
          col.forEach(function (c) {
            if (c != null && data.columns.indexOf(c) < 0) mappingOk = false;
          });
          return;
        }
        if (col != null && data.columns.indexOf(col) < 0) mappingOk = false;
      });
      if (newIds.indexOf(draft.templateId) < 0 || !mappingOk) {
        draft.templateId = recommendations[0].template_id;
        draft.mapping = null;
        templateRadios.forEach(function (t) { t.radio.checked = t.id === draft.templateId; });
      }
      if (parseCfg && parseReparseHost) rebuildParseRow();
      if (dataTableHost) {
        // 真正滚动的是 .dw-table-wrap（每次重建都会销毁），不是宿主
        var oldWrap = dataTableHost.querySelector('.dw-table-wrap');
        var st = oldWrap ? oldWrap.scrollTop : 0;
        var sl = oldWrap ? oldWrap.scrollLeft : 0;
        dataTableHost.textContent = '';
        var newWrap = buildDataTable();
        dataTableHost.appendChild(newWrap);
        if (focusInfo) restoreCellFocus(focusInfo.row, focusInfo.column);
        // 滚动位置最后写：先恢复焦点（preventScroll 不再滚动），再落滚动位置
        newWrap.scrollTop = st;
        newWrap.scrollLeft = sl;
      }
      if (recCardHost) {
        recCardHost.textContent = '';
        recCardHost.appendChild(buildRecCard());
      }
      if (templateListHost) {
        templateListHost.textContent = '';
        templateListHost.appendChild(buildTemplateList(function (id) {
          draft.templateId = id;
          rebuildForTemplate();
        }));
        syncTemplateRadios();
      }
      if (chipsHost) {
        chipsHost.textContent = '';
        chipsHost.appendChild(buildColumnChips());
      }
      if (mappingWrapHost) {
        mappingWrapHost.textContent = '';
        mappingWrapHost.appendChild(buildMappingControls());
      }
      if (editsHost) renderEditsPanel();
      refreshPreview();
      if (opts2.after) opts2.after();
    }

    function syncTemplateRadios() {
      templateRadios.forEach(function (t) { t.radio.checked = t.id === draft.templateId; });
    }

    function currentMapping() {
      if (isObj(draft.mapping)) return draft.mapping;
      return inferredMapping(draft.templateId);
    }

    // 折线/面积图“同一条线同一横轴多个点”（折返）统计；只提示，不改映射。
    function dupXStatsFor(chartType, mapping) {
      if (!global.FigData || typeof global.FigData.duplicateXStats !== 'function') return null;
      if (!chartType) return null;
      try {
        var st = global.FigData.duplicateXStats(chartType, data, mapping || {});
        return (st && st.applicable) ? st : null;
      } catch (e) { return null; }
    }

    function dupXAdviceLines(st) {
      if (!st || !(st.dupX > 0)) return [];
      var lines = ['同一条线上有 ' + st.dupX + ' 个横轴位置各对应多个点（共 ' +
        st.dupPoints + ' 个点），折线会上下折返。'];
      if (st.splitColumns && st.splitColumns.length) {
        lines.push('这些点可以用「' + st.splitColumns.join('」「') +
          '」区分开；目前一张折线图只能按一列分组，可以先在表格里把分组列合并，或改用分组柱状图（会对重复点取平均）。');
      } else {
        lines.push('可以改用柱状图（会对重复点取平均）或散点图。');
      }
      return lines;
    }

    function currentCanvasChoice() {
      var tpl = currentTemplate();
      if (draft.canvasChoice.mode === 'explicit_size') {
        return {
          mode: 'explicit_size',
          width_mm: Number(widthInput && widthInput.value) || 120,
          height_mm: Number(heightInput && heightInput.value) || 90
        };
      }
      if (draft.canvasChoice.mode === 'explicit_preset' && tpl && tpl.journal_default) {
        var preset = P.journal(tpl.journal_default);
        if (preset) return { mode: 'explicit_preset', preset: preset };
      }
      return { mode: 'keep' };
    }

    function canvasSummaryText(choice) {
      var c = effectiveCanvasOf(choice, opts.currentCanvas || { width_mm: 120, height_mm: 90, dpi: 300 });
      var src = choice.mode === 'keep' ? '保持当前画布'
        : choice.mode === 'explicit_preset' ? ('期刊预设 ' + (choice.preset && choice.preset.name || choice.preset && choice.preset.id))
        : '自定义尺寸';
      return src + '：' + Math.round(c.width_mm) + ' × ' + Math.round(c.height_mm) + ' mm（' + (c.dpi || 300) + ' dpi）';
    }

    function effectiveCanvasOf(choice, currentCanvas) {
      if (choice.mode === 'explicit_size') {
        return {
          width_mm: Math.max(10, Math.min(2000, Number(choice.width_mm) || 120)),
          height_mm: Math.max(10, Math.min(2000, Number(choice.height_mm) || 90)),
          dpi: currentCanvas.dpi || 300
        };
      }
      if (choice.mode === 'explicit_preset' && choice.preset) {
        return {
          width_mm: choice.preset.width_mm,
          height_mm: choice.preset.height_mm != null
            ? choice.preset.height_mm : Math.round(choice.preset.width_mm * 0.75),
          dpi: choice.preset.dpi_min || currentCanvas.dpi || 300
        };
      }
      return currentCanvas;
    }

    // ---- 行数统计：优先 FigData.renderableRows（复用渲染器 prep），
    // 旧内核没有该接口时回退平行规则。 ----
    function rowStats() {
      var tpl = currentTemplate();
      var chartType = tpl ? tpl.chart_type : null;
      var mapping = currentMapping();
      if (global.FigData && typeof global.FigData.renderableRows === 'function' && chartType) {
        try {
          var rr = global.FigData.renderableRows(chartType, data, mapping);
          if (rr && typeof rr.drawn === 'number') {
            return { ok: true, total: rr.total, drawn: rr.drawn,
                     excluded: rr.excluded, reasons: rr.reasons || [] };
          }
          return { ok: false, total: data.rows.length, drawn: null,
                   excluded: null, reasons: (rr && rr.reasons) || ['无法统计'] };
        } catch (e) {
          return { ok: false, total: data.rows.length, drawn: null,
                   excluded: null, reasons: [e.message] };
        }
      }
      // 兜底：旧平行规则
      var sem = tpl ? semanticsFor(chartType) : null;
      var required = sem ? sem.required : [];
      var numericSlots = (tpl && tpl.chart_type === 'heatmap') ? ['color']
        : (sem && sem.aggregation !== 'none' ? ['y'] : ['x', 'y']);
      var ex = excludedRowCount(data, required, mapping, numericSlots);
      if (ex === null) {
        return { ok: false, total: data.rows.length, drawn: null,
                 excluded: null, reasons: ['还有必须的列没选'] };
      }
      return { ok: true, total: data.rows.length, drawn: data.rows.length - ex,
               excluded: ex, reasons: [] };
    }

    // 预览失败的统一呈现：主文案 + 一行中文原因 + 可选读取方式提示；
    // 原始报错收进折叠的 data-tech 细节，不直出给用户。
    function previewFailNode(kind, rawMsg) {
      var wrap = h('div', { 'class': 'dw-err', 'data-wizard-error': kind });
      wrap.appendChild(h('div', { text: '现在还画不出预览' }));
      var tpl = currentTemplate();
      var sem = tpl ? semanticsFor(tpl.chart_type) : null;
      var mapping = currentMapping();
      var wideMultiPrev = Array.isArray(mapping.ys) && mapping.ys.length >= 2;
      var missing = (sem ? sem.required : []).filter(function (s) {
        if (wideMultiPrev && s === 'group') return false;
        return !mapping[s];
      });
      var reason;
      if (missing.length) {
        var names = missing.map(function (s) { return slotNameLabel(tpl, s); }).join('、');
        reason = '「' + ((tpl && tpl.name) || (tpl && tpl.template_id) || '该模板') +
          '」还缺：' + names + '。请到第 2 步选择对应的列。';
      } else {
        reason = '这种图用现在的数据画不出来，请到第 2 步换一种图或调整列。';
      }
      wrap.appendChild(h('div', { text: reason }));
      if (numberHint && (numberHint.suggestion || numberHint.ambiguous) &&
          parseState.numberFormat === 'plain') {
        wrap.appendChild(h('div', {
          text: '上面有几列数字被当成了文本，先看一下「读取方式」的提示。'
        }));
      }
      var det = h('details', { 'data-tech': '1' });
      det.appendChild(h('summary', { text: '技术细节' }));
      det.appendChild(h('pre', { text: String(rawMsg == null ? '' : rawMsg) }));
      wrap.appendChild(det);
      return wrap;
    }

    // ---- 大数据预览抽样：rows > 3000 时预览只画确定性样本（等步长 +
    // 首尾行 + 映射 x/y 的最小/最大值所在行），统计仍用全量数据。 ----
    var PREVIEW_SAMPLE_LIMIT = 3000;
    function previewSampleRows(inline, mapping) {
      var rows = inline && inline.rows;
      if (!Array.isArray(rows) || rows.length <= PREVIEW_SAMPLE_LIMIT) return null;
      var cols = Array.isArray(inline.columns) ? inline.columns : [];
      function ci(name) {
        return (typeof name === 'string' && name !== '') ? cols.indexOf(name) : -1;
      }
      var n = rows.length;
      var keep = Object.create(null);
      var stride = n / PREVIEW_SAMPLE_LIMIT;
      for (var k = 0; k < PREVIEW_SAMPLE_LIMIT; k++) {
        var idx = Math.floor(k * stride);
        if (idx >= 0 && idx < n) keep[idx] = 1;
      }
      keep[0] = 1; keep[n - 1] = 1;
      function addExtremum(cidx) {
        if (cidx < 0) return;
        var lo = -1, hi = -1, loV = Infinity, hiV = -Infinity;
        for (var i = 0; i < n; i++) {
          var row = rows[i];
          if (!Array.isArray(row)) continue;
          var v = Number(row[cidx]);
          if (!isFinite(v)) continue;
          if (v < loV) { loV = v; lo = i; }
          if (v > hiV) { hiV = v; hi = i; }
        }
        if (lo >= 0) keep[lo] = 1;
        if (hi >= 0) keep[hi] = 1;
      }
      addExtremum(ci(mapping && mapping.x));
      addExtremum(ci(mapping && mapping.y));
      var idxs = Object.keys(keep).map(Number).sort(function (a, b) { return a - b; });
      return idxs.map(function (i) { return rows[i]; });
    }

    // ---- 预览（不写正式文档/历史/工程） ----
    function refreshPreview() {
      if (!previewBox) return;
      var mapping = currentMapping();
      var choice = currentCanvasChoice();
      var tpl = currentTemplate();
      try {
        lastBuild = opts.buildDraft(draft.templateId, mapping, choice, draft.title, ctxForCreate());
      } catch (err) {
        lastBuild = null;
        previewBox.textContent = '';
        previewBox.appendChild(previewFailNode('build', err && err.message));
        renderInfoPanels();
        return;
      }
      // canonical 渲染链：临时 mini-doc → FigRender.toSVG
      var svg = '';
      var renderError = null;
      try {
        var mini = {
          schema_version: '1.0',
          id: 'wizard-preview',
          title: draft.title || '',
          canvas: JSON.parse(JSON.stringify(lastBuild.effectiveCanvas || opts.currentCanvas || { width_mm: 120, height_mm: 90, dpi: 300 })),
          elements: JSON.parse(JSON.stringify(lastBuild.elements || [])),
          anchors: [], panels: [], history: [], meta: {}
        };
        // 大数据抽样：只改预览副本的 inline.rows，创建仍用全量数据。
        var sampledInfo = null;
        (mini.elements || []).forEach(function (el) {
          var inl = el && el.chart && el.chart.data && el.chart.data.inline;
          if (!inl || !Array.isArray(inl.rows) || inl.rows.length <= PREVIEW_SAMPLE_LIMIT) return;
          var total = inl.rows.length;
          var sampled = previewSampleRows(inl, el.chart.mapping);
          if (sampled && sampled.length) {
            inl.rows = sampled;
            if (!sampledInfo) sampledInfo = { shown: sampled.length, total: total };
          }
        });
        if (global.FigRender && typeof global.FigRender.toSVG === 'function') {
          svg = global.FigRender.toSVG(mini, { scale: 1, includeGuides: false });
        }
      } catch (err2) {
        renderError = err2.message;
      }
      if (svg) {
        previewBox.textContent = ''; // fake DOM 的 innerHTML 不清 children
        var sampleNote = sampledInfo
          ? '<div class="dw-note" data-wizard-sample="1">预览按 ' + sampledInfo.shown +
            ' / ' + sampledInfo.total + ' 行抽样显示，创建后按全部数据绘制</div>'
          : '';
        previewBox.innerHTML = sampleNote + svg;
      } else if (!renderError) {
        previewBox.textContent = '';
        previewBox.appendChild(h('div', {
          'class': 'dw-note',
          text: '当前环境缺少 FigRender，无法显示图形预览；映射与统计摘要仍然有效。'
        }));
      } else {
        previewBox.textContent = '';
        previewBox.appendChild(previewFailNode('render', renderError));
      }
      renderInfoPanels();
    }

    function schedulePreview() {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(function () {
        previewTimer = null;
        refreshPreview();
      }, 150);
    }

    // ---- 信息面板：第 2 步统计区 + ⓘ、第 4 步汇总 + ⓘ ----
    function renderInfoPanels() {
      var tpl = currentTemplate();
      var sem = tpl ? semanticsFor(tpl.chart_type) : null;
      var mapping = currentMapping();
      var rs = rowStats();
      var curRec = recommendations.filter(function (r) {
        return r.template_id === draft.templateId;
      })[0] || recommendations[0];

      // ---- 第 2 步：「这些数字代表什么」 ----
      if (statsHost) {
        statsHost.textContent = '';
        var lines = [];
        if (sem) {
          lines.push('统计方式：' + (AGG_PLAIN[sem.aggregation] || '按该图表类型的统计方式处理'));
        }
        if (rs.ok) {
          lines.push('按当前选择，' + rs.total + ' 行中有 ' + rs.drawn +
            ' 行会画出，' + rs.excluded + ' 行不会画出。');
          lines.push('排除的行：' + rs.excluded + ' / ' + rs.total);
        } else {
          lines.push('无法统计会画出的行数：' + (rs.reasons.join('；') || '还有必须的列没选'));
        }
        Object.keys(mapping).forEach(function (slot) {
          var col = mapping[slot];
          if (!col) return;
          var miss = columnMissing(data, col);
          if (miss) lines.push('列「' + col + '」缺失 ' + miss + ' 行。');
        });
        if (mapping.error) {
          lines.push('误差列「' + mapping.error +
            '」：误差值本身不声明统计量类型；请到「论证」页说明是 SD、SEM 还是 95% CI，程序不会根据列名猜测。');
        } else {
          lines.push('误差线：如果同一分类有重复测量，请到「论证」页说明是 SD、SEM 还是 95% CI；也可以提供误差列。程序不会根据列名猜测。');
        }
        lines.forEach(function (t) {
          statsHost.appendChild(h('div', { 'class': 'dw-stat-line', text: t }));
        });
        dupXAdviceLines(dupXStatsFor(tpl ? tpl.chart_type : null, mapping))
          .forEach(function (t) {
            statsHost.appendChild(h('div', {
              'class': 'dw-stat-warn', 'data-wizard-dupwarn': '1', text: t
            }));
          });
      }

      // ---- 第 2 步 ⓘ：技术细节（渲染语义、统计量申报、匹配分数、预览声明） ----
      if (tipHost) {
        tipHost.textContent = '';
        var tipLines = [];
        if (sem && sem.note) tipLines.push('渲染语义：' + sem.note);
        if (tpl && tpl.chart_type) tipLines.push('图型：' + (global.FigData && typeof global.FigData.chartTypeName === 'function' ? global.FigData.chartTypeName(tpl.chart_type) : tpl.chart_type));
        tipLines.push('误差统计量申报：重复观测的 SD/SEM/95CI 在「论证」页科学合同中申报；' +
          '用户误差列在图表属性中声明。程序不依据列名猜测统计量。');
        tipLines.push('匹配分数：' + (curRec ? curRec.score : '—'));
        tipLines.push('预览不写入正式文档、历史与工程；「创建图表」才提交一笔可撤销历史。');
        var tip = h('details', { 'class': 'dw-tip' }, [
          h('summary', { text: '技术细节' })
        ]);
        var tipBody = h('div', { 'class': 'dw-tip-body' });
        tipLines.forEach(function (t) {
          tipBody.appendChild(h('div', { text: t }));
        });
        tip.appendChild(tipBody);
        tipHost.appendChild(tip);
      }

      // ---- 第 4 步：确认汇总 ----
      if (summaryHost) {
        summaryHost.textContent = '';
        var sumLines = [];
        sumLines.push('图表：' + (tpl ? tpl.name : draft.templateId));
        sumLines.push('映射：' + humanMapText(mapping, tpl));
        if (rs.ok) {
          sumLines.push('数据：' + rs.total + ' 行，预计画出 ' + rs.drawn +
            ' 行，' + rs.excluded + ' 行不会画出。');
          sumLines.push('排除的行：' + rs.excluded + ' / ' + rs.total);
        } else {
          sumLines.push('数据：' + data.rows.length + ' 行；' +
            (rs.reasons.join('；') || '还有必须的列没选，暂时无法统计'));
        }
        Object.keys(mapping).forEach(function (slot) {
          var col = mapping[slot];
          if (!col) return;
          var miss = columnMissing(data, col);
          if (miss) sumLines.push('列「' + col + '」缺失 ' + miss + ' 行。');
        });
        if (mapping.error) {
          sumLines.push('误差列「' + mapping.error + '」已提供；统计量类型（SD/SEM/95% CI）请在「论证」页申报。');
        } else {
          sumLines.push('未提供误差列；如有重复测量，请到「论证」页说明统计量类型。');
        }
        sumLines.push('画布：' + canvasSummaryText(currentCanvasChoice()) + '。');
        sumLines.push('创建后会作为一步操作写入历史，可以用 Ctrl+Z 撤销。');
        sumLines.forEach(function (t, i) {
          summaryHost.appendChild(h('div', {
            'class': 'dw-sum-line' + (i === sumLines.length - 1 ? ' dw-sum-last' : ''),
            text: t
          }));
        });
        dupXAdviceLines(dupXStatsFor(tpl ? tpl.chart_type : null, mapping))
          .forEach(function (t) {
            summaryHost.appendChild(h('div', {
              'class': 'dw-stat-warn', 'data-wizard-dupwarn': '1', text: t
            }));
          });
      }
      if (tip4Host) {
        tip4Host.textContent = '';
        var tip4 = h('details', { 'class': 'dw-tip' }, [
          h('summary', { text: '技术细节' })
        ]);
        var tip4Body = h('div', { 'class': 'dw-tip-body' });
        var t4 = [];
        if (sem && sem.note) t4.push('渲染语义：' + sem.note);
        if (tpl && tpl.chart_type) t4.push('图型：' + (global.FigData && typeof global.FigData.chartTypeName === 'function' ? global.FigData.chartTypeName(tpl.chart_type) : tpl.chart_type));
        t4.push('误差统计量申报：SD/SEM/95CI 在「论证」页科学合同中申报；' +
          '用户误差列在图表属性中声明。程序不依据列名猜测统计量。');
        t4.push('匹配分数：' + (curRec ? curRec.score : '—'));
        t4.push('预览不写入正式文档、历史与工程；「创建图表」才提交一笔可撤销历史。');
        t4.forEach(function (t) { tip4Body.appendChild(h('div', { text: t })); });
        tip4.appendChild(tip4Body);
        tip4Host.appendChild(tip4);
      }

      updateSlotStates();
    }

    // ---- 映射槽（拖放放置框 + 下拉备选，同一 setMapping 入口） ----
    var dragCol = null;

    function slotNeedsNumeric(slot) {
      var tpl = currentTemplate();
      var chartType = tpl ? tpl.chart_type : '';
      var nums = numericSlotsFor(chartType);
      if (nums.indexOf(slot) >= 0) return true;
      var defs = {};
      try {
        P.mappingSlots(draft.templateId).forEach(function (s) { defs[s.slot] = s; });
      } catch (e) { /* 忽略 */ }
      return !!(defs[slot] && defs[slot].numeric);
    }

    function updateSlotStates() {
      var mapping = currentMapping();
      Object.keys(slotUI).forEach(function (slot) {
        var ui = slotUI[slot];
        var col = mapping[slot];
        var kind = col ? colKind[col] : undefined;
        var bad = !!(col && slotNeedsNumeric(slot) && kind && !kindIsNumeric(kind));
        ui.warn.hidden = !bad;
        ui.box.className = bad ? ui.baseClass + ' dw-slot-bad' : ui.baseClass;
      });
    }

    // ---- R4-HB：宽表多纵轴（line_multi/scatter 的 y 槽）------------------
    // 多列纵轴：mapping.ys（≥2 列时启用，y=ys[0]，互斥 group/color）；
    // 每列可标 左轴/右轴（draft.y2Right），≥1 列在右轴时生成 axes.y2。
    function wideYCapable() {
      var tpl = currentTemplate();
      var ct = tpl ? tpl.chart_type : '';
      // R10：venn 的 ys 是 2–3 个成员标记列（复用多选 chip 机制，不画轴）
      return ct === 'line_multi' || ct === 'scatter' || ct === 'venn';
    }
    function isVennTpl() {
      var tpl = currentTemplate();
      return !!(tpl && tpl.chart_type === 'venn');
    }
    function selectedWideCols() {
      // draft.mapping 为空时回退推断映射（与 currentMapping 同口径），
      // 否则推断出的 y 列不会显示为 chip。
      var m = currentMapping() || {};
      if (isObj(m) === false) m = {};
      if (Array.isArray(m.ys) && m.ys.length) {
        return m.ys.filter(function (n) { return typeof n === 'string' && n !== ''; });
      }
      return (typeof m.y === 'string' && m.y !== '') ? [m.y] : [];
    }
    function commitWideCols(nextCols, nextRights) {
      var base = JSON.parse(JSON.stringify(currentMapping() || {}));
      var seen = {}, cols = [];
      (nextCols || []).forEach(function (c) {
        if (typeof c === 'string' && c !== '' && !seen[c] && data.columns.indexOf(c) >= 0) {
          seen[c] = true; cols.push(c);
        }
      });
      var tpl = currentTemplate();
      var ct = tpl ? tpl.chart_type : '';
      if (cols.length >= 2) {
        base.ys = cols.slice();
        if (isVennTpl()) {
          // venn：ys 是成员标记列，不需要 y/group/color 槽位
          delete base.y; delete base.group; delete base.color;
        } else {
          base.y = cols[0];
          base.group = null; // 宽表与长表分组互斥
          if (ct === 'scatter') base.color = null;
        }
      } else {
        delete base.ys;
        base.y = cols.length ? cols[0] : null;
      }
      draft.mapping = base;
      // 右轴集合只在 ≥2 列时有意义；列被移除时同步清掉（venn 无左右轴概念）
      draft.y2Right = (cols.length >= 2 && !isVennTpl() ? (nextRights || []) : [])
        .filter(function (c) { return cols.indexOf(c) >= 0; });
      rerenderMapping();
      refreshPreview();
    }
    function addWideCol(col) {
      var cols = selectedWideCols();
      if (cols.indexOf(col) < 0) commitWideCols(cols.concat([col]), draft.y2Right || []);
    }
    function removeWideCol(col) {
      commitWideCols(selectedWideCols().filter(function (c) { return c !== col; }),
        (draft.y2Right || []).filter(function (c) { return c !== col; }));
    }
    function setWideAxis(col, toRight) {
      var rights = (draft.y2Right || []).slice();
      var at = rights.indexOf(col);
      if (toRight && at < 0) rights.push(col);
      if (!toRight && at >= 0) rights.splice(at, 1);
      commitWideCols(selectedWideCols(), rights);
    }
    function rerenderMapping() {
      if (!mappingWrapHost) return;
      mappingWrapHost.textContent = '';
      mappingWrapHost.appendChild(buildMappingControls());
    }
    function buildWideYControl() {
      var wrap = h('div', { 'class': 'dw-ycol-wrap', 'data-wizard-y2': '1' });
      var chips = h('div', { 'class': 'dw-ycol-chips' });
      var hint = h('div', { 'class': 'dw-ycol-hint', text: '' });
      var addSelEl = null; // 闭包持有引用（node 测试 DOM 无 querySelector）
      function renderChips() {
        chips.textContent = '';
        var cols = selectedWideCols();
        var rights = draft.y2Right || [];
        var nonNum = 0;
        var vennMode = isVennTpl();
        cols.forEach(function (c) {
          // venn 成员标记允许 0/1、true/false 等非数值写法，不按数值列警告
          if (!vennMode && colKind[c] && !kindIsNumeric(colKind[c])) nonNum++;
          var isRight = cols.length >= 2 && rights.indexOf(c) >= 0;
          var chipKids = [document.createTextNode(c + ' ')];
          if (!vennMode) {
            var axSel = h('select', {
              'class': 'dw-ycol-axis', 'aria-label': '列「' + c + '」纵轴',
              disabled: cols.length < 2 ? 'disabled' : null
            });
            axSel.appendChild(h('option', { value: 'left', text: '左轴' }));
            axSel.appendChild(h('option', { value: 'right', text: '右轴' }));
            axSel.value = isRight ? 'right' : 'left';
            axSel.addEventListener('change', function () { setWideAxis(c, axSel.value === 'right'); });
            chipKids.push(axSel);
          }
          var rm = h('button', {
            'class': 'dw-ycol-rm', 'type': 'button',
            'aria-label': '移除列 ' + c, text: '×'
          });
          rm.addEventListener('click', function () { removeWideCol(c); });
          chipKids.push(rm);
          chips.appendChild(h('span', {
            'class': 'dw-ycol-chip' + (isRight ? ' dw-ycol-chip-right' : ''),
            'data-col': c, 'data-axis': isRight ? 'right' : 'left'
          }, chipKids));
        });
        if (!cols.length) {
          chips.appendChild(h('span', { 'class': 'dw-ycol-empty', text: vennMode ? '（拖入 2–3 个成员标记列）' : '（拖入列或点下方添加）' }));
        }
        hint.textContent = vennMode
          ? (cols.length >= 2
            ? '已选 ' + cols.length + ' 个集合；每列一个成员标记（0/1 或 true/false），最多 3 列。'
            : '每个集合一列成员标记（0/1 或 true/false），至少选 2 列、最多 3 列。')
          : (cols.length >= 2
            ? '已选 ' + cols.length + ' 列纵轴；每列可指定左轴或右轴，至少保留 1 列在左轴。'
            : (cols.length === 1 ? '再加一列即可画多条曲线；单列时按普通单轴绘制。'
              : '纵轴需要数值列；可多选几列画多条曲线。'));
        if (nonNum) {
          hint.textContent += ' 注意：' + nonNum + ' 列不是数值列，非数值行不会画出。';
        }
        // 添加列下拉（键盘路径；已选列不再出现）
        var addSel = h('select', { 'class': 'dw-ycol-addsel', 'aria-label': '添加纵轴列' });
        addSel.appendChild(h('option', { value: '', text: '＋ 添加列…' }));
        data.columns.forEach(function (n) {
          if (cols.indexOf(n) < 0) addSel.appendChild(h('option', { value: n, text: n }));
        });
        addSel.addEventListener('change', function () {
          if (addSel.value) addWideCol(addSel.value);
        });
        // 重建 chips 后把 addSel 追加到 wrap 尾部（每次 renderChips 重建）
        if (addSelEl && addSelEl.parentNode) addSelEl.parentNode.removeChild(addSelEl);
        wrap.appendChild(addSel);
        addSelEl = addSel;
      }
      wrap.appendChild(chips);
      wrap.appendChild(hint);
      renderChips();
      return wrap;
    }

    function buildMappingControls() {
      var wrap = h('div', { 'data-wizard-mapping': '1', 'class': 'dw-slots' });
      var slots = P.mappingSlots(draft.templateId);
      var tpl = currentTemplate();
      var sem = tpl ? semanticsFor(tpl.chart_type) : null;
      var requiredSlots = sem ? sem.required : [];
      var defaults = currentMapping(); // draft.mapping 优先（记忆/用户改动），否则内核推断
      // R4-HB：宽表多列纵轴（ys≥2）与 group/color 互斥，禁用对应槽位
      var wideMultiNow = Array.isArray(defaults.ys) && defaults.ys.length >= 2;
      selectEls = {};
      slotUI = {};
      if (!slots.length) {
        wrap.appendChild(h('div', {
          'class': 'dw-note',
          text: '该模板没有声明字段映射槽。'
        }));
        return wrap;
      }
      slots.forEach(function (slotDef) {
        var needed = requiredSlots.indexOf(slotDef.slot) >= 0;
        // R4-HB：line_multi/scatter 的纵轴槽改为多列选择（宽表 ys + 左/右轴）
        // R10：venn 的 ys 槽同样走多选 chip（成员标记列，无左右轴）
        var isWideY = wideYCapable() &&
          (slotDef.slot === 'y' || (isVennTpl() && slotDef.slot === 'ys'));
        var box = h('div', {
          'class': 'dw-slot',
          'data-slot': slotDef.slot
        });
        box.addEventListener('dragover', function (evt) {
          evt.preventDefault();
          if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'copy';
          addClass(box, 'dw-slot-over');
        });
        box.addEventListener('dragleave', function () { removeClass(box, 'dw-slot-over'); });
        box.addEventListener('drop', function (evt) {
          evt.preventDefault();
          removeClass(box, 'dw-slot-over');
          var col = null;
          try {
            if (evt.dataTransfer) col = evt.dataTransfer.getData('text/plain');
          } catch (e) { /* 忽略 */ }
          if (!col) col = dragCol;
          dragCol = null;
          if (col && data.columns.indexOf(col) >= 0) {
            if (isWideY) addWideCol(col); else setMapping(slotDef.slot, col);
          }
        });
        box.addEventListener('dragend', function () { dragCol = null; });

        var cur = h('div', {
          'class': 'dw-slot-cur',
          'data-slot-cur': slotDef.slot,
          text: '（未映射）'
        });
        var warn = h('div', {
          'class': 'dw-slot-warn',
          text: '此处需要数值列，非数值行不会画出'
        });
        warn.hidden = true;
        if (isWideY) {
          // 宽表纵轴：chip 列表 + 添加下拉；cur 显示已选列数
          slotUI[slotDef.slot] = { box: box, warn: warn, cur: cur, baseClass: 'dw-slot' };
          box.appendChild(h('div', { 'class': 'dw-slot-label' }, [
            document.createTextNode((needed ? '* ' : '') + slotLabel(slotDef) + '（可多选）')
          ]));
          box.appendChild(buildWideYControl());
          box.appendChild(warn);
          wrap.appendChild(box);
          return;
        }
        // R4-HB：ys≥2 时 group/color 槽与宽表互斥，置为禁用说明
        if (wideMultiNow && (slotDef.slot === 'group' || slotDef.slot === 'color')) {
          slotUI[slotDef.slot] = { box: box, warn: warn, cur: cur, baseClass: 'dw-slot' };
          box.appendChild(h('div', { 'class': 'dw-slot-label' }, [
            document.createTextNode(slotLabel(slotDef))
          ]));
          box.appendChild(h('div', {
            'class': 'dw-slot-cur',
            text: '多列纵轴模式下不使用此列'
          }));
          box.appendChild(warn);
          wrap.appendChild(box);
          return;
        }
        var select = h('select', {
          'data-wizard-slot': slotDef.slot,
          'aria-label': '映射槽 ' + slotDef.slot,
          'class': 'dw-slot-select'
        });
        select.appendChild(h('option', { value: '', text: '（不映射）' }));
        data.columns.forEach(function (name) {
          select.appendChild(h('option', { value: name, text: name }));
        });
        var preset = defaults[slotDef.slot];
        select.value = preset != null ? String(preset) : '';
        select.addEventListener('change', function () {
          setMapping(slotDef.slot, select.value || null);
        });
        selectEls[slotDef.slot] = select;
        slotUI[slotDef.slot] = {
          box: box, warn: warn, cur: cur,
          baseClass: 'dw-slot'
        };
        box.appendChild(h('div', { 'class': 'dw-slot-label' }, [
          document.createTextNode((needed ? '* ' : '') + slotLabel(slotDef))
        ]));
        box.appendChild(cur);
        box.appendChild(select);
        box.appendChild(warn);
        wrap.appendChild(box);
      });
      // 当前映射回填到各槽位显示
      var mapping = currentMapping();
      Object.keys(slotUI).forEach(function (slot) {
        if ((slot === 'y' || (isVennTpl() && slot === 'ys')) && wideYCapable()) {
          var wcols = selectedWideCols();
          slotUI[slot].cur.textContent = wcols.length ? wcols.join('、') : '（未映射）';
          return;
        }
        var col = mapping[slot];
        if (Array.isArray(col)) {
          slotUI[slot].cur.textContent = col.length ? col.join('、') : '（未映射）';
          return;
        }
        slotUI[slot].cur.textContent = col || '（未映射）';
        if (selectEls[slot]) selectEls[slot].value = col || '';
      });
      return wrap;
    }

    function setMapping(slot, column) {
      var base = currentMapping();
      base[slot] = column || null;
      draft.mapping = base;
      // 同步下拉与槽位当前值显示
      if (selectEls[slot]) selectEls[slot].value = column || '';
      if (slotUI[slot]) slotUI[slot].cur.textContent = column || '（未映射）';
      refreshPreview();
    }

    // ---- 画布选择 ----
    function buildCanvasControls() {
      var tpl = currentTemplate();
      var preset = tpl && tpl.journal_default ? P.journal(tpl.journal_default) : null;
      var wrap = h('div', {
        'data-wizard-canvas': '1',
        'class': 'dw-canvas'
      });
      var cur = opts.currentCanvas || { width_mm: 120, height_mm: 90, dpi: 300 };
      canvasKeepRadio = h('input', { type: 'radio', name: 'wizard-canvas', checked: true });
      canvasKeepRadio.addEventListener('change', function () {
        if (canvasKeepRadio.checked) { draft.canvasChoice = { mode: 'keep' }; refreshPreview(); }
      });
      wrap.appendChild(h('label', { 'class': 'dw-canvas-opt' }, [
        canvasKeepRadio,
        document.createTextNode('保持当前画布 ' + Math.round(cur.width_mm) + ' × ' +
          Math.round(cur.height_mm) + ' mm（推荐，不会改变尺寸）')
      ]));
      if (preset) {
        canvasPresetRadio = h('input', { type: 'radio', name: 'wizard-canvas' });
        canvasPresetRadio.addEventListener('change', function () {
          if (canvasPresetRadio.checked) { draft.canvasChoice = { mode: 'explicit_preset' }; refreshPreview(); }
        });
        wrap.appendChild(h('label', { 'class': 'dw-canvas-opt' }, [
          canvasPresetRadio,
          document.createTextNode('套用模板期刊预设 ' + preset.name + '（' +
            preset.width_mm + ' × ' + (preset.height_mm != null ? preset.height_mm : Math.round(preset.width_mm * 0.75)) +
            ' mm' + (preset.base_font_pt ? '，正文 ' + preset.base_font_pt + 'pt' : '') + '）')
        ]));
      }
      canvasSizeRadio = h('input', { type: 'radio', name: 'wizard-canvas' });
      widthInput = h('input', {
        type: 'number', min: '10', max: '2000', step: '0.5',
        value: String(Math.round(cur.width_mm)),
        'class': 'dw-num', 'aria-label': '自定义宽度 mm'
      });
      heightInput = h('input', {
        type: 'number', min: '10', max: '2000', step: '0.5',
        value: String(Math.round(cur.height_mm)),
        'class': 'dw-num', 'aria-label': '自定义高度 mm'
      });
      function takeCustom() {
        canvasSizeRadio.checked = true;
        draft.canvasChoice = { mode: 'explicit_size' };
        refreshPreview();
      }
      canvasSizeRadio.addEventListener('change', function () {
        if (canvasSizeRadio.checked) takeCustom();
      });
      widthInput.addEventListener('change', takeCustom);
      heightInput.addEventListener('change', takeCustom);
      wrap.appendChild(h('label', { 'class': 'dw-canvas-opt' }, [
        canvasSizeRadio,
        document.createTextNode('自定义 '),
        widthInput, document.createTextNode('×'), heightInput, document.createTextNode(' mm')
      ]));
      if (canPlaceNewTab) {
        wrap.appendChild(h('div', { 'class': 'dw-place-label', text: '放置到' }));
        var newTabRadio = h('input', {
          type: 'radio', name: 'wizard-place', checked: placeInChoice() === 'new-tab'
        });
        newTabRadio.addEventListener('change', function () {
          if (newTabRadio.checked) { draft.placeIn = 'new-tab'; refreshPreview(); }
        });
        wrap.appendChild(h('label', { 'class': 'dw-canvas-opt' }, [
          newTabRadio,
          document.createTextNode('新建画布标签页（推荐）')
        ]));
        var curTabRadio = h('input', {
          type: 'radio', name: 'wizard-place', checked: placeInChoice() === 'current'
        });
        curTabRadio.addEventListener('change', function () {
          if (curTabRadio.checked) { draft.placeIn = 'current'; refreshPreview(); }
        });
        wrap.appendChild(h('label', { 'class': 'dw-canvas-opt' }, [
          curTabRadio,
          document.createTextNode('放到当前画布')
        ]));
      }
      return wrap;
    }

    // ---- 单元格编辑（G20）：双击/Enter/F2 进入行内编辑，Esc 取消 ----
    function editForCell(row, column) {
      for (var i = 0; i < cellEdits.length; i++) {
        if (cellEdits[i].row === row && cellEdits[i].column === column) return cellEdits[i];
      }
      return null;
    }

    function fmtCellValue(v) {
      if (v === null || v === undefined) return '空';
      if (typeof v === 'number' && isFinite(v)) {
        // 与表格显示一致：数值原样显示（避免 1.5 -> "1.5" 差异）
        return String(v);
      }
      return String(v);
    }

    function setCellEdit(row, column, rawText, opts2) {
      // rawText 为输入框文本；经 FigData.parseCell 按当前数字写法转换。
      opts2 = opts2 || {};
      var ci = data.columns.indexOf(column);
      if (ci < 0 || row < 0 || row >= data.rows.length) return false;
      var orig = parsedData.rows[row] ? parsedData.rows[row][ci] : undefined;
      var next = global.FigData && typeof global.FigData.parseCell === 'function'
        ? global.FigData.parseCell(rawText, parseState.numberFormat)
        : coerceFallback(rawText);
      // 与原始值相同 → 移除该格修改记录
      var same = (next === orig) ||
        (next === null && (orig === null || orig === undefined || orig === '')) ||
        (orig === null && next === null);
      var existed = editForCell(row, column);
      if (same) {
        if (existed) {
          cellEdits.splice(cellEdits.indexOf(existed), 1);
        }
      } else if (existed) {
        existed.from = orig === undefined ? null : orig;
        existed.to = next;
      } else {
        cellEdits.push({
          row: row, column: column,
          from: orig === undefined ? null : orig,
          to: next
        });
      }
      lastEditedFocus = { row: row, column: column };
      // 不变量：data = applyEdits(parsedData, cellEdits)，再原地重建
      data = applyEdits(parsedData, cellEdits);
      reloadData({ focusRef: { row: row, column: column } });
      if (opts2.after) opts2.after();
      return true;
    }

    function coerceFallback(text) {
      var s = String(text == null ? '' : text).trim();
      if (s === '') return null;
      var low = s.toLowerCase();
      if (low === 'na' || low === 'n/a' || low === 'nan' || low === 'null' ||
          low === 'none' || low === '-') return null;
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
        var n = Number(s);
        if (isFinite(n)) return n;
      }
      return s;
    }

    function revertCellEdit(row, column) {
      var e = editForCell(row, column);
      if (!e) return;
      cellEdits.splice(cellEdits.indexOf(e), 1);
      lastEditedFocus = { row: row, column: column };
      data = applyEdits(parsedData, cellEdits);
      reloadData({ focusRef: { row: row, column: column } });
    }

    function revertAllEdits() {
      if (!cellEdits.length) return;
      cellEdits = [];
      data = applyEdits(parsedData, cellEdits);
      reloadData({});
    }

    // ---- 第 1 步：数据表（roving tabindex、≤50 行起、sticky 表头） ----
    function buildDataTable() {
      var box = h('div', { 'class': 'dw-table-wrap', 'data-wizard-data': '1' });
      var table = h('table', { 'class': 'dw-table' });
      var thead = h('thead');
      var headRow = h('tr');
      data.columns.forEach(function (name) {
        var th = h('th', { text: name });
        var badges = h('span', { 'class': 'dw-th-badges' });
        if (colKind[name] !== undefined) {
          badges.appendChild(h('span', {
            'class': 'dw-badge dw-badge-' + (kindIsNumeric(colKind[name]) ? 'num' : (/date|time/i.test(String(colKind[name])) ? 'date' : 'text')),
            text: kindLabel(colKind[name])
          }));
        }
        var miss = columnMissing(effectiveData(), name);
        if (miss) {
          badges.appendChild(h('span', { 'class': 'dw-badge dw-badge-miss', text: '缺 ' + miss }));
        }
        th.appendChild(badges);
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);
      var tbody = h('tbody');
      var eff = effectiveData();
      var shown = Math.min(data.rows.length, shownRows);
      var flatIdx = 0;
      for (var i = 0; i < shown; i++) {
        var row = data.rows[i];
        var effRow = eff.rows[i];
        var tr = h('tr');
        data.columns.forEach(function (colName, ci) {
          var v = effRow && effRow[ci];
          var missing = v === null || v === undefined || v === '';
          var edit = editForCell(i, colName);
          var td = h('td', {
            'class': (missing ? 'dw-miss ' : '') + (edit ? 'dw-cell-edited' : ''),
            title: edit
              ? '已修改 · 原值：' + fmtCellValue(edit.from) + '（第 ' + (i + 1) + ' 行）'
              : '第 ' + (i + 1) + ' 行',
            text: missing ? '—' : String(v),
            tabindex: allowCellEdit ? (flatIdx === cellFocusIdx ? '0' : '-1') : null,
            'data-cell-row': String(i),
            'data-cell-col': colName
          });
          if (allowCellEdit) {
            td.setAttribute('role', 'gridcell');
            wireCellEdit(td, i, colName);
          }
          flatIdx++;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      box.appendChild(table);
      if (data.rows.length > shown) {
        showMoreHost = h('div', { 'class': 'dw-note' }, [
          document.createTextNode('… 共 ' + data.rows.length + ' 行（显示前 ' + shown + ' 行） '),
          h('button', {
            'class': 'dw-link', 'data-wizard-showmore': '1',
            text: '再显示 200 行',
            onclick: function () {
              shownRows += 200;
              var host = dataTableHost;
              if (!host) return;
              var oldWrap = host.querySelector('.dw-table-wrap');
              var st = oldWrap ? oldWrap.scrollTop : 0;
              var sl = oldWrap ? oldWrap.scrollLeft : 0;
              host.textContent = '';
              var newWrap = buildDataTable();
              host.appendChild(newWrap);
              newWrap.scrollTop = st;
              newWrap.scrollLeft = sl;
            }
          })
        ]);
        box.appendChild(showMoreHost);
      }
      return box;
    }

    function wireCellEdit(td, row, column) {
      function startEdit() {
        if (td.querySelector('input')) return;
        var cur = td.textContent === '—' ? '' : td.textContent;
        var initialText = cur; // R2：未改动直接提交按取消处理
        td.textContent = '';
        var input = h('input', {
          'class': 'dw-cell-input', 'type': 'text',
          'data-modal-keys': 'own',
          value: cur, 'aria-label': '编辑 ' + column + ' 第 ' + (row + 1) + ' 行'
        });
        td.appendChild(input);
        input.focus();
        input.select && input.select();
        var done = false;
        function commit(save) {
          if (done) return;
          done = true;
          // 输入与进入编辑时的显示文本相同 → 视为取消，不产生修改记录
          if (save && input.value !== initialText) {
            setCellEdit(row, column, input.value);
          } else {
            lastEditedFocus = { row: row, column: column };
            reloadData({ focusRef: { row: row, column: column } });
          }
        }
        input.addEventListener('keydown', function (evt) {
          evt.stopPropagation();
          if (evt.key === 'Enter') { evt.preventDefault(); commit(true); }
          else if (evt.key === 'Escape') { evt.preventDefault(); commit(false); }
        });
        input.addEventListener('blur', function () { commit(true); });
      }
      td.addEventListener('dblclick', function (evt) {
        evt.stopPropagation();
        startEdit();
      });
      td.addEventListener('keydown', function (evt) {
        if (evt.key === 'Enter' || evt.key === 'F2') {
          evt.preventDefault();
          evt.stopPropagation();
          startEdit();
          return;
        }
        var nr = -1, nc = -1;
        var cols = data.columns.length;
        var shown = Math.min(data.rows.length, shownRows);
        if (evt.key === 'ArrowRight') { nr = row; nc = data.columns.indexOf(column) + 1; }
        else if (evt.key === 'ArrowLeft') { nr = row; nc = data.columns.indexOf(column) - 1; }
        else if (evt.key === 'ArrowDown') { nr = row + 1; nc = data.columns.indexOf(column); }
        else if (evt.key === 'ArrowUp') { nr = row - 1; nc = data.columns.indexOf(column); }
        if (nr < 0 || nr >= shown || nc < 0 || nc >= cols) return;
        evt.preventDefault();
        cellFocusIdx = nr * cols + nc;
        // roving tabindex：按扁平序号定位格子，列名可能含特殊字符故不拼选择器
        var cells = dataTableHost ? dataTableHost.querySelectorAll('td[data-cell-row]') : [];
        var want = cells[cellFocusIdx];
        if (want) {
          want.setAttribute('tabindex', '0');
          try { want.focus(); } catch (e) { /* best effort */ }
        }
        Array.prototype.forEach.call(cells, function (c) {
          if (c !== want) c.setAttribute('tabindex', '-1');
        });
      });
    }

    function restoreCellFocus(row, column) {
      if (!dataTableHost) return;
      var cells = dataTableHost.querySelectorAll('td[data-cell-row]');
      var cols = data.columns.length;
      var idx = row * cols + data.columns.indexOf(column);
      if (idx < 0 || idx >= cells.length) return;
      cellFocusIdx = idx;
      Array.prototype.forEach.call(cells, function (c) {
        c.setAttribute('tabindex', '-1');
      });
      var target = cells[idx];
      target.setAttribute('tabindex', '0');
      try { target.focus({ preventScroll: true }); }
      catch (e) { try { target.focus(); } catch (e2) { /* best effort */ } }
    }

    // ---- 「读取方式」行（G19）：仅分隔文本来源显示 ---------------------
    var DELIM_LABELS = { auto: '自动', ',': '逗号 ,', ';': '分号 ;', '\t': '制表符 Tab' };
    var NF_LABELS = {
      plain: '1234.5（默认）',
      comma_thousands: '1,234.5（逗号是千分位）',
      comma_decimal: '1.234,5（逗号是小数点）'
    };
    var NF_SHORT = {
      comma_decimal: '逗号是小数点',
      comma_thousands: '逗号是千分位'
    };
    var DELIM_NOTE = { ',': '逗号', ';': '分号', '\t': '制表符' };

    function delimDisplayName(d) {
      if (d === '\t') return '制表符';
      return DELIM_NOTE[d] || d || '逗号';
    }

    function sniffColumnsText(cols) {
      return (cols || []).join('、');
    }

    function rebuildParseRow() {
      if (!parseReparseHost) return;
      parseReparseHost.textContent = '';
      if (!parseCfg) return;
      var row = h('div', { 'class': 'dw-parse', 'data-wizard-parse': '1' });
      row.appendChild(h('span', { 'class': 'dw-parse-label', text: '读取方式' }));

      // 分隔符下拉：自动（检测到：X）｜逗号｜分号｜制表符
      var delimSel = h('select', {
        'class': 'dw-parse-sel', 'data-parse-delimiter': '1',
        'aria-label': '分隔符'
      });
      var autoText = '自动（检测到：' + delimDisplayName(detectedDelimiter) + '）';
      delimSel.appendChild(h('option', { value: 'auto', text: autoText }));
      [',', ';', '\t'].forEach(function (d) {
        delimSel.appendChild(h('option', { value: d, text: DELIM_LABELS[d] }));
      });
      delimSel.value = parseState.delimiter;
      delimSel.addEventListener('change', function () {
        applyParseChange({ delimiter: delimSel.value });
      });
      row.appendChild(h('label', { 'class': 'dw-parse-item' }, [
        document.createTextNode('分隔符 '), delimSel
      ]));

      // 数字写法下拉
      var nfSel = h('select', {
        'class': 'dw-parse-sel', 'data-parse-numberformat': '1',
        'aria-label': '数字写法'
      });
      Object.keys(NF_LABELS).forEach(function (k) {
        nfSel.appendChild(h('option', { value: k, text: NF_LABELS[k] }));
      });
      nfSel.value = parseState.numberFormat;
      nfSel.addEventListener('change', function () {
        applyParseChange({ numberFormat: nfSel.value });
      });
      row.appendChild(h('label', { 'class': 'dw-parse-item' }, [
        document.createTextNode('数字写法 '), nfSel
      ]));
      parseReparseHost.appendChild(row);

      // 提示条：suggestion / ambiguous（绝不自动应用）；
      // 仅当数字写法仍是默认 plain 时提示——已选非默认写法则不再提示。
      var hint = numberHint;
      if (hint && (hint.suggestion || hint.ambiguous) && parseState.numberFormat === 'plain') {
        var colsText = sniffColumnsText(hint.columns);
        var bar = h('div', { 'class': 'dw-parse-hint', 'data-wizard-parse-hint': '1' });
        if (hint.suggestion === 'comma_decimal') {
          bar.appendChild(h('span', {
            text: '「' + colsText + '」列像是用逗号作小数点（例如 ' + hint.example +
              '），现在被当成文本。 '
          }));
          bar.appendChild(h('button', {
            'class': 'dw-link', 'data-parse-apply': 'comma_decimal',
            text: '按「逗号是小数点」读取',
            onclick: function () { applyParseChange({ numberFormat: 'comma_decimal' }); }
          }));
        } else if (hint.suggestion === 'comma_thousands') {
          bar.appendChild(h('span', {
            text: '「' + colsText + '」列像是带千分位逗号（例如 ' + hint.example +
              '），现在被当成文本。 '
          }));
          bar.appendChild(h('button', {
            'class': 'dw-link', 'data-parse-apply': 'comma_thousands',
            text: '按「逗号是千分位」读取',
            onclick: function () { applyParseChange({ numberFormat: 'comma_thousands' }); }
          }));
        } else if (hint.ambiguous) {
          bar.appendChild(h('span', {
            text: '「' + colsText + '」列里 ' + hint.example +
              ' 这样的写法有两种读法。请在「数字写法」里选一种；不选则保持为文本。'
          }));
        }
        parseReparseHost.appendChild(bar);
      }
    }

    function applyParseChange(patch) {
      // patch: {delimiter?, numberFormat?}；确认框在有单元格修改时先弹。
      var nextDelim = patch.delimiter !== undefined ? patch.delimiter : parseState.delimiter;
      var nextNF = patch.numberFormat !== undefined ? patch.numberFormat : parseState.numberFormat;
      var same = nextDelim === parseState.delimiter && nextNF === parseState.numberFormat;
      if (same) return;
      function doReparse() {
        var res;
        try {
          res = parseCfg.reparse({ delimiter: nextDelim, numberFormat: nextNF });
        } catch (err) {
          toast('重新读取失败：' + err.message, 'error');
          rebuildParseRow(); // 恢复下拉到原值
          return;
        }
        parseState.delimiter = nextDelim;
        parseState.numberFormat = nextNF;
        if (res && typeof res.detectedDelimiter === 'string') {
          detectedDelimiter = res.detectedDelimiter;
        }
        if (res && isObj(res.hint)) numberHint = res.hint;
        // 不变量：重新解析 → parsedData=data=新原表，修改记录作废（已确认）
        parsedData = cloneTable(res.data);
        cellEdits = [];
        data = cloneTable(res.data);
        lastEditedFocus = null;
        memKey = memKeyFor(opts.filename, data.columns);
        reloadData({});
      }
      if (cellEdits.length) {
        var msg = '改变读取方式会重新读取文件，已做的 ' + cellEdits.length +
          ' 处单元格修改会丢失。继续吗？';
        // Ui.confirm(text) 单参、返回 Promise<boolean>（ui.js 定稿接口）
        if (global.Ui && typeof global.Ui.confirm === 'function') {
          global.Ui.confirm(msg).then(function (ok) {
            if (ok) doReparse(); else rebuildParseRow();
          });
        } else if (typeof window !== 'undefined' && window.confirm) {
          if (window.confirm(msg)) doReparse(); else rebuildParseRow();
        } else {
          doReparse();
        }
      } else {
        doReparse();
      }
    }

    // ---- 修改清单面板（G20）：已修改 N 个单元格 + 全部还原 + 清单 ----
    function renderEditsPanel() {
      if (!editsHost) return;
      editsHost.textContent = '';
      if (!allowCellEdit) return;
      editsHost.appendChild(h('div', {
        'class': 'dw-note',
        text: '双击单元格可以修改数值；原始文件不会被改动，修改会记录在数据来源里。'
      }));
      if (!cellEdits.length) return;
      var head = h('div', { 'class': 'dw-edits-head' }, [
        h('span', { 'class': 'dw-edits-count', 'data-wizard-edits-count': '1',
          text: '已修改 ' + cellEdits.length + ' 个单元格' }),
        h('button', {
          'class': 'dw-link', 'data-wizard-revert-all': '1',
          text: '全部还原',
          onclick: function () { revertAllEdits(); }
        })
      ]);
      editsHost.appendChild(head);
      var det = h('details', { 'class': 'dw-edits-list' }, [
        h('summary', { text: '查看修改清单' })
      ]);
      var list = h('div', { 'class': 'dw-edits-items' });
      cellEdits.forEach(function (e) {
        var rowNo = e.row + 1;
        var item = h('div', { 'class': 'dw-edit-item' }, [
          document.createTextNode('第 ' + rowNo + ' 行 · ' + e.column + '：' +
            fmtCellValue(e.from) + ' → ' + fmtCellValue(e.to) + ' '),
          h('button', {
            'class': 'dw-link', 'data-wizard-revert-one': '1',
            text: '还原',
            onclick: function () { revertCellEdit(e.row, e.column); }
          })
        ]);
        list.appendChild(item);
      });
      det.appendChild(list);
      editsHost.appendChild(det);
    }

    // ---- 第 1 步：推荐卡片 + 记忆提示 ----
    function buildRecCard() {
      var card = h('div', { 'class': 'dw-reccard', 'data-wizard-quickcard': '1' });
      var rec0 = recommendations[0];
      var tpl0 = P.template(rec0.template_id);
      card.appendChild(h('div', { 'class': 'dw-reccard-title' }, [
        h('span', { 'class': 'dw-badge dw-badge-rec', text: '推荐' }),
        document.createTextNode(' ' + (tpl0 ? tpl0.name : rec0.template_id))
      ]));
      var map0 = inferredMapping(rec0.template_id);
      // F3：首个推荐用当前数据建不出来（试建抛错，或必填槽在推断映射里有空缺）
      // 时禁用「按推荐直接创建」；数据变化（reloadData 重建本卡）后重新判断。
      var canQuick = true;
      var sem0 = tpl0 ? semanticsFor(tpl0.chart_type) : null;
      var req0 = (sem0 && Array.isArray(sem0.required)) ? sem0.required : [];
      if (req0.some(function (s) { return !map0[s]; })) {
        canQuick = false;
      } else {
        try {
          opts.buildDraft(rec0.template_id, null, { mode: 'keep' }, draft.title, ctxForCreate());
        } catch (e) { canQuick = false; }
      }
      card.appendChild(h('div', {
        'class': 'dw-reccard-line',
        text: '映射：' + humanMapText(map0, tpl0)
      }));
      var cur = opts.currentCanvas || { width_mm: 120, height_mm: 90 };
      card.appendChild(h('div', {
        'class': 'dw-reccard-line',
        text: '画布：保持当前画布 ' + Math.round(cur.width_mm) + ' × ' +
          Math.round(cur.height_mm) + ' mm'
      }));
      card.appendChild(h('button', {
        'class': 'ui-btn dw-quick',
        'data-wizard-quick': '1',
        text: '按推荐直接创建',
        disabled: !canQuick,
        onclick: function () { if (canQuick) handle.quickCreate(); }
      }));
      if (!canQuick) {
        card.appendChild(h('div', {
          'class': 'dw-note', 'data-wizard-quick-disabled': '1',
          text: '现在的数据还不够画这张图，先看上面的提示，或点「下一步」调整。'
        }));
      }
      var dupSt0 = dupXStatsFor(tpl0 ? tpl0.chart_type : null, map0);
      if (dupSt0 && dupSt0.dupX > 0) {
        card.appendChild(h('div', {
          'class': 'dw-stat-warn', 'data-wizard-dupwarn': '1',
          text: '推荐的折线图里有 ' + dupSt0.dupX +
            ' 处重复的横轴位置，直接创建会出现折返；建议点「下一步」先看一下。'
        }));
      }
      return card;
    }

    function buildMemHint() {
      var wrap = h('div', { 'class': 'dw-mem' });
      wrap.appendChild(h('span', {
        text: '已沿用上次对这个文件的选择，可以修改'
      }));
      wrap.appendChild(h('button', {
        'class': 'dw-link',
        text: '改回推荐',
        onclick: function () { resetToRecommended(); }
      }));
      return wrap;
    }

    // ---- 模板卡片（第 2 步） ----
    function buildTemplateList(onPicked) {
      var list = h('div', {
        'data-wizard-templates': '1',
        'class': 'dw-cards'
      });
      templateRadios = [];
      recommendations.forEach(function (rec, i) {
        var tpl = P.template(rec.template_id);
        var isFirst = i === 0;
        var usable = rec.score > 0;
        var badgeText = isFirst ? '推荐' : (usable ? '可用' : '不适合');
        var badgeCls = isFirst ? 'dw-badge-rec' : (usable ? 'dw-badge-ok' : 'dw-badge-off');
        var radio = h('input', {
          type: 'radio', name: 'wizard-template',
          checked: rec.template_id === draft.templateId,
          'aria-label': '模板 ' + (tpl ? tpl.name : rec.template_id)
        });
        radio.addEventListener('change', function () {
          if (radio.checked) onPicked(rec.template_id);
        });
        templateRadios.push({ radio: radio, id: rec.template_id });
        var card = h('label', {
          'class': 'dw-card' + (isFirst || usable ? '' : ' dw-card-off')
        }, [
          radio,
          h('div', { 'class': 'dw-card-body' }, [
            h('div', { 'class': 'dw-card-title' }, [
              h('span', { 'text': (tpl ? tpl.name : rec.template_id) + ' ' }),
              h('span', { 'class': 'dw-badge ' + badgeCls, text: badgeText })
            ]),
            h('div', {
              'class': 'dw-card-reasons',
              text: (rec.reasons || []).join('；') || '—'
            })
          ])
        ]);
        var tip = h('details', { 'class': 'dw-tip dw-card-tip' }, [
          h('summary', { text: 'ⓘ' }),
          h('div', { 'class': 'dw-tip-body', text: '匹配分数：' + rec.score })
        ]);
        card.appendChild(tip);
        list.appendChild(card);
      });
      return list;
    }

    // ---- 列标签（可拖动） ----
    function buildColumnChips() {
      var wrap = h('div', { 'class': 'dw-chips', 'data-wizard-columns': '1' });
      data.columns.forEach(function (name) {
        var chip = h('span', {
          'class': 'dw-chip',
          'data-col': name,
          draggable: 'true',
          text: name
        });
        if (colKind[name] !== undefined) {
          chip.appendChild(h('span', {
            'class': 'dw-chip-kind',
            text: kindLabel(colKind[name])
          }));
        }
        chip.addEventListener('dragstart', function (evt) {
          dragCol = name;
          try {
            if (evt.dataTransfer) {
              evt.dataTransfer.setData('text/plain', name);
              evt.dataTransfer.effectAllowed = 'copy';
            }
          } catch (e) { /* 忽略 */ }
        });
        chip.addEventListener('dragend', function () { dragCol = null; });
        wrap.appendChild(chip);
      });
      return wrap;
    }

    // ---- 组装与步骤切换 ----
    var body = h('div', { 'data-wizard-root': '1', 'class': 'dw-root' });

    // 步骤条
    var stepsNav = h('nav', { 'class': 'dw-steps', 'aria-label': '向导步骤' });
    var stepNames = ['1 看数据', '2 选图与映射', '3 画布与标题', '4 确认'];
    stepNames.forEach(function (name, i) {
      var btn = h('button', {
        'class': 'dw-stepbtn',
        'data-step-btn': String(i + 1),
        text: name
      });
      btn.addEventListener('click', function () { goTo(i + 1); });
      stepBtns.push(btn);
      stepsNav.appendChild(btn);
    });
    body.appendChild(stepsNav);

    var cols = h('div', { 'class': 'dw-cols' });
    var mainCol = h('div', { 'class': 'dw-main' });
    var sideCol = h('div', { 'class': 'dw-side' });

    // 第 1 步面板
    var step1 = h('section', {
      'class': 'dw-step', 'data-step': '1',
      tabindex: '-1', 'data-autofocus': ''
    });
    step1.appendChild(h('div', { 'class': 'dw-h', text: '数据预览' }));
    var srcInfo = opts.sourceInfo || {};
    var srcBits = ['来源：' + opts.filename];
    if (srcInfo.sheet_name) srcBits.push('工作表「' + srcInfo.sheet_name + '」');
    if (srcInfo.header_row) srcBits.push('表头第 ' + srcInfo.header_row + ' 行');
    srcBits.push(data.rows.length + ' 行 × ' + data.columns.length + ' 列');
    step1.appendChild(h('div', { 'class': 'dw-src', text: srcBits.join(' · ') }));
    // G19：「读取方式」行仅分隔文本来源显示（parse 接缝存在时）
    parseReparseHost = h('div', { 'class': 'dw-parsehost' });
    if (parseCfg) step1.appendChild(parseReparseHost);
    rebuildParseRow();
    // G21 复用模式：说明数据取自画布图表
    if (reuseNote) {
      step1.appendChild(h('div', { 'class': 'dw-note dw-reuse-note', text: reuseNote }));
    }
    dataTableHost = h('div', { 'class': 'dw-tablehost' });
    dataTableHost.appendChild(buildDataTable());
    step1.appendChild(dataTableHost);
    editsHost = h('div', { 'class': 'dw-editshost' });
    if (allowCellEdit) renderEditsPanel();
    step1.appendChild(editsHost);
    step1.appendChild(h('div', { 'class': 'dw-h', text: '推荐' }));
    recCardHost = h('div', {});
    if (memApplied) {
      memHintEl = buildMemHint();
      step1.appendChild(memHintEl);
    }
    recCardHost.appendChild(buildRecCard());
    step1.appendChild(recCardHost);

    // 第 2 步面板
    var step2 = h('section', { 'class': 'dw-step', 'data-step': '2' });
    step2.appendChild(h('div', { 'class': 'dw-h', text: '图表类型' }));
    templateListHost = h('div', {});
    templateListHost.appendChild(buildTemplateList(function (id) {
      draft.templateId = id;
      rebuildForTemplate();
    }));
    step2.appendChild(templateListHost);
    step2.appendChild(h('div', { 'class': 'dw-h', text: '字段映射（拖动列名到槽位，或用下拉；* 为必填）' }));
    chipsHost = h('div', {});
    chipsHost.appendChild(buildColumnChips());
    step2.appendChild(chipsHost);
    mappingWrapHost = h('div', {});
    step2.appendChild(mappingWrapHost);
    step2.appendChild(h('div', { 'class': 'dw-h', text: '这些数字代表什么' }));
    statsHost = h('div', { 'class': 'dw-stats', 'data-wizard-summary': '1' });
    step2.appendChild(statsHost);
    tipHost = h('div', { 'class': 'dw-tiphost' });
    step2.appendChild(tipHost);

    // 第 3 步面板
    var step3 = h('section', { 'class': 'dw-step', 'data-step': '3' });
    step3.appendChild(h('div', { 'class': 'dw-h', text: '画布' }));
    canvasHost = h('div', {});
    step3.appendChild(canvasHost);
    step3.appendChild(h('div', { 'class': 'dw-h', text: '图表标题（可留空）' }));
    titleInput = h('input', {
      type: 'text', value: draft.title,
      'class': 'dw-title',
      'aria-label': '图表标题'
    });
    titleInput.addEventListener('input', function () {
      draft.title = titleInput.value;
      schedulePreview(); // dirty 立即生效（draft.title 已更新），预览 150ms 去抖
    });
    step3.appendChild(titleInput);

    // 第 4 步面板
    var step4 = h('section', { 'class': 'dw-step', 'data-step': '4' });
    step4.appendChild(h('div', { 'class': 'dw-h', text: '确认' }));
    summaryHost = h('div', { 'class': 'dw-summary', 'data-wizard-confirm': '1' });
    step4.appendChild(summaryHost);
    tip4Host = h('div', { 'class': 'dw-tiphost' });
    step4.appendChild(tip4Host);

    panels = [step1, step2, step3, step4];
    panels.forEach(function (p, i) { p.hidden = i !== 0; mainCol.appendChild(p); });

    cols.appendChild(mainCol);
    // 右栏：常驻预览
    previewBox = h('div', {
      'class': 'dw-preview',
      'data-wizard-preview': '1'
    });
    sideCol.appendChild(previewBox);
    sideCol.appendChild(h('div', {
      'class': 'dw-preview-cap',
      text: '预览 · 尚未写入文档'
    }));
    cols.appendChild(sideCol);
    body.appendChild(cols);

    function rebuildForTemplate(keepMapping) {
      // 换模板回到该模板的推断默认；仅初始构建传 keepMapping=true，
      // 以保留打开时记忆套用进 draft.mapping 的映射。
      if (!keepMapping) { draft.mapping = null; draft.y2Right = []; }
      mappingWrapHost.textContent = '';
      mappingWrapHost.appendChild(buildMappingControls());
      canvasHost.textContent = '';
      canvasHost.appendChild(buildCanvasControls());
      refreshPreview();
    }

    rebuildForTemplate(true);

    // ---- 步骤切换 ----
    function syncStepBar() {
      stepBtns.forEach(function (btn, i) {
        if (i + 1 === currentStep) btn.setAttribute('aria-current', 'step');
        else btn.removeAttribute('aria-current');
        btn.className = 'dw-stepbtn' + (i + 1 === currentStep ? ' dw-stepbtn-on' : '');
      });
    }

    function focusStep(n) {
      if (n === 1) { focusEl(panels[0]); return; }
      if (n === 2) {
        var checked = null;
        for (var i = 0; i < templateRadios.length; i++) {
          if (templateRadios[i].radio.checked) { checked = templateRadios[i].radio; break; }
        }
        focusEl(checked || (templateRadios[0] && templateRadios[0].radio));
        return;
      }
      if (n === 3) { focusEl(canvasKeepRadio); return; }
      // 第 4 步：聚焦「创建图表」（footer 主按钮）
      try {
        if (modal && modal.dialog && typeof modal.dialog.querySelector === 'function') {
          var primary = modal.dialog.querySelector('.ui-modal-footer .ui-btn-primary');
          if (primary) { focusEl(primary); return; }
        }
      } catch (e) { /* 忽略 */ }
      focusEl(panels[3]);
    }

    function syncFooter() {
      if (modal && typeof modal.setActions === 'function') {
        modal.setActions(footerActions());
      }
    }

    function goTo(n) {
      n = Math.max(1, Math.min(4, Math.round(Number(n)) || 1));
      currentStep = n;
      panels.forEach(function (p, i) { p.hidden = i !== n - 1; });
      syncStepBar();
      syncFooter();
      focusStep(n);
    }

    // ---- dirty 快照：模板 / 映射 / 画布选择 / 标题任一项与打开时不同即脏 ----
    // 快照在记忆套用之后取，套用本身不算用户改动。
    function sortDeep(v) {
      if (Array.isArray(v)) return v.map(sortDeep);
      if (v && typeof v === 'object') {
        var o = {};
        Object.keys(v).sort().forEach(function (k) { o[k] = sortDeep(v[k]); });
        return o;
      }
      return v;
    }
    function snapshotDraft() {
      return sortDeep({
        templateId: draft.templateId,
        mapping: currentMapping(),
        canvasChoice: currentCanvasChoice(),
        title: draft.title,
        y2right: (draft.y2Right || []).slice()
      });
    }
    var initialSnapshotJson = JSON.stringify(snapshotDraft());
    function parseStateDefault() {
      return parseState.delimiter === 'auto' && parseState.numberFormat === 'plain';
    }
    function draftChanged() {
      try {
        if (JSON.stringify(snapshotDraft()) !== initialSnapshotJson) return true;
      } catch (e) { /* fall through */ }
      // G19/G20：有单元格修改或读取方式非默认也算已改动
      if (cellEdits.length) return true;
      if (!parseStateDefault()) return true;
      return false;
    }

    function resetToRecommended() {
      draft.templateId = recommendations[0].template_id;
      draft.mapping = null;
      draft.y2Right = [];
      draft.canvasChoice = { mode: 'keep' };
      templateRadios.forEach(function (t) { t.radio.checked = t.id === draft.templateId; });
      if (memHintEl && memHintEl.parentNode) {
        memHintEl.parentNode.removeChild(memHintEl);
        memHintEl = null;
      }
      memApplied = false;
      rebuildForTemplate();
    }

    // ---- footer 动作（setActions 动态更新；初始数组含「取消」「创建图表」） ----
    var cancelAction = {
      label: '取消',
      'data-wizard-action': 'cancel',
      onClick: function () {
        // 取消也走 requestClose：有未保存改动时先弹确认；返回 false
        // 阻止 runAction 的默认 close（确认结果异步决定）。
        if (modal && typeof modal.requestClose === 'function') modal.requestClose();
        else handle.closeModal();
        return false;
      }
    };
    function footerActions() {
      return [
        cancelAction,
        {
          label: '上一步',
          'data-wizard-action': 'prev',
          disabled: currentStep === 1,
          onClick: function () {
            if (currentStep > 1) goTo(currentStep - 1);
            return false;
          }
        },
        {
          label: '下一步',
          primary: currentStep < 4,
          hidden: currentStep === 4,
          'data-wizard-action': 'next',
          onClick: function () {
            if (currentStep < 4) goTo(currentStep + 1);
            return false;
          }
        },
        {
          label: '创建图表',
          primary: currentStep === 4,
          'data-wizard-action': 'create',
          onClick: function () {
            return handle.create();
          }
        }
      ];
    }
    var actions = footerActions();

    var modal = null;
    try {
      if (global.Ui && typeof global.Ui.modal === 'function') {
        modal = global.Ui.modal({
          title: (typeof opts.modalTitle === 'string' && opts.modalTitle) ||
            ('导入数据向导：' + opts.filename),
          className: 'ui-modal-wide dw-modal',
          body: body,
          isDirty: draftChanged,
          discardText: '放弃本次导入设置？',
          actions: actions
        });
      }
    } catch (e) { modal = null; }
    if (!modal) {
      // 最小回退：挂到 body（headless 测试里 document.body 即容器）
      document.body.appendChild(body);
    }
    syncStepBar();
    syncFooter();

    var createSeq = 0;
    var handle = {
      modal: modal,
      body: body,
      actions: actions,
      step: function () { return currentStep; },
      goTo: goTo,
      draft: function () {
        return {
          templateId: draft.templateId,
          mapping: JSON.parse(JSON.stringify(currentMapping())),
          canvasChoice: JSON.parse(JSON.stringify(currentCanvasChoice())),
          title: String(draft.title == null ? '' : draft.title).trim()
        };
      },
      selectTemplate: function (id) {
        var found = templateRadios.some(function (t) {
          if (t.id === id) { t.radio.checked = true; return true; }
          return false;
        });
        if (!found) fail('未知模板：' + id);
        draft.templateId = id;
        rebuildForTemplate();
      },
      setMapping: setMapping,
      setCanvasChoice: function (choice) {
        if (!isObj(choice) || ['keep', 'explicit_preset', 'explicit_size'].indexOf(choice.mode) < 0) {
          fail('canvasChoice 必须是 {mode:"keep"|"explicit_preset"|"explicit_size"}');
        }
        draft.canvasChoice = { mode: choice.mode };
        if (choice.mode === 'explicit_size') {
          if (widthInput) widthInput.value = String(choice.width_mm || 120);
          if (heightInput) heightInput.value = String(choice.height_mm || 90);
        }
        if (choice.mode === 'keep' && canvasKeepRadio) canvasKeepRadio.checked = true;
        if (choice.mode === 'explicit_preset' && canvasPresetRadio) canvasPresetRadio.checked = true;
        if (choice.mode === 'explicit_size' && canvasSizeRadio) canvasSizeRadio.checked = true;
        refreshPreview();
      },
      setTitle: function (t) {
        draft.title = String(t == null ? '' : t);
        titleInput.value = draft.title;
        refreshPreview();
      },
      refreshPreview: refreshPreview,
      lastBuild: function () { return lastBuild; },
      quickCreate: function () {
        // 等价于：首个推荐模板 + 内核推断映射 + keep 画布 + 当前标题
        draft.templateId = recommendations[0].template_id;
        draft.mapping = null;
        draft.y2Right = [];
        draft.canvasChoice = { mode: 'keep' };
        templateRadios.forEach(function (t) {
          t.radio.checked = t.id === draft.templateId;
        });
        rebuildForTemplate();
        return handle.create();
      },
      create: function () {
        var seq = ++createSeq;
        if (seq !== 1) {
          // 重复点击：不重复提交（与 AI applyPending 同纪律）
          toast('已提交创建请求，请等待完成', 'info');
          return Promise.resolve(false);
        }
        var d = handle.draft();
        // 必填槽校验：缺失时阻止提交并提示（内核在 buildDraft 也会拦）
        var tpl = currentTemplate();
        var sem = tpl ? semanticsFor(tpl.chart_type) : null;
        // R4-HB：宽表多列纵轴（ys≥2）不需要 group 分组列
        var wideMulti = Array.isArray(d.mapping.ys) && d.mapping.ys.length >= 2;
        var missingSlots = (sem ? sem.required : []).filter(function (slot) {
          if (wideMulti && slot === 'group') return false;
          return !d.mapping[slot];
        });
        if (missingSlots.length) {
          var missNames = missingSlots.map(function (s) { return slotNameLabel(tpl, s); }).join('、');
          toast('还缺必须的列：' + missNames + '。请在第 2 步选好再创建', 'error');
          createSeq = 0;
          return Promise.resolve(false);
        }
        return Promise.resolve().then(function () {
          return opts.onCreate(d.templateId, d.mapping, d.canvasChoice, d.title, ctxForCreate());
        }).then(function (ok) {
          if (ok === false) {
            createSeq = 0; // 允许修正后重试
            return false;
          }
          // 仅创建成功后记忆映射（不存画布、不存数据）
          writeMemory(memKey, {
            templateId: d.templateId,
            mapping: d.mapping,
            y2right: (draft.y2Right || []).slice(),
            ts: Date.now()
          });
          handle.closeModal();
          return true;
        });
      },
      // ---- G19/G20 测试与内部 API ----
      data: function () { return cloneTable(effectiveData()); },
      parsedData: function () { return cloneTable(parsedData); },
      edits: function () {
        return cellEdits.map(function (e) {
          return { row: e.row, column: e.column, from: e.from, to: e.to };
        });
      },
      setCell: function (row, column, text) {
        if (!allowCellEdit) return false;
        return setCellEdit(Number(row), String(column), String(text == null ? '' : text));
      },
      revertEdits: function () { revertAllEdits(); },
      setParseOptions: function (patch) {
        if (!parseCfg || !isObj(patch)) return;
        applyParseChange({
          delimiter: patch.delimiter !== undefined ? patch.delimiter : undefined,
          numberFormat: patch.numberFormat !== undefined ? patch.numberFormat : undefined
        });
      },
      parseState: function () {
        return { delimiter: parseState.delimiter, numberFormat: parseState.numberFormat };
      },
      closeModal: function () {
        try {
          if (modal && typeof modal.close === 'function') modal.close();
          else if (body.parentNode) body.parentNode.removeChild(body);
        } catch (e) { /* already closed */ }
      }
    };
    // 测试钩子：最近一次打开的向导句柄（UI 测试经 window.__lastDataWizard 读取）
    try { global.__lastDataWizard = handle; } catch (e) { /* 忽略 */ }
    return handle;
  }

  global.DataWizard = { open: open };
})(typeof globalThis !== 'undefined' ? globalThis : this);
