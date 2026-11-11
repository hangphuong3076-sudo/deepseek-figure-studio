/**
 * figdoc.js — FigDoc: document model & coordinate utilities for the shared
 * figure-editing kernel (v1.0, frozen contract in shared/lib/API.md).
 *
 * Pure JS, no DOM, no modules, no third-party deps. Attaches `FigDoc` to
 * globalThis so it works under Node (`globalThis.FigDoc`) and in the browser
 * (`window.FigDoc`) when loaded via <script src="lib/figdoc.js">.
 *
 * Conventions:
 *  - Units are millimeters (mm) and points (pt) inside documents.
 *  - All structural changes are immutable in style: the incoming doc is
 *    structured-cloned, the copy is mutated, and the copy is returned.
 *  - Errors are thrown as `Error` with Chinese messages; no silent fallback.
 */
(function (global) {
  'use strict';

  const SCHEMA_VERSION = '1.0';

  const ELEMENT_TYPES = ['rect', 'ellipse', 'line', 'arrow', 'path', 'text', 'image', 'chart', 'group', 'panel', 'connector'];
  const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
  const COLOR_MODES = ['RGB', 'CMYK', 'GRAY'];

  // ------------------------------------------------------------------
  // Small generic helpers
  // ------------------------------------------------------------------

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function deepClone(value) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch (e) {
        throw new Error('对象包含无法克隆的数据: ' + (e && e.message ? e.message : String(e)));
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function requireDoc(doc) {
    if (!isPlainObject(doc)) throw new Error('无效的文档对象');
    if (!Array.isArray(doc.elements)) throw new Error('文档缺少 elements 数组');
  }

  function requireId(id, what) {
    if (typeof id !== 'string' || !id) throw new Error(what + '必须为非空字符串');
    return id;
  }

  function isContainer(el) {
    return !!el && (el.type === 'group' || el.type === 'panel');
  }

  function findById(doc, id) {
    const els = doc.elements;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el && el.id === id) return el;
    }
    return null;
  }

  function childrenIds(el) {
    return Array.isArray(el.children) ? el.children : [];
  }

  // ------------------------------------------------------------------
  // create — empty document conforming to figure-document.schema.json
  // ------------------------------------------------------------------

  function requirePositive(v, what) {
    if (!isFiniteNumber(v) || v <= 0) throw new Error(what + '必须为正数');
    return v;
  }

  function create(opts) {
    opts = isPlainObject(opts) ? opts : {};
    const width_mm = opts.width_mm === undefined ? 120 : requirePositive(opts.width_mm, 'width_mm');
    const height_mm = opts.height_mm === undefined ? 90 : requirePositive(opts.height_mm, 'height_mm');
    const dpi = opts.dpi === undefined ? 300 : requirePositive(opts.dpi, 'dpi');
    const background = opts.background === undefined ? '#FFFFFF' : opts.background;
    if (typeof background !== 'string') throw new Error('background 必须为字符串');
    const journal_preset_id = opts.journal_preset_id === undefined ? null : opts.journal_preset_id;
    if (journal_preset_id !== null && typeof journal_preset_id !== 'string') {
      throw new Error('journal_preset_id 必须为字符串或 null');
    }
    const now = new Date().toISOString();
    const doc = {
      schema_version: SCHEMA_VERSION,
      id: uid('doc'),
      title: typeof opts.title === 'string' ? opts.title : '',
      canvas: {
        width_mm,
        height_mm,
        dpi,
        background,
        color_mode: 'RGB',
        journal_preset_id,
        bleed_mm: 0,
      },
      elements: [],
      panels: [],
      anchors: [],
      history: [],
      meta: { created: now, updated: now, provenance: [] },
    };
    if (typeof opts.app === 'string') doc.meta.app = opts.app;
    if (typeof opts.app_version === 'string') doc.meta.app_version = opts.app_version;
    return doc;
  }

  // ------------------------------------------------------------------
  // uid — unique within the current process
  // ------------------------------------------------------------------

  const uidIssued = Object.create(null);

  function uid(prefix) {
    if (typeof prefix !== 'string' || !prefix) throw new Error('uid 前缀必须为非空字符串');
    for (;;) {
      // 36^8 = 2821109907456 → up to 8 base36 chars, zero-padded to 8.
      let s = Math.floor(Math.random() * 2821109907456).toString(36);
      while (s.length < 8) s = '0' + s;
      if (uidIssued[s]) continue;
      uidIssued[s] = true;
      return prefix + '-' + s;
    }
  }

  // ------------------------------------------------------------------
  // Unit conversions
  // ------------------------------------------------------------------

  function mmToPx(mm, dpi) {
    if (!isFiniteNumber(mm)) throw new Error('mm 必须为有限数字');
    if (!isFiniteNumber(dpi) || dpi <= 0) throw new Error('dpi 必须为正数');
    return (mm * dpi) / 25.4;
  }

  function pxToMm(px, dpi) {
    if (!isFiniteNumber(px)) throw new Error('px 必须为有限数字');
    if (!isFiniteNumber(dpi) || dpi <= 0) throw new Error('dpi 必须为正数');
    return (px * 25.4) / dpi;
  }

  function ptToPx(pt, dpi) {
    if (!isFiniteNumber(pt)) throw new Error('pt 必须为有限数字');
    if (!isFiniteNumber(dpi) || dpi <= 0) throw new Error('dpi 必须为正数');
    return (pt * dpi) / 72;
  }

  function requireCanvasSize(canvas) {
    if (!isPlainObject(canvas) ||
        !isFiniteNumber(canvas.width_mm) || canvas.width_mm <= 0 ||
        !isFiniteNumber(canvas.height_mm) || canvas.height_mm <= 0) {
      throw new Error('画布缺少有效的 width_mm/height_mm');
    }
    return canvas;
  }

  function requireBbox4(b, what) {
    if (!isPlainObject(b)) throw new Error(what + ' 必须为 {x,y,w,h} 对象');
    const keys = ['x', 'y', 'w', 'h'];
    for (const k of keys) {
      if (!isFiniteNumber(b[k])) throw new Error(what + '.' + k + ' 必须为有限数字');
    }
  }

  function normToMm(bboxNorm, canvas) {
    requireBbox4(bboxNorm, 'bboxNorm');
    requireCanvasSize(canvas);
    return {
      x: bboxNorm.x * canvas.width_mm,
      y: bboxNorm.y * canvas.height_mm,
      w: bboxNorm.w * canvas.width_mm,
      h: bboxNorm.h * canvas.height_mm,
    };
  }

  function mmToNorm(bboxMm, canvas) {
    requireBbox4(bboxMm, 'bboxMm');
    requireCanvasSize(canvas);
    return {
      x: bboxMm.x / canvas.width_mm,
      y: bboxMm.y / canvas.height_mm,
      w: bboxMm.w / canvas.width_mm,
      h: bboxMm.h / canvas.height_mm,
    };
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  function get(doc, id) {
    requireDoc(doc);
    requireId(id, '元素 id');
    return findById(doc, id);
  }

  function byType(doc, type) {
    requireDoc(doc);
    if (typeof type !== 'string') throw new Error('type 必须为字符串');
    return doc.elements.filter((el) => el && el.type === type);
  }

  // Children in the order given by the parent's `children` array (render order).
  function children(doc, parentId) {
    requireDoc(doc);
    requireId(parentId, '父元素 id');
    const parent = findById(doc, parentId);
    if (!parent) throw new Error('元素不存在: ' + parentId);
    const out = [];
    for (const cid of childrenIds(parent)) {
      const c = findById(doc, cid);
      if (c) out.push(c);
    }
    return out;
  }

  function collectDescendants(doc, id, includeSelf) {
    const root = findById(doc, id);
    if (!root) throw new Error('元素不存在: ' + id);
    const out = [];
    const seen = new Set();
    const walk = (el) => {
      if (seen.has(el.id)) return;
      seen.add(el.id);
      out.push(el);
      for (const cid of childrenIds(el)) {
        const c = findById(doc, cid);
        if (c) walk(c);
      }
    };
    if (includeSelf) {
      walk(root);
    } else {
      seen.add(root.id);
      for (const cid of childrenIds(root)) {
        const c = findById(doc, cid);
        if (c) walk(c);
      }
    }
    return out;
  }

  function descendants(doc, id, opts) {
    requireDoc(doc);
    requireId(id, '元素 id');
    const includeSelf = !!(opts && opts.includeSelf);
    return collectDescendants(doc, id, includeSelf);
  }

  // Inner → outer: [direct parent, grandparent, ...].
  function ancestors(doc, id) {
    requireDoc(doc);
    requireId(id, '元素 id');
    const start = findById(doc, id);
    if (!start) throw new Error('元素不存在: ' + id);
    const out = [];
    const seen = new Set([id]);
    let pid = start.parent_id;
    while (typeof pid === 'string' && pid && !seen.has(pid)) {
      const p = findById(doc, pid);
      if (!p) break;
      seen.add(p.id);
      out.push(p);
      pid = p.parent_id;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Geometry: bbox / hitTest
  // ------------------------------------------------------------------

  function unionBBox(a, b) {
    const x1 = Math.min(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.w, b.x + b.w);
    const y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // Content area of a panel = its transform shrunk by panelLayout.padding_mm
  // on every side. Returns null when the area degenerates (callers decide
  // whether to fall back or to throw).
  function panelContentArea(panel) {
    const t = isPlainObject(panel.transform) ? panel.transform : { x: 0, y: 0, w: 0, h: 0 };
    let pad = 0;
    if (isPlainObject(panel.panelLayout) && isFiniteNumber(panel.panelLayout.padding_mm)) {
      pad = panel.panelLayout.padding_mm;
    }
    const x = (isFiniteNumber(t.x) ? t.x : 0) + pad;
    const y = (isFiniteNumber(t.y) ? t.y : 0) + pad;
    const w = (isFiniteNumber(t.w) ? t.w : 0) - 2 * pad;
    const h = (isFiniteNumber(t.h) ? t.h : 0) - 2 * pad;
    if (!(w > 0) || !(h > 0)) return null;
    return { x, y, w, h };
  }

  // World-space (mm) bbox of one element. When `style.panelRelative === true`
  // and the parent is a panel, the transform holds 0–1 ratios of the panel's
  // content area and is converted to mm here.
  function elementBBox(doc, el, recursive, seen) {
    const t = isPlainObject(el.transform) ? el.transform : {};
    let x = isFiniteNumber(t.x) ? t.x : 0;
    let y = isFiniteNumber(t.y) ? t.y : 0;
    let w = isFiniteNumber(t.w) ? t.w : 0;
    let h = isFiniteNumber(t.h) ? t.h : 0;
    const panelRelative = isPlainObject(el.style) && el.style.panelRelative === true;
    if (panelRelative && typeof el.parent_id === 'string' && el.parent_id) {
      const parent = findById(doc, el.parent_id);
      if (parent && parent.type === 'panel') {
        const area = panelContentArea(parent);
        if (area) {
          x = area.x + x * area.w;
          y = area.y + y * area.h;
          w = w * area.w;
          h = h * area.h;
        }
      }
    }
    let bb = { x, y, w, h };
    if (recursive && isContainer(el) && !seen.has(el.id)) {
      seen.add(el.id);
      for (const cid of childrenIds(el)) {
        const c = findById(doc, cid);
        if (!c) continue;
        bb = unionBBox(bb, elementBBox(doc, c, true, seen));
      }
    }
    return bb;
  }

  function bbox(doc, id, opts) {
    requireDoc(doc);
    requireId(id, '元素 id');
    const el = findById(doc, id);
    if (!el) throw new Error('元素不存在: ' + id);
    const recursive = !(opts && opts.recursive === false);
    return elementBBox(doc, el, recursive, new Set());
  }

  function rectsIntersect(a, b) {
    return a.x <= b.x + b.w && b.x <= a.x + a.w &&
           a.y <= b.y + b.h && b.y <= a.y + a.h;
  }

  // Top-level elements only, larger z first, skipping locked / invisible.
  function hitTest(doc, point) {
    requireDoc(doc);
    if (!isPlainObject(point) || !isFiniteNumber(point.x_mm) || !isFiniteNumber(point.y_mm)) {
      throw new Error('hitTest 需要 {x_mm, y_mm} 坐标对象');
    }
    const px = point.x_mm;
    const py = point.y_mm;
    const candidates = doc.elements
      .filter((el) => el && !el.parent_id && el.visible !== false && el.locked !== true)
      .sort((a, b) => (isFiniteNumber(b.z) ? b.z : 0) - (isFiniteNumber(a.z) ? a.z : 0));
    const seen = new Set();
    for (const el of candidates) {
      const bb = elementBBox(doc, el, true, seen);
      if (px >= bb.x && px <= bb.x + bb.w && py >= bb.y && py <= bb.y + bb.h) return el;
    }
    return null;
  }

  // Anchors attached to an element: via anchor.element_ids; when an anchor has
  // no element_ids list, fall back to bbox_mm intersection with the element.
  function anchorsOf(doc, elementId) {
    requireDoc(doc);
    requireId(elementId, '元素 id');
    const el = findById(doc, elementId);
    const out = [];
    const anchors = Array.isArray(doc.anchors) ? doc.anchors : [];
    for (const a of anchors) {
      if (!isPlainObject(a)) continue;
      if (Array.isArray(a.element_ids)) {
        if (a.element_ids.indexOf(elementId) !== -1) out.push(a);
      } else if (el) {
        const ab = a.bbox_mm;
        if (isPlainObject(ab) &&
            isFiniteNumber(ab.x) && isFiniteNumber(ab.y) &&
            isFiniteNumber(ab.w) && isFiniteNumber(ab.h)) {
          if (rectsIntersect(elementBBox(doc, el, true, new Set()), ab)) out.push(a);
        }
      }
    }
    return out;
  }

  function elementsInAnchor(doc, anchorId) {
    requireDoc(doc);
    requireId(anchorId, '锚点 id');
    const anchors = Array.isArray(doc.anchors) ? doc.anchors : [];
    let anchor = null;
    for (const a of anchors) {
      if (isPlainObject(a) && a.id === anchorId) { anchor = a; break; }
    }
    if (!anchor) throw new Error('锚点不存在: ' + anchorId);
    if (Array.isArray(anchor.element_ids) && anchor.element_ids.length) {
      const out = [];
      for (const eid of anchor.element_ids) {
        const e = findById(doc, eid);
        if (e) out.push(e);
      }
      return out;
    }
    // No explicit list: hit by bbox_mm intersection (same rule as "@anchor" targets).
    const ab = anchor.bbox_mm;
    if (!isPlainObject(ab) ||
        !isFiniteNumber(ab.x) || !isFiniteNumber(ab.y) ||
        !isFiniteNumber(ab.w) || !isFiniteNumber(ab.h)) return [];
    return doc.elements.filter((el) => {
      if (!el) return false;
      return rectsIntersect(elementBBox(doc, el, true, new Set()), ab);
    });
  }

  // ------------------------------------------------------------------
  // Structural changes (immutable style: clone → mutate copy → return)
  // ------------------------------------------------------------------

  function addElement(doc, element) {
    requireDoc(doc);
    if (!isPlainObject(element)) throw new Error('addElement 需要元素对象');
    const el = deepClone(element);
    if (typeof el.id !== 'string' || !el.id) el.id = uid('el');
    if (ELEMENT_TYPES.indexOf(el.type) === -1) throw new Error('元素类型非法: ' + el.id + ' (' + el.type + ')');
    if (!isPlainObject(el.transform)) throw new Error('元素缺少有效的 transform: ' + el.id);
    const tk = ['x', 'y', 'w', 'h'];
    for (const k of tk) {
      if (!isFiniteNumber(el.transform[k])) throw new Error('元素 transform.' + k + ' 必须为有限数字: ' + el.id);
    }
    const d = deepClone(doc);
    if (findById(d, el.id)) throw new Error('元素 id 已存在: ' + el.id);
    if (el.parent_id != null) {
      if (typeof el.parent_id !== 'string') throw new Error('parent_id 必须为字符串或 null');
      if (el.parent_id === el.id) throw new Error('元素不能以自身为父元素: ' + el.id);
      const parent = findById(d, el.parent_id);
      if (!parent) throw new Error('父元素不存在: ' + el.parent_id);
      if (!isContainer(parent)) throw new Error('父元素不是 group/panel，无法持有子元素: ' + el.parent_id);
      if (!Array.isArray(parent.children)) parent.children = [];
      if (parent.children.indexOf(el.id) === -1) parent.children.push(el.id);
    } else {
      el.parent_id = null;
    }
    // Appended elements land on top unless an explicit z was given.
    if (!isFiniteNumber(el.z)) {
      let maxZ = null;
      for (const e of d.elements) {
        if (e && isFiniteNumber(e.z)) maxZ = maxZ === null ? e.z : Math.max(maxZ, e.z);
      }
      el.z = maxZ === null ? 0 : maxZ + 1;
    }
    d.elements.push(el);
    return d;
  }

  function removeElement(doc, id, opts) {
    requireDoc(doc);
    requireId(id, '元素 id');
    const cascade = !(opts && opts.cascade === false);
    if (!findById(doc, id)) throw new Error('元素不存在: ' + id);
    const d = deepClone(doc);
    const doomed = new Set([id]);
    if (cascade) {
      for (const de of collectDescendants(d, id, true)) doomed.add(de.id);
    }
    const stranded = [];
    for (const el of d.elements) {
      if (!el || el.type !== 'connector' || doomed.has(el.id) || !isPlainObject(el.relation)) continue;
      const diagramId = el.diagramId || el.diagram_id;
      const refs = [el.relation.source, el.relation.target];
      const missing = refs.some((ref) => {
        if (doomed.has(ref)) return true;
        return d.elements.some((node) => node && node.type === 'group' && node.diagramNodeId === ref &&
          (node.diagramId || node.diagram_id) === diagramId && doomed.has(node.id));
      });
      if (!missing) continue;
      stranded.push({ action: 'remove_stranded_connector', connector_id: el.id,
        source: el.relation.source, target: el.relation.target, reason: 'referenced node removed' });
      doomed.add(el.id);
      if (typeof el.label_element_id === 'string') doomed.add(el.label_element_id);
    }
    if (stranded.length) {
      if (!isPlainObject(d.meta)) d.meta = {};
      if (!Array.isArray(d.meta.connector_audit)) d.meta.connector_audit = [];
      d.meta.connector_audit = d.meta.connector_audit.concat(stranded);
    }
    d.elements = d.elements.filter((el) => !el || !doomed.has(el.id));
    // Clean every remaining reference to the removed ids.
    for (const el of d.elements) {
      if (el && Array.isArray(el.children)) {
        el.children = el.children.filter((cid) => !doomed.has(cid));
      }
    }
    if (Array.isArray(d.anchors)) {
      for (const a of d.anchors) {
        if (a && Array.isArray(a.element_ids)) {
          a.element_ids = a.element_ids.filter((eid) => !doomed.has(eid));
        }
      }
    }
    if (Array.isArray(d.panels)) {
      for (const p of d.panels) {
        if (p && typeof p === 'object' && doomed.has(p.parent_id)) p.parent_id = null;
      }
      d.panels = d.panels.filter((p) => p && typeof p === 'object' && !doomed.has(p.element_id));
    }
    return d;
  }

  // Re-parent an element. With keepWorldPosition (default) the child's
  // transform is recomputed so its world position in mm stays unchanged:
  // panel-relative (normalized) children are converted through the panel
  // content areas of the old and new parent.
  function setParent(doc, childId, parentId, opts) {
    requireDoc(doc);
    requireId(childId, '元素 id');
    const keepWorld = !(opts && opts.keepWorldPosition === false);
    const child = findById(doc, childId);
    if (!child) throw new Error('元素不存在: ' + childId);
    if (parentId != null && typeof parentId !== 'string') throw new Error('parentId 必须为字符串或 null');
    if (parentId === childId) throw new Error('不能将元素的父元素设为其自身: ' + childId);
    let newParent = null;
    if (parentId != null) {
      newParent = findById(doc, parentId);
      if (!newParent) throw new Error('父元素不存在: ' + parentId);
      if (!isContainer(newParent)) throw new Error('父元素必须是 group 或 panel: ' + parentId);
      for (const de of collectDescendants(doc, childId, true)) {
        if (de.id === parentId) throw new Error('不能把元素移动到它自身或其子元素之下: ' + parentId);
      }
    }
    if ((child.parent_id || null) === (parentId || null)) return deepClone(doc);

    // World-space bbox before the move (original doc, so old panel-relative
    // coordinates are resolved against the old parent).
    const world = keepWorld ? elementBBox(doc, child, false, new Set()) : null;

    const d = deepClone(doc);
    const el = findById(d, childId);
    const oldParent = el.parent_id ? findById(d, el.parent_id) : null;
    if (oldParent && Array.isArray(oldParent.children)) {
      const pos = oldParent.children.indexOf(childId);
      if (pos !== -1) oldParent.children.splice(pos, 1);
    }
    el.parent_id = parentId || null;
    if (newParent) {
      const np = findById(d, parentId);
      if (!Array.isArray(np.children)) np.children = [];
      if (np.children.indexOf(childId) === -1) np.children.push(childId);
    }

    if (keepWorld && world) {
      if (!isPlainObject(el.style)) el.style = {};
      if (el.parent_id && findById(d, el.parent_id).type === 'panel' && el.style.panelRelative === true) {
        // Rewrite the transform as 0–1 ratios of the NEW panel's content area.
        const area = panelContentArea(findById(d, el.parent_id));
        if (!area) throw new Error('目标面板内容区无效，无法换算归一化坐标: ' + el.parent_id);
        el.transform.x = (world.x - area.x) / area.w;
        el.transform.y = (world.y - area.y) / area.h;
        el.transform.w = world.w / area.w;
        el.transform.h = world.h / area.h;
      } else if (el.style.panelRelative === true) {
        // Leaving panel-relative space: bake the world mm rect into transform.
        el.transform.x = world.x;
        el.transform.y = world.y;
        el.transform.w = world.w;
        el.transform.h = world.h;
        el.style.panelRelative = false;
      }
      // Otherwise the transform already holds world mm — nothing to recompute.
    }
    return d;
  }

  function reorder(doc, id, opts) {
    requireDoc(doc);
    requireId(id, '元素 id');
    if (!isPlainObject(opts) || ['front', 'back', 'forward', 'backward'].indexOf(opts.to) === -1) {
      throw new Error('reorder 需要 {to: "front"|"back"|"forward"|"backward"}');
    }
    const d = deepClone(doc);
    const el = findById(d, id);
    if (!el) throw new Error('元素不存在: ' + id);
    if (!isFiniteNumber(el.z)) el.z = 0;
    const parentId = el.parent_id || null;
    const to = opts.to;

    // Sibling scope = elements sharing the same parent (null = top level).
    const scope = [];
    d.elements.forEach((e, i) => {
      if (e && (e.parent_id || null) === parentId) scope.push({ el: e, i });
    });
    scope.sort((a, b) =>
      ((isFiniteNumber(a.el.z) ? a.el.z : 0) - (isFiniteNumber(b.el.z) ? b.el.z : 0)) || (a.i - b.i));
    let idx = -1;
    for (let i = 0; i < scope.length; i++) if (scope[i].el === el) { idx = i; break; }

    if (to === 'front') {
      let maxZ = null;
      for (const o of scope) {
        if (o.el === el) continue;
        const z = isFiniteNumber(o.el.z) ? o.el.z : 0;
        maxZ = maxZ === null ? z : Math.max(maxZ, z);
      }
      if (maxZ !== null) el.z = maxZ + 1;
    } else if (to === 'back') {
      let minZ = null;
      for (const o of scope) {
        if (o.el === el) continue;
        const z = isFiniteNumber(o.el.z) ? o.el.z : 0;
        minZ = minZ === null ? z : Math.min(minZ, z);
      }
      if (minZ !== null) el.z = minZ - 1;
    } else if (to === 'forward') {
      if (idx > -1 && idx < scope.length - 1) {
        const next = scope[idx + 1].el;
        if (!isFiniteNumber(next.z)) next.z = 0;
        if (next.z === el.z) {
          el.z = next.z + 1;
        } else {
          const tmp = el.z;
          el.z = next.z;
          next.z = tmp;
        }
      }
    } else if (to === 'backward') {
      if (idx > 0) {
        const prev = scope[idx - 1].el;
        if (!isFiniteNumber(prev.z)) prev.z = 0;
        if (prev.z === el.z) {
          el.z = prev.z - 1;
        } else {
          const tmp = el.z;
          el.z = prev.z;
          prev.z = tmp;
        }
      }
    }

    // Keep the parent's children array (render order) in the same direction.
    if (parentId) {
      const parent = findById(d, parentId);
      if (parent && Array.isArray(parent.children)) {
        const arr = parent.children;
        const pos = arr.indexOf(id);
        if (pos !== -1) {
          if (to === 'front') {
            arr.splice(pos, 1);
            arr.push(id);
          } else if (to === 'back') {
            arr.splice(pos, 1);
            arr.unshift(id);
          } else if (to === 'forward' && pos < arr.length - 1) {
            const tmp = arr[pos];
            arr[pos] = arr[pos + 1];
            arr[pos + 1] = tmp;
          } else if (to === 'backward' && pos > 0) {
            const tmp = arr[pos];
            arr[pos] = arr[pos - 1];
            arr[pos - 1] = tmp;
          }
        }
      }
    }
    return d;
  }

  function setCanvas(doc, patch) {
    requireDoc(doc);
    if (!isPlainObject(patch)) throw new Error('setCanvas 需要 canvas 补丁对象');
    const d = deepClone(doc);
    if (!isPlainObject(d.canvas)) d.canvas = {};
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if ((k === 'width_mm' || k === 'height_mm') && (!isFiniteNumber(v) || v <= 0)) {
        throw new Error('画布' + (k === 'width_mm' ? '宽' : '高') + '必须为正数');
      }
      if (k === 'dpi' && (!isFiniteNumber(v) || v <= 0)) throw new Error('画布 dpi 必须为正数');
      if (k === 'background' && typeof v !== 'string') throw new Error('画布背景色必须为字符串');
      if (k === 'color_mode' && COLOR_MODES.indexOf(v) === -1) throw new Error('color_mode 必须为 RGB/CMYK/GRAY');
      if (k === 'journal_preset_id' && v !== null && typeof v !== 'string') {
        throw new Error('journal_preset_id 必须为字符串或 null');
      }
      if (k === 'bleed_mm' && (!isFiniteNumber(v) || v < 0)) throw new Error('bleed_mm 必须为非负数字');
      d.canvas[k] = deepClone(v);
    }
    return d;
  }

  function touch(doc) {
    requireDoc(doc);
    const d = deepClone(doc);
    if (!isPlainObject(d.meta)) d.meta = {};
    const now = new Date().toISOString();
    if (typeof d.meta.created !== 'string' || !d.meta.created) d.meta.created = now;
    d.meta.updated = now;
    return d;
  }

  function clone(doc) {
    requireDoc(doc);
    return deepClone(doc);
  }

  // ------------------------------------------------------------------
  // normalize — fill defaults, sort by z, drop dangling references
  // ------------------------------------------------------------------

  function normalize(doc) {
    if (!isPlainObject(doc)) throw new Error('无效的文档对象');
    const d = deepClone(doc);

    if (typeof d.schema_version !== 'string' || !d.schema_version) d.schema_version = SCHEMA_VERSION;
    if (!isPlainObject(d.canvas)) d.canvas = {};
    if (!isFiniteNumber(d.canvas.width_mm) || d.canvas.width_mm <= 0) d.canvas.width_mm = 120;
    if (!isFiniteNumber(d.canvas.height_mm) || d.canvas.height_mm <= 0) d.canvas.height_mm = 90;
    if (!isFiniteNumber(d.canvas.dpi) || d.canvas.dpi <= 0) d.canvas.dpi = 300;
    if (typeof d.canvas.background !== 'string' || !d.canvas.background) d.canvas.background = '#FFFFFF';
    if (d.canvas.color_mode === undefined) d.canvas.color_mode = 'RGB';
    if (d.canvas.journal_preset_id === undefined) d.canvas.journal_preset_id = null;
    if (!isFiniteNumber(d.canvas.bleed_mm)) d.canvas.bleed_mm = 0;
    if (!Array.isArray(d.elements)) d.elements = [];
    if (!Array.isArray(d.anchors)) d.anchors = [];
    if (!Array.isArray(d.panels)) d.panels = [];
    if (!Array.isArray(d.history)) d.history = [];
    if (typeof d.id !== 'string' || !d.id) d.id = uid('doc');
    if (typeof d.title !== 'string') d.title = '';
    if (!isPlainObject(d.meta)) d.meta = {};
    const now = new Date().toISOString();
    if (typeof d.meta.created !== 'string' || !d.meta.created) d.meta.created = now;
    if (typeof d.meta.updated !== 'string' || !d.meta.updated) d.meta.updated = now;
    if (!Array.isArray(d.meta.provenance)) d.meta.provenance = [];

    // Elements: defaults + unique ids.
    const byId = new Map();
    const kept = [];
    for (const el of d.elements) {
      if (!isPlainObject(el)) throw new Error('elements 中存在非对象成员');
      if (typeof el.id !== 'string' || !el.id) el.id = uid('el');
      if (byId.has(el.id)) throw new Error('元素 id 重复: ' + el.id);
      byId.set(el.id, el);
      kept.push(el);
      if (!isPlainObject(el.transform)) el.transform = { x: 0, y: 0, w: 0, h: 0 };
      for (const k of ['x', 'y', 'w', 'h']) {
        if (!isFiniteNumber(el.transform[k])) el.transform[k] = 0;
      }
      if (!isFiniteNumber(el.z)) el.z = 0;
      if (typeof el.locked !== 'boolean') el.locked = false;
      if (typeof el.visible !== 'boolean') el.visible = true;
      if (el.parent_id === undefined) el.parent_id = null;
      if (el.parent_id !== null && typeof el.parent_id !== 'string') el.parent_id = null;
    }
    d.elements = kept;

    // Drop dangling parent_id references.
    for (const el of d.elements) {
      if (el.parent_id !== null && !byId.has(el.parent_id)) el.parent_id = null;
    }
    // Containers: drop dangling / duplicate children ids, and entries whose
    // element no longer points back at this container (two-way consistency).
    for (const el of d.elements) {
      if (isContainer(el)) {
        if (!Array.isArray(el.children)) el.children = [];
        const seenC = new Set();
        el.children = el.children.filter((cid) => {
          if (typeof cid !== 'string' || !byId.has(cid) || seenC.has(cid)) return false;
          if (byId.get(cid).parent_id !== el.id) return false;
          seenC.add(cid);
          return true;
        });
      }
    }
    // Back-reference sync: every parent_id must appear in the parent's children.
    for (const el of d.elements) {
      if (el.parent_id) {
        const p = byId.get(el.parent_id);
        if (p && isContainer(p) && Array.isArray(p.children) && p.children.indexOf(el.id) === -1) {
          p.children.push(el.id);
        }
      }
    }

    // Anchors: defaults + drop references to missing elements.
    const anchorIds = new Set();
    const keptAnchors = [];
    for (const a of d.anchors) {
      if (!isPlainObject(a)) continue;
      if (typeof a.id !== 'string' || !a.id) a.id = uid('anchor');
      if (anchorIds.has(a.id)) continue;
      anchorIds.add(a.id);
      if (typeof a.label !== 'string') a.label = '';
      if (!isPlainObject(a.bbox_norm)) a.bbox_norm = { x: 0, y: 0, w: 0, h: 0 };
      for (const k of ['x', 'y', 'w', 'h']) {
        if (!isFiniteNumber(a.bbox_norm[k])) a.bbox_norm[k] = 0;
      }
      if (!isPlainObject(a.bbox_mm)) a.bbox_mm = normToMm(a.bbox_norm, d.canvas);
      if (!Array.isArray(a.element_ids)) a.element_ids = [];
      a.element_ids = a.element_ids.filter((eid) => typeof eid === 'string' && byId.has(eid));
      keptAnchors.push(a);
    }
    d.anchors = keptAnchors;

    // Panels index: drop entries pointing at missing elements.
    const seenPanel = new Set();
    d.panels = d.panels.filter((p) => {
      if (!isPlainObject(p)) return false;
      if (typeof p.id !== 'string' || !p.id) p.id = uid('panel');
      if (typeof p.element_id !== 'string' || !byId.has(p.element_id)) return false;
      if (seenPanel.has(p.id)) return false;
      seenPanel.add(p.id);
      if (p.parent_id === undefined || (p.parent_id !== null && !byId.has(p.parent_id))) p.parent_id = null;
      return true;
    });

    // Stable ascending sort by z (render order; larger z drawn later/on top).
    d.elements.sort((a, b) => a.z - b.z);
    return d;
  }

  // ------------------------------------------------------------------
  // validate — lightweight structural check (not full JSON Schema)
  // ------------------------------------------------------------------

  function validate(doc) {
    const errors = [];
    const warnings = [];
    if (!isPlainObject(doc)) return { ok: false, errors: ['无效的文档对象'] };

    if (doc.schema_version !== SCHEMA_VERSION) errors.push('schema_version 必须为 "1.0"');
    if (!isPlainObject(doc.canvas)) {
      errors.push('缺少 canvas 对象');
    } else {
      const c = doc.canvas;
      if (!isFiniteNumber(c.width_mm) || c.width_mm <= 0) errors.push('canvas.width_mm 必须为正数');
      if (!isFiniteNumber(c.height_mm) || c.height_mm <= 0) errors.push('canvas.height_mm 必须为正数');
      if (!isFiniteNumber(c.dpi) || c.dpi <= 0) errors.push('canvas.dpi 必须为正数');
      if (typeof c.background !== 'string') errors.push('canvas.background 必须为字符串');
    }
    if (!Array.isArray(doc.elements)) errors.push('elements 必须为数组');
    if (!Array.isArray(doc.anchors)) errors.push('anchors 必须为数组');
    if (doc.panels !== undefined && !Array.isArray(doc.panels)) errors.push('panels 必须为数组');
    if (doc.history !== undefined && !Array.isArray(doc.history)) errors.push('history 必须为数组');
    if (!isPlainObject(doc.meta)) {
      errors.push('缺少 meta 对象');
    } else {
      if (typeof doc.meta.created !== 'string' || !doc.meta.created) errors.push('meta.created 必须为 ISO 时间字符串');
      if (typeof doc.meta.updated !== 'string' || !doc.meta.updated) errors.push('meta.updated 必须为 ISO 时间字符串');
    }

    const elems = Array.isArray(doc.elements) ? doc.elements : [];
    const byId = new Map();
    for (const el of elems) {
      if (!isPlainObject(el)) { errors.push('elements 中存在非对象成员'); continue; }
      if (typeof el.id !== 'string' || !ID_PATTERN.test(el.id)) {
        errors.push('元素 id 非法: ' + JSON.stringify(el.id));
        continue;
      }
      if (byId.has(el.id)) { errors.push('元素 id 重复: ' + el.id); continue; }
      byId.set(el.id, el);
    }

    for (const el of elems) {
      if (!isPlainObject(el) || typeof el.id !== 'string' || !byId.get(el.id)) continue;
      const eid = el.id;
      if (ELEMENT_TYPES.indexOf(el.type) === -1) errors.push('元素类型非法: ' + eid + ' (' + el.type + ')');
      if (!isPlainObject(el.transform)) {
        errors.push('元素缺少 transform: ' + eid);
      } else {
        for (const k of ['x', 'y', 'w', 'h']) {
          if (!isFiniteNumber(el.transform[k])) errors.push('元素 transform.' + k + ' 必须为有限数字: ' + eid);
        }
      }
      if (el.z !== undefined && !Number.isInteger(el.z)) errors.push('元素 z 必须为整数: ' + eid);
      if (el.locked !== undefined && typeof el.locked !== 'boolean') errors.push('元素 locked 必须为布尔值: ' + eid);
      if (el.visible !== undefined && typeof el.visible !== 'boolean') errors.push('元素 visible 必须为布尔值: ' + eid);
      if (el.style !== undefined && !isPlainObject(el.style)) errors.push('元素 style 必须为对象: ' + eid);
      if (el.type === 'connector') {
        const relation = el.relation;
        if (!isPlainObject(relation)) errors.push('connector 缺少 relation: ' + eid);
        else {
          const kinds = ['activate', 'inhibit', 'include', 'associate', 'sequence'];
          const directions = ['forward', 'reverse', 'both', 'none'];
          if (typeof relation.source !== 'string' || typeof relation.target !== 'string') {
            errors.push('connector source/target 必须引用语义节点 id: ' + eid);
          } else {
            for (const ref of [relation.source, relation.target]) {
              const direct = byId.has(ref) && byId.get(ref).type !== 'connector';
              const semanticCount = elems.filter((n) => n && n.type === 'group' && n.diagramNodeId === ref &&
                (n.diagramId || n.diagram_id) === (el.diagramId || el.diagram_id)).length;
              if (!direct && semanticCount !== 1) errors.push('connector 节点引用无效或重复: ' + eid + ' -> ' + ref);
            }
          }
          const kind = relation.kind;
          let direction = relation.direction === undefined
            ? (kind === 'associate' || kind === 'include' ? 'none' : 'forward') : relation.direction;
          if (direction === 'backwards') direction = 'reverse';
          if (kinds.indexOf(kind) < 0 || directions.indexOf(direction) < 0 ||
              (kind === 'associate' && direction !== 'none') ||
              (kind === 'include' && direction !== 'none') ||
              (kind !== 'associate' && kind !== 'include' && direction === 'none')) {
            errors.push('connector kind/direction 语义冲突: ' + eid);
          }
        }
      }

      if (Array.isArray(el.children)) {
        const seenC = new Set();
        for (const cid of el.children) {
          if (typeof cid !== 'string' || !byId.has(cid)) {
            errors.push('children 存在悬挂引用: ' + eid + ' -> ' + JSON.stringify(cid));
          } else if (seenC.has(cid)) {
            errors.push('children 存在重复引用: ' + eid + ' -> ' + cid);
          } else {
            seenC.add(cid);
            const child = byId.get(cid);
            if (child && child.parent_id !== eid) {
              errors.push('子元素 parent_id 与父元素 children 不一致: ' + cid);
            }
          }
        }
      }
      if (el.parent_id != null) {
        const p = byId.get(el.parent_id);
        if (!p) {
          errors.push('parent_id 指向不存在的元素: ' + eid + ' -> ' + el.parent_id);
        } else if (!isContainer(p)) {
          errors.push('parent_id 指向非 group/panel 元素: ' + eid + ' -> ' + el.parent_id);
        } else if (!Array.isArray(p.children) || p.children.indexOf(eid) === -1) {
          errors.push('父元素 children 缺少子元素反向引用: ' + eid);
        }
      }

      // panelRelative children of a panel: 0–1 ratios; overflow is a warning.
      if (isPlainObject(el.style) && el.style.panelRelative === true &&
          el.parent_id && byId.get(el.parent_id) && byId.get(el.parent_id).type === 'panel' &&
          isPlainObject(el.transform) &&
          isFiniteNumber(el.transform.x) && isFiniteNumber(el.transform.y) &&
          isFiniteNumber(el.transform.w) && isFiniteNumber(el.transform.h)) {
        const t = el.transform;
        if (t.x < 0 || t.y < 0 || t.x + t.w > 1 || t.y + t.h > 1) {
          warnings.push('PANEL_OVERFLOW: 元素 ' + eid + ' 的 panelRelative 坐标超出父面板 0–1 范围');
        }
      }
    }

    const anchorIds = new Set();
    const anchors = Array.isArray(doc.anchors) ? doc.anchors : [];
    for (const a of anchors) {
      if (!isPlainObject(a)) { errors.push('anchors 中存在非对象成员'); continue; }
      const aid = typeof a.id === 'string' && a.id ? a.id : '(缺 id)';
      if (typeof a.id !== 'string' || !a.id) {
        errors.push('锚点缺少 id');
      } else if (anchorIds.has(a.id)) {
        errors.push('锚点 id 重复: ' + a.id);
      } else {
        anchorIds.add(a.id);
      }
      if (typeof a.label !== 'string') errors.push('锚点 label 必须为字符串: ' + aid);
      if (!isPlainObject(a.bbox_norm)) {
        errors.push('锚点缺少 bbox_norm: ' + aid);
      } else {
        for (const k of ['x', 'y', 'w', 'h']) {
          if (!isFiniteNumber(a.bbox_norm[k]) || a.bbox_norm[k] < 0 || a.bbox_norm[k] > 1) {
            errors.push('锚点 bbox_norm.' + k + ' 必须为 0–1 的数字: ' + aid);
          }
        }
      }
      if (!isPlainObject(a.bbox_mm)) {
        errors.push('锚点缺少 bbox_mm: ' + aid);
      } else {
        for (const k of ['x', 'y', 'w', 'h']) {
          if (!isFiniteNumber(a.bbox_mm[k]) || a.bbox_mm[k] < 0) {
            errors.push('锚点 bbox_mm.' + k + ' 必须为非负数字: ' + aid);
          }
        }
      }
      if (Array.isArray(a.element_ids)) {
        for (const eid of a.element_ids) {
          if (!byId.has(eid)) errors.push('锚点 element_ids 存在悬挂引用: ' + aid + ' -> ' + eid);
        }
      }
    }

    if (Array.isArray(doc.panels)) {
      for (const p of doc.panels) {
        if (!isPlainObject(p)) { errors.push('panels 中存在非对象成员'); continue; }
        if (typeof p.id !== 'string' || !p.id) errors.push('面板索引缺少 id');
        if (typeof p.element_id !== 'string' || !byId.has(p.element_id)) {
          errors.push('面板索引 element_id 悬挂: ' + (p.id || '(缺 id)'));
        }
      }
    }

    if (Array.isArray(doc.history)) {
      for (const h of doc.history) {
        if (!isPlainObject(h)) { errors.push('history 中存在非对象成员'); continue; }
        if (!Number.isInteger(h.rev)) errors.push('history 记录缺少整数 rev');
        if (typeof h.ts !== 'string' || !h.ts) errors.push('history 记录缺少 ts');
        if (typeof h.label !== 'string') errors.push('history 记录缺少 label');
      }
    }

    return { ok: errors.length === 0, errors: errors.concat(warnings) };
  }

  // ------------------------------------------------------------------
  // serialize / sha256 — stable JSON, sorted keys, for hashing
  // ------------------------------------------------------------------

  function sortedCopy(v) {
    if (Array.isArray(v)) return v.map(sortedCopy);
    if (isPlainObject(v)) {
      const out = {};
      const keys = Object.keys(v).sort();
      for (const k of keys) out[k] = sortedCopy(v[k]);
      return out;
    }
    return v;
  }

  function serialize(doc) {
    requireDoc(doc);
    return JSON.stringify(sortedCopy(doc));
  }

  async function sha256(doc) {
    const json = serialize(doc);
    const subtle = global.crypto && global.crypto.subtle;
    if (!subtle) throw new Error('当前环境不支持 WebCrypto，无法计算 sha256');
    const data = new TextEncoder().encode(json);
    const digest = await subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const b of bytes) hex += (b < 16 ? '0' : '') + b.toString(16);
    return hex;
  }

  // ------------------------------------------------------------------
  // Export
  // ------------------------------------------------------------------

  const FigDoc = {
    SCHEMA_VERSION,
    create, uid,
    mmToPx, pxToMm, ptToPx, normToMm, mmToNorm,
    get, byType, children, descendants, ancestors, bbox, hitTest,
    anchorsOf, elementsInAnchor,
    addElement, removeElement, setParent, reorder, setCanvas, touch, clone,
    normalize, validate, serialize, sha256,
  };

  global.FigDoc = FigDoc;
})(typeof globalThis !== 'undefined' ? globalThis : this);
