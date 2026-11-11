/* Excel workbook import through the local viewer API. Preview never mutates App.doc. */
(function (global) {
  'use strict';

  var MAX_FILE_BYTES = 20 * 1024 * 1024;
  var PREVIEW_ROW_LIMIT = 8;
  var previewSequence = 0;

  function isObj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined) return;
      if (key === 'text') el.textContent = value;
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
        el.addEventListener(key.slice(2), value);
      } else el.setAttribute(key, value);
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return el;
  }

  function toast(text, opts) {
    if (global.Ui && typeof global.Ui.toast === 'function') global.Ui.toast(text, opts);
    else if (global.App && typeof global.App.status === 'function') global.App.status(text);
  }

  function error(err) {
    var text = err && err.message ? err.message : String(err);
    if (global.App && typeof global.App.error === 'function') global.App.error(text);
    toast(text, { type: 'error', ms: 7000 });
  }

  function requireApp() {
    if (!global.App || !isObj(global.App.doc) || typeof global.App.commit !== 'function') {
      throw new Error('Excel 导入需要已初始化的 App.doc / App.commit');
    }
    return global.App;
  }

  function extOf(name) {
    var match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return match ? match[1].toLowerCase() : '';
  }

  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var bytes = new Uint8Array(reader.result);
          var binary = '';
          for (var offset = 0; offset < bytes.length; offset += 32768) {
            binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768));
          }
          resolve(btoa(binary));
        } catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(new Error('读取工作簿失败：' + file.name)); };
      reader.readAsArrayBuffer(file);
    });
  }

  function postPreview(fileName, contentBase64, sheet, headerRow) {
    if (typeof global.fetch !== 'function') {
      return Promise.reject(new Error('Excel 导入需要 viewer.py 本地 HTTP 服务，不能使用 file:// 直开'));
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 30000) : null;
    var options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_name: fileName,
        content_base64: contentBase64,
        sheet: sheet === undefined ? null : sheet,
        header_row: headerRow === undefined ? null : headerRow
      })
    };
    if (controller) options.signal = controller.signal;
    return global.fetch('/api/import-spreadsheet', options).then(function (response) {
      return response.json().catch(function () {
        throw new Error('Excel 导入服务返回了非 JSON 响应（HTTP ' + response.status + '）');
      }).then(function (payload) {
        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error(payload && payload.error ? payload.error : 'Excel 导入失败（HTTP ' + response.status + '）');
        }
        return payload;
      });
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  function applicable(rec) {
    if (!rec || rec.can_apply === false || !global.FigPresets ||
        typeof global.FigPresets.validateTemplateCapability !== 'function') return false;
    try { return global.FigPresets.validateTemplateCapability(rec.template_id).ok === true; }
    catch (err) { return false; }
  }

  function previewTable(data) {
    var table = h('table', {
      style: 'border-collapse:collapse;width:100%;font-size:11px;white-space:nowrap'
    });
    var head = h('tr');
    (data.columns || []).forEach(function (column) {
      head.appendChild(h('th', {
        text: column,
        style: 'border:1px solid #ddd;padding:3px 5px;text-align:left;background:#f5f5f5'
      }));
    });
    table.appendChild(h('thead', {}, [head]));
    var body = h('tbody');
    (data.rows || []).slice(0, PREVIEW_ROW_LIMIT).forEach(function (row) {
      var tr = h('tr');
      data.columns.forEach(function (_column, index) {
        tr.appendChild(h('td', {
          text: row[index] === null || row[index] === undefined ? '' : String(row[index]),
          style: 'border:1px solid #ddd;padding:3px 5px'
        }));
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    return h('div', { style: 'overflow:auto;max-height:220px;margin-top:8px' }, [table]);
  }

  function round2(value) { return Math.round(value * 100) / 100; }

  function fitBuiltIntoCanvas(built, canvas) {
    if (!built || !Array.isArray(built.elements) || !built.elements.length) return;
    var margin = 4;
    var availW = Math.max(1, (Number(canvas && canvas.width_mm) || 120) - margin * 2);
    var availH = Math.max(1, (Number(canvas && canvas.height_mm) || 90) - margin * 2);
    var box = null;
    built.elements.forEach(function (el) {
      if (!isObj(el) || !isObj(el.transform) || (isObj(el.style) && el.style.panelRelative === true)) return;
      var t = el.transform;
      var x0 = Number(t.x) || 0, y0 = Number(t.y) || 0;
      var next = { x: x0, y: y0, x1: x0 + (Number(t.w) || 0), y1: y0 + (Number(t.h) || 0) };
      if (!box) box = next;
      else {
        box.x = Math.min(box.x, next.x);
        box.y = Math.min(box.y, next.y);
        box.x1 = Math.max(box.x1, next.x1);
        box.y1 = Math.max(box.y1, next.y1);
      }
    });
    if (!box || !(box.x1 > box.x) || !(box.y1 > box.y)) return;
    var scale = Math.min(1, availW / (box.x1 - box.x), availH / (box.y1 - box.y));
    if (!isFinite(scale) || scale > 0.999) return;
    built.elements.forEach(function (el) {
      if (!isObj(el) || !isObj(el.transform)) return;
      if (isObj(el.style) && el.style.panelRelative === true) return;
      var t = el.transform;
      t.x = margin + ((Number(t.x) || 0) - box.x) * scale;
      t.y = margin + ((Number(t.y) || 0) - box.y) * scale;
      t.w = (Number(t.w) || 0) * scale;
      t.h = (Number(t.h) || 0) * scale;
      var style = el.style;
      if (isObj(style)) {
        if (typeof style.fontSizePt === 'number') style.fontSizePt = round2(style.fontSizePt * scale);
        if (typeof style.strokeWidthPt === 'number') style.strokeWidthPt = round2(style.strokeWidthPt * scale);
      }
      if (isObj(el.panelLayout) && isObj(el.panelLayout.labelStyle) &&
          typeof el.panelLayout.labelStyle.fontSizePt === 'number') {
        el.panelLayout.labelStyle.fontSizePt = round2(el.panelLayout.labelStyle.fontSizePt * scale);
      }
    });
  }

  function orderedElements(elements) {
    var remaining = elements.slice(), ordered = [], placed = {};
    while (remaining.length) {
      var progressed = false;
      for (var index = 0; index < remaining.length;) {
        var el = remaining[index];
        if (el.parent_id && !placed[el.parent_id]) { index++; continue; }
        ordered.push(el);
        if (el.id) placed[el.id] = true;
        remaining.splice(index, 1);
        progressed = true;
      }
      if (!progressed) return ordered.concat(remaining);
    }
    return ordered;
  }

  function showWorkbook(fileName, contentBase64, initialPreview, cb) {
    var app = requireApp();
    var state = { preview: initialPreview, busy: false, committing: null };
    var sheetSelect = h('select', {
      'data-spreadsheet-sheet': '1',
      style: 'width:100%;padding:5px;margin:4px 0 10px'
    });
    (initialPreview.sheets || []).forEach(function (sheet) {
      var option = h('option', { value: sheet, text: sheet });
      if (sheet === initialPreview.sheet_name) option.selected = true;
      sheetSelect.appendChild(option);
    });
    var headerInput = h('input', {
      type: 'number', min: '1', max: '10000', step: '1',
      value: String(initialPreview.header_row || 1),
      'data-spreadsheet-header': '1',
      style: 'width:100%;box-sizing:border-box;padding:5px;margin:4px 0 10px'
    });
    var status = h('div', {
      'data-spreadsheet-status': '1',
      style: 'font-size:12px;color:#666;min-height:18px'
    });
    var notices = h('div', { 'data-spreadsheet-notices': '1' });
    var tableHost = h('div', { 'data-spreadsheet-preview': '1' });
    var recsHost = h('div', {
      'data-spreadsheet-recommendations': '1',
      style: 'display:flex;flex-direction:column;gap:5px;margin:8px 0'
    });
    var titleInput = h('input', {
      type: 'text', value: fileName.replace(/\.[^.]+$/, ''),
      style: 'width:100%;box-sizing:border-box;padding:5px;margin-top:4px'
    });

    function selectedHeader() {
      var value = Number(headerInput.value);
      if (!Number.isInteger(value) || value < 1 || value > 10000) {
        throw new Error('表头行必须是 1 到 10000 的整数');
      }
      return value;
    }

    function renderPreview(payload) {
      tableHost.innerHTML = '';
      tableHost.appendChild(previewTable(payload.data));
      notices.innerHTML = '';
      (payload.notices || []).forEach(function (notice) {
        notices.appendChild(h('div', {
          text: notice.message || String(notice),
          style: 'font-size:12px;color:#8a6d3b;margin:4px 0'
        }));
      });
      recsHost.innerHTML = '';
      var applicableRecs = (payload.recommended || []).filter(applicable);
      payload._applicableRecs = applicableRecs;
      if (!applicableRecs.length) {
        recsHost.appendChild(h('div', { text: '没有可应用的模板', style: 'color:#a00;font-size:12px' }));
      }
      applicableRecs.forEach(function (rec, index) {
        var radio = h('input', {
          type: 'radio', name: 'spreadsheet-template-choice', value: rec.template_id
        });
        radio.checked = index === 0;
        var template = global.FigPresets.template(rec.template_id);
        recsHost.appendChild(h('label', {
          style: 'display:flex;gap:7px;align-items:flex-start;border:1px solid #ddd;padding:5px;font-size:12px'
        }, [radio, h('span', {
          text: (template ? template.name : rec.template_id) + '（匹配度 ' + rec.score + '）' +
            ((rec.reasons || []).length ? '：' + rec.reasons.join('；') : '')
        })]));
      });
      status.textContent = '工作表「' + payload.sheet_name + '」，表头第 ' + payload.header_row +
        ' 行；' + payload.data.rows.length + ' 行数据（预览前 ' +
        Math.min(PREVIEW_ROW_LIMIT, payload.data.rows.length) + ' 行）';
    }

    function reload() {
      var sequence = ++previewSequence;
      var sheet = sheetSelect.value;
      var header;
      try { header = selectedHeader(); }
      catch (err) { error(err); return Promise.resolve(false); }
      state.busy = true;
      state.preview = null;
      status.textContent = '正在重新读取所选工作表…';
      tableHost.innerHTML = '';
      recsHost.innerHTML = '';
      return postPreview(fileName, contentBase64, sheet, header).then(function (payload) {
        if (sequence !== previewSequence) return false;
        state.preview = payload;
        renderPreview(payload);
        return true;
      }).catch(function (err) {
        if (sequence === previewSequence) {
          status.textContent = '重读失败，未改变当前图；请修正工作表/表头选择';
          error(err);
        }
        return false;
      }).finally(function () {
        if (sequence === previewSequence) state.busy = false;
      });
    }

    sheetSelect.addEventListener('change', reload);
    headerInput.addEventListener('change', reload);
    renderPreview(initialPreview);

    function commit() {
      if (state.committing) return state.committing;
      if (state.busy || !state.preview) {
        error(new Error('请等待当前工作表预览完成'));
        return false;
      }
      var picked = null;
      recsHost.querySelectorAll('input[type="radio"]').forEach(function (radio) {
        if (radio.checked) picked = radio.value;
      });
      if (!picked || !applicable({ template_id: picked, can_apply: true })) {
        error(new Error('请选择可应用的模板'));
        return false;
      }
      var payload = state.preview;
      var built;
      try {
        built = global.FigPresets.templateFromStats(picked, payload.data, {
          journal_id: null, palette_id: null, title: titleInput.value.trim() || undefined
        });
        if (!built || !Array.isArray(built.elements) || !built.elements.length) {
          throw new Error('模板未生成任何元素');
        }
      } catch (err) {
        error(err);
        return false;
      }
      var ops = [];
      var template = global.FigPresets.template(picked);
      var canvas = app.doc.canvas || { width_mm: 120, height_mm: 90 };
      if (!(app.doc.elements || []).length && template && template.journal_default && !canvas.journal_preset_id) {
        try {
          var applied = global.FigPresets.applyCanvas(template.journal_default, app.doc);
          if (applied && applied.op) {
            ops.push(applied.op);
            canvas = applied.doc.canvas;
          }
        } catch (err) { /* Keep this canvas and fit the generated chart instead. */ }
      }
      fitBuiltIntoCanvas(built, canvas);
      orderedElements(built.elements).forEach(function (element) {
        ops.push({ op: 'add_element', element: element });
      });
      var sha = payload.source_info && payload.source_info.sha256;
      ops.push({
        op: 'note',
        note: '导入工作簿 ' + fileName + '，工作表 ' + payload.sheet_name +
          '，表头第 ' + payload.header_row + ' 行，模板 ' + picked +
          (sha ? '，sha256=' + sha : '') +
          ((built.warnings || []).length ? '；告警：' + built.warnings.join('；') : '')
      });
      state.committing = Promise.resolve().then(function () {
        return app.commit(ops, { label: '导入 Excel：' + fileName, source: 'import' });
      }).then(function (result) {
        if (!result || !result.applied) {
          state.committing = null;
          error(new Error('Excel 导入未通过文档校验，未写入任何图或历史'));
          return false;
        }
        var ids = built.elements.map(function (element) { return element.id; });
        if (typeof app.select === 'function') app.select(ids);
        toast('已导入 ' + fileName + ' / ' + payload.sheet_name, { type: 'success' });
        if (cb) cb(null, {
          template_id: picked, element_ids: ids,
          sheet_name: payload.sheet_name, header_row: payload.header_row
        });
        return true;
      }).catch(function (err) {
        state.committing = null;
        error(err);
        if (cb) cb(err);
        return false;
      });
      return state.committing;
    }

    var body = h('div', {}, [
      h('label', { text: '工作表' }), sheetSelect,
      h('label', { text: '表头所在行（从 1 开始）' }), headerInput,
      status, notices, tableHost,
      h('div', { text: '推荐模板（已排除不可真实生成项）', style: 'font-size:12px;margin-top:8px' }),
      recsHost,
      h('label', { text: '图表标题（可留空）' }), titleInput
    ]);
    global.Ui.modal({
      title: '导入 Excel：' + fileName,
      body: body,
      actions: [{ label: '取消' }, { label: '生成图表', primary: true, onClick: commit }]
    });
  }

  function openBase64(fileName, contentBase64, cb) {
    requireApp();
    return postPreview(fileName, contentBase64, null, null).then(function (payload) {
      showWorkbook(fileName, contentBase64, payload, cb);
      return payload;
    }).catch(function (err) {
      error(err);
      if (cb) cb(err);
      throw err;
    });
  }

  function openData(cb) {
    requireApp();
    var input = h('input', {
      type: 'file',
      accept: '.xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.ms-excel',
      'data-spreadsheet-file': '1', style: 'display:none'
    });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (input.parentNode) input.parentNode.removeChild(input);
      if (!file) return;
      if (['xlsx', 'xlsm', 'xls'].indexOf(extOf(file.name)) < 0) {
        var extError = new Error('请选择 .xlsx / .xlsm / .xls 工作簿');
        error(extError);
        if (cb) cb(extError);
        return;
      }
      if (!(file.size > 0) || file.size > MAX_FILE_BYTES) {
        var sizeError = new Error('工作簿必须非空且不得超过 20 MiB');
        error(sizeError);
        if (cb) cb(sizeError);
        return;
      }
      readBase64(file).then(function (contentBase64) {
        openBase64(file.name, contentBase64, cb).catch(function () {});
      }, function (err) {
        error(err);
        if (cb) cb(err);
      });
    });
    document.body.appendChild(input);
    input.click();
  }

  function mount(panel) {
    if (!panel || (panel.querySelector && panel.querySelector('[data-spreadsheet-mount="1"]'))) return;
    var button = h('button', {
      text: '导入 Excel', title: '导入 XLSX / XLSM / XLS，选择工作表与表头行',
      'data-spreadsheet-mount': '1',
      style: 'margin:4px 4px 4px 0;padding:5px 12px;border:1px solid #bbb;' +
        'border-radius:4px;background:#fff;cursor:pointer;font-size:13px'
    });
    button.addEventListener('click', function () { openData(); });
    panel.appendChild(button);
  }

  var api = {
    mount: mount,
    openData: openData,
    preview: postPreview,
    _openBase64: openBase64
  };
  global.SpreadsheetImport = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
