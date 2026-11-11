/*
 * chart-render.js — ChartRender
 *
 * Shared chart-element renderer for type=chart elements
 * (see v2-server/SERVER-API.md: "此逻辑封装在 app/chart-render.js").
 *
 * The module is self-installing: on load it calls ChartRender.install(),
 * which wraps FigData.renderChartSVG in place (kernel files stay untouched)
 * so that every caller — the frozen kernel's FigRender.renderChart included
 * — transparently gets backend renders when a Backend adapter is present.
 * Editor does not need any change.
 *
 * Strategy for one chart element:
 *   1. If a Backend adapter is present and Backend.available is true, its
 *      Backend.renderChart(chartSpec, opts) result (matplotlib SVG) is used.
 *      That call is async, so FigData.renderChartSVG stays synchronous: the
 *      wrapper returns the best currently-known SVG immediately (cached
 *      backend SVG, else the original local FigData render) and kicks off
 *      the async backend render once; when it resolves the result is kept
 *      in an in-memory cache (no duplicate backend requests) and a repaint
 *      is triggered via a direct Editor.render() call — no App event, the
 *      event contract has no chart event.
 *   2. Without a backend the original FigData.renderChartSVG runs
 *      unchanged (pass-through wrapper).
 *   3. Only UnsupportedChartError.svgFragment with the controlled
 *      data-render=unsupported-preview marker may be shown as a local preview.
 *      Invalid size/data/mapping errors propagate. There is no catch-all or
 *      placeholder success fallback; explicit unbound composite panels are
 *      marked empty-layout instead of being presented as real data charts.
 *
 * Units: the original FigData.renderChartSVG returns a fragment in pixel
 * space (mm * dpi / 25.4) while FigRender.toSVG user space is millimetres,
 * so the fragment is wrapped in translate(x y) scale(25.4/dpi). Backend SVG
 * arrives as a full <svg> and is embedded as a nested <svg> positioned in
 * mm; both FigRender.renderChart and ChartRender.placeFragment handle that
 * shape, so the wrapper may return either.
 *
 * Load order: after lib/data.js + lib/render.js, before app/editor.js.
 */
