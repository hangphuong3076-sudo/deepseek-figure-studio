/*
 * import.js — Import
 *
 * Data and image import for the v1 web app (see v1-web-app/APP-API.md):
 *   Import.mount(panelEl)             panel buttons (data / image / svg)
 *   Import.openData(cb)               selected bytes -> actual SHA-256 (unverified origin)
 *                                     -> same CSV/JSON/TSV parser/stats/template flow;
 *                                     xlsx/xlsm/xls reuse the service hash for those bytes
 *                                     -> sheet/header preview -> templateFromStats
 *                                     -> App.commit(add_element... + source_info/note,
 *                                     preserving value fingerprints and import provenance)
 *   Import.openImage(cb)              image -> data URL -> type=image element
 *                                     (optional asBackground placement)
 *   Import.openSvg(cb)                svg/svgz -> choice dialog -> editable
 *                                     per-element import (SvgImport, dynamic
 *                                     app/svg-import.js) or sanitized SVG -> PNG
 *                                     static image (no vector editing capability)
 *   Import.pasteImageFromClipboard()  document-level paste listener
 *
 * All document mutations go through App.commit (ops carry source:"import").
 * UI dialogs use Ui.modal/Ui.toast when available and fall back to minimal
 * local DOM otherwise, so this module stays testable without the full shell.
 */
