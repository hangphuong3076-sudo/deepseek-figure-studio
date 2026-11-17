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
  var HANDLE_CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize',
    ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize',
    e: 'ew-resize', w: 'ew-resize',
    rotate: 'grab'
  };

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
    guides: { v: [], h: [], gaps: [] },
    handleLayout: [],      // [{key,x,y}] in mm, for hit testing
    raf: 0,
    textEditor: null,      // {box,id,orig}
    editingId: null,
    clipboard: null,       // {items:[{elements,rootId}]}
    pasteCount: 0,
    pendingAfterDoc: null, // {select,textEdit} re-applied when the doc update lands
    appliedZoom: null, appliedW: null, appliedH: null,
    contextMenu: null,       // transient DOM only; never enters the figure document
    contextTarget: null,
    spaceArmed: false,       // Space held → canvas pan armed (idle, select tool)
    altDown: false,          // Alt held → copy cursor / measure overlay
    pan: null,               // {x0,y0,sl,st} client-px start + scroll start while panning
    hoverEvt: null,          // last mousemove snapshot {clientX,clientY,over,ctrlKey,altKey,metaKey}
    hoverRaf: 0,
    hoverSig: '',            // last rendered hover signature (avoid redundant overlay redraws)
    hoverBoxEl: null,        // element under cursor eligible for .fig-hover-box
    hoverEl: null,           // any element under cursor (cursor/measure)
    hoverHandle: null,       // handle key under cursor
    measure: null            // transient Alt-measure segments [{axis,f,t,at}]
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
    if (!A) throw new Error('编辑器未加载，无法启动');
    if (typeof FigDoc === 'undefined' || typeof FigRender === 'undefined' || typeof FigOps === 'undefined') {
      throw new Error('编辑器内核未加载，无法启动');
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
      keyup: onKeyUp,
      blur: onWindowBlur,
      focusin: onFocusIn,
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
    document.addEventListener('keyup', h.keyup);
    document.addEventListener('focusin', h.focusin, true);
    window.addEventListener('resize', h.resize);
    window.addEventListener('blur', h.blur);

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
      document.removeEventListener('keyup', h.keyup);
      document.removeEventListener('focusin', h.focusin, true);
      window.removeEventListener('resize', h.resize);
      window.removeEventListener('blur', h.blur);
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
    S.previewDoc = null; S.guides = { v: [], h: [], gaps: [] };
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

  function isSelectedId(id) {
    var A = global.App;
    if (!A) return false;
    if (A.selectionSet && typeof A.selectionSet.has === 'function') return A.selectionSet.has(id);
    var sel = (A.selection && A.selection()) || [];
    return sel.indexOf(id) >= 0;
  }

  function modalOpen() {
    try {
      return !!(typeof document !== 'undefined' && document.querySelector &&
        document.querySelector('.ui-modal-overlay'));
    } catch (e) { return false; }
  }

  // Space-pan / Alt-measure only arm while the canvas is idle and editable.
  function canvasIdle() {
    return !!(global.App && global.App.doc && S.mounted && !S.mode && !S.editingId && !modalOpen());
  }

  function computeCursor() {
    var A = global.App;
    if (!A || !A.ui) return 'default';
    if (S.mode === 'pan') return 'grabbing';
    if (S.spaceArmed) return 'grab';
    var tool = A.ui.tool || 'select';
    if (tool !== 'select') return 'crosshair';
    if (S.mode === 'move') return (S.drag && S.drag.duplicate) ? 'copy' : 'move';
    if (S.mode === 'resize') return (S.drag && HANDLE_CURSORS[S.drag.handle]) || 'default';
    if (S.mode === 'rotate') return 'grab';
    if (S.mode) return 'crosshair'; // marquee / anchor / create rubber bands
    if (S.hoverHandle) return HANDLE_CURSORS[S.hoverHandle] || 'default';
    if (S.altDown && S.hoverEl) return 'copy';
    if (S.hoverEl && isSelectedId(S.hoverEl.id)) return 'move';
    return 'default';
  }

  function updateCursor() {
    var A = global.App;
    if (!S.stageEl || !A || !A.ui) return;
    S.stageEl.style.cursor = computeCursor();
  }

  // ------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------

  function svgInnerOf(doc) {
    var s = FigRender.toSVG(doc, { includeGuides: false, compactMarks: true });
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
    refreshChartPartMark();
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

  // 预览快路径：move/rotate/add_element 只浅克隆被触及的元素（transform/
  // style 复制，其余子树——含 chart.data.inline.rows——与 App.doc 共享），
  // 避免每帧多次深克隆大数据文档。语义镜像 ops.js 的 opMove/opRotate/
  // shiftRecursive；遇到无法镜像的情形（未知 op、diagramNodeId）返回 null，
  // 由调用方回退到 FigOps.applyAll 全量路径。
  function previewApplyFast(doc, ops) {
    var F = global.FigDoc;
    if (!F || typeof F.children !== 'function' || !Array.isArray(doc.elements)) {
      return null;
    }
    var n = doc.elements.length;
    var idxOf = Object.create(null);
    for (var i = 0; i < n; i++) idxOf[doc.elements[i].id] = i;
    var orig = doc.elements;

    function shallowEl(e) {
      var c = {};
      var ks = Object.keys(e);
      for (var i = 0; i < ks.length; i++) c[ks[i]] = e[ks[i]];
      if (e.transform && typeof e.transform === 'object') {
        var t = {};
        var tk = Object.keys(e.transform);
        for (var j = 0; j < tk.length; j++) t[tk[j]] = e.transform[tk[j]];
        c.transform = t;
      }
      if (e.style && typeof e.style === 'object') {
        var s = {};
        var sk = Object.keys(e.style);
        for (var j2 = 0; j2 < sk.length; j2++) s[sk[j2]] = e.style[sk[j2]];
        c.style = s;
      }
      return c;
    }

    var clones = Object.create(null);
    function elFor(id) {
      var c = clones[id];
      if (c) return c;
      var ix = idxOf[id];
      if (ix === undefined) return null;
      c = shallowEl(orig[ix]);
      clones[id] = c;
      return c;
    }

    function subtreeHasDiagram(el) {
      if (!el) return false;
      if (el.diagramNodeId) return true;
      var desc = F.descendants ? F.descendants(doc, el.id, { includeSelf: false }) : [];
      for (var i = 0; i < desc.length; i++) {
        if (desc[i] && desc[i].diagramNodeId) return true;
      }
      return false;
    }

    // 预扫描：只接受 move/rotate/add_element；目标子树含 diagramNodeId 时放弃。
    var adds = [];
    for (i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || typeof op !== 'object') return null;
      if (op.op === 'add_element') {
        if (!op.element || typeof op.element !== 'object') return null;
        adds.push(op.element);
        continue;
      }
      if (op.op !== 'move' && op.op !== 'rotate') return null;
      var tg = Array.isArray(op.targets) ? op.targets : [];
      for (var j = 0; j < tg.length; j++) {
        var id = tg[j];
        if (idxOf[id] === undefined) return null;
        if (subtreeHasDiagram(orig[idxOf[id]])) return null;
      }
    }

    // shiftRecursive 镜像：目标自身 panelRelative 时按父 panel 内尺寸折算；
    // 子孙中 panelRelative 的跳过（随父面板走），其余递归平移。
    function shiftRec(el, dx, dy, skip) {
      var t = el.transform;
      if (!t || typeof t !== 'object') t = el.transform = { x: 0, y: 0, w: 0, h: 0 };
      if (el.style && el.style.panelRelative === true) {
        // 镜像 ops.js findParentPanelOf：沿 parent_id 向上找最近的 panel。
        var panel = null, pide = el.parent_id, pguard = 0;
        while (pide && pguard++ < 20) {
          var pi = idxOf[pide];
          if (pi === undefined) break;
          var pe = orig[pi];
          if (pe && pe.type === 'panel') { panel = pe; break; }
          pide = pe && pe.parent_id;
        }
        if (panel && panel.transform) {
          var lay = (panel.panelLayout && typeof panel.panelLayout === 'object')
            ? panel.panelLayout : {};
          var pad = lay.padding_mm === undefined ? 0 : Number(lay.padding_mm);
          if (!isFinite(pad) || pad < 0) pad = 0;
          var iw = Math.max(0, (Number(panel.transform.w) || 0) - 2 * pad);
          var ih = Math.max(0, (Number(panel.transform.h) || 0) - 2 * pad);
          t.x += dx / (iw || 1);
          t.y += dy / (ih || 1);
        } else {
          t.x += dx; t.y += dy;
        }
      } else {
        t.x += dx; t.y += dy;
      }
      var kids = F.children(doc, el.id) || [];
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (!kid || skip[kid.id]) continue;
        if (kid.style && kid.style.panelRelative === true) continue;
        var kc = elFor(kid.id);
        if (kc) shiftRec(kc, dx, dy, skip);
      }
    }

    // 保持 ops 原顺序对同一元素的累积效果：move 与 rotate 作用在不同字段，
    // 顺序无关；多个 move 按 ops 顺序累加。
    for (i = 0; i < ops.length; i++) {
      op = ops[i];
      if (op.op === 'add_element') continue;
      var targets = Array.isArray(op.targets) ? op.targets : [];
      if (op.op === 'rotate') {
        for (j = 0; j < targets.length; j++) {
          var re = elFor(targets[j]);
          if (!re) continue;
          var rt = re.transform;
          if (!rt || typeof rt !== 'object') rt = re.transform = { x: 0, y: 0, w: 0, h: 0 };
          if (op.rotation != null) rt.rotation = op.rotation;
          else if (typeof op.angle === 'number') rt.rotation = (rt.rotation || 0) + op.angle;
        }
      } else { // move
        var skip = Object.create(null);
        for (j = 0; j < targets.length; j++) skip[targets[j]] = true;
        for (j = 0; j < targets.length; j++) {
          var me = elFor(targets[j]);
          if (!me) continue;
          var dx, dy;
          if (op.x != null || op.y != null) {
            dx = (op.x != null ? op.x : me.transform.x) - me.transform.x;
            dy = (op.y != null ? op.y : me.transform.y) - me.transform.y;
          } else {
            dx = op.dx || 0; dy = op.dy || 0;
          }
          if (dx === 0 && dy === 0) continue;
          shiftRec(me, dx, dy, skip);
        }
      }
    }

    var newElements = new Array(n + adds.length);
    for (i = 0; i < n; i++) {
      var oid = orig[i].id;
      newElements[i] = clones[oid] || orig[i];
    }
    for (i = 0; i < adds.length; i++) newElements[n + i] = adds[i];
    var out = {};
    var dk = Object.keys(doc);
    for (i = 0; i < dk.length; i++) out[dk[i]] = doc[dk[i]];
    out.elements = newElements;
    if (doc.meta && typeof doc.meta === 'object') {
      out.meta = Object.assign({}, doc.meta);
    }
    return out;
  }

  function previewOps(ops) {
    var A = global.App;
    try {
      S.previewDoc = previewApplyFast(A.doc, ops) ||
        FigOps.applyAll(FigDoc.clone(A.doc), ops, { label: '预览' }).doc;
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

    // hover outline for the unselected element under the cursor (idle only)
    if (S.hoverBoxEl && S.hoverBoxEl.id && S.mode === null) {
      var hbEl = FigDoc.get(d, S.hoverBoxEl.id);
      if (hbEl) {
        var hb = FigDoc.bbox(d, S.hoverBoxEl.id, { recursive: true });
        var hrot = (hbEl.transform && hbEl.transform.rotation) || 0;
        out.push(tag('rect', {
          x: r3(hb.x), y: r3(hb.y),
          width: r3(Math.abs(hb.w)), height: r3(Math.abs(hb.h)),
          fill: 'none', stroke: SEL_COLOR, 'stroke-width': sw,
          'stroke-opacity': '0.55', 'class': 'fig-hover-box',
          transform: hrot ? ('rotate(' + r3(hrot) + ' ' + r3(hb.x + hb.w / 2) + ' ' + r3(hb.y + hb.h / 2) + ')') : null
        }));
      }
    }

    // equal-spacing gap labels + Alt-hover measurement (transient, never exported)
    (S.guides.gaps || []).forEach(function (s) { dimSeg(out, s, 'fig-gap-label', z, sw); });
    (S.measure || []).forEach(function (s) { dimSeg(out, s, 'fig-measure', z, sw); });

    S.overlay.innerHTML = out.join('');
  }

  // ------------------------------------------------------------------
  // pan / hover / gap-snap / alt-duplicate / alt-measure helpers
  // ------------------------------------------------------------------

  function beginPan(evt) {
    var st = S.stageEl;
    if (!st) return;
    S.mode = 'pan';
    S.pan = { x0: evt.clientX, y0: evt.clientY, sl: st.scrollLeft, st: st.scrollTop };
    resetHover();
    evt.preventDefault();
    updateCursor();
    renderOverlay(); // hide selection handles while panning
  }

  function panTo(evt) {
    var st = S.stageEl, pn = S.pan;
    if (!st || !pn) return;
    st.scrollLeft = pn.sl - (evt.clientX - pn.x0);
    st.scrollTop = pn.st - (evt.clientY - pn.y0);
  }

  function endPan() {
    S.mode = null; S.pan = null; S.drag = null;
    updateCursor();
    renderOverlay();
  }

  // Top-level visible peers (not dragged, not descendants of dragged) used by
  // equal-spacing snapping. Each entry is a normalized {l,r,t,b} box in mm.
  function collectPeerBoxes(doc, ids) {
    var ex = Object.create(null);
    (ids || []).forEach(function (id) {
      ex[id] = true;
      var desc = FigDoc.descendants(doc, id, { includeSelf: false }) || [];
      desc.forEach(function (dd) { ex[dd.id] = true; });
    });
    var out = [];
    (doc.elements || []).forEach(function (el) {
      if (!el || ex[el.id] || el.visible === false || el.parent_id) return;
      var b = FigDoc.bbox(doc, el.id, { recursive: true });
      var l = Math.min(b.x, b.x + b.w), r = Math.max(b.x, b.x + b.w);
      var t = Math.min(b.y, b.y + b.h), bt = Math.max(b.y, b.y + b.h);
      if (r - l > 0.01 && bt - t > 0.01) out.push({ l: l, r: r, t: t, b: bt });
    });
    return out;
  }

  // Equal-spacing snap for one axis. pos/size = dragged box's current left/top
  // and width/height on that axis; peers = [{a,b}] near/far edge coords sorted
  // input. Returns {pos,dist,segs:[{f,t}]} for the best candidate or null.
  function gapSnapAxis(pos, size, peers) {
    var before = peers.filter(function (pb) { return pb.b <= pos + 1e-6; })
      .sort(function (p, q) { return q.b - p.b; }); // nearest-left first
    var after = peers.filter(function (pb) { return pb.a >= pos + size - 1e-6; })
      .sort(function (p, q) { return p.a - q.a; }); // nearest-right first
    var L = before[0], L2 = before[1], R = after[0], R2 = after[1];
    var cands = [];
    if (L && R) {
      var cx = (L.b + R.a - size) / 2;
      cands.push({ pos: cx, segs: [{ f: L.b, t: cx }, { f: cx + size, t: R.a }] });
    }
    if (L2 && L) {
      var g = L.a - L2.b;
      if (g > 0) {
        var xr = L.b + g;
        cands.push({ pos: xr, segs: [{ f: L.b, t: xr }, { f: L2.b, t: L.a }] });
      }
    }
    if (R2 && R) {
      var g2 = R2.a - R.b;
      if (g2 > 0) {
        var xl = R.a - g2 - size;
        cands.push({ pos: xl, segs: [{ f: xl + size, t: R.a }, { f: R.b, t: R2.a }] });
      }
    }
    var best = null;
    cands.forEach(function (c) {
      var dist = Math.abs(pos - c.pos);
      if (!best || dist < best.dist) best = { pos: c.pos, dist: dist, segs: c.segs };
    });
    return best;
  }

  // Alt-hover measurement between the selection bbox and another element.
  function computeMeasure(selIds, hoverEl) {
    var A = global.App, doc = A.doc;
    var SB = unionSelBBox(doc, selIds);
    if (!SB) return null;
    var HB = FigDoc.bbox(doc, hoverEl.id, { recursive: true });
    var hb = normRect({ x0: HB.x, y0: HB.y, x1: HB.x + HB.w, y1: HB.y + HB.h });
    var sl = SB.x, sr = SB.x + SB.w, st = SB.y, sb = SB.y + SB.h;
    var hl = hb.x, hr = hb.x + hb.w, ht = hb.y, hbb = hb.y + hb.h;
    var xOverlap = sl < hr && hl < sr;
    var yOverlap = st < hbb && ht < sb;
    var segs = [];
    if (!xOverlap) {
      var from, to;
      if (sr <= hl) { from = sr; to = hl; } else { from = hr; to = sl; }
      if (to - from > 0.01) {
        var y = yOverlap ? (Math.max(st, ht) + Math.min(sb, hbb)) / 2
                         : ((SB.y + SB.h / 2) + (hb.y + hb.h / 2)) / 2;
        segs.push({ axis: 'x', f: from, t: to, at: y });
      }
    }
    if (!yOverlap) {
      var f2, t2;
      if (sb <= ht) { f2 = sb; t2 = ht; } else { f2 = hbb; t2 = st; }
      if (t2 - f2 > 0.01) {
        var x = xOverlap ? (Math.max(sl, hl) + Math.min(sr, hr)) / 2
                         : ((SB.x + SB.w / 2) + (hb.x + hb.w / 2)) / 2;
        segs.push({ axis: 'y', f: f2, t: t2, at: x });
      }
    }
    return segs.length ? segs : null;
  }

  function fmtGap(v) {
    var n = Math.round(v * 10) / 10;
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return n.toFixed(1);
  }

  // One dimension segment: line + two end ticks + "<n> mm" text label.
  function dimSeg(out, s, cls, z, sw) {
    var fs = r3(11 / z), tick = r3(3 / z);
    var val = fmtGap(Math.abs(s.t - s.f)) + ' mm';
    var mx, my, tx, ty, anchor;
    if (s.axis === 'x') {
      mx = (s.f + s.t) / 2; my = s.at;
      tx = mx; ty = my - fs * 0.9; anchor = 'middle';
      out.push(tag('line', { x1: r3(s.f), y1: r3(my), x2: r3(s.t), y2: r3(my), stroke: GUIDE_COLOR, 'stroke-width': sw }));
      out.push(tag('line', { x1: r3(s.f), y1: r3(my - tick / 2), x2: r3(s.f), y2: r3(my + tick / 2), stroke: GUIDE_COLOR, 'stroke-width': sw }));
      out.push(tag('line', { x1: r3(s.t), y1: r3(my - tick / 2), x2: r3(s.t), y2: r3(my + tick / 2), stroke: GUIDE_COLOR, 'stroke-width': sw }));
    } else {
      mx = s.at; my = (s.f + s.t) / 2;
      tx = mx + fs * 0.4; ty = my + fs * 0.35; anchor = 'start';
      out.push(tag('line', { x1: r3(mx), y1: r3(s.f), x2: r3(mx), y2: r3(s.t), stroke: GUIDE_COLOR, 'stroke-width': sw }));
      out.push(tag('line', { x1: r3(mx - tick / 2), y1: r3(s.f), x2: r3(mx + tick / 2), y2: r3(s.f), stroke: GUIDE_COLOR, 'stroke-width': sw }));
      out.push(tag('line', { x1: r3(mx - tick / 2), y1: r3(s.t), x2: r3(mx + tick / 2), y2: r3(s.t), stroke: GUIDE_COLOR, 'stroke-width': sw }));
    }
    out.push('<text x="' + r3(tx) + '" y="' + r3(ty) + '" text-anchor="' + anchor +
      '" fill="' + GUIDE_COLOR + '" font-size="' + fs + '" class="' + cls + '">' + val + '</text>');
  }

  function resetHover() {
    S.hoverBoxEl = null; S.hoverEl = null; S.hoverHandle = null;
    S.measure = null; S.hoverSig = '';
  }

  function trackHover(evt) {
    if (!S.stageEl) return;
    var over = (S.stageEl.contains && evt.target) ? S.stageEl.contains(evt.target) : true;
    S.hoverEvt = {
      clientX: evt.clientX, clientY: evt.clientY, over: over,
      ctrlKey: !!evt.ctrlKey, altKey: !!evt.altKey, metaKey: !!evt.metaKey,
      shiftKey: !!evt.shiftKey
    };
    if (S.hoverRaf) return;
    var run = function () { S.hoverRaf = 0; updateHover(); };
    if (typeof requestAnimationFrame === 'function') S.hoverRaf = requestAnimationFrame(run);
    else run();
  }

  function refreshHover() { updateHover(); }

  function updateHover() {
    var A = global.App;
    var prevSig = S.hoverSig;
    S.hoverBoxEl = null; S.hoverEl = null; S.hoverHandle = null; S.measure = null;
    var sig = '-';
    if (A && A.doc && S.svg && S.stageEl && S.hoverEvt && S.hoverEvt.over) {
      var tool = (A.ui && A.ui.tool) || 'select';
      if (tool === 'select' && !S.mode && !S.editingId) {
        var evt = S.hoverEvt;
        var r = S.svg.getBoundingClientRect();
        var z = zoomOf();
        var p = { x: (evt.clientX - r.left) / z, y: (evt.clientY - r.top) / z };
        var clean = !evt.ctrlKey && !evt.altKey && !evt.metaKey && !S.altDown;
        var el = hitElement(p);
        if (el) {
          S.hoverEl = el;
          if (clean && !isSelectedId(el.id)) S.hoverBoxEl = el;
          if (S.altDown && !isSelectedId(el.id)) {
            var sel = topmostSelected(A.doc);
            if (sel.length) S.measure = computeMeasure(sel, el);
          }
        }
        var hd = handleAt({ clientX: evt.clientX, clientY: evt.clientY });
        if (hd) S.hoverHandle = hd.key;
        sig = (S.hoverBoxEl ? S.hoverBoxEl.id : '-') + '|' +
          (S.hoverEl ? S.hoverEl.id : '-') + '|' + (S.hoverHandle || '-') + '|' +
          (S.measure ? S.measure.length : 0);
      }
    }
    if (sig !== S.hoverSig) {
      S.hoverSig = sig;
      renderOverlay();
    }
    updateCursor();
  }

  // ------------------------------------------------------------------
  // event dispatch: mouse
  // ------------------------------------------------------------------

  function onStageMouseDown(evt) {
    var A = global.App;
    if (!A || !A.doc || !S.svg) return;
    if (evt.button === 1) {           // middle-button drag pans the canvas
      if (!S.mode && !S.editingId) beginPan(evt);
      return;
    }
    if (evt.button !== 0) return;
    var t = evt.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (S.editingId) { commitTextEditor(); return; } // click ends in-place editing
    if (S.mode) return;
    evt.preventDefault();
    var tool = (A.ui && A.ui.tool) || 'select';
    var p = evtMm(evt);
    resetHover();

    if (S.spaceArmed && canvasIdle()) { beginPan(evt); return; } // Space+drag pans

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
      setChartPartRef(el, evt.target, evt);
      if (evt.altKey) beginDuplicate(p); else beginMove(p);
      return;
    }
    clearChartPartRef();
    beginMarquee(p, evt, false);
  }

  // R04：从点击目标向上找 data-chart-part / data-series-key / data-peak-id
  // 与所属 chart 的 data-fig-id；命中的图表按 data-fig-id 解析（嵌在
  // panel/group 里的 chart 同样支持点选部件）。
  function setChartPartRef(chartEl, targetNode, evt) {
    var A = global.App;
    if (!A.ui || typeof A.ui !== 'object') A.ui = {};
    var node = targetNode, part = null, key = null, peakId = null, figId = null;
    var pointKey = null, rowAttr = null, compactNode = null;
    var guard = 0;
    while (node && node !== S.svg && guard++ < 40) {
      if (node.getAttribute) {
        if (!part) part = node.getAttribute('data-chart-part');
        if (!key) key = node.getAttribute('data-series-key');
        if (!peakId) peakId = node.getAttribute('data-peak-id');
        if (!figId) figId = node.getAttribute('data-fig-id');
        if (!pointKey) pointKey = node.getAttribute('data-point-key');
        if (!compactNode && node.getAttribute('data-compact-marks')) compactNode = node;
        if (rowAttr === null) { var ra = node.getAttribute('data-row'); if (ra !== null) rowAttr = ra; }
      }
      node = node.parentNode;
    }
    if (!figId) {
      // 部件未携带所属元素标识（如旧渲染输出）：视为整图选择
      clearChartPartRef();
      return null;
    }
    var realChart = (A.doc && typeof FigDoc !== 'undefined' && FigDoc.get)
      ? FigDoc.get(A.doc, figId) : null;
    if (!realChart || realChart.type !== 'chart') {
      clearChartPartRef();
      return null;
    }
    // 大数据图的 compact 标记路径：按指针位置在命中索引里找最近点，
    // 命中则与逐点标记走同一 chartPart 结构（多 compact:true 与局部坐标
    // 供选中高亮环使用）；未命中则落到下方常规 series 分支。
    if (compactNode && evt && typeof FigData !== 'undefined' &&
        typeof FigData.chartHitIndex === 'function') {
      var hit = compactHitAt(compactNode, evt, realChart);
      if (hit) {
        A.ui.chartPart = {
          chartId: realChart.id,
          part: 'point',
          seriesKey: hit.seriesKey || key || null,
          pointKey: hit.key,
          row: String(hit.row),
          peakId: null,
          compact: true,
          compactX: hit.x, compactY: hit.y, compactR: hit.r
        };
        if (typeof A.emit === 'function') A.emit('ui:changed', { chartPart: A.ui.chartPart });
        refreshChartPartMark();
        return A.ui.chartPart;
      }
    }
    // 数据点/柱子标记：data-point-key 存在时 part 由键前缀决定（覆盖
    // data-chart-part="series"）；否则沿用 data-chart-part 原值。
    var effPart = part;
    if (pointKey) effPart = (pointKey.indexOf('bar|') === 0) ? 'bar' : 'point';
    else if (!effPart) { clearChartPartRef(); return null; }
    A.ui.chartPart = {
      chartId: realChart.id,
      part: effPart,
      seriesKey: key || null,
      pointKey: pointKey || null,
      row: rowAttr,
      peakId: peakId || null
    };
    if (typeof A.emit === 'function') A.emit('ui:changed', { chartPart: A.ui.chartPart });
    refreshChartPartMark();
    return A.ui.chartPart;
  }

  // compact 标记路径的最近点命中：指针经 getScreenCTM 逆变换到路径局部
  // 坐标（与渲染片段同单位），在 FigData.chartHitIndex 里取半径+3px 容差内
  // 最近的标记；返回 {x,y,r,row,key,seriesKey}（片段像素单位）。
  function compactHitAt(pathNode, evt, realChart) {
    if (!pathNode.getScreenCTM || typeof DOMPoint === 'undefined') return null;
    var ctm = pathNode.getScreenCTM();
    if (!ctm || !ctm.inverse) return null;
    var loc;
    try {
      loc = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse());
    } catch (e) { return null; }
    var A = global.App;
    var dpi = (A.doc && A.doc.canvas && typeof A.doc.canvas.dpi === 'number' &&
      isFinite(A.doc.canvas.dpi) && A.doc.canvas.dpi > 0) ? A.doc.canvas.dpi : 300;
    var box = (typeof ChartRender !== 'undefined' && ChartRender.resolveBoxMm)
      ? ChartRender.resolveBoxMm(A.doc, realChart) : null;
    var st = (realChart.style && typeof realChart.style === 'object') ? realChart.style : {};
    var hits = FigData.chartHitIndex(realChart.chart, {
      width_mm: box ? box.w : (Number(realChart.transform && realChart.transform.w) || 0),
      height_mm: box ? box.h : (Number(realChart.transform && realChart.transform.h) || 0),
      dpi: dpi,
      fontSizePt: st.fontSizePt,
      fontFamily: st.fontFamily
    });
    if (!hits || !hits.length) return null;
    var sk = pathNode.getAttribute('data-series-key');
    var best = null, bd = Infinity;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (sk && h.seriesKey !== sk) continue;
      var dx = h.x - loc.x, dy = h.y - loc.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d <= h.r + 3 && d < bd) { bd = d; best = h; }
    }
    return best;
  }

  // 当前 chartPart 的数据点/柱子 SVG 节点：先定位 data-fig-id=chartId 的
  // <g>，再在其内部逐个比对 data-point-key（键不拼进选择器，避免注入/转义）。
  function chartPartTargetNode() {
    var A = global.App;
    var cp = A && A.ui && A.ui.chartPart;
    if (!cp || !cp.pointKey || !S.svg || !S.svg.querySelectorAll) return null;
    var hosts = S.svg.querySelectorAll('[data-fig-id]');
    var host = null;
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i].getAttribute('data-fig-id') === cp.chartId) { host = hosts[i]; break; }
    }
    if (!host) return null;
    var marks = host.querySelectorAll('[data-point-key]');
    for (var j = 0; j < marks.length; j++) {
      if (marks[j].getAttribute('data-point-key') === cp.pointKey) return marks[j];
    }
    return null;
  }

  // 选中描边：每次画布重绘/选中变化后重打 data-part-selected；节点已随数据
  // 替换消失时清掉 chartPart（覆盖不再生效但仍留在文档里）。compact 点没有
  // 独立 DOM 节点，在 overlay 层画一个等效选中环（mm 用户单位，与画布同步）。
  function refreshChartPartMark() {
    if (!S.svg || !S.svg.querySelectorAll) return;
    var prev = S.svg.querySelectorAll('[data-part-selected]');
    for (var i = 0; i < prev.length; i++) prev[i].removeAttribute('data-part-selected');
    var oldRing = S.overlay && S.overlay.querySelectorAll
      ? S.overlay.querySelectorAll('[data-compact-ring]') : [];
    for (var rI = 0; rI < oldRing.length; rI++) {
      if (oldRing[rI].parentNode) oldRing[rI].parentNode.removeChild(oldRing[rI]);
    }
    var A = global.App;
    var cp = A && A.ui && A.ui.chartPart;
    if (!cp || !cp.pointKey) return;
    var node = chartPartTargetNode();
    if (!node) {
      if (cp.compact) { drawCompactPartRing(cp); return; }
      clearChartPartRef();
      return;
    }
    node.setAttribute('data-part-selected', '1');
  }

  // compact 点选中环：把命中点的片段局部坐标经路径 CTM 转成画布 mm，
  // 在 overlay（与 #svg-stage 同 viewBox）画 circle；半径按 CTM 比例换算。
  function drawCompactPartRing(cp) {
    if (!S.overlay || !S.svg || !S.svg.querySelectorAll) return;
    var hosts = S.svg.querySelectorAll('[data-fig-id]');
    var host = null;
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i].getAttribute('data-fig-id') === cp.chartId) { host = hosts[i]; break; }
    }
    if (!host) { clearChartPartRef(); return; }
    var paths = host.querySelectorAll('[data-compact-marks]');
    var pathNode = null;
    for (var j = 0; j < paths.length; j++) {
      if (paths[j].getAttribute('data-series-key') === cp.seriesKey) {
        pathNode = paths[j]; break;
      }
    }
    if (!pathNode || !pathNode.getCTM || typeof DOMPoint === 'undefined') {
      clearChartPartRef();
      return;
    }
    var ctm;
    try { ctm = pathNode.getCTM(); } catch (e) { ctm = null; }
    if (!ctm) { clearChartPartRef(); return; }
    var c, c2;
    try {
      c = new DOMPoint(cp.compactX, cp.compactY).matrixTransform(ctm);
      c2 = new DOMPoint(cp.compactX + 1, cp.compactY).matrixTransform(ctm);
    } catch (e) { clearChartPartRef(); return; }
    var unit = Math.sqrt((c2.x - c.x) * (c2.x - c.x) + (c2.y - c.y) * (c2.y - c.y));
    if (!isFinite(unit) || unit <= 0) { clearChartPartRef(); return; }
    var circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(c.x));
    circle.setAttribute('cy', String(c.y));
    circle.setAttribute('r', String((cp.compactR || 0) * unit + 0.4));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', '#FF3B5C');
    circle.setAttribute('stroke-width', '2');
    circle.setAttribute('vector-effect', 'non-scaling-stroke');
    circle.setAttribute('data-compact-ring', '1');
    circle.setAttribute('data-part-selected', '1');
    S.overlay.appendChild(circle);
  }

  function clearChartPartRef() {
    var A = global.App;
    if (A && A.ui && A.ui.chartPart) {
      A.ui.chartPart = null;
      if (typeof A.emit === 'function') A.emit('ui:changed', { chartPart: null });
    }
    refreshChartPartMark();
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
      lines: collectSnapLines(A.doc, ids),
      peerBoxes: collectPeerBoxes(A.doc, ids)
    };
  }

  // Alt+drag: copy the current selection; the duplicate (fixed new ids, built
  // once) is previewed at the drag offset and committed once on mouse-up.
  function beginDuplicate(p) {
    var A = global.App;
    var ids = topmostSelected(A.doc);
    if (!ids.length) return;
    var stmts = [], newIds = [];
    ids.forEach(function (id) {
      var desc = FigDoc.descendants(A.doc, id, { includeSelf: true });
      var map = Object.create(null);
      desc.forEach(function (e) { map[e.id] = FigDoc.uid('el'); });
      sortedByDepth(desc).forEach(function (e) { // parents before children
        var c = JSON.parse(JSON.stringify(e));
        c.id = map[e.id];
        c.parent_id = (e.parent_id && map[e.parent_id]) ? map[e.parent_id] : null;
        if (Array.isArray(c.children)) {
          c.children = c.children.map(function (cid) { return map[cid] || cid; });
        }
        c.transform = c.transform || { x: 0, y: 0, w: 0, h: 0 };
        stmts.push({ el: c });
        if (e.id === id) newIds.push(c.id);
      });
    });
    if (!stmts.length) return;
    S.mode = 'move';
    S.drag = {
      ids: ids, start: p, dx: 0, dy: 0,
      bbox: unionSelBBox(A.doc, ids),
      lines: collectSnapLines(A.doc, ids),
      peerBoxes: collectPeerBoxes(A.doc, ids),
      duplicate: true, dupStmts: stmts, dupNewIds: newIds
    };
  }

  // add_element ops for the pending duplicate at drag offset (dx,dy). Each call
  // clones the fixed-id statements so transforms never accumulate. 浅克隆共享
  // chart/style 等子树（提交时 applyAll 会整体深克隆，不会污染文档）。
  function dupOps(d, dx, dy) {
    return (d.dupStmts || []).map(function (s) {
      var src = s.el;
      var el = {};
      var ks = Object.keys(src);
      for (var i = 0; i < ks.length; i++) el[ks[i]] = src[ks[i]];
      el.transform = (src.transform && typeof src.transform === 'object')
        ? Object.assign({}, src.transform) : { x: 0, y: 0, w: 0, h: 0 };
      el.transform.x = (el.transform.x || 0) + dx;
      el.transform.y = (el.transform.y || 0) + dy;
      return { op: 'add_element', element: el };
    });
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
    var A = global.App;
    if (!S.mode) { trackHover(evt); return; }
    if (!A || !A.doc) return;
    if (S.mode === 'pan') { panTo(evt); return; }
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
    var todo = null, label = '', dupSelect = null;

    if (mode === 'pan') { endPan(); return; }
    if (mode === 'marquee') {
      finishMarquee();
      S.mode = null; S.marquee = null; S.guides = { v: [], h: [], gaps: [] };
      renderOverlay();
      return;
    }
    if (mode === 'anchor') {
      finishAnchor();
      S.mode = null; S.marquee = null; S.guides = { v: [], h: [], gaps: [] };
      renderOverlay();
      return;
    }
    if (mode === 'create') {
      finishCreate();
      S.mode = null; S.creating = null; S.guides = { v: [], h: [], gaps: [] };
      renderOverlay();
      return;
    }
    if (mode === 'move' && d && d.duplicate) {
      if ((d.dx || 0) !== 0 || (d.dy || 0) !== 0) {
        todo = dupOps(d, d.dx, d.dy);
        label = '拖动复制';
        dupSelect = d.dupNewIds;
      }
    } else if (mode === 'move' && d && ((d.dx || 0) !== 0 || (d.dy || 0) !== 0)) {
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
    S.guides = { v: [], h: [], gaps: [] };
    if (todo) {
      if (dupSelect && dupSelect.length) {
        commit(todo, label, function (done) {
          if (done && done.applied > 0) {
            var ready = dupSelect.every(function (id) { return !!FigDoc.get(A.doc, id); });
            if (ready) { if (typeof A.select === 'function') A.select(dupSelect); }
            else S.pendingAfterDoc = { select: dupSelect, textEdit: null };
          }
        });
      } else {
        commit(todo, label);
      }
    }
    render();
  }

  function onStageDblClick(evt) {
    var A = global.App;
    if (!A || !A.doc || !S.svg) return;
    var t = evt.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (S.editingId || S.mode) return;
    var p = evtMm(evt);
    var c = A.doc.canvas || {};
    var W = c.width_mm, H = c.height_mm;
    if (typeof W === 'number' && typeof H === 'number' &&
        (p.x < 0 || p.y < 0 || p.x > W || p.y > H)) {
      evt.preventDefault();
      fit();
      return;
    }
    var el = textElementAt(p);
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
    S.guides = { v: [], h: [], gaps: [] };
    if (A.ui.snap) {
      var z = zoomOf();
      var thr = SNAP_RADIUS_PX / z;
      var B = d.bbox;
      var D = { x: B.x + dx, y: B.y + dy, w: B.w, h: B.h };
      var bestX = null;
      [B.x + dx, B.x + B.w / 2 + dx, B.x + B.w + dx].forEach(function (v) {
        var s = nearestLine(v, d.lines.v, thr);
        if (s && (!bestX || s.diff < bestX.diff)) bestX = { s: s, val: v, diff: s.diff };
      });
      var bestY = null;
      [B.y + dy, B.y + B.h / 2 + dy, B.y + B.h + dy].forEach(function (v) {
        var s = nearestLine(v, d.lines.h, thr);
        if (s && (!bestY || s.diff < bestY.diff)) bestY = { s: s, val: v, diff: s.diff };
      });
      // Equal-spacing candidates (only vs top-level peers overlapping on the
      // cross axis). Winner replaces that axis's full-length guide line.
      var gapX = null, gapY = null;
      if (d.peerBoxes && d.peerBoxes.length) {
        var peersX = [], peersY = [];
        d.peerBoxes.forEach(function (pb) {
          if (pb.t < D.y + D.h && D.y < pb.b) peersX.push({ a: pb.l, b: pb.r });
          if (pb.l < D.x + D.w && D.x < pb.r) peersY.push({ a: pb.t, b: pb.b });
        });
        var gx = gapSnapAxis(D.x, D.w, peersX);
        if (gx && gx.dist <= thr) gapX = gx;
        var gy = gapSnapAxis(D.y, D.h, peersY);
        if (gy && gy.dist <= thr) gapY = gy;
      }
      var xGapSegs = null, yGapSegs = null;
      if (gapX && (!bestX || gapX.dist <= bestX.diff)) {
        dx = gapX.pos - B.x;
        xGapSegs = gapX.segs;
      } else if (bestX) {
        dx += bestX.s.line - bestX.val; S.guides.v = [bestX.s.line];
      }
      if (gapY && (!bestY || gapY.dist <= bestY.diff)) {
        dy = gapY.pos - B.y;
        yGapSegs = gapY.segs;
      } else if (bestY) {
        dy += bestY.s.line - bestY.val; S.guides.h = [bestY.s.line];
      }
      // Label positions use the final dragged-box center on the cross axis.
      if (xGapSegs) {
        var fcy = B.y + dy + B.h / 2;
        xGapSegs.forEach(function (s) { S.guides.gaps.push({ axis: 'x', f: s.f, t: s.t, at: fcy }); });
      }
      if (yGapSegs) {
        var fcx = B.x + dx + B.w / 2;
        yGapSegs.forEach(function (s) { S.guides.gaps.push({ axis: 'y', f: s.f, t: s.t, at: fcx }); });
      }
    }
    d.dx = dx; d.dy = dy;
    if (dx !== 0 || dy !== 0) {
      if (d.duplicate) previewOps(dupOps(d, dx, dy));
      else previewOps([{ op: 'move', targets: d.ids, dx: dx, dy: dy }]);
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

    S.guides = { v: [], h: [], gaps: [] };
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
      S.previewDoc = null; S.guides = { v: [], h: [], gaps: [] };
      had = true;
    }
    if (S.editingId) { cancelTextEditor(false); had = true; }
    resetHover();
    if (hadPreview) render();
    else if (had) renderOverlay();
    if (A.selectionSet && A.selectionSet.size) {
      A.clearSelection();
      had = true;
    }
    if (had) A.status('已取消当前操作');
  }

  // H2：页面存在非空文本选区且选区不在画布 SVG 内时，Ctrl+C 交给浏览器复制文本，
  // 不拦截为「复制画布元素」。
  function textSelectionOutsideCanvas() {
    try {
      var sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null;
      if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
      var txt = sel.toString();
      if (!txt || !txt.trim()) return false;
      var node = sel.anchorNode;
      if (S && S.svg && node && typeof S.svg.contains === 'function' && S.svg.contains(node)) return false;
      return true;
    } catch (e) { return false; }
  }

  function onKeyDown(evt) {
    var A = global.App;
    if (!A || !S.mounted || !A.doc) return;
    var t = evt.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
              t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (S.editingId) return;
    var k = evt.key;
    var mod = evt.ctrlKey || evt.metaKey;
    var stop = function () { evt.preventDefault(); evt.stopPropagation(); };

    if (mod && (k === 'z' || k === 'Z')) { stop(); if (evt.shiftKey) redo(); else undo(); return; }
    if (mod && (k === 'y' || k === 'Y')) { stop(); redo(); return; }
    if (mod && (k === 'c' || k === 'C')) {
      if (textSelectionOutsideCanvas()) return; // 画布外文本选区 → 浏览器复制文本
      stop(); copySelection(); return;
    }
    if (mod && (k === 'v' || k === 'V')) { stop(); pasteClipboard(); return; }
    if (mod && (k === 'd' || k === 'D')) { stop(); duplicateSelection(); return; }
    if (mod && (k === 'a' || k === 'A')) { stop(); selectAll(); return; }
    if (mod) return;
    if (k === 'Delete' || k === 'Backspace') { stop(); deleteSelection(); return; }
    if (k === 'Escape') { stop(); escapeAction(); return; }
    if (evt.code === 'Digit1' && evt.shiftKey && !mod && !evt.altKey) {
      stop(); fit(); return;
    }
    if (k === 'Alt') {
      S.altDown = true;
      if (canvasIdle()) evt.preventDefault(); // keep browser menu from stealing focus
      refreshHover();
      return;
    }
    if (k === ' ' || evt.code === 'Space') {
      // 焦点在可激活元素上时让位：键盘 Tab 聚焦（focusin 时 :focus-visible
      // 为真）的按钮保留原生空格激活；鼠标点出来的焦点先 blur 再走平移。
      // 注意不能在此刻重查 :focus-visible——按 Space 本身会把按钮翻成
      // focus-visible，无法区分两种焦点来源，故用 onFocusIn 的快照。
      var ae = document.activeElement;
      if (ae && typeof ae.matches === 'function' &&
          ae.matches('button, a, summary, [role="button"]')) {
        var kbdFocused = (ae.__kbdFocus !== undefined) ? !!ae.__kbdFocus
          : (function () { try { return ae.matches(':focus-visible'); }
                            catch (e) { return false; } })();
        if (kbdFocused) return;
        try { ae.blur(); } catch (e2) { /* ignore */ }
      }
      if (canvasIdle()) { S.spaceArmed = true; evt.preventDefault(); updateCursor(); }
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      stop();
      nudge(k, evt.shiftKey);
    }
  }

  // 在焦点落下的瞬间快照 :focus-visible（此时 Tab→true、鼠标→false，
  // 尚未被后续按键翻成 focus-visible）。Space 处理据此区分「键盘 Tab
  // 聚焦的按钮」（保留原生空格激活）与「鼠标点出来的焦点」（先 blur 再平移）。
  function onFocusIn(evt) {
    var t = evt.target;
    if (t && t.nodeType === 1) {
      try { t.__kbdFocus = !!t.matches(':focus-visible'); }
      catch (e) { t.__kbdFocus = false; }
    }
  }

  function onKeyUp(evt) {
    if (!S.mounted) return;
    var k = evt.key;
    if (k === 'Alt' && S.altDown) {
      S.altDown = false;
      refreshHover();
    } else if ((k === ' ' || evt.code === 'Space') && S.spaceArmed) {
      S.spaceArmed = false;
      evt.preventDefault();
      updateCursor();
    }
  }

  function onWindowBlur() {
    var wasPan = S.mode === 'pan';
    S.spaceArmed = false; S.altDown = false;
    if (wasPan) { S.mode = null; S.pan = null; S.drag = null; }
    updateCursor();
    refreshHover();
    if (wasPan) renderOverlay();
  }

  // ------------------------------------------------------------------
  // App event handlers
  // ------------------------------------------------------------------

  function onDocChanged() {
    S.previewDoc = null;
    S.guides = { v: [], h: [], gaps: [] };
    resetHover();
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
    resetHover(); // hovered element may now be selected; box/measure/cursor refresh
    renderOverlay();
    updateCursor();
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
    refreshChartPartMark();
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
    if (!A) throw new Error('编辑器未加载，无法缩放');
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
    selectedBBox: selectedBBox,
    chartPartNode: function () { return chartPartTargetNode(); },
    spaceArmed: function () { return !!S.spaceArmed; }, // 测试只读钩子
    previewApplyFast: previewApplyFast // 测试只读钩子：与 FigOps.applyAll 对拍
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
