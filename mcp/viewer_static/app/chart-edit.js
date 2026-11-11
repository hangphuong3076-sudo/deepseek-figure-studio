(function (global) {
  'use strict';

  var svgImportPromise = null;

  function loadSvgImport() {
    if (global.SvgImport && typeof global.SvgImport.convert === 'function') {
      return Promise.resolve(global.SvgImport);
    }
    if (!svgImportPromise) {
      svgImportPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = 'app/svg-import.js';
        script.onload = function () {
          if (global.SvgImport && typeof global.SvgImport.convert === 'function') resolve(global.SvgImport);
          else reject(new Error('SVG 转换模块未正确加载'));
        };
        script.onerror = function () { reject(new Error('无法加载 SVG 转换模块')); };
        document.head.appendChild(script);
      });
    }
    return svgImportPromise;
  }

  function app() {
    if (!global.App || !global.App.doc || typeof global.App.commit !== 'function') {
      throw new Error('当前文档尚未就绪');
    }
    return global.App;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function toast(text, error) {
    if (global.Ui && typeof global.Ui.toast === 'function') {
      global.Ui.toast(text, { type: error ? 'error' : 'info' });
    } else if (global.App && typeof global.App.status === 'function') {
      global.App.status(text);
    }
  }

  function selectedCharts() {
    var current = app();
    var byId = {};
    (current.doc.elements || []).forEach(function (element) { byId[element.id] = element; });
    var ids = typeof current.selection === 'function' ? current.selection() : [];
    return ids.map(function (id) { return byId[id]; })
      .filter(function (element) { return element && element.type === 'chart'; });
  }

  function isolatedChart(doc, element) {
    if (!global.ChartRender || typeof global.ChartRender.elementSVG !== 'function') {
      throw new Error('缺少图表渲染模块');
    }
    var box = global.ChartRender.resolveBoxMm(doc, element);
    var chart = clone(element);
    chart.parent_id = null;
    chart.transform = { x: box.x, y: box.y, w: box.w, h: box.h, rotation: 0 };
    chart.style = Object.assign({}, chart.style || {}, { panelRelative: false });
    var isolated = {
      schema_version: doc.schema_version,
      id: doc.id,
      title: doc.title,
      canvas: clone(doc.canvas),
      elements: [chart],
      anchors: [],
      panels: [],
      history: [],
      meta: clone(doc.meta || {})
    };
    return global.ChartRender.elementSVG(isolated, chart, { useBackend: false });
  }

  function barLabels(spec) {
    var type = spec.chartType;
    if (type !== 'bar' && type !== 'bar_grouped') return [];
    var data = spec.data && spec.data.inline;
    var columns = data && data.columns;
    var rows = data && data.rows;
    if (!Array.isArray(columns) || !Array.isArray(rows)) return [];
    var mapping = spec.mapping || {};
    var xi = columns.indexOf(mapping.x);
    var yi = columns.indexOf(mapping.y);
    var gi = columns.indexOf(mapping.group);
    var labels = [];
    var cats = [];
    var groups = type === 'bar' ? [''] : [];
    var catIndex = {};
    var cells = {};
    rows.forEach(function (row) {
      if (!Array.isArray(row) || row[xi] === null || row[xi] === '' || !isFinite(Number(row[yi]))) return;
      var x = String(row[xi]);
      if (catIndex[x] === undefined) { catIndex[x] = cats.length; cats.push(x); }
      var group = type === 'bar_grouped' && gi >= 0 && row[gi] != null ? String(row[gi]) : '';
      if (type === 'bar_grouped' && groups.indexOf(group) < 0) groups.push(group);
      var ci = catIndex[x];
      var g = type === 'bar_grouped' ? groups.indexOf(group) : 0;
      cells[ci + ':' + g] = true;
    });
    cats.forEach(function (x, ci) {
      groups.forEach(function (group, gi) {
        if (cells[ci + ':' + gi]) labels.push({ category: x, group: group });
      });
    });
    return labels;
  }

  function addBarNames(elements, sourceChart) {
    var labels = barLabels(sourceChart.chart || {});
    if (!labels.length) return;
    var bars = elements.filter(function (element) {
      var fill = element.style && element.style.fill;
      return element.type === 'rect' && fill && fill.toLowerCase() !== 'none';
    });
    labels.forEach(function (label, index) {
      var bar = bars[index];
      if (!bar) return;
      bar.name = '柱子 ' + (index + 1) + ' · ' + label.category +
        (label.group ? ' / ' + label.group : '');
    });
  }

  function makeElements(elements, doc) {
    var used = {};
    (doc.elements || []).forEach(function (element) { used[element.id] = true; });
    var ids = {};
    var copies = elements.map(function (original) {
      var element = clone(original);
      var id = element.id;
      while (!id || used[id]) id = global.FigDoc.uid('svg');
      used[id] = true;
      ids[element.id] = id;
      element.id = id;
      return element;
    });
    copies.forEach(function (element) {
      if (element.parent_id != null) element.parent_id = ids[element.parent_id];
      if (Array.isArray(element.children)) {
        element.children = element.children.map(function (id) { return ids[id]; });
      }
    });
    var byId = {};
    copies.forEach(function (element) { byId[element.id] = element; });
    copies.forEach(function (element) {
      if (Array.isArray(element.children)) {
        element.children = element.children.filter(function (id) {
          return byId[id] && byId[id].parent_id === element.id;
        });
      }
    });
    return copies;
  }

   function confirmSplit(count) {
    var text = '将选中的 ' + count + ' 个图表拆为独立形状与文本。每根柱子、坐标轴和图例都可分别编辑。\n\n' +
      '原始图表配置会保存在新分组的来源信息里，但拆分后不再根据原始数据自动重绘。此操作可通过撤销完整恢复。';
    if (global.Ui && typeof global.Ui.confirm === 'function') return global.Ui.confirm(text);
    return Promise.resolve(true);
  }

  function explodeSelection() {
    var charts;
    try { charts = selectedCharts(); } catch (err) {
      toast(err.message, true);
      return Promise.reject(err);
    }
    if (!charts.length) {
      var error = new Error('请先在画布中选中一个图表，再点击「拆为图元」');
      toast(error.message, true);
      return Promise.reject(error);
    }
    return confirmSplit(charts.length).then(function (accepted) {
      if (!accepted) return { applied: 0 };
      var current = app();
      var doc = current.doc;
      return loadSvgImport().then(function () {
        var ops = [];
        var count = 0;
        charts.forEach(function (source) {
          var box = global.ChartRender.resolveBoxMm(doc, source);
          var fragment = isolatedChart(doc, source);
          if (/data-render=["']placeholder["']/.test(fragment)) {
            throw new Error(source.id + ' 暂时不能由前端拆分为真实图元，请先导出 SVG 后再逐元素导入');
          }
          var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' +
            doc.canvas.width_mm + 'mm" height="' + doc.canvas.height_mm + 'mm" viewBox="0 0 ' +
            doc.canvas.width_mm + ' ' + doc.canvas.height_mm + '">' + fragment + '</svg>';
          var children = makeElements(global.SvgImport.convert(svg).elements, doc);
          addBarNames(children, source);
          var childIds = children.filter(function (child) { return child.parent_id == null; })
            .map(function (child) { return child.id; });
          var group = {
            id: global.FigDoc.uid('group'),
            name: (source.name || source.chart.chartType) + ' · 可编辑图元',
            type: 'group',
            parent_id: source.parent_id || null,
            transform: { x: box.x, y: box.y, w: box.w, h: box.h, rotation: source.transform.rotation || 0 },
            children: childIds,
            style: { panelRelative: false },
            source_element_id: source.id,
            source_chart: clone(source)
          };
          children.forEach(function (child) {
            if (child.parent_id == null) child.parent_id = group.id;
          });
          ops.push({ op: 'delete', targets: [source.id] });
          ops.push({ op: 'add_element', element: group });
          children.forEach(function (child) { ops.push({ op: 'add_element', element: child }); });
          ops.push({
            op: 'note',
            note: '图表拆分来源 ' + source.id + '；原始 spec/data 保存在 ' + group.id + '.source_chart'
          });
          count += children.length;
        });
        return current.commit(ops, { label: '拆分为独立图元', source: 'user' }).then(function (result) {
          if (!result || !result.applied) throw new Error('拆分操作未通过文档校验，未修改图表');
          var firstGroup = ops.filter(function (op) {
            return op.op === 'add_element' && op.element.type === 'group';
          })[0];
          if (firstGroup) current.select([firstGroup.element.id]);
          toast('已拆分为 ' + count + ' 个可编辑元素；原始配置已保留，可随时撤销');
          return { applied: result.applied, elements: count };
        });
      });
    }).catch(function (err) {
      toast('拆分失败：' + (err && err.message ? err.message : err), true);
      throw err;
    });
  }

  function mount() {
    var button = document.getElementById('btn-explode-chart');
    if (!button || button.getAttribute('data-chart-edit-bound')) return;
    button.setAttribute('data-chart-edit-bound', '1');
    button.addEventListener('click', function () { explodeSelection().catch(function () {}); });
    function update() {
      try { button.disabled = selectedCharts().length === 0; }
      catch (err) { button.disabled = true; }
    }
    global.App.on('selection:changed', update);
    global.App.on('doc:changed', update);
    update();
  }

  global.ChartEdit = {
    mount: mount,
    explodeSelection: explodeSelection,
    selectedCharts: selectedCharts
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
