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
 *   refreshPreview() 重建预览与统计摘要；create() 触发 onCreate 一次；
 *   closeModal()。所有控件是原生 select/input/radio/button，键盘可达。
 *
 * 约束（R02）：
 * - 草稿只存在于对话框内；预览不调用 App.commit、不写历史/工程；
 * - 自动推断只作默认值，用户确认值优先（kernel opts.mapping）；
 * - 渲染聚合方式、缺失值、被排除行数在确认页如实展示（RENDERER_SEMANTICS）；
 * - 模板期刊默认只作为建议显示，未经确认不改变用户画布。
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
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'disabled') el.disabled = !!v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          // 事件类型大小写敏感：onClick/onclick 一律注册为小写事件名
          el.addEventListener(String(k.slice(2)).toLowerCase(), v);
        } else el.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
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

  // ---- 数据统计（缺失/类型/被排除行） --------------------------------
  //
  // 被排除行：按当前模板 required 槽的映射列计算——x/y 缺失、空或（数值槽）
  // 非数值的行会被渲染器排除（RENDERS 的 catLabel/toNum 行为）。

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

  // ---- 向导主体 ---------------------------------------------------------

  function open(opts) {
    if (!isObj(opts)) fail('open 需要选项对象');
    if (!isObj(opts.data) || !Array.isArray(opts.data.columns)) fail('缺少 data');
    if (typeof opts.buildDraft !== 'function') fail('缺少 buildDraft 构建入口');
    if (typeof opts.onCreate !== 'function') fail('缺少 onCreate 提交入口');
    var data = opts.data;
    var recommendations = Array.isArray(opts.recommendations) && opts.recommendations.length
      ? opts.recommendations : [];
    if (!recommendations.length) fail('没有可推荐的模板');

    var P = global.FigPresets;
    if (!P || typeof P.mappingSlots !== 'function') {
      fail('内核 FigPresets 未加载 mappingSlots（需要新版 presets.js）');
    }

    var draft = {
      templateId: recommendations[0].template_id,
      mapping: null,            // null = 未确认（用内核推断为默认）
      canvasChoice: { mode: 'keep' },
      title: opts.appName || ''
    };

    // inferred mapping（内核 _resolveMapping 的结果，经 templateFromStats 无
    // mapping 调用获得），作为下拉默认值展示给用户确认。
    function inferredMapping(templateId) {
      try {
        var built = opts.buildDraft(templateId, null, { mode: 'keep' }, draft.title);
        return built && built.chart && isObj(built.chart.mapping)
          ? JSON.parse(JSON.stringify(built.chart.mapping)) : {};
      } catch (e) {
        return {};
      }
    }

    var selectEls = {};   // slot -> <select>
    var mappingSummary = null;
    var previewBox = null;
    var canvasPresetRadio = null;
    var canvasKeepRadio = null;
    var canvasSizeRadio = null;
    var widthInput = null;
    var heightInput = null;
    var titleInput = null;
    var templateRadios = [];
    var lastBuild = null;

    function currentTemplate() {
      return P.template(draft.templateId) || null;
    }

    function currentMapping() {
      if (isObj(draft.mapping)) return draft.mapping;
      return inferredMapping(draft.templateId);
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

    // ---- 预览（不写正式文档/历史/工程） ----
    function refreshPreview() {
      if (!previewBox) return;
      var mapping = currentMapping();
      var choice = currentCanvasChoice();
      var tpl = currentTemplate();
      var sem = tpl ? semanticsFor(tpl.chart_type) : null;
      var lines = [];
      try {
        lastBuild = opts.buildDraft(draft.templateId, mapping, choice, draft.title);
      } catch (err) {
        lastBuild = null;
        previewBox.textContent = '';
        previewBox.appendChild(h('div', {
          style: 'color:#b91c1c;font-size:12px;white-space:pre-wrap;',
          'data-wizard-error': 'build',
          text: '构建预览失败：' + err.message
        }));
        renderMappingSummary(mapping, sem);
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
        if (global.FigRender && typeof global.FigRender.toSVG === 'function') {
          svg = global.FigRender.toSVG(mini, { scale: 1, includeGuides: false });
        }
      } catch (err2) {
        renderError = err2.message;
      }
      if (svg) {
        previewBox.innerHTML = svg;
      } else if (!renderError) {
        previewBox.appendChild(h('div', {
          style: 'color:#8a6d3b;font-size:12px;',
          text: '当前环境缺少 FigRender，无法显示图形预览；映射与统计摘要仍然有效。'
        }));
      } else {
        previewBox.appendChild(h('div', {
          style: 'color:#b91c1c;font-size:12px;white-space:pre-wrap;',
          'data-wizard-error': 'render',
          text: '图形预览渲染失败：' + renderError + '（不会以此替代创建校验）'
        }));
      }
      renderMappingSummary(mapping, sem);
    }

    function renderMappingSummary(mapping, sem) {
      if (!mappingSummary) return;
      mappingSummary.textContent = '';
      var tpl = currentTemplate();
      var required = sem ? sem.required : [];
      var numericSlots = (tpl && tpl.chart_type === 'heatmap') ? ['color']
        : (sem && sem.aggregation !== 'none' ? ['y'] : ['x', 'y']);
      var lines = [];
      if (sem) {
        lines.push('渲染语义：' + sem.note + '。');
      }
      var excluded = excludedRowCount(data, required, mapping, numericSlots);
      if (excluded !== null) {
        lines.push('按当前映射将被渲染器排除的行：' + excluded + ' / ' + data.rows.length +
          '（必填列缺失或数值列非数值）。');
      } else {
        lines.push('必填映射槽未填满，无法计算被排除行。');
      }
      Object.keys(mapping).forEach(function (slot) {
        var col = mapping[slot];
        if (!col) return;
        var miss = columnMissing(data, col);
        if (miss) lines.push('列「' + col + '」（' + slot + '）：缺失 ' + miss + ' 行。');
      });
      if (mapping.error) {
        lines.push('误差列「' + mapping.error +
          '」：误差值本身不声明统计量类型；SD/SEM/95CI 需在「论证」页科学合同中申报，向导不猜测。');
      } else {
        lines.push('误差线两条路径：① 同一分类的重复观测在「论证」页申报统计量类型（SD/SEM/95CI）后由内核按原始重复计算；' +
          '② 用户提供误差列经科学合同 uncertainty_column 声明。向导不依据列名猜测统计量。');
      }
      lines.push('画布：' + canvasSummaryText(currentCanvasChoice()) + '。' +
        (lastBuild && lastBuild.effectiveCanvas && currentCanvasChoice().mode === 'keep' &&
          tpl && tpl.journal_default
          ? '（模板建议 ' + tpl.journal_default + '，未选择不生效）' : ''));
      lines.push('预览不写入正式文档、历史与工程；「创建图表」才提交一笔可撤销历史。');
      lines.forEach(function (t, i) {
        mappingSummary.appendChild(h('div', {
          style: 'margin:2px 0;' + (i === lines.length - 1 ? 'color:#666;' : ''),
          text: t
        }));
      });
    }

    // ---- 映射槽下拉 ----
    function buildMappingControls() {
      var wrap = h('div', { 'data-wizard-mapping': '1', style: 'margin:6px 0 10px;' });
      var slots = P.mappingSlots(draft.templateId);
      var tpl = currentTemplate();
      var sem = tpl ? semanticsFor(tpl.chart_type) : null;
      var requiredSlots = sem ? sem.required : [];
      var defaults = inferredMapping(draft.templateId);
      selectEls = {};
      if (!slots.length) {
        wrap.appendChild(h('div', {
          style: 'font-size:12px;color:#666;',
          text: '该模板没有声明字段映射槽。'
        }));
        return wrap;
      }
      wrap.appendChild(h('div', {
        style: 'font-size:12px;font-weight:bold;margin-bottom:4px;',
        text: '字段映射（自动推断作为默认值，可修改；* 为渲染必填槽）：'
      }));
      slots.forEach(function (slotDef) {
        var needed = requiredSlots.indexOf(slotDef.slot) >= 0;
        var select = h('select', {
          'data-wizard-slot': slotDef.slot,
          'aria-label': '映射槽 ' + slotDef.slot,
          style: 'max-width:220px;padding:3px;margin:2px 6px 2px 0;'
        });
        var none = h('option', { value: '', text: '（不映射）' });
        select.appendChild(none);
        data.columns.forEach(function (name) {
          select.appendChild(h('option', { value: name, text: name }));
        });
        var preset = defaults[slotDef.slot];
        select.value = preset != null ? String(preset) : '';
        select.addEventListener('change', function () {
          setMapping(slotDef.slot, select.value || null);
        });
        selectEls[slotDef.slot] = select;
        wrap.appendChild(h('label', { style: 'display:inline-flex;align-items:center;gap:4px;margin-right:10px;' }, [
          h('span', {
            style: 'font-size:12px;' + (needed ? 'font-weight:bold;' : 'color:#555;'),
            text: (needed ? '* ' : '') + slotDef.slot + (slotDef.description ? '（' + slotDef.description + '）' : '')
          }),
          select
        ]));
      });
      return wrap;
    }

    function setMapping(slot, column) {
      var base = currentMapping();
      base[slot] = column || null;
      draft.mapping = base;
      refreshPreview();
    }

    // ---- 画布选择 ----
    function buildCanvasControls() {
      var tpl = currentTemplate();
      var preset = tpl && tpl.journal_default ? P.journal(tpl.journal_default) : null;
      var wrap = h('div', {
        'data-wizard-canvas': '1',
        style: 'margin:6px 0 10px;font-size:12px;display:flex;flex-direction:column;gap:3px;'
      });
      wrap.appendChild(h('div', { style: 'font-weight:bold;', text: '画布：' }));
      var cur = opts.currentCanvas || { width_mm: 120, height_mm: 90, dpi: 300 };
      canvasKeepRadio = h('input', { type: 'radio', name: 'wizard-canvas', checked: true });
      canvasKeepRadio.addEventListener('change', function () {
        if (canvasKeepRadio.checked) { draft.canvasChoice = { mode: 'keep' }; refreshPreview(); }
      });
      wrap.appendChild(h('label', { style: 'display:flex;gap:6px;align-items:center;' }, [
        canvasKeepRadio,
        document.createTextNode('保持当前画布 ' + Math.round(cur.width_mm) + ' × ' + Math.round(cur.height_mm) + ' mm（推荐：模板不擅自改尺寸）')
      ]));
      if (preset) {
        canvasPresetRadio = h('input', { type: 'radio', name: 'wizard-canvas' });
        canvasPresetRadio.addEventListener('change', function () {
          if (canvasPresetRadio.checked) { draft.canvasChoice = { mode: 'explicit_preset' }; refreshPreview(); }
        });
        wrap.appendChild(h('label', { style: 'display:flex;gap:6px;align-items:center;' }, [
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
        style: 'width:64px;padding:2px;', 'aria-label': '自定义宽度 mm'
      });
      heightInput = h('input', {
        type: 'number', min: '10', max: '2000', step: '0.5',
        value: String(Math.round(cur.height_mm)),
        style: 'width:64px;padding:2px;', 'aria-label': '自定义高度 mm'
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
      wrap.appendChild(h('label', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;' }, [
        canvasSizeRadio,
        document.createTextNode('自定义'),
        widthInput, document.createTextNode('×'), heightInput, document.createTextNode('mm')
      ]));
      return wrap;
    }

    // ---- 数据预览 ----
    function buildDataPreview() {
      var box = h('div', {
        'data-wizard-data': '1',
        style: 'max-height:150px;overflow:auto;margin:6px 0;border:1px solid #eee;border-radius:4px;'
      });
      var head = h('tr');
      data.columns.forEach(function (name) {
        var miss = columnMissing(data, name);
        head.appendChild(h('th', {
          style: 'border:1px solid #ddd;padding:2px 5px;background:#f3f5f7;font-size:11px;text-align:left;',
          text: name + (miss ? ' ⚠' + miss : '')
        }));
      });
      var table = h('table', { style: 'border-collapse:collapse;font-size:11px;' }, [
        h('thead', {}, [head])
      ]);
      var tbody = h('tbody');
      data.rows.slice(0, 6).forEach(function (row) {
        var tr = h('tr');
        data.columns.forEach(function (_, i) {
          var v = row && row[i];
          tr.appendChild(h('td', {
            style: 'border:1px solid #eee;padding:2px 5px;max-width:160px;overflow-wrap:anywhere;',
            text: v === null || v === undefined || v === '' ? '—' : String(v)
          }));
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      box.appendChild(table);
      if (data.rows.length > 6) {
        box.appendChild(h('div', {
          style: 'font-size:11px;color:#666;padding:2px 5px;',
          text: '… 共 ' + data.rows.length + ' 行（前 6 行）'
        }));
      }
      return box;
    }

    // ---- 模板选择 ----
    function buildTemplateList(onPicked) {
      var list = h('div', {
        'data-wizard-templates': '1',
        style: 'display:flex;flex-direction:column;gap:4px;margin:4px 0;'
      });
      templateRadios = [];
      recommendations.forEach(function (rec, i) {
        var tpl = P.template(rec.template_id);
        var radio = h('input', {
          type: 'radio', name: 'wizard-template',
          checked: i === 0, 'aria-label': '模板 ' + (tpl ? tpl.name : rec.template_id)
        });
        radio.addEventListener('change', function () {
          if (radio.checked) onPicked(rec.template_id);
        });
        templateRadios.push({ radio: radio, id: rec.template_id });
        list.appendChild(h('label', {
          style: 'display:flex;gap:8px;align-items:flex-start;padding:4px 6px;border:1px solid #ddd;border-radius:5px;cursor:pointer;'
        }, [
          radio,
          h('div', {}, [
            h('div', {
              style: 'font-weight:bold;font-size:12px;',
              text: (tpl ? tpl.name : rec.template_id) + '（匹配度 ' + rec.score + '）'
            }),
            h('div', {
              style: 'font-size:11px;color:#666;',
              text: (rec.reasons || []).join('；') || '—'
            })
          ])
        ]));
      });
      return list;
    }

    // ---- 组装与切换 ----
    var body = h('div', { 'data-wizard-root': '1', style: 'min-width:460px;max-width:680px;' });
    var templateListEl = null;
    var mappingWrapHost = h('div', {});
    var canvasHost = h('div', {});
    mappingSummary = h('div', {
      'data-wizard-summary': '1',
      style: 'font-size:12px;color:#333;margin:6px 0;white-space:normal;'
    });
    previewBox = h('div', {
      'data-wizard-preview': '1',
      style: 'border:1px solid #ddd;border-radius:5px;background:#fafafa;margin:6px 0;max-height:260px;overflow:auto;text-align:center;'
    });
    titleInput = h('input', {
      type: 'text', value: draft.title,
      style: 'width:100%;box-sizing:border-box;padding:4px;border:1px solid #bbb;border-radius:4px;',
      'aria-label': '图表标题'
    });
    titleInput.addEventListener('change', function () {
      draft.title = titleInput.value.trim();
      refreshPreview();
    });

    function rebuildForTemplate() {
      draft.mapping = null; // 换模板回到该模板的推断默认
      mappingWrapHost.textContent = '';
      mappingWrapHost.appendChild(buildMappingControls());
      canvasHost.textContent = '';
      canvasHost.appendChild(buildCanvasControls());
      refreshPreview();
    }

    templateListEl = buildTemplateList(function (id) {
      draft.templateId = id;
      rebuildForTemplate();
    });

    body.appendChild(h('div', {
      style: 'font-size:12px;font-weight:bold;margin-bottom:2px;',
      text: '① 选择模板'
    }));
    body.appendChild(templateListEl);
    body.appendChild(h('div', { style: 'font-size:12px;font-weight:bold;', text: '② 数据预览（⚠n=缺失行数）' }));
    body.appendChild(buildDataPreview());
    body.appendChild(h('div', { style: 'font-size:12px;font-weight:bold;', text: '③ 字段映射与统计含义' }));
    body.appendChild(mappingWrapHost);
    body.appendChild(h('div', { style: 'font-size:12px;font-weight:bold;', text: '④ 画布' }));
    body.appendChild(canvasHost);
    body.appendChild(h('div', { style: 'font-size:12px;font-weight:bold;', text: '⑤ 图表标题（可留空）' }));
    body.appendChild(titleInput);
    body.appendChild(h('div', { style: 'font-size:12px;font-weight:bold;margin-top:4px;', text: '⑥ 预览与确认' }));
    body.appendChild(mappingSummary);
    body.appendChild(previewBox);

    rebuildForTemplate();

    var createAction = {
      label: '创建图表',
      primary: true,
      'data-wizard-action': 'create',
      onClick: function () {
        return handle.create();
      }
    };
    var cancelAction = { label: '取消', 'data-wizard-action': 'cancel' };
    var actions = [cancelAction, createAction];

    var modal = null;
    try {
      if (global.Ui && typeof global.Ui.modal === 'function') {
        modal = global.Ui.modal({
          title: '导入数据向导：' + opts.filename,
          body: body,
          actions: actions
        });
      }
    } catch (e) { modal = null; }
    if (!modal) {
      // 最小回退：挂到 body（headless 测试里 document.body 即容器）
      document.body.appendChild(body);
    }

    var createSeq = 0;
    var handle = {
      modal: modal,
      body: body,
      actions: actions,
      draft: function () {
        return {
          templateId: draft.templateId,
          mapping: JSON.parse(JSON.stringify(currentMapping())),
          canvasChoice: JSON.parse(JSON.stringify(currentCanvasChoice())),
          title: draft.title
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
        var missingSlots = (sem ? sem.required : []).filter(function (slot) {
          return !d.mapping[slot];
        });
        if (missingSlots.length) {
          toast('必填映射槽未填：' + missingSlots.join('、') + '；请先在字段映射中选择列', 'error');
          createSeq = 0;
          return Promise.resolve(false);
        }
        return Promise.resolve().then(function () {
          return opts.onCreate(d.templateId, d.mapping, d.canvasChoice, d.title);
        }).then(function (ok) {
          if (ok === false) {
            createSeq = 0; // 允许修正后重试
            return false;
          }
          handle.closeModal();
          return true;
        });
      },
      closeModal: function () {
        try {
          if (modal && typeof modal.close === 'function') modal.close();
          else if (body.parentNode) body.parentNode.removeChild(body);
        } catch (e) { /* already closed */ }
      }
    };
    return handle;
  }

  global.DataWizard = { open: open };
})(typeof globalThis !== 'undefined' ? globalThis : this);