(function (global) {
  'use strict';

  var MM_PER_INCH = 25.4;

  // Cache of backend render results, keyed by stable JSON of
  // {chartSpec, w, h, dpi, journal, palette}. Values:
  //   { state: "pending" | "ok" | "failed", elementId, svg?, warnings?, error? }
  var backendCache = {};

  function fail(msg) {
    throw new Error('ChartRender：' + msg);
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Deterministic key: sort object keys so property order cannot change it.
  function stableJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(stableJson(v[i]));
      return '[' + parts.join(',') + ']';
    }
    var keys = Object.keys(v).sort();
    var out = [];
    for (var k = 0; k < keys.length; k++) {
      if (typeof v[keys[k]] === 'function') continue;
      out.push(JSON.stringify(keys[k]) + ':' + stableJson(v[keys[k]]));
    }
    return '{' + out.join(',') + '}';
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmt(v) {
    var r = Math.round(Number(v) * 1000) / 1000;
    return String(r === 0 ? 0 : r);
  }

  // ------------------------------------------------------------------
  // deterministic placeholder (mm space, origin at element top-left)
  // ------------------------------------------------------------------

  function placeholderSVG(w, h, lines) {
    w = Math.max(0, w);
    h = Math.max(0, h);
    var textLines = Array.isArray(lines) && lines.length ? lines : ['图表不可用'];
    var fs = Math.min(2.6, Math.max(1.4, h / 6));
    var parts = [
      '<rect width="' + fmt(w) + '" height="' + fmt(h) + '"' +
        ' fill="#F7F7F7" stroke="#999999" stroke-width="0.3"/>',
      '<rect x="0.6" y="0.6" width="' + fmt(Math.max(0, w - 1.2)) +
        '" height="' + fmt(Math.max(0, h - 1.2)) + '" fill="none"' +
        ' stroke="#BBBBBB" stroke-width="0.25" stroke-dasharray="1 1"/>'
    ];
    for (var i = 0; i < textLines.length; i++) {
      var y = h / 2 + (i - (textLines.length - 1) / 2) * fs * 1.5;
      parts.push('<text x="' + fmt(w / 2) + '" y="' + fmt(y) +
        '" text-anchor="middle" font-family="Arial" font-size="' + fmt(fs) +
        '" fill="#666666">' + esc(textLines[i]) + '</text>');
    }
    return '<g data-render="placeholder">' + parts.join('') + '</g>';
  }

  // ------------------------------------------------------------------
  // local (FigData) rendering
  // ------------------------------------------------------------------

  function isUnsupportedPreview(svg) {
    return typeof svg === 'string' && /data-render=["']unsupported-preview["']/.test(svg) &&
      /data-real-data=["']false["']/.test(svg);
  }

  function isUnsupportedError(err) {
    return !!(err && err.name === 'UnsupportedChartError' && isUnsupportedPreview(err.svgFragment));
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

  function emptyLayoutSVG(t, w, h) {
    var svg = placeholderSVG(w, h, ['空版式 · 未绑定图表', '不会自动填图'])
      .replace('data-render="placeholder"', 'data-render="empty-layout" data-real-data="false"');
    return '<g transform="translate(' + fmt(t.x) + ' ' + fmt(t.y) + ')">' + svg + '</g>';
  }

  function localFragment(chartSpec, w, h, dpi, elementStyle) {
    if (!global.FigData || typeof global.FigData.renderChartSVG !== 'function') {
      fail('需要 FigData.renderChartSVG，无法生成真实图表');
    }
    var style = isObj(elementStyle) ? elementStyle : {};
    try {
      var frag = String(global.FigData.renderChartSVG(chartSpec, {
        width_mm: w,
        height_mm: h,
        dpi: dpi,
        fontFamily: style.fontFamily,
        fontSizePt: style.fontSizePt
      }));
      if (!frag.trim()) throw new Error('FigData 返回空 SVG，未生成真实图表');
      return frag;
    } catch (e) {
      if (isUnsupportedError(e)) return e.svgFragment;
      var type = isObj(chartSpec) && chartSpec.chartType !== undefined
        ? String(chartSpec.chartType) : '(missing)';
      var error = e instanceof Error ? e : new Error(String(e));
      error.message = 'ChartRender：图表类型「' + type + '」渲染失败（实际原因：' +
        (e && e.message ? e.message : String(e)) + '）';
      throw error;
    }
  }

  // Put a rendered chart into the document mm space at the element's box.
  function placeFragment(svg, t, w, h, dpi) {
    var s = String(svg).trim();
    if (/^<svg(\s|>)/i.test(s)) {
      // Nested full <svg>: force position and size in millimetres.
      s = s
        .replace(/\sx\s*=\s*"[^"]*"/i, '')
        .replace(/\sy\s*=\s*"[^"]*"/i, '')
        .replace(/\swidth\s*=\s*"[^"]*"/i, '')
        .replace(/\sheight\s*=\s*"[^"]*"/i, '')
        .replace(/<svg/i, '<svg x="' + fmt(t.x) + '" y="' + fmt(t.y) +
          '" width="' + fmt(w) + 'mm" height="' + fmt(h) + 'mm"');
      return s;
    }
    // px-space fragment: translate to the element box and scale px -> mm.
    // The scale factor gets extra precision: a 3-decimal rounding would
    // introduce a ~0.4% size error.
    var k = MM_PER_INCH / dpi;
    var ks = String(Math.round(k * 1e6) / 1e6);
    return '<g transform="translate(' + fmt(t.x) + ' ' + fmt(t.y) + ') scale(' +
      ks + ')">' + s + '</g>';
  }

  // ------------------------------------------------------------------
  // geometry
  // ------------------------------------------------------------------

  // Mirror of FigRender.resolveBox: when style.panelRelative is true and the
  // parent is a panel, x/y/w/h are 0-1 fractions of the parent's inner
  // padding box. One level, exactly like the frozen kernel.
  function resolveBoxMm(doc, element) {
    var t = element.transform;
    var out = {
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      w: Number(t.w) || 0,
      h: Number(t.h) || 0
    };
    var style = isObj(element.style) ? element.style : {};
    if (style.panelRelative === true && element.parent_id && isObj(doc) &&
        Array.isArray(doc.elements)) {
      var parent = null;
      for (var i = 0; i < doc.elements.length; i++) {
        var e = doc.elements[i];
        if (e && e.id === element.parent_id) { parent = e; break; }
      }
      if (parent && parent.type === 'panel' && isObj(parent.transform)) {
        var lay = isObj(parent.panelLayout) ? parent.panelLayout : {};
        var pad = lay.padding_mm === undefined ? 0 : Number(lay.padding_mm);
        if (!isFinite(pad) || pad < 0) pad = 0;
        var ix = Number(parent.transform.x) + pad;
        var iy = Number(parent.transform.y) + pad;
        var iw = Math.max(0, Number(parent.transform.w) - 2 * pad);
        var ih = Math.max(0, Number(parent.transform.h) - 2 * pad);
        out.x = ix + out.x * iw;
        out.y = iy + out.y * ih;
        out.w = out.w * iw;
        out.h = out.h * ih;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // backend adapter
  // ------------------------------------------------------------------

  function backend() {
    var b = global.Backend;
    if (b && b.available === true && typeof b.renderChart === 'function') return b;
    return null;
  }

  // Journal preset of the current document, via App.canvas(). App.canvas()
  // throws before a doc exists, so guard every access.
  function journalId() {
    try {
      if (global.App && typeof global.App.canvas === 'function') {
        var c = global.App.canvas();
        if (isObj(c) && c.journal_preset_id !== undefined) {
          return c.journal_preset_id;
        }
      }
    } catch (e) { /* no app state yet */ }
    return null;
  }

  // Cache key from what every call site can see (chart spec + render size +
  // journal/palette via App.canvas): calls originating from FigRender (no
  // doc object available) and from elementSVG dedupe onto the same entry.
  function specKey(spec, w, h, dpi) {
    var s = isObj(spec) ? spec : {};
    return stableJson([s, w, h, dpi, journalId(),
      s.paletteId === undefined ? null : s.paletteId]);
  }

  // Repaint trigger. A direct Editor.render() call only — App events are
  // restricted to the fixed contract names, which include no chart event.
  function notifyRefresh() {
    try {
      if (global.Editor && typeof global.Editor.render === 'function') {
        global.Editor.render();
      }
    } catch (e) { /* editor not ready or refresh loop guarded by cache */ }
  }

  function requestBackend(spec, key, w, h, dpi, elementId) {
    var b = backend();
    if (!b || backendCache[key]) return;
    var entry = {
      state: 'pending',
      elementId: elementId === undefined ? null : elementId
    };
    backendCache[key] = entry;
    Promise.resolve().then(function () {
      return b.renderChart(spec, {
        width_mm: w,
        height_mm: h,
        dpi: dpi,
        journal_id: journalId(),
        palette_id: isObj(spec) && spec.paletteId !== undefined ? spec.paletteId : null
      });
    }).then(function (res) {
      var svg = res && res.svg ? String(res.svg) : '';
      if (!svg.trim()) throw new Error('后端返回了空的 SVG');
      entry.state = 'ok';
      entry.svg = svg;
      entry.warnings = res && res.warnings ? res.warnings : [];
      notifyRefresh();
    }).catch(function (err) {
      // Negative cache: do not retry the same spec on every repaint.
      entry.state = 'failed';
      entry.error = err && err.message ? String(err.message) : String(err);
      notifyRefresh();
    });
  }

  // ------------------------------------------------------------------
  // public entry points
  // ------------------------------------------------------------------

  function resolveInput(doc, element, opts) {
    if (!isObj(doc)) fail('doc 必须是 FigureDocument 对象');
    if (!isObj(element)) fail('element 必须是元素对象');
    if (element.type !== 'chart') {
      fail('elementSVG 仅支持 type=chart 元素，收到：' + esc(element.type));
    }
    if (!isObj(element.transform)) fail('元素缺少 transform：' + esc(element.id));
    var dpi = opts && typeof opts.dpi === 'number' && isFinite(opts.dpi) && opts.dpi > 0
      ? opts.dpi
      : (isObj(doc.canvas) && typeof doc.canvas.dpi === 'number' &&
         isFinite(doc.canvas.dpi) && doc.canvas.dpi > 0 ? doc.canvas.dpi : 300);
    var box = resolveBoxMm(doc, element);
    return {
      t: box,
      w: Math.max(0, box.w),
      h: Math.max(0, box.h),
      dpi: dpi
    };
  }

  // ChartRender.elementSVG(doc, element, {dpi, useBackend}) -> string
  // Synchronous SVG fragment for one chart element, positioned in the
  // document's mm space. See file header for the backend/preview strategy.
  function elementSVG(doc, element, opts) {
    var g = resolveInput(doc, element, opts);
    if (element.visible === false) return '';
    if (!(g.w > 0) || !(g.h > 0)) fail('图表 width_mm/height_mm 必须是正数');
    if (isEmptyLayoutChart(element.chart)) return emptyLayoutSVG(g.t, g.w, g.h);

    var key = specKey(element.chart, g.w, g.h, g.dpi);
    var useBackend = !(opts && opts.useBackend === false);

    // 1. A resolved backend SVG wins whenever we have one.
    if (useBackend && backendCache[key] && backendCache[key].state === 'ok') {
      try {
        return placeFragment(backendCache[key].svg, g.t, g.w, g.h, g.dpi);
      } catch (e) {
        delete backendCache[key]; // malformed backend output, re-render locally
      }
    }

    // 2. Kick off (or skip if already pending/failed) the async backend call.
    if (useBackend) requestBackend(element.chart, key, g.w, g.h, g.dpi, element.id);

    // 3. Real local SVG or explicitly marked unsupported-preview. Other errors throw.
    return placeFragment(localFragment(element.chart, g.w, g.h, g.dpi, element.style),
      g.t, g.w, g.h, g.dpi);
  }

  // ChartRender.elementSVGAsync(doc, element, {dpi}) -> Promise<{svg, source, warnings}>
  // Awaitable variant for callers that can wait (e.g. previews). Supported
  // local charts may still be used when a backend fails; local data/mapping
  // errors reject. Unsupported previews are never labelled source=local.
  function elementSVGAsync(doc, element, opts) {
    var g = resolveInput(doc, element, opts);
    if (isEmptyLayoutChart(element.chart)) {
      return Promise.resolve({ svg: emptyLayoutSVG(g.t, g.w, g.h),
        source: 'empty-layout', warnings: ['仅空版式，未绑定图表，不会自动填图'], preview: true });
    }
    function localPack() {
      var frag = localFragment(element.chart, g.w, g.h, g.dpi, element.style);
      if (isUnsupportedPreview(frag)) {
        return { svg: placeFragment(frag, g.t, g.w, g.h, g.dpi),
          source: 'unsupported-preview', preview: true,
          warnings: ['暂不支持真实生成：仅示意，禁止应用与成功导出'] };
      }
      return { svg: placeFragment(frag, g.t, g.w, g.h, g.dpi), source: 'local', warnings: [] };
    }
    var b = !(opts && opts.useBackend === false) ? backend() : null;
    if (!b) return Promise.resolve().then(localPack);
    var key = specKey(element.chart, g.w, g.h, g.dpi);
    var spec = element.chart || {};
    return Promise.resolve().then(function () {
      return b.renderChart(spec, {
        width_mm: g.w,
        height_mm: g.h,
        dpi: g.dpi,
        journal_id: journalId(),
        palette_id: isObj(spec) && spec.paletteId !== undefined ? spec.paletteId : null
      });
    }).then(function (res) {
      var svg = res && res.svg ? String(res.svg) : '';
      if (!svg.trim()) throw new Error('后端返回了空的 SVG');
      backendCache[key] = { state: 'ok', svg: svg, warnings: res.warnings || [] };
      return { svg: placeFragment(svg, g.t, g.w, g.h, g.dpi), source: 'backend',
               warnings: res.warnings || [] };
    }).catch(function (err) {
      var pack = localPack();
      pack.warnings = (pack.warnings || []).concat([
        '后端渲染失败：' + (err && err.message ? err.message : String(err))]);
      return pack;
    });
  }

  // ChartRender.clearCache(elementId?) — drop backend cache so the next
  // render retries the backend (e.g. after the backend becomes available).
  // Entries created by the wrapped FigData.renderChartSVG carry no element
  // id; clearCache() without an argument drops the whole cache.
  function clearCache(elementId) {
    if (elementId === undefined || elementId === null) {
      backendCache = {};
      return;
    }
    var keys = Object.keys(backendCache);
    for (var i = 0; i < keys.length; i++) {
      if (backendCache[keys[i]].elementId === elementId) {
        delete backendCache[keys[i]];
      }
    }
  }

  // ------------------------------------------------------------------
  // self-install
  // ------------------------------------------------------------------

  // ChartRender.install() -> boolean
  // Wraps FigData.renderChartSVG in place. With a Backend adapter: a cached
  // backend SVG wins; otherwise one async Backend.renderChart request is
  // kicked off (guarded by the in-memory cache) and the original local
  // render is returned for this call; on backend failure the original
  // implementation is used. Without a backend the wrapper is a pass-through.
  // Returns true when the wrapper was installed by this call.
  function install() {
    var fd = global.FigData;
    if (!fd || typeof fd.renderChartSVG !== 'function') return false;
    var original = fd.renderChartSVG;
    if (original.__chartRenderWrapped) return false; // already installed
    var wrapped = function (chartSpec, opts) {
      if (!backend()) return original(chartSpec, opts);
      var w = opts && isFinite(Number(opts.width_mm)) ? Number(opts.width_mm) : 0;
      var h = opts && isFinite(Number(opts.height_mm)) ? Number(opts.height_mm) : 0;
      var dpi = opts && isFinite(Number(opts.dpi)) && Number(opts.dpi) > 0
        ? Number(opts.dpi) : 300;
      var key = specKey(chartSpec, w, h, dpi);
      var hit = backendCache[key];
      if (hit && hit.state === 'ok') {
        // Backend SVG is a full <svg>; FigRender.renderChart and
        // placeFragment embed it as a nested <svg> in mm space.
        return String(hit.svg);
      }
      if (!hit) requestBackend(chartSpec, key, w, h, dpi, null);
      // This call keeps the synchronous local answer; the backend SVG takes
      // over from the next repaint (notifyRefresh -> Editor.render()).
      return original(chartSpec, opts);
    };
    wrapped.__chartRenderWrapped = true;
    fd.renderChartSVG = wrapped;
    return true;
  }

  global.ChartRender = {
    elementSVG: elementSVG,
    elementSVGAsync: elementSVGAsync,
    resolveBoxMm: resolveBoxMm,
    placeholderSVG: placeholderSVG,
    clearCache: clearCache,
    install: install
  };

  // Self-install so the wrapper is active as soon as the kernel is loaded.
  // Call ChartRender.install() again manually if FigData arrives later.
  install();
})(typeof globalThis !== 'undefined' ? globalThis : this);
