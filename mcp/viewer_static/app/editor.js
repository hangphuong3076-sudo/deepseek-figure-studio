/* =========================================================================
 * editor.js — v1 web-app canvas editor (left pane, direct manipulation).
 *
 * Implements the Editor contract of v1-web-app/APP-API.md:
 *   Editor.mount(stageEl) / render() / renderOverlay() / setTool(tool)
 *   Editor.zoom(factor,{center}) / fit() / setZoom(z) / selectedBBox()
 *
 * Interactions: click / Shift-click / marquee select, drag-move with element
 * edge & canvas midline snapping (App.ui.snap), 8 resize handles, rotate
 * handle, in-place text editing (overlay textarea), Delete, arrow-key nudge
 * (Shift = x10), Ctrl+Z / Ctrl+Shift+Z / Ctrl+C / Ctrl+V / Ctrl+D / Ctrl+A,
 * Esc cancel, and six drag-to-create tools (text/rect/ellipse/line/arrow/image).
 *
 * Every document change goes through App.commit() as EditOp[]; undo/redo
 * replay history via FigOps + the awaitable, serialized App.publishDoc queue
 * (the same publication path as History.restore, including finalizeHistory).
 * Selection boxes, handles, snap guides, marquee and rubber bands are drawn
 * only in #overlay-layer and never enter exports (FigRender.toSVG is always
 * called with includeGuides:false here).
 * ======================================================================= */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // constants & module state
  // ------------------------------------------------------------------

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var TOOLS = ['select', 'marquee', 'anchor', 'text', 'rect', 'ellipse', 'line', 'arrow', 'image'];
  var DRAW_TOOLS = ['text', 'rect', 'ellipse', 'line', 'arrow', 'image'];
  var TOOL_LABELS = { select: '选择', marquee: '框选', anchor: '锚点', text: '文本',
    rect: '矩形', ellipse: '椭圆', line: '直线', arrow: '箭头', image: '图片' };
  var TOOL_BUTTON_IDS = { select: 'tool-select', marquee: 'tool-marquee', anchor: 'tool-anchor',
    text: 'tool-text', rect: 'tool-rect', ellipse: 'tool-ellipse',
    line: 'tool-line', arrow: 'tool-arrow', image: 'tool-image' };
  var HANDLE_KEYS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  var MIN_ZOOM = 0.05;
  var MAX_ZOOM = 40;
  var SNAP_RADIUS_PX = 6;        // snap attract radius on screen
  var HANDLE_HIT_PX = 9;         // handle hit radius on screen
  var HANDLE_VIS_PX = 9;         // handle visual size on screen
  var ROT_HANDLE_OFFSET_PX = 16; // rotate handle distance above the box
  var MIN_SIZE_MM = 0.1;
  var HIT_TOL_MM = 0.8;          // extra picking tolerance for thin lines
  var NUDGE_PX = 1;              // arrow key step on screen
  var NUDGE_SHIFT_PX = 10;       // arrow key step with Shift held
  var PASTE_STEP_MM = 2;         // paste/duplicate offset per repetition
  var SEL_COLOR = '#1E88E5';
  var GUIDE_COLOR = '#FF3B5C';

  var S = {
    mounted: false,
    stageEl: null, svg: null, overlay: null,
    badgeSize: null, badgeZoom: null,
    handlers: null, unsub: null,
    mode: null,            // null | 'move' | 'resize' | 'rotate' | 'marquee' | 'anchor' | 'create'
    drag: null,            // payload for move/resize/rotate
    marquee: null,         // {x0,y0,x1,y1,shift} for marquee & anchor tools
    creating: null,        // {tool,x0,y0,x1,y1,shift} for draw tools
    previewDoc: null,      // transient doc shown while dragging (never App.doc)
    guides: { v: [], h: [] },
    handleLayout: [],      // [{key,x,y}] in mm, for hit testing
    raf: 0,
    textEditor: null,      // {box,id,orig}
    editingId: null,
    clipboard: null,       // {items:[{elements,rootId}]}
    pasteCount: 0,
    pendingAfterDoc: null, // {select,textEdit} re-applied when the doc update lands
    appliedZoom: null, appliedW: null, appliedH: null,
    contextMenu: null,       // transient DOM only; never enters the figure document
    contextTarget: null
  };

  // ------------------------------------------------------------------
  // tiny utilities
  // ------------------------------------------------------------------

  function r3(v) {
    var r = Math.round(Number(v) * 1000) / 1000;
    return r === 0 ? 0 : r;
  }

  function tag(name, attrs) {
    var s = '<' + name;
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
        s += ' ' + k + '="' + attrs[k] + '"';
      }
    }
    return s + '/>';
  }

  function zoomOf() {
    var A = global.App;
    var z = A && A.ui && typeof A.ui.zoom === 'number' && isFinite(A.ui.zoom) ? A.ui.zoom : 1;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  }

  // Screen pixel -> mm via the mounted svg (client coordinates).
  function evtMm(evt) {
    var r = S.svg.getBoundingClientRect();
    var z = zoomOf();
    return { x: (evt.clientX - r.left) / z, y: (evt.clientY - r.top) / z };
  }

  function normRect(m) {
    return {
      x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1),
      w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0)
    };
  }

  function unionRect(a, b) {
    var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
    var x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function rectsOverlap(a, b) {
    return a.x <= b.x + b.w && b.x <= a.x + a.w &&
           a.y <= b.y + b.h && b.y <= a.y + a.h;
  }

  function rotatePoint(p, c, deg) {
    var rad = (deg || 0) * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var dx = p.x - c.x, dy = p.y - c.y;
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
  }

  function dedupe(arr) {
    var seen = Object.create(null), out = [];
    arr.forEach(function (v) {
      var k = Math.round(v * 1000);
      if (!seen[k]) { seen[k] = 1; out.push(v); }
    });
    return out;
  }

  function nearestLine(val, lines, thr) {
    var best = null;
    for (var i = 0; i < lines.length; i++) {
      var diff = Math.abs(val - lines[i]);
      if (diff <= thr && (!best || diff < best.diff)) {
        best = { line: lines[i], diff: diff };
      }
    }
    return best;
  }

  function handlePoint(B, key) {
    var cx = B.x + B.w / 2, cy = B.y + B.h / 2;
    switch (key) {
      case 'nw': return { x: B.x, y: B.y };
      case 'n': return { x: cx, y: B.y };
      case 'ne': return { x: B.x + B.w, y: B.y };
      case 'e': return { x: B.x + B.w, y: cy };
      case 'se': return { x: B.x + B.w, y: B.y + B.h };
      case 's': return { x: cx, y: B.y + B.h };
      case 'sw': return { x: B.x, y: B.y + B.h };
      case 'w': return { x: B.x, y: cy };
      default: return { x: cx, y: cy };
    }
  }

  // ------------------------------------------------------------------
  // document helpers (all reads; mutations only via App.commit)
  // ------------------------------------------------------------------

  // Selection ids minus those whose ancestor is selected too.
  function topmostSelected(doc) {
    var A = global.App;
    var ids = (A && A.selection && A.selection()) || [];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (!FigDoc.get(doc, id)) continue;
      var anc = FigDoc.ancestors(doc, id);
      var covered = false;
      for (var j = 0; j < anc.length; j++) {
        if (ids.indexOf(anc[j].id) >= 0) { covered = true; break; }
      }
      if (!covered) out.push(id);
    }
    return out;
  }

  function unionSelBBox(doc, ids) {
    var out = null;
    (ids || []).forEach(function (id) {
      if (!FigDoc.get(doc, id)) return;
      var b = FigDoc.bbox(doc, id, { recursive: true });
      var r = normRect({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
      out = out ? unionRect(out, r) : r;
    });
    return out;
  }

  // FigDoc.hitTest first, then a tolerance pass for thin line/arrow elements.
  function hitElement(p) {
    var A = global.App;
    var doc = A.doc;
    var el = FigDoc.hitTest(doc, { x_mm: p.x, y_mm: p.y });
    if (el) return el;
    var cands = doc.elements
      .filter(function (e) { return e && !e.parent_id && e.visible !== false && e.locked !== true; })
      .sort(function (a, b) { return (b.z || 0) - (a.z || 0); });
    for (var i = 0; i < cands.length; i++) {
      var e = cands[i];
      if (e.type !== 'line' && e.type !== 'arrow') continue;
      var b = FigDoc.bbox(doc, e.id, { recursive: false });
      var x0 = Math.min(b.x, b.x + b.w) - HIT_TOL_MM;
      var y0 = Math.min(b.y, b.y + b.h) - HIT_TOL_MM;
      var w = Math.abs(b.w) + 2 * HIT_TOL_MM;
      var h = Math.abs(b.h) + 2 * HIT_TOL_MM;
      if (p.x >= x0 && p.x <= x0 + w && p.y >= y0 && p.y <= y0 + h) return e;
    }
    return null;
  }

  // A chart or group may cover its text nodes. Find the actual text under the
  // pointer as a fallback so both T-click and double-click can edit it.
  function textElementAt(p) {
    var doc = global.App && global.App.doc;
    if (!doc) return null;
    var direct = hitElement(p);
    if (direct && direct.type === 'text' && !direct.locked) return direct;
    var matches = (doc.elements || []).filter(function (el) {
      if (!el || el.type !== 'text' || el.visible === false || el.locked) return false;
      var parentId = el.parent_id;
      while (parentId) {
        var parent = FigDoc.get(doc, parentId);
        if (!parent) break;
        if (parent.visible === false || parent.locked) return false;
        parentId = parent.parent_id;
      }
      var b = FigDoc.bbox(doc, el.id, { recursive: false });
      var x0 = Math.min(b.x, b.x + b.w), x1 = Math.max(b.x, b.x + b.w);
      var y0 = Math.min(b.y, b.y + b.h), y1 = Math.max(b.y, b.y + b.h);
      return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    }).sort(function (a, b) {
      var za = typeof a.z === 'number' ? a.z : 0;
      var zb = typeof b.z === 'number' ? b.z : 0;
      return zb - za;
    });
    return matches[0] || null;
  }

  // Vertical/horizontal snap lines: canvas edges + midlines and every other
  // element's edges/centers (excluded: the dragged selection and descendants).
  function collectSnapLines(doc, ids) {
    var W = doc.canvas.width_mm, H = doc.canvas.height_mm;
    var v = [0, W / 2, W], h = [0, H / 2, H];
    var ex = Object.create(null);
    (ids || []).forEach(function (id) {
      ex[id] = true;
      var desc = FigDoc.descendants(doc, id, { includeSelf: false });
      desc.forEach(function (d) { ex[d.id] = true; });
    });
    doc.elements.forEach(function (el) {
      if (!el || ex[el.id] || el.visible === false) return;
      var b = FigDoc.bbox(doc, el.id, { recursive: true });
      var x0 = Math.min(b.x, b.x + b.w), x1 = Math.max(b.x, b.x + b.w);
      var y0 = Math.min(b.y, b.y + b.h), y1 = Math.max(b.y, b.y + b.h);
      if (x1 - x0 > 0.01) v.push(x0, (x0 + x1) / 2, x1);
      if (y1 - y0 > 0.01) h.push(y0, (y0 + y1) / 2, y1);
    });
    return { v: dedupe(v), h: dedupe(h) };
  }

  // App.commit may be synchronous or async (the contract awaits
  // finalizeHistory before setDoc). `onDone` receives the result in both
  // cases and is the place for post-commit UI updates.
  function commit(ops, label, onDone) {
    var A = global.App;
    var emsg = function (e) { return e && e.message ? e.message : String(e); };
    var r;
    try {
      r = A.commit(ops, { label: label || '', source: 'user' });
    } catch (e) {
      if (typeof A.error === 'function') A.error('提交失败：' + emsg(e));
      if (onDone) onDone({ doc: A.doc, applied: 0 });
      return { doc: A.doc, applied: 0 };
    }
    if (r && typeof r.then === 'function') {
      r.then(function (res) {
        if (onDone) onDone(res || { doc: A.doc, applied: 0 });
      }).catch(function (e) {
        if (typeof A.error === 'function') A.error('提交失败：' + emsg(e));
        if (onDone) onDone({ doc: A.doc, applied: 0 });
      });
      return { doc: A.doc, applied: undefined, pending: true };
    }
    if (onDone) onDone(r || { doc: A.doc, applied: 0 });
    return r || { doc: A.doc, applied: 0 };
  }

  // ------------------------------------------------------------------
  // mount / unmount / DOM wiring
  // ------------------------------------------------------------------

  function ensureUiDefaults(A) {
    if (!A.ui || typeof A.ui !== 'object') A.ui = {};
    if (TOOLS.indexOf(A.ui.tool) < 0) A.ui.tool = 'select';
    if (typeof A.ui.zoom !== 'number' || !isFinite(A.ui.zoom) || A.ui.zoom <= 0) A.ui.zoom = 1;
    if (A.ui.showGuides !== true && A.ui.showGuides !== false) A.ui.showGuides = true;
    if (A.ui.snap !== true && A.ui.snap !== false) A.ui.snap = true;
  }

  function mount(stageEl) {
    if (!stageEl || stageEl.nodeType !== 1) {
      throw new Error('Editor.mount 需要一个 DOM 元素作为画布挂载点');
    }
    var A = global.App;
    if (!A) throw new Error('App 未加载，Editor 无法挂载');
    if (typeof FigDoc === 'undefined' || typeof FigRender === 'undefined' || typeof FigOps === 'undefined') {
      throw new Error('共享内核（FigDoc/FigOps/FigRender）未加载，Editor 无法挂载');
    }
    unmount();
    ensureUiDefaults(A);
    S.stageEl = stageEl;
    var cs = global.getComputedStyle ? global.getComputedStyle(stageEl) : null;
    if (!cs || cs.position === 'static') stageEl.style.position = 'relative';

    var old1 = stageEl.querySelector('#svg-stage');
    if (old1 && old1.parentNode) old1.parentNode.removeChild(old1);
    var old2 = stageEl.querySelector('#overlay-layer');
    if (old2 && old2.parentNode) old2.parentNode.removeChild(old2);

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = 'svg-stage';
    svg.style.display = 'block';
    var overlay = document.createElementNS(SVG_NS, 'svg');
    overlay.id = 'overlay-layer';
    overlay.style.position = 'absolute';
    overlay.style.pointerEvents = 'none';
    overlay.style.overflow = 'visible';
    stageEl.appendChild(svg);
    stageEl.appendChild(overlay);
    S.svg = svg;
    S.overlay = overlay;

    A.stage = {
      svgEl: svg,
      overlayEl: overlay,
      pxPerMm: zoomOf(),
      screenToMm: function (evt) { return evtMm(evt); },
      mmToScreen: function (pt) {
        var r = S.svg.getBoundingClientRect();
        var z = zoomOf();
        return { x: pt.x_mm * z + r.left, y: pt.y_mm * z + r.top };
      }
    };

    ensureBadges();
    wireToolbar();

    var h = {
      down: onStageMouseDown,
      move: onWindowMouseMove,
      up: onWindowMouseUp,
      dbl: onStageDblClick,
      key: onKeyDown,
      context: onStageContextMenu,
      contextOutside: onDocumentMouseDown,
      contextKey: onContextMenuKeyDown,
      wheel: onStageWheel,
      scroll: function () { closeContextMenu(); syncBadges(); },
      resize: function () { closeContextMenu(); syncBadges(); }
    };
    S.handlers = h;
    stageEl.addEventListener('mousedown', h.down);
    stageEl.addEventListener('dblclick', h.dbl);
    stageEl.addEventListener('contextmenu', h.context);
    stageEl.addEventListener('wheel', h.wheel, { passive: false });
    stageEl.addEventListener('scroll', h.scroll);
    window.addEventListener('mousemove', h.move);
    window.addEventListener('mouseup', h.up);
    document.addEventListener('mousedown', h.contextOutside, true);
    document.addEventListener('keydown', h.contextKey, true);
    document.addEventListener('keydown', h.key);
    window.addEventListener('resize', h.resize);

    S.unsub = [
      A.on('doc:changed', onDocChanged),
      A.on('selection:changed', onSelectionChanged),
      A.on('ui:changed', onUiChanged)
    ];
    S.mounted = true;
    applyZoomSizes();
    updateCursor();
    render();
  }

  function unmount() {
    if (S.unsub) {
      S.unsub.forEach(function (f) { try { f(); } catch (e) { /* noop */ } });
      S.unsub = null;
    }
    var h = S.handlers;
    if (h && S.stageEl) {
      S.stageEl.removeEventListener('mousedown', h.down);
      S.stageEl.removeEventListener('dblclick', h.dbl);
      S.stageEl.removeEventListener('contextmenu', h.context);
      S.stageEl.removeEventListener('wheel', h.wheel);
      S.stageEl.removeEventListener('scroll', h.scroll);
    }
    if (h) {
      window.removeEventListener('mousemove', h.move);
      window.removeEventListener('mouseup', h.up);
      document.removeEventListener('mousedown', h.contextOutside, true);
      document.removeEventListener('keydown', h.contextKey, true);
      document.removeEventListener('keydown', h.key);
      window.removeEventListener('resize', h.resize);
    }
    closeContextMenu();
    S.handlers = null;
    teardownTextEditor();
    [['#svg-stage', 'svg'], ['#overlay-layer', 'overlay'],
     ['#editor-size-badge', 'badgeSize'], ['#editor-zoom-badge', 'badgeZoom']]
      .forEach(function (pair) {
        var node = S[pair[1]];
        if (node && node.parentNode) node.parentNode.removeChild(node);
      });
    S.mounted = false;
    S.stageEl = null; S.svg = null; S.overlay = null;
    S.badgeSize = null; S.badgeZoom = null;
    S.mode = null; S.drag = null; S.marquee = null; S.creating = null;
    S.previewDoc = null; S.guides = { v: [], h: [] };
    S.handleLayout = []; S.clipboard = null; S.pasteCount = 0;
    S.appliedZoom = null; S.appliedW = null; S.appliedH = null;
    if (global.App && global.App.stage) global.App.stage = null;
  }

  function ensureBadges() {
    var host = (S.stageEl && S.stageEl.parentElement) || S.stageEl;
    if (!host) return;
    var cs = global.getComputedStyle ? global.getComputedStyle(host) : null;
    if (cs && cs.position === 'static') host.style.position = 'relative';
    var mk = function (id) {
      var el = document.getElementById(id);
      if (!el || !host.contains(el)) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        el = document.createElement('div');
        el.id = id;
        host.appendChild(el);
      }
      // 样式全部内联（self-contained），不随 app.css 迭代漂移；
      // pointer-events:none 保证角标永远不拦截画布点击。
      el.style.cssText = 'position:absolute;font:11px/1.4 sans-serif;' +
        'background:rgba(255,255,255,0.92);color:#24313f;padding:2px 9px;' +
        'border:1px solid rgba(31,45,61,0.18);border-radius:10px;' +
        'pointer-events:none;z-index:20;white-space:nowrap;box-sizing:border-box;';
      return el;
    };
    S.badgeSize = mk('editor-size-badge');
    S.badgeZoom = mk('editor-zoom-badge');
    if (S.badgeZoom) {
      S.badgeZoom.title = '视图缩放：只改变画布显示大小，不改变文档数据 / 导出 DPI';
    }
    var zl = document.getElementById('zoom-level');
    if (zl) {
      zl.title = '视图缩放（100% ≈ 1 px/mm）；点击复位为适配窗口。不影响文档数据 / DPI';
    }
    syncBadges();
  }

  function wireToolbar() {
    var A = global.App;
    Object.keys(TOOL_BUTTON_IDS).forEach(function (tool) {
      var btn = document.getElementById(TOOL_BUTTON_IDS[tool]);
      if (!btn || btn.__editorToolWired) return;
      btn.__editorToolWired = true;
      btn.addEventListener('click', function () { setTool(tool); });
    });
    updateToolbarActive();
    if (A && A.ui) updateCursor();
  }

  function updateToolbarActive() {
    var A = global.App;
    var tool = A && A.ui ? A.ui.tool : 'select';
    Object.keys(TOOL_BUTTON_IDS).forEach(function (t) {
      var btn = document.getElementById(TOOL_BUTTON_IDS[t]);
      if (!btn) return;
      if (t === tool) btn.classList.add('active');
      else btn.classList.remove('active');
      btn.setAttribute('aria-pressed', t === tool ? 'true' : 'false');
    });
  }

  function updateCursor() {
    var A = global.App;
    if (!S.stageEl || !A || !A.ui) return;
    S.stageEl.style.cursor = (A.ui.tool === 'select') ? 'default' : 'crosshair';
  }

  // ------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------

  function svgInnerOf(doc) {
    var s = FigRender.toSVG(doc, { includeGuides: false });
    return s.slice(s.indexOf('>') + 1, s.lastIndexOf('</svg>'));
  }

  function render() {
    var A = global.App;
    if (!A || !A.doc || !S.svg) return;
    var inner = '';
    try {
      inner = svgInnerOf(A.doc);
    } catch (e) {
      if (typeof A.error === 'function') A.error('渲染失败：' + e.message);
      inner = '';
    }
    S.svg.innerHTML = inner;
    applyZoomSizes();
    renderOverlay();
    updateBadges();
    if (S.editingId && FigDoc.get(A.doc, S.editingId)) positionTextEditor();
  }

  function setPx(el, w, h) {
    el.setAttribute('width', w + 'px');
    el.setAttribute('height', h + 'px');
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  }

  function applyZoomSizes() {
    var A = global.App;
    if (!A || !A.doc || !S.svg) return;
    var c = A.doc.canvas;
    var z = zoomOf();
    var wpx = c.width_mm * z, hpx = c.height_mm * z;
    var vb = '0 0 ' + c.width_mm + ' ' + c.height_mm;
    S.svg.setAttribute('viewBox', vb);
    S.overlay.setAttribute('viewBox', vb);
    setPx(S.svg, wpx, hpx);
    setPx(S.overlay, wpx, hpx);
    if (A.stage) A.stage.pxPerMm = z;
    S.appliedZoom = z; S.appliedW = c.width_mm; S.appliedH = c.height_mm;
    syncOverlayPos();
    syncBadges();
  }

  function syncOverlayPos() {
    if (!S.overlay || !S.svg) return;
    S.overlay.style.left = S.svg.offsetLeft + 'px';
    S.overlay.style.top = S.svg.offsetTop + 'px';
  }

  function syncBadges() {
    var st = S.stageEl;
    if (!st) return;
    // 角标挂在 stage 的父容器上（父容器不滚动、不随文档缩放）。
    // 用 getBoundingClientRect 对齐 stage 的可视视口四角，
    // 不再用 scrollLeft/clientWidth 估算——后者在缩放/平移后会漂移。
    var sr = st.getBoundingClientRect();
    if (sr.width <= 0 || sr.height <= 0) return;
    var host = (st.parentElement && st.parentElement !== st) ? st.parentElement : st;
    var ox = 0, oy = 0;
    if (host !== st) {
      var hr = host.getBoundingClientRect();
      ox = sr.left - hr.left;
      oy = sr.top - hr.top;
    }
    var pin = function (el, x, fromBottom) {
      if (!el) return;
      var r = el.getBoundingClientRect();
      var w = r.width || el.offsetWidth || 0;
      var h = r.height || el.offsetHeight || 0;
      var y = fromBottom ? (oy + sr.height - h - 8) : (oy + 6);
      var maxX = Math.max(4, ox + sr.width - w - 4);
      var maxY = Math.max(4, oy + sr.height - h - 4);
      el.style.left = Math.round(Math.max(4, Math.min(x, maxX))) + 'px';
      el.style.top = Math.round(Math.min(y, maxY)) + 'px';
    };
    pin(S.badgeSize, ox + 8, false);
    pin(S.badgeZoom, ox + 8, true);
    var zl = document.getElementById('zoom-level');
    if (zl) zl.textContent = Math.round(zoomOf() * 100) + '%';
  }

  function updateBadges() {
    var A = global.App;
    if (S.badgeSize && A && A.doc) {
      var c = A.doc.canvas;
      S.badgeSize.textContent = c.width_mm + ' × ' + c.height_mm + ' mm · ' + (c.dpi || 300) + ' DPI';
    }
    if (S.badgeZoom) {
      S.badgeZoom.textContent = '缩放 ' + Math.round(zoomOf() * 100) + '%';
    }
    syncBadges();
  }

  // Live drag feedback: render the preview doc without touching App.doc.
  function schedulePreview() {
    if (S.raf) return;
    S.raf = requestAnimationFrame(function () {
      S.raf = 0;
      flushPreview();
    });
  }

  function flushPreview() {
    var A = global.App;
    if (!A || !S.svg) return;
    var d = S.previewDoc || A.doc;
    try {
      S.svg.innerHTML = svgInnerOf(d);
    } catch (e) { /* keep last good frame */ }
    renderOverlay();
  }

  function previewOps(ops) {
    var A = global.App;
    try {
      S.previewDoc = FigOps.applyAll(FigDoc.clone(A.doc), ops, { label: '预览' }).doc;
    } catch (e) {
      S.previewDoc = null;
    }
    schedulePreview();
  }

  // ------------------------------------------------------------------
  // overlay layer: anchors + selection + handles + guides + rubber bands
  // ------------------------------------------------------------------

  function renderOverlay() {
    var A = global.App;
    if (!A || !A.doc || !S.overlay) return;
    var d = S.previewDoc || A.doc;
    var z = zoomOf();
    var W = A.doc.canvas.width_mm, H = A.doc.canvas.height_mm;
    var out = [];

    if (A.ui.showGuides !== false) {
      try {
        var ab = FigRender.anchorBoxes(A.doc);
        if (ab) out.push(ab);
      } catch (e) { /* anchors are optional decoration */ }
    }

    var sel = ((A.selection && A.selection()) || []).filter(function (id) {
      return FigDoc.get(d, id);
    });
    var sw = r3(1 / z);

    // per-element selection boxes (track the live preview while dragging)
    sel.forEach(function (id) {
      var el = FigDoc.get(d, id);
      var b = FigDoc.bbox(d, id, { recursive: true });
      var rot = (el.transform && el.transform.rotation) || 0;
      out.push(tag('rect', {
        x: r3(b.x), y: r3(b.y),
        width: r3(Math.abs(b.w)), height: r3(Math.abs(b.h)),
        fill: 'none', stroke: SEL_COLOR, 'stroke-width': sw,
        'class': 'fig-sel-box',
        transform: rot ? ('rotate(' + r3(rot) + ' ' + r3(b.x + b.w / 2) + ' ' + r3(b.y + b.h / 2) + ')') : null
      }));
    });

    // handles only when idle (layout is hit-tested in screen space)
    S.handleLayout = [];
    if (sel.length && S.mode === null) {
      var single = sel.length === 1 ? FigDoc.get(d, sel[0]) : null;
      var B = unionSelBBox(d, sel);
      if (B) {
        var rot2 = (single && single.transform && single.transform.rotation) || 0;
        var c = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
        var hs = HANDLE_VIS_PX / z, half = hs / 2;
        HANDLE_KEYS.forEach(function (k) {
          var pt = handlePoint(B, k);
          if (rot2) pt = rotatePoint(pt, c, rot2);
          S.handleLayout.push({ key: k, x: pt.x, y: pt.y });
          out.push(tag('rect', {
            x: r3(pt.x - half), y: r3(pt.y - half),
            width: r3(hs), height: r3(hs),
            fill: '#FFFFFF', stroke: SEL_COLOR, 'stroke-width': sw, 'class': 'fig-handle'
          }));
        });
        if (single) {
          var rp = rotatePoint({ x: c.x, y: B.y }, c, rot2);
          var dx = rp.x - c.x, dy = rp.y - c.y;
          var len = Math.hypot(dx, dy) || 1;
          var off = ROT_HANDLE_OFFSET_PX / z;
          var ctr = { x: rp.x + dx / len * off, y: rp.y + dy / len * off };
          S.handleLayout.push({ key: 'rotate', x: ctr.x, y: ctr.y });
          out.push(tag('line', {
            x1: r3(rp.x), y1: r3(rp.y), x2: r3(ctr.x), y2: r3(ctr.y),
            stroke: SEL_COLOR, 'stroke-width': sw
          }));
          out.push(tag('circle', {
            cx: r3(ctr.x), cy: r3(ctr.y), r: r3(hs * 0.7),
            fill: '#FFFFFF', stroke: SEL_COLOR, 'stroke-width': sw, 'class': 'fig-rotate-handle'
          }));
        }
      }
    }

    // snap reference lines (overlay only, never exported)
    S.guides.v.forEach(function (x) {
      out.push(tag('line', {
        x1: r3(x), y1: 0, x2: r3(x), y2: r3(H),
        stroke: GUIDE_COLOR, 'stroke-width': sw
      }));
    });
    S.guides.h.forEach(function (y) {
      out.push(tag('line', {
        x1: 0, y1: r3(y), x2: r3(W), y2: r3(y),
        stroke: GUIDE_COLOR, 'stroke-width': sw
      }));
    });

    // marquee / anchor rubber band
    if ((S.mode === 'marquee' || S.mode === 'anchor') && S.marquee) {
      var m = normRect(S.marquee);
      var ac = S.mode === 'anchor';
      out.push(tag('rect', {
        x: r3(m.x), y: r3(m.y), width: r3(m.w), height: r3(m.h),
        fill: ac ? 'rgba(0,160,233,0.08)' : 'rgba(30,136,229,0.08)',
        stroke: ac ? '#00A0E9' : SEL_COLOR, 'stroke-width': sw,
        'stroke-dasharray': r3(3 / z) + ' ' + r3(2 / z)
      }));
    }

    // create-tool rubber band
    if (S.mode === 'create' && S.creating) {
      var cr = S.creating;
      if (cr.tool === 'line' || cr.tool === 'arrow') {
        out.push(tag('line', {
          x1: r3(cr.x0), y1: r3(cr.y0), x2: r3(cr.x1), y2: r3(cr.y1),
          stroke: '#888888', 'stroke-width': sw, 'stroke-dasharray': r3(3 / z) + ' ' + r3(2 / z)
        }));
      } else {
        var nb = normRect(cr);
        out.push(tag('rect', {
          x: r3(nb.x), y: r3(nb.y), width: r3(nb.w), height: r3(nb.h),
          fill: 'none', stroke: '#888888', 'stroke-width': sw,
          'stroke-dasharray': r3(3 / z) + ' ' + r3(2 / z)
        }));
      }
    }

    S.overlay.innerHTML = out.join('');
  }

  // ------------------------------------------------------------------
  // event dispatch: mouse
  // ------------------------------------------------------------------

  function onStageMouseDown(evt) {
    var A = global.App;
    if (!A || !A.doc || !S.svg) return;
    if (evt.button !== 0) return;
    var t = evt.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (S.editingId) { commitTextEditor(); return; } // click ends in-place editing
    if (S.mode) return;
    evt.preventDefault();
    var tool = (A.ui && A.ui.tool) || 'select';
    var p = evtMm(evt);

    if (tool === 'text') {
      var existingText = textElementAt(p);
      if (existingText) {
        if (typeof A.select === 'function') A.select([existingText.id]);
        startTextEditor(existingText.id);
        return;
      }
    }

    if (DRAW_TOOLS.indexOf(tool) >= 0) {
      S.mode = 'create';
      S.creating = { tool: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: evt.shiftKey };
      renderOverlay();
      return;
    }
    if (tool === 'marquee') { beginMarquee(p, evt, false); return; }
    if (tool === 'anchor') { beginMarquee(p, evt, true); return; }

    // select tool
    if (evt.detail >= 2 && !evt.shiftKey) {
      var dblText = textElementAt(p);
      if (dblText) {
        if (typeof A.select === 'function') A.select([dblText.id]);
        startTextEditor(dblText.id);
        return;
      }
    }
    var hd = handleAt(evt);
    if (hd) { beginHandle(hd, p); return; }
    var el = hitElement(p);
    if (el) {
      var already = A.selectionSet && A.selectionSet.has(el.id);
      if (evt.shiftKey) {
        if (typeof A.toggleSelect === 'function') A.toggleSelect(el.id);
        if (!(A.selectionSet && A.selectionSet.has(el.id))) return; // toggled off: no drag
      } else if (!already) {
        A.select([el.id]);
      }
      // R04：图表部件命中（系列/图例/轴标题/峰标注）→ 记录语义部件引用，
      // 供属性面板做局部样式编辑；整体拖动仍以 chart 元素为对象。
      setChartPartRef(el, evt.target);
      beginMove(p);
      return;
    }
    clearChartPartRef();
    beginMarquee(p, evt, false);
  }

  // R04：从点击目标向上找 data-chart-part / data-series-key / data-peak-id
  // 与所属 chart 的 data-fig-id；仅当命中的顶层元素是 chart 时生效。
  function setChartPartRef(chartEl, targetNode) {
    var A = global.App;
    if (!A.ui || typeof A.ui !== 'object') A.ui = {};
    if (!chartEl || chartEl.type !== 'chart') {
      clearChartPartRef();
      return null;
    }
    var node = targetNode, part = null, key = null, peakId = null, figId = null;
    var guard = 0;
    while (node && node !== S.svg && guard++ < 40) {
      if (node.getAttribute) {
        if (!part) part = node.getAttribute('data-chart-part');
        if (!key) key = node.getAttribute('data-series-key');
        if (!peakId) peakId = node.getAttribute('data-peak-id');
        if (!figId) figId = node.getAttribute('data-fig-id');
      }
      node = node.parentNode;
    }
    if (!figId || figId !== chartEl.id) {
      // 部件未携带所属 chart 标识（如旧渲染输出）：视为整图选择
      clearChartPartRef();
      return null;
    }
    if (!part) {
      clearChartPartRef();
      return null;
    }
    A.ui.chartPart = {
      chartId: chartEl.id,
      part: part,
      seriesKey: key || null,
      peakId: peakId || null
    };
    if (typeof A.emit === 'function') A.emit('ui:changed', { chartPart: A.ui.chartPart });
    return A.ui.chartPart;
  }

  function clearChartPartRef() {
    var A = global.App;
    if (A && A.ui && A.ui.chartPart) {
      A.ui.chartPart = null;
      if (typeof A.emit === 'function') A.emit('ui:changed', { chartPart: null });
    }
  }

  function beginMarquee(p, evt, isAnchor) {
    var A = global.App;
    S.mode = isAnchor ? 'anchor' : 'marquee';
    S.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: !!evt.shiftKey };
    if (!isAnchor && !evt.shiftKey && typeof A.clearSelection === 'function') {
      A.clearSelection();
    }
    renderOverlay();
  }

  function beginMove(p) {
    var A = global.App;
    var ids = topmostSelected(A.doc);
    if (!ids.length) return;
    S.mode = 'move';
    S.drag = {
      ids: ids,
      start: p,
      dx: 0, dy: 0,
      bbox: unionSelBBox(A.doc, ids),
      lines: collectSnapLines(A.doc, ids)
    };
  }

  function beginHandle(hd, p) {
    var A = global.App;
    var ids = topmostSelected(A.doc);
    if (!ids.length) return;
    if (hd.key === 'rotate') {
      if (ids.length !== 1) return;
      var el = FigDoc.get(A.doc, ids[0]);
      var b = FigDoc.bbox(A.doc, ids[0], { recursive: true });
      var cx = b.x + Math.abs(b.w) / 2, cy = b.y + Math.abs(b.h) / 2;
      S.mode = 'rotate';
      S.drag = {
        id: ids[0], ids: ids,
        center: { x: cx, y: cy },
        rot0: (el.transform && el.transform.rotation) || 0,
        startA: Math.atan2(p.y - cy, p.x - cx),
        changed: false, rotation: null
      };
      return;
    }
    var single = ids.length === 1 ? FigDoc.get(A.doc, ids[0]) : null;
    var rot = (single && single.transform && single.transform.rotation) || 0;
    var B = ids.length === 1
      ? normRect(function (bb) { return { x0: bb.x, y0: bb.y, x1: bb.x + bb.w, y1: bb.y + bb.h }; }
          (FigDoc.bbox(A.doc, ids[0], { recursive: true })))
      : unionSelBBox(A.doc, ids);
    if (!B || B.w <= 0 || B.h <= 0) return;
    S.mode = 'resize';
    S.drag = {
      ids: ids, handle: hd.key, B: B, rot: rot,
      lines: collectSnapLines(A.doc, ids),
      changed: false, lastOps: null
    };
    resizeTo(p);
  }

  function handleAt(evt) {
    if (!S.handleLayout.length || !S.svg) return null;
    var r = S.svg.getBoundingClientRect();
    var px = evt.clientX - r.left, py = evt.clientY - r.top;
    var z = zoomOf();
    for (var i = 0; i < S.handleLayout.length; i++) {
      var h = S.handleLayout[i];
      var dx = h.x * z - px, dy = h.y * z - py;
      if (dx * dx + dy * dy <= HANDLE_HIT_PX * HANDLE_HIT_PX) return h;
    }
    return null;
  }

  function onWindowMouseMove(evt) {
    if (!S.mode) return;
    var A = global.App;
    if (!A || !A.doc) return;
    var p = evtMm(evt);
    switch (S.mode) {
      case 'move': moveTo(p, evt); break;
      case 'resize': resizeTo(p); break;
      case 'rotate': rotateTo(p); break;
      case 'marquee':
      case 'anchor':
        S.marquee.x1 = p.x; S.marquee.y1 = p.y;
        renderOverlay();
        break;
      case 'create':
        S.creating.x1 = p.x; S.creating.y1 = p.y;
        S.creating.shift = evt.shiftKey;
        renderOverlay();
        break;
    }
  }

  function onWindowMouseUp() {
    var A = global.App;
    var mode = S.mode;
    if (!mode) return;
    var d = S.drag;
    var todo = null, label = '';

    if (mode === 'marquee') {
      finishMarquee();
      S.mode = null; S.marquee = null; S.guides = { v: [], h: [] };
      renderOverlay();
      return;
    }
    if (mode === 'anchor') {
      finishAnchor();
      S.mode = null; S.marquee = null; S.guides = { v: [], h: [] };
      renderOverlay();
      return;
    }
    if (mode === 'create') {
      finishCreate();
      S.mode = null; S.creating = null; S.guides = { v: [], h: [] };
      renderOverlay();
      return;
    }
    if (mode === 'move' && d && ((d.dx || 0) !== 0 || (d.dy || 0) !== 0)) {
      todo = [{ op: 'move', targets: d.ids, dx: d.dx, dy: d.dy }];
      label = '移动元素';
    } else if (mode === 'resize' && d && d.changed && d.lastOps && d.lastOps.length) {
      todo = d.lastOps;
      label = '缩放元素';
    } else if (mode === 'rotate' && d && d.changed && d.rotation !== null) {
      todo = [{ op: 'rotate', targets: [d.id], rotation: d.rotation }];
      label = '旋转元素';
    }

    S.mode = null; S.drag = null; S.previewDoc = null;
    S.guides = { v: [], h: [] };
    if (todo) commit(todo, label);
    render();
  }

  function onStageDblClick(evt) {
    var A = global.App;
    if (!A || !A.doc || !S.svg) return;
    var t = evt.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (S.editingId || S.mode) return;
    var el = textElementAt(evtMm(evt));
    if (el && el.type === 'text') {
      evt.preventDefault();
      startTextEditor(el.id);
    }
  }

  function closeContextMenu() {
    if (S.contextMenu && S.contextMenu.parentNode) {
      S.contextMenu.parentNode.removeChild(S.contextMenu);
    }
    S.contextMenu = null;
    S.contextTarget = null;
  }

  function contextFailure(prefix, err) {
    var msg = err && err.message ? err.message : String(err);
    if (global.App && typeof global.App.error === 'function') {
      global.App.error(prefix + msg);
    } else if (global.Ui && typeof global.Ui.toast === 'function') {
      global.Ui.toast(prefix + msg, { type: 'error' });
    }
  }

  function anchorRect(anchor) {
    var b = anchor && anchor.bbox_mm;
    if (!b) return null;
    var values = [b.x, b.y, b.w, b.h];
    if (!values.every(function (v) { return typeof v === 'number' && isFinite(v); })) return null;
    return normRect({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
  }

  function pointInRect(p, r) {
    return !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  function anchorAtPoint(doc, p) {
    var best = null;
    var bestArea = Infinity;
    ((doc && doc.anchors) || []).forEach(function (anchor) {
      var r = anchorRect(anchor);
      if (!pointInRect(p, r)) return;
      var area = r.w * r.h;
      if (area < bestArea) { best = anchor; bestArea = area; }
    });
    return best;
  }

  function sameIds(a, b) {
    if (!Array.isArray(a) || a.length !== b.length) return false;
    return b.every(function (id) { return a.indexOf(id) >= 0; });
  }

  function sameBBox(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 &&
      Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
  }

  function reusableAnchor(doc, ids, bbox) {
    var anchors = (doc && doc.anchors) || [];
    var i;
    for (i = 0; i < anchors.length; i++) {
      if (sameIds(anchors[i] && anchors[i].element_ids, ids)) return anchors[i];
    }
    for (i = 0; i < anchors.length; i++) {
      if (sameBBox(anchorRect(anchors[i]), bbox)) return anchors[i];
    }
    return null;
  }

  function resolveContextTarget(p) {
    var A = global.App;
    var doc = A.doc;
    var hit = hitElement(p);
    var region = anchorAtPoint(doc, p);
    var selected = ((A.selection && A.selection()) || []).filter(function (id) {
      return !!FigDoc.get(doc, id);
    });
    if (hit && selected.indexOf(hit.id) < 0) {
      A.select([hit.id]);
      selected = [hit.id];
    }
    var ids = topmostSelected(doc);
    if (hit && selected.length > 1) {
      return { kind: 'selection', ids: ids, elementIds: selected.slice(), point: p, region: region };
    }
    if (hit) return { kind: 'element', id: hit.id, ids: [hit.id], point: p, region: region };
    if (region) return { kind: 'anchor', id: region.id, point: p, region: region };
    if (ids.length && pointInRect(p, unionSelBBox(doc, ids))) {
      if (ids.length === 1) return { kind: 'element', id: ids[0], ids: ids, point: p, region: null };
      return { kind: 'selection', ids: ids, elementIds: ids.slice(), point: p, region: null };
    }
    return null;
  }

  function contextTargetName(target) {
    var A = global.App;
    if (!target) return '未命中元素或锚点';
    if (target.kind === 'anchor') {
      var anchor = ((A.doc && A.doc.anchors) || []).filter(function (a) {
        return a && a.id === target.id;
      })[0];
      return '锚点 [' + String(anchor && anchor.label != null ? anchor.label : target.id) + ']';
    }
    if (target.kind === 'selection') return target.ids.length + ' 个选中元素';
    var el = FigDoc.get(A.doc, target.id);
    if (!el) return '元素已不存在';
    var name = el.name && String(el.name).trim() ? String(el.name) : el.id;
    return (el.type || '元素') + ' · ' + name;
  }

  function ensureTargetAnchor(target) {
    var A = global.App;
    if (!A || !A.doc || !target) return Promise.reject(new Error('没有可创建锚点的选区'));
    if (target.kind === 'anchor') {
      var existing = (A.doc.anchors || []).filter(function (a) { return a && a.id === target.id; })[0];
      return existing ? Promise.resolve(existing) : Promise.reject(new Error('该锚点已不存在'));
    }
    var ids = (target.ids || []).filter(function (id) { return !!FigDoc.get(A.doc, id); });
    if (!ids.length) return Promise.reject(new Error('目标元素已不存在'));
    var bbox = unionSelBBox(A.doc, ids);
    if (!bbox || bbox.w <= 0 || bbox.h <= 0) {
      return Promise.reject(new Error('选区没有有效的包围盒，无法创建锚点'));
    }
    var reused = reusableAnchor(A.doc, ids, bbox);
    if (reused) return Promise.resolve(reused);

    var label = String(nextFreeAnchorNumber(A.doc.anchors || []));
    var cleanBBox = { x: r3(bbox.x), y: r3(bbox.y), w: r3(bbox.w), h: r3(bbox.h) };
    var normal = FigDoc.mmToNorm(cleanBBox, A.doc.canvas);
    var anchor = {
      id: FigDoc.uid('anchor'),
      label: label,
      bbox_mm: cleanBBox,
      bbox_norm: { x: r3(normal.x), y: r3(normal.y), w: r3(normal.w), h: r3(normal.h) },
      note: '',
      element_ids: ids.slice()
    };
    var result;
    try {
      result = A.commit([{ op: 'add_anchor', anchor: anchor, reason: '从画布右键选区创建锚点' }],
        { label: '锚点：' + label, source: 'user' });
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(result).then(function (done) {
      if (!done || !done.applied) throw new Error('锚点提交未生效，请查看历史或文档状态');
      var saved = (A.doc.anchors || []).filter(function (a) { return a && a.id === anchor.id; })[0];
      if (!saved) throw new Error('锚点提交后未找到原生记录');
      if (typeof A.emit === 'function') A.emit('anchors:changed', { id: saved.id });
      A.status('已创建锚点 ' + saved.label);
      return saved;
    });
  }

  function invokeAiReference(method, id) {
    var panel = global.AiPanel;
    if (!panel || typeof panel[method] !== 'function') {
      return Promise.reject(new Error('下方 AI 面板引用接口尚未就绪（AiPanel.' + method + '）'));
    }
    var result;
    try { result = panel[method](id); }
    catch (err) { return Promise.reject(err); }
    return Promise.resolve(result).then(function (value) {
      if (value === false) throw new Error('AI 面板未能接收该引用');
      return value;
    });
  }

  function sendContextTarget(target) {
    if (!target) return;
    closeContextMenu();
    var pending;
    if (target.kind === 'element') {
      pending = invokeAiReference('referenceElement', target.id);
    } else if (target.kind === 'anchor') {
      pending = invokeAiReference('referenceAnchor', target.id);
    } else {
      if (!global.AiPanel || typeof global.AiPanel.referenceAnchor !== 'function') {
        contextFailure('发送给 AI 失败：', new Error('下方 AI 面板引用接口尚未就绪（AiPanel.referenceAnchor）'));
        return;
      }
      pending = ensureTargetAnchor(target).then(function (anchor) {
        return invokeAiReference('referenceAnchor', anchor.id);
      });
    }
    pending.catch(function (err) { contextFailure('发送给 AI 失败：', err); });
  }

  function manageContextAnchor(target) {
    closeContextMenu();
    function openPanel(anchor) {
      var tab = document.getElementById('tab-anchors');
      if (tab) tab.click();
      if (anchor && global.Anchors && typeof global.Anchors.focus === 'function') {
        global.Anchors.focus(anchor.id);
      }
    }
    if (!target) {
      openPanel(null);
      setTool('anchor');
      global.App.status('请在画布上拖出新的锚点区域');
      return;
    }
    ensureTargetAnchor(target).then(function (anchor) {
      openPanel(anchor);
    }).catch(function (err) { contextFailure('创建/管理锚点失败：', err); });
  }

  function makeContextButton(number, label, action, disabled) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'editor-context-action';
    button.setAttribute('role', 'menuitem');
    button.disabled = !!disabled;
    var badge = document.createElement('span');
    badge.className = 'editor-context-number';
    badge.textContent = '[' + number + ']';
    var text = document.createElement('span');
    text.textContent = label;
    button.appendChild(badge);
    button.appendChild(text);
    return button;
  }

  function openContextMenu(evt, target) {
    closeContextMenu();
    var menu = document.createElement('div');
    menu.id = 'editor-context-menu';
    menu.className = 'editor-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '画布对象操作');

    var caption = document.createElement('div');
    caption.className = 'editor-context-caption';
    caption.textContent = contextTargetName(target);
    menu.appendChild(caption);

    var send = makeContextButton(1, '发送给 AI', '发送给 AI', !target);
    send.setAttribute('data-action', 'send-ai');
    send.addEventListener('click', function (clickEvt) {
      clickEvt.preventDefault(); clickEvt.stopPropagation();
      sendContextTarget(target);
    });
    var manage = makeContextButton(2, '创建/管理锚点', '创建/管理锚点', false);
    manage.setAttribute('data-action', 'manage-anchor');
    manage.addEventListener('click', function (clickEvt) {
      clickEvt.preventDefault(); clickEvt.stopPropagation();
      manageContextAnchor(target);
    });
    menu.appendChild(send);
    menu.appendChild(manage);
    document.body.appendChild(menu);
    S.contextMenu = menu;
    S.contextTarget = target;

    var vw = global.innerWidth || document.documentElement.clientWidth;
    var vh = global.innerHeight || document.documentElement.clientHeight;
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(evt.clientX, vw - mw - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(evt.clientY, vh - mh - 8)) + 'px';
    (target ? send : manage).focus({ preventScroll: true });
  }

  function onStageContextMenu(evt) {
    var t = evt.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    evt.preventDefault();
    evt.stopPropagation();
    closeContextMenu();
    if (S.mode || !global.App || !global.App.doc) return;
    var target = resolveContextTarget(evtMm(evt));
    openContextMenu(evt, target);
  }

  function onDocumentMouseDown(evt) {
    if (S.contextMenu && !S.contextMenu.contains(evt.target)) closeContextMenu();
  }

  function onContextMenuKeyDown(evt) {
    var menu = S.contextMenu;
    if (!menu) return;
    if (evt.key === 'Escape') {
      evt.preventDefault(); evt.stopImmediatePropagation();
      closeContextMenu();
      return;
    }
    var buttons = Array.from(menu.querySelectorAll('button:not(:disabled)'));
    if (!buttons.length) return;
    var index = buttons.indexOf(document.activeElement);
    var next = null;
    if (evt.key === 'ArrowDown') next = buttons[(index + 1 + buttons.length) % buttons.length];
    else if (evt.key === 'ArrowUp') next = buttons[(index - 1 + buttons.length) % buttons.length];
    else if (evt.key === 'Home') next = buttons[0];
    else if (evt.key === 'End') next = buttons[buttons.length - 1];
    if (next) {
      evt.preventDefault(); evt.stopImmediatePropagation();
      next.focus({ preventScroll: true });
    }
  }

  function onStageWheel(evt) {
    closeContextMenu();
    var A = global.App;
    if (!A || !evt.ctrlKey) return;
    evt.preventDefault();
    zoom(evt.deltaY < 0 ? 1.1 : 1 / 1.1, { center: { x: evt.clientX, y: evt.clientY } });
  }

  // ------------------------------------------------------------------
  // move / resize / rotate (live preview, commit once on mouse-up)
  // ------------------------------------------------------------------

  function moveTo(p, evt) {
    var A = global.App;
    var d = S.drag;
    if (!d || S.mode !== 'move') return;
    var dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (evt && evt.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
    }
    S.guides = { v: [], h: [] };
    if (A.ui.snap) {
      var z = zoomOf();
      var thr = SNAP_RADIUS_PX / z;
      var B = d.bbox;
      var bestX = null;
      [B.x + dx, B.x + B.w / 2 + dx, B.x + B.w + dx].forEach(function (v) {
        var s = nearestLine(v, d.lines.v, thr);
        if (s && (!bestX || s.diff < bestX.diff)) bestX = { s: s, val: v };
      });
      if (bestX) { dx += bestX.s.line - bestX.val; S.guides.v = [bestX.s.line]; }
      var bestY = null;
      [B.y + dy, B.y + B.h / 2 + dy, B.y + B.h + dy].forEach(function (v) {
        var s = nearestLine(v, d.lines.h, thr);
        if (s && (!bestY || s.diff < bestY.diff)) bestY = { s: s, val: v };
      });
      if (bestY) { dy += bestY.s.line - bestY.val; S.guides.h = [bestY.s.line]; }
    }
    d.dx = dx; d.dy = dy;
    if (dx !== 0 || dy !== 0) {
      previewOps([{ op: 'move', targets: d.ids, dx: dx, dy: dy }]);
    } else {
      S.previewDoc = null;
      schedulePreview();
    }
  }

  function resizeTo(p) {
    var A = global.App;
    var d = S.drag;
    if (!d || S.mode !== 'resize') return;
    var z = zoomOf();
    var local = p;
    if (d.rot) {
      var c = { x: d.B.x + d.B.w / 2, y: d.B.y + d.B.h / 2 };
      local = rotatePoint(p, c, -d.rot);
    }
    var h = d.handle;
    var l = d.B.x, t = d.B.y, r = d.B.x + d.B.w, b = d.B.y + d.B.h;
    if (h.indexOf('w') >= 0) l = Math.min(local.x, r - MIN_SIZE_MM);
    if (h.indexOf('e') >= 0) r = Math.max(local.x, l + MIN_SIZE_MM);
    if (h.indexOf('n') >= 0) t = Math.min(local.y, b - MIN_SIZE_MM);
    if (h.indexOf('s') >= 0) b = Math.max(local.y, t + MIN_SIZE_MM);

    S.guides = { v: [], h: [] };
    if (A.ui.snap) {
      var thr = SNAP_RADIUS_PX / z;
      if (h.indexOf('w') >= 0) {
        var s1 = nearestLine(l, d.lines.v, thr);
        if (s1) { l = s1.line; r = Math.max(r, l + MIN_SIZE_MM); S.guides.v = [l]; }
      } else if (h.indexOf('e') >= 0) {
        var s2 = nearestLine(r, d.lines.v, thr);
        if (s2) { r = s2.line; l = Math.min(l, r - MIN_SIZE_MM); S.guides.v = [r]; }
      }
      if (h.indexOf('n') >= 0) {
        var s3 = nearestLine(t, d.lines.h, thr);
        if (s3) { t = s3.line; b = Math.max(b, t + MIN_SIZE_MM); S.guides.h = [t]; }
      } else if (h.indexOf('s') >= 0) {
        var s4 = nearestLine(b, d.lines.h, thr);
        if (s4) { b = s4.line; t = Math.min(t, b - MIN_SIZE_MM); S.guides.h = [b]; }
      }
    }

    var nb = { x: l, y: t, w: r - l, h: b - t };
    if (Math.abs(nb.w - d.B.w) < 1e-9 && Math.abs(nb.h - d.B.h) < 1e-9 &&
        nb.x === d.B.x && nb.y === d.B.y) {
      return;
    }
    d.changed = true;
    d.lastOps = scaleOps(nb, d.B, d.ids);
    previewOps(d.lastOps);
  }

  // Ops that map every affected element from bbox B to newB. Containers get
  // explicit child ops (the kernel's resize does not scale children); the
  // absolute move of each child is applied after its parent's move, so the
  // parent's recursive shift is corrected by the child's own absolute value.
  function scaleOps(newB, B, ids) {
    var A = global.App;
    var doc = A.doc;
    var fx = B.w > 1e-9 ? newB.w / B.w : 1;
    var fy = B.h > 1e-9 ? newB.h / B.h : 1;
    var ops = [];
    function emit(id) {
      var el = FigDoc.get(doc, id);
      if (!el) return;
      var t = el.transform || { x: 0, y: 0, w: 0, h: 0 };
      var nx = newB.x + (t.x - B.x) * fx;
      var ny = newB.y + (t.y - B.y) * fy;
      var nw = t.w * fx, nh = t.h * fy;
      var rw = Math.abs(nw) < MIN_SIZE_MM ? MIN_SIZE_MM : Math.abs(nw);
      var rh = Math.abs(nh) < MIN_SIZE_MM ? MIN_SIZE_MM : Math.abs(nh);
      var rx = nw < 0 ? nx + nw : nx; // keep line direction: resize uses |w|, move re-anchors
      var ry = nh < 0 ? ny + nh : ny;
      ops.push({ op: 'resize', targets: [id], w: rw, h: rh });
      ops.push({ op: 'move', targets: [id], x: rx, y: ry });
      if (el.type === 'group' || el.type === 'panel') {
        var kids = FigDoc.children(doc, id) || [];
        kids.forEach(function (k) {
          if (k && k.style && k.style.panelRelative === true) return; // scales with panel
          emit(k.id);
        });
      }
    }
    (ids || []).forEach(emit);
    return ops;
  }

  function rotateTo(p) {
    var A = global.App;
    var d = S.drag;
    if (!d || S.mode !== 'rotate') return;
    var ang = Math.atan2(p.y - d.center.y, p.x - d.center.x);
    var deg = d.rot0 + (ang - d.startA) * 180 / Math.PI;
    if (A.ui.snap) deg = Math.round(deg / 15) * 15;
    deg = Math.round(deg * 10) / 10;
    deg = ((deg % 360) + 540) % 360 - 180;
    if (deg === d.rot0) return;
    d.rotation = deg;
    d.changed = true;
    previewOps([{ op: 'rotate', targets: [d.id], rotation: deg }]);
  }

  // ------------------------------------------------------------------
  // marquee select & anchor creation
  // ------------------------------------------------------------------

  function finishMarquee() {
    var A = global.App;
    var m = S.marquee;
    if (!m) return;
    var z = zoomOf();
    var moved = Math.hypot((m.x1 - m.x0) * z, (m.y1 - m.y0) * z) >= 3;
    var rect = normRect(m);
    var ids = [];
    if (moved) {
      A.doc.elements.forEach(function (el) {
        if (!el || el.parent_id || el.visible === false || el.locked === true) return;
        var b = FigDoc.bbox(A.doc, el.id, { recursive: true });
        var r = normRect({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
        if (r.w <= 0 || r.h <= 0) return;
        if (rectsOverlap(r, rect)) ids.push(el.id);
      });
    }
    if (m.shift) {
      var cur = A.selection();
      ids = cur.concat(ids.filter(function (id) { return cur.indexOf(id) < 0; }));
    }
    if (ids.length) {
      A.select(ids);
      A.status('框选了 ' + ids.length + ' 个元素');
    } else if (!m.shift) {
      A.clearSelection();
    }
  }

  function finishAnchor() {
    var A = global.App;
    var m = S.marquee;
    if (!m) return;
    var W = A.doc.canvas.width_mm, H = A.doc.canvas.height_mm;
    var z = zoomOf();
    var r = normRect(m);
    r.x = Math.max(0, Math.min(r.x, W - 0.5));
    r.y = Math.max(0, Math.min(r.y, H - 0.5));
    r.w = Math.max(0.5, Math.min(r.w, W - r.x));
    r.h = Math.max(0.5, Math.min(r.h, H - r.y));
    if (r.w * z < 4 && r.h * z < 4) {
      A.status('锚点区域太小，已取消');
      return;
    }
    // Numeric labels: 1, 2, … — smallest number not in use. Existing anchors
    // are never renumbered when one is deleted; the freed number is reused.
    var label = String(nextFreeAnchorNumber(A.doc.anchors || []));
    var anchor = {
      id: FigDoc.uid('anchor'),
      label: label,
      bbox_mm: { x: r3(r.x), y: r3(r.y), w: r3(r.w), h: r3(r.h) },
      bbox_norm: (function (b) {
        var n = FigDoc.mmToNorm(b, A.doc.canvas);
        return { x: r3(n.x), y: r3(n.y), w: r3(n.w), h: r3(n.h) };
      })({ x: r.x, y: r.y, w: r.w, h: r.h }),
      note: ''
    };
    commit([{ op: 'add_anchor', anchor: anchor }], '创建锚点 ' + label, function (done) {
      if (done.applied > 0) {
        A.status('已创建锚点 ' + label + '，可在右侧“锚点”面板中编辑');
        if (typeof A.emit === 'function') A.emit('anchors:changed', { id: anchor.id });
        notifyAiPanelAnchorRef(anchor);
      }
    });
  }

  // Smallest positive integer label not used by any existing anchor whose
  // label parses to a whole number.
  function nextFreeAnchorNumber(anchors) {
    var used = {};
    (anchors || []).forEach(function (a) {
      var n = parseInt(String(a && a.label || '').trim(), 10);
      if (isFinite(n) && n > 0 && String(n) === String(a.label).trim()) used[n] = true;
    });
    var n = 1;
    while (used[n]) n++;
    return n;
  }

  // Surface the new anchor in the AI panel as a [n] @anchor-id reference so
  // the user can immediately say “把1的…”. Optional: AI panel may be absent.
  function notifyAiPanelAnchorRef(anchor) {
    try {
      if (global.AiPanel && typeof global.AiPanel.appendAnchorRef === 'function') {
        global.AiPanel.appendAnchorRef(anchor);
      }
    } catch (e) { /* 引用注入失败不影响锚点创建 */ }
  }

  // ------------------------------------------------------------------
  // draw tools (text/rect/ellipse/line/arrow/image)
  // ------------------------------------------------------------------

  function baseFontPt() {
    var A = global.App;
    var j = A && typeof A.currentJournal === 'function' ? A.currentJournal() : null;
    return j && typeof j.base_font_pt === 'number' && j.base_font_pt > 0 ? j.base_font_pt : 8;
  }

  function baseFontFamily() {
    var A = global.App;
    var j = A && typeof A.currentJournal === 'function' ? A.currentJournal() : null;
    return (j && j.font_family) || 'Arial';
  }

  function styleForTool(tool) {
    switch (tool) {
      case 'rect':
      case 'ellipse':
        return { fill: '#FFFFFF', stroke: '#333333', strokeWidthPt: 0.75 };
      case 'line':
        return { fill: null, stroke: '#333333', strokeWidthPt: 0.75 };
      case 'arrow':
        return { fill: null, stroke: '#333333', strokeWidthPt: 0.75, arrowHead: 'end' };
      case 'text':
        return { fontSizePt: baseFontPt(), fontFamily: baseFontFamily(), fill: '#000000' };
      case 'image':
        return { imageFit: 'contain' };
      default:
        return {};
    }
  }

  function finishCreate() {
    var A = global.App;
    var c = S.creating;
    if (!c) return;
    var z = zoomOf();
    var tool = c.tool;
    var x0 = c.x0, y0 = c.y0, x1 = c.x1, y1 = c.y1;
    var tiny = Math.hypot((x1 - x0) * z, (y1 - y0) * z) < 3;
    var rect;

    if (tool === 'line' || tool === 'arrow') {
      if (tiny) {
        x1 = x0 + 20; y1 = y0;
      } else if (c.shift) { // constrain to 45° increments
        var ang = Math.atan2(y1 - y0, x1 - x0);
        var len = Math.hypot(x1 - x0, y1 - y0);
        var snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        x1 = x0 + Math.cos(snap) * len;
        y1 = y0 + Math.sin(snap) * len;
      }
      rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; // signed: keeps direction
    } else {
      if (tiny) {
        var def = { text: [40, 10], rect: [20, 15], ellipse: [20, 15], image: [40, 30] }[tool] || [20, 15];
        rect = { x: x0, y: y0, w: def[0], h: def[1] };
      } else {
        if (c.shift) { // square constraint
          var w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
          var s = Math.max(w, hh);
          x1 = x0 + (Math.sign(x1 - x0) || 1) * s;
          y1 = y0 + (Math.sign(y1 - y0) || 1) * s;
        }
        rect = normRect({ x0: x0, y0: y0, x1: x1, y1: y1 });
      }
      rect.x = Math.max(0, rect.x);
      rect.y = Math.max(0, rect.y);
      rect.w = Math.min(rect.w, Math.max(MIN_SIZE_MM, A.doc.canvas.width_mm - rect.x));
      rect.h = Math.min(rect.h, Math.max(MIN_SIZE_MM, A.doc.canvas.height_mm - rect.y));
      if (rect.w < MIN_SIZE_MM) rect.w = MIN_SIZE_MM;
      if (rect.h < MIN_SIZE_MM) rect.h = MIN_SIZE_MM;
    }

    var el = {
      id: FigDoc.uid('el'),
      type: tool,
      transform: { x: r3(rect.x), y: r3(rect.y), w: r3(rect.w), h: r3(rect.h), rotation: 0 },
      style: styleForTool(tool)
    };
    if (tool === 'text') el.text = '双击编辑文本';
    if (tool === 'image') el.src = null;

    commit([{ op: 'add_element', element: el }], '绘制' + (TOOL_LABELS[tool] || tool), function (done) {
      if (done.applied > 0) {
        A.select([el.id]);
        if (FigDoc.get(A.doc, el.id)) {
          // doc already published: act now
          if (tool === 'text') {
            startTextEditor(el.id);
          } else if (tool === 'image') {
            A.status('已创建图片元素（src 为空，请通过“导入图片”设置图片内容）');
          }
        } else {
          // doc update still in flight: re-apply on the next doc:changed
          S.pendingAfterDoc = { select: [el.id], textEdit: tool === 'text' ? el.id : null };
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // in-place text editing (overlay textarea over the text element)
  // ------------------------------------------------------------------

  function startTextEditor(id) {
    var A = global.App;
    if (S.editingId === id) return;
    var el = FigDoc.get(A.doc, id);
    if (!el || el.type !== 'text' || !S.stageEl) return;
    teardownTextEditor();
    var ta = document.createElement('textarea');
    ta.className = 'editor-text-input';
    ta.spellcheck = false;
    ta.style.cssText = 'position:absolute;margin:0;padding:1px 2px;' +
      'border:1px dashed ' + SEL_COLOR + ';background:rgba(255,255,255,0.95);' +
      'outline:none;box-sizing:border-box;z-index:30;resize:none;overflow:hidden;';
    var te = { box: ta, id: id, orig: el.text == null ? '' : String(el.text) };
    ta.value = te.orig;
    S.textEditor = te;
    S.editingId = id;
    positionTextEditor();
    S.stageEl.appendChild(ta);
    ta.addEventListener('keydown', function (evt) {
      evt.stopPropagation();
      if (evt.key === 'Enter' && !evt.shiftKey && !evt.ctrlKey && !evt.metaKey) {
        evt.preventDefault();
        commitTextEditor();
      } else if (evt.key === 'Escape') {
        evt.preventDefault();
        cancelTextEditor(true);
      }
    });
    ta.addEventListener('blur', function () {
      if (S.editingId === id) commitTextEditor();
    });
    setTimeout(function () { ta.focus(); ta.select(); }, 0);
    A.status('编辑文本：Enter 完成，Esc 取消');
  }

  function positionTextEditor() {
    var A = global.App;
    var te = S.textEditor;
    if (!te || !S.svg) return;
    var el = FigDoc.get(A.doc, te.id);
    if (!el) { teardownTextEditor(); return; }
    var b = FigDoc.bbox(A.doc, te.id, { recursive: false });
    var z = zoomOf();
    // Offset of the canvas inside the scrollable stage. SVG elements expose
    // no offsetLeft/offsetTop (undefined on SVGSVGElement → "NaNpx" is
    // dropped by CSS and the editor lands at the stage origin), so derive
    // the delta from the two bounding rects plus the current stage scroll.
    var ox = 0, oy = 0;
    if (S.stageEl) {
      var sr = S.svg.getBoundingClientRect();
      var tr = S.stageEl.getBoundingClientRect();
      ox = sr.left - tr.left - S.stageEl.clientLeft + S.stageEl.scrollLeft;
      oy = sr.top - tr.top - S.stageEl.clientTop + S.stageEl.scrollTop;
    }
    var st = el.style || {};
    var fs = (typeof st.fontSizePt === 'number' && st.fontSizePt > 0 ? st.fontSizePt : 7) * (25.4 / 72) * z;
    var lh = fs * (typeof st.lineHeight === 'number' && st.lineHeight > 0 ? st.lineHeight : 1.2);
    te.box.style.left = (ox + b.x * z) + 'px';
    te.box.style.top = (oy + b.y * z) + 'px';
    te.box.style.width = Math.max(40, Math.abs(b.w) * z) + 'px';
    te.box.style.height = Math.max(lh * 1.2, Math.abs(b.h) * z) + 'px';
    te.box.style.fontSize = fs + 'px';
    te.box.style.lineHeight = lh + 'px';
    te.box.style.fontFamily = st.fontFamily || 'Arial';
    te.box.style.fontWeight = st.fontWeight === 'bold' ? '700' : '400';
    te.box.style.fontStyle = st.fontStyle === 'italic' ? 'italic' : 'normal';
    te.box.style.color = st.fill || '#000000';
    te.box.style.textAlign = st.textAlign || 'left';
  }

  function commitTextEditor() {
    var te = S.textEditor;
    if (!te) return;
    var A = global.App;
    var val = te.box.value;
    var id = te.id;
    var orig = te.orig;
    teardownTextEditor();
    if (val !== orig && FigDoc.get(A.doc, id)) {
      commit([{ op: 'set_text', targets: [id], text: val }], '编辑文本');
    }
  }

  function cancelTextEditor(showMsg) {
    if (!S.textEditor) return;
    teardownTextEditor();
    if (showMsg && global.App) global.App.status('已取消文本编辑');
  }

  function teardownTextEditor() {
    var te = S.textEditor;
    S.textEditor = null;
    S.editingId = null;
    if (te && te.box && te.box.parentNode) te.box.parentNode.removeChild(te.box);
  }

  // ------------------------------------------------------------------
  // clipboard: copy / paste / duplicate (top-level subtrees, id remapped)
  // ------------------------------------------------------------------

  function buildCopyItems(ids) {
    var A = global.App;
    var doc = A.doc;
    var items = [];
    (ids || []).forEach(function (id) {
      if (!FigDoc.get(doc, id)) return;
      var desc = FigDoc.descendants(doc, id, { includeSelf: true });
      items.push({
        rootId: id,
        elements: desc.map(function (e) { return JSON.parse(JSON.stringify(e)); })
      });
    });
    return items;
  }

  function sortedByDepth(arr) {
    var byId = Object.create(null);
    arr.forEach(function (e) { byId[e.id] = e; });
    function depth(e) {
      var d = 0, pid = e.parent_id;
      while (pid && byId[pid]) { d++; pid = byId[pid].parent_id; }
      return d;
    }
    return arr.slice().sort(function (a, b) { return depth(a) - depth(b); });
  }

  function pasteFromItems(items, offX, offY, label) {
    var A = global.App;
    if (!items || !items.length) return;
    var ops = [], newIds = [];
    items.forEach(function (item) {
      var map = Object.create(null);
      item.elements.forEach(function (e) { map[e.id] = FigDoc.uid('el'); });
      sortedByDepth(item.elements).forEach(function (e) { // parents first
        var c = JSON.parse(JSON.stringify(e));
        c.id = map[e.id];
        c.parent_id = (e.parent_id && map[e.parent_id]) ? map[e.parent_id] : null;
        if (Array.isArray(c.children)) {
          c.children = c.children.map(function (cid) { return map[cid] || cid; });
        }
        c.transform = c.transform || { x: 0, y: 0, w: 0, h: 0 };
        c.transform.x = (c.transform.x || 0) + offX;
        c.transform.y = (c.transform.y || 0) + offY;
        ops.push({ op: 'add_element', element: c });
        if (e.id === item.rootId) newIds.push(c.id);
      });
    });
    if (!ops.length) return;
    commit(ops, label, function (done) {
      if (done.applied > 0 && newIds.length) {
        A.select(newIds);
        var ready = newIds.every(function (id) { return !!FigDoc.get(A.doc, id); });
        if (!ready) S.pendingAfterDoc = { select: newIds, textEdit: null };
      }
    });
  }

  function copySelection() {
    var A = global.App;
    var ids = topmostSelected(A.doc);
    if (!ids.length) { A.status('没有可复制的元素'); return; }
    S.clipboard = { items: buildCopyItems(ids) };
    S.pasteCount = 0;
    A.status('已复制 ' + ids.length + ' 个元素');
  }

  function pasteClipboard() {
    var A = global.App;
    if (!S.clipboard || !S.clipboard.items.length) { A.status('剪贴板为空'); return; }
    S.pasteCount++;
    var off = PASTE_STEP_MM * S.pasteCount;
    pasteFromItems(S.clipboard.items, off, off, '粘贴元素');
  }

  function duplicateSelection() {
    var A = global.App;
    var ids = topmostSelected(A.doc);
    if (!ids.length) { A.status('没有可再制的元素'); return; }
    pasteFromItems(buildCopyItems(ids), PASTE_STEP_MM, PASTE_STEP_MM, '再制元素');
  }

  function deleteSelection() {
    var A = global.App;
    var ids = topmostSelected(A.doc);
    if (!ids.length) return;
    var doIt = function () {
      commit([{ op: 'delete', targets: ids }], '删除元素', function (done) {
        if (done.applied > 0) {
          if (typeof A.clearSelection === 'function') A.clearSelection();
          A.status('已删除 ' + ids.length + ' 个元素（可撤销）');
        }
      });
    };
    if (global.Ui && typeof global.Ui.confirm === 'function') {
      global.Ui.confirm('确定删除选中的 ' + ids.length + ' 个元素？此操作可在历史中撤销。')
        .then(function (ok) { if (ok) doIt(); })
        .catch(function () { /* dialog closed: do nothing */ });
    } else {
      doIt();
    }
  }

  function selectAll() {
    var A = global.App;
    var ids = A.doc.elements
      .filter(function (e) { return e && !e.parent_id && e.visible !== false && e.locked !== true; })
      .map(function (e) { return e.id; });
    if (ids.length) A.select(ids); else A.clearSelection();
    A.status('已全选 ' + ids.length + ' 个元素');
  }

  // ------------------------------------------------------------------
  // undo / redo / nudge / escape (keyboard)
  // ------------------------------------------------------------------

  function undo() {
    var A = global.App;
    if (!A || typeof A.publishDoc !== 'function') {
      if (A && typeof A.error === 'function') A.error('撤销失败：统一文档发布入口未就绪');
      return Promise.resolve(false);
    }
    return A.publishDoc(function (current) {
      return FigOps.undo(current);
    }, { reason: 'undo', finalizeHistory: true }).then(function () {
      A.status('已撤销');
      return true;
    }).catch(function (e) {
      if (typeof A.error === 'function') A.error('撤销失败：' + e.message);
      return false;
    });
  }

  function redo() {
    var A = global.App;
    if (!A || typeof A.publishDoc !== 'function') {
      if (A && typeof A.error === 'function') A.error('重做失败：统一文档发布入口未就绪');
      return Promise.resolve(false);
    }
    return A.publishDoc(function (current) {
      return FigOps.redo(current);
    }, { reason: 'redo', finalizeHistory: true }).then(function () {
      A.status('已重做');
      return true;
    }).catch(function (e) {
      if (typeof A.error === 'function') A.error('重做失败：' + e.message);
      return false;
    });
  }

  function nudge(key, fine) {
    var A = global.App;
    var ids = topmostSelected(A.doc);
    if (!ids.length) return;
    var z = zoomOf();
    var step = (fine ? NUDGE_SHIFT_PX : NUDGE_PX) / z;
    var dx = 0, dy = 0;
    if (key === 'ArrowLeft') dx = -step;
    else if (key === 'ArrowRight') dx = step;
    else if (key === 'ArrowUp') dy = -step;
    else dy = step;
    commit([{ op: 'move', targets: ids, dx: r3(dx), dy: r3(dy) }],
      fine ? '微移元素（×10）' : '微移元素');
  }

  function escapeAction() {
    var A = global.App;
    var had = false;
    var hadPreview = !!S.previewDoc;
    if (S.mode) {
      S.mode = null; S.drag = null; S.marquee = null; S.creating = null;
      S.previewDoc = null; S.guides = { v: [], h: [] };
      had = true;
    }
    if (S.editingId) { cancelTextEditor(false); had = true; }
    if (hadPreview) render();
    else if (had) renderOverlay();
    if (A.selectionSet && A.selectionSet.size) {
      A.clearSelection();
      had = true;
    }
    if (had) A.status('已取消当前操作');
  }

  function onKeyDown(evt) {
    var A = global.App;
    if (!A || !S.mounted || !A.doc) return;
    var t = evt.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (S.editingId) return;
    var k = evt.key;
    var mod = evt.ctrlKey || evt.metaKey;
    var stop = function () { evt.preventDefault(); evt.stopPropagation(); };

    if (mod && (k === 'z' || k === 'Z')) { stop(); if (evt.shiftKey) redo(); else undo(); return; }
    if (mod && (k === 'y' || k === 'Y')) { stop(); redo(); return; }
    if (mod && (k === 'c' || k === 'C')) { stop(); copySelection(); return; }
    if (mod && (k === 'v' || k === 'V')) { stop(); pasteClipboard(); return; }
    if (mod && (k === 'd' || k === 'D')) { stop(); duplicateSelection(); return; }
    if (mod && (k === 'a' || k === 'A')) { stop(); selectAll(); return; }
    if (mod) return;
    if (k === 'Delete' || k === 'Backspace') { stop(); deleteSelection(); return; }
    if (k === 'Escape') { stop(); escapeAction(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      stop();
      nudge(k, evt.shiftKey);
    }
  }

  // ------------------------------------------------------------------
  // App event handlers
  // ------------------------------------------------------------------

  function onDocChanged() {
    S.previewDoc = null;
    S.guides = { v: [], h: [] };
    var A = global.App;
    if (S.editingId && (!A || !A.doc || !FigDoc.get(A.doc, S.editingId))) {
      cancelTextEditor(false);
    }
    render();
    // App implementations that publish the new doc asynchronously (contract:
    // setDoc happens after finalizeHistory) need post-commit UI updates now.
    if (S.pendingAfterDoc) {
      var pend = S.pendingAfterDoc;
      S.pendingAfterDoc = null;
      var sel = (pend.select || []).filter(function (id) { return FigDoc.get(A.doc, id); });
      if (pend.textEdit && FigDoc.get(A.doc, pend.textEdit)) {
        if (sel.length && typeof A.select === 'function') A.select(sel);
        startTextEditor(pend.textEdit);
      } else if (sel.length && typeof A.select === 'function') {
        A.select(sel);
      }
      // nothing exists (failed commit): drop silently, no selection clobber
    }
  }

  function onSelectionChanged() {
    renderOverlay();
  }

  function onUiChanged() {
    var A = global.App;
    if (A && A.doc && (S.appliedZoom !== zoomOf() ||
        S.appliedW !== A.doc.canvas.width_mm || S.appliedH !== A.doc.canvas.height_mm)) {
      applyZoomSizes();
    }
    updateCursor();
    updateToolbarActive();
    renderOverlay();
    updateBadges();
    if (S.editingId) positionTextEditor();
  }

  // ------------------------------------------------------------------
  // public API (Editor contract)
  // ------------------------------------------------------------------

  function renderPublic() { render(); }
  function renderOverlayPublic() { renderOverlay(); }

  function setTool(tool) {
    var A = global.App;
    if (TOOLS.indexOf(tool) < 0) throw new Error('未知工具: ' + String(tool));
    if (!A.ui || typeof A.ui !== 'object') A.ui = {};
    A.ui.tool = tool;
    updateToolbarActive();
    updateCursor();
    if (typeof A.status === 'function') A.status('工具：' + (TOOL_LABELS[tool] || tool));
    if (typeof A.emit === 'function') A.emit('ui:changed', { tool: tool });
  }

  function setZoom(zv, opts) {
    var A = global.App;
    if (!A) throw new Error('App 未加载，无法设置缩放');
    if (typeof zv !== 'number' || !isFinite(zv)) throw new Error('缩放值必须是有限数字');
    zv = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zv));
    var center = opts && opts.center;
    var mmPt = null;
    if (center && S.svg) {
      var r = S.svg.getBoundingClientRect();
      var z0 = zoomOf();
      mmPt = { x: (center.x - r.left) / z0, y: (center.y - r.top) / z0 };
    }
    var changed = A.ui.zoom !== zv;
    A.ui.zoom = zv;
    applyZoomSizes();
    if (changed && typeof A.emit === 'function') A.emit('ui:changed', { zoom: zv });
    if (mmPt && S.stageEl) {
      requestAnimationFrame(function () {
        var st = S.stageEl;
        if (!st) return;
        var z2 = zoomOf();
        var contentX = S.svg.offsetLeft + mmPt.x * z2;
        var contentY = S.svg.offsetTop + mmPt.y * z2;
        var rect = st.getBoundingClientRect();
        st.scrollLeft = contentX - (center.x - rect.left);
        st.scrollTop = contentY - (center.y - rect.top);
        syncBadges();
      });
    } else {
      syncBadges();
    }
  }

  function zoom(factor, opts) {
    if (typeof factor !== 'number' || !isFinite(factor) || factor <= 0) {
      throw new Error('缩放系数必须是正数');
    }
    setZoom(zoomOf() * factor, opts);
  }

  function fit() {
    var A = global.App;
    var st = S.stageEl;
    if (!A || !A.doc || !st) return;
    var c = A.doc.canvas;
    var availW = Math.max(50, st.clientWidth - 32);
    var availH = Math.max(50, st.clientHeight - 32);
    var z = Math.min(availW / c.width_mm, availH / c.height_mm);
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    A.ui.zoom = z;
    applyZoomSizes();
    if (typeof A.emit === 'function') A.emit('ui:changed', { zoom: z });
    requestAnimationFrame(function () {
      var wpx = c.width_mm * z;
      var hpx = c.height_mm * z;
      st.scrollLeft = Math.max(0, (S.svg.offsetLeft * 2 + wpx - st.clientWidth) / 2);
      st.scrollTop = Math.max(0, (S.svg.offsetTop * 2 + hpx - st.clientHeight) / 2);
      syncBadges();
    });
  }

  function selectedBBox() {
    var A = global.App;
    if (!A || !A.doc) return null;
    var ids = (A.selection && A.selection()) || [];
    return unionSelBBox(A.doc, ids);
  }

  global.Editor = {
    mount: mount,
    render: renderPublic,
    renderOverlay: renderOverlayPublic,
    setTool: setTool,
    zoom: zoom,
    fit: fit,
    setZoom: setZoom,
    selectedBBox: selectedBBox
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
