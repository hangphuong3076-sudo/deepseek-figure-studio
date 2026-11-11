/*
 * render.js — FigRender
 *
 * Deterministic document -> SVG renderer for the shared figure kernel.
 * No DOM, no time, no randomness: the same (doc, opts) always produces the
 * exact same string. SVG user space is millimetres: viewBox="0 0 W H" where
 * W/H are doc.canvas.width_mm/height_mm, and width/height attributes carry
 * the "mm" unit (multiplied by opts.scale for zoomed/high-res previews).
 *
 * Loading order: loaded after figdoc.js / data.js. FigData.renderChartSVG is
 * called opportunistically for type=chart elements when available; the module
 * itself does not hard-require any other kernel object at load time.
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var PT_TO_MM = 25.4 / 72; // pt -> mm

  // ------------------------------------------------------------------
  // small utilities
  // ------------------------------------------------------------------

  function fail(msg) {
    throw new Error(msg);
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Round to 3 decimals to keep output short, stable and free of "-0".
  function num3(v) {
    var r = Math.round(Number(v) * 1000) / 1000;
    return r === 0 ? 0 : r;
  }

  // Deterministic number formatting for all SVG coordinates.
  function fmt(v) {
    var n = Number(v);
    if (!isFinite(n)) fail('FigRender：遇到非法数值（' + String(v) + '）');
    return String(num3(n));
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  // Serialize an attribute map (insertion order = output order, deterministic).
  // null / undefined values are skipped.
  function attrStr(attrs) {
    var out = '';
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k) &&
          attrs[k] !== null && attrs[k] !== undefined) {
        out += ' ' + k + '="' + escAttr(attrs[k]) + '"';
      }
    }
    return out;
  }

  function sanitizeIdPart(s) {
    return String(s).replace(/[^A-Za-z0-9_.:-]/g, '_');
  }

  function zOf(el) {
    var z = el && typeof el.z === 'number' && isFinite(el.z) ? el.z : 0;
    return z;
  }

  // Render order: asBackground elements first, then by z ascending.
  // Array.prototype.sort is stable (ES2019+), equal keys keep document order.
  function compareRenderOrder(a, b) {
    var abg = a.asBackground === true;
    var bbg = b.asBackground === true;
    if (abg !== bbg) return abg ? -1 : 1;
    return zOf(a) - zOf(b);
  }

  // ------------------------------------------------------------------
  // validation
  // ------------------------------------------------------------------

  function validateDoc(doc, fnName) {
    if (!isObj(doc)) fail(fnName + '：doc 必须是文档对象');
    if (!isObj(doc.canvas)) fail(fnName + '：doc.canvas 缺失或不是对象');
    var w = Number(doc.canvas.width_mm);
    var h = Number(doc.canvas.height_mm);
    if (!isFinite(w) || w <= 0 || !isFinite(h) || h <= 0) {
      fail(fnName + '：canvas.width_mm / canvas.height_mm 必须是正数');
    }
    if (!Array.isArray(doc.elements)) {
      fail(fnName + '：doc.elements 必须是数组');
    }
  }

  function validateElement(el, fnName) {
    if (!isObj(el)) fail(fnName + '：元素必须是对象');
    if (typeof el.id !== 'string' || el.id === '') {
      fail(fnName + '：元素缺少合法的 id');
    }
    if (!isObj(el.transform)) fail(fnName + '：元素 ' + el.id + ' 缺少 transform');
    var t = el.transform;
    if (![t.x, t.y, t.w, t.h].every(function (v) {
      return typeof v === 'number' && isFinite(v);
    })) {
      fail(fnName + '：元素 ' + el.id + ' 的 transform.x/y/w/h 必须是数值');
    }
  }

  function resolveDpi(canvas, fnName) {
    if (canvas.dpi === undefined || canvas.dpi === null) return 300;
    var dpi = Number(canvas.dpi);
    if (!isFinite(dpi) || dpi <= 0) {
      fail(fnName + '：canvas.dpi 必须是正数');
    }
    return dpi;
  }

  // ------------------------------------------------------------------
  // render context
  // ------------------------------------------------------------------

  function buildContext(doc, fnName) {
    validateDoc(doc, fnName);
    var byId = Object.create(null);
    var all = [];
    for (var i = 0; i < doc.elements.length; i++) {
      var e = doc.elements[i];
      validateElement(e, fnName);
      all.push(e);
      if (!(e.id in byId)) byId[e.id] = e; // first occurrence wins
    }
    var sorted = all.slice().sort(compareRenderOrder);
    return {
      doc: doc,
      fnName: fnName,
      W: Number(doc.canvas.width_mm),
      H: Number(doc.canvas.height_mm),
      dpi: resolveDpi(doc.canvas, fnName),
      byId: byId,
      sorted: sorted
    };
  }

  function isTopLevel(el, byId) {
    return !el.parent_id || !(el.parent_id in byId) || byId[el.parent_id] === el;
  }

  // Children of a container in render order: the `children` id list first,
  // then any elements pointing at this parent but missing from the list
  // (dangling entries), ordered by z / document order.
  function childrenOf(el, ctx) {
    var kids = [];
    var listed = Object.create(null);
    if (Array.isArray(el.children)) {
      for (var i = 0; i < el.children.length; i++) {
        var cid = el.children[i];
        if (typeof cid !== 'string') continue;
        var c = ctx.byId[cid];
        if (c && !listed[cid]) {
          listed[cid] = true;
          kids.push(c);
        }
      }
    }
    for (var j = 0; j < ctx.sorted.length; j++) {
      var e = ctx.sorted[j];
      if (e.parent_id === el.id && !listed[e.id]) kids.push(e);
    }
    return kids;
  }

  // Resolve an element's box in millimetres. When style.panelRelative is true
  // and the parent is a panel, x/y/w/h are 0-1 fractions of the parent's
  // inner padding box (panelLayout.padding_mm inset).
  function resolveBox(el, ctx) {
    var t = el.transform;
    var out = {
      x: t.x, y: t.y, w: t.w, h: t.h,
      rotation: typeof t.rotation === 'number' && isFinite(t.rotation) ? t.rotation : 0
    };
    if (el.style && el.style.panelRelative === true && el.parent_id) {
      var p = ctx.byId[el.parent_id];
      if (p && p.type === 'panel') {
        var lay = isObj(p.panelLayout) ? p.panelLayout : {};
        var pad = lay.padding_mm === undefined ? 0 : Number(lay.padding_mm);
        if (!isFinite(pad) || pad < 0) pad = 0;
        var ix = p.transform.x + pad;
        var iy = p.transform.y + pad;
        var iw = Math.max(0, p.transform.w - 2 * pad);
        var ih = Math.max(0, p.transform.h - 2 * pad);
        out.x = ix + t.x * iw;
        out.y = iy + t.y * ih;
        out.w = t.w * iw;
        out.h = t.h * ih;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // defs registry (markers + clip paths), filled during rendering
  // ------------------------------------------------------------------

  function ensureMarker(ctx, color, which) {
    if (which !== 'end' && which !== 'start') return;
    var m = ctx.markers.get(color);
    if (!m) {
      var base = 'arw-' + sanitizeIdPart(color);
      var id = base;
      var n = 1;
      while (ctx.usedIds[id]) id = base + '-' + (n++);
      ctx.usedIds[id] = true;
      m = { id: id, end: false, start: false };
      ctx.markers.set(color, m);
    }
    m[which] = true;
  }

  function ensureClip(ctx, el) {
    var id = 'clip-' + sanitizeIdPart(el.id);
    if (!ctx.usedIds[id]) ctx.usedIds[id] = true;
    if (!ctx.clips.has(id)) {
      var t = resolveBox(el, ctx);
      var rot = t.rotation;
      var rect = '<rect x="' + fmt(t.x) + '" y="' + fmt(t.y) +
        '" width="' + fmt(Math.max(0, t.w)) + '" height="' + fmt(Math.max(0, t.h)) + '"' +
        (rot ? ' transform="rotate(' + fmt(rot) + ' ' + fmt(t.x + t.w / 2) + ' ' + fmt(t.y + t.h / 2) + ')"' : '') +
        '/>';
      ctx.clips.set(id, '<clipPath id="' + escAttr(id) + '">' + rect + '</clipPath>');
    }
    return id;
  }

  function emitDefs(ctx) {
    var out = '';
    ctx.markers.forEach(function (m, color) {
      if (m.end) {
        out += '<marker id="' + m.id + '" viewBox="0 0 10 10" markerWidth="3" markerHeight="3"' +
          ' refX="9.5" refY="5" orient="auto" markerUnits="userSpaceOnUse">' +
          '<path d="M0,0 L10,5 L0,10 Z" fill="' + escAttr(color) + '"/></marker>';
      }
      if (m.start) {
        out += '<marker id="' + m.id + '-r" viewBox="0 0 10 10" markerWidth="3" markerHeight="3"' +
          ' refX="0.5" refY="5" orient="auto" markerUnits="userSpaceOnUse">' +
          '<path d="M10,0 L0,5 L10,10 Z" fill="' + escAttr(color) + '"/></marker>';
      }
    });
    ctx.clips.forEach(function (def) {
      out += def;
    });
    return out;
  }

  // ------------------------------------------------------------------
  // style -> SVG attributes
  // ------------------------------------------------------------------

  // FigRender.styleToAttrs(style, {dpi=96}) -> object
  // Font sizes and stroke widths are expressed in CSS px (pt * dpi / 72).
  // render.js converts them back to mm user units via px * 25.4 / dpi.
  function styleToAttrs(style, opts) {
    if (style === undefined || style === null) style = {};
    if (!isObj(style)) fail('FigRender.styleToAttrs：style 必须是对象');
    opts = opts || {};
    var dpi = opts.dpi === undefined ? 96 : Number(opts.dpi);
    if (!isFinite(dpi) || dpi <= 0) fail('FigRender.styleToAttrs：dpi 必须是正数');
    var pxPerPt = dpi / 72;

    var a = {};
    if (style.fill !== undefined) {
      a.fill = (style.fill === null || style.fill === '') ? 'none' : String(style.fill);
    }
    if (style.stroke !== undefined) {
      a.stroke = (style.stroke === null || style.stroke === '') ? 'none' : String(style.stroke);
    }
    var sw = style.strokeWidthPt === undefined ? 0.75 : Number(style.strokeWidthPt);
    if (!isFinite(sw) || sw < 0) fail('FigRender.styleToAttrs：strokeWidthPt 必须是非负数');
    a['stroke-width'] = num3(sw * pxPerPt);
    if (style.dash) a['stroke-dasharray'] = String(style.dash);
    if (style.opacity !== undefined) {
      var op = Number(style.opacity);
      if (!isFinite(op)) fail('FigRender.styleToAttrs：opacity 必须是数值');
      if (op !== 1) a.opacity = num3(op);
    }
    a['font-family'] = style.fontFamily === undefined ? 'Arial' : String(style.fontFamily);
    var fs = style.fontSizePt === undefined ? 7 : Number(style.fontSizePt);
    if (!isFinite(fs) || fs <= 0) fail('FigRender.styleToAttrs：fontSizePt 必须是正数');
    a['font-size'] = num3(fs * pxPerPt);
    a['font-weight'] = style.fontWeight === undefined ? 'normal' : String(style.fontWeight);
    a['font-style'] = style.fontStyle === undefined ? 'normal' : String(style.fontStyle);
    if (style.textAnchor !== undefined) {
      a['text-anchor'] = String(style.textAnchor);
    } else {
      var ta = style.textAlign === undefined ? 'left' : String(style.textAlign);
      a['text-anchor'] = ta === 'center' ? 'middle' : (ta === 'right' ? 'end' : 'start');
    }
    return a;
  }

  // styleToAttrs output with px values converted to mm SVG user units.
  function svgStyleAttrs(el, ctx) {
    var a = styleToAttrs(el.style, { dpi: ctx.dpi });
    var k = 25.4 / ctx.dpi;
    a['stroke-width'] = num3(Number(a['stroke-width']) * k);
    a['font-size'] = num3(Number(a['font-size']) * k);
    return a;
  }

  var STYLE_KEYS_ALL = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity',
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor'];

  function pickKeys(attrs, keys) {
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (attrs[k] !== undefined) out[k] = attrs[k];
    }
    return out;
  }

  var TEXT_KEYS = ['fill', 'opacity', 'font-family', 'font-size', 'font-weight',
    'font-style', 'text-anchor'];
  var SHAPE_KEYS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity'];
  var LINE_KEYS = ['stroke', 'stroke-width', 'stroke-dasharray', 'opacity'];
  var GROUP_KEYS = ['fill', 'stroke', 'stroke-width', 'opacity'];

  // ------------------------------------------------------------------
  // arrow-head helpers
  // ------------------------------------------------------------------

  var HEAD_ENUM = ['none', 'start', 'end', 'both'];

  function headOf(el) {
    var style = isObj(el.style) ? el.style : {};
    var raw = style.arrowHead;
    if (raw === undefined) {
      // schema default is "end"; only the dedicated arrow type takes it.
      raw = el.type === 'arrow' ? 'end' : 'none';
    }
    if (HEAD_ENUM.indexOf(raw) < 0) {
      fail(ctxFnName(el) + '：元素 ' + el.id + ' 的 style.arrowHead 非法（' + String(raw) + '）');
    }
    return raw;
  }

  function ctxFnName(el) {
    return 'FigRender'; // messages stay stable regardless of entry point
  }

  function strokeColorOf(el) {
    var style = isObj(el.style) ? el.style : {};
    if (style.stroke === undefined) return '#000000';
    if (style.stroke === null || style.stroke === '') return 'none';
    return String(style.stroke);
  }

  function markerAttrs(ctx, el, head, color) {
    var attrs = {};
    if (color === 'none') return attrs;
    if (head === 'end' || head === 'both') {
      ensureMarker(ctx, color, 'end');
      attrs['marker-end'] = 'url(#' + ctx.markers.get(color).id + ')';
    }
    if (head === 'start' || head === 'both') {
      ensureMarker(ctx, color, 'start');
      attrs['marker-start'] = 'url(#' + ctx.markers.get(color).id + '-r)';
    }
    return attrs;
  }

  function connectorGeometry(el, ctx) {
    if (!global.FigDiagram || typeof global.FigDiagram.connectorGeometry !== 'function') {
      fail('FigRender：connector ' + el.id + ' 需要 FigDiagram 动态几何，不能回退静态路径');
    }
    try {
      return global.FigDiagram.connectorGeometry(ctx.doc, el);
    } catch (e) {
      fail('FigRender：connector ' + el.id + ' 几何解析失败：' + (e && e.message ? e.message : String(e)));
    }
    return null;
  }

  function connectorHead(g, point, toward, color) {
    var dx = point.x - toward.x, dy = point.y - toward.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    if (g.kind === 'inhibit') {
      return '<line class="fig-connector-tbar" x1="' + fmt(point.x - uy * 2) + '" y1="' + fmt(point.y + ux * 2) +
        '" x2="' + fmt(point.x + uy * 2) + '" y2="' + fmt(point.y - ux * 2) +
        '" stroke="' + escAttr(color) + '" stroke-width="1.2"/>';
    }
    if (g.kind === 'associate' || g.kind === 'include') return '';
    var px = -uy, py = ux, length = g.kind === 'sequence' ? 2.2 : 3;
    var halfWidth = g.kind === 'sequence' ? 1 : 1.5;
    return '<path class="fig-connector-head" d="M' + fmt(point.x) + ' ' + fmt(point.y) +
      ' L' + fmt(point.x - ux * length + px * halfWidth) + ' ' + fmt(point.y - uy * length + py * halfWidth) +
      ' L' + fmt(point.x - ux * length - px * halfWidth) + ' ' + fmt(point.y - uy * length - py * halfWidth) +
      ' Z" fill="' + escAttr(color) + '"/>';
  }

  function renderConnector(el, ctx) {
    var g = connectorGeometry(el, ctx);
    var a = svgStyleAttrs(el, ctx), line = pickKeys(a, LINE_KEYS);
    if (line.stroke === undefined) line.stroke = '#3F4A55';
    var color = line.stroke;
    var d;
    if (g.path_type === 'quadratic' || (!g.path_type && el.relation && el.relation.bend)) {
      d = 'M' + fmt(g.start.x) + ' ' + fmt(g.start.y) + ' Q' + fmt(g.middle.x) + ' ' +
        fmt(g.middle.y) + ' ' + fmt(g.end.x) + ' ' + fmt(g.end.y);
    } else {
      d = g.points.map(function (point, index) {
        return (index ? 'L' : 'M') + fmt(point.x) + ' ' + fmt(point.y);
      }).join(' ');
    }
    var out = '<g class="fig-connector fig-relation-' + escAttr(g.kind) + '" data-fig-id="' + escAttr(el.id) +
      '" data-relation-kind="' + escAttr(g.kind) + '" data-relation-direction="' + escAttr(g.direction) +
      '" data-source-id="' + escAttr(g.source) + '" data-target-id="' + escAttr(g.target) + '"' +
      attrStr({ 'data-source-port-id': g.source_port && g.source_port.id,
        'data-target-port-id': g.target_port && g.target_port.id,
        'data-source-port-side': g.source_port && g.source_port.side,
        'data-target-port-side': g.target_port && g.target_port.side }) + '>';
    if (g.kind === 'include') {
      var b = g.targetBox;
      out += '<rect class="fig-connector-container" data-containment-for="' + escAttr(el.relation.target) + '" x="' + fmt(b.x - 2) +
        '" y="' + fmt(b.y - 2) + '" width="' + fmt(b.w + 4) + '" height="' + fmt(b.h + 4) +
        '" rx="2" fill="none"' + attrStr(pickKeys(a, ['stroke', 'stroke-width', 'stroke-dasharray'])) + '/>';
      return out + '</g>';
    }
    out += '<path class="fig-connector-path" d="' + d + '" fill="none"' + attrStr(line) + '/>';
    if (g.direction === 'forward' || g.direction === 'both') out += connectorHead(g, g.end, g.points[g.points.length - 2], color);
    if (g.direction === 'reverse' || g.direction === 'both') out += connectorHead(g, g.start, g.points[1], color);
    return out + '</g>';
  }

  // ------------------------------------------------------------------
  // per-type element rendering (all coordinates in mm user units)
  // ------------------------------------------------------------------

  function rotationAttr(t) {
    if (!t.rotation) return '';
    var cx = t.x + t.w / 2;
    var cy = t.y + t.h / 2;
    return ' transform="rotate(' + fmt(t.rotation) + ' ' + fmt(cx) + ' ' + fmt(cy) + ')"';
  }

  function renderRect(el, ctx, t, a) {
    var rx = isObj(el.style) && el.style.cornerRadiusMm !== undefined
      ? Number(el.style.cornerRadiusMm) : 0;
    if (!isFinite(rx) || rx < 0) fail('FigRender：元素 ' + el.id + ' 的 cornerRadiusMm 非法');
    rx = Math.min(rx, Math.max(0, t.w) / 2, Math.max(0, t.h) / 2);
    return '<rect data-fig-id="' + escAttr(el.id) + '"' +
      ' x="' + fmt(t.x) + '" y="' + fmt(t.y) + '"' +
      ' width="' + fmt(Math.max(0, t.w)) + '" height="' + fmt(Math.max(0, t.h)) + '"' +
      (rx > 0 ? ' rx="' + fmt(rx) + '" ry="' + fmt(rx) + '"' : '') +
      attrStr(pickKeys(a, SHAPE_KEYS)) + rotationAttr(t) + '/>';
  }

  function renderEllipse(el, ctx, t, a) {
    return '<ellipse data-fig-id="' + escAttr(el.id) + '"' +
      ' cx="' + fmt(t.x + t.w / 2) + '" cy="' + fmt(t.y + t.h / 2) + '"' +
      ' rx="' + fmt(Math.max(0, t.w / 2)) + '" ry="' + fmt(Math.max(0, t.h / 2)) + '"' +
      attrStr(pickKeys(a, SHAPE_KEYS)) + rotationAttr(t) + '/>';
  }

  function renderLineOrArrow(el, ctx, t, a) {
    var head = headOf(el);
    var color = strokeColorOf(el);
    var line = pickKeys(a, LINE_KEYS);
    if (line.stroke === undefined) line.stroke = color;
    var attrs = markerAttrs(ctx, el, head, color);
    return '<line data-fig-id="' + escAttr(el.id) + '"' +
      ' x1="' + fmt(t.x) + '" y1="' + fmt(t.y) + '"' +
      ' x2="' + fmt(t.x + t.w) + '" y2="' + fmt(t.y + t.h) + '"' +
      attrStr(line) + attrStr(attrs) + rotationAttr(t) + '/>';
  }

  function renderPath(el, ctx, t, a) {
    if (typeof el.pathData !== 'string') return ''; // schema allows null
    var style = isObj(el.style) ? el.style : {};
    var attrs = {};
    if (style.arrowHead !== undefined && style.arrowHead !== 'none') {
      var head = headOf(el);
      attrs = markerAttrs(ctx, el, head, strokeColorOf(el));
    }
    var line = pickKeys(a, ['fill'].concat(LINE_KEYS));
    if (line.stroke === undefined) line.stroke = '#000000';
    if (line.fill === undefined) line.fill = 'none';
    var tf = 'translate(' + fmt(t.x) + ' ' + fmt(t.y) + ')';
    if (t.rotation) {
      tf += ' rotate(' + fmt(t.rotation) + ' ' + fmt(t.w / 2) + ' ' + fmt(t.h / 2) + ')';
    }
    return '<g transform="' + tf + '"><path data-fig-id="' + escAttr(el.id) + '"' +
      ' d="' + escAttr(el.pathData) + '"' + attrStr(line) + attrStr(attrs) + '/></g>';
  }

  function renderText(el, ctx, t, a) {
    var text = el.text === null || el.text === undefined ? '' : String(el.text);
    var lines = text.length ? text.split(/\r\n|\n|\r/) : [''];
    var fs = Number(a['font-size']);
    var lh = fs * (isObj(el.style) && el.style.lineHeight !== undefined
      ? Number(el.style.lineHeight) : 1.2);
    if (!isFinite(lh) || lh <= 0) fail('FigRender：元素 ' + el.id + ' 的 style.lineHeight 非法');

    var anchor = a['text-anchor'];
    var x = anchor === 'middle' ? t.x + t.w / 2 : (anchor === 'end' ? t.x + t.w : t.x);
    var bl0;
    var va = isObj(el.style) && el.style.verticalAlign !== undefined
      ? String(el.style.verticalAlign) : 'top';
    if (va === 'middle') {
      bl0 = t.y + t.h / 2 - ((lines.length - 1) * lh) / 2 + fs * 0.3;
    } else if (va === 'bottom') {
      bl0 = t.y + t.h - (lines.length - 1) * lh - fs * 0.3;
    } else {
      bl0 = t.y + fs * 0.8;
    }

    var body = '<text data-fig-id="' + escAttr(el.id) + '"' +
      ' x="' + fmt(x) + '" y="' + fmt(bl0) + '"' +
      attrStr(pickKeys(a, TEXT_KEYS)) + rotationAttr(t) + '>';
    for (var i = 0; i < lines.length; i++) {
      body += '<tspan x="' + fmt(x) + (i > 0 ? '" dy="' + fmt(lh) : '') + '">' +
        esc(lines[i]) + '</tspan>';
    }
    return body + '</text>';
  }

  var MAX_STATIC_SVG_BYTES = 32 * 1024 * 1024;
  var MAX_STATIC_SVG_ELEMENTS = 100000;

  function decodeBase64Utf8(payload, el) {
    var binary;
    try {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
        throw new Error('base64');
      }
      if (typeof global.atob === 'function') {
        binary = global.atob(payload);
      } else {
        var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        binary = '';
        var buffer = 0, bits = 0;
        for (var i = 0; i < payload.length; i++) {
          var ch = payload.charAt(i);
          if (ch === '=') break;
          var value = alphabet.indexOf(ch);
          if (value < 0 || value === 64) throw new Error('base64');
          buffer = (buffer << 6) | value;
          bits += 6;
          if (bits >= 8) {
            bits -= 8;
            binary += String.fromCharCode((buffer >> bits) & 255);
          }
        }
      }
      var bytes = new Uint8Array(binary.length);
      for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
      if (typeof global.TextDecoder === 'function') {
        return new global.TextDecoder('utf-8', { fatal: true }).decode(bytes);
      }
      var encoded = '';
      for (var k = 0; k < binary.length; k++) {
        encoded += '%' + binary.charCodeAt(k).toString(16).padStart(2, '0');
      }
      return decodeURIComponent(encoded);
    } catch (e) {
      fail('FigRender：图片 ' + el.id + ' 的内嵌静态 SVG base64/UTF-8 解码失败');
    }
    return '';
  }

  function decodePercentUtf8(payload, el) {
    try {
      return decodeURIComponent(payload);
    } catch (e) {
      fail('FigRender：图片 ' + el.id + ' 的内嵌静态 SVG percent/UTF-8 解码失败');
    }
    return '';
  }

  function staticSvgDataUrl(href, el) {
    if (href.slice(0, 5).toLowerCase() !== 'data:') return null;
    var comma = href.indexOf(',');
    if (comma < 0) return null;
    var header = href.slice(5, comma).split(';');
    if (header.shift().trim().toLowerCase() !== 'image/svg+xml') return null;
    var base64 = false;
    for (var i = 0; i < header.length; i++) {
      var parameter = header[i].trim().toLowerCase();
      if (!parameter) continue;
      if (parameter === 'base64') base64 = true;
      else if (parameter !== 'charset=utf-8' && parameter !== 'charset=us-ascii') {
        fail('FigRender：图片 ' + el.id + ' 的静态 SVG data URL 含不支持的参数 ' + parameter);
      }
    }
    var payload = href.slice(comma + 1);
    if (payload.length > MAX_STATIC_SVG_BYTES * 3 + 1024) {
      fail('FigRender：图片 ' + el.id + ' 的静态 SVG data URL 编码内容超过 32MiB 上限');
    }
    return {
      text: base64 ? decodeBase64Utf8(payload, el) : decodePercentUtf8(payload, el)
    };
  }

  function utf8ByteLength(text) {
    var bytes = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 128) bytes += 1;
      else if (code < 2048) bytes += 2;
      else if (code >= 55296 && code <= 56319 && i + 1 < text.length &&
               text.charCodeAt(i + 1) >= 56320 && text.charCodeAt(i + 1) <= 57343) {
        bytes += 4;
        i++;
      } else bytes += 3;
    }
    return bytes;
  }

  function validateStaticSvgImage(text, el) {
    function unsafe(reason) {
      fail('FigRender：图片 ' + el.id + ' 的内嵌 SVG 不安全，' + reason);
    }
    if (!text || utf8ByteLength(text) > MAX_STATIC_SVG_BYTES) unsafe('内容为空或超过 32MiB');
    var opens = text.match(/<[A-Za-z_]/g);
    if (opens && opens.length > MAX_STATIC_SVG_ELEMENTS) unsafe('元素数超过 100000 上限');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) unsafe('XML 含非法控制字符');
    if (!/^\s*<svg(?:\s|>)/i.test(text) || !/<\/svg>\s*$/i.test(text)) unsafe('根节点必须是完整 svg 元素');
    if (/<!\s*(?:doctype|entity)/i.test(text) || /<\?\s*xml-stylesheet/i.test(text)) {
      unsafe('禁止 DOCTYPE、ENTITY 或外部样式处理指令');
    }
    if (/<\s*\/?\s*(?:[A-Za-z0-9_-]+:)?(script|handler|foreignObject|iframe|object|embed|audio|video|canvas)(?:\s|>|\/)/i.test(text)) {
      unsafe('禁止脚本或外部内容元素');
    }
    if (/<[^>]*\son[A-Za-z0-9_-]+\s*=/i.test(text)) unsafe('禁止 on* 事件属性');
    if (/\s(?:src|xml:base)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(text)) unsafe('禁止 src 或 xml:base 外部资源属性');
    if (/(?:javascript|vbscript|file|ftp)\s*:/i.test(text) || /@import|expression\s*\(|behavior\s*:/i.test(text)) {
      unsafe('禁止危险协议或可执行 CSS');
    }
    var hrefRe = /\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    var match;
    while ((match = hrefRe.exec(text))) {
      var href = (match[1] !== undefined ? match[1] : (match[2] !== undefined ? match[2] : match[3])).trim();
      if (href.charAt(0) !== '#') unsafe('href 仅允许同文档 #id 引用');
    }
    var urlRe = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi;
    while ((match = urlRe.exec(text))) {
      if (match[2].trim().charAt(0) !== '#') unsafe('paint/url 仅允许同文档 #id 引用');
    }
    if (/url\s*\(/i.test(text.replace(urlRe, ''))) unsafe('存在无法安全解析的 url()');
  }

  function safeImageHref(el) {
    var href = el.src === null || el.src === undefined ? '' : String(el.src).trim();
    if (!href) return '';
    var svg = staticSvgDataUrl(href, el);
    if (svg) {
      validateStaticSvgImage(svg.text, el);
      return href;
    }
    var match = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|x-ms-bmp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(href);
    if (!match) {
      fail('FigRender：图片 ' + el.id + ' 仅支持内嵌光栅图或经安全检查的静态 SVG base64/percent data URL，拒绝远程地址或其他 MIME');
    }
    return href;
  }

  function renderImage(el, ctx, t) {
    var fit = isObj(el.style) && el.style.imageFit !== undefined
      ? String(el.style.imageFit) : 'contain';
    var pAR = fit === 'cover' ? 'xMidYMid slice' : (fit === 'stretch' ? 'none' : 'xMidYMid meet');
    var href = safeImageHref(el);
    var hrefAttrs = href
      ? ' href="' + escAttr(href) + '" xlink:href="' + escAttr(href) + '"'
      : '';
    return '<image data-fig-id="' + escAttr(el.id) + '"' +
      ' x="' + fmt(t.x) + '" y="' + fmt(t.y) + '"' +
      ' width="' + fmt(Math.max(0, t.w)) + '" height="' + fmt(Math.max(0, t.h)) + '"' +
      ' preserveAspectRatio="' + pAR + '"' + hrefAttrs + rotationAttr(t) + '/>';
  }

  function isEmptyLayoutChart(chart) {
    if (!isObj(chart) || (chart.chartType !== null && chart.chartType !== undefined)) return false;
    var mapping = isObj(chart.mapping) ? chart.mapping : {};
    var hasMapping = Object.keys(mapping).some(function (key) {
      return mapping[key] !== null && mapping[key] !== undefined && mapping[key] !== '';
    });
    if (hasMapping) return false;
    var inline = isObj(chart.data) && isObj(chart.data.inline) ? chart.data.inline : null;
    return !inline || !Array.isArray(inline.rows) || inline.rows.length === 0;
  }

  function chartRenderError(el, err) {
    var type = isObj(el.chart) && el.chart.chartType !== undefined
      ? String(el.chart.chartType) : '(missing)';
    var reason = err && err.message ? String(err.message) : String(err);
    var error = err instanceof Error ? err : new Error(reason);
    error.message = 'FigRender：元素 ' + el.id + '（chartType=' + type + '）渲染失败：' + reason;
    return error;
  }

  function renderChart(el, ctx, t) {
    if (!isObj(el.chart)) fail('FigRender：元素 ' + el.id + ' 缺少 chart 配置，无法渲染');
    if (!(t.w > 0) || !(t.h > 0)) {
      fail('FigRender：元素 ' + el.id + ' 的图表 width_mm/height_mm 必须是正数');
    }
    if (isEmptyLayoutChart(el.chart)) {
      return '<g data-render="empty-layout" transform="translate(' + fmt(t.x) + ' ' + fmt(t.y) + ')">' +
        '<rect width="' + fmt(t.w) + '" height="' + fmt(t.h) + '"' +
        ' fill="#FFFFFF" stroke="#999999" stroke-width="0.3" stroke-dasharray="1 1"/>' +
        '<text x="' + fmt(t.w / 2) + '" y="' + fmt(t.h / 2 - 1.2) + '" text-anchor="middle"' +
        ' font-family="Arial" font-size="' + fmt(2.2) + '" fill="#666666">空版式 · 未绑定图表</text>' +
        '<text x="' + fmt(t.w / 2) + '" y="' + fmt(t.h / 2 + 2.0) + '" text-anchor="middle"' +
        ' font-family="Arial" font-size="' + fmt(1.8) + '" fill="#666666">不会自动填图</text></g>';
    }
    var fd = global.FigData;
    if (!fd || typeof fd.renderChartSVG !== 'function') {
      fail('FigRender：元素 ' + el.id + ' 需要 FigData.renderChartSVG，无法生成真实图表');
    }
    var style = isObj(el.style) ? el.style : {};
    var frag;
    try {
      frag = String(fd.renderChartSVG(el.chart, {
        width_mm: t.w,
        height_mm: t.h,
        dpi: ctx.dpi,
        fontFamily: style.fontFamily,
        fontSizePt: style.fontSizePt
      }));
      if (!frag.trim()) throw new Error('FigData 返回空 SVG，未生成真实图表');
    } catch (e) {
      throw chartRenderError(el, e);
    }
    var s = frag.trim();
    // FigData.renderChartSVG draws in CSS pixels for a t.w x t.h millimetre
    // box at ctx.dpi, so its coordinates must be scaled into the parent mm
    // user space (same px -> mm factor used by styleToAttrs).
    var k = 25.4 / ctx.dpi;
    var kStr = String(Number(k.toFixed(6)));
    var pxW = Math.max(1, Math.round(t.w / k));
    var pxH = Math.max(1, Math.round(t.h / k));
    if (/^<svg(\s|>)/i.test(s)) {
      // embed as nested <svg>: pixel viewBox plus the millimetre footprint
      if (!/\sviewBox\s*=/.test(s)) {
        s = s.replace(/<svg/i, '<svg viewBox="0 0 ' + pxW + ' ' + pxH + '"');
      }
      if (!/\sx\s*=/.test(s)) {
        s = s.replace(/<svg/i, '<svg x="' + fmt(t.x) + '" y="' + fmt(t.y) + '"');
      }
      if (!/\swidth\s*=/.test(s)) {
        s = s.replace(/<svg/i, '<svg width="' + fmt(Math.max(0, t.w)) +
          '" height="' + fmt(Math.max(0, t.h)) + '"');
      }
      return '<g data-fig-id="' + escAttr(el.id) + '" data-chart-type="' +
        escAttr(el.chart.chartType) + '">' + s + '</g>';
    }
    return '<g data-fig-id="' + escAttr(el.id) + '" data-chart-type="' + escAttr(el.chart.chartType) +
      '" transform="translate(' + fmt(t.x) + ' ' + fmt(t.y) + ') scale(' + kStr + ')">' + s + '</g>';
  }

  function renderPanelLabel(el, t) {
    var lay = isObj(el.panelLayout) ? el.panelLayout : {};
    if (typeof lay.label !== 'string' || lay.label === '') return '';
    var ls = isObj(lay.labelStyle) ? lay.labelStyle : {};
    var fsPt = ls.fontSizePt === undefined ? 8 : Number(ls.fontSizePt);
    if (!isFinite(fsPt) || fsPt <= 0) fail('FigRender：元素 ' + el.id + ' 的 labelStyle.fontSizePt 非法');
    var fs = fsPt * PT_TO_MM;
    var pos = lay.labelPosition === undefined ? 'top-left' : String(lay.labelPosition);
    var x, y, anchor;
    if (pos === 'top-right') {
      x = t.x + t.w; y = t.y - 0.6; anchor = 'end';
    } else if (pos === 'below') {
      x = t.x; y = t.y + t.h + fs; anchor = 'start';
    } else if (pos === 'top-left') {
      x = t.x; y = t.y - 0.6; anchor = 'start';
    } else {
      fail('FigRender：元素 ' + el.id + ' 的 panelLayout.labelPosition 非法（' + pos + '）');
    }
    return '<text x="' + fmt(x) + '" y="' + fmt(y) + '" text-anchor="' + anchor + '"' +
      ' font-family="' + escAttr(ls.fontFamily === undefined ? 'Arial' : ls.fontFamily) + '"' +
      ' font-size="' + fmt(fs) + '" font-weight="' +
      escAttr(ls.fontWeight === undefined ? 'bold' : ls.fontWeight) + '"' +
      ' fill="' + escAttr(ls.fill === undefined ? '#000000' : ls.fill) + '">' +
      esc(lay.label) + '</text>';
  }

  function renderContainer(el, ctx, t) {
    var kids = childrenOf(el, ctx);
    var inner = '';
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].visible === false) continue;
      inner += renderElement(kids[i], ctx);
    }
    var isPanel = el.type === 'panel';
    var clipId = null;
    if (isPanel) {
      // every panel gets a clipPath in <defs>; clipping is applied only
      // when the panel's clip flag is true (schema default false)
      clipId = ensureClip(ctx, el);
    }
    var a = svgStyleAttrs(el, ctx);
    var open = '<g data-fig-id="' + escAttr(el.id) + '"' +
      attrStr(pickKeys(a, GROUP_KEYS)) + rotationAttr(t) + '>';
    return open +
      (clipId && el.clip === true
        ? '<g clip-path="url(#' + escAttr(clipId) + ')">' + inner + '</g>'
        : inner) +
      (isPanel ? renderPanelLabel(el, t) : '') + '</g>';
  }

  function renderElement(el, ctx) {
    var t = resolveBox(el, ctx);
    if (el.type === 'text' && typeof el.relation_label_for === 'string') {
      var owner = ctx.byId[el.relation_label_for];
      if (owner && owner.type === 'connector') {
        var labelGeometry = connectorGeometry(owner, ctx);
        t = { x: labelGeometry.middle.x - 10, y: labelGeometry.middle.y - 2.5,
          w: 20, h: 5, rotation: 0 };
      }
    }
    switch (el.type) {
      case 'rect': return renderRect(el, ctx, t, svgStyleAttrs(el, ctx));
      case 'ellipse': return renderEllipse(el, ctx, t, svgStyleAttrs(el, ctx));
      case 'line': return renderLineOrArrow(el, ctx, t, svgStyleAttrs(el, ctx));
      case 'arrow': return renderLineOrArrow(el, ctx, t, svgStyleAttrs(el, ctx));
      case 'connector': return renderConnector(el, ctx);
      case 'path': return renderPath(el, ctx, t, svgStyleAttrs(el, ctx));
      case 'text': return renderText(el, ctx, t, svgStyleAttrs(el, ctx));
      case 'image': return renderImage(el, ctx, t);
      case 'chart': return renderChart(el, ctx, t);
      case 'group': return renderContainer(el, ctx, t);
      case 'panel': return renderContainer(el, ctx, t);
      default:
        fail('FigRender：元素 ' + el.id + ' 的 type 非法（' + String(el.type) + '）');
        return ''; // unreachable
    }
  }

  // ------------------------------------------------------------------
  // anchors overlay
  // ------------------------------------------------------------------

  function anchorBoxMm(a, W, H, fnName) {
    if (isObj(a.bbox_mm)) {
      var m = a.bbox_mm;
      if ([m.x, m.y, m.w, m.h].every(function (v) {
        return typeof v === 'number' && isFinite(v);
      })) {
        return { x: m.x, y: m.y, w: m.w, h: m.h };
      }
      fail(fnName + '：锚点 ' + a.id + ' 的 bbox_mm 数值非法');
    }
    if (isObj(a.bbox_norm)) {
      var n = a.bbox_norm;
      if ([n.x, n.y, n.w, n.h].every(function (v) {
        return typeof v === 'number' && isFinite(v);
      })) {
        return { x: n.x * W, y: n.y * H, w: n.w * W, h: n.h * H };
      }
      fail(fnName + '：锚点 ' + a.id + ' 的 bbox_norm 数值非法');
    }
    fail(fnName + '：锚点 ' + a.id + ' 缺少 bbox_mm / bbox_norm');
  }

  // FigRender.anchorBoxes(doc) -> string
  // Dashed overlay boxes + label/id text for the editor layer.
  function anchorBoxes(doc) {
    var fnName = 'FigRender.anchorBoxes';
    validateDoc(doc, fnName);
    var W = Number(doc.canvas.width_mm);
    var H = Number(doc.canvas.height_mm);
    var anchors = Array.isArray(doc.anchors) ? doc.anchors : [];
    var out = '';
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (!isObj(a) || typeof a.id !== 'string' || a.id === '') {
        fail(fnName + '：锚点必须是含 id 的对象');
      }
      var b = anchorBoxMm(a, W, H, fnName);
      out += '<g class="fig-anchor-box" data-anchor-id="' + escAttr(a.id) + '">' +
        '<rect x="' + fmt(b.x) + '" y="' + fmt(b.y) + '"' +
        ' width="' + fmt(b.w) + '" height="' + fmt(b.h) + '"' +
        ' fill="none" stroke="#00A0E9" stroke-width="0.3" stroke-dasharray="1 1"/>' +
        '<text x="' + fmt(b.x) + '" y="' + fmt(Math.max(b.y - 0.4, 2)) + '"' +
        ' font-family="Arial" font-size="' + fmt(6 * PT_TO_MM) + '" fill="#00A0E9">' +
        esc(a.label === undefined || a.label === null ? '' : a.label) +
        ' (' + esc(a.id) + ')</text></g>';
    }
    return out;
  }

  // ------------------------------------------------------------------
  // public entry points
  // ------------------------------------------------------------------

  function makeCtx(doc, fnName) {
    var ctx = buildContext(doc, fnName);
    ctx.markers = new Map();
    ctx.clips = new Map();
    ctx.usedIds = Object.create(null);
    return ctx;
  }

  function topLevelList(ctx) {
    return ctx.sorted.filter(function (e) { return isTopLevel(e, ctx.byId); });
  }

  function renderVisibleList(list, ctx) {
    var out = '';
    for (var i = 0; i < list.length; i++) {
      if (list[i].visible === false) continue;
      out += renderElement(list[i], ctx);
    }
    return out;
  }

  function panelScope(ctx, panelId, fnName) {
    if (typeof panelId !== 'string' || panelId === '') {
      fail(fnName + '：panel_id 必须是非空字符串');
    }
    var scopeElement = ctx.byId[panelId];
    if (!scopeElement) fail(fnName + '：panel_id 不存在（' + panelId + '）');
    if (scopeElement.type !== 'panel' && scopeElement.type !== 'chart') {
      fail(fnName + '：panel_id 必须指向 type=panel 或 type=chart 元素（' + panelId + '）');
    }
    if (scopeElement.visible === false) {
      fail(fnName + '：选中 panel/chart 不可见，无法导出（' + panelId + '）');
    }
    // resolveBox 使用与正常渲染相同的父 panel frame，chart 的 normalized
    // panelRelative transform 因而解析为其真实区域，而不是外层 panel bbox。
    var t = resolveBox(scopeElement, ctx);
    if (!(t.w > 0) || !(t.h > 0)) {
      fail(fnName + '：panel/chart 的导出范围必须为正数（' + panelId + '）');
    }
    var out = { x: t.x, y: t.y, w: t.w, h: t.h, panel: scopeElement };

    // panel 范围包含完整 transform/bbox（padding 留在图内，不另加边距）；
    // chart 只取自身 bbox，不继承父 panel 范围、label 或额外 padding。
    // panel 的 top-left/top-right 标签向外扩 0.6mm + 一个字号；below 扩 1.2 个字号，贴边裁切。
    var lay = scopeElement.type === 'panel' && isObj(scopeElement.panelLayout)
      ? scopeElement.panelLayout : {};
    if (typeof lay.label === 'string' && lay.label !== '') {
      var ls = isObj(lay.labelStyle) ? lay.labelStyle : {};
      var fsPt = ls.fontSizePt === undefined ? 8 : Number(ls.fontSizePt);
      if (!isFinite(fsPt) || fsPt <= 0) {
        fail(fnName + '：元素 ' + scopeElement.id + ' 的 labelStyle.fontSizePt 非法');
      }
      var fs = fsPt * PT_TO_MM;
      var pos = lay.labelPosition === undefined ? 'top-left' : String(lay.labelPosition);
      if (pos === 'top-left' || pos === 'top-right') {
        var top = t.y - 0.6 - fs;
        out.h += t.y - top;
        out.y = top;
      } else if (pos === 'below') {
        out.h += fs * 1.2;
      } else {
        fail(fnName + '：元素 ' + scopeElement.id + ' 的 panelLayout.labelPosition 非法（' + pos + '）');
      }
    }
    out.x = num3(out.x);
    out.y = num3(out.y);
    out.w = num3(out.w);
    out.h = num3(out.h);
    if (!(out.w > 0) || !(out.h > 0)) {
      fail(fnName + '：panel/chart 的导出范围舍入后无效（' + panelId + '）');
    }
    return out;
  }

  function canvasScope(ctx) {
    return { x: 0, y: 0, w: ctx.W, h: ctx.H, panel: null };
  }

  function panelBBox(doc, panelId) {
    var fnName = 'FigRender.panelBBox';
    var ctx = makeCtx(doc, fnName);
    var box = panelScope(ctx, panelId, fnName);
    return { x: box.x, y: box.y, w: box.w, h: box.h };
  }

  // FigRender.toSVG(doc, {scale=1, includeGuides=false, panel_id=null}) -> string
  // panel_id keeps its legacy name and accepts one panel or one chart.
  function toSVG(doc, opts) {
    var fnName = 'FigRender.toSVG';
    opts = opts || {};
    var scale = opts.scale === undefined ? 1 : Number(opts.scale);
    if (!isFinite(scale) || scale <= 0) fail(fnName + '：scale 必须是正数');
    var guides = opts.includeGuides === true;

    var ctx = makeCtx(doc, fnName);
    var scoped = opts.panel_id !== undefined && opts.panel_id !== null;
    var scope = scoped ? panelScope(ctx, opts.panel_id, fnName) : canvasScope(ctx);
    var body = scoped ? renderElement(scope.panel, ctx) : renderVisibleList(topLevelList(ctx), ctx);
    var defs = emitDefs(ctx);
    var out = '<svg xmlns="' + SVG_NS + '" xmlns:xlink="' + XLINK_NS + '" version="1.1"' +
      ' width="' + fmt(scope.w * scale) + 'mm" height="' + fmt(scope.h * scale) + 'mm"' +
      ' viewBox="' + fmt(scope.x) + ' ' + fmt(scope.y) + ' ' + fmt(scope.w) + ' ' + fmt(scope.h) + '">' +
      '<defs>' + defs + '</defs>';
    var bg = doc.canvas.background;
    if (opts.transparent !== true && typeof bg === 'string' && bg !== '' && bg !== 'none') {
      out += '<rect x="' + fmt(scope.x) + '" y="' + fmt(scope.y) +
        '" width="' + fmt(scope.w) + '" height="' + fmt(scope.h) +
        '" fill="' + escAttr(bg) + '"/>';
    }
    out += body;
    if (guides) out += anchorBoxes(doc);
    return out + '</svg>';
  }

  // FigRender.elementToSVG(doc, element, {scale=1}) -> string
  // Standalone fragment: marker / clipPath defs used by this subtree are
  // emitted inline. A non-unit scale wraps the fragment in a scale transform.
  function elementToSVG(doc, element, opts) {
    var fnName = 'FigRender.elementToSVG';
    opts = opts || {};
    var scale = opts.scale === undefined ? 1 : Number(opts.scale);
    if (!isFinite(scale) || scale <= 0) fail(fnName + '：scale 必须是正数');
    validateElement(element, fnName);

    var ctx = makeCtx(doc, fnName);
    var body = element.visible === false ? '' : renderElement(element, ctx);
    var defs = emitDefs(ctx);
    var out = (defs ? '<defs>' + defs + '</defs>' : '') + body;
    if (scale !== 1) out = '<g transform="scale(' + fmt(scale) + ')">' + out + '</g>';
    return out;
  }

  global.FigRender = {
    toSVG: toSVG,
    elementToSVG: elementToSVG,
    panelBBox: panelBBox,
    styleToAttrs: styleToAttrs,
    anchorBoxes: anchorBoxes
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
