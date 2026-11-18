/* compose.js — R8 组图：把当前/其他标签页的图表、图片、组组合成
 * 带子图字母的论文大图（外层 panel 网格 → 子 panel 字母 → 内容元素）。
 *
 * 公开 API：
 *   Compose.open({ids})              组图对话框；ids 预选当前标签元素
 *   Compose.editPanel(panelId)       编辑已有组图排版（版式/字母/调序）
 *   Compose.dissolve(panelId)        解散组图（子元素保留原位，一次提交）
 *   Compose.placeIntoCell(chartId)   复合模板空格「放入图表…」
 *   Compose.isComposition(el)        判定是否为组图外层 panel
 *   Compose.isEmptyCell(el)          判定是否为可放入的空版式格
 */
(function (global) {
  "use strict";

  var SRC_TYPES = { chart: 1, image: 1, group: 1 };
  var LAYOUT_PRESETS = [
    { id: "auto", name: "自动（按数量）" },
    { id: "1xn", name: "1×N 横排" },
    { id: "nx1", name: "N×1 竖排" },
    { id: "2x2", name: "2×2" },
    { id: "2x3", name: "2×3" },
    { id: "3x2", name: "3×2" },
    { id: "3x3", name: "3×3" },
    { id: "top2", name: "上一大两小" },
    { id: "left2", name: "左大右二" },
    { id: "top3", name: "上一大三小" },
    { id: "custom", name: "自定义行列" }
  ];
  var ASPECTS = [
    { id: "4:3", name: "4:3", value: 4 / 3 },
    { id: "1:1", name: "1:1", value: 1 },
    { id: "3:2", name: "3:2", value: 3 / 2 },
    { id: "16:9", name: "16:9", value: 16 / 9 }
  ];
  var LABEL_FMTS = [
    { id: "a", name: "a" }, { id: "(a)", name: "(a)" },
    { id: "A", name: "A" }, { id: "(A)", name: "(A)" },
    { id: "a)", name: "a)" }
  ];
  var LABEL_POS = [
    { id: "top-left", name: "左上外侧" },
    { id: "inside-top-left", name: "左上内侧" }
  ];
  var FALLBACK_WIDTHS = { single: 89, "1.5": 120, double: 183 };

  // ------------------------------------------------------------------
  // 基础工具
  // ------------------------------------------------------------------

  function app() { return global.App; }
  function doc() { return global.App && global.App.doc; }
  function figdoc() { return global.FigDoc; }
  function figops() { return global.FigOps; }
  function figrender() { return global.FigRender; }
  function ui() { return global.Ui; }
  function uid(prefix) {
    var F = figdoc();
    if (F && typeof F.uid === "function") return F.uid(prefix);
    return (prefix || "el") + "-" + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);
  }
  function copy(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function elById(d, id) {
    var els = (d && d.elements) || [];
    for (var i = 0; i < els.length; i++) if (els[i] && els[i].id === id) return els[i];
    return null;
  }
  function typeName(el) {
    if (global.FigDoc && typeof FigDoc.elementTypeName === "function") {
      try { return FigDoc.elementTypeName(el.type); } catch (e) { /* fall */ }
    }
    return { chart: "图表", image: "图片", group: "组" }[el.type] || el.type;
  }
  function elLabel(el) {
    if (el.name && String(el.name).trim()) return String(el.name).trim();
    if (el.chart && el.chart.chartType) return typeName(el) + "·" + el.chart.chartType;
    return typeName(el);
  }

  // ------------------------------------------------------------------
  // 来源收集：当前标签（顶层 chart/image/group）+ 其他标签页
  // ------------------------------------------------------------------

  function eligible(el) {
    return !!(el && SRC_TYPES[el.type] && !el.parent_id &&
      el.transform && el.transform.w > 0 && el.transform.h > 0);
  }

  function currentSources(includeCanvas) {
    var d = doc();
    if (!d) return [];
    var sources = (d.elements || []).filter(eligible).map(function (el) {
      return { kind: "current", tabId: d.id, tabTitle: d.title || "当前画布",
        el: el, srcDoc: d };
    });
    if (!includeCanvas) (d.elements || []).forEach(function (el) {
      if (el.parent_id && el.type === "chart" && !isEmptyCell(el)) {
        sources.push({kind:"current", tabId:d.id, tabTitle:d.title, el:el, srcDoc:d});
      }
    });
    if (includeCanvas && needsCanvasSource(d, sources)) sources.unshift(canvasSource(d));
    return sources;
  }

  function needsCanvasSource(d, sources) {
    return d.elements.length && !(sources.length === 1 && d.elements.filter(function (el) { return !el.parent_id; }).length === 1);
  }

  // A canvas can contain several independent roots (e.g. template panel and title).
  // Wrap a copy so the source tab and its native editable elements survive placement.
  function canvasSource(d) {
    var roots = d.elements.filter(function (el) { return !el.parent_id; });
    var wrapper = {id:uid("canvas"), type:"group", name:"整张画布 · " + (d.title || "未命名"),
      transform:{x:0, y:0, w:d.canvas.width_mm, h:d.canvas.height_mm, rotation:0},
      children:roots.map(function (el) { return el.id; }), style:{}};
    var nodes = d.elements.map(function (el) { return el.parent_id ? el : Object.assign({}, el, {parent_id:wrapper.id}); });
    return {kind:"tab", tabId:d.id, tabTitle:d.title, el:wrapper,
      srcDoc:Object.assign({}, d, {elements:[wrapper].concat(nodes)})};
  }

  var _tabsCache = { at: 0, tabs: [] };

  function fetchTabs() {
    if (typeof fetch !== "function") return Promise.resolve([]);
    return fetch("/api/tabs", { cache: "no-store" }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { _tabsCache = { at: Date.now(), tabs: j.tabs || [] }; }
        return (j && j.ok) ? (j.tabs || []) : [];
      }).catch(function () { return []; });
  }

  function fetchTabSources() {
    var d = doc();
    var curId = d && d.id;
    return fetchTabs().then(function (tabs) {
      var jobs = tabs.filter(function (t) { return t.id !== curId; }).map(function (t) {
        return fetch("/api/tabs/doc?id=" + encodeURIComponent(t.id), { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || !j.ok || !j.doc) return null;
            var out = [];
            (j.doc.elements || []).forEach(function (el) {
              if (eligible(el)) {
                out.push({ kind: "tab", tabId: t.id, tabTitle: t.title || t.id,
                  el: el, srcDoc: j.doc });
              }
            });
            if (needsCanvasSource(j.doc, out)) {
              out.unshift(canvasSource(j.doc));
            }
            return out.length ? { tab: t, sources: out } : null;
          }).catch(function () { return null; });
      });
      return Promise.all(jobs).then(function (groups) {
        var flat = [];
        groups.forEach(function (g) {
          if (g) g.sources.forEach(function (s) { flat.push(s); });
        });
        return flat;
      });
    });
  }

  // ------------------------------------------------------------------
  // 缩略图：FigRender.elementToSVG 真实渲染 → data-uri <img>
  // ------------------------------------------------------------------

  function thumbFor(src) {
    try {
      var R = figrender(), F = figdoc();
      if (!R || typeof R.elementToSVG !== "function" || !F ||
          typeof F.bbox !== "function") return null;
      var bb = F.bbox(src.srcDoc, src.el.id, { recursive: true });
      if (!bb || !(bb.w > 0) || !(bb.h > 0)) return null;
      var m = Math.max(bb.w, bb.h) * 0.06 + 1;
      var frag = R.elementToSVG(src.srcDoc, src.el, {});
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
        (bb.x - m).toFixed(2) + " " + (bb.y - m).toFixed(2) + " " +
        (bb.w + 2 * m).toFixed(2) + " " + (bb.h + 2 * m).toFixed(2) + '">' +
        frag + "</svg>";
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------
  // 版式：预设 → {cols, rows, areas}
  // ------------------------------------------------------------------

  function gridFor(layoutId, n, customRows, customCols) {
    n = Math.max(1, n);
    function grow(cols, rows) {
      while (cols * rows < n) rows++;
      return { cols: cols, rows: rows };
    }
    switch (layoutId) {
      case "1xn": return { cols: n, rows: 1 };
      case "nx1": return { cols: 1, rows: n };
      case "2x2": return grow(2, 2);
      case "2x3": return grow(3, 2);   // 2 行 3 列
      case "3x2": return grow(2, 3);   // 3 行 2 列
      case "3x3": return grow(3, 3);
      case "top2": {
        var r2 = 1 + Math.ceil(Math.max(0, n - 1) / 2);
        return { cols: 2, rows: r2,
          areas: [{ col: 0, row: 0, colSpan: 2, rowSpan: 1 }] };
      }
      case "left2": {
        var rL = Math.ceil((n + 1) / 2);
        return { cols: 2, rows: rL,
          areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 2 }] };
      }
      case "top3": {
        var r3 = 1 + Math.ceil(Math.max(0, n - 1) / 3);
        return { cols: 3, rows: r3,
          areas: [{ col: 0, row: 0, colSpan: 3, rowSpan: 1 }] };
      }
      case "custom": {
        var cc = Math.max(1, Math.floor(customCols) || 2);
        var cr = Math.max(1, Math.floor(customRows) || 2);
        return grow(cc, cr);
      }
      case "auto":
      default:
        if (n <= 1) return { cols: 1, rows: 1 };
        if (n === 2) return { cols: 2, rows: 1 };
        if (n === 3) return { cols: 2, rows: 2,
          areas: [{ col: 0, row: 0, colSpan: 2, rowSpan: 1 }] };
        if (n <= 4) return { cols: 2, rows: 2 };
        if (n <= 6) return { cols: 3, rows: 2 };
        if (n <= 9) return { cols: 3, rows: 3 };
        return grow(Math.ceil(Math.sqrt(n)), Math.ceil(n / Math.ceil(Math.sqrt(n))));
    }
  }

  function letterFor(i, fmt) {
    var base;
    if (i < 26) base = String.fromCharCode(97 + i);
    else if (i < 26 * 27) base = String.fromCharCode(97 + Math.floor(i / 26) - 1) +
      String.fromCharCode(97 + (i % 26));
    else base = String(i + 1);
    if (fmt === "(a)") return "(" + base + ")";
    if (fmt === "A") return base.toUpperCase();
    if (fmt === "(A)") return "(" + base.toUpperCase() + ")";
    if (fmt === "a)") return base + ")";
    return base;
  }

  // placements[i] = {col,row,colSpan,rowSpan, rx,ry,rw,rh}（相对坐标 0..1）
  function placementsFor(grid, n, cellW, cellH, gap, W, H) {
    var innerW = W, innerH = H; // padding_mm = 0
    var occupied = {};
    function key(c, r) { return c + "," + r; }
    function freeCell(a) {
      for (var r = a.row; r < a.row + a.rowSpan; r++)
        for (var c = a.col; c < a.col + a.colSpan; c++)
          if (occupied[key(c, r)]) return false;
      return true;
    }
    function mark(a) {
      for (var r = a.row; r < a.row + a.rowSpan; r++)
        for (var c = a.col; c < a.col + a.colSpan; c++) occupied[key(c, r)] = true;
    }
    function firstFree() {
      for (var r = 0; r < grid.rows; r++)
        for (var c = 0; c < grid.cols; c++)
          if (!occupied[key(c, r)]) return { col: c, row: r };
      return { col: 0, row: 0 };
    }
    var areas = Array.isArray(grid.areas) ? grid.areas : [];
    var ai = 0, out = [];
    for (var i = 0; i < n; i++) {
      var a = null;
      while (ai < areas.length) {
        if (freeCell(areas[ai])) { a = areas[ai]; ai++; break; }
        ai++;
      }
      var p;
      if (a) { mark(a); p = { col: a.col, row: a.row, colSpan: a.colSpan, rowSpan: a.rowSpan }; }
      else {
        var fc = firstFree(); mark({ col: fc.col, row: fc.row, colSpan: 1, rowSpan: 1 });
        p = { col: fc.col, row: fc.row, colSpan: 1, rowSpan: 1 };
      }
      var px = p.col * (cellW + gap);
      var pw = p.colSpan * cellW + (p.colSpan - 1) * gap;
      var py = p.row * (cellH + gap);
      var ph = p.rowSpan * cellH + (p.rowSpan - 1) * gap;
      out.push({ col: p.col, row: p.row, colSpan: p.colSpan, rowSpan: p.rowSpan,
        cellX: px, cellY: py, cellW: pw, cellH: ph,
        rx: px / innerW, ry: py / innerH, rw: pw / innerW, rh: ph / innerH });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 元素子树克隆：current 保留原 id（移动语义），tab 换新 id
  // ------------------------------------------------------------------

  function subtreeIds(d, rootId) {
    // 父先子后扁平序
    var out = [], seen = {};
    function walk(id) {
      if (seen[id]) return; seen[id] = true;
      var el = elById(d, id); if (!el) return;
      out.push(el.id);
      (el.children || []).forEach(walk);
    }
    walk(rootId);
    return out;
  }

  function cloneSubtree(src, keepIds) {
    // 返回扁平元素数组（父先子后）。keepIds=true 保留全部原 id。
    var ids = subtreeIds(src.srcDoc, src.el.id);
    var idMap = {};
    ids.forEach(function (id) { idMap[id] = keepIds ? id : uid("el"); });
    var out = [];
    ids.forEach(function (id) {
      var el = elById(src.srcDoc, id);
      var c = copy(el);
      c.id = idMap[id];
      if (c.parent_id != null) c.parent_id = idMap[c.parent_id] || null;
      if (Array.isArray(c.children)) {
        c.children = c.children.map(function (cid) { return idMap[cid]; })
          .filter(function (cid) { return !!cid; });
      }
      if (!keepIds) {
        ["label_element_id", "relation_label_for"].forEach(function (key) {
          if (idMap[c[key]]) c[key] = idMap[c[key]];
        });
        if (c.relation) ["source", "target"].forEach(function (key) {
          if (idMap[c.relation[key]]) c.relation[key] = idMap[c.relation[key]];
        });
      }
      out.push(c);
    });
    return out;
  }

  // group 内容：把后代 transform 从旧包围盒线性映射进目标矩形（绝对 mm）。
  // bbox 必须在源文档上按原始 id 计算（克隆可能已换新 id）。
  function fitGroupIntoRect(nodes, srcDoc, srcRootId, rect) {
    var bb = figdoc().bbox(srcDoc, srcRootId, { recursive: true });
    figdoc().fitElements(nodes, bb, rect);
  }

  // ------------------------------------------------------------------
  // 结构构建：外层 panel + 子 panel（字母）+ 内容
  // ------------------------------------------------------------------

  function journalInfo() {
    var p = null;
    try { if (global.App && typeof App.currentJournal === "function") p = App.currentJournal(); } catch (e) { /* */ }
    var basePt = (p && p.base_font_pt) || 8;
    var font = (p && p.font_family) || "Arial";
    var widths = copy(FALLBACK_WIDTHS);
    try {
      var list = (global.FigPresets && typeof FigPresets.journals === "function")
        ? (FigPresets.journals() || []) : [];
      var curId = p && p.id;
      var base = curId ? String(curId).replace(/-(single|double|1\.5col|full)$/i, "") : null;
      function findW(suf) {
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          if (it && it.width_mm &&
              (it.id === (base || "") + suf || (curId && it.id === curId && suf === "-double"))) {
            // exact sibling match only
          }
        }
        return null;
      }
      if (base) {
        var s = null, d = null, m = null;
        list.forEach(function (it) {
          if (!it || !it.width_mm) return;
          if (it.id === base + "-single" || it.id === base) s = it.width_mm;
          if (it.id === base + "-double") d = it.width_mm;
          if (/1\.5|1-5/.test(it.id) && it.id.indexOf(base) === 0) m = it.width_mm;
        });
        if (curId && /single$/i.test(curId)) s = p.width_mm;
        if (curId && /double$/i.test(curId)) d = p.width_mm;
        if (curId && /1\.5/i.test(curId)) m = p.width_mm;
        if (s) widths.single = s;
        if (m) widths["1.5"] = m;
        if (d) widths.double = d;
      }
    } catch (e) { /* fallback widths */ }
    return { basePt: basePt, font: font, widths: widths, journal: p };
  }

  function buildStructure(sel, cfg) {
    var ji = journalInfo();
    cfg = cfg || {};
    var n = sel.length;
    var grid = gridFor(cfg.layout || "auto", n, cfg.rows, cfg.cols);
    var W = cfg.width || ji.widths.single;
    var gap = cfg.gap != null ? cfg.gap : 3;
    var aspect = cfg.aspect || (4 / 3);
    var cellW = Math.max(5, (W - (grid.cols - 1) * gap) / grid.cols);
    var cellH = cellW / aspect;
    var H = grid.rows * cellH + (grid.rows - 1) * gap;
    var OX = cfg.x != null ? cfg.x : 5;
    var OY = cfg.y != null ? cfg.y : 5;
    var inside = cfg.labelPos === "inside-top-left";
    var childPad = inside ? 4.0 : 1.0;
    var labelPt = cfg.labelPt != null ? cfg.labelPt : ji.basePt + 1;
    var fontFamily = cfg.fontFamily || ji.font;

    var outerId = uid("panel");
    var outer = {
      id: outerId, type: "panel", name: "组图",
      transform: { x: OX, y: OY, w: W, h: H, rotation: 0 },
      style: {}, z: (cfg.zBase || 0) + 1, parent_id: null,
      children: [],
      panelLayout: {
        cols: grid.cols, rows: grid.rows, gap_mm: gap, padding_mm: 0,
        label: "", labelStyle: {}, labelPosition: "top-left"
      }
    };
    if (grid.areas && grid.areas.length) outer.panelLayout.areas = copy(grid.areas);
    var elements = [outer];
    var placements = placementsFor(grid, n, cellW, cellH, gap, W, H);
    var chartIds = [];
    var rowOf = [];

    sel.forEach(function (s, i) {
      var p = placements[i];
      var cid = uid("panel");
      var letter = letterFor(i, cfg.labelFmt || "a");
      // 子 panel 用绝对 mm（与 relayoutPanelChildren 对非 panelRelative
      // 子元素的写法一致）：panelRelative 全库只解析一层，子 panel 若也
      // 用相对坐标，格内图表会解析到错误的父框。格内内容仍 panelRelative。
      var cpanel = {
        id: cid, type: "panel", name: "子图 " + letter,
        transform: { x: OX + p.cellX, y: OY + p.cellY,
          w: p.cellW, h: p.cellH, rotation: 0 },
        style: {}, z: (cfg.zBase || 0) + 2 + i,
        parent_id: outerId, children: [],
        panelLayout: {
          cols: 1, rows: 1, gap_mm: 0, padding_mm: childPad,
          label: letter,
          labelStyle: {
            fontSizePt: labelPt, fontFamily: fontFamily,
            fontWeight: cfg.labelBold === false ? "normal" : "bold",
            fill: "#000000"
          },
          labelPosition: inside ? "inside-top-left" : "top-left"
        }
      };
      elements.push(cpanel);
      outer.children.push(cid);

      if (!s) {
        var slot = {id:uid("slot"), name:"子图 " + letter, type:"chart", chart:{},
          parent_id:cid, style:{panelRelative:true}, transform:{x:0,y:0,w:1,h:1,rotation:0}, z:1};
        cpanel.children.push(slot.id);
        elements.push(slot);
        return;
      }
      var keepIds = s.kind === "current";
      var nodes = cloneSubtree(s, keepIds);
      var contentRoot = nodes[0];
      var absRect = null;
      if (s.el.type === "group") {
        // group 子树用绝对 mm：内容区 = 子 panel 内边距后的矩形
        var pad = childPad;
        absRect = {
          x: OX + p.cellX + pad, y: OY + p.cellY + pad,
          w: Math.max(0.1, p.cellW - 2 * pad),
          h: Math.max(0.1, p.cellH - 2 * pad)
        };
        fitGroupIntoRect(nodes, s.srcDoc, s.el.id, absRect);
        contentRoot.parent_id = cid;
        contentRoot.style = contentRoot.style || {};
        contentRoot.style.panelRelative = false;
        contentRoot.transform = { x: absRect.x, y: absRect.y,
          w: absRect.w, h: absRect.h, rotation: 0 };
      } else {
        contentRoot.parent_id = cid;
        contentRoot.style = contentRoot.style || {};
        contentRoot.style.panelRelative = true;
        contentRoot.transform = { x: 0, y: 0, w: 1, h: 1, rotation: 0 };
      }
      // 父面板 children 引用已在克隆时重映射；确保 contentRoot 在 cpanel.children
      cpanel.children.push(contentRoot.id);
      nodes.forEach(function (nd) { elements.push(nd); });
      if (contentRoot.type === "chart") {
        chartIds.push(contentRoot.id);
        rowOf.push(p.row);
      } else if (contentRoot.type === "group") {
        nodes.forEach(function (nd) {
          if (nd.type === "chart") { chartIds.push(nd.id); rowOf.push(p.row); }
        });
      }
    });
    return { elements: elements, rootId: outerId, W: W, H: H, grid: grid,
      ox: OX, oy: OY,
      chartIds: chartIds, rowOf: rowOf, placements: placements };
  }

  // ------------------------------------------------------------------
  // 统一选项 → ops（在结构元素 id 上操作）
  // ------------------------------------------------------------------

  function unifyOps(struct, cfg, baseDoc) {
    var ops = [];
    var chartIds = struct.chartIds || [];
    if (!chartIds.length) return ops;
    if (cfg.unifyColors !== false) {
      try {
        var FO = figops();
        if (FO && typeof FO.unifySeriesColors === "function") {
          var pal = baseDoc && baseDoc.meta && baseDoc.meta.palette_id;
          var tmp = { elements: struct.elements };
          var res = FO.unifySeriesColors(tmp, pal ? { palette_id: pal } : {});
          (res.ops || []).forEach(function (o) { ops.push(o); });
        }
      } catch (e) { /* 统一颜色失败不阻塞组图 */ }
    }
    if (cfg.styleId) {
      ops.push({ op: "apply_chart_style", targets: chartIds.slice(), style_id: cfg.styleId });
    }
    if (cfg.unifyFont !== false) {
      var ji = journalInfo();
      var pt = ji.basePt;
      ops.push({ op: "set_style", targets: chartIds.slice(),
        style: { fontSizePt: pt } });
      chartIds.forEach(function (id) {
        ops.push({ op: "set_chart_properties", targets: [id],
          properties: { presentation: { version: 1,
            axes: {
              x: { title: { fontSizePt: pt }, tick: { fontSizePt: pt } },
              y: { title: { fontSizePt: pt }, tick: { fontSizePt: pt } }
            },
            legend: { fontSizePt: pt } } } });
      });
    }
    if (cfg.sameRowY) {
      var ranges = sameRowYRanges(struct, baseDoc);
      Object.keys(ranges).forEach(function (row) {
        var r = ranges[row];
        r.ids.forEach(function (id) {
          ops.push({ op: "set_chart_properties", targets: [id],
            properties: { axes: { yMin: r.min, yMax: r.max } } });
        });
      });
    }
    return ops;
  }

  // 同行统一 Y：按 chart.mapping.y + characterization.curves 列收数值
  function sameRowYRanges(struct, baseDoc) {
    var byRow = {};
    var allById = {};
    struct.elements.forEach(function (nd) { allById[nd.id] = nd; });
    (struct.chartIds || []).forEach(function (id, i) {
      var el = allById[id];
      if (!el || el.type !== "chart" || !el.chart) return;
      var cols = yColumnsOf(el.chart);
      if (!cols.length) return;
      var rows = el.chart.data && el.chart.data.inline &&
        el.chart.data.inline.rows;
      var names = el.chart.data && el.chart.data.inline &&
        el.chart.data.inline.columns;
      if (!Array.isArray(rows) || !rows.length || !Array.isArray(names)) return;
      var idx = cols.map(function (c) { return names.indexOf(c); })
        .filter(function (x) { return x >= 0; });
      if (!idx.length) return;
      var lo = Infinity, hi = -Infinity;
      rows.forEach(function (row) {
        idx.forEach(function (ci) {
          var v = row[ci];
          if (typeof v === "number" && isFinite(v)) {
            if (v < lo) lo = v; if (v > hi) hi = v;
          }
        });
      });
      if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return;
      var rowKey = String(struct.rowOf ? struct.rowOf[i] : 0);
      var slot = byRow[rowKey] || (byRow[rowKey] = { min: Infinity, max: -Infinity, ids: [] });
      if (lo < slot.min) slot.min = lo;
      if (hi > slot.max) slot.max = hi;
      slot.ids.push(id);
    });
    var out = {};
    Object.keys(byRow).forEach(function (k) {
      var s = byRow[k];
      if (s.ids.length < 2) return; // 同行只有 1 张图无需统一
      var pad = (s.max - s.min) * 0.03 || 0.01;
      out[k] = { min: s.min - pad, max: s.max + pad, ids: s.ids };
    });
    return out;
  }

  function yColumnsOf(chart) {
    var cols = [];
    function add(c) { if (typeof c === "string" && c && cols.indexOf(c) < 0) cols.push(c); }
    var m = chart.mapping || {};
    if (typeof m.y === "string") add(m.y);
    else if (Array.isArray(m.y)) m.y.forEach(add);
    var ch = chart.characterization;
    if (ch && Array.isArray(ch.curves)) {
      ch.curves.forEach(function (cv) { if (cv) add(cv.column); });
    }
    return cols;
  }

  // ------------------------------------------------------------------
  // 提交：当前画布（一次 commit）/ 新标签（先删源再 tabs/new）
  // ------------------------------------------------------------------

  function canvasFitOps(struct) {
    var d = doc();
    var cv = (d && d.canvas) || {};
    var needW = struct.W + 10, needH = struct.H + 10;
    if ((cv.width_mm || 0) >= needW && (cv.height_mm || 0) >= needH) return [];
    return [{ op: "set_canvas", canvas: {
      width_mm: Math.max(cv.width_mm || 0, needW),
      height_mm: Math.max(cv.height_mm || 0, needH) } }];
  }

  // 组图超界三向选择：fit=扩画布 / keep=保持画布原位放置 / cancel=放弃
  function askCanvasFit(needW, needH, cv) {
    var U = global.Ui;
    if (!U || typeof U.modal !== "function") return Promise.resolve("fit");
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      U.modal({
        title: "组图超出当前画布",
        body: "组图约需 " + needW.toFixed(0) + " × " + needH.toFixed(0) +
          " mm，当前画布 " + (cv.width_mm || 0).toFixed(0) + " × " +
          (cv.height_mm || 0).toFixed(0) + " mm。",
        actions: [
          { label: "取消", variant: "ghost",
            onClick: function () { finish("cancel"); return true; } },
          { label: "保持画布直接组图",
            onClick: function () { finish("keep"); return true; } },
          { label: "画布适配组图", primary: true,
            onClick: function () { finish("fit"); return true; } }
        ],
        onClosed: function () { finish("cancel"); }
      });
    });
  }

  function commitCurrent(sel, cfg) {
    var d = doc();
    if (!d) return Promise.reject(new Error("没有当前文档"));
    var struct = buildStructure(sel, cfg);
    var ops = [];
    sel.forEach(function (s) {
      if (s.kind === "current") ops.push({ op: "delete", targets: [s.el.id] });
    });
    struct.elements.forEach(function (el) {
      ops.push({ op: "add_element", element: el });
    });
    // R8b：组图超界时默认随内容扩画布；cfg.skipCanvasFit（用户选「保持
    // 画布直接组图」）时跳过扩画布，元素按原坐标放置可能越界。
    if (!cfg.skipCanvasFit) ops = ops.concat(canvasFitOps(struct));
    ops = ops.concat(unifyOps(struct, cfg, d));
    if (!ops.length) return Promise.resolve(null);
    return global.App.commit(ops, { label: "组成组图", source: "user" });
  }

  function newDocFor(struct, cfg, tabTitle) {
    var d = doc() || {};
    var cv = copy(d.canvas || {});
    // R8b：新标签画布收紧到组图内容 + 边距（原 Math.max 保留旧画布
    // 最小 90mm，矮组图下方大片空白）。
    cv.width_mm = Math.max((struct.ox || 5) + struct.W + 8, 30);
    cv.height_mm = Math.max((struct.oy || 5) + struct.H + 8, 30);
    if (!cv.dpi) cv.dpi = 300;
    if (!cv.background) cv.background = "#FFFFFF";
    var now = new Date().toISOString();
    var prov = [];
    (cfg.sources || []).forEach(function (s) {
      prov.push({ ts: now, actor: "user", action: "compose",
        detail: s.kind === "current"
          ? "从当前画布移入组图"
          : "从标签「" + (s.tabTitle || s.tabId) + "」复制" });
    });
    return {
      schema_version: "1.0",
      id: uid("doc"),
      title: tabTitle || "组图",
      canvas: cv,
      elements: struct.elements,
      panels: [], anchors: [],
      history: [],
      meta: { created: now, updated: now, provenance: prov }
    };
  }

  function applyUnifyToDoc(newDoc, struct, cfg, baseDoc) {
    var ops = unifyOps(struct, cfg, baseDoc);
    if (!ops.length) return newDoc;
    try {
      var FO = figops();
      if (FO && typeof FO.applyAll === "function") {
        var r = FO.applyAll(newDoc, ops, { label: "组图统一", source: "user" });
        return r && r.doc ? r.doc : newDoc;
      }
    } catch (e) { /* 统一选项失败仍返回结构文档 */ }
    return newDoc;
  }

  function commitNewTab(sel, cfg) {
    var d = doc();
    if (!d) return Promise.reject(new Error("没有当前文档"));
    var struct = buildStructure(sel, cfg);
    // 「组图 N」：已有 组图* 标签数 +1
    return fetchTabs().then(function (tabs) {
      var n = 1;
      tabs.forEach(function (t) {
        if (t.title && /^组图/.test(t.title)) {
          var m = /(\d+)\s*$/.exec(t.title);
          if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
        }
      });
      var title = "组图 " + n;
      cfg.sources = sel;
      var newDoc = newDocFor(struct, cfg, title);
      newDoc = applyUnifyToDoc(newDoc, struct, cfg, d);
      var check = figdoc().validate(newDoc);
      if (!check.ok) throw new Error("组图结构无效：" + check.errors.join("；"));
      var curIds = sel.filter(function (s) { return s.kind === "current"; })
        .map(function (s) { return s.el.id; });
      var go = function () {
        if (global.Tabs && typeof Tabs.newTab === "function") {
          return Tabs.newTab(newDoc);
        }
        return Promise.reject(new Error("标签页模块不可用"));
      };
      if (curIds.length) {
        // 先把当前画布来源删掉（移动语义），flush 后再建新标签
        return global.App.commit(
          curIds.map(function (id) { return { op: "delete", targets: [id] }; }),
          { label: "组图：移出元素", source: "user" })
          .then(go);
      }
      return go();
    });
  }

  // ------------------------------------------------------------------
  // 实时预览
  // ------------------------------------------------------------------

  var lastPreviewError = null;
  function previewSVG(sel, cfg) {
    lastPreviewError = null;
    try {
      var struct = buildStructure(sel, cfg);
      var d = doc() || {};
      var cv = copy(d.canvas || {});
      cv.width_mm = struct.W + 20; cv.height_mm = struct.H + 20;
      cv.dpi = 96; cv.background = "#FFFFFF";
      var tmp = { schema_version: "1.0", id: "compose-preview",
        canvas: cv, elements: struct.elements, panels: [], anchors: [],
        history: [], meta: {} };
      var R = figrender();
      if (!R || typeof R.toSVG !== "function") return null;
      return R.toSVG(tmp, {});
    } catch (e) {
      lastPreviewError = e && e.message ? String(e.message) : String(e);
      return null;
    }
  }

  // ------------------------------------------------------------------
  // 对话框 UI
  // ------------------------------------------------------------------

  function h(tag, attrs, children) { return global.Ui.h(tag, attrs, children); }
  function field(labelText, input) {
    return h("label", { class: "cp-field" }, [
      h("span", { class: "cp-field-label", text: labelText }), input]);
  }
  function numInput(val, attrs) {
    return h("input", Object.assign({ type: "number", step: "any", value: val }, attrs || {}));
  }
  function selectInput(options, value, attrs) {
    var sel = h("select", attrs || {});
    options.forEach(function (o) {
      var op = h("option", { value: o.id, text: o.name });
      if (o.id === value) op.selected = true;
      sel.appendChild(op);
    });
    return sel;
  }
  function checkInput(checked, attrs) {
    return h("input", Object.assign({ type: "checkbox" }, attrs || {},
      checked ? { checked: true } : {}));
  }

  function readCfg(ui2) {
    var ji = journalInfo();
    var wKey = ui2.widthSel.value;
    var width = wKey === "custom" ? parseFloat(ui2.widthCustom.value)
      : ji.widths[wKey];
    if (!isFinite(width) || width <= 0) width = ji.widths.single;
    var rows = parseInt(ui2.rowsInput.value, 10);
    var cols = parseInt(ui2.colsInput.value, 10);
    var gap = parseFloat(ui2.gapInput.value);
    return {
      layout: ui2.layoutSel.value,
      rows: isFinite(rows) ? rows : 2,
      cols: isFinite(cols) ? cols : 2,
      width: width,
      aspect: ui2.aspectSel.value === "custom"
        ? parseFloat(ui2.aspectCustom.value) || (4 / 3)
        : parseFloat(ui2.aspectSel.value),
      gap: isFinite(gap) ? gap : 3,
      labelFmt: ui2.labelFmt.value,
      labelBold: ui2.labelBold.checked,
      labelPt: parseFloat(ui2.labelPt.value) || (ji.basePt + 1),
      labelPos: ui2.labelPos.value,
      fontFamily: ji.font,
      unifyFont: ui2.unifyFont.checked,
      styleId: ui2.styleSel.value || null,
      unifyColors: ui2.unifyColors.checked,
      sameRowY: ui2.sameRowY.checked,
      dest: ui2.destSel.value
    };
  }

  function styleOptions() {
    var out = [{ id: "", name: "保持各自风格" }];
    try {
      if (global.FigPresets && typeof FigPresets.styles === "function") {
        (FigPresets.styles() || []).forEach(function (s) {
          if (s && s.id) out.push({ id: s.id, name: s.name || s.id });
        });
      }
    } catch (e) { /* */ }
    return out;
  }

  function sourcePicker(onChange, single) {
    var wrap = h("div", { class: "cp-sources" });
    var listEl = h("div", { class: "cp-source-list" });
    var orderEl = h("div", { class: "cp-order-list" });
    var state = { items: [], selected: [] }; // selected: source refs in order

    function refreshThumbs() {
      // 缩略图异步填充：先放占位，渲染后回填
      state.items.forEach(function (it) {
        if (it.thumb) return;
        it.thumb = thumbFor(it);
      });
    }

    function renderList() {
      listEl.textContent = "";
      state.items.forEach(function (it, idx) {
        var cb = h("input", { type: "checkbox", "data-idx": idx });
        var inOrder = state.selected.indexOf(it) >= 0;
        cb.checked = inOrder;
        cb.addEventListener("change", function () {
          if (cb.checked) {
            if (single) state.selected = [it];
            else if (state.selected.indexOf(it) < 0) state.selected.push(it);
          } else {
            state.selected = state.selected.filter(function (x) { return x !== it; });
          }
          renderOrder(); renderListKeep(); onChange && onChange();
        });
        var thumb = h("span", { class: "cp-thumb" });
        if (it.thumb) thumb.appendChild(h("img", { src: it.thumb, alt: "" }));
        else thumb.textContent = typeName(it.el);
        var label = h("span", { class: "cp-src-label" }, [
          h("span", { class: "cp-src-name", text: elLabel(it.el) }),
          h("span", { class: "cp-src-tab", text: it.kind === "current" ? "当前画布" : "标签「" + it.tabTitle + "」" })
        ]);
        listEl.appendChild(h("label", { class: "cp-src-item" }, [cb, thumb, label]));
      });
      renderOrder();
    }

    function renderOrder() {
      orderEl.textContent = "";
      state.selected.forEach(function (it, i) {
        var mv = h("button", { class: "cp-mini", text: "↑", title: "上移", disabled: i === 0 });
        var mv2 = h("button", { class: "cp-mini", text: "↓", title: "下移",
          disabled: i === state.selected.length - 1 });
        mv.addEventListener("click", function () {
          state.selected.splice(i, 1); state.selected.splice(i - 1, 0, it);
          renderOrder(); renderListKeep(); onChange && onChange();
        });
        mv2.addEventListener("click", function () {
          state.selected.splice(i, 1); state.selected.splice(i + 1, 0, it);
          renderOrder(); renderListKeep(); onChange && onChange();
        });
        orderEl.appendChild(h("div", { class: "cp-order-item" }, [
          h("span", { class: "cp-order-idx", text: String(i + 1) }),
          h("span", { class: "cp-order-name", text: elLabel(it.el) +
            (it.kind === "tab" ? "（" + it.tabTitle + "）" : "") }), mv, mv2]));
      });
    }
    function renderListKeep() {
      // 只重建勾选状态，不重建整个列表（保留滚动）
      var cbs = listEl.querySelectorAll("input[type=checkbox]");
      cbs.forEach(function (cb, i) {
        cb.checked = state.selected.indexOf(state.items[i]) >= 0;
      });
    }

    wrap.appendChild(h("div", { class: "cp-picker-cols" }, [
      h("div", {}, [h("div", { class: "cp-sub", text: "可用图表 / 图片 / 组" }), listEl]),
      h("div", {}, [h("div", { class: "cp-sub", text: "子图位置（先从左到右，再从上到下）" }), orderEl])
    ]));

    function load(preIds) {
      listEl.textContent = "加载中…";
      orderEl.textContent = "";
      state.items = [];
      state.selected = [];
      var cur = currentSources(!single);
      return fetchTabSources().then(function (tabSrcs) {
        state.items = cur.concat(tabSrcs);
        refreshThumbs();
        // 预选
        (preIds || []).forEach(function (id) {
          var it = state.items.filter(function (x) {
            return x.kind === "current" && x.el.id === id; })[0];
          if (it && state.selected.indexOf(it) < 0) state.selected.push(it);
        });
        // 默认：当前选中项已由 preIds 处理；无 preIds 时不预选
        renderList();
      });
    }

    return { el: wrap, load: load, getSelected: function () { return state.selected.slice(); } };
  }

  function open(opts) {
    opts = opts || {};
    var U = ui();
    if (!U || typeof U.modal !== "function") return;
    var ji = journalInfo();
    var picker = sourcePicker(function () { refreshPreview(); });

    var layoutSel = selectInput(LAYOUT_PRESETS, "auto");
    var rowsInput = numInput(2, { min: "1" });
    var colsInput = numInput(2, { min: "1" });
    var widthSel = selectInput([
      { id: "single", name: "单栏 " + ji.widths.single + " mm" },
      { id: "1.5", name: "1.5 栏 " + ji.widths["1.5"] + " mm" },
      { id: "double", name: "双栏 " + ji.widths.double + " mm" },
      { id: "custom", name: "自定义…" }
    ], "single");
    var widthCustom = numInput(ji.widths.single, { min: "10", step: "1",
      style: { width: "70px", display: "none" } });
    widthSel.addEventListener("change", function () {
      widthCustom.style.display = widthSel.value === "custom" ? "" : "none";
    });
    var aspectSel = selectInput(ASPECTS.map(function (a) {
      return { id: String(a.value), name: a.name }; }), String(4 / 3));
    var gapInput = numInput(3, { min: "0", step: "0.5" });
    var labelFmt = selectInput(LABEL_FMTS, "a");
    var labelBold = checkInput(true);
    var labelPt = numInput(ji.basePt + 1, { min: "4", step: "0.5" });
    var labelPos = selectInput(LABEL_POS, "top-left");
    var unifyFont = checkInput(true);
    var styleSel = selectInput(styleOptions(), "");
    var unifyColors = checkInput(true);
    var sameRowY = checkInput(false);
    var destSel = selectInput([
      { id: "auto", name: "自动（含其他标签→新标签）" },
      { id: "newtab", name: "新标签「组图 N」" },
      { id: "current", name: "当前画布" }
    ], "auto");

    var ui2 = { layoutSel: layoutSel, rowsInput: rowsInput, colsInput: colsInput,
      widthSel: widthSel, widthCustom: widthCustom, aspectSel: aspectSel,
      gapInput: gapInput, labelFmt: labelFmt, labelBold: labelBold,
      labelPt: labelPt, labelPos: labelPos, unifyFont: unifyFont,
      styleSel: styleSel, unifyColors: unifyColors, sameRowY: sameRowY,
      destSel: destSel };

    function emptySlots(cfg) {
      var counts = {"2x2":4, "2x3":6, "3x2":6, "3x3":9, top2:3, left2:3, top3:4};
      var n = counts[cfg.layout] || (cfg.layout === "custom" ? cfg.rows * cfg.cols :
        cfg.layout === "1xn" ? cfg.cols : cfg.layout === "nx1" ? cfg.rows : 2);
      if (!Number.isInteger(n) || n < 1 || n > 100 || (cfg.layout === "custom" && (cfg.rows < 1 || cfg.cols < 1))) return [];
      return Array(n).fill(null);
    }
    var previewBox = h("div", { class: "cp-preview" });
    function refreshPreview() {
      var sel = picker.getSelected();
      var cfg = readCfg(ui2);
      if (!sel.length) sel = emptySlots(cfg);
      if (!sel.length) { previewBox.textContent = "请设置 1–100 个位置"; return; }
      var svg = previewSVG(sel, cfg);
      if (!svg) {
        var why = lastPreviewError
          ? String(lastPreviewError).replace(/^FigRender：/, "").slice(0, 90)
          : "未知原因";
        previewBox.innerHTML = '<div class="cp-preview-empty">预览生成失败：' +
          String(why).replace(/&/g, "&amp;").replace(/</g, "&lt;") +
          "</div>";
        return;
      }
      previewBox.innerHTML = svg;
      var svgEl = previewBox.querySelector("svg");
      if (svgEl) svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }

    var cfgInputs = [layoutSel, rowsInput, colsInput, widthSel, widthCustom,
      aspectSel, gapInput, labelFmt, labelBold, labelPt, labelPos,
      unifyFont, styleSel, unifyColors, sameRowY, destSel];
    cfgInputs.forEach(function (inp) {
      inp.addEventListener("input", refreshPreview);
      inp.addEventListener("change", refreshPreview);
    });
    var previewTimer = null;
    picker.el.addEventListener("change", function () {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(refreshPreview, 120);
    });

    var body = h("div", { class: "cp-dialog" }, [
      h("div", { class: "cp-cols" }, [
        h("div", { class: "cp-left" }, [
          h("div", { class: "cp-sec" }, [
            h("div", { class: "cp-sec-title", text: "1 · 选择图表（顺序=子图字母）" }),
            picker.el]),
          h("div", { class: "cp-sec" }, [
            h("div", { class: "cp-sec-title", text: "2 · 版式" }),
            h("div", { class: "cp-grid2" }, [
              field("版式", layoutSel),
              h("span"),
              field("行数", rowsInput), field("列数", colsInput),
              field("宽度", h("span", {}, [widthSel, " ", widthCustom]))
            ])]),
          h("div", { class: "cp-sec" }, [
            h("div", { class: "cp-sec-title", text: "3 · 尺寸与间距" }),
            h("div", { class: "cp-grid2" }, [
              field("单格宽高比", aspectSel),
              field("间距 (mm)", gapInput)
            ])]),
          h("div", { class: "cp-sec" }, [
            h("div", { class: "cp-sec-title", text: "4 · 子图字母" }),
            h("div", { class: "cp-grid2" }, [
              field("格式", labelFmt),
              field("位置", labelPos),
              field("字号 (pt)", labelPt),
              h("label", { class: "cp-check" }, [labelBold, " 粗体"])
            ])]),
          h("div", { class: "cp-sec" }, [
            h("div", { class: "cp-sec-title", text: "5 · 统一选项" }),
            h("div", { class: "cp-checks" }, [
              h("label", { class: "cp-check" }, [unifyFont, " 统一字号（期刊基准 " + ji.basePt + "pt）"]),
              h("label", { class: "cp-check" }, [unifyColors, " 统一实验组颜色"]),
              h("label", { class: "cp-check" }, [
                field("统一风格", styleSel)]),
              h("label", { class: "cp-check" }, [sameRowY, " 同行统一 Y 范围（只设轴范围）"])
            ])]),
          h("div", { class: "cp-sec" }, [
            h("div", { class: "cp-sec-title", text: "6 · 去向" }),
            field("放到", destSel)
          ])
        ]),
        h("div", { class: "cp-right" }, [
          h("div", { class: "cp-sec-title", text: "实时预览" }),
          previewBox
        ])
      ])
    ]);

    function doApply() {
      var sel = picker.getSelected();
      if (sel.length < 1) {
        if (global.Ui && Ui.toast) Ui.toast("请至少选择 1 个图表", { type: "error" });
        return false;
      }
      var cfg = readCfg(ui2);
      var hasTab = sel.some(function (s) { return s.kind === "tab"; });
      var hasCur = sel.some(function (s) { return s.kind === "current"; });
      var dest = cfg.dest;
      if (dest === "auto") dest = (hasTab || !hasCur) ? "newtab" : "current";
      if (dest === "newtab" && !hasCur && !hasTab) dest = "current";
      if (dest === "current" && !hasCur) {
        // 全部来自其他标签：只能复制到当前画布（深拷贝）
        dest = "current";
      }
      cfg.dest = dest;
      var promise;
      if (dest === "newtab") {
        promise = commitNewTab(sel, cfg);
      } else {
        // R8b：组图超出当前画布时先询问——「画布适配组图」扩画布、
        // 「保持画布直接组图」按原位放置（可能越界）、取消留在对话框。
        var structPeek = null;
        try { structPeek = buildStructure(sel, cfg); } catch (e) { structPeek = null; }
        var cvNow = ((doc() || {}).canvas) || {};
        var needW = structPeek ? (structPeek.ox || 5) + structPeek.W + 8 : 0;
        var needH = structPeek ? (structPeek.oy || 5) + structPeek.H + 8 : 0;
        var overflow = !!structPeek &&
          ((cvNow.width_mm || 0) < needW || (cvNow.height_mm || 0) < needH);
        if (overflow) {
          promise = askCanvasFit(needW, needH, cvNow).then(function (mode) {
            if (mode === "cancel") return null;
            if (mode === "keep") cfg.skipCanvasFit = true;
            return commitCurrent(sel, cfg);
          });
        } else {
          promise = commitCurrent(sel, cfg);
        }
      }
      return promise.then(function (r) {
        if (r == null || r.applied === 0) return false; // 取消：留在组图对话框
        if (dest === "current" && global.ViewerBoot && typeof ViewerBoot.flush === "function") {
          return ViewerBoot.flush().then(function (saved) {
            if (saved && saved.ok) ui().toast("组图已保存");
            return true;
          });
        }
        ui().toast("组图已完成");
        return true;
      });
    }

    var modal = U.modal({
      title: "组成组图",
      className: "compose-modal",
      body: body,
      actions: [
        { label: "取消", variant: "ghost" },
        { label: "先建空版式", onClick: function () {
          var cfg = readCfg(ui2), slots = emptySlots(cfg);
          if (!slots.length) throw new Error("请设置 1–100 个位置");
          var struct = buildStructure(slots, cfg);
          return global.Tabs.newTab(newDocFor(struct, cfg, "组图")).then(function (result) {
            if (result) ui().toast("点击空位，选择已有图或新建子图画布");
            return !!result;
          });
        } },
        { label: "生成组图", primary: true, "data-compose-apply": "1",
          onClick: function () { return doApply(); } }
      ]
    });
    picker.load(opts.ids || []).then(refreshPreview);
    setTimeout(refreshPreview, 300);
    return modal;
  }

  // ------------------------------------------------------------------
  // 编辑组图排版 / 解散 / 空格放入
  // ------------------------------------------------------------------

  function isComposition(el) {
    if (!el || el.type !== "panel" || !el.panelLayout) return false;
    var d = doc(); if (!d) return false;
    return (el.children || []).some(function (cid) {
      var c = elById(d, cid);
      return c && c.type === "panel";
    });
  }

  function isEmptyCell(el) {
    if (!el || el.type !== "chart" || !el.chart) return false;
    var data = el.chart.data;
    var rows = data && data.inline && data.inline.rows;
    if (Array.isArray(rows) && rows.length) return false;
    var d = doc();
    var parent = el.parent_id && d ? elById(d, el.parent_id) : null;
    return !!(parent && parent.type === "panel");
  }

  function childPanelsOf(panelId) {
    var d = doc(); var p = elById(d, panelId);
    if (!p) return [];
    return (p.children || []).map(function (cid) { return elById(d, cid); })
      .filter(function (c) { return c && c.type === "panel"; });
  }

  function editPanel(panelId) {
    var U = ui(); if (!U || typeof U.modal !== "function") return;
    var d = doc(); var p = elById(d, panelId);
    if (!p || !isComposition(p)) return;
    var kids = childPanelsOf(panelId);
    var lay = p.panelLayout || {};
    var ji = journalInfo();

    var layoutSel = selectInput(LAYOUT_PRESETS, "auto");
    var rowsInput = numInput(lay.rows || 2, { min: "1" });
    var colsInput = numInput(lay.cols || 2, { min: "1" });
    var gapInput = numInput(lay.gap_mm != null ? lay.gap_mm : 3, { min: "0", step: "0.5" });
    var labelFmt = selectInput(LABEL_FMTS, "a");
    var labelBold = checkInput(true);
    var labelPt = numInput((kids[0] && kids[0].panelLayout &&
      kids[0].panelLayout.labelStyle && kids[0].panelLayout.labelStyle.fontSizePt) ||
      ji.basePt + 1, { min: "4", step: "0.5" });
    var labelPos = selectInput(LABEL_POS, "top-left");

    // 初始化控件为当前值：版式按 cols/rows/areas 匹配预设，字母按 label 反推
    (function init() {
      var n = kids.length || 1;
      var matched = "custom";
      LAYOUT_PRESETS.forEach(function (lp) {
        if (matched !== "custom" || lp.id === "auto" || lp.id === "custom") return;
        var g = gridFor(lp.id, n, lay.rows, lay.cols);
        if (g.cols === (lay.cols || g.cols) && g.rows === (lay.rows || g.rows)) {
          var cur = lay.areas || [];
          var nxt = g.areas || [];
          if (cur.length === nxt.length &&
              cur.every(function (a, i) {
                var b = nxt[i] || {};
                return a.col === b.col && a.row === b.row &&
                  a.colSpan === b.colSpan && a.rowSpan === b.rowSpan;
              })) matched = lp.id;
        }
      });
      if (!lay.areas || !lay.areas.length) {
        LAYOUT_PRESETS.forEach(function (lp) {
          if (matched !== "custom" || lp.id === "auto" || lp.id === "custom") return;
          var g = gridFor(lp.id, n, lay.rows, lay.cols);
          if (g.cols === lay.cols && g.rows === lay.rows && !(g.areas || []).length) {
            matched = lp.id;
          }
        });
      }
      layoutSel.value = matched;
      var k0 = kids[0];
      if (!k0 || !k0.panelLayout) return;
      var lb = String(k0.panelLayout.label || "");
      var m = /^(\(?)([a-zA-Z])([a-zA-Z]?)(\)?)$/.exec(lb);
      if (m) {
        var up = m[2] === m[2].toUpperCase();
        var fmt = m[1] === "(" ? (up ? "(A)" : "(a)")
          : (m[4] === ")" ? "a)" : (up ? "A" : "a"));
        labelFmt.value = fmt;
      }
      labelPos.value = k0.panelLayout.labelPosition === "inside-top-left"
        ? "inside-top-left" : "top-left";
      var ws = k0.panelLayout.labelStyle || {};
      labelBold.checked = ws.fontWeight !== "normal";
      if (ws.fontSizePt) labelPt.value = ws.fontSizePt;
    })();

    // 调序列表
    var orderWrap = h("div", { class: "cp-order-list" });
    function renderOrder() {
      orderWrap.textContent = "";
      var cur = childPanelsOf(panelId);
      cur.forEach(function (c, i) {
        var up = h("button", { class: "cp-mini", text: "↑", disabled: i === 0 });
        var dn = h("button", { class: "cp-mini", text: "↓",
          disabled: i === cur.length - 1 });
        up.addEventListener("click", function () { moveChild(i, -1); });
        dn.addEventListener("click", function () { moveChild(i, 1); });
        orderWrap.appendChild(h("div", { class: "cp-order-item" }, [
          h("span", { class: "cp-order-idx", text: String(i + 1) }),
          h("span", { class: "cp-order-name",
            text: (c.panelLayout && c.panelLayout.label) || c.id }), up, dn]));
      });
    }
    function moveChild(i, dir) {
      var ops = [];
      var cur = childPanelsOf(panelId);
      var order = cur.map(function (c) { return c.id; });
      var j = i + dir;
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      ops.push({ op: "panel_layout", targets: [panelId],
        panel: { order: order } });
      return global.App.commit(ops, { label: "组图调序", source: "user" })
        .then(renderOrder);
    }
    renderOrder();

    var body = h("div", { class: "cp-dialog cp-edit" }, [
      h("div", { class: "cp-sec" }, [
        h("div", { class: "cp-sec-title", text: "版式" }),
        h("div", { class: "cp-grid2" }, [
          field("版式", layoutSel), field("行数", rowsInput), field("列数", colsInput),
          field("间距 (mm)", gapInput)
        ])]),
      h("div", { class: "cp-sec" }, [
        h("div", { class: "cp-sec-title", text: "子图字母" }),
        h("div", { class: "cp-grid2" }, [
          field("格式", labelFmt), field("位置", labelPos),
          field("字号 (pt)", labelPt),
          h("label", { class: "cp-check" }, [labelBold, " 粗体"])
        ])]),
      h("div", { class: "cp-sec" }, [
        h("div", { class: "cp-sec-title", text: "子图顺序（上=子图 a）" }),
        orderWrap
      ])
    ]);

    function doApply() {
      var n = childPanelsOf(panelId).length || 1;
      var grid = gridFor(layoutSel.value, n,
        parseInt(rowsInput.value, 10), parseInt(colsInput.value, 10));
      var gap = parseFloat(gapInput.value);
      var inside = labelPos.value === "inside-top-left";
      var pad = inside ? 4.0 : 1.0;
      var ops = [{ op: "panel_layout", targets: [panelId], panel: {
        cols: grid.cols, rows: grid.rows,
        gap_mm: isFinite(gap) ? gap : 3, padding_mm: 0,
        areas: grid.areas && grid.areas.length ? grid.areas : undefined
      } }];
      // areas 为 undefined 时不能进 patch（会写 undefined 键）——重建 patch
      var patch = ops[0].panel;
      if (!patch.areas) delete patch.areas;
      var fmt = labelFmt.value;
      var pt = parseFloat(labelPt.value) || (ji.basePt + 1);
      var pos = labelPos.value;
      var bold = labelBold.checked;
      childPanelsOf(panelId).forEach(function (c, i) {
        ops.push({ op: "panel_layout", targets: [c.id], panel: {
          label: letterFor(i, fmt),
          labelStyle: { fontSizePt: pt, fontFamily: ji.font,
            fontWeight: bold ? "bold" : "normal", fill: "#000000" },
          labelPosition: pos,
          padding_mm: pad
        } });
      });
      return global.App.commit(ops, { label: "编辑组图排版", source: "user" })
        .then(function () { return true; });
    }

    U.modal({
      title: "编辑组图排版",
      className: "compose-modal",
      body: body,
      actions: [
        { label: "取消", variant: "ghost" },
        { label: "解散组图", variant: "danger",
          onClick: function () { dissolve(panelId); } },
        { label: "应用", primary: true, onClick: function () { return doApply(); } }
      ]
    });
  }

  function dissolve(panelId) {
    var d = doc(); var p = elById(d, panelId);
    if (!p || !isComposition(p)) return;
    // ungroup 外层 → 子 panel 变顶层（panelRelative 已转绝对）；再 ungroup 各子 panel
    var ops = [{ op: "ungroup", targets: [panelId] }];
    childPanelsOf(panelId).forEach(function (c) {
      ops.push({ op: "ungroup", targets: [c.id] });
    });
    return global.App.commit(ops, { label: "解散组图", source: "user" });
  }

  // ------------------------------------------------------------------
  // 空版式格「放入图表…」：选一个图表深拷贝进该格
  // ------------------------------------------------------------------

  function fillCell(chartId, src) {
    var d = doc(), ph = elById(d, chartId);
    if (!isEmptyCell(ph)) throw new Error("这个位置已填入或已删除，原子图仍在其画布中");
    var parent = elById(d, ph.parent_id);
    var nodes = cloneSubtree(src, false), root = nodes[0];
    if (root.type === "group") {
      fitGroupIntoRect(nodes, src.srcDoc, src.el.id, figdoc().bbox(d, ph.id, {recursive:false}));
    } else {
      root.transform = copy(ph.transform);
      root.style = Object.assign({}, root.style, {panelRelative:!!(ph.style && ph.style.panelRelative)});
    }
    root.parent_id = ph.parent_id;
    var ops = [{op:"delete", targets:[ph.id]}];
    nodes.forEach(function (node) { ops.push({op:"add_element", element:node}); });
    if (parent.children[parent.children.length - 1] !== ph.id) {
      ops.push({op:"panel_layout", targets:[parent.id], panel:{order:parent.children.map(function (id) {
        return id === ph.id ? root.id : id;
      })}});
    }
    return global.App.commit(ops, {label:"放入图表", source:"user"}).then(function (r) { return !!r.applied; });
  }

  function returnToCell() {
    var source = doc(), target = source.meta.compose_target;
    if (!source.elements.length) throw new Error("先在子图画布上绘制或导入内容");
    var snapshot = canvasSource(source);
    return global.Tabs.switchTab(target.doc_id).then(function (result) {
      if (!result || doc().id !== target.doc_id) return false;
      return fillCell(target.slot_id, snapshot);
    });
  }

  function placeIntoCell(chartId) {
    var U = ui(), d = doc(), ph = elById(d, chartId);
    if (!U || !isEmptyCell(ph)) return;
    var picker = sourcePicker(null, true);
    picker.load([]);
    return U.modal({
      title: "放入图表 · " + elLabel(ph), className: "compose-modal", body: picker.el,
      actions: [
        {label:"取消", variant:"ghost"},
        {label:"新建子图画布", onClick:function () {
          var box = figdoc().bbox(d, chartId, {recursive:false});
          var zoom = Math.max(1, 120 / box.w, 90 / box.h);
          var child = figdoc().create({title:elLabel(ph), width_mm:box.w * zoom, height_mm:box.h * zoom, dpi:d.canvas.dpi});
          child.meta.compose_target = {doc_id:d.id, slot_id:chartId};
          return global.Tabs.newTab(child).then(function (result) { return !!result; });
        }},
        {label:"放入", primary:true, onClick:function () {
          var sel = picker.getSelected();
          if (sel.length !== 1) { U.toast("请选择一张图", {type:"error"}); return false; }
          return fillCell(chartId, sel[0]);
        }}
      ]
    });
  }

  // ------------------------------------------------------------------
  // 导出
  // ------------------------------------------------------------------

  global.Compose = {
    open: open,
    editPanel: editPanel,
    dissolve: dissolve,
    placeIntoCell: placeIntoCell,
    isComposition: isComposition,
    isEmptyCell: isEmptyCell,
    isSourceEl: eligible,
    _gridFor: gridFor,
    _placementsFor: placementsFor,
    _letterFor: letterFor,
    _buildStructure: buildStructure,
    _previewSVG: previewSVG
  };

  // 工具栏「组图」按钮（与模板库同一自绑定模式）
  if (typeof document !== "undefined") {
    function _bindBtn() {
      var btn = document.getElementById("btn-compose");
      if (btn && !btn.__composeBound) {
        btn.__composeBound = true;
        var putBack = h("button", {type:"button", text:"放回组图", onclick:function () {
          putBack.disabled = true;
          Promise.resolve().then(returnToCell).catch(function (err) { ui().toast(err.message, {type:"error"}); })
            .finally(function () { putBack.disabled = false; });
        }});
        btn.after(putBack);
        function updateReturn() {
          putBack.hidden = !(doc() && doc().meta && doc().meta.compose_target);
        }
        updateReturn();
        global.App.on("doc:changed", updateReturn);
        btn.addEventListener("click", function () {
          var ids = null;
          try {
            if (global.App && typeof App.selection === "function") {
              var sel = App.selection();
              var d = doc();
              var elig = (d ? d.elements : []).filter(function (el) {
                return el && SRC_TYPES[el.type] && !el.parent_id && sel.indexOf(el.id) >= 0;
              });
              if (elig.length) ids = elig.map(function (el) { return el.id; });
            }
          } catch (e) { /* */ }
          open({ ids: ids });
        });
      }
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _bindBtn);
    } else { _bindBtn(); }
    setTimeout(_bindBtn, 500);
    setTimeout(_bindBtn, 2000);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