(function (global) {
  'use strict';

  var pasteBound = false;
  var pasteCb = null; // latest callback passed to pasteImageFromClipboard

  // ------------------------------------------------------------------
  // small helpers
  // ------------------------------------------------------------------

  function fail(msg) {
    throw new Error('Import：' + msg);
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Minimal element builder (mirrors Ui.h; kept local so dialogs work even
  // before ui.js registers itself).
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          el.addEventListener(k.slice(2), v);
        } else el.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function toast(text, opts) {
    try {
      if (global.Ui && typeof global.Ui.toast === 'function') {
        global.Ui.toast(text, opts);
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      if (global.App && typeof global.App.status === 'function') {
        global.App.status(text);
        return;
      }
    } catch (e) { /* fall through */ }
    // eslint-disable-next-line no-console
    if (global.console) console.log('[Import] ' + text);
  }

  function toastError(text) {
    toast(text, { type: 'error' });
    try {
      if (global.App && typeof global.App.error === 'function') global.App.error(text);
    } catch (e) { /* ignore */ }
  }

  function requireApp() {
    if (!global.App || !isObj(global.App.doc) || typeof global.App.commit !== 'function') {
      fail('App 尚未初始化（缺少 App.doc / App.commit），无法导入');
    }
    return global.App;
  }

  // Modal wrapper: Ui.modal first, minimal fallback overlay second.
  function openModal(opts) {
    try {
      if (global.Ui && typeof global.Ui.modal === 'function') {
        var m = global.Ui.modal(opts);
        if (m && typeof m.close === 'function') return m;
      }
    } catch (e) { /* fall through */ }
    return fallbackModal(opts);
  }

  function fallbackModal(opts) {
    var closed = false;
    var overlay = h('div', {
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;' +
        'display:flex;align-items:center;justify-content:center'
    });
    var actionRow = h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' });
    var box = h('div', {
      style: 'background:#fff;color:#222;border-radius:8px;min-width:320px;max-width:520px;' +
        'max-height:70vh;overflow:auto;padding:16px;box-shadow:0 8px 30px rgba(0,0,0,0.3)'
    }, [
      h('div', { style: 'font-weight:bold;margin-bottom:10px', text: opts.title || '' }),
      h('div', { style: 'margin-bottom:12px' },
        [typeof opts.body === 'string' ? h('div', { html: opts.body }) : opts.body]),
      actionRow
    ]);
    overlay.appendChild(box);
    function close() {
      if (closed) return;
      closed = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    (opts.actions || []).forEach(function (a) {
      var b = h('button', {
        text: a.label,
        style: 'padding:6px 14px;border-radius:4px;border:1px solid #999;cursor:pointer;' +
          (a.primary ? 'background:#1f6feb;color:#fff;' : 'background:#f5f5f5;color:#222;')
      });
      b.addEventListener('click', function () {
        if (typeof a.onClick !== 'function') { close(); return; }
        var result = a.onClick();
        if (result && typeof result.then === 'function') {
          // Mirror Ui.modal: close only when the async action succeeds.
          result.then(function (v) { if (v !== false) close(); });
          return;
        }
        if (result === false) return; // keep the dialog open
        close();
      });
      actionRow.appendChild(b);
    });
    (document.getElementById('modal-root') || document.body).appendChild(overlay);
    return { close: close };
  }

  function fileInput(accept, onFile) {
    var input = h('input', { type: 'file', accept: accept, style: 'display:none' });
    input.addEventListener('change', function () {
      // The node must stay attached until the dialog closes, so removal
      // happens here, not right after click().
      if (input.parentNode) input.parentNode.removeChild(input);
      var f = input.files && input.files[0];
      if (f && onFile) onFile(f);
      input.value = ''; // allow re-selecting the same file
    });
    document.body.appendChild(input);
    return input;
  }

  function readFile(file, as) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        resolve(as === 'arrayBuffer' ? r.result : String(r.result));
      };
      r.onerror = function () { reject(new Error('读取文件失败：' + file.name)); };
      if (as === 'dataURL') r.readAsDataURL(file);
      else if (as === 'arrayBuffer') r.readAsArrayBuffer(file);
      else r.readAsText(file);
    });
  }

  function readArrayBuffer(file) {
    if (file && typeof file.arrayBuffer === 'function') {
      return Promise.resolve().then(function () { return file.arrayBuffer(); });
    }
    return readFile(file, 'arrayBuffer');
  }

  function extOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function baseName(name) {
    return String(name || '数据').replace(/\.[A-Za-z0-9]+$/, '');
  }

  function isSpreadsheetFile(file) {
    return ['xlsx', 'xlsm', 'xls'].indexOf(extOf(file && file.name)) >= 0;
  }

  function arrayBufferToBase64(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var binary = '';
    var chunkSize = 0x8000;
    for (var start = 0; start < bytes.length; start += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(start, start + chunkSize));
    }
    return btoa(binary);
  }

  function spreadsheetServiceError(detail) {
    return new Error('Excel 导入需要正在运行的图工作台服务' +
      '（POST /api/import-spreadsheet）；请通过该服务工作台打开页面。' +
      (detail ? '服务错误：' + detail : ''));
  }

  function postSpreadsheet(payload) {
    if (typeof global.fetch !== 'function') {
      return Promise.reject(spreadsheetServiceError('当前环境没有 fetch'));
    }
    var request = {
      data_base64: payload.data_base64,
      file_name: payload.file_name,
      sheet: payload.sheet,
      header_row: payload.header_row
    };
    Object.keys(request).forEach(function (key) {
      if (request[key] === undefined || request[key] === null) delete request[key];
    });
    var response;
    try {
      response = global.fetch('/api/import-spreadsheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      });
    } catch (err) {
      return Promise.reject(spreadsheetServiceError(err.message));
    }
    return Promise.resolve(response).then(function (res) {
      return res.text().then(function (text) {
        var body;
        try {
          body = JSON.parse(text);
        } catch (err) {
          throw spreadsheetServiceError('HTTP ' + res.status + ' 返回的不是有效 JSON');
        }
        if (!res.ok || !body || body.ok === false) {
          throw new Error('Excel 解析失败：' +
            ((body && body.error) || ('HTTP ' + res.status + '，未返回错误详情')));
        }
        if (!body.data || !Array.isArray(body.data.columns) || !Array.isArray(body.data.rows)) {
          throw spreadsheetServiceError('服务响应缺少 data:{columns,rows}');
        }
        return body;
      });
    }, function (err) {
      throw spreadsheetServiceError(err && err.message);
    });
  }

  // ------------------------------------------------------------------
  // data import
  // ------------------------------------------------------------------

  function utf8Bytes(text) {
    if (typeof global.TextEncoder === 'function') return new global.TextEncoder().encode(String(text));
    var encoded = unescape(encodeURIComponent(String(text)));
    var bytes = new Uint8Array(encoded.length);
    for (var index = 0; index < encoded.length; index++) bytes[index] = encoded.charCodeAt(index);
    return bytes;
  }

  function sha256Bytes(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var bitLength = bytes.length * 8;
    var padded = new Uint8Array((Math.floor((bytes.length + 8) / 64) + 1) * 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    var view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296), false);
    view.setUint32(padded.length - 4, bitLength >>> 0, false);
    var state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var words = new Uint32Array(64);
    for (var offset = 0; offset < padded.length; offset += 64) {
      for (var index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
      for (index = 16; index < 64; index++) {
        var x = words[index - 15], y = words[index - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      var a = state[0], b = state[1], c = state[2], d = state[3];
      var e = state[4], f = state[5], g = state[6], hh = state[7];
      for (index = 0; index < 64; index++) {
        var upper = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var choice = (e & f) ^ (~e & g);
        var temp1 = (hh + upper + choice + constants[index] + words[index]) >>> 0;
        var lower = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var majority = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (lower + majority) >>> 0;
        hh = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      state = [(state[0] + a) >>> 0, (state[1] + b) >>> 0, (state[2] + c) >>> 0,
        (state[3] + d) >>> 0, (state[4] + e) >>> 0, (state[5] + f) >>> 0,
        (state[6] + g) >>> 0, (state[7] + hh) >>> 0];
    }
    return state.map(function (word) { return word.toString(16).padStart(8, '0'); }).join('');
  }

  function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (isObj(value)) {
      var result = {};
      Object.keys(value).sort().forEach(function (key) { result[key] = canonicalValue(value[key]); });
      return result;
    }
    return value;
  }

  function tableValueInfo(data) {
    var values = { columns: data.columns, rows: data.rows };
    return {
      algorithm: 'canonical_columns_rows_json_sha256',
      sha256: sha256Bytes(utf8Bytes(JSON.stringify(canonicalValue(values)))),
      columns: data.columns.slice(),
      row_count: data.rows.length
    };
  }

  function sourceInfoForTable(data, filename, rawBytes, existing, rawText) {
    var source = existing ? JSON.parse(JSON.stringify(existing)) : {};
    var bytes = rawBytes ? (rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes)) : null;
    var kind = extOf(filename) === 'json' ? 'json' : (source.format || extOf(filename) || 'csv');
    if (bytes) {
      source.kind = kind;
      source.format = kind;
      source.locator = String(filename || 'provided_' + kind + '_text');
      source.locator_kind = 'provided_file_name_not_path';
      source.file_name = String(filename || 'provided_' + kind + '_text');
      source.input_mode = 'selected_local_file_bytes';
      source.sha256 = sha256Bytes(bytes);
      source.bytes = bytes.byteLength;
    } else {
      source.kind = source.kind || kind;
      source.locator = source.locator || String(filename || ('provided_' + kind + '_text'));
      source.locator_kind = source.locator_kind || (existing ? 'provided_base64_bytes' : 'provided_file_name_not_path');
      source.input_mode = source.input_mode || (existing ? 'provided_base64_bytes' : 'provided_text_utf8_bytes');
      if (!existing) {
        bytes = utf8Bytes(rawText || '');
        source.sha256 = sha256Bytes(bytes);
        source.bytes = bytes.byteLength;
        source.locator_kind = 'provided_text_not_a_file';
      }
    }
    source.version = source.version === undefined ? null : source.version;
    source.content_version = source.sha256 ? 'sha256:' + source.sha256 : null;
    source.verification_status = 'input_bytes_hashed_unverified_origin';
    source.source_identity = source.source_identity ||
      (existing ? 'provided_workbook_not_publication_verification' : 'provided_text_input_not_publication_verification');
    source.value_fingerprint = tableValueInfo(data);
    return source;
  }

  function parseTable(text, filename) {
    var ext = extOf(filename);
    if (!global.FigData || typeof global.FigData.parseCSV !== 'function') {
      fail('内核 FigData 未加载');
    }
    if (ext === 'json') return global.FigData.parseJSON(text);
    return global.FigData.parseCSV(text, { delimiter: 'auto', header: true });
  }

  function templateApplicability(templateId) {
    if (!global.FigPresets || typeof global.FigPresets.validateTemplateCapability !== 'function') {
      return { ok: false, errors: ['模板能力注册未加载，禁止应用'], capability: null };
    }
    try {
      return global.FigPresets.validateTemplateCapability(templateId);
    } catch (err) {
      return { ok: false, errors: ['模板能力校验失败：' + err.message], capability: null };
    }
  }

  function onlyApplicable(recs) {
    return (Array.isArray(recs) ? recs : []).filter(function (rec) {
      return rec && templateApplicability(rec.template_id).ok;
    });
  }

  function recommendList(stats) {
    // Templates.recommend is the APP-API reuse point; fall back to the kernel.
    try {
      if (global.Templates && typeof global.Templates.recommend === 'function') {
        var list = global.Templates.recommend(stats);
        if (Array.isArray(list) && list.length) return onlyApplicable(list);
      }
    } catch (e) { /* fall through to kernel */ }
    return onlyApplicable(global.FigPresets.recommend(stats, { n: 5 }));
  }

  function recommendDialog(filename, recs, onSubmit) {
    var appName = baseName(filename);
    var radios = [];
    var list = h('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px' });
    recs.forEach(function (r, i) {
      var tpl = (global.FigPresets && global.FigPresets.template(r.template_id)) || null;
      var label = h('label', {
        style: 'display:flex;gap:8px;align-items:flex-start;padding:6px 8px;' +
          'border:1px solid #ddd;border-radius:6px;cursor:pointer'
      });
      var radio = h('input', { type: 'radio', name: 'import-template-choice' });
      radio.checked = i === 0;
      radios.push({ radio: radio, id: r.template_id });
      label.appendChild(radio);
      label.appendChild(h('div', {}, [
        h('div', { text: (tpl ? tpl.name : r.template_id) + '（匹配度 ' + r.score + '）',
          style: 'font-weight:bold;font-size:13px' }),
        h('div', { text: (r.reasons || []).join('；') || '—', style: 'font-size:12px;color:#666' })
      ]));
      list.appendChild(label);
    });
    var titleInput = h('input', {
      type: 'text', value: appName,
      style: 'width:100%;box-sizing:border-box;padding:6px;border:1px solid #bbb;border-radius:4px'
    });
    var body = h('div', {}, [
      h('div', { text: '根据数据特征推荐以下模板（按匹配度排序）：', style: 'margin-bottom:8px;font-size:13px' }),
      list,
      h('div', { text: '图表标题（可留空）：', style: 'margin-bottom:4px;font-size:13px' }),
      titleInput
    ]);
    openModal({
      title: '导入数据：' + filename,
      body: body,
      actions: [
        { label: '取消' },
        {
          label: '生成图表',
          primary: true,
          onClick: function () {
            var picked = null;
            radios.forEach(function (r) { if (r.radio.checked) picked = r.id; });
            if (!picked) {
              toastError('请先选择一个模板');
              return false; // keep the dialog open
            }
            var applicability = templateApplicability(picked);
            if (!applicability.ok) {
              toastError('模板不可应用：' + applicability.errors.join('；'));
              return false;
            }
            // Return the commit promise so the modal stays open until the
            // async App.commit resolves (Ui.modal closes only on success).
            return onSubmit(picked, titleInput.value.trim());
          }
        }
      ]
    });
  }

  // Build add_element ops from templateFromStats output, panel first.
  // Templates are authored for their own journal_default, so content sized for
  // an 89 mm column can overflow a smaller canvas entirely. Scale the generated
  // content (geometry and typography) down so it always fits the canvas.
  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function fitBuiltIntoCanvas(built, canvas) {
    if (!built || !Array.isArray(built.elements) || !built.elements.length) return;
    var margin = 4;
    var availW = Math.max(1, (Number(canvas && canvas.width_mm) || 120) - margin * 2);
    var availH = Math.max(1, (Number(canvas && canvas.height_mm) || 90) - margin * 2);
    var box = null;
    built.elements.forEach(function (el) {
      if (!isObj(el) || !isObj(el.transform)) return;
      if (isObj(el.style) && el.style.panelRelative === true) return;
      var t = el.transform;
      var x0 = Number(t.x) || 0;
      var y0 = Number(t.y) || 0;
      var x1 = x0 + (Number(t.w) || 0);
      var y1 = y0 + (Number(t.h) || 0);
      if (!box) box = { x: x0, y: y0, x1: x1, y1: y1 };
      else {
        box.x = Math.min(box.x, x0);
        box.y = Math.min(box.y, y0);
        box.x1 = Math.max(box.x1, x1);
        box.y1 = Math.max(box.y1, y1);
      }
    });
    if (!box) return;
    var bw = box.x1 - box.x;
    var bh = box.y1 - box.y;
    if (!(bw > 0) || !(bh > 0)) return;
    var k = Math.min(1, availW / bw, availH / bh);
    if (!isFinite(k) || k > 0.999) return;
    built.elements.forEach(function (el) {
      if (!isObj(el) || !isObj(el.transform)) return;
      if (isObj(el.style) && el.style.panelRelative === true) return;
      var t = el.transform;
      t.x = margin + ((Number(t.x) || 0) - box.x) * k;
      t.y = margin + ((Number(t.y) || 0) - box.y) * k;
      t.w = (Number(t.w) || 0) * k;
      t.h = (Number(t.h) || 0) * k;
      var s = el.style;
      if (isObj(s)) {
        if (typeof s.fontSizePt === 'number') s.fontSizePt = round2(s.fontSizePt * k);
        if (typeof s.strokeWidthPt === 'number') s.strokeWidthPt = round2(s.strokeWidthPt * k);
      }
      var lay = el.panelLayout;
      if (isObj(lay) && isObj(lay.labelStyle) && typeof lay.labelStyle.fontSizePt === 'number') {
        lay.labelStyle.fontSizePt = round2(lay.labelStyle.fontSizePt * k);
      }
    });
  }

  function attachSourceInfo(elements, provenance) {
    if (!provenance) return;
    elements.forEach(function (element) {
      if (!element || element.type !== 'chart' || !isObj(element.chart) || !isObj(element.chart.data)) return;
      var stored = JSON.parse(JSON.stringify(provenance));
      element.chart.data.source_info = stored;
      if (stored.locator) {
        element.chart.data.source_ref = stored.locator;
        element.chart.data.ref = stored.locator;
      }
      if (stored.version !== null && stored.version !== undefined) {
        element.chart.data.version = String(stored.version);
      }
    });
  }

  function buildTableOps(built, filename, templateId, provenance) {
    var ops = [];
    if (!Array.isArray(built.elements) || !built.elements.length) {
      fail('模板未生成任何元素');
    }
    attachSourceInfo(built.elements, provenance);
    built.elements.forEach(function (el) {
      ops.push({ op: 'add_element', element: el });
    });
    var source = '';
    if (provenance) {
      if (provenance.sheet_name !== undefined && provenance.sheet_name !== null) {
        source += '，工作表 ' + provenance.sheet_name + '，表头第 ' + provenance.header_row + ' 行';
      }
      if (provenance.sha256) source += '，输入字节 SHA-256 ' + provenance.sha256 + '（来源身份未核验）';
    }
    ops.push({
      op: 'note',
      note: '导入数据文件 ' + filename + '，应用模板 ' + templateId + source +
        (built.warnings && built.warnings.length ? '；告警：' + built.warnings.join('；') : '')
    });
    return ops;
  }

  // ---- R02 数据映射向导 ------------------------------------------------
  //
  // 统一「数据预览 → 字段映射 → 图表和画布预览 → 创建」流程。DataWizard
  // 动态加载（与 svg-import 同模式）；不可用时回退旧 recommendDialog，
  // 保证旧入口与环境仍可用。构建（buildDraft）与提交（onCreate）共用
  // templateFromStats + fitBuiltIntoCanvas：预览与最终创建来自同一构建结果。

  var dataWizardPromise = null;

  function ensureDataWizard() {
    if (global.DataWizard && typeof global.DataWizard.open === 'function') {
      return Promise.resolve(global.DataWizard);
    }
    if (!dataWizardPromise) {
      dataWizardPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'app/data-wizard.js';
        s.onload = function () {
          if (global.DataWizard && typeof global.DataWizard.open === 'function') {
            resolve(global.DataWizard);
          } else {
            reject(new Error('data-wizard.js 加载后缺少 DataWizard'));
          }
        };
        s.onerror = function () { reject(new Error('无法加载 app/data-wizard.js')); };
        (document.head || document.body).appendChild(s);
      });
    }
    return dataWizardPromise;
  }

  // 画布选择 → effective canvas + 需要额外提交的 apply_journal op。
  // keep：当前画布不动；explicit_preset：用户确认套模板期刊预设；
  // explicit_size：用户输入 W×H。
  function canvasChoiceResult(app, choice) {
    var canvas = (app.doc && app.doc.canvas) || { width_mm: 120, height_mm: 90, dpi: 300 };
    var ops = [];
    var effective = canvas;
    if (choice && choice.mode === 'explicit_preset' && choice.preset && choice.preset.id) {
      try {
        var ap = global.FigPresets.applyCanvas(choice.preset.id, app.doc);
        if (ap && ap.op) {
          ops.push(ap.op);
          effective = ap.doc.canvas;
        }
      } catch (e) { /* 保留当前画布并回退缩放 */ }
    } else if (choice && choice.mode === 'explicit_size') {
      var w = Math.max(10, Math.min(2000, Number(choice.width_mm) || 120));
      var hgt = Math.max(10, Math.min(2000, Number(choice.height_mm) || 90));
      var op = { op: 'set_canvas', canvas: { width_mm: w, height_mm: hgt } };
      ops.push(op);
      effective = Object.assign({}, canvas, { width_mm: w, height_mm: hgt });
    }
    return { ops: ops, canvas: effective };
  }

  function openDataWizard(app, data, filename, recs, provenance, cb) {
    var appName = baseName(filename);
    // 预览与最终创建共用同一构建函数：同一 draft 状态 → 同一几何/映射/
    // 有效画布（元素 id 因构建而不同，但提交后即固定进历史）。
    function buildDraftShared(templateId, mapping, canvasChoice, title) {
      var applicability = templateApplicability(templateId);
      if (!applicability.ok) fail('模板不可应用：' + applicability.errors.join('；'));
      var canvasRes = canvasChoiceResult(app, canvasChoice);
      var opts = {
        journal_id: null, // 画布选择独立处理；模板默认仅在用户确认后生效
        palette_id: null,
        title: title || undefined
      };
      if (mapping && Object.keys(mapping).length) opts.mapping = mapping;
      var built = global.FigPresets.templateFromStats(templateId, data, opts);
      fitBuiltIntoCanvas(built, canvasRes.canvas);
      built.effectiveCanvas = canvasRes.canvas;
      built._canvasOps = canvasRes.ops;
      return built;
    }
    function openWith(DW) {
      var handle = DW.open({
        filename: filename,
        data: data,
        recommendations: recs,
        appName: appName,
        sourceInfo: provenance || null,
        currentCanvas: (app.doc && app.doc.canvas) || { width_mm: 120, height_mm: 90, dpi: 300 },
        buildDraft: buildDraftShared,
        onCreate: function (templateId, mapping, canvasChoice, title) {
          return Promise.resolve().then(function () {
            // 与预览共用同一 buildDraft：提交的就是预览看到的构建结果
            // （元素、几何、映射、有效画布一致；同一 draft 状态确定性重建）。
            var buildResult = buildDraftShared(templateId, mapping, canvasChoice, title);
            var ops = (buildResult._canvasOps || []).concat(
              buildTableOps(buildResult, filename, templateId, provenance));
            return app.commit(ops, { label: '导入数据：' + filename, source: 'import' })
              .then(function (res) {
                if (!res || !res.applied) {
                  if (cb) cb(new Error('操作未应用'));
                  return false;
                }
                var ids = buildResult.elements.map(function (el) { return el.id; });
                (buildResult.warnings || []).forEach(function (w) { toast(w, { type: 'info' }); });
                toast('已导入 ' + filename + '（模板 ' + templateId + '，' +
                  buildResult.elements.length + ' 个元素）', { type: 'success' });
                try {
                  if (typeof app.select === 'function') app.select(ids);
                } catch (e) { /* selection is cosmetic */ }
                if (cb) cb(null, { template_id: templateId, element_ids: ids,
                  source_info: provenance || null, warnings: buildResult.warnings || [] });
                return true;
              });
          }).catch(function (err) {
            toastError('导入失败：' + err.message);
            if (cb) cb(err);
            return false;
          });
        }
      });
      return handle;
    }
    // DataWizard 已加载时同步打开（浏览器 index.html 预载 / 测试 require）。
    // 未加载时：真实浏览器（script onload 可用）动态加载；headless/受限
    // 环境不等待永不触发的 onload，直接回退旧推荐对话框保持可用。
    if (global.DataWizard && typeof global.DataWizard.open === 'function') {
      return openWith(global.DataWizard);
    }
    function canDynamicLoad() {
      try {
        return typeof document === 'object' && !!document.head &&
          typeof document.createElement === 'function' &&
          'onload' in document.createElement('script');
      } catch (e) { return false; }
    }
    if (canDynamicLoad()) {
      ensureDataWizard().then(openWith).catch(fallbackToLegacy);
      return null;
    }
    fallbackToLegacy(new Error('当前环境不支持动态脚本加载'));
    return null;

    function fallbackToLegacy(err) {
      // data-wizard.js 不可用（如脱离服务的静态页）：回退旧推荐对话框
      toast('数据映射向导不可用（' + (err && err.message || '加载失败') +
        '），回退到简单模板选择', { type: 'info' });
      recommendDialog(filename, recs, function (templateId, title) {
        return legacyCreateFromTemplate(app, data, filename, templateId, title, provenance, cb);
      });
    }
  }

  // 旧路径（无向导）：沿用既有「空文档自动套期刊 + 缩放」行为。
  function legacyCreateFromTemplate(app, data, filename, templateId, title, provenance, cb) {
    var built;
    try {
      var applicability = templateApplicability(templateId);
      if (!applicability.ok) fail('模板不可应用：' + applicability.errors.join('；'));
      built = global.FigPresets.templateFromStats(templateId, data, {
        journal_id: null,
        palette_id: null,
        title: title || undefined
      });
    } catch (err) {
      toastError('生成模板失败：' + err.message);
      if (cb) cb(err);
      return Promise.resolve(false);
    }
    var ops = [];
    var tpl = null;
    try {
      tpl = global.FigPresets.template(templateId);
    } catch (e) { /* template lookup is optional */ }
    var canvas = (app.doc && app.doc.canvas) || { width_mm: 120, height_mm: 90 };
    var emptyDoc = !(app.doc && app.doc.elements && app.doc.elements.length);
    var journalId = tpl && tpl.journal_default;
    if (emptyDoc && journalId && !canvas.journal_preset_id) {
      try {
        var ap = global.FigPresets.applyCanvas(journalId, app.doc);
        if (ap && ap.op) {
          ops.push(ap.op);
          canvas = ap.doc.canvas;
        }
      } catch (e) { /* keep the current canvas and fall back to scaling */ }
    }
    fitBuiltIntoCanvas(built, canvas);
    ops = ops.concat(buildTableOps(built, filename, templateId, provenance));
    return Promise.resolve().then(function () {
      return app.commit(ops, { label: '导入数据：' + filename, source: 'import' });
    }).then(function (res) {
      if (!res || !res.applied) {
        if (cb) cb(new Error('操作未应用'));
        return false;
      }
      var ids = built.elements.map(function (el) { return el.id; });
      (built.warnings || []).forEach(function (w) { toast(w, { type: 'info' }); });
      toast('已导入 ' + filename + '（模板 ' + templateId + '，' +
        built.elements.length + ' 个元素）', { type: 'success' });
      try {
        if (typeof app.select === 'function') app.select(ids);
      } catch (e) { /* selection is cosmetic */ }
      if (cb) cb(null, { template_id: templateId, element_ids: ids,
        source_info: provenance || null, warnings: built.warnings || [] });
      return true;
    }).catch(function (err) {
      toastError('导入失败：' + err.message);
      if (cb) cb(err);
      return false;
    });
  }

  function applyParsedDataTable(data, filename, cb, provenance) {
    var app = requireApp();
    var stats, recs;
    try {
      stats = global.FigData.columnStats(data);
      recs = recommendList(stats);
    } catch (err) {
      toastError('解析数据失败：' + err.message);
      if (cb) cb(err);
      return;
    }
    if (!recs.length) {
      toastError('没有可推荐的模板');
      if (cb) cb(new Error('没有可推荐的模板'));
      return;
    }
    openDataWizard(app, data, filename, recs, provenance, cb);
  }

  function applyDataTable(text, filename, cb, rawBytes) {
    var data, provenance;
    try {
      data = parseTable(text, filename);
      provenance = sourceInfoForTable(data, filename, rawBytes || null, null, text);
    } catch (err) {
      toastError('解析数据失败：' + err.message);
      if (cb) cb(err);
      return;
    }
    return applyParsedDataTable(data, filename, cb, provenance);
  }

  function applyDataFile(file, cb) {
    requireApp();
    return readArrayBuffer(file).then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      if (typeof global.TextDecoder !== 'function') throw new Error('当前环境缺少 UTF-8 TextDecoder');
      var text = new global.TextDecoder('utf-8').decode(bytes);
      return applyDataTable(text, file.name, cb, bytes);
    }).catch(function (err) {
      toastError(err.message);
      if (cb) cb(err);
      return null;
    });
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    el.textContent = '';
  }

  function cellText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    return String(value);
  }

  function spreadsheetPreviewDialog(filename, dataBase64, initial, cb) {
    var result = initial;
    var sequence = 0;
    var busy = false;
    var sheetSelect = h('select', {
      'data-role': 'spreadsheet-sheet',
      style: 'max-width:240px;padding:4px;margin-left:6px'
    });
    (initial.sheets || []).forEach(function (name) {
      sheetSelect.appendChild(h('option', { value: name, text: name }));
    });
    sheetSelect.value = initial.sheet_name;
    var headerInput = h('input', {
      type: 'number', min: '1', max: '10000', step: '1', value: String(initial.header_row || 1),
      'data-role': 'spreadsheet-header-row',
      style: 'width:80px;padding:4px;margin-left:6px'
    });
    var refreshButton = h('button', {
      type: 'button', text: '刷新解析', 'data-role': 'spreadsheet-refresh',
      style: 'margin-left:8px;padding:4px 10px'
    });
    var status = h('div', {
      'data-role': 'spreadsheet-status', text: '',
      style: 'font-size:12px;color:#8a3b12;margin:6px 0'
    });
    var info = h('div', {
      'data-role': 'spreadsheet-info', style: 'font-size:12px;color:#555;margin-bottom:6px'
    });
    var notices = h('div', {
      'data-role': 'spreadsheet-notices', style: 'font-size:12px;color:#8a5a00;margin-bottom:8px'
    });
    var stats = h('div', {
      'data-role': 'spreadsheet-stats', style: 'font-size:12px;margin-bottom:8px'
    });
    var preview = h('div', {
      'data-role': 'spreadsheet-preview', style: 'overflow:auto;max-height:240px;margin-bottom:8px'
    });
    var body = h('div', { 'data-role': 'spreadsheet-dialog' }, [
      h('div', {
        text: '文件：' + filename + '；仅在本机图工作台服务中读取，不执行公式、宏或外部工作簿链接。',
        style: 'font-size:13px;margin-bottom:8px'
      }),
      h('div', { style: 'display:flex;align-items:center;flex-wrap:wrap;gap:4px' }, [
        h('label', { text: '工作表' }), sheetSelect,
        h('label', { text: '表头行（从 1 开始）' }), headerInput, refreshButton
      ]),
      status, info, notices, stats, preview,
      h('div', {
        text: '切换工作表或表头只更新上方预览；点击“继续：选择模板”后才会按现有导入事务建图。',
        style: 'font-size:12px;color:#666'
      })
    ]);

    function renderResult() {
      var data = result.data;
      clearChildren(info);
      clearChildren(notices);
      clearChildren(stats);
      clearChildren(preview);
      info.appendChild(h('div', {
        text: '工作表：' + result.sheet_name + '；表头行：' + result.header_row +
          '；列：' + data.columns.length + '；数据行：' + data.rows.length +
          ((result.source_info && result.source_info.sha256)
            ? '；SHA-256：' + result.source_info.sha256 : '')
      }));
      (result.notices || []).forEach(function (notice) {
        notices.appendChild(h('div', {
          text: '· ' + (notice.message || notice.code || '工作簿提示'),
          style: 'white-space:pre-wrap;overflow-wrap:anywhere;margin:3px 0'
        }));
      });
      var columnStats = global.FigData.columnStats(data);
      stats.appendChild(h('div', { text: '实际列统计：', style: 'font-weight:bold;margin-bottom:3px' }));
      columnStats.columns.forEach(function (column) {
        stats.appendChild(h('span', {
          text: column.name + ' [' + column.kind + '，缺失 ' + column.missing + ']',
          style: 'display:inline-block;border:1px solid #ddd;border-radius:4px;padding:2px 5px;margin:2px'
        }));
      });
      var table = h('table', {
        'data-role': 'spreadsheet-table',
        style: 'border-collapse:collapse;font-size:12px;min-width:100%'
      });
      var head = h('tr');
      data.columns.forEach(function (name) {
        head.appendChild(h('th', {
          text: name,
          style: 'border:1px solid #ccc;padding:3px 6px;text-align:left;background:#f3f5f7'
        }));
      });
      table.appendChild(h('thead', {}, [head]));
      var tbody = h('tbody');
      data.rows.slice(0, 8).forEach(function (row) {
        var tr = h('tr');
        data.columns.forEach(function (_, index) {
          tr.appendChild(h('td', {
            text: cellText(row[index]),
            style: 'border:1px solid #ddd;padding:3px 6px;white-space:pre-wrap;max-width:260px;overflow-wrap:anywhere'
          }));
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      preview.appendChild(table);
    }

    function refresh() {
      var rawHeader = String(headerInput.value || '').trim();
      var header = rawHeader ? Number(rawHeader) : null;
      if (header !== null && (!Number.isInteger(header) || header < 1 || header > 10000)) {
        status.textContent = '表头行必须是 1 到 10000 的整数；留空则自动识别';
        return Promise.resolve(null);
      }
      var current = ++sequence;
      busy = true;
      refreshButton.disabled = true;
      status.textContent = '正在本机重新解析…';
      return postSpreadsheet({
        data_base64: dataBase64,
        file_name: filename,
        sheet: sheetSelect.value,
        header_row: header
      }).then(function (next) {
        if (current !== sequence) return null;
        result = next;
        sheetSelect.value = result.sheet_name;
        headerInput.value = String(result.header_row);
        renderResult();
        status.textContent = '预览已更新；尚未写入画布或历史。';
        return result;
      }).catch(function (err) {
        if (current === sequence) status.textContent = err.message;
        toastError(err.message);
        return null;
      }).then(function (value) {
        if (current === sequence) {
          busy = false;
          refreshButton.disabled = false;
        }
        return value;
      });
    }

    sheetSelect.addEventListener('change', function () {
      headerInput.value = '';
      refresh();
    });
    refreshButton.addEventListener('click', refresh);
    renderResult();
    var actions = [
      { label: '取消' },
      {
        label: '继续：选择模板', primary: true,
        onClick: function () {
          if (busy) {
            toastError('请等待当前工作表解析完成');
            return false;
          }
          if (!result || !result.data) return false;
          var provenance = {};
          Object.keys(result.source_info || {}).forEach(function (key) {
            provenance[key] = result.source_info[key];
          });
          provenance.sheet_name = result.sheet_name;
          provenance.header_row = result.header_row;
          provenance = sourceInfoForTable(result.data, filename, null, provenance);
          return applyParsedDataTable(result.data, filename, cb, provenance);
        }
      }
    ];
    var modal = openModal({ title: 'Excel 导入预览：' + filename, body: body, actions: actions });
    return {
      modal: modal, body: body, actions: actions, refresh: refresh,
      getResult: function () { return result; },
      sheetSelect: sheetSelect, headerInput: headerInput
    };
  }

  function applySpreadsheetBuffer(buffer, filename, cb) {
    requireApp();
    var dataBase64;
    try {
      if (!buffer || !(buffer.byteLength > 0)) fail('工作簿内容为空');
      if (buffer.byteLength > 20 * 1024 * 1024) fail('工作簿不得超过 20 MiB');
      dataBase64 = arrayBufferToBase64(buffer);
    } catch (err) {
      toastError('Excel 导入失败：' + err.message);
      if (cb) cb(err);
      return Promise.reject(err);
    }
    return postSpreadsheet({
      data_base64: dataBase64, file_name: filename
    }).then(function (result) {
      return spreadsheetPreviewDialog(filename, dataBase64, result, cb);
    }).catch(function (err) {
      toastError(err.message);
      if (cb) cb(err);
      return null;
    });
  }

  function applySpreadsheetFile(file, cb) {
    requireApp();
    return readArrayBuffer(file).then(function (buffer) {
      return applySpreadsheetBuffer(buffer, file.name, cb);
    }).catch(function (err) {
      toastError(err.message);
      if (cb) cb(err);
      return null;
    });
  }

  // ------------------------------------------------------------------
  // image import
  // ------------------------------------------------------------------

  function measureImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      };
      img.onerror = function () { reject(new Error('图片无法解码，请确认文件格式')); };
      img.src = dataUrl;
    });
  }

  function defaultImageBox(pxW, pxH, canvas) {
    // Natural size at canvas DPI, then fit into 80% of the canvas, centered.
    var dpi = canvas.dpi && canvas.dpi > 0 ? canvas.dpi : 300;
    var mmW = pxW * 25.4 / dpi;
    var mmH = pxH * 25.4 / dpi;
    var maxW = canvas.width_mm * 0.8;
    var maxH = canvas.height_mm * 0.8;
    var k = Math.min(maxW / mmW, maxH / mmH, 1);
    mmW *= k;
    mmH *= k;
    return {
      x: Math.round((canvas.width_mm - mmW) / 2 * 100) / 100,
      y: Math.round((canvas.height_mm - mmH) / 2 * 100) / 100,
      w: Math.round(mmW * 100) / 100,
      h: Math.round(mmH * 100) / 100
    };
  }

  function imageDialog(dataUrl, name, px, onPlace) {
    var canvas = global.App.canvas();
    var checked = { background: false };
    var box = h('div', {}, [
      h('img', {
        src: dataUrl,
        style: 'max-width:100%;max-height:180px;display:block;margin-bottom:8px;' +
          'border:1px solid #ddd;background:#fff'
      }),
      h('div', {
        text: name + '（' + px.width + ' × ' + px.height + ' px，建议 ' +
          defaultImageBox(px.width, px.height, canvas).w + ' × ' +
          defaultImageBox(px.width, px.height, canvas).h + ' mm）',
        style: 'font-size:12px;color:#666;margin-bottom:8px'
      }),
      h('div', {
        'data-image-capability': 'raster-only',
        text: '位图将作为整张图片图层置入，可移动、缩放；插件不会识别图中文字/数据，' +
          '不会自动仿绘或恢复原始数据。如需重绘，请导入真实数据表或用「实体关系」明确声明内容。',
        style: 'font-size:12px;color:#7c2d12;background:#fff7ed;border:1px solid #fed7aa;' +
          'border-radius:4px;padding:6px;margin-bottom:8px'
      }),
      h('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, (function () {
        var cb = h('input', { type: 'checkbox' });
        cb.addEventListener('change', function () { checked.background = cb.checked; });
        return [cb, document.createTextNode('作为画布底图（asBackground，铺满画布并置于最底层）')];
      })())
    ]);
    openModal({
      title: '置入图片',
      body: box,
      actions: [
        { label: '取消' },
        {
          label: '置入画布',
          primary: true,
          onClick: function () { return onPlace(checked.background); }
        }
      ]
    });
  }

  function applyImageData(dataUrl, name, cb) {
    var app = requireApp();
    var px;
    measureImage(dataUrl).then(function (size) {
      px = size;
      if (!(px.width > 0) || !(px.height > 0)) px = { width: 300, height: 150 };
      imageDialog(dataUrl, name, px, function (asBackground) {
        placeImage(app, dataUrl, name, px, asBackground, cb);
      });
    }).catch(function (err) {
      toastError(err.message);
      if (cb) cb(err);
    });
  }

  function placeImage(app, dataUrl, name, px, asBackground, cb) {
    var canvas = app.canvas();
    var el;
    if (asBackground) {
      el = {
        id: global.FigDoc.uid('img'),
        name: name,
        type: 'image',
        transform: { x: 0, y: 0, w: canvas.width_mm, h: canvas.height_mm, rotation: 0 },
        style: { imageFit: 'stretch' },
        src: dataUrl,
        asBackground: true
      };
    } else {
      var box = defaultImageBox(px.width, px.height, canvas);
      el = {
        id: global.FigDoc.uid('img'),
        name: name,
        type: 'image',
        transform: { x: box.x, y: box.y, w: box.w, h: box.h, rotation: 0 },
        style: { imageFit: 'contain' },
        src: dataUrl,
        asBackground: false,
        // R07：原始像素尺寸（导入时实测），供有效 DPI 检查；
        // 缺失时检查器如实给 unknown，不用 dpi 标签冒充。
        pxWidth: px.width,
        pxHeight: px.height
      };
    }
    var ops = [{ op: 'add_element', element: el }];
    if (asBackground) ops.push({ op: 'z_order', targets: [el.id], to: 'back' });
    // Image provenance travels inside the same commit as a note op; doc.meta
    // is not touched after commit (see the commit rules in APP-API.md).
    ops.push({
      op: 'note',
      note: '置入图片文件 ' + name + (asBackground ? '（作为画布底图）' : '')
    });
    // App.commit is async: keep the dialog open until it resolves.
    return Promise.resolve().then(function () {
      return app.commit(ops, { label: '置入图片：' + name, source: 'import' });
    }).then(function (res) {
      if (!res || !res.applied) {
        if (cb) cb(new Error('操作未应用'));
        return false; // keep the dialog open
      }
      // No res.doc mutation here: image provenance was carried by the note op
      // inside the commit above, so history and doc_sha256 stay exact.
      toast('已置入图片 ' + name + (asBackground ? '（底图）' : ''), { type: 'success' });
      try {
        if (typeof app.select === 'function') app.select([el.id]);
      } catch (e) { /* cosmetic */ }
      if (cb) cb(null, el.id);
      return true;
    }).catch(function (err) {
      toastError('置入图片失败：' + err.message);
      if (cb) cb(err);
      return false;
    });
  }

  // ------------------------------------------------------------------
  // svg import (editable per-element or static image)
  // ------------------------------------------------------------------

  var svgImportPromise = null;

  // import.js 按 APP-API.md 的脚本顺序在 index.html 之外动态加载转换器，
  // 不新增 index.html 的 script 标签。
  function ensureSvgImport() {
    if (global.SvgImport && typeof global.SvgImport.convert === 'function') {
      return Promise.resolve(global.SvgImport);
    }
    if (!svgImportPromise) {
      svgImportPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'app/svg-import.js';
        s.onload = function () {
          if (global.SvgImport && typeof global.SvgImport.convert === 'function') {
            resolve(global.SvgImport);
          } else {
            reject(new Error('svg-import.js 加载后缺少 SvgImport'));
          }
        };
        s.onerror = function () {
          reject(new Error('无法加载 app/svg-import.js'));
        };
        (document.head || document.body).appendChild(s);
      });
    }
    return svgImportPromise;
  }

  function isSvgFile(file) {
    var ext = extOf(file && file.name);
    var type = String((file && file.type) || '').toLowerCase();
    return ext === 'svg' || ext === 'svgz' ||
      type === 'image/svg+xml' || type === 'image/svg+xml-gzip';
  }

  function isSvgzFile(file) {
    var ext = extOf(file && file.name);
    var type = String((file && file.type) || '').toLowerCase();
    return ext === 'svgz' || type === 'image/svg+xml-gzip';
  }

  function svgToDataUrl(text) {
    return 'data:image/svg+xml;base64,' +
      btoa(unescape(encodeURIComponent(String(text))));
  }

  function rasterizeSvgDataUrl(svgDataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var w = Math.round(img.naturalWidth || img.width);
          var h = Math.round(img.naturalHeight || img.height);
          if (!(w > 0) || !(h > 0)) throw new Error('SVG 没有可栅格化的尺寸');
          if (w * h > 16 * 1024 * 1024) {
            throw new Error('SVG 静态图超过 1600 万像素上限，请先缩小尺寸');
          }
          var canvasEl = document.createElement('canvas');
          canvasEl.width = w;
          canvasEl.height = h;
          var ctx = canvasEl.getContext('2d');
          if (!ctx) throw new Error('当前浏览器无法创建静态图栅格化画布');
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          var png = canvasEl.toDataURL('image/png');
          if (!/^data:image\/png;base64,/i.test(png)) {
            throw new Error('浏览器未返回有效 PNG，静态 SVG 未置入');
          }
          resolve(png);
        } catch (err) {
          reject(new Error('静态 SVG 栅格化失败：' + err.message));
        }
      };
      img.onerror = function () {
        reject(new Error('静态 SVG 栅格化失败：清理后的 SVG 无法解码'));
      };
      img.src = svgDataUrl;
    });
  }

  function decompressSvgz(file) {
    if (typeof global.DecompressionStream !== 'function') {
      return Promise.reject(new Error(
        '当前浏览器缺少 gzip 解压能力，无法导入 .svgz，请先解压为 .svg 再导入'));
    }
    return Promise.resolve().then(function () {
      var stream = file.stream().pipeThrough(new global.DecompressionStream('gzip'));
      return new Response(stream).text();
    }).catch(function () {
      throw new Error('.svgz 解压失败，文件可能已损坏');
    });
  }

  function applySvgText(text, name, cb) {
    requireApp();
    ensureSvgImport().then(function (Sv) {
      var conv;
      try {
        conv = Sv.convert(text);
      } catch (err) {
        toastError('解析 SVG 失败：' + err.message);
        if (cb) cb(err);
        return;
      }
      svgChoiceDialog(name, text, Sv, conv, cb);
    }).catch(function (err) {
      toastError('导入 SVG 失败：' + err.message);
      if (cb) cb(err);
    });
  }

  function applySvgFile(file, cb) {
    var gz = isSvgzFile(file);
    Promise.resolve()
      .then(function () { return gz ? decompressSvgz(file) : readFile(file, 'text'); })
      .then(function (text) { applySvgText(text, file.name, cb); })
      .catch(function (err) {
        toastError(err.message);
        if (cb) cb(err);
      });
  }

  function svgChoiceDialog(name, svgText, Sv, conv, cb) {
    var app = requireApp();
    var summary = h('div', { style: 'font-size:12px;color:#666;margin-bottom:10px' }, [
      h('div', {
        text: '识别到 ' + conv.elements.length + ' 个可编辑元素' +
          (conv.skipped ? '，' + conv.skipped + ' 个元素被跳过' : '') +
          '（画布尺寸约 ' + conv.size_mm.w + ' × ' + conv.size_mm.h + ' mm）',
        style: 'margin-bottom:4px'
      })
    ]);
    (conv.warnings || []).forEach(function (w) {
      summary.appendChild(h('div', { text: '· ' + w, style: 'color:#8a6d3b' }));
    });
    openModal({
      title: '导入 SVG：' + name,
      body: h('div', {}, [
        summary,
        h('div', {
          text: '逐元素导入（默认）：形状/文本转换为可独立选中、移动、改色的图元；' +
            '不承诺逐锚点编辑既有 path。',
          style: 'font-size:12px;margin-bottom:4px'
        }),
        h('div', {
          text: '作为静态图置入：安全清理后栅格化为 PNG，仅能整体缩放移动，不保留矢量编辑能力。',
          style: 'font-size:12px;color:#666'
        })
      ]),
      actions: [
        { label: '取消' },
        {
          label: '作为静态图置入',
          onClick: function () {
            return Promise.resolve().then(function () {
              var cleanText = conv.svgText;
              if (typeof cleanText !== 'string' && typeof Sv.sanitize === 'function') {
                cleanText = Sv.sanitize(svgText).svgText;
              }
              if (typeof cleanText !== 'string') {
                throw new Error('SVG 尚未完成安全清理，拒绝静态置入');
              }
              return rasterizeSvgDataUrl(svgToDataUrl(cleanText));
            }).then(function (pngDataUrl) {
              return applyImageData(pngDataUrl, name, cb);
            }).then(function () { return true; });
          }
        },
        {
          label: '逐元素导入',
          primary: true,
          onClick: function () { return commitSvgEditable(app, name, Sv, conv, cb); }
        }
      ]
    });
  }

  function commitSvgEditable(app, name, Sv, conv, cb) {
    var canvas = app.canvas();
    var used = {};
    (app.doc.elements || []).forEach(function (el) { if (el && el.id) used[el.id] = true; });
    var ids = {};
    var elements = conv.elements.map(function (source) {
      var el = JSON.parse(JSON.stringify(source));
      var id = source.id;
      while (!id || used[id]) id = global.FigDoc.uid('svg');
      used[id] = true;
      ids[source.id] = id;
      el.id = id;
      return el;
    });
    elements.forEach(function (el) {
      if (el.parent_id != null) el.parent_id = ids[el.parent_id];
      if (Array.isArray(el.children)) {
        el.children = el.children.map(function (id) { return ids[id]; });
      }
    });
    var k = Sv.fitToCanvas(elements, canvas);
    var topIds = elements.filter(function (el) { return el.parent_id == null; })
      .map(function (el) { return el.id; });
    var ops = elements.map(function (el) {
      return { op: 'add_element', element: el };
    });
    var note = '导入 SVG ' + name + '：逐元素转换 ' + elements.length + ' 个元素' +
      (k !== 1 ? '，已整体缩放至 ' + Math.round(k * 100) + '%' : '') +
      (conv.skipped ? '，跳过 ' + conv.skipped + ' 个' : '') +
      ((conv.warnings && conv.warnings.length) ? '；' + conv.warnings.join('；') : '');
    ops.push({ op: 'note', note: note });
    return Promise.resolve().then(function () {
      return app.commit(ops, { label: '导入SVG：' + name, source: 'import' });
    }).then(function (res) {
      if (!res || !res.applied) {
        toastError('SVG 未通过文档校验，未导入任何元素；请查看当前状态栏的校验错误');
        if (cb) cb(new Error('操作未应用'));
        return false; // keep the dialog open so the user can retry
      }
      toast('已导入 SVG ' + name + '（' + elements.length + ' 个可编辑元素）',
        { type: 'success' });
      if (conv.warnings && conv.warnings.length) {
        toast('SVG 转换提示：' + conv.warnings.join('；'), { type: 'info' });
      }
      try {
        if (typeof app.select === 'function') app.select(topIds);
      } catch (e) { /* selection is cosmetic */ }
      if (cb) cb(null, { element_ids: topIds, count: elements.length });
      return true;
    }).catch(function (err) {
      toastError('导入 SVG 失败：' + err.message);
      if (cb) cb(err);
      return false;
    });
  }

  // ------------------------------------------------------------------
  // clipboard paste
  // ------------------------------------------------------------------

  function pickImageItem(items) {
    if (!items) return null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type || '')) return items[i];
    }
    return null;
  }

  // Import.pasteImageFromClipboard(cb?) — install the paste listener once
  // (idempotent); the latest cb is used for subsequent pastes. Returns a
  // detach function so callers (Editor/main) keep an API-shaped handle.
  function pasteImageFromClipboard(cb) {
    pasteCb = typeof cb === 'function' ? cb : pasteCb;
    if (!pasteBound) {
      pasteBound = true;
      document.addEventListener('paste', function (evt) {
        var item = pickImageItem(evt.clipboardData && evt.clipboardData.items);
        if (!item) return; // plain-text paste stays with the editor
        evt.preventDefault();
        var file = item.getAsFile();
        if (!file) {
          toastError('剪贴板中的图片无法读取');
          return;
        }
        if (isSvgFile(file)) {
          applySvgFile(file, pasteCb);
          return;
        }
        readFile(file, 'dataURL').then(function (dataUrl) {
          applyImageData(dataUrl, '剪贴板图片', pasteCb);
        }).catch(function (err) {
          toastError(err.message);
        });
      });
    }
    return function detach() { /* single shared listener; kept for API shape */ };
  }

  // ------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------

  // Import.mount(panelEl) — "导入数据 / 导入图片" buttons; idempotent.
  function mount(panelEl) {
    if (!panelEl || typeof panelEl.appendChild !== 'function') return;
    if (panelEl.getAttribute && panelEl.getAttribute('data-import-mounted') === '1') return;
    if (panelEl.setAttribute) panelEl.setAttribute('data-import-mounted', '1');
    function btn(label, onClick) {
      var b = h('button', {
        text: label,
        style: 'margin:4px 4px 4px 0;padding:5px 12px;border:1px solid #bbb;' +
          'border-radius:4px;background:#fff;cursor:pointer;font-size:13px'
      });
      b.addEventListener('click', onClick);
      panelEl.appendChild(b);
      return b;
    }
    btn('导入数据', function () { openData(); });
    btn('导入图片', function () { openImage(); }).title =
      '置入为位图图层；不做 OCR/图表识别，不自动仿绘或恢复原始数据';
    btn('导入 SVG', function () { openSvg(); });
    pasteImageFromClipboard();
  }

  // Import.openData(cb?) — text data stays local; Excel uses the local workbench API.
  function openData(cb) {
    requireApp();
    var input = fileInput(
      '.csv,.json,.tsv,.xlsx,.xlsm,.xls,text/csv,application/json,text/tab-separated-values,' +
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
      'application/vnd.ms-excel.sheet.macroenabled.12,application/vnd.ms-excel',
      function (file) {
        if (isSpreadsheetFile(file)) {
          applySpreadsheetFile(file, cb);
          return;
        }
        applyDataFile(file, cb);
      });
    input.click();
    return input;
  }

  // Import.openImage(cb?) — pick an image and place it (dialog asks about
  // asBackground); cb(elementId) fires after the commit. SVG/SVGZ routes to
  // the editable-import dialog instead of the raster path.
  function openImage(cb) {
    requireApp();
    var input = fileInput('image/*,.svg,.svgz', function (file) {
      if (isSvgFile(file)) {
        applySvgFile(file, cb);
        return;
      }
      readFile(file, 'dataURL').then(function (dataUrl) {
        applyImageData(dataUrl, file.name, cb);
      }).catch(function (err) {
        toastError(err.message);
        if (cb) cb(err);
      });
    });
    input.click();
  }

  // Import.openSvg(cb?) — pick .svg/.svgz and run the editable-import dialog.
  function openSvg(cb) {
    requireApp();
    var input = fileInput('.svg,.svgz,image/svg+xml', function (file) {
      if (!isSvgFile(file)) {
        var err = new Error('请选择 .svg 或 .svgz 文件');
        toastError(err.message);
        if (cb) cb(err);
        return;
      }
      applySvgFile(file, cb);
    });
    input.click();
  }

  global.Import = {
    mount: mount,
    openData: openData,
    openImage: openImage,
    openSvg: openSvg,
    pasteImageFromClipboard: pasteImageFromClipboard,
    // exposed for tests / other modules; not part of the frozen contract
    _applyImageData: applyImageData,
    _applyDataTable: applyDataTable,
    _applyDataFile: applyDataFile,
    _sha256Bytes: sha256Bytes,
    _sourceInfoForTable: sourceInfoForTable,
    _applySpreadsheetFile: applySpreadsheetFile,
    _applySpreadsheetBuffer: applySpreadsheetBuffer,
    _spreadsheetPreviewDialog: spreadsheetPreviewDialog,
    _arrayBufferToBase64: arrayBufferToBase64,
    _readArrayBuffer: readArrayBuffer,
    _applySvgFile: applySvgFile,
    _applySvgText: applySvgText,
    _decompressSvgz: decompressSvgz,
    _svgToDataUrl: svgToDataUrl
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
