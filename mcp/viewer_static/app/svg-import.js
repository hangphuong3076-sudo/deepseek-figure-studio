/*
 * svg-import.js — SVG 可编辑导入（安全解析 → FigDoc 元素）
 *
 * SvgImport.convert(svgText)          解析 SVG 文本，返回
 *                                     { elements, warnings, size_mm, skipped }
 *                                     elements 为扁平数组：group 在其 children
 *                                     之前，子元素通过 parent_id 关联，坐标一律
 *                                     为毫米（viewBox / 物理单位换算后烘焙）。
 * SvgImport.fitToCanvas(els, canvas)  内容超出画布时整体等比缩放（原地修改），
 *                                     返回缩放系数（1 = 未缩放）。
 *
 * 安全边界：使用 DOMParser('image/svg+xml') 解析，脚本、事件属性、外部引用、
 * foreignObject/style 等在解析副本上移除，从不挂载到页面 DOM，不执行任何
 * SVG 内容。仅支持内嵌 data: 图片与同文档 #id 引用；渐变简化为单色，
 * 滤镜/图案/裁剪等忽略并在 warnings 中提示。不支持的特性不静默。
 */
(function (global) {
  'use strict';

  var EPS = 1e-9;
  var MM_PER_PX = 25.4 / 96;
  var PT_PER_MM = 72 / 25.4;
  var PX_PER_UNIT = {
    '': 1, px: 1, pt: 96 / 72, pc: 16,
    mm: 96 / 25.4, cm: 960 / 25.4, in: 96, q: 96 / 101.6
  };
  var ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
  var MAX_ELEMENTS = 1500;

  var SKIP_TAGS = {
    defs: 1, title: 1, desc: 1, metadata: 1, symbol: 1, marker: 1,
    clippath: 1, mask: 1, pattern: 1, filter: 1,
    lineargradient: 1, radialgradient: 1
  };
  var DROP_TAGS = { script: 1, foreignobject: 1, style: 1 };
  var SHAPE_TAGS = {
    rect: 1, circle: 1, ellipse: 1, line: 1,
    polyline: 1, polygon: 1, path: 1, text: 1, image: 1
  };

  function fail(msg) {
    throw new Error('SvgImport：' + msg);
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function r3(n) {
    return Math.round(n * 1000) / 1000;
  }

  function f3(n) {
    return String(r3(n));
  }

  // ------------------------------------------------------------------
  // 2D 仿射矩阵 {a,b,c,d,e,f}：x' = a·x + c·y + e; y' = b·x + d·y + f
  // ------------------------------------------------------------------

  function mat(a, b, c, d, e, f) {
    return { a: a, b: b, c: c, d: d, e: e, f: f };
  }

  function identity() {
    return mat(1, 0, 0, 1, 0, 0);
  }

  function mul(m, n) { // 先应用 n，再应用 m
    return {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      e: m.a * n.e + m.c * n.f + m.e,
      f: m.b * n.e + m.d * n.f + m.f
    };
  }

  function applyM(m, x, y) {
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }

  function matScale(m) { // 面积守恒的近似缩放系数（user 单位 → 毫米）
    return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  }

  function axisAligned(m) {
    return Math.abs(m.b) < EPS && Math.abs(m.c) < EPS;
  }

  function parseTransformAttr(str, warn) {
    var out = identity();
    if (!str) return out;
    var re = /([a-zA-Z]+)\s*\(([^\)]*)\)/g;
    var t;
    while ((t = re.exec(str))) {
      var name = t[1].toLowerCase();
      var args = t[2].trim().split(/[\s,]+/).filter(function (s) { return s.length; })
        .map(Number);
      if (!args.length || args.some(function (v) { return !isFinite(v); })) {
        warn('transform 参数非法已忽略');
        continue;
      }
      if (name === 'translate') {
        out = mul(out, mat(1, 0, 0, 1, args[0], args[1] || 0));
      } else if (name === 'scale') {
        out = mul(out, mat(args[0], 0, 0, args.length > 1 ? args[1] : args[0], 0, 0));
      } else if (name === 'rotate') {
        var rad = args[0] * Math.PI / 180;
        var co = Math.cos(rad), si = Math.sin(rad);
        var rot = mat(co, si, -si, co, 0, 0);
        if (args.length > 2) {
          rot = mul(mat(1, 0, 0, 1, args[1], args[2]),
            mul(rot, mat(1, 0, 0, 1, -args[1], -args[2])));
        }
        out = mul(out, rot);
      } else if (name === 'matrix' && args.length >= 6) {
        out = mul(out, mat(args[0], args[1], args[2], args[3], args[4], args[5]));
      } else if (name === 'skewx') {
        out = mul(out, mat(1, 0, Math.tan(args[0] * Math.PI / 180), 0, 0, 0));
      } else if (name === 'skewy') {
        out = mul(out, mat(1, Math.tan(args[0] * Math.PI / 180), 0, 1, 0, 0));
      } else {
        warn('不支持的 transform "' + name + '" 已忽略');
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 长度解析（结果为当前 user 单位的 px 值）
  // ------------------------------------------------------------------

  function lenPx(str, state, dim) {
    if (str === null || str === undefined) return null;
    var m = /^([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*([a-z%]*)$/i.exec(String(str).trim());
    if (!m) return null;
    var v = Number(m[1]), u = m[2].toLowerCase();
    if (u === '%') {
      var vp = state.viewport || { w: 100, h: 100 };
      if (dim === 'h') return v / 100 * vp.w;
      if (dim === 'v') return v / 100 * vp.h;
      return v / 100 * Math.sqrt(vp.w * vp.h);
    }
    if (u === 'em') return v * (state.fontSizePx || 16);
    if (u === 'ex') return v * (state.fontSizePx || 16) / 2;
    var k = PX_PER_UNIT[u];
    return k === undefined ? null : v * k;
  }

  function fontPx(str, state) { // font-size 的 % 相对父级字号
    if (str === null || str === undefined) return null;
    var m = /^([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*([a-z%]*)$/i.exec(String(str).trim());
    if (!m) return null;
    var v = Number(m[1]), u = m[2].toLowerCase();
    if (u === '%') return v / 100 * (state.fontSizePx || 16);
    if (u === 'em') return v * (state.fontSizePx || 16);
    if (u === 'ex') return v * (state.fontSizePx || 16) / 2;
    var k = PX_PER_UNIT[u];
    return k === undefined ? null : v * k;
  }

  // ------------------------------------------------------------------
  // path d 解析：绝对化 + 圆弧转三次贝塞尔
  // 段格式 {c:'M'|'L'|'C'|'Q', pts:[[x,y],...]} 或 {c:'Z'}
  // ------------------------------------------------------------------

  function parsePathToSegs(d, warn) {
    var segs = [];
    var s = String(d || '');
    var i = 0, n = s.length;

    function isSep(c) { return c === ' ' || c === ',' || c === '\t' || c === '\n' || c === '\r'; }
    function isCmd(c) { return /[MmLlHhVvCcSsQqTtAaZz]/.test(c); }
    function skipSep() { while (i < n && isSep(s[i])) i++; }
    function readNum() {
      skipSep();
      var start = i;
      if (s[i] === '+' || s[i] === '-') i++;
      while (i < n && s[i] >= '0' && s[i] <= '9') i++;
      if (s[i] === '.') { i++; while (i < n && s[i] >= '0' && s[i] <= '9') i++; }
      if (s[i] === 'e' || s[i] === 'E') {
        i++;
        if (s[i] === '+' || s[i] === '-') i++;
        while (i < n && s[i] >= '0' && s[i] <= '9') i++;
      }
      if (i === start) return null;
      var v = Number(s.slice(start, i));
      return isFinite(v) ? v : null;
    }
    function readFlag() {
      skipSep();
      if (s[i] === '0') { i++; return 0; }
      if (s[i] === '1') { i++; return 1; }
      return null;
    }

    var cur = { x: 0, y: 0 }, startP = null;
    var lastC = null, lastQ = null, prevCmd = '';

    function arcToBeziers(rx, ry, phiDeg, fa, fs, p2) {
      if (!rx || !ry) {
        segs.push({ c: 'L', pts: [[p2.x, p2.y]] });
        return;
      }
      rx = Math.abs(rx); ry = Math.abs(ry);
      var phi = phiDeg * Math.PI / 180;
      var cosP = Math.cos(phi), sinP = Math.sin(phi);
      var dx2 = (cur.x - p2.x) / 2, dy2 = (cur.y - p2.y) / 2;
      var x1p = cosP * dx2 + sinP * dy2;
      var y1p = -sinP * dx2 + cosP * dy2;
      var lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
      if (lam > 1) {
        var sq = Math.sqrt(lam);
        rx *= sq; ry *= sq;
      }
      var sign = (fa !== fs) ? 1 : -1;
      var num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
      var den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
      var co = sign * Math.sqrt(Math.max(0, den > 0 ? num / den : 0));
      var cxp = co * rx * y1p / ry;
      var cyp = -co * ry * x1p / rx;
      var cx = cosP * cxp - sinP * cyp + (cur.x + p2.x) / 2;
      var cy = sinP * cxp + cosP * cyp + (cur.y + p2.y) / 2;
      function ang(ux, uy, vx, vy) {
        var dot = ux * vx + uy * vy;
        var len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
        var a = Math.acos(Math.min(1, Math.max(-1, len ? dot / len : 1)));
        if (ux * vy - uy * vx < 0) a = -a;
        return a;
      }
      var th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
      var dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry,
        (-x1p - cxp) / rx, (-y1p - cyp) / ry);
      if (!fs && dth > 0) dth -= 2 * Math.PI;
      if (fs && dth < 0) dth += 2 * Math.PI;
      var segN = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
      var delta = dth / segN;
      var k = 4 / 3 * Math.tan(delta / 4);
      function pt(a) {
        return {
          x: cx + rx * Math.cos(a) * cosP - ry * Math.sin(a) * sinP,
          y: cy + rx * Math.cos(a) * sinP + ry * Math.sin(a) * cosP
        };
      }
      function der(a) {
        return {
          x: -rx * Math.sin(a) * cosP - ry * Math.cos(a) * sinP,
          y: -rx * Math.sin(a) * sinP + ry * Math.cos(a) * cosP
        };
      }
      var th = th1, p0 = pt(th), d0 = der(th);
      for (var j = 0; j < segN; j++) {
        var th2 = th + delta;
        var p3 = pt(th2), d3 = der(th2);
        segs.push({
          c: 'C', pts: [
            [p0.x + k * d0.x, p0.y + k * d0.y],
            [p3.x - k * d3.x, p3.y - k * d3.y],
            [p3.x, p3.y]
          ]
        });
        p0 = p3; d0 = d3; th = th2;
      }
    }

    var cmd;
    while ((cmd = (skipSep(), i < n && isCmd(s[i]) ? s[i++] : null))) {
      var rel = cmd >= 'a' && cmd <= 'z';
      var C = cmd.toUpperCase();
      if (C === 'Z') {
        if (startP) {
          segs.push({ c: 'Z' });
          cur = { x: startP.x, y: startP.y };
        }
        prevCmd = 'Z';
        continue;
      }
      var first = true;
      for (;;) {
        skipSep();
        if (i < n && isCmd(s[i])) break; // 隐式重复结束：下一个命令
        if (C === 'M' || C === 'L') {
          var x = readNum(), y = readNum();
          if (x === null || y === null) break;
          if (rel) { x += cur.x; y += cur.y; }
          if (C === 'M' && first) {
            segs.push({ c: 'M', pts: [[x, y]] });
            startP = { x: x, y: y };
          } else {
            segs.push({ c: 'L', pts: [[x, y]] });
          }
          cur = { x: x, y: y };
        } else if (C === 'H') {
          var hx = readNum();
          if (hx === null) break;
          if (rel) hx += cur.x;
          segs.push({ c: 'L', pts: [[hx, cur.y]] });
          cur = { x: hx, y: cur.y };
        } else if (C === 'V') {
          var vy = readNum();
          if (vy === null) break;
          if (rel) vy += cur.y;
          segs.push({ c: 'L', pts: [[cur.x, vy]] });
          cur = { x: cur.x, y: vy };
        } else if (C === 'C') {
          var c1x = readNum(), c1y = readNum(), c2x = readNum(), c2y = readNum();
          var ex = readNum(), ey = readNum();
          if ([c1x, c1y, c2x, c2y, ex, ey].some(function (v) { return v === null; })) break;
          if (rel) {
            c1x += cur.x; c1y += cur.y; c2x += cur.x; c2y += cur.y; ex += cur.x; ey += cur.y;
          }
          segs.push({ c: 'C', pts: [[c1x, c1y], [c2x, c2y], [ex, ey]] });
          lastC = { x: c2x, y: c2y };
          cur = { x: ex, y: ey };
        } else if (C === 'S') {
          var s2x = readNum(), s2y = readNum(), s3x = readNum(), s3y = readNum();
          if ([s2x, s2y, s3x, s3y].some(function (v) { return v === null; })) break;
          var r1 = (prevCmd === 'C' || prevCmd === 'S') && lastC
            ? { x: 2 * cur.x - lastC.x, y: 2 * cur.y - lastC.y } : { x: cur.x, y: cur.y };
          if (rel) { s2x += cur.x; s2y += cur.y; s3x += cur.x; s3y += cur.y; }
          segs.push({ c: 'C', pts: [[r1.x, r1.y], [s2x, s2y], [s3x, s3y]] });
          lastC = { x: s2x, y: s2y };
          cur = { x: s3x, y: s3y };
        } else if (C === 'Q') {
          var qx = readNum(), qy = readNum(), qex = readNum(), qey = readNum();
          if ([qx, qy, qex, qey].some(function (v) { return v === null; })) break;
          if (rel) { qx += cur.x; qy += cur.y; qex += cur.x; qey += cur.y; }
          segs.push({ c: 'Q', pts: [[qx, qy], [qex, qey]] });
          lastQ = { x: qx, y: qy };
          cur = { x: qex, y: qey };
        } else if (C === 'T') {
          var tex = readNum(), tey = readNum();
          if (tex === null || tey === null) break;
          var tq = (prevCmd === 'Q' || prevCmd === 'T') && lastQ
            ? { x: 2 * cur.x - lastQ.x, y: 2 * cur.y - lastQ.y } : { x: cur.x, y: cur.y };
          if (rel) { tex += cur.x; tey += cur.y; }
          segs.push({ c: 'Q', pts: [[tq.x, tq.y], [tex, tey]] });
          lastQ = { x: tq.x, y: tq.y };
          cur = { x: tex, y: tey };
        } else if (C === 'A') {
          var arx = readNum(), ary = readNum(), rot = readNum();
          var fa = readFlag(), fs2 = readFlag();
          var aex = readNum(), aey = readNum();
          if ([arx, ary, rot, aex, aey].some(function (v) { return v === null; }) ||
            fa === null || fs2 === null) break;
          var target = rel ? { x: cur.x + aex, y: cur.y + aey } : { x: aex, y: aey };
          arcToBeziers(arx, ary, rot, fa, fs2, target);
          cur = target;
        } else {
          break;
        }
        first = false;
      }
      prevCmd = C;
    }
    if (!segs.length) warn('path 数据无法解析已跳过');
    return segs;
  }

  function transformSegs(segs, m) {
    segs.forEach(function (sg) {
      if (!sg.pts) return;
      sg.pts.forEach(function (p) {
        var q = applyM(m, p[0], p[1]);
        p[0] = q.x; p[1] = q.y;
      });
    });
    return segs;
  }

  function segsBBox(segs) {
    var box = null;
    segs.forEach(function (sg) {
      if (!sg.pts) return;
      sg.pts.forEach(function (p) {
        if (!isNum(p[0]) || !isNum(p[1])) return;
        if (!box) box = { x: p[0], y: p[1], w: 0, h: 0 };
        else {
          box.x = Math.min(box.x, p[0]);
          box.y = Math.min(box.y, p[1]);
        }
      });
    });
    if (!box) return null;
    segs.forEach(function (sg) {
      if (!sg.pts) return;
      sg.pts.forEach(function (p) {
        box.w = Math.max(box.w, p[0] - box.x);
        box.h = Math.max(box.h, p[1] - box.y);
      });
    });
    return box;
  }

  function segsToPathData(segs, ox, oy) {
    var out = [];
    segs.forEach(function (sg) {
      if (sg.c === 'Z') { out.push('Z'); return; }
      out.push(sg.c + ' ' + sg.pts.map(function (p) {
        return f3(p[0] - ox) + ' ' + f3(p[1] - oy);
      }).join(' '));
    });
    return out.join(' ');
  }

  // ------------------------------------------------------------------
  // 样式继承（呈现属性 + style 属性白名单）
  // ------------------------------------------------------------------

  var INHERITED = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray',
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'color'];
  var STYLE_WHITELIST = INHERITED.concat(['opacity', 'fill-opacity', 'stroke-opacity']);

  function initialState() {
    return {
      fill: '#000000',
      stroke: 'none',
      strokeWidth: 1,
      dash: null,
      fontFamily: 'Arial',
      fontSizePx: 16,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textAnchor: 'start',
      color: '#000000',
      viewport: { w: 100, h: 100 }
    };
  }

  function resolvePaint(value, ctx) {
    var v = String(value).trim();
    if (v === 'inherit' || v === '') return null; // 保持继承值
    if (v === 'currentColor') return 'currentColor';
    var m = /^url\(\s*['"]?#([A-Za-z0-9_.:-]+)['"]?\s*\)(?:\s+[^;]+)?$/i.exec(v);
    if (m) {
      var target = ctx.byId[m[1]];
      var tag = target ? String(target.localName).toLowerCase() : '';
      if (tag === 'lineargradient' || tag === 'radialgradient') {
        ctx.warn('渐变填充已简化为单色');
        return gradientMidColor(target, ctx) || 'none';
      }
      ctx.warn('图案/纹理引用已忽略');
      return 'none';
    }
    if (/url\s*\(/i.test(v) || /\\[0-9a-f]{1,6}\s*/i.test(v)) {
      ctx.warn('外部/非法 paint 引用已替换为 none');
      return 'none';
    }
    return v;
  }

  function gradientMidColor(g, ctx) {
    var seen = arguments[2] || {};
    var idAttr = g.getAttribute && g.getAttribute('id');
    if (idAttr) {
      if (seen[idAttr]) return null;
      seen[idAttr] = true;
    }
    var stops = [].slice.call(g.getElementsByTagName('stop'));
    if (!stops.length) {
      var href = g.getAttribute('href') || g.getAttribute('xlink:href');
      if (href && href.charAt(0) === '#') {
        var base = ctx.byId[href.slice(1)];
        if (base) return gradientMidColor(base, ctx, seen);
      }
      return null;
    }
    var mid = stops[Math.floor(stops.length / 2)];
    var col = mid.getAttribute('stop-color');
    if (!col) {
      var st = mid.getAttribute('style') || '';
      var m = /(?:^|;)\s*stop-color\s*:\s*([^;]+)/.exec(st);
      col = m ? m[1].trim() : '';
    }
    return col && col !== 'none' ? col : null;
  }

  function readStyles(el, state, ctx) {
    var s = Object.assign({}, state);
    function setProp(name, value) {
      switch (name) {
        case 'fill': case 'stroke': {
          var col = resolvePaint(value, ctx);
          if (col === 'currentColor') col = s.color || '#000000';
          if (col !== null) s[name] = col;
          break;
        }
        case 'stroke-width': {
          var w = lenPx(value, s, 'r');
          if (w !== null && w >= 0) s.strokeWidth = w;
          break;
        }
        case 'stroke-dasharray': {
          var v = String(value).trim();
          s.dash = (v && v !== 'none') ? v : null;
          break;
        }
        case 'font-family':
          s.fontFamily = value;
          break;
        case 'font-size': {
          var fs = fontPx(value, s);
          if (fs !== null && fs > 0) s.fontSizePx = fs;
          break;
        }
        case 'font-weight':
          s.fontWeight = String(value).trim() || 'normal';
          break;
        case 'font-style':
          s.fontStyle = String(value).trim() || 'normal';
          break;
        case 'text-anchor':
          s.textAnchor = String(value).trim();
          break;
        case 'color': {
          var c = resolvePaint(value, ctx);
          if (c && c !== 'none' && c !== null) s.color = c;
          break;
        }
      }
    }
    INHERITED.forEach(function (name) {
      var v = el.getAttribute && el.getAttribute(name);
      if (v !== null && v !== undefined) setProp(name, v);
    });
    var styleAttr = el.getAttribute && el.getAttribute('style');
    if (styleAttr) {
      String(styleAttr).split(';').forEach(function (decl) {
        var parts = decl.split(':');
        if (parts.length < 2) return;
        var name = parts[0].trim().toLowerCase();
        var value = parts.slice(1).join(':').trim();
        if (STYLE_WHITELIST.indexOf(name) >= 0 && value) setProp(name, value);
      });
    }
    return s;
  }

  function num(v, d) {
    if (v === null || v === undefined || v === '') return d;
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function opacityOf(el) {
    var op = num(el.getAttribute('opacity'), 1);
    var fo = num(el.getAttribute('fill-opacity'), 1);
    var so = num(el.getAttribute('stroke-opacity'), 1);
    var v = op * fo * so;
    return isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  }

  function buildStyle(state, m, kind, el, ctx) {
    var sf = matScale(m);
    var st = {};
    if (kind === 'text') {
      st.fill = state.fill && state.fill !== 'none' ? state.fill : '#000000';
      st.fontSizePt = r3(Math.max(0.1, state.fontSizePx * sf * PT_PER_MM));
      st.fontFamily = state.fontFamily || 'Arial';
      st.fontWeight = state.fontWeight || 'normal';
      st.fontStyle = state.fontStyle || 'normal';
      st.textAnchor = ['start', 'middle', 'end'].indexOf(state.textAnchor) >= 0
        ? state.textAnchor : 'start';
    } else {
      st.fill = state.fill || 'none';
      st.stroke = state.stroke && state.stroke !== 'none' ? state.stroke : 'none';
      if (st.stroke !== 'none') {
        st.strokeWidthPt = r3(Math.max(0.01, state.strokeWidth * sf * PT_PER_MM));
        if (state.dash) {
          st.dash = state.dash.split(/[\s,]+/).filter(function (v) { return v.length; })
            .map(function (v) { return f3(num(v, 0) * sf); }).join(' ');
        }
      }
    }
    if (el) {
      var op = opacityOf(el);
      if (op < 1) st.opacity = r3(op);
      if (kind !== 'text') {
        var head = null;
        if (el.getAttribute('marker-end') && el.getAttribute('marker-end') !== 'none') head = 'end';
        if (el.getAttribute('marker-start') && el.getAttribute('marker-start') !== 'none') {
          head = head === 'end' ? 'both' : 'start';
        }
        if (head && kind !== 'rect' && kind !== 'ellipse') st.arrowHead = head;
      }
    }
    return st;
  }

  // ------------------------------------------------------------------
  // 元素构造
  // ------------------------------------------------------------------

  function assignId(el, ctx) {
    var raw = el.getAttribute && el.getAttribute('id');
    var base = raw && ID_PATTERN.test(raw) ? 'svg-' + raw : 'svg-el-' + (++ctx.seq);
    var id = base, k = 2;
    while (ctx.usedIds[id]) id = base + '-' + (k++);
    ctx.usedIds[id] = true;
    return id;
  }

  function shapeEl(el, type, box, style, ctx, extra) {
    var t = box;
    if (![t.x, t.y, t.w, t.h].every(isNum)) {
      ctx.skip('元素坐标非法已跳过');
      return null;
    }
    var out = {
      id: assignId(el, ctx),
      type: type,
      transform: { x: r3(t.x), y: r3(t.y), w: r3(t.w), h: r3(t.h), rotation: 0 },
      style: style
    };
    if (el.getAttribute && el.getAttribute('id') && ID_PATTERN.test(el.getAttribute('id'))) {
      out.name = el.getAttribute('id');
    }
    if (extra) Object.assign(out, extra);
    return out;
  }

  function segsToPathEl(el, segs, state, m, ctx) {
    var box = segsBBox(segs);
    if (!box || box.w <= 0 || box.h <= 0) {
      if (box && (box.w > 0 || box.h > 0)) {
        // 单方向路径（水平/垂直线段）：给一个极小高度便于选中
        box.w = Math.max(box.w, 0.01);
        box.h = Math.max(box.h, 0.01);
      } else {
        ctx.skip('路径无有效坐标已跳过');
        return null;
      }
    }
    var style = buildStyle(state, m, 'path', el, ctx);
    return shapeEl(el, 'path',
      { x: box.x, y: box.y, w: box.w, h: box.h }, style, ctx,
      { pathData: segsToPathData(segs, box.x, box.y) });
  }

  function convertRect(el, state, m, ctx) {
    var x = lenPx(el.getAttribute('x'), state, 'h') || 0;
    var y = lenPx(el.getAttribute('y'), state, 'v') || 0;
    var w = lenPx(el.getAttribute('width'), state, 'h');
    var h = lenPx(el.getAttribute('height'), state, 'v');
    if (w === null || h === null || w <= 0 || h <= 0) {
      ctx.skip('矩形缺少尺寸已跳过');
      return null;
    }
    var rx = lenPx(el.getAttribute('rx'), state, 'h');
    var ry = lenPx(el.getAttribute('ry'), state, 'v');
    if (rx === null && ry === null) { rx = 0; ry = 0; }
    else if (rx === null) rx = ry;
    else if (ry === null) ry = rx;
    rx = Math.max(0, Math.min(rx, w / 2));
    ry = Math.max(0, Math.min(ry, h / 2));
    var style = buildStyle(state, m, 'rect', el, ctx);
    if (axisAligned(m) && m.a > 0 && m.d > 0) {
      if (rx > 0 || ry > 0) style.cornerRadiusMm = r3(Math.max(m.a * rx, m.d * ry));
      return shapeEl(el, 'rect',
        { x: m.a * x + m.e, y: m.d * y + m.f, w: m.a * w, h: m.d * h }, style, ctx);
    }
    if (rx > 0 || ry > 0) ctx.warn('旋转/斜切矩形的圆角已简化');
    var corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      .map(function (p) { var q = applyM(m, p[0], p[1]); return [q.x, q.y]; });
    var segs = [{ c: 'M', pts: [corners[0]] }];
    for (var i = 1; i < 4; i++) segs.push({ c: 'L', pts: [corners[i]] });
    segs.push({ c: 'Z' });
    return segsToPathEl(el, segs, state, identity(), ctx); // 角点已含矩阵
  }

  function ellipseSegs(cx, cy, rx, ry) {
    var k = 0.552284749831;
    var kx = rx * k, ky = ry * k;
    var p0 = [cx + rx, cy], p1 = [cx, cy + ry], p2 = [cx - rx, cy], p3 = [cx, cy - ry];
    return [
      { c: 'M', pts: [p0] },
      { c: 'C', pts: [[cx + rx, cy + ky], [cx + kx, cy + ry], p1] },
      { c: 'C', pts: [[cx - kx, cy + ry], [cx - rx, cy + ky], p2] },
      { c: 'C', pts: [[cx - rx, cy - ky], [cx - kx, cy - ry], p3] },
      { c: 'C', pts: [[cx + kx, cy - ry], [cx + rx, cy - ky], p0] },
      { c: 'Z' }
    ];
  }

  function convertCircleEllipse(el, state, m, ctx, isCircle) {
    var cx = lenPx(el.getAttribute('cx'), state, 'h') || 0;
    var cy = lenPx(el.getAttribute('cy'), state, 'v') || 0;
    var rx, ry;
    if (isCircle) {
      rx = ry = lenPx(el.getAttribute('r'), state, 'r');
    } else {
      rx = lenPx(el.getAttribute('rx'), state, 'h');
      ry = lenPx(el.getAttribute('ry'), state, 'v');
    }
    if (rx === null || ry === null || rx <= 0 || ry <= 0) {
      ctx.skip('椭圆缺少半径已跳过');
      return null;
    }
    var style = buildStyle(state, m, 'ellipse', el, ctx);
    if (axisAligned(m)) {
      var cx2 = m.a * cx + m.e, cy2 = m.d * cy + m.f;
      var rx2 = Math.abs(m.a) * rx, ry2 = Math.abs(m.d) * ry;
      return shapeEl(el, 'ellipse',
        { x: cx2 - rx2, y: cy2 - ry2, w: 2 * rx2, h: 2 * ry2 }, style, ctx);
    }
    return segsToPathEl(el, transformSegs(ellipseSegs(cx, cy, rx, ry), m),
      state, identity(), ctx);
  }

  function convertLine(el, state, m, ctx) {
    var x1 = lenPx(el.getAttribute('x1'), state, 'h') || 0;
    var y1 = lenPx(el.getAttribute('y1'), state, 'v') || 0;
    var x2 = lenPx(el.getAttribute('x2'), state, 'h') || 0;
    var y2 = lenPx(el.getAttribute('y2'), state, 'v') || 0;
    var p1 = applyM(m, x1, y1), p2 = applyM(m, x2, y2);
    var style = buildStyle(state, m, 'line', el, ctx);
    return shapeEl(el, 'line',
      { x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y }, style, ctx);
  }

  function parsePointsAttr(el, ctx) {
    var raw = String(el.getAttribute('points') || '').trim();
    if (!raw) return [];
    var parts = raw.split(/[\s,]+/).filter(function (v) { return v.length; });
    var pts = [];
    for (var i = 0; i + 1 < parts.length; i += 2) {
      var x = Number(parts[i]), y = Number(parts[i + 1]);
      if (!isFinite(x) || !isFinite(y)) { ctx.warn('points 坐标非法已忽略'); break; }
      pts.push([x, y]);
    }
    return pts;
  }

  function convertPoly(el, state, m, ctx, close) {
    var pts = parsePointsAttr(el, ctx);
    if (pts.length < 2) {
      ctx.skip('折线点数不足已跳过');
      return null;
    }
    var segs = [{ c: 'M', pts: [pts[0]] }];
    for (var i = 1; i < pts.length; i++) segs.push({ c: 'L', pts: [pts[i]] });
    if (close) segs.push({ c: 'Z' });
    return segsToPathEl(el, transformSegs(segs, m), state, identity(), ctx);
  }

  function convertPath(el, state, m, ctx) {
    var segs = parsePathToSegs(el.getAttribute('d'), ctx.warn);
    if (!segs.length) { ctx.skip(); return null; }
    return segsToPathEl(el, transformSegs(segs, m), state, identity(), ctx);
  }

  function getHref(el) {
    var v = el.getAttribute('href');
    if (v === null || v === undefined) v = el.getAttribute('xlink:href');
    return v === null || v === undefined ? null : String(v).trim();
  }

  function convertImage(el, state, m, ctx) {
    var href = getHref(el);
    if (!href || href.slice(0, 5).toLowerCase() !== 'data:') {
      ctx.skip('图片缺少内嵌 data URL 已跳过');
      return null;
    }
    if (/^data:image\/svg\+xml/i.test(href)) {
      ctx.skip('内嵌 SVG 仅可随整图静态置入，不能作为可编辑位图导入');
      return null;
    }
    var x = lenPx(el.getAttribute('x'), state, 'h') || 0;
    var y = lenPx(el.getAttribute('y'), state, 'v') || 0;
    var w = lenPx(el.getAttribute('width'), state, 'h');
    var h = lenPx(el.getAttribute('height'), state, 'v');
    if (w === null || h === null || w <= 0 || h <= 0) {
      ctx.skip('图片缺少宽高已跳过');
      return null;
    }
    var style = { imageFit: 'contain' };
    var op = opacityOf(el);
    if (op < 1) style.opacity = r3(op);
    if (axisAligned(m) && m.a > 0 && m.d > 0) {
      return shapeEl(el, 'image',
        { x: m.a * x + m.e, y: m.d * y + m.f, w: m.a * w, h: m.d * h }, style, ctx,
        { src: href });
    }
    ctx.warn('旋转/斜切图片按外接框放置');
    var corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      .map(function (p) { var q = applyM(m, p[0], p[1]); return [q.x, q.y]; });
    var box = null;
    corners.forEach(function (p) {
      if (!box) box = { x: p[0], y: p[1], w: 0, h: 0 };
      box.x = Math.min(box.x, p[0]);
      box.y = Math.min(box.y, p[1]);
    });
    corners.forEach(function (p) {
      box.w = Math.max(box.w, p[0] - box.x);
      box.h = Math.max(box.h, p[1] - box.y);
    });
    return shapeEl(el, 'image', box, style, ctx, { src: href });
  }

  function textContentOf(el) {
    var out = [];
    function rec(n) {
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      var tag = String(n.localName).toLowerCase();
      if (tag === 'title' || tag === 'desc' || tag === 'metadata') return;
      for (var c = n.firstChild; c; c = c.nextSibling) rec(c);
    }
    rec(el);
    return out.join(' ').replace(/\s+/g, ' ').trim();
  }

  function estTextWidthMm(content, fsMm) {
    var w = 0;
    for (var i = 0; i < content.length; i++) {
      var c = content.charCodeAt(i);
      var wide = (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0x9FFF) ||
        (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0xF900 && c <= 0xFAFF) ||
        (c >= 0xFF00 && c <= 0xFF60) || (c >= 0x3000 && c <= 0x303F);
      w += wide ? 1 : 0.55;
    }
    return w * fsMm;
  }

  function convertText(el, state, m, ctx) {
    var content = textContentOf(el);
    if (!content) return null;
    if (el.getElementsByTagName('textPath').length) {
      ctx.warn('textPath 路径排布未支持，文本按单行放置');
    }
    var tspans = el.getElementsByTagName('tspan');
    for (var i = 0; i < tspans.length; i++) {
      if (tspans[i].getAttribute('x') !== null || tspans[i].getAttribute('dy') !== null ||
        tspans[i].getAttribute('dx') !== null) {
        ctx.warn('tspan 逐字/逐行定位未支持，文本已合并');
        break;
      }
    }
    var xs = String(el.getAttribute('x') || '0').trim().split(/[\s,]+/);
    var ys = String(el.getAttribute('y') || '0').trim().split(/[\s,]+/);
    if (xs.length > 1 || ys.length > 1) {
      ctx.warn('文本多坐标定位未支持，仅取首坐标');
    }
    var x = lenPx(xs[0], state, 'h');
    var y = lenPx(ys[0], state, 'v');
    if (x === null) x = 0;
    if (y === null) y = 0;
    if (!axisAligned(m)) ctx.warn('旋转/斜切文本按水平放置');
    var sf = matScale(m);
    var fsMm = Math.max(0.1, state.fontSizePx * sf);
    var anchor = applyM(m, x, y);
    var style = buildStyle(state, m, 'text', el, ctx);
    var w = estTextWidthMm(content, fsMm);
    var ta = style.textAnchor;
    var bx = ta === 'middle' ? anchor.x - w / 2 : (ta === 'end' ? anchor.x - w : anchor.x);
    var elOut = shapeEl(el, 'text',
      { x: bx, y: anchor.y - fsMm * 0.8, w: w, h: fsMm * 1.4 }, style, ctx,
      { text: content });
    if (elOut && ta !== 'start') {
      // renderText 以盒子位置实现锚点；这里直接给出锚点对齐后的盒子
      elOut.style.textAnchor = ta;
    }
    return elOut;
  }

  // ------------------------------------------------------------------
  // 遍历
  // ------------------------------------------------------------------

  function bboxOfEl(el) {
    var t = el.transform;
    return {
      x: Math.min(t.x, t.x + t.w), y: Math.min(t.y, t.y + t.h),
      w: Math.abs(t.w), h: Math.abs(t.h)
    };
  }

  function unionBox(a, b) {
    if (!a) return { x: b.x, y: b.y, w: b.w, h: b.h };
    var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
    var x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function groupFrom(kids, el, state, ctx) {
    var box = null;
    kids.forEach(function (k) { box = unionBox(box, bboxOfEl(k)); });
    var g = {
      id: assignId(el, ctx),
      type: 'group',
      transform: { x: r3(box.x), y: r3(box.y), w: r3(box.w), h: r3(box.h), rotation: 0 },
      children: kids.map(function (k) { return k.id; }),
      parent_id: null,
      style: {}
    };
    var op = opacityOf(el);
    if (op < 1) g.style.opacity = r3(op);
    kids.forEach(function (k) { if (k.parent_id == null) k.parent_id = g.id; });
    return [g].concat(kids);
  }

  function convertNode(el, state, m, ctx) {
    var tag = String(el.localName).toLowerCase();
    if (DROP_TAGS[tag]) return []; // sanitize 漏网防御
    if (SKIP_TAGS[tag]) return [];
    if (el.getAttribute('display') === 'none' ||
      el.getAttribute('visibility') === 'hidden') {
      ctx.skip('隐藏元素已跳过');
      return [];
    }
    state = readStyles(el, state, ctx);
    var mEl = mul(m, parseTransformAttr(el.getAttribute('transform'), ctx.warn));
    switch (tag) {
      case 'g': case 'a': case 'switch': {
        var kids = walkChildren(el, state, mEl, ctx);
        return kids.length ? groupFrom(kids, el, state, ctx) : [];
      }
      case 'svg': { // 嵌套 <svg>：按其 viewBox 建立子坐标系
        var inner = nestedViewportMatrix(el, state, ctx);
        state.viewport = inner.viewport;
        var m3 = mul(mEl, mul(mat(1, 0, 0, 1,
          lenPx(el.getAttribute('x'), state, 'h') || 0,
          lenPx(el.getAttribute('y'), state, 'v') || 0), inner.m));
        var nkids = walkChildren(el, state, m3, ctx);
        return nkids.length ? groupFrom(nkids, el, state, ctx) : [];
      }
      case 'use': return convertUse(el, state, mEl, ctx);
      case 'rect': return pack(convertRect(el, state, mEl, ctx));
      case 'circle': return pack(convertCircleEllipse(el, state, mEl, ctx, true));
      case 'ellipse': return pack(convertCircleEllipse(el, state, mEl, ctx, false));
      case 'line': return pack(convertLine(el, state, mEl, ctx));
      case 'polyline': return pack(convertPoly(el, state, mEl, ctx, false));
      case 'polygon': return pack(convertPoly(el, state, mEl, ctx, true));
      case 'path': return pack(convertPath(el, state, mEl, ctx));
      case 'text': return pack(convertText(el, state, mEl, ctx));
      case 'image': return pack(convertImage(el, state, mEl, ctx));
      default:
        ctx.skip('不支持的元素 <' + tag + '> 已跳过');
        return [];
    }
  }

  function pack(el) {
    return el ? [el] : [];
  }

  function walkChildren(parent, state, m, ctx) {
    var out = [];
    for (var c = parent.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (out.length + ctx.count > MAX_ELEMENTS) {
        ctx.warn('元素数量超过上限，超出部分未导入');
        break;
      }
      var made = convertNode(c, state, m, ctx);
      made.forEach(function (e) { ctx.count++; });
      out = out.concat(made);
    }
    return out;
  }

  function convertUse(el, state, m, ctx) {
    var href = getHref(el);
    if (!href || href.charAt(0) !== '#') {
      ctx.skip('use 引用不是同文档 #id 已跳过');
      return [];
    }
    var target = ctx.byId[href.slice(1)];
    if (!target) {
      ctx.skip('use 引用目标不存在已跳过');
      return [];
    }
    if (ctx.useStack.indexOf(href) >= 0 || ctx.depth > 24) {
      ctx.skip('use 循环/过深引用已跳过');
      return [];
    }
    var ns = state; // convertNode 已合并 use 自身的呈现属性与 transform
    var m2 = m;
    var ux = lenPx(el.getAttribute('x'), state, 'h');
    var uy = lenPx(el.getAttribute('y'), state, 'v');
    if (ux || uy) m2 = mul(m2, mat(1, 0, 0, 1, ux || 0, uy || 0));
    ctx.useStack.push(href);
    ctx.depth++;
    var tag = String(target.localName).toLowerCase();
    var kids;
    if (tag === 'symbol' || tag === 'svg') {
      if (tag === 'symbol') ctx.warn('symbol 视口缩放未处理，按原始坐标放置');
      kids = walkChildren(target, ns, m2, ctx);
    } else {
      kids = convertNode(target, ns, m2, ctx);
    }
    ctx.depth--;
    ctx.useStack.pop();
    return kids;
  }

  // ------------------------------------------------------------------
  // 视口与比例
  // ------------------------------------------------------------------

  function parseViewBox(str) {
    if (!str) return null;
    var parts = String(str).trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some(function (v) { return !isFinite(v); })) return null;
    if (parts[2] <= 0 || parts[3] <= 0) return null;
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }

  function attrToMm(str) {
    if (str === null || str === undefined) return null;
    var m = /^([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*([a-z%]*)$/i.exec(String(str).trim());
    if (!m) return null;
    var u = m[2].toLowerCase();
    if (u === '%') return null;
    var px = Number(m[1]) * (PX_PER_UNIT[u] !== undefined ? PX_PER_UNIT[u] : 1);
    return px * MM_PER_PX;
  }

  function attrToNum(str) {
    var m = /^([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*([a-z%]*)$/i.exec(String(str || '').trim());
    return m ? Number(m[1]) : null;
  }

  function rootViewport(root, ctx) {
    var vb = parseViewBox(root.getAttribute('viewBox'));
    var wS = root.getAttribute('width'), hS = root.getAttribute('height');
    if (vb) {
      var outW = wS ? attrToMm(wS) : vb.w * MM_PER_PX;
      var outH = hS ? attrToMm(hS) : vb.h * MM_PER_PX;
      if (outW === null || outH === null || !(outW > 0) || !(outH > 0)) {
        ctx.warn('SVG 宽高含 % 或非法，按 viewBox 像素处理');
        outW = vb.w * MM_PER_PX;
        outH = vb.h * MM_PER_PX;
      }
      var s = Math.min(outW / vb.w, outH / vb.h); // preserveAspectRatio xMidYMid meet
      var ox = (outW - vb.w * s) / 2, oy = (outH - vb.h * s) / 2;
      return {
        m: mul(mat(1, 0, 0, 1, ox - vb.x * s, oy - vb.y * s), mat(s, 0, 0, s, 0, 0)),
        w: outW, h: outH, viewport: { w: vb.w, h: vb.h }
      };
    }
    if (wS && hS) {
      var mmW = attrToMm(wS), mmH = attrToMm(hS);
      var pxW = attrToNum(wS), pxH = attrToNum(hS);
      if (mmW === null || mmH === null || !(mmW > 0) || !(mmH > 0) ||
        !pxW || !pxH) {
        ctx.warn('SVG 宽高非法，按 96dpi 像素处理');
        return {
          m: mat(MM_PER_PX, 0, 0, MM_PER_PX, 0, 0),
          w: 100 * MM_PER_PX, h: 100 * MM_PER_PX, viewport: { w: 100, h: 100 }
        };
      }
      return {
        m: mat(mmW / pxW, 0, 0, mmH / pxH, 0, 0),
        w: mmW, h: mmH, viewport: { w: pxW, h: pxH }
      };
    }
    ctx.warn('SVG 未声明宽高/viewBox，按 96dpi 像素处理');
    return {
      m: mat(MM_PER_PX, 0, 0, MM_PER_PX, 0, 0),
      w: 100 * MM_PER_PX, h: 100 * MM_PER_PX, viewport: { w: 100, h: 100 }
    };
  }

  function nestedViewportMatrix(el, state, ctx) {
    var vb = parseViewBox(el.getAttribute('viewBox'));
    var wS = el.getAttribute('width'), hS = el.getAttribute('height');
    if (vb) {
      var outW = wS ? (lenPx(wS, state, 'h') || vb.w) : vb.w;
      var outH = hS ? (lenPx(hS, state, 'v') || vb.h) : vb.h;
      var s = Math.min(outW / vb.w, outH / vb.h);
      var ox = (outW - vb.w * s) / 2, oy = (outH - vb.h * s) / 2;
      return {
        m: mul(mat(1, 0, 0, 1, ox - vb.x * s, oy - vb.y * s), mat(s, 0, 0, s, 0, 0)),
        viewport: { w: vb.w, h: vb.h }
      };
    }
    return {
      m: mat(1, 0, 0, 1, 0, 0),
      viewport: { w: wS ? (lenPx(wS, state, 'h') || 100) : 100, h: hS ? (lenPx(hS, state, 'v') || 100) : 100 }
    };
  }

  // ------------------------------------------------------------------
  // 安全清理：可编辑转换和静态置入共用同一个清理后的 SVG 根节点
  // ------------------------------------------------------------------

  var STATIC_DROP_TAGS = {
    script: 1, foreignobject: 1, style: 1,
    animate: 1, animatemotion: 1, animatetransform: 1, animatecolor: 1,
    set: 1, discard: 1, mpath: 1, handler: 1, listener: 1,
    iframe: 1, object: 1, embed: 1, audio: 1, video: 1, canvas: 1
  };
  var RASTER_MIMES = {
    'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1
  };
  var MAX_EMBEDDED_BYTES = 25 * 1024 * 1024;
  var MAX_EMBEDDED_SVG_DEPTH = 4;

  function parseSvgDocument(svgText) {
    if (typeof global.DOMParser !== 'function') {
      fail('当前环境缺少 DOMParser，无法解析 SVG');
    }
    var doc = new global.DOMParser().parseFromString(String(svgText), 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length) {
      fail('SVG 解析失败（XML 格式错误），请检查文件内容');
    }
    var root = doc.documentElement;
    if (!root || String(root.localName).toLowerCase() !== 'svg') {
      fail('根元素不是 <svg>');
    }
    return root;
  }

  function serializeSvg(root) {
    if (typeof global.XMLSerializer !== 'function') {
      fail('当前环境缺少 XMLSerializer，无法安全静态置入 SVG');
    }
    return new global.XMLSerializer().serializeToString(root);
  }

  function bytesToBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i += 32768) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    }
    return global.btoa(binary);
  }

  function base64ToBytes(payload) {
    var compact = String(payload).replace(/\s+/g, '');
    if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
      throw new Error('base64 非法');
    }
    var binary = global.atob(compact);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function percentDataToBytes(payload) {
    var bytes = [];
    for (var i = 0; i < payload.length;) {
      if (payload.charAt(i) === '%') {
        if (!/^[0-9A-Fa-f]{2}$/.test(payload.slice(i + 1, i + 3))) {
          throw new Error('data URL 百分号编码非法');
        }
        bytes.push(parseInt(payload.slice(i + 1, i + 3), 16));
        i += 3;
        continue;
      }
      var cp = payload.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      var utf8 = unescape(encodeURIComponent(ch));
      for (var j = 0; j < utf8.length; j++) bytes.push(utf8.charCodeAt(j));
      i += ch.length;
    }
    return new Uint8Array(bytes);
  }

  function utf8BytesToText(bytes) {
    if (typeof global.TextDecoder === 'function') {
      return new global.TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    var binary = '';
    for (var i = 0; i < bytes.length; i += 32768) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    }
    return decodeURIComponent(escape(binary));
  }

  function rasterMimeMatches(mime, b) {
    function has(sig, offset) {
      offset = offset || 0;
      if (b.length < offset + sig.length) return false;
      for (var i = 0; i < sig.length; i++) {
        if (b[offset + i] !== sig[i]) return false;
      }
      return true;
    }
    if (mime === 'image/png') return has([137, 80, 78, 71, 13, 10, 26, 10]);
    if (mime === 'image/jpeg') return has([255, 216, 255]);
    if (mime === 'image/gif') return has([71, 73, 70, 56]) &&
      (b[4] === 55 || b[4] === 57) && b[5] === 97;
    if (mime === 'image/webp') return has([82, 73, 70, 70]) &&
      has([87, 69, 66, 80], 8);
    return false;
  }

  function sanitizeImageDataUrl(value, ctx, depth) {
    var raw = String(value || '').trim();
    if (!/^data:/i.test(raw)) return null;
    var comma = raw.indexOf(',');
    if (comma < 0) {
      ctx.warn('图片 data URL 缺少数据已移除');
      return null;
    }
    var header = raw.slice(5, comma);
    var fields = header.split(';');
    var mime = fields.shift().trim().toLowerCase();
    var isBase64 = fields.some(function (v) { return v.trim().toLowerCase() === 'base64'; });
    var bytes;
    try {
      bytes = isBase64 ? base64ToBytes(raw.slice(comma + 1)) :
        percentDataToBytes(raw.slice(comma + 1));
      if (bytes.length > MAX_EMBEDDED_BYTES) throw new Error('data URL 过大');
    } catch (e) {
      ctx.warn('图片 data URL 解码失败已移除');
      return null;
    }
    if (mime === 'image/svg+xml') {
      if (depth >= MAX_EMBEDDED_SVG_DEPTH) {
        ctx.warn('嵌套 SVG 层级过深已移除');
        return null;
      }
      try {
        var nestedRoot = parseSvgDocument(utf8BytesToText(bytes));
        sanitize(nestedRoot, ctx, depth + 1);
        return 'data:image/svg+xml;base64,' + bytesToBase64(
          percentDataToBytes(encodeURIComponent(serializeSvg(nestedRoot))));
      } catch (e) {
        ctx.warn('嵌套 SVG 无法安全解析已移除');
        return null;
      }
    }
    if (!RASTER_MIMES[mime]) {
      ctx.warn('不支持的图片 data URL MIME 已移除');
      return null;
    }
    if (!rasterMimeMatches(mime, bytes)) {
      ctx.warn('图片 data URL 内容与 MIME 不符已移除');
      return null;
    }
    return 'data:' + mime + ';base64,' + bytesToBase64(bytes);
  }

  function decodeCss(value) {
    return String(value).replace(/\/\*[\s\S]*?\*\//g, '').replace(
      /\\(?:([0-9a-fA-F]{1,6})\s?|([^\r\n\f0-9a-fA-F]))/g,
      function (_, hex, ch) {
        if (ch) return ch;
        var cp = parseInt(hex, 16);
        return cp ? String.fromCodePoint(cp) : '\uFFFD';
      });
  }

  function cleanLocalUrls(value) {
    var had = false;
    var cleaned = String(value).replace(
      /url\s*\(\s*(['"]?)#([A-Za-z0-9_.:-]+)\1\s*\)/gi,
      function (_, quote, id) { had = true; return 'url(#' + id + ')'; });
    var remainder = cleaned.replace(/url\(#[A-Za-z0-9_.:-]+\)/gi, '');
    if (/url\s*\(/i.test(decodeCss(remainder))) return null;
    return { value: cleaned, had: had };
  }

  function safeDefaultForUrlAttr(name) {
    var nm = name.toLowerCase();
    if (nm === 'fill' || nm === 'stroke' || nm === 'filter' || nm === 'mask' ||
      nm === 'clip-path' || /^marker-(?:start|mid|end)$/.test(nm)) return 'none';
    return null;
  }

  function cssDeclarations(text) {
    var out = [], start = 0, quote = '', escaped = false, depth = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && depth) depth--;
      else if (ch === ';' && !depth) {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
    out.push(text.slice(start));
    return out;
  }

  function sanitizeStyleAttribute(text) {
    return cssDeclarations(String(text)).map(function (decl) {
      var colon = decl.indexOf(':');
      if (colon < 1) return '';
      var name = decl.slice(0, colon).trim().toLowerCase();
      var value = decl.slice(colon + 1).trim();
      if (!/^-?[a-z][a-z0-9-]*$/.test(name) || !value) return '';
      var decoded = decodeCss(value);
      if (/@(?:import|font-face|namespace)\b|expression\s*\(|image-set\s*\(|(?:javascript|vbscript|https?|ftp|file)\s*:|-moz-binding|behavior\s*:/i.test(decoded)) {
        var unsafeDefault = safeDefaultForUrlAttr(name);
        return unsafeDefault ? name + ':' + unsafeDefault : '';
      }
      var urls = cleanLocalUrls(value);
      if (!urls) {
        var fallback = safeDefaultForUrlAttr(name);
        return fallback ? name + ':' + fallback : '';
      }
      return name + ':' + urls.value;
    }).filter(function (v) { return !!v; }).join(';');
  }

  function sanitize(root, ctx, depth) {
    depth = depth || 0;
    var all = [root].concat([].slice.call(root.getElementsByTagName('*')));
    all.forEach(function (el) {
      if (el.nodeType !== 1) return;
      var tag = String(el.localName).toLowerCase();
      if (STATIC_DROP_TAGS[tag]) {
        ctx.warn(tag === 'script' ? '脚本元素已移除' :
          tag === 'foreignobject' ? 'foreignObject 已移除' :
          tag === 'style' ? 'style 样式表/@import/外部字体已移除' : '动画/主动内容元素已移除');
        if (el.parentNode) el.parentNode.removeChild(el);
        return;
      }
      [].slice.call(el.attributes).forEach(function (a) {
        var nm = String(a.name).toLowerCase();
        var local = String(a.localName || nm.replace(/^.*:/, '')).toLowerCase();
        if (local.slice(0, 2) === 'on') {
          el.removeAttribute(a.name);
          ctx.warn('事件属性（含命名空间事件）已移除');
          return;
        }
        if (local === 'srcdoc') {
          el.removeAttribute(a.name);
          ctx.warn('srcdoc 主动内容已移除');
          return;
        }
        var value = String(a.value).trim();
        if (local === 'href') {
          if (/^#[A-Za-z0-9_.:-]+$/.test(value)) return;
          if (tag === 'image' && /^data:/i.test(value)) {
            var clean = sanitizeImageDataUrl(value, ctx, depth);
            if (clean) {
              el.removeAttribute(a.name);
              el.setAttribute('href', clean);
              return;
            }
          }
          el.removeAttribute(a.name);
          ctx.warn('外部/不支持的链接引用已移除');
          return;
        }
        if (/^(?:src|data|poster|action|formaction|background|manifest|codebase)$/.test(local)) {
          el.removeAttribute(a.name);
          ctx.warn('非 SVG 资源属性已移除');
          return;
        }
        if (nm === 'style') {
          var safeStyle = sanitizeStyleAttribute(value);
          if (safeStyle) el.setAttribute(a.name, safeStyle);
          else el.removeAttribute(a.name);
          if (cleanLocalUrls(value) === null ||
            /@(?:import|font-face|namespace)\b/i.test(decodeCss(value))) {
            ctx.warn('style 外部资源/@import 已移除或替换为安全默认值');
          }
          return;
        }
        if (/url\s*\(/i.test(decodeCss(value))) {
          var safeUrls = cleanLocalUrls(value);
          if (safeUrls) el.setAttribute(a.name, safeUrls.value);
          else {
            var fallback = safeDefaultForUrlAttr(nm);
            if (fallback) el.setAttribute(a.name, fallback);
            else el.removeAttribute(a.name);
            ctx.warn('外部 url() 已移除或替换为安全默认值');
          }
        }
      });
    });
  }

  // ------------------------------------------------------------------
  // 入口
  // ------------------------------------------------------------------

  function makeContext() {
    var ctx = {
      warnMap: {}, byId: {}, usedIds: {}, seq: 0,
      skipped: 0, count: 0, useStack: [], depth: 0
    };
    ctx.warn = function (k) { ctx.warnMap[k] = (ctx.warnMap[k] || 0) + 1; };
    ctx.skip = function (k) { ctx.skipped++; if (k) ctx.warn(k); };
    return ctx;
  }

  function formatWarnings(ctx) {
    return Object.keys(ctx.warnMap).map(function (k) {
      var n = ctx.warnMap[k];
      return n > 1 ? k + '（' + n + ' 处）' : k;
    });
  }

  function sanitizeText(svgText) {
    var root = parseSvgDocument(svgText);
    var ctx = makeContext();
    sanitize(root, ctx, 0);
    return { svgText: serializeSvg(root), warnings: formatWarnings(ctx) };
  }

  function convert(svgText) {
    var root = parseSvgDocument(svgText);
    var ctx = makeContext();
    sanitize(root, ctx, 0);
    [root].concat([].slice.call(root.getElementsByTagName('*'))).forEach(function (el) {
      var id = el.getAttribute && el.getAttribute('id');
      if (id) ctx.byId[id] = el;
    });
    var vp = rootViewport(root, ctx);
    var state = readStyles(root, initialState(), ctx);
    state.viewport = vp.viewport;
    var elements = walkChildren(root, state, vp.m, ctx);
    if (!elements.length) fail('SVG 中没有可转换的图形元素');
    if (elements.length > MAX_ELEMENTS) {
      fail('可转换元素超过 ' + MAX_ELEMENTS + ' 个，建议作为静态图导入');
    }
    return {
      elements: elements,
      warnings: formatWarnings(ctx),
      size_mm: { w: r3(vp.w), h: r3(vp.h) },
      skipped: ctx.skipped,
      svgText: serializeSvg(root)
    };
  }

  // ------------------------------------------------------------------
  // 画布适配：内容超出时整体等比缩放（含 pathData / 字号 / 线宽 / 圆角）
  // ------------------------------------------------------------------

  function scalePathData(d, k) {
    return String(d).replace(
      /-?\d*\.?\d+(?:[eE][+-]?\d+)?/gi,
      function (v) { return f3(Number(v) * k); });
  }

  function fitToCanvas(elements, canvas) {
    if (!Array.isArray(elements) || !elements.length) return 1;
    var cw = num(canvas && canvas.width_mm, 120);
    var ch = num(canvas && canvas.height_mm, 90);
    var margin = 4;
    var availW = Math.max(1, cw - margin * 2);
    var availH = Math.max(1, ch - margin * 2);
    var box = null;
    elements.forEach(function (el) {
      if (!el || !el.transform) return;
      box = unionBox(box, bboxOfEl(el));
    });
    if (!box || box.w <= 0 || box.h <= 0) return 1;
    if (box.w <= availW && box.h <= availH) return 1;
    var k = Math.min(availW / box.w, availH / box.h);
    if (!isFinite(k) || k <= 0 || k > 1) return 1;
    elements.forEach(function (el) {
      if (!el || !el.transform) return;
      var t = el.transform;
      t.x = r3(t.x * k);
      t.y = r3(t.y * k);
      t.w = r3(t.w * k);
      t.h = r3(t.h * k);
      var s = el.style;
      if (!s || typeof s !== 'object') return;
      if (isNum(s.fontSizePt)) s.fontSizePt = r3(Math.max(0.1, s.fontSizePt * k));
      if (isNum(s.strokeWidthPt)) s.strokeWidthPt = r3(Math.max(0.01, s.strokeWidthPt * k));
      if (isNum(s.cornerRadiusMm)) s.cornerRadiusMm = r3(s.cornerRadiusMm * k);
      if (typeof s.dash === 'string' && s.dash) {
        s.dash = s.dash.split(/\s+/).map(function (v) {
          return f3(num(v, 0) * k);
        }).join(' ');
      }
      if (typeof el.pathData === 'string' && el.pathData) {
        el.pathData = scalePathData(el.pathData, k);
      }
    });
    return r3(k);
  }

  global.SvgImport = {
    convert: convert,
    sanitize: sanitizeText,
    fitToCanvas: fitToCanvas
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
