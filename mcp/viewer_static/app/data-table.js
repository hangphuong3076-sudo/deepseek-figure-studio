/*
 * data-table.js — 「定位到原始数据」只读数据表（D 项）。
 *
 * DataTable.open({chartId, rows:[int...]})
 *   rows 为 chart.data.inline.rows 的 0 基下标（与渲染器 data-row 同源）。
 *   - Ui.modal 承载；表头列名 + 映射角色标注（横轴/纵轴/分组/颜色/大小/标签/误差）
 *   - 固定行高虚拟滚动：只渲染可视窗口 ± 缓冲，20 万行也能快速打开
 *   - 目标行高亮并滚到中间；多行（柱子汇总）可「上一行/下一行」循环查看
 *   - 显示来源文件名与短校验码；向导手工修改过的单元格带标记
 *   - 纯只读：不改文档、不进历史；Esc/✕ 关闭
 */
(function (global) {
  'use strict';

  var ROW_H = 24;          // 与 CSS .dt-row height 保持一致
  var BUFFER = 10;         // 可视窗口上下各多渲染的行数
  var HEADER_H = 30;

  var ROLE_LABEL = {
    x: '横轴', y: '纵轴', group: '分组', color: '颜色',
    size: '大小', label: '标签', error: '误差'
  };

  function h(tag, attrs, children) {
    return global.Ui.h(tag, attrs, children);
  }

  function figdoc() { return global.FigDoc; }

  function findChart(chartId) {
    var App = global.App, doc = App && App.doc;
    if (!doc || !figdoc() || typeof figdoc().get !== 'function') return null;
    var el = figdoc().get(doc, chartId);
    return el && el.type === 'chart' ? el : null;
  }

  function parseRows(raw) {
    var out = [];
    String(raw || '').split(',').forEach(function (s) {
      var n = parseInt(s, 10);
      if (isFinite(n) && n >= 0) out.push(n);
    });
    return out;
  }

  // manual_edits.cells: {row, column, from, to} —— row 为 0 基行下标。
  function editedCells(sourceInfo) {
    var set = Object.create(null);
    var me = sourceInfo && sourceInfo.manual_edits;
    if (me && Array.isArray(me.cells)) {
      me.cells.forEach(function (c) {
        if (c && isFinite(c.row)) {
          var key = String(c.row) + '|' + String(c.column);
          set[key] = true;
        }
      });
    }
    return set;
  }

  function fmtCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  function open(opts) {
    opts = opts || {};
    var chartId = opts.chartId;
    var rows = Array.isArray(opts.rows) ? opts.rows.slice() : parseRows(opts.rowAttr);
    var chartEl = findChart(chartId);
    if (!chartEl || !chartEl.chart) {
      if (global.Ui && Ui.toast) Ui.toast('找不到图表数据', { type: 'error' });
      return null;
    }
    var spec = chartEl.chart;
    var inline = spec.data && spec.data.inline;
    if (!inline || !Array.isArray(inline.columns) || !Array.isArray(inline.rows)) {
      if (global.Ui && Ui.toast) Ui.toast('该图表没有可定位的内联数据', { type: 'error' });
      return null;
    }
    var columns = inline.columns;
    var allRows = inline.rows;
    var mapping = spec.mapping || {};
    var sourceInfo = (spec.data && spec.data.source_info) || null;
    var edited = editedCells(sourceInfo);

    // 映射角色 → 列名集合（同一列可承担多个角色）
    var colRoles = columns.map(function () { return []; });
    Object.keys(ROLE_LABEL).forEach(function (role) {
      var col = mapping[role];
      var idx = columns.indexOf(col);
      if (idx >= 0) colRoles[idx].push(ROLE_LABEL[role]);
    });

    var validRows = rows.filter(function (r) { return r >= 0 && r < allRows.length; });
    if (!validRows.length) {
      if (global.Ui && Ui.toast) Ui.toast('没有可定位的数据行', { type: 'error' });
      return null;
    }
    // 高亮集合 + 当前聚焦下标（多行时可循环）
    var targetSet = Object.create(null);
    validRows.forEach(function (r) { targetSet[r] = true; });
    var curIdx = 0;

    // ---------------- 视图 ----------------
    var meta = h('div', { class: 'dt-meta', style: { fontSize: '12px', color: '#555', margin: '0 0 6px' } });
    var srcBits = [];
    if (sourceInfo) {
      if (sourceInfo.file_name) srcBits.push('来源文件：' + sourceInfo.file_name);
      else if (sourceInfo.locator) srcBits.push('来源：' + sourceInfo.locator);
      if (sourceInfo.sha256) srcBits.push('校验码 ' + String(sourceInfo.sha256).slice(0, 12));
      var meN = sourceInfo.manual_edits && sourceInfo.manual_edits.count;
      if (meN) srcBits.push('导入时手工修改 ' + meN + ' 格（标 * 的单元格）');
    }
    meta.textContent = srcBits.length ? srcBits.join(' · ') : '内联数据（无外部来源记录）';
    if (sourceInfo && sourceInfo.sha256) {
      meta.title = '内容校验值（SHA-256）：' + sourceInfo.sha256;
    }

    var bar = h('div', { class: 'dt-bar', style: { display: 'flex', gap: '8px',
      alignItems: 'center', margin: '0 0 6px', fontSize: '12px' } });
    var caption = h('span', { class: 'dt-caption' });
    var prevBtn = h('button', { class: 'dt-nav', text: '上一行', type: 'button' });
    var nextBtn = h('button', { class: 'dt-nav', text: '下一行', type: 'button' });
    var multi = validRows.length > 1;
    bar.appendChild(caption);
    if (multi) {
      bar.appendChild(prevBtn); bar.appendChild(nextBtn);
      var sumText = '这根柱子由 ' + validRows.length + ' 行数据汇总';
      var sumEl = h('span', { class: 'dt-sum', text: sumText,
        style: { color: '#555' } });
      bar.appendChild(sumEl);
    }

    var tableWrap = h('div', { class: 'dt-wrap' });
    var table = h('table', { class: 'dt-table' });
    var thead = h('thead');
    var headRow = h('tr');
    columns.forEach(function (name, ci) {
      var th = h('th', { text: fmtCell(name) });
      var roles = colRoles[ci];
      if (roles.length) {
        th.appendChild(h('span', { class: 'dt-role',
          text: '（' + roles.join('、') + '）',
          style: { color: '#2f6fed', fontWeight: 'normal', fontSize: '11px' } }));
      }
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = h('tbody');
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    var body = h('div', { class: 'dt-body' }, [meta, bar, tableWrap]);

    // ---------------- 虚拟滚动 ----------------
    var scrollTop = 0;
    var viewH = 320;

    function rowHtml(r) {
      var tr = h('tr', { class: 'dt-row' + (targetSet[r] ? ' dt-hit' : ''),
        'data-row-idx': r });
      if (targetSet[r] && r === validRows[curIdx]) tr.className += ' dt-focus';
      var row = allRows[r] || [];
      columns.forEach(function (name, ci) {
        var td = h('td');
        var v = fmtCell(row[ci]);
        td.textContent = v;
        if (edited[String(r) + '|' + String(name)]) {
          td.appendChild(h('span', { class: 'dt-edited', text: ' *',
            title: '导入向导中手工修改过', style: { color: '#b45309' } }));
        }
        tr.appendChild(td);
      });
      return tr;
    }

    function renderWindow() {
      var first = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
      var last = Math.min(allRows.length - 1,
        Math.ceil((scrollTop + viewH) / ROW_H) + BUFFER);
      tbody.textContent = '';
      // 用绝对定位的空白行撑出总高度，窗口内只放可视行
      var topPad = h('tr', { class: 'dt-pad' });
      var topCell = h('td', { colspan: String(columns.length) });
      topCell.style.height = (first * ROW_H) + 'px';
      topPad.appendChild(topCell);
      tbody.appendChild(topPad);
      for (var r = first; r <= last; r++) tbody.appendChild(rowHtml(r));
      var botPad = h('tr', { class: 'dt-pad' });
      var botCell = h('td', { colspan: String(columns.length) });
      botCell.style.height = ((allRows.length - 1 - last) * ROW_H) + 'px';
      botPad.appendChild(botCell);
      tbody.appendChild(botPad);
    }

    function updateCaption() {
      var r = validRows[curIdx];
      caption.textContent = '数据第 ' + (r + 1) + ' 行（不含表头）' +
        (multi ? ' · 第 ' + (curIdx + 1) + '/' + validRows.length + ' 处' : '');
    }

    function scrollToRow(r, center) {
      var target = r * ROW_H;
      var top = center ? target - viewH / 2 + ROW_H / 2
        : Math.max(0, target - ROW_H);
      scrollTop = Math.max(0, Math.min(allRows.length * ROW_H - viewH, top));
      tableWrap.scrollTop = scrollTop;
      renderWindow();
      updateCaption();
    }

    tableWrap.addEventListener('scroll', function () {
      scrollTop = tableWrap.scrollTop;
      renderWindow();
    });

    function cycle(dir) {
      curIdx = (curIdx + dir + validRows.length) % validRows.length;
      scrollToRow(validRows[curIdx], true);
    }
    prevBtn.addEventListener('click', function () { cycle(-1); });
    nextBtn.addEventListener('click', function () { cycle(1); });

    // 键盘：上下方向键在多行间循环（单行时无操作）
    var modal = null;
    function onKey(evt) {
      if (!multi) return;
      if (evt.key === 'ArrowUp' || evt.key === 'ArrowLeft') { evt.preventDefault(); cycle(-1); }
      else if (evt.key === 'ArrowDown' || evt.key === 'ArrowRight') { evt.preventDefault(); cycle(1); }
    }

    if (!(global.Ui && typeof Ui.modal === 'function')) {
      if (global.Ui && Ui.toast) Ui.toast('页面缺少对话框组件', { type: 'error' });
      return null;
    }
    modal = Ui.modal({
      title: '图表数据（只读）',
      className: 'ui-modal-wide dt-modal',
      body: body,
      onClosed: function () {
        if (modal && modal.dialog) modal.dialog.removeEventListener('keydown', onKey);
      },
      actions: [{ label: '关闭', primary: true }]
    });
    if (modal && modal.dialog) modal.dialog.addEventListener('keydown', onKey);

    // 初始定位：优先当前聚焦行；视口高度取实际渲染值
    requestAnimationFrame(function () {
      viewH = tableWrap.clientHeight || 320;
      scrollToRow(validRows[curIdx], true);
    });
    updateCaption();
    renderWindow();
    return modal;
  }

  global.DataTable = { open: open };
})(typeof globalThis !== 'undefined' ? globalThis : this);
