/*
 * template-preview.js — template-derived SVG thumbnails. The shared local
 * kernel is preferred independently of Backend.available; svgAsync/drawAsync
 * may wait for a real asynchronous backend render. Every fallback stays
 * explicitly marked as a simplified schematic. No inference or document writes.
 */
(function (global) {
  "use strict";

  var W = 180, H = 112, CHART_H = 94;
  var INK = "#334155";
  var MUTED = "#64748b";
  var GRID = "#e2e8f0";
  var PAPER = "#ffffff";
  var DEFAULT_SERIES = ["#3c5488", "#e64b35", "#00a087", "#4dbbd5", "#f39b7f", "#7e6148"];
  var KERNEL_SERIES = ["#3C5488", "#E64B35", "#00A087", "#4DBBD5", "#F39B7F", "#8491B4", "#91D1C2", "#DC0000", "#7E6148", "#B09C85"];
  var SERIES = DEFAULT_SERIES;
  var FOOTER_CHART = "简化结构示意 · 示例非真实数据";
  var FOOTER_SPECTRUM = "简化光谱示意 · 合成非实验数据";
  var FOOTER_DIAGRAM = "机制 / 流程结构示意";
  var FOOTER_COMPOSITE = "面板版式 · 结构示意";
  var FOOTER_LOCAL_CHART = "本地实际预览 · 示例非真实数据";
  var FOOTER_LOCAL_SPECTRUM = "本地实际预览 · 光谱示意非实验";
  var FOOTER_BACKEND_CHART = "后端实际预览 · 示例非真实数据";
  var FOOTER_BACKEND_SPECTRUM = "后端实际预览 · 光谱示意非实验";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmt(value) {
    var n = Math.round(Number(value) * 100) / 100;
    return String(n === 0 ? 0 : n);
  }

  function rgb(hex) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
    if (!m) return null;
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16)
    };
  }

  function channelLinear(v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function contrastOnWhite(hex) {
    var c = rgb(hex);
    if (!c) return 1;
    var l = 0.2126 * channelLinear(c.r) + 0.7152 * channelLinear(c.g) + 0.0722 * channelLinear(c.b);
    return 1.05 / (l + 0.05);
  }

  function seriesFrom(colors) {
    if (!Array.isArray(colors)) return DEFAULT_SERIES;
    var usable = [];
    for (var i = 0; i < colors.length && usable.length < DEFAULT_SERIES.length; i++) {
      if (typeof colors[i] === "string" && rgb(colors[i]) && contrastOnWhite(colors[i]) >= 1.55) {
        usable.push(colors[i]);
      }
    }
    if (usable.length < 2) return DEFAULT_SERIES;
    var original = usable.slice();
    for (i = 0; usable.length < DEFAULT_SERIES.length; i++) {
      usable.push(mix(original[i % original.length], i % 2 ? "#ffffff" : "#334155", i % 2 ? 0.26 : 0.18));
    }
    return usable;
  }

  function mix(a, b, t) {
    var ca = rgb(a) || rgb(DEFAULT_SERIES[0]);
    var cb = rgb(b) || { r: 255, g: 255, b: 255 };
    function part(x, y) {
      var v = Math.round(x + (y - x) * Math.max(0, Math.min(1, t)));
      return ("0" + v.toString(16)).slice(-2);
    }
    return "#" + part(ca.r, cb.r) + part(ca.g, cb.g) + part(ca.b, cb.b);
  }

  function soft(color) {
    return mix(color, "#ffffff", 0.88);
  }

  function frame(inner, footer, source) {
    var provenance = source || "local-deterministic-fallback";
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="模板实际预览或明确标注的简化示意" data-preview-data="deterministic-synthetic" data-preview-source="' + esc(provenance) + '">' +
      '<title>' + esc((footer || FOOTER_CHART) + "；渲染来源：" + provenance) + '</title>' +
      '<rect width="' + W + '" height="' + H + '" fill="' + PAPER + '"/>' +
      '<g font-family="Arial, Helvetica, sans-serif" fill="' + INK + '">' + (inner || "") + '</g>' +
      '<line x1="8" y1="98.5" x2="172" y2="98.5" stroke="#edf1f5" stroke-width="0.7"/>' +
      '<text x="9" y="107" font-family="Arial, Helvetica, sans-serif" font-size="6.2" letter-spacing="0.1" fill="' + MUTED + '">' +
      esc(footer || FOOTER_CHART) + '</text>' +
      '<rect x="0.5" y="0.5" width="179" height="111" rx="2" fill="none" stroke="#d6dee8" stroke-width="0.8"/>' +
      '</svg>';
  }

  function text(x, y, value, size, anchor, color, weight) {
    return '<text x="' + fmt(x) + '" y="' + fmt(y) + '" text-anchor="' + (anchor || "middle") +
      '" font-size="' + (size || 6.4) + '" fill="' + (color || INK) + '"' +
      (weight ? ' font-weight="' + weight + '"' : "") + '>' + esc(value) + '</text>';
  }

  function line(x1, y1, x2, y2, color, width, dash) {
    return '<line x1="' + fmt(x1) + '" y1="' + fmt(y1) + '" x2="' + fmt(x2) + '" y2="' + fmt(y2) +
      '" stroke="' + (color || INK) + '" stroke-width="' + (width || 0.8) + '"' +
      (dash ? ' stroke-dasharray="' + dash + '"' : "") + '/>';
  }

  function pathLine(points, color, width, extra) {
    var d = "";
    for (var i = 0; i < points.length; i++) {
      d += (i ? " L" : "M") + fmt(points[i][0]) + " " + fmt(points[i][1]);
    }
    return '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + (width || 1.05) +
      '" stroke-linecap="round" stroke-linejoin="round"' + (extra || "") + '/>';
  }

  function dots(points, color, radius) {
    var out = "";
    for (var i = 0; i < points.length; i++) {
      out += '<circle cx="' + fmt(points[i][0]) + '" cy="' + fmt(points[i][1]) + '" r="' + (radius || 1.65) +
        '" fill="' + color + '" stroke="#ffffff" stroke-width="0.45"/>';
    }
    return out;
  }

  function chartFrame(x, y, w, h, xLabel, yLabel, grid) {
    var out = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="#fcfdff"/>';
    if (grid !== false) {
      for (var i = 1; i < 4; i++) {
        out += line(x, y + h * i / 4, x + w, y + h * i / 4, GRID, 0.55);
      }
    }
    out += line(x, y, x, y + h, INK, 0.75) + line(x, y + h, x + w, y + h, INK, 0.75);
    if (xLabel) out += text(x + w / 2, y + h + 10, xLabel, 6.3);
    if (yLabel) out += '<g transform="rotate(-90 ' + fmt(x - 7) + ' ' + fmt(y + h / 2) + ')">' +
      text(x - 7, y + h / 2, yLabel, 6.3, "middle", INK) + '</g>';
    return out;
  }

  function gaussian(x, center, width, height) {
    var z = (x - center) / width;
    return height * Math.exp(-0.5 * z * z);
  }

  function spec(chartType, columns, rows, mapping, axes, characterization, legend) {
    return {
      chartType: chartType,
      data: { inline: { columns: columns, rows: rows } },
      mapping: mapping,
      axes: Object.assign({ tickLabelSizePt: 9, gridlines: false }, axes || {}),
      characterization: characterization || undefined,
      legend: legend || "right"
    };
  }

  function recolorKernel(fragment) {
    var out = String(fragment || "");
    for (var i = 0; i < KERNEL_SERIES.length; i++) {
      var re = new RegExp(KERNEL_SERIES[i], "gi");
      out = out.replace(re, SERIES[i % SERIES.length]);
    }
    return out.replace(/#000000/gi, INK).replace(/#DDDDDD/gi, GRID);
  }

  function localKernel(specValue, width, height) {
    if (!global.FigData || typeof global.FigData.renderChartSVG !== "function") return null;
    try {
      var rendered = global.FigData.renderChartSVG(specValue, {
        width_mm: (width || W) * 25.4 / 60,
        height_mm: (height || CHART_H) * 25.4 / 60,
        dpi: 60
      });
      var result = String(rendered == null ? "" : rendered).trim();
      if (!result || /data-render=["']placeholder["']|该图表类型需 v2 服务端渲染/.test(result)) return null;
      return result;
    } catch (e) {
      return null;
    }
  }

  function number(v) {
    if (typeof v !== "number" && typeof v !== "string") return null;
    if (typeof v === "string" && !v.trim()) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function category(v) {
    return v === null || v === undefined || v === "" ? null : String(v);
  }

  function pushUnique(list, value) {
    if (list.indexOf(value) < 0) list.push(value);
    return list.indexOf(value);
  }

  function mean(values) {
    var total = 0;
    for (var i = 0; i < values.length; i++) total += values[i];
    return values.length ? total / values.length : 0;
  }

  function fallbackDomain(values, includeZero) {
    if (includeZero) values = values.concat([0]);
    var lo = Math.min.apply(Math, values), hi = Math.max.apply(Math, values);
    if (lo === hi) {
      var pad = Math.abs(lo) * 0.1 || 0.5;
      lo -= pad;
      hi += pad;
    }
    return { min: lo, max: hi };
  }

  function fallbackEmpty(message) {
    return text(W / 2, 45, message + "（示意）", 6.7);
  }

  function fallbackLegend(labels, y) {
    var out = "", step = 140 / Math.max(1, labels.length);
    for (var i = 0; i < labels.length; i++) {
      out += line(28 + i * step, y - 1.6, 34 + i * step, y - 1.6, SERIES[i % SERIES.length], 1.2) +
        text(36 + i * step, y, labels[i], 5.2, "start", MUTED);
    }
    return out;
  }

  function fallbackPie(s, ch) {
    var cols = s.data.inline.columns, rows = s.data.inline.rows;
    var xi = cols.indexOf(s.mapping.x), yi = cols.indexOf(s.mapping.y);
    var totals = {}, labels = [], values = [], total = 0;
    for (var i = 0; i < rows.length && xi >= 0 && yi >= 0; i++) {
      var label = category(rows[i][xi]), value = number(rows[i][yi]);
      if (label === null || value === null) continue;
      if (totals[label] === undefined) { totals[label] = 0; labels.push(label); }
      totals[label] += value;
    }
    for (i = 0; i < labels.length; i++) {
      if (!(totals[labels[i]] >= 0)) return fallbackEmpty("饼图需要非负数据");
      total += totals[labels[i]];
      values.push(totals[labels[i]]);
    }
    if (!(total > 0)) return fallbackEmpty("饼图总和需要大于零");
    var out = "", angle = -Math.PI / 2, cx = 78, cy = 44, radius = 33;
    for (i = 0; i < labels.length; i++) {
      var next = angle + values[i] / total * Math.PI * 2;
      if (labels.length === 1) {
        out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + radius + '" fill="' + SERIES[0] + '"/>';
      } else if (values[i] > 0) {
        var x1 = cx + radius * Math.cos(angle), y1 = cy + radius * Math.sin(angle);
        var x2 = cx + radius * Math.cos(next), y2 = cy + radius * Math.sin(next);
        out += '<path d="M' + fmt(cx) + ' ' + fmt(cy) + ' L' + fmt(x1) + ' ' + fmt(y1) +
          ' A' + radius + ' ' + radius + ' 0 ' + (next - angle > Math.PI ? 1 : 0) + ' 1 ' +
          fmt(x2) + ' ' + fmt(y2) + ' Z" fill="' + SERIES[i % SERIES.length] +
          '" data-preview-category="' + esc(labels[i]) + '"/>';
      }
      angle = next;
      out += text(129, 23 + i * 13, labels[i] + " " + fmt(values[i] / total * 100) + "%", 5.6, "start", SERIES[i % SERIES.length]);
    }
    return out;
  }

  function fallbackCategorical(s, ch) {
    if (s.chartType === "pie") return fallbackPie(s, ch);
    var cols = s.data.inline.columns, rows = s.data.inline.rows;
    var xi = cols.indexOf(s.mapping.x), yi = cols.indexOf(s.mapping.y);
    var gi = cols.indexOf(s.mapping.group);
    var grouped = s.chartType === "bar_grouped";
    var labels = [], groups = [], cells = {}, values = [];
    for (var i = 0; i < rows.length && xi >= 0 && yi >= 0; i++) {
      var label = category(rows[i][xi]), value = number(rows[i][yi]);
      var group = grouped && gi >= 0 ? category(rows[i][gi]) : "raw";
      if (label === null || value === null || group === null) continue;
      var ci = pushUnique(labels, label), gj = pushUnique(groups, group);
      var key = ci + ":" + gj;
      if (!cells[key]) cells[key] = [];
      cells[key].push(value);
      values.push(value);
    }
    if (!values.length) return fallbackEmpty("无可绘制的分类数据");
    var x = 28, y = 9, w = 137, h = 64;
    var isBar = /^bar/.test(s.chartType);
    var dom = fallbackDomain(values, isBar);
    var sy = function (v) { return y + h - (v - dom.min) / (dom.max - dom.min) * h; };
    var out = chartFrame(x, y, w, h, "", ch.y_label || s.axes.yLabel || "");
    var band = w / labels.length, slot = band / Math.max(1, groups.length);
    for (i = 0; i < labels.length; i++) {
      for (var j = 0; j < groups.length; j++) {
        var vals = cells[i + ":" + j] || [];
        if (!vals.length) continue;
        var px = x + band * i + slot * (j + 0.5), color = SERIES[j % SERIES.length];
        if (isBar) {
          var value = mean(vals), zero = sy(0), top = sy(value), bw = Math.max(1.5, slot * (grouped ? 0.86 : 0.58));
          out += '<rect x="' + fmt(px - bw / 2) + '" y="' + fmt(Math.min(zero, top)) +
            '" width="' + fmt(bw) + '" height="' + fmt(Math.max(0.35, Math.abs(zero - top))) +
            '" fill="' + color + '" data-preview-category="' + esc(labels[i]) +
            '" data-preview-group="' + esc(groups[j]) + '" data-preview-value="' + fmt(value) + '"/>';
        } else {
          vals.sort(function (a, b) { return a - b; });
          var q = function (p) {
            var at = (vals.length - 1) * p, low = Math.floor(at), high = Math.ceil(at);
            return vals[low] + (vals[high] - vals[low]) * (at - low);
          };
          var y0 = sy(vals[0]), y1 = sy(q(0.25)), ym = sy(q(0.5)), y2 = sy(q(0.75)), y3 = sy(vals[vals.length - 1]);
          var bw2 = Math.max(3, slot * 0.5);
          out += line(px, y0, px, y3, INK, 0.7) +
            '<rect x="' + fmt(px - bw2 / 2) + '" y="' + fmt(Math.min(y1, y2)) + '" width="' + fmt(bw2) +
            '" height="' + fmt(Math.abs(y2 - y1)) + '" fill="' + soft(color) + '" stroke="' + color +
            '" stroke-width="0.8" data-preview-category="' + esc(labels[i]) + '"/>' +
            line(px - bw2 / 2, ym, px + bw2 / 2, ym, color, 1.1) +
            line(px - bw2 / 3, y0, px + bw2 / 3, y0, INK, 0.65) + line(px - bw2 / 3, y3, px + bw2 / 3, y3, INK, 0.65);
        }
      }
      out += text(x + band * (i + 0.5), y + h + 5, labels[i], 5.5);
    }
    if (s.axes.xLabel) out += text(x + w / 2, y + h + 12, s.axes.xLabel, 5.5);
    if (grouped && groups.length > 1) out += fallbackLegend(groups, 93);
    return out;
  }

  function fallbackHistogram(s, ch) {
    var cols = s.data.inline.columns, rows = s.data.inline.rows, xi = cols.indexOf(s.mapping.x), values = [];
    for (var i = 0; i < rows.length && xi >= 0; i++) {
      var value = number(rows[i][xi]);
      if (value !== null) values.push(value);
    }
    if (!values.length) return fallbackEmpty("直方图需要数值列");
    var dom = fallbackDomain(values, false), bins = 7, counts = numericRows(bins, function () { return 0; });
    for (i = 0; i < values.length; i++) {
      var bi = Math.min(bins - 1, Math.floor((values[i] - dom.min) / (dom.max - dom.min) * bins));
      counts[bi] += 1;
    }
    var x = 35, y = 7, w = 132, h = 65, maxCount = Math.max.apply(Math, counts);
    var out = chartFrame(x, y, w, h, ch.x_label || s.axes.xLabel || "", ch.y_label || s.axes.yLabel || "");
    for (i = 0; i < bins; i++) {
      var bh = counts[i] / maxCount * h;
      out += '<rect x="' + fmt(x + i * w / bins + 0.5) + '" y="' + fmt(y + h - bh) +
        '" width="' + fmt(w / bins - 1) + '" height="' + fmt(bh) + '" fill="' + soft(SERIES[0]) +
        '" stroke="' + SERIES[0] + '" stroke-width="0.6" data-bin-count="' + counts[i] + '"/>';
    }
    return out;
  }

  function fallbackDataChart(s) {
    var ch = s.characterization || {}, axes = s.axes || {};
    if (/^bar/.test(s.chartType) || s.chartType === "box" || s.chartType === "pie") {
      return fallbackCategorical(s, ch);
    }
    if (s.chartType === "histogram") return fallbackHistogram(s, ch);
    var cols = s.data.inline.columns, rows = s.data.inline.rows;
    var xi = cols.indexOf(s.mapping.x), yi = cols.indexOf(s.mapping.y), gi = cols.indexOf(s.mapping.group);
    var records = [], groups = [], valuesX = [], valuesY = [];
    var offset = number(ch.offset_each_series);
    for (var i = 0; i < rows.length && xi >= 0 && yi >= 0; i++) {
      var xv = number(rows[i][xi]), yv = number(rows[i][yi]);
      var group = gi >= 0 ? category(rows[i][gi]) : "raw";
      if (xv === null || yv === null || group === null || (ch.x_scale === "log10" && xv <= 0)) continue;
      var gi2 = pushUnique(groups, group);
      records.push({ x: xv, y: yv, group: group, rawIndex: gi2, row: rows[i] });
      valuesX.push(ch.x_scale === "log10" ? Math.log10(xv) : xv);
    }
    if (!records.length) return fallbackEmpty("无可绘制的数值点");
    var normalize = ch.normalize === "max_to_unity";
    var maxima = numericRows(groups.length, function () { return 0; });
    for (i = 0; i < records.length; i++) {
      maxima[records[i].rawIndex] = Math.max(maxima[records[i].rawIndex], Math.abs(records[i].y));
    }
    for (i = 0; i < records.length; i++) {
      var scale = normalize && maxima[records[i].rawIndex] > 0 ? 1 / maxima[records[i].rawIndex] : 1;
      records[i].displayY = records[i].y * scale + (offset === null ? 0 : records[i].rawIndex * offset);
      valuesY.push(records[i].displayY);
    }
    var curves = [], priority = { component: 0, baseline: 1, fit: 2 };
    for (i = 0; i < (ch.curves || []).length; i++) {
      var declared = ch.curves[i], ci = cols.indexOf(declared.column);
      if (ci < 0) continue;
      var points = [], maxAbs = 0;
      for (var j = 0; j < records.length; j++) {
        var cv = number(records[j].row[ci]);
        if (cv === null) continue;
        points.push({ x: records[j].x, y: cv, rawIndex: records[j].rawIndex });
        maxAbs = Math.max(maxAbs, Math.abs(cv));
      }
      var sharedMax = groups.length === 1 ? maxima[0] : maxAbs;
      var curveScale = normalize && sharedMax > 0 ? 1 / sharedMax : 1;
      for (j = 0; j < points.length; j++) {
        points[j].displayY = points[j].y * curveScale;
        valuesY.push(points[j].displayY);
      }
      curves.push({ role: declared.role, points: points });
    }
    curves.sort(function (a, b) { return (priority[a.role] == null ? 3 : priority[a.role]) - (priority[b.role] == null ? 3 : priority[b.role]); });
    var x = 35, y = 7, w = 132, h = 65;
    var xd = fallbackDomain(valuesX, false), yd = fallbackDomain(valuesY, false);
    var sx = function (v) {
      if (ch.x_scale === "log10") v = Math.log10(v);
      var t = (v - xd.min) / (xd.max - xd.min);
      return ch.x_reverse ? x + w * (1 - t) : x + w * t;
    };
    var sy = function (v) { return y + h - (v - yd.min) / (yd.max - yd.min) * h; };
    var out = '<g data-preview-normalize="' + esc(normalize ? "max_to_unity" : (ch.normalize || "none")) +
      '" data-preview-offset="' + esc(offset === null ? "null" : offset) + '">' +
      chartFrame(x, y, w, h, ch.x_label || axes.xLabel || "", ch.y_label || axes.yLabel || "");
    if (s.chartType === "scatter") {
      for (i = 0; i < records.length; i++) {
        out += dots([[sx(records[i].x), sy(records[i].displayY)]], SERIES[records[i].rawIndex % SERIES.length], 1.35);
      }
    } else {
      for (i = 0; i < curves.length; i++) {
        var cpoints = curves[i].points.map(function (p) { return [sx(p.x), sy(p.displayY)]; });
        out += pathLine(cpoints, SERIES[(groups.length + i + 1) % SERIES.length], 0.8,
          ' data-preview-role="' + esc(curves[i].role) + '"' + (curves[i].role === "fit" ? ' stroke-dasharray="4 2"' : ""));
      }
      for (i = 0; i < groups.length; i++) {
        var points2 = records.filter(function (r) { return r.group === groups[i]; })
          .map(function (r) { return [sx(r.x), sy(r.displayY)]; });
        out += pathLine(points2, SERIES[i % SERIES.length], 1.05,
          ' data-preview-role="raw" data-preview-group="' + esc(groups[i]) + '" data-preview-raw-index="' + i + '"');
      }
    }
    out += text(x + w - 2, 86, ch.x_reverse ? "高值 ← x → 低值" : "x →", 5.8, "end", MUTED);
    if (groups.length > 1) out += fallbackLegend(groups, 94);
    return out + '</g>';
  }

  function fitRenderedSVG(fragment, x, y, width, height) {
    var rendered = String(fragment || "").trim();
    if (!/^<svg(\s|>)/i.test(rendered)) {
      var scaleX = (width || W) / W, scaleY = (height || CHART_H) / CHART_H;
      return '<g transform="translate(' + fmt(x || 0) + ' ' + fmt(y || 0) + ') scale(' + fmt(scaleX) + ' ' + fmt(scaleY) + ')">' + rendered + '</g>';
    }
    var viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(rendered);
    if (!viewBox) {
      var wm = /width\s*=\s*["']([0-9.]+)(?:px|pt|mm)?["']/i.exec(rendered);
      var hm = /height\s*=\s*["']([0-9.]+)(?:px|pt|mm)?["']/i.exec(rendered);
      viewBox = wm && hm ? [null, "0 0 " + wm[1] + " " + hm[1]] : [null, "0 0 " + W + " " + CHART_H];
    }
    var opening = /^<svg\b[^>]*>/i.exec(rendered);
    if (!opening) return rendered;
    var rootTag = opening[0].replace(/\s(?:x|y|width|height|viewBox|preserveAspectRatio)\s*=\s*["'][^"']*["']/gi, "");
    rootTag = rootTag.replace(/<svg/i, '<svg x="' + fmt(x || 0) + '" y="' + fmt(y || 0) +
      '" width="' + fmt(width || W) + '" height="' + fmt(height || CHART_H) +
      '" viewBox="' + esc(viewBox[1]) + '" preserveAspectRatio="xMidYMid meet"');
    return rootTag + rendered.slice(opening[0].length);
  }

  function applyTemplateDefaults(s, template) {
    if (!template) return s;
    var defaults = template.default_mapping || {};
    Object.keys(s.mapping || {}).forEach(function (role) {
      if (defaults[role] === null) delete s.mapping[role];
    });
    if (!template.characterization) return s;
    var sourceCurves = s.characterization && Array.isArray(s.characterization.curves) ? s.characterization.curves : [];
    var declared = JSON.parse(JSON.stringify(template.characterization));
    var roleUsed = {};
    declared.curves = (declared.curves || []).map(function (cu) {
      roleUsed[cu.role] = (roleUsed[cu.role] || 0) + 1;
      var seen = 0, source = null;
      for (var i = 0; i < sourceCurves.length; i++) {
        if (sourceCurves[i].role !== cu.role) continue;
        seen += 1;
        if (seen === roleUsed[cu.role]) { source = sourceCurves[i]; break; }
      }
      if (!source) return null;
      return { role: cu.role, column: source.column, label: cu.label || source.label || null };
    }).filter(function (cu) { return !!cu; });
    s.characterization = declared;
    s.axes = Object.assign({}, s.axes, { xLabel: declared.x_label || "", yLabel: declared.y_label || "" });
    s.legend = s.mapping.group ? "right" : "none";
    return s;
  }

  function kernelPreview(s, footer, template) {
    s = applyTemplateDefaults(s, template);
    var fragment = localKernel(s);
    var cachedBackend = !!fragment && /^<svg(\s|>)/i.test(fragment);
    var source = fragment ? (cachedBackend ? "Backend.renderChart" : "FigData.renderChartSVG") : "local-deterministic-fallback";
    var body = fragment ? fitRenderedSVG(recolorKernel(fragment)) : fallbackDataChart(s);
    var actualFooter = s.characterization
      ? (cachedBackend ? FOOTER_BACKEND_SPECTRUM : FOOTER_LOCAL_SPECTRUM)
      : (cachedBackend ? FOOTER_BACKEND_CHART : FOOTER_LOCAL_CHART);
    return frame('<g data-preview-renderer="' + source + '">' + body + '</g>', fragment ? actualFooter : (footer || FOOTER_CHART), source);
  }

  function numericRows(n, fn) {
    var rows = [];
    for (var i = 0; i < n; i++) rows.push(fn(i, n));
    return rows;
  }

  var G = {};
  G.bar = function () {
    return spec("bar", ["Condition", "Response"], [["Control", 2.8], ["A", 4.1], ["B", 3.5], ["C", 4.8]],
      { x: "Condition", y: "Response" }, { yLabel: "Response" });
  };
  G.barGrouped = function () {
    var values = [[2.7, 3.5], [4.2, 3.7], [3.4, 4.8]], rows = [];
    for (var i = 0; i < values.length; i++) {
      rows.push([String.fromCharCode(65 + i), values[i][0], "Control"]);
      rows.push([String.fromCharCode(65 + i), values[i][1], "Treatment"]);
    }
    return spec("bar_grouped", ["Condition", "Response", "Group"], rows,
      { x: "Condition", y: "Response", group: "Group" }, { yLabel: "Response" });
  };
  G.line = function () {
    return spec("line", ["Time", "Response"], numericRows(25, function (i) {
      return [i, 1.1 + 3.3 / (1 + Math.exp(-(i - 10) / 3.4)) + 0.1 * Math.sin(i * 0.7)];
    }), { x: "Time", y: "Response" }, { xLabel: "Time", yLabel: "Response" });
  };
  G.lineMulti = function () {
    var rows = [];
    ["Control", "A", "B"].forEach(function (group, k) {
      numericRows(19, function (i) {
        rows.push([i, 1.0 + k * 0.35 + (2.0 + k * 0.45) * Math.sin(i / 18 * Math.PI * 0.8), group]);
      });
    });
    return spec("line_multi", ["Time", "Response", "Group"], rows,
      { x: "Time", y: "Response", group: "Group" }, { xLabel: "Time", yLabel: "Response" });
  };
  G.scatter = function () {
    return spec("scatter", ["x", "y"], numericRows(28, function (i) {
      var x = 0.4 + i * 0.31;
      return [x, 0.7 + x * 0.72 + Math.sin(i * 2.17) * 0.75];
    }), { x: "x", y: "y" }, { xLabel: "Variable x", yLabel: "Variable y" });
  };
  G.box = function () {
    var rows = [];
    [[2.1, 2.7, 3.1, 3.3, 3.5, 3.8, 4.4], [2.8, 3.2, 3.5, 3.9, 4.2, 4.5, 5.0], [1.8, 2.4, 2.8, 3.0, 3.4, 3.7, 4.0]].forEach(function (values, i) {
      values.forEach(function (v) { rows.push([String.fromCharCode(65 + i), v]); });
    });
    return spec("box", ["Group", "Response"], rows, { x: "Group", y: "Response" }, { yLabel: "Response" });
  };
  G.histogram = function () {
    var values = [1.1, 1.4, 1.6, 1.9, 2.0, 2.1, 2.2, 2.3, 2.4, 2.4, 2.5, 2.5, 2.6, 2.6, 2.7, 2.7, 2.8, 2.8, 2.9, 3.0, 3.0, 3.1, 3.2, 3.3, 3.4, 3.5, 3.8, 4.1];
    return spec("histogram", ["Value"], values.map(function (v) { return [v]; }), { x: "Value" }, { xLabel: "Value", yLabel: "Count" });
  };
  G.pie = function () {
    return spec("pie", ["Class", "Share"], [["A", 42], ["B", 31], ["C", 17], ["D", 10]],
      { x: "Class", y: "Share" }, {});
  };

  var P = {};
  P.bar = function (template) { return kernelPreview(G.bar(), FOOTER_CHART, template); };
  P.bar_grouped = function (template) { return kernelPreview(G.barGrouped(), FOOTER_CHART, template); };
  P.line = function (template) { return kernelPreview(G.line(), FOOTER_CHART, template); };
  P.line_multi = function (template) { return kernelPreview(G.lineMulti(), FOOTER_CHART, template); };
  P.scatter = function (template) { return kernelPreview(G.scatter(), FOOTER_CHART, template); };
  P.box = function (template) { return kernelPreview(G.box(), FOOTER_CHART, template); };
  P.histogram = function (template) { return kernelPreview(G.histogram(), FOOTER_CHART, template); };
  P.pie = function (template) { return kernelPreview(G.pie(), FOOTER_CHART, template); };

  P.bar_stacked = function () {
    var rows = [[0.42, 0.33, 0.25], [0.55, 0.27, 0.18], [0.35, 0.4, 0.25]], out = chartFrame(28, 8, 136, 73, "Composition", "Fraction");
    for (var i = 0; i < rows.length; i++) {
      var base = 81;
      for (var j = 0; j < rows[i].length; j++) {
        var bh = 68 * rows[i][j];
        out += '<rect x="' + (47 + i * 38) + '" y="' + fmt(base - bh) + '" width="22" height="' + fmt(bh) +
          '" fill="' + SERIES[j] + '" stroke="#ffffff" stroke-width="0.7"/>';
        base -= bh;
      }
      out += text(58 + i * 38, 87, String.fromCharCode(65 + i), 6);
    }
    return frame(out);
  };

  P.marginal = function () {
    var points = [], top = [6, 12, 19, 14, 8], right = [8, 14, 19, 11, 6];
    for (var i = 0; i < 24; i++) {
      var x = 30 + i * 4.4;
      points.push([x, 75 - i * 1.7 - Math.sin(i * 1.7) * 6]);
    }
    var out = chartFrame(28, 25, 119, 57, "Variable x", "", false) + dots(points, SERIES[0], 1.45);
    for (i = 0; i < 5; i++) {
      out += '<rect x="' + (33 + i * 22) + '" y="' + (23 - top[i]) + '" width="17" height="' + top[i] + '" fill="' + SERIES[0] + '" opacity="0.65"/>';
      out += '<rect x="149" y="' + (29 + i * 10) + '" width="' + right[i] + '" height="8" fill="' + SERIES[1] + '" opacity="0.55"/>';
    }
    return frame(out);
  };

  P.paired = function () {
    var before = [67, 56, 61, 43, 49], after = [59, 46, 48, 36, 29];
    var out = chartFrame(24, 8, 139, 74, "Paired measurements", "");
    for (var i = 0; i < before.length; i++) {
      out += line(67, before[i], 118, after[i], "#cbd5e1", 1.1) +
        dots([[67, before[i]]], SERIES[0], 2.4) + dots([[118, after[i]]], SERIES[1], 2.4);
    }
    out += text(67, 90, "Before", 6.3) + text(118, 90, "After", 6.3);
    return frame(out);
  };

  P.violin = function () {
    var out = chartFrame(24, 8, 139, 74, "Distribution", "");
    [69, 116].forEach(function (cx, i) {
      var left = [], right = [];
      for (var j = 0; j <= 32; j++) {
        var t = j / 32;
        var width = 4 + 14 * Math.exp(-Math.pow((t - (0.38 + i * 0.12)) / 0.25, 2)) + 5 * Math.exp(-Math.pow((t - 0.78) / 0.13, 2));
        left.push([cx - width, 12 + t * 65]);
        right.push([cx + width, 12 + t * 65]);
      }
      var shape = left.concat(right.reverse());
      var d = shape.map(function (p, k) { return (k ? "L" : "M") + fmt(p[0]) + " " + fmt(p[1]); }).join(" ") + " Z";
      out += '<path d="' + d + '" fill="' + SERIES[i] + '" fill-opacity="0.28" stroke="' + SERIES[i] + '" stroke-width="1"/>' +
        line(cx - 6, 46 + i * 5, cx + 6, 46 + i * 5, INK, 1);
    });
    return frame(out);
  };

  P.heatmap = function () {
    var values = [[0.1, 0.24, 0.48, 0.72, 0.58], [0.18, 0.42, 0.78, 0.9, 0.64], [0.06, 0.31, 0.54, 0.67, 0.36], [0.22, 0.5, 0.83, 0.74, 0.45]];
    var out = "";
    for (var r = 0; r < 4; r++) {
      out += text(25, 27 + r * 15, "G" + (r + 1), 5.8, "end", MUTED);
      for (var c = 0; c < 5; c++) {
        var value = values[r][c];
        var color = value < 0.5 ? mix(SERIES[0], "#f8fafc", value * 2) : mix("#f8fafc", SERIES[1], (value - 0.5) * 2);
        out += '<rect x="' + (31 + c * 23) + '" y="' + (14 + r * 15) + '" width="21" height="13" rx="1" fill="' + color + '"/>';
      }
    }
    for (var c2 = 0; c2 < 5; c2++) out += text(41.5 + c2 * 23, 84, "S" + (c2 + 1), 5.8, "middle", MUTED);
    for (var k = 0; k < 18; k++) {
      out += '<rect x="153" y="' + (72 - k * 3) + '" width="7" height="3.2" fill="' + mix(SERIES[0], SERIES[1], k / 17) + '"/>';
    }
    out += text(164, 23, "high", 5.3, "start", MUTED) + text(164, 76, "low", 5.3, "start", MUTED);
    return frame(out);
  };

  P.dotplot = function () {
    var out = chartFrame(35, 7, 128, 74, "Effect size", "Group");
    var values = [[0.2, 0.46], [0.52, 0.78], [0.35, 0.64], [0.7, 0.88]];
    for (var i = 0; i < values.length; i++) {
      var y = 18 + i * 17;
      out += line(35, y, 163, y, GRID, 0.55) + text(30, y + 2, "G" + (i + 1), 5.8, "end", MUTED);
      for (var j = 0; j < 2; j++) {
        out += '<circle cx="' + (43 + values[i][j] * 111) + '" cy="' + y + '" r="' + (2.2 + values[i][j] * (j ? 3.5 : 2)) +
          '" fill="' + SERIES[j] + '" fill-opacity="0.78"/>';
      }
    }
    return frame(out);
  };

  P.roc = function () {
    var out = chartFrame(30, 7, 132, 73, "1 − specificity", "Sensitivity");
    var diagonal = [[30, 80], [162, 7]];
    out += pathLine(diagonal, "#94a3b8", 0.75, ' stroke-dasharray="3 2"');
    [0, 1].forEach(function (k) {
      var points = numericRows(41, function (i, n) {
        var t = i / (n - 1);
        return [30 + 132 * t, 80 - 73 * Math.pow(t, 0.34 + k * 0.25)];
      });
      out += pathLine(points, SERIES[k], 1.15);
    });
    out += text(117, 57, "ROC", 6.5, "middle", MUTED);
    return frame(out);
  };

  P.volcano = function () {
    var out = chartFrame(31, 7, 130, 73, "Effect", "−log10 p");
    var neutral = [], left = [], right = [];
    for (var i = 0; i < 46; i++) {
      var x = 40 + (i * 37 % 113);
      var y = 75 - (i * 19 % 35) - Math.abs(x - 96) * 0.18;
      var p = [x, y];
      if (x < 67 && y < 48) left.push(p);
      else if (x > 126 && y < 48) right.push(p);
      else neutral.push(p);
    }
    out += dots(neutral, "#94a3b8", 1.25) + dots(left, SERIES[0], 1.5) + dots(right, SERIES[1], 1.5) +
      line(70, 7, 70, 80, MUTED, 0.65, "3 2") + line(122, 7, 122, 80, MUTED, 0.65, "3 2") +
      line(31, 50, 161, 50, MUTED, 0.65, "3 2");
    return frame(out);
  };

  P.forest = function () {
    var studies = [{ e: -0.55, ci: 0.28 }, { e: 0.2, ci: 0.4 }, { e: -0.08, ci: 0.22 }, { e: 0.55, ci: 0.32 }];
    var out = text(14, 9, "Study", 6, "start", MUTED) + text(126, 9, "Effect (95% CI)", 6, "middle", MUTED);
    var x0 = 62, x1 = 163, center = 111;
    out += line(center, 12, center, 77, MUTED, 0.65, "3 2");
    studies.forEach(function (s, i) {
      var y = 20 + i * 14, x = center + s.e * 40, half = s.ci * 40;
      out += text(14, y + 2, String.fromCharCode(65 + i), 6.1, "start") +
        line(x - half, y, x + half, y, INK, 0.9) + line(x - half, y - 2, x - half, y + 2, INK, 0.7) +
        line(x + half, y - 2, x + half, y + 2, INK, 0.7) +
        '<rect x="' + fmt(x - 2.2) + '" y="' + (y - 2.2) + '" width="4.4" height="4.4" fill="' + SERIES[0] + '"/>';
    });
    out += '<path d="M108 78 L115 83 L108 88 L101 83 Z" fill="' + SERIES[1] + '"/>' +
      text(61, 91, "← left", 5.6, "start", MUTED) + text(163, 91, "right →", 5.6, "end", MUTED);
    return frame(out);
  };

  P.survival = function () {
    var out = chartFrame(28, 5, 134, 57, "Time", "Survival");
    var a = [[28, 5], [62, 5], [62, 16], [88, 16], [88, 28], [124, 28], [124, 41], [162, 41]];
    var b = [[28, 5], [50, 5], [50, 20], [79, 20], [79, 35], [110, 35], [110, 51], [162, 51]];
    out += pathLine(a, SERIES[0], 1.15) + pathLine(b, SERIES[1], 1.15) +
      line(62, 5, 60, 9, SERIES[0], 0.8) + line(88, 16, 86, 20, SERIES[0], 0.8) +
      line(79, 20, 77, 24, SERIES[1], 0.8) + line(110, 35, 108, 39, SERIES[1], 0.8);
    out += text(28, 74, "At risk", 5.8, "start", MUTED) + text(50, 74, "A", 5.8, "start", SERIES[0]) + text(50, 85, "B", 5.8, "start", SERIES[1]);
    var va = [18, 14, 9], vb = [18, 11, 6];
    [82, 119, 156].forEach(function (x, i) {
      out += line(x, 62, x, 91, GRID, 0.5) + text(x, 75, va[i], 6) + text(x, 86, vb[i], 6);
    });
    return frame(out);
  };

  P.pca = function () {
    var a = [], b = [];
    for (var i = 0; i < 14; i++) {
      a.push([51 + Math.sin(i * 2.3) * 17, 57 + Math.cos(i * 1.7) * 10]);
      b.push([122 + Math.sin(i * 1.9) * 15, 31 + Math.cos(i * 2.1) * 11]);
    }
    var out = chartFrame(25, 7, 137, 74, "PC1", "PC2") +
      '<ellipse cx="51" cy="57" rx="25" ry="16" fill="' + SERIES[0] + '" fill-opacity="0.08" stroke="' + SERIES[0] + '" stroke-width="0.8"/>' +
      '<ellipse cx="122" cy="31" rx="24" ry="17" fill="' + SERIES[1] + '" fill-opacity="0.08" stroke="' + SERIES[1] + '" stroke-width="0.8"/>' +
      dots(a, SERIES[0], 1.55) + dots(b, SERIES[1], 1.55);
    return frame(out);
  };

  P.venn = function () {
    return frame(
      '<circle cx="72" cy="42" r="26" fill="' + SERIES[0] + '" fill-opacity="0.3" stroke="' + SERIES[0] + '" stroke-width="0.9"/>' +
      '<circle cx="108" cy="42" r="26" fill="' + SERIES[1] + '" fill-opacity="0.28" stroke="' + SERIES[1] + '" stroke-width="0.9"/>' +
      '<circle cx="90" cy="65" r="24" fill="' + SERIES[2] + '" fill-opacity="0.24" stroke="' + SERIES[2] + '" stroke-width="0.9"/>' +
      text(53, 30, "A", 7, "middle", INK, "bold") + text(127, 30, "B", 7, "middle", INK, "bold") + text(90, 88, "C", 7, "middle", INK, "bold"));
  };

  P.sankey = function () {
    var out = "";
    var left = [18, 43, 68], right = [29, 65];
    for (var i = 0; i < 3; i++) out += '<rect x="20" y="' + left[i] + '" width="7" height="14" rx="1" fill="' + SERIES[i] + '"/>';
    for (i = 0; i < 2; i++) out += '<rect x="153" y="' + right[i] + '" width="7" height="18" rx="1" fill="' + SERIES[i + 3] + '"/>';
    var flows = [[25, 36, 8, 0], [50, 36, 5, 1], [50, 73, 9, 1], [75, 73, 11, 2], [25, 73, 4, 0]];
    flows.forEach(function (f) {
      out += '<path d="M27 ' + f[0] + ' C76 ' + f[0] + ' 104 ' + f[1] + ' 153 ' + f[1] + '" fill="none" stroke="' + SERIES[f[3]] + '" stroke-width="' + f[2] + '" stroke-opacity="0.33"/>';
    });
    out += text(23, 90, "Source", 5.8) + text(157, 90, "Target", 5.8);
    return frame(out);
  };

  P.taylor = function () {
    var out = '<path d="M32 82 A58 58 0 0 1 148 82" fill="#fcfdff" stroke="' + INK + '" stroke-width="0.75"/>';
    [20, 38, 56].forEach(function (r) {
      out += '<path d="M' + (90 - r) + ' 82 A' + r + ' ' + r + ' 0 0 1 ' + (90 + r) + ' 82" fill="none" stroke="' + GRID + '" stroke-width="0.6"/>';
    });
    out += line(90, 82, 44, 39, GRID, 0.55) + line(90, 82, 90, 24, GRID, 0.55) + line(90, 82, 136, 39, GRID, 0.55);
    [[52, 49], [77, 34], [111, 39], [132, 57]].forEach(function (p, i) { out += dots([p], SERIES[i], 2.2); });
    out += dots([[90, 82]], INK, 2.2) + text(90, 92, "Reference", 5.8) + text(66, 20, "Correlation", 5.8);
    return frame(out);
  };

  function miniLine(x, y, w, h, color) {
    var points = numericRows(15, function (i, n) {
      return [x + i / (n - 1) * w, y + h * (0.78 - i / (n - 1) * 0.5 - Math.sin(i * 0.8) * 0.08)];
    });
    return pathLine(points, color, 0.85);
  }

  function miniBar(x, y, w, h, color) {
    var heights = [0.38, 0.7, 0.52, 0.86], out = "";
    heights.forEach(function (v, i) {
      var bw = w / 5.8;
      out += '<rect x="' + fmt(x + i * w / 4 + bw * 0.25) + '" y="' + fmt(y + h * (1 - v)) + '" width="' + fmt(bw) + '" height="' + fmt(h * v) + '" fill="' + color + '"/>';
    });
    return out;
  }

  function miniScatter(x, y, w, h, color) {
    var points = numericRows(9, function (i, n) {
      return [x + i / (n - 1) * w, y + h * (0.85 - i / (n - 1) * 0.58 + Math.sin(i * 2) * 0.07)];
    });
    return dots(points, color, 1);
  }

  function miniHeat(x, y, w, h) {
    var values = [0.15, 0.5, 0.82, 0.35, 0.9, 0.55, 0.1, 0.62, 0.4, 0.75, 0.28, 0.68], out = "";
    for (var i = 0; i < 12; i++) {
      out += '<rect x="' + fmt(x + (i % 3) * w / 3) + '" y="' + fmt(y + Math.floor(i / 3) * h / 4) +
        '" width="' + fmt(w / 3 - 0.35) + '" height="' + fmt(h / 4 - 0.35) + '" fill="' + mix(SERIES[0], SERIES[1], values[i]) + '"/>';
    }
    return out;
  }

  function miniSpectra(x, y, w, h, color) {
    var raw = numericRows(45, function (i, n) {
      var t = i / (n - 1);
      var v = 0.12 + gaussian(t, 0.34, 0.08, 0.7) + gaussian(t, 0.62, 0.12, 0.38);
      return [x + t * w, y + h * (1 - v)];
    });
    var fit = raw.map(function (p, i) { return [p[0], p[1] + (i % 3 - 1) * 0.3 + 1.2]; });
    return pathLine(fit, SERIES[(SERIES.indexOf(color) + 1) % SERIES.length], 0.65, ' stroke-dasharray="2 1.5"') + pathLine(raw, color, 0.85);
  }

  function miniSchematic(x, y, w, h, color) {
    var bw = Math.min(18, w * 0.34), bh = Math.max(5, Math.min(11, h * 0.55));
    return dnode(x, y + (h - bh) / 2, bw, bh, "", soft(color)) +
      dnode(x + w - bw, y + (h - bh) / 2, bw, bh, "", "#f1f5f9") +
      darrow(x + bw, y + h / 2, x + w - bw, y + h / 2);
  }

  function miniBox(x, y, w, h, color) {
    return line(x + w / 2, y + 1, x + w / 2, y + h - 1, INK, 0.6) +
      '<rect x="' + fmt(x + w * 0.24) + '" y="' + fmt(y + h * 0.24) + '" width="' + fmt(w * 0.52) + '" height="' + fmt(h * 0.52) + '" fill="' + soft(color) + '" stroke="' + INK + '" stroke-width="0.6"/>' +
      line(x + w * 0.24, y + h * 0.52, x + w * 0.76, y + h * 0.52, INK, 0.8);
  }

  var MINI = {
    bar: miniBar,
    line: miniLine,
    scatter: miniScatter,
    heat: miniHeat,
    spectra: miniSpectra,
    schematic: miniSchematic,
    box: miniBox
  };

  function panelsGridPainted(cols, rows, kinds, footer) {
    var out = "", pw = 164 / cols, ph = 88 / rows;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c, x = 8 + c * pw, y = 5 + r * ph;
        var w = pw - 4, h = ph - 4;
        var fn = MINI[(kinds && kinds[i]) || "bar"] || miniBar;
        out += '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) + '" rx="1" fill="#fcfdff" stroke="#cbd5e1" stroke-width="0.65"/>';
        out += fn(x + 4, y + 5, Math.max(5, w - 9), Math.max(4, h - 10), SERIES[i % SERIES.length]);
        out += text(x + 3, y + 8, String.fromCharCode(97 + i), 6.4, "start", INK, "bold");
      }
    }
    return frame(out, footer || FOOTER_COMPOSITE);
  }

  function dnode(x, y, w, h, label, fill) {
    return '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) + '" rx="3" fill="' + (fill || soft(SERIES[0])) + '" stroke="#94a3b8" stroke-width="0.75"/>' +
      (label ? text(x + w / 2, y + h / 2 + 2.2, label, 6.1) : "");
  }

  function dhead(x, y, ux, uy) {
    var px = -uy, py = ux;
    return '<path d="M' + fmt(x) + ' ' + fmt(y) + ' L' + fmt(x - ux * 4.5 + px * 2) + ' ' + fmt(y - uy * 4.5 + py * 2) +
      ' L' + fmt(x - ux * 4.5 - px * 2) + ' ' + fmt(y - uy * 4.5 - py * 2) + ' Z" fill="' + MUTED + '"/>';
  }

  function darrow(x1, y1, x2, y2, dash) {
    var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    return line(x1, y1, x2 - ux * 4.5, y2 - uy * 4.5, MUTED, 0.9, dash ? "3 2" : null) + dhead(x2, y2, ux, uy);
  }

  function dpathArrow(points, dash) {
    var last = points.length - 1;
    var dx = points[last][0] - points[last - 1][0], dy = points[last][1] - points[last - 1][1];
    var len = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / len, uy = dy / len;
    var shortened = points.slice(0, last).concat([[points[last][0] - ux * 4.5, points[last][1] - uy * 4.5]]);
    return pathLine(shortened, MUTED, 0.9, dash ? ' stroke-dasharray="3 2"' : "") + dhead(points[last][0], points[last][1], ux, uy);
  }

  function ddiamond(cx, cy, w, h, label) {
    return '<path d="M' + cx + ' ' + (cy - h / 2) + ' L' + (cx + w / 2) + ' ' + cy + ' L' + cx + ' ' + (cy + h / 2) + ' L' + (cx - w / 2) + ' ' + cy + ' Z" fill="' + soft(SERIES[1]) + '" stroke="#94a3b8" stroke-width="0.75"/>' + text(cx, cy + 2, label, 6);
  }

  function diagramPreview(inner) {
    return frame(inner, FOOTER_DIAGRAM);
  }

  function templateGrid(template, cols, rows, kinds, footer) {
    var layout = template && Array.isArray(template.panels) ? template.panels : [cols, rows];
    return panelsGridPainted(layout[0] || cols, layout[1] || rows, kinds, footer);
  }

  var T = {};
  T["tpl-composite-2x2"] = function (template) { return templateGrid(template, 2, 2, ["scatter", "line", "bar", "heat"]); };
  T["tpl-composite-1x3"] = function (template) { return templateGrid(template, 3, 1, ["bar", "line", "scatter"]); };
  T["tpl-composite-1x2-v"] = function (template) { return templateGrid(template, 1, 2, ["line", "scatter"]); };
  T["tpl-composite-1x3-v"] = function (template) { return templateGrid(template, 1, 3, ["line", "bar", "box"]); };
  T["tpl-composite-1x4-v"] = function (template) { return templateGrid(template, 1, 4, ["line", "spectra", "scatter", "bar"]); };
  T["tpl-composite-1x4-h"] = function (template) { return templateGrid(template, 4, 1, ["bar", "line", "box", "scatter"]); };
  T["tpl-composite-3x2"] = function (template) { return templateGrid(template, 3, 2, ["schematic", "bar", "line", "heat", "scatter", "box"]); };
  T["tpl-composite-2x3"] = function (template) { return templateGrid(template, 2, 3, ["bar", "heat", "line", "scatter", "box", "schematic"]); };
  T["tpl-composite-4x2"] = function (template) { return templateGrid(template, 4, 2, ["bar", "line", "scatter", "box", "heat", "spectra", "line", "schematic"]); };
  T["tpl-composite-2x4"] = function (template) { return templateGrid(template, 2, 4, ["heat", "line", "bar", "scatter", "spectra", "box", "line", "bar"]); };
  T["tpl-composite-3x3"] = function (template) { return templateGrid(template, 3, 3, ["bar", "line", "scatter", "heat", "schematic", "box", "spectra", "scatter", "line"]); };
  T["tpl-composite-schematic"] = function (template) { return templateGrid(template, 2, 1, ["schematic", "bar"]); };

  T["tpl-diagram-flow"] = function () {
    var out = "", xs = [14, 72, 130], names = ["Input", "Process", "Output"];
    xs.forEach(function (x, i) {
      out += dnode(x, 35, 36, 21, names[i]);
      if (i < 2) out += darrow(x + 36, 45.5, xs[i + 1], 45.5);
    });
    return diagramPreview(out);
  };
  T["tpl-diagram-arch"] = function () {
    var out = "", ys = [10, 37, 64], names = ["Input layer", "Model layer", "Output layer"];
    ys.forEach(function (y, i) {
      out += dnode(35, y, 110, 18, names[i]);
      if (i < 2) out += darrow(90, y + 18, 90, ys[i + 1]);
    });
    return diagramPreview(out);
  };
  T["tpl-diagram-pipeline"] = function () {
    var out = "", xs = [10, 53, 96, 139], names = ["采集", "清洗", "训练", "输出"];
    xs.forEach(function (x, i) {
      out += dnode(x, 35, 31, 22, names[i], soft(SERIES[i % SERIES.length]));
      if (i < 3) out += darrow(x + 31, 46, xs[i + 1], 46);
    });
    return diagramPreview(out);
  };
  T["tpl-diagram-decision"] = function () {
    return diagramPreview(dnode(10, 35, 30, 20, "开始") + darrow(40, 45, 66, 45) + ddiamond(90, 45, 46, 30, "达标?") +
      darrow(113, 45, 139, 45) + dnode(139, 35, 32, 20, "完成") + text(119, 37, "是", 5.8) +
      dpathArrow([[90, 60], [90, 77]]) + text(98, 72, "否", 5.8, "start") + dnode(74, 77, 32, 14, "迭代", soft(SERIES[2])));
  };
  T["tpl-diagram-loop"] = function () {
    var out = "", xs = [13, 70, 127], names = ["预处理", "迭代优化", "验证"];
    xs.forEach(function (x, i) {
      out += dnode(x, 43, 38, 19, names[i], soft(SERIES[i]));
      if (i < 2) out += darrow(x + 38, 52.5, xs[i + 1], 52.5);
    });
    out += dpathArrow([[146, 43], [146, 24], [32, 24], [32, 43]], true) + text(90, 18, "Feedback", 6);
    return diagramPreview(out);
  };
  T["tpl-diagram-experiment"] = function () {
    return diagramPreview(dnode(8, 38, 30, 18, "样本") + dpathArrow([[38, 47], [51, 47], [51, 25], [58, 25]]) +
      dpathArrow([[51, 47], [51, 70], [58, 70]]) + dnode(58, 17, 37, 16, "处理组", soft(SERIES[1])) + dnode(58, 62, 37, 16, "对照组", soft(SERIES[0])) +
      dpathArrow([[95, 25], [105, 25], [105, 47], [112, 47]]) + dpathArrow([[95, 70], [105, 70], [105, 47], [112, 47]]) +
      dnode(112, 38, 27, 19, "测定") + darrow(139, 47.5, 147, 47.5) + dnode(147, 38, 27, 19, "分析", soft(SERIES[2])));
  };
  T["tpl-diagram-swimlane"] = function () {
    var out = '<rect x="10" y="10" width="160" height="34" rx="2" fill="#f8fafc" stroke="#cbd5e1" stroke-width="0.65"/>' +
      '<rect x="10" y="53" width="160" height="34" rx="2" fill="' + soft(SERIES[0]) + '" stroke="#cbd5e1" stroke-width="0.65"/>';
    out += text(16, 22, "平台", 5.8, "start", MUTED) + text(16, 65, "实验", 5.8, "start", MUTED) +
      dnode(36, 18, 36, 17, "调度") + dnode(112, 18, 36, 17, "统计") + dnode(36, 61, 36, 17, "制样") + dnode(112, 61, 36, 17, "复测") +
      darrow(72, 26.5, 112, 26.5) + darrow(54, 35, 54, 61) + darrow(72, 69.5, 112, 69.5) + darrow(130, 35, 130, 61);
    return diagramPreview(out);
  };
  T["tpl-diagram-timeline"] = function () {
    var out = darrow(12, 54, 168, 54), xs = [32, 70, 108, 146];
    xs.forEach(function (x, i) {
      out += line(x, 54, x, 38, MUTED, 0.75) + '<circle cx="' + x + '" cy="54" r="4" fill="' + SERIES[i] + '" stroke="#fff" stroke-width="1"/>' + text(x, 31, "阶段" + (i + 1), 6.1);
    });
    return diagramPreview(out);
  };
  T["tpl-diagram-hierarchy"] = function () {
    var out = dnode(68, 7, 44, 16, "研究目标"), xs = [12, 68, 124];
    xs.forEach(function (x, i) {
      out += dpathArrow([[90, 23], [90, 32], [x + 22, 32], [x + 22, 40]]) + dnode(x, 40, 44, 16, "模块 " + String.fromCharCode(65 + i), soft(SERIES[i])) +
        darrow(x + 22, 56, x + 22, 67) + dnode(x, 67, 44, 15, "子项 " + (i + 1), "#f8fafc");
    });
    return diagramPreview(out);
  };
  T["tpl-diagram-model"] = function () {
    var out = "";
    for (var i = 0; i < 3; i++) out += dnode(8, 26 + i * 16, 24, 12, "", "#f8fafc");
    out += text(20, 22, "输入", 5.8) + darrow(32, 50, 43, 50) + dnode(43, 22, 43, 55, "Encoder", soft(SERIES[0])) +
      darrow(86, 50, 97, 50) + dnode(97, 22, 43, 55, "Decoder", soft(SERIES[1])) + darrow(140, 50, 151, 50) + dnode(151, 40, 23, 20, "输出", soft(SERIES[2]));
    [39, 50, 61].forEach(function (y) { out += line(49, y, 80, y, "#94a3b8", 0.55) + line(103, y, 134, y, "#94a3b8", 0.55); });
    return diagramPreview(out);
  };
  T["tpl-diagram-compare"] = function () {
    var out = text(38, 13, "Baseline", 6.5) + text(142, 13, "Proposed", 6.5), ys = [21, 43, 65];
    ys.forEach(function (y, i) {
      out += dnode(15, y, 46, 15, "Step " + (i + 1), "#f1f5f9") + dnode(119, y, 46, 15, "Step " + (i + 1), soft(SERIES[1]));
      if (i < 2) out += darrow(38, y + 15, 38, ys[i + 1]) + darrow(142, y + 15, 142, ys[i + 1]);
    });
    out += dpathArrow([[61, 29], [90, 29], [119, 29]], true);
    return diagramPreview(out);
  };

  function charBase(technique, xLabel, yLabel, reverse, normalize, offset) {
    return {
      technique: technique,
      x_reverse: !!reverse,
      x_scale: "linear",
      x_label: xLabel,
      y_label: yLabel,
      curves: [],
      fit_model: null,
      fit_source: null,
      peak_annotations: [],
      normalize: normalize || "none",
      offset_each_series: offset == null ? null : offset
    };
  }

  G.xpsSurvey = function () {
    var rows = numericRows(401, function (i, n) {
      var x = 1200 - i * 1200 / (n - 1);
      var y = 0.06 + 0.1 * x / 1200 + gaussian(x, 984, 12, 0.32) + gaussian(x, 532, 16, 0.72) +
        gaussian(x, 402, 10, 0.24) + gaussian(x, 285, 8, 0.9) + gaussian(x, 106, 13, 0.42) + 0.004 * Math.sin(i * 1.71);
      return [x, y];
    });
    return spec("line", ["Binding energy", "raw"], rows, { x: "Binding energy", y: "raw" }, {},
      charBase("XPS survey", "Binding energy (eV)", "Intensity (counts)", true));
  };

  G.xpsFit = function () {
    var columns = ["Binding energy", "raw", "fit", "baseline", "component 1", "component 2"];
    var rows = numericRows(401, function (i, n) {
      var x = 296 - i * 20 / (n - 1);
      var c1 = gaussian(x, 288.6, 0.7, 0.82), c2 = gaussian(x, 285.1, 0.95, 0.46) + gaussian(x, 291.7, 0.5, 0.13);
      var base = 0.045 + (296 - x) * 0.0015;
      var fit = base + c1 + c2;
      var raw = fit + 0.005 * Math.sin(i * 1.91) + 0.003 * Math.cos(i * 0.73);
      return [x, raw, fit, base, c1 + base * 0.25, c2 + base * 0.25];
    });
    var ch = charBase("XPS high-resolution", "Binding energy (eV)", "Intensity (counts)", true);
    ch.fit_source = "synthetic_preview_curve";
    ch.curves = [
      { role: "fit", column: "fit", label: "fit" },
      { role: "baseline", column: "baseline", label: "base" },
      { role: "component", column: "component 1", label: "c1" },
      { role: "component", column: "component 2", label: "c2" }
    ];
    return spec("line", columns, rows, { x: "Binding energy", y: "raw" }, {}, ch);
  };

  G.raman = function () {
    var rows = numericRows(401, function (i, n) {
      var x = 200 + i * 1800 / (n - 1);
      var y = 0.055 + gaussian(x, 610, 32, 0.92) + gaussian(x, 910, 45, 0.26) +
        gaussian(x, 1440, 52, 0.7) + gaussian(x, 1690, 34, 0.2) + 0.004 * Math.sin(i * 1.47);
      return [x, y];
    });
    return spec("line", ["Raman shift", "raw"], rows, { x: "Raman shift", y: "raw" }, {},
      charBase("Raman", "Raman shift (cm⁻¹)", "Intensity (a.u.)", false));
  };

  G.ramanMulti = function () {
    var rows = [];
    ["S1", "S2", "S3"].forEach(function (group, k) {
      numericRows(201, function (i, n) {
        var x = 200 + i * 1800 / (n - 1);
        var y = 0.05 + gaussian(x, 610 + k * 13, 35, 0.8 + k * 0.08) + gaussian(x, 910 + k * 8, 45, 0.22 + k * 0.025) +
          gaussian(x, 1440 - k * 11, 52, 0.58 + k * 0.07) + gaussian(x, 1690, 38, 0.16 + k * 0.025);
        rows.push([x, y, group]);
      });
    });
    var ch = charBase("Raman", "Raman shift (cm⁻¹)", "Intensity (a.u.)", false, "max_to_unity", null);
    return spec("line_multi", ["Raman shift", "Intensity", "Sample"], rows,
      { x: "Raman shift", y: "Intensity", group: "Sample" }, {}, ch);
  };

  G.xrd = function () {
    var rows = numericRows(401, function (i, n) {
      var x = 10 + i * 70 / (n - 1);
      var y = 0.035 + gaussian(x, 22.8, 0.4, 0.36) + gaussian(x, 31.7, 0.28, 0.72) + gaussian(x, 38.4, 0.32, 0.25) +
        gaussian(x, 45.5, 0.36, 0.9) + gaussian(x, 65.2, 0.4, 0.55);
      return [x, y];
    });
    return spec("line", ["2 theta", "Intensity"], rows, { x: "2 theta", y: "Intensity" }, {},
      charBase("XRD", "2θ (°)", "Intensity (counts)", false));
  };

  G.ftir = function () {
    var rows = numericRows(401, function (i, n) {
      var x = 400 + i * 3600 / (n - 1);
      var y = 0.94 - gaussian(x, 1060, 65, 0.32) - gaussian(x, 1650, 50, 0.18) - gaussian(x, 2920, 85, 0.45) - gaussian(x, 3400, 150, 0.28);
      return [x, y];
    });
    return spec("line", ["Wavenumber", "Transmittance"], rows, { x: "Wavenumber", y: "Transmittance" }, {},
      charBase("FTIR", "Wavenumber (cm⁻¹)", "Transmittance (%)", false));
  };

  G.uvpl = function () {
    var rows = [];
    ["Absorbance", "Emission"].forEach(function (group, k) {
      numericRows(201, function (i, n) {
        var x = 250 + i * 500 / (n - 1);
        var y = k === 0 ? 0.04 + gaussian(x, 390, 48, 0.78) + gaussian(x, 520, 30, 0.2) : 0.035 + gaussian(x, 610, 55, 0.84);
        rows.push([x, y, group]);
      });
    });
    return spec("line_multi", ["Wavelength", "Signal", "Mode"], rows,
      { x: "Wavelength", y: "Signal", group: "Mode" }, {}, charBase("UV-Vis/PL", "Wavelength (nm)", "Intensity (a.u.)", false));
  };

  G.nyquist = function () {
    var rows = numericRows(60, function (i, n) {
      var t = i / (n - 1), theta = Math.PI * Math.min(1, t * 1.35);
      return [12 + 43 * (1 - Math.cos(theta)) + Math.max(0, t - 0.74) * 75,
        2 + 40 * Math.sin(theta) + Math.max(0, t - 0.74) * 28];
    });
    return spec("scatter", ["Z real", "minus Z imag"], rows, { x: "Z real", y: "minus Z imag" },
      { xLabel: "Z′ (Ω)", yLabel: "−Z″ (Ω)" }, charBase("EIS Nyquist", "Z′ (Ω)", "−Z″ (Ω)", false));
  };

  G.bode = function () {
    var rows = numericRows(201, function (i, n) {
      var logf = -1 + 7 * i / (n - 1);
      return [Math.pow(10, logf), 18 + 900 / (1 + Math.pow(10, (logf - 2.3) * 1.2))];
    });
    var ch = charBase("EIS Bode", "Frequency (Hz)", "|Z| (Ω)", false);
    ch.x_scale = "log10";
    return spec("line", ["Frequency", "Impedance"], rows, { x: "Frequency", y: "Impedance" }, {}, ch);
  };

  G.cv = function () {
    var rows = [];
    ["Cycle 1", "Cycle 2"].forEach(function (group, k) {
      numericRows(240, function (i, n) {
        var t = i / (n - 1) * Math.PI * 2;
        var x = 0.45 * Math.cos(t);
        var y = 0.56 * Math.sin(t) + gaussian(x, 0.18, 0.11, 0.28) - gaussian(x, -0.2, 0.13, 0.24) + k * 0.05 * Math.sin(t);
        rows.push([x, y, group]);
      });
    });
    return spec("line_multi", ["Potential", "Current", "Cycle"], rows,
      { x: "Potential", y: "Current", group: "Cycle" }, {}, charBase("CV", "Potential (V)", "Current (A)", false));
  };

  G.stress = function () {
    var rows = [];
    ["A", "B"].forEach(function (group, k) {
      numericRows(160, function (i, n) {
        var x = i * 12 / (n - 1);
        var y = k === 0 ? 110 * (1 - Math.exp(-x * 1.8)) + 3.2 * x : 84 * (1 - Math.exp(-x * 2.2)) + 2.3 * x - Math.max(0, x - 8) * 8;
        rows.push([x, Math.max(0, y), group]);
      });
    });
    return spec("line_multi", ["Strain", "Stress", "Specimen"], rows,
      { x: "Strain", y: "Stress", group: "Specimen" }, {}, charBase("Tensile", "Strain (%)", "Stress (MPa)", false));
  };

  G.particle = function () {
    var values = [12, 15, 18, 20, 22, 24, 25, 27, 28, 30, 30, 31, 32, 33, 34, 35, 35, 36, 37, 38, 39, 40, 42, 44, 48, 52, 58];
    return spec("histogram", ["Diameter"], values.map(function (v) { return [v]; }), { x: "Diameter" },
      { xLabel: "Particle size (nm)", yLabel: "Count" }, charBase("PSD", "Particle size (nm)", "Count", false));
  };

  G.nmr = function () {
    var rows = numericRows(401, function (i, n) {
      var x = 12 - i * 12 / (n - 1);
      var y = 0.025 + gaussian(x, 9.8, 0.08, 0.28) + gaussian(x, 7.25, 0.055, 0.55) + gaussian(x, 4.1, 0.07, 0.75) +
        gaussian(x, 2.5, 0.06, 0.36) + gaussian(x, 1.2, 0.05, 0.48);
      return [x, y];
    });
    return spec("line", ["Chemical shift", "Intensity"], rows, { x: "Chemical shift", y: "Intensity" }, {},
      charBase("NMR", "Chemical shift (ppm)", "Intensity (a.u.)", true));
  };

  function scientificPanels(template) {
    var layout = template && Array.isArray(template.panels) ? template.panels : [2, 1];
    var cols = Math.max(1, Math.floor(Number(layout[0]) || 2));
    var rows = Math.max(1, Math.floor(Number(layout[1]) || 1));
    var pw = 164 / cols, ph = 88 / rows, out = "", allKernel = true, allBackend = true;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c, x = 8 + c * pw, y = 5 + r * ph;
        var w = pw - 4, h = ph - 4, s = G.xpsSurvey();
        if (cols * rows === 2) {
          var region = i === 0 ? [270, 310] : [520, 550];
          s.data.inline.rows = s.data.inline.rows.filter(function (row) { return row[0] >= region[0] && row[0] <= region[1]; });
        }
        applyTemplateDefaults(s, template);
        var fragment = localKernel(s), body, source;
        if (fragment) {
          var cachedBackend = /^<svg(\s|>)/i.test(fragment);
          source = cachedBackend ? "Backend.renderChart" : "FigData.renderChartSVG";
          if (!cachedBackend) allBackend = false;
          body = fitRenderedSVG(recolorKernel(fragment), x, y, w, h);
        } else {
          source = "local-deterministic-fallback";
          allKernel = false;
          allBackend = false;
          body = fitRenderedSVG(fallbackDataChart(s), x, y, w, h);
        }
        out += '<g data-preview-panel="' + String.fromCharCode(97 + i) + '" data-preview-renderer="' + source + '">' +
          '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) +
          '" rx="1" fill="#fcfdff" stroke="#cbd5e1" stroke-width="0.65"/>' + body +
          text(x + 3, y + 8, String.fromCharCode(97 + i), 6.4, "start", INK, "bold") + '</g>';
      }
    }
    var actualSource = allBackend ? "Backend.renderChart" : "FigData.renderChartSVG";
    return frame(out, allKernel ? (allBackend ? FOOTER_BACKEND_SPECTRUM : FOOTER_LOCAL_SPECTRUM) : FOOTER_SPECTRUM,
      allKernel ? actualSource : "local-deterministic-fallback");
  }

  T["tpl-xps-survey"] = function (template) { return kernelPreview(G.xpsSurvey(), FOOTER_SPECTRUM, template); };
  T["tpl-xps-highres-fit"] = function (template) { return kernelPreview(G.xpsFit(), FOOTER_SPECTRUM, template); };
  T["tpl-xps-two-regions"] = function (template) { return scientificPanels(template); };
  T["tpl-raman-single"] = function (template) { return kernelPreview(G.raman(), FOOTER_SPECTRUM, template); };
  T["tpl-raman-multi-compare"] = function (template) { return kernelPreview(G.ramanMulti(), FOOTER_SPECTRUM, template); };
  T["tpl-xrd"] = function (template) { return kernelPreview(G.xrd(), FOOTER_SPECTRUM, template); };
  T["tpl-ftir"] = function (template) { return kernelPreview(G.ftir(), FOOTER_SPECTRUM, template); };
  T["tpl-uvvis-pl"] = function (template) { return kernelPreview(G.uvpl(), FOOTER_SPECTRUM, template); };
  T["tpl-eis-nyquist"] = function (template) { return kernelPreview(G.nyquist(), FOOTER_SPECTRUM, template); };
  T["tpl-eis-bode"] = function (template) { return kernelPreview(G.bode(), FOOTER_SPECTRUM, template); };
  T["tpl-cv"] = function (template) { return kernelPreview(G.cv(), FOOTER_SPECTRUM, template); };
  T["tpl-stress-strain"] = function (template) { return kernelPreview(G.stress(), FOOTER_SPECTRUM, template); };
  T["tpl-particle-size"] = function (template) { return kernelPreview(G.particle(), FOOTER_SPECTRUM, template); };
  T["tpl-nmr"] = function (template) { return kernelPreview(G.nmr(), FOOTER_SPECTRUM, template); };

  function byTemplateId(template) {
    if (global.FigDiagram && typeof global.FigDiagram.supportsTemplate === "function" &&
        global.FigDiagram.supportsTemplate(template).supported) {
      var raw = global.FigDiagram.example(template.id, true);
      var actual = global.FigDiagram.previewSVG(raw);
      return frame(fitRenderedSVG(actual, 0, 0, W, 94),
        "FigDiagram 原生矢量 · 合成示例非论文/官方案例", "FigDiagram+FigRender");
    }
    return T[template.id] ? T[template.id](template) : null;
  }

  function tagTemplate(markup, template) {
    return markup.replace("<svg ", '<svg data-template-id="' + esc(template.id) + '" ');
  }

  function svg(template, opts) {
    if (!template) return null;
    SERIES = seriesFrom(opts && opts.colors);
    try {
      var out = byTemplateId(template);
      if (!out && P[template.chart_type || ""]) out = P[template.chart_type || ""](template);
      if (!out && template.category === "composite") out = templateGrid(template, 2, 2, null);
      if (!out && template.category === "diagram") out = T["tpl-diagram-flow"](template);
      if (!out) out = frame(fallbackEmpty("该类型暂无实际内核预览"), FOOTER_CHART);
      return tagTemplate(out, template);
    } finally {
      SERIES = DEFAULT_SERIES;
    }
  }

  function specForTemplate(template) {
    var makers = {
      "tpl-xps-survey": G.xpsSurvey,
      "tpl-xps-highres-fit": G.xpsFit,
      "tpl-raman-single": G.raman,
      "tpl-raman-multi-compare": G.ramanMulti,
      "tpl-xrd": G.xrd,
      "tpl-ftir": G.ftir,
      "tpl-uvvis-pl": G.uvpl,
      "tpl-eis-nyquist": G.nyquist,
      "tpl-eis-bode": G.bode,
      "tpl-cv": G.cv,
      "tpl-stress-strain": G.stress,
      "tpl-particle-size": G.particle,
      "tpl-nmr": G.nmr
    };
    var generic = {
      bar: G.bar,
      bar_grouped: G.barGrouped,
      line: G.line,
      line_multi: G.lineMulti,
      scatter: G.scatter,
      box: G.box,
      histogram: G.histogram,
      pie: G.pie
    };
    var maker = makers[template.id] || generic[template.chart_type || ""];
    return maker ? applyTemplateDefaults(maker(), template) : null;
  }

  function backendSVG(template, opts) {
    var adapter = global.Backend;
    if (!adapter || adapter.available !== true || typeof adapter.renderChart !== "function") return Promise.resolve(null);
    var chart = specForTemplate(template);
    if (!chart) return Promise.resolve(null);
    return Promise.resolve().then(function () {
      return adapter.renderChart(chart, {
        width_mm: W * 25.4 / 60,
        height_mm: CHART_H * 25.4 / 60,
        dpi: 60,
        palette_id: template.palette_default || null
      });
    }).then(function (result) {
      var rendered = String(result && result.svg || "").trim();
      if (!rendered || /data-render=["']placeholder["']|该图表类型需 v2 服务端渲染/.test(rendered)) return null;
      SERIES = seriesFrom(opts && opts.colors);
      try {
        var provenance = "Backend.renderChart";
        var body = '<g data-preview-renderer="' + provenance + '">' + fitRenderedSVG(recolorKernel(rendered)) + '</g>';
        return frame(body, chart.characterization ? FOOTER_BACKEND_SPECTRUM : FOOTER_BACKEND_CHART, provenance);
      } finally {
        SERIES = DEFAULT_SERIES;
      }
    }).catch(function () { return null; });
  }

  function svgAsync(template, opts) {
    if (!template) return Promise.resolve(null);
    return backendSVG(template, opts).then(function (backend) {
      return backend ? tagTemplate(backend, template) : svg(template, opts);
    });
  }

  function elementForMarkup(markup) {
    if (!markup || !global.document || typeof global.document.createElement !== "function") return null;
    var host = global.document.createElement("span");
    host.style.display = "inline-block";
    host.style.lineHeight = "0";
    host.innerHTML = markup;
    return host.firstChild || null;
  }

  function draw(template, opts) {
    return elementForMarkup(svg(template, opts));
  }

  function drawAsync(template, opts) {
    return svgAsync(template, opts).then(elementForMarkup);
  }

  global.TemplatePreview = { svg: svg, draw: draw, svgAsync: svgAsync, drawAsync: drawAsync };
})(typeof globalThis !== "undefined" ? globalThis : this);
