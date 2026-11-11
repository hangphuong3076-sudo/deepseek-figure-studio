/**
 * export.js — FigExport
 *
 * Export pipeline for the shared figure kernel.
 * Depends on FigRender (render.js) and FigTiff (tiff.js) at call time.
 * Pure JS, no build step, no module system, no third-party dependencies.
 * DOM (canvas / Image / Blob / download anchor) is required only for raster,
 * TIFF and PDF export; FigExport.isAvailable() reports that without throwing.
 */
(function (root) {
  "use strict";

  var G = root;

  // ------------------------------------------------------------------
  // Environment detection
  // ------------------------------------------------------------------

  // True only when the current environment provides the DOM primitives
  // needed for raster export. Never throws, also safe in Node / workers.
  function isAvailable() {
    try {
      if (typeof document === "undefined" || !document) return false;
      if (typeof Blob === "undefined") return false;
      if (typeof Image === "undefined") return false;
      var canvas = document.createElement("canvas");
      if (!canvas || typeof canvas.getContext !== "function") return false;
      return !!canvas.getContext("2d");
    } catch (e) {
      return false;
    }
  }

  function makeBlob(parts, type) {
    if (typeof Blob === "undefined") {
      throw new Error("FigExport：当前环境不支持 Blob，无法构造导出文件");
    }
    try {
      return new Blob(parts, { type: type });
    } catch (e) {
      throw new Error("FigExport：构造 Blob 失败：" + (e && e.message ? e.message : String(e)));
    }
  }

  // ------------------------------------------------------------------
  // Input validation (all errors carry Chinese messages)
  // ------------------------------------------------------------------

  function requireDoc(doc, fnName) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(fnName + "：doc 必须是文档对象");
    }
    var canvas = doc.canvas;
    if (!canvas || typeof canvas !== "object") {
      throw new Error(fnName + "：doc.canvas 缺失");
    }
    if (typeof canvas.width_mm !== "number" || !(canvas.width_mm > 0) ||
        typeof canvas.height_mm !== "number" || !(canvas.height_mm > 0)) {
      throw new Error(fnName + "：canvas.width_mm 与 canvas.height_mm 必须为正数");
    }
    return canvas;
  }

  function requireRender(fnName) {
    if (typeof FigRender === "undefined" || !FigRender || typeof FigRender.toSVG !== "function") {
      throw new Error(fnName + "：缺少依赖 FigRender，请先按顺序加载 render.js");
    }
  }

  function requireTiff(fnName) {
    if (typeof FigTiff === "undefined" || !FigTiff || typeof FigTiff.encodeRGBA !== "function") {
      throw new Error(fnName + "：缺少依赖 FigTiff，请先按顺序加载 tiff.js");
    }
  }

  // dpi resolution: explicit value wins, then doc.canvas.dpi, then schema default 300
  function resolveDpi(canvas, dpi) {
    if (typeof dpi === "number" && dpi > 0) return dpi;
    if (typeof canvas.dpi === "number" && canvas.dpi > 0) return canvas.dpi;
    return 300;
  }

  function ceilPx(mm, dpi) {
    return Math.ceil(mm * dpi / 25.4);
  }

  function fmtNum(n) {
    return String(n);
  }

  function fmtPdfNum(n) {
    return String(Math.round(n * 100) / 100);
  }

  function rejectTransparent(opts, format, fnName) {
    if (opts && opts.transparent === true && format !== "png") {
      throw new Error(fnName + "：transparent=true 仅支持 PNG，" + format.toUpperCase() + " 不支持透明背景，未静默改成 RGB");
    }
  }

  function scopeBox(doc, opts, fnName) {
    var canvas = requireDoc(doc, fnName);
    var o = opts || {};
    if (o.panel_id !== undefined && o.panel_id !== null) {
      requireRender(fnName);
      if (typeof FigRender.panelBBox !== "function") {
        throw new Error(fnName + "：当前 FigRender 不支持 panelBBox 范围计算");
      }
      return FigRender.panelBBox(doc, o.panel_id);
    }
    return { x: 0, y: 0, w: canvas.width_mm, h: canvas.height_mm };
  }

  // ------------------------------------------------------------------
  // SVG export
  // ------------------------------------------------------------------

  function toSVGString(doc, opts, internalTransparent) {
    var o = opts || {};
    requireDoc(doc, "FigExport.toSVGString");
    requireRender("FigExport.toSVGString");
    if (o.transparent === true && internalTransparent !== true) {
      rejectTransparent(o, "svg", "FigExport.toSVGString");
    }
    var svg = FigRender.toSVG(doc, {
      scale: 1,
      includeGuides: false,
      panel_id: o.panel_id,
      transparent: o.transparent === true && internalTransparent === true
    });
    if (typeof svg !== "string" || svg.length === 0) {
      throw new Error("FigExport.toSVGString：FigRender.toSVG 未返回有效的 SVG 字符串");
    }
    return svg;
  }

  function svgToDataUrl(svg) {
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  // ------------------------------------------------------------------
  // Raster pipeline: SVG string -> Image -> canvas (white background)
  // ------------------------------------------------------------------

  function ensureRasterEnv(fnName) {
    if (!isAvailable()) {
      throw new Error(fnName + "：当前环境缺少 DOM（canvas/Image/Blob），无法执行栅格导出");
    }
  }

  function loadSvgImage(svgString, fnName) {
    return new Promise(function (resolve, reject) {
      var img;
      var timer = null;
      var settled = false;
      function succeed() {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(img);
      }
      function fail(message) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        reject(new Error(fnName + "：" + message));
      }
      try {
        img = new Image();
      } catch (e) {
        fail("无法创建 Image 对象：" + (e && e.message ? e.message : String(e)));
        return;
      }
      img.onload = succeed;
      img.onerror = function () {
        fail("SVG 转位图时 Image 解码失败；请检查内嵌光栅图或安全静态 SVG 是否受当前浏览器支持，外链图片不能作为图元");
      };
      timer = setTimeout(function () {
        fail("SVG 转位图等待 Image 解码超时（15 秒）；请检查内嵌位图格式与浏览器 DOM 解码能力");
      }, 15000);
      try {
        img.src = svgToDataUrl(svgString);
      } catch (e) {
        fail("设置 SVG Image 源失败：" + (e && e.message ? e.message : String(e)));
      }
    });
  }

  // Default raster output is unchanged: white canvas plus SVG background.
  // Transparent PNG skips both default backgrounds but retains explicit white elements.
  function rasterize(doc, dpi, fnName, opts) {
    ensureRasterEnv(fnName);
    var o = opts || {};
    var box = scopeBox(doc, o, fnName);
    var canvasW = ceilPx(box.w, dpi);
    var canvasH = ceilPx(box.h, dpi);
    if (canvasW < 1 || canvasH < 1) {
      throw new Error(fnName + "：导出范围像素尺寸过小，无法导出");
    }
    var svg = toSVGString(doc, o, o.transparent === true);
    return loadSvgImage(svg, fnName).then(function (img) {
      var canvas = document.createElement("canvas");
      canvas.width = canvasW;
      canvas.height = canvasH;
      var ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error(fnName + "：无法获取 canvas 2D 绘图上下文");
      }
      if (o.transparent !== true) {
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, canvasW, canvasH);
      }
      ctx.drawImage(img, 0, 0, canvasW, canvasH);
      return {
        canvas: canvas, ctx: ctx, width: canvasW, height: canvasH,
        widthMm: box.w, heightMm: box.h
      };
    });
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      if (typeof canvas.toBlob !== "function") {
        reject(new Error("FigExport：当前环境不支持 canvas.toBlob"));
        return;
      }
      canvas.toBlob(function (blob) {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("FigExport：canvas.toBlob 返回空结果"));
        }
      }, mime, quality);
    });
  }

  // ------------------------------------------------------------------
  // Minimal PDF builder: one page, document rasterized as a raw RGB
  // image XObject filling the page (baseline PDF 1.4, no compression).
  // ------------------------------------------------------------------

  function asciiBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
      out[i] = str.charCodeAt(i) & 0xff;
    }
    return out;
  }

  function pad10(n) {
    var s = String(n);
    while (s.length < 10) s = "0" + s;
    return s;
  }

  function buildPdfBytes(pageWpt, pageHpt, pxW, pxH, rgb) {
    var chunks = [];
    var offset = 0;
    var objOffsets = {};

    function push(part) {
      var bytes = (typeof part === "string") ? asciiBytes(part) : part;
      chunks.push(bytes);
      offset += bytes.length;
    }
    function beginObj(n) {
      objOffsets[n] = offset;
      push(n + " 0 obj\n");
    }
    function endObj() {
      push("endobj\n");
    }

    push("%PDF-1.4\n");
    // Binary comment line, marks the file as binary-safe
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    beginObj(1);
    push("<< /Type /Catalog /Pages 2 0 R >>\n");
    endObj();

    beginObj(2);
    push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n");
    endObj();

    beginObj(3);
    push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + fmtPdfNum(pageWpt) + " " + fmtPdfNum(pageHpt) + "]" +
         " /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\n");
    endObj();

    var content = "q\n" + fmtPdfNum(pageWpt) + " 0 0 " + fmtPdfNum(pageHpt) + " 0 0 cm\n/Im0 Do\nQ\n";
    beginObj(4);
    push("<< /Length " + content.length + " >>\nstream\n" + content + "endstream\n");
    endObj();

    beginObj(5);
    push("<< /Type /XObject /Subtype /Image /Width " + pxW + " /Height " + pxH +
         " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length " + rgb.length + " >>\nstream\n");
    push(rgb);
    push("\nendstream\n");
    endObj();

    var xrefOffset = offset;
    var xref = "xref\n0 6\n0000000000 65535 f \n";
    for (var i = 1; i <= 5; i++) {
      xref += pad10(objOffsets[i]) + " 00000 n \n";
    }
    push(xref);
    push("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n");

    var total = 0;
    for (var j = 0; j < chunks.length; j++) total += chunks[j].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var k = 0; k < chunks.length; k++) {
      out.set(chunks[k], pos);
      pos += chunks[k].length;
    }
    return out;
  }

  function rgbaToRgb(data, pixelCount) {
    var rgb = new Uint8Array(pixelCount * 3);
    for (var i = 0, j = 0; i < pixelCount; i++) {
      rgb[j++] = data[i * 4];
      rgb[j++] = data[i * 4 + 1];
      rgb[j++] = data[i * 4 + 2];
    }
    return rgb;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  var FigExport = {

    exportFormats: ["png", "jpeg", "tiff", "svg", "pdf"],

    isAvailable: function () {
      return isAvailable();
    },

    // {width, height} in pixels, ceil(scope mm * dpi / 25.4)
    pixelSize: function (doc, opts) {
      var o = opts || {};
      var canvas = requireDoc(doc, "FigExport.pixelSize");
      var dpi = resolveDpi(canvas, o.dpi);
      var box = scopeBox(doc, o, "FigExport.pixelSize");
      return {
        width: ceilPx(box.w, dpi),
        height: ceilPx(box.h, dpi)
      };
    },

    toSVGBlob: function (doc, opts) {
      return makeBlob([toSVGString(doc, opts)], "image/svg+xml");
    },

    toSVGString: function (doc, opts) {
      return toSVGString(doc, opts);
    },

    // Promise<Blob>; format "png" | "jpeg", quality used for jpeg only
    toRasterBlob: function (doc, opts) {
      var o = opts || {};
      var format = (o.format === undefined) ? "png" : o.format;
      if (format !== "png" && format !== "jpeg") {
        throw new Error("FigExport.toRasterBlob：format 仅支持 png / jpeg，收到 " + JSON.stringify(format));
      }
      rejectTransparent(o, format, "FigExport.toRasterBlob");
      var quality = (typeof o.quality === "number") ? o.quality : 0.92;
      var canvas = requireDoc(doc, "FigExport.toRasterBlob");
      requireRender("FigExport.toRasterBlob");
      var dpi = resolveDpi(canvas, o.dpi);
      var mime = (format === "png") ? "image/png" : "image/jpeg";
      return rasterize(doc, dpi, "FigExport.toRasterBlob", o).then(function (r) {
        return canvasToBlob(r.canvas, mime, quality);
      });
    },

    // Promise<Blob>; rasterize then encode baseline TIFF via FigTiff
    toTIFFBlob: function (doc, opts) {
      var o = opts || {};
      rejectTransparent(o, "tiff", "FigExport.toTIFFBlob");
      var canvas = requireDoc(doc, "FigExport.toTIFFBlob");
      requireRender("FigExport.toTIFFBlob");
      requireTiff("FigExport.toTIFFBlob");
      var dpi = resolveDpi(canvas, o.dpi);
      return rasterize(doc, dpi, "FigExport.toTIFFBlob", o).then(function (r) {
        var imageData = r.ctx.getImageData(0, 0, r.width, r.height);
        var bytes = FigTiff.encodeRGBA(imageData.data, r.width, r.height, { dpi: dpi });
        if (!(bytes instanceof Uint8Array)) {
          throw new Error("FigExport.toTIFFBlob：FigTiff.encodeRGBA 未返回 Uint8Array");
        }
        return makeBlob([bytes], "image/tiff");
      });
    },

    // Promise<Blob> application/pdf; v1 wraps the rendered figure in a
    // minimal single-page PDF (v2 may delegate to the server instead).
    toPDFBlob: function (doc, opts) {
      var o = opts || {};
      rejectTransparent(o, "pdf", "FigExport.toPDFBlob");
      var canvas = requireDoc(doc, "FigExport.toPDFBlob");
      requireRender("FigExport.toPDFBlob");
      var dpi = resolveDpi(canvas, o.dpi);
      var box = scopeBox(doc, o, "FigExport.toPDFBlob");
      var pageWpt = box.w * 72 / 25.4;
      var pageHpt = box.h * 72 / 25.4;
      return rasterize(doc, dpi, "FigExport.toPDFBlob", o).then(function (r) {
        var data = r.ctx.getImageData(0, 0, r.width, r.height).data;
        var rgb = rgbaToRgb(data, r.width * r.height);
        var bytes = buildPdfBytes(pageWpt, pageHpt, r.width, r.height, rgb);
        return makeBlob([bytes], "application/pdf");
      });
    },

    download: function (blob, filename) {
      if (!isAvailable()) {
        throw new Error("FigExport.download：当前环境缺少 DOM，无法触发下载");
      }
      if (typeof Blob === "undefined" || !(blob instanceof Blob)) {
        throw new Error("FigExport.download：blob 必须是 Blob 对象");
      }
      if (typeof filename !== "string" || filename.length === 0) {
        throw new Error("FigExport.download：filename 必须是非空字符串");
      }
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        throw new Error("FigExport.download：当前环境不支持 URL.createObjectURL");
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      }, 1000);
    },

    // `${title||id}[_panel-id]_${scopeWidth}x${scopeHeight}mm_${dpi}dpi.${ext}`
    suggestFilename: function (doc, ext, opts) {
      var o = opts || {};
      var canvas = requireDoc(doc, "FigExport.suggestFilename");
      if (typeof ext !== "string" || ext.trim().length === 0) {
        throw new Error("FigExport.suggestFilename：ext 必须是非空字符串");
      }
      var cleanExt = ext.trim().replace(/^\./, "");
      if (!/^[A-Za-z0-9]+$/.test(cleanExt)) {
        throw new Error("FigExport.suggestFilename：ext 只能包含字母与数字");
      }
      var dpi = resolveDpi(canvas, o.dpi);
      var box = scopeBox(doc, o, "FigExport.suggestFilename");
      var base;
      if (typeof doc.title === "string" && doc.title.trim().length > 0) {
        base = doc.title;
      } else if (typeof doc.id === "string" && doc.id.length > 0) {
        base = doc.id;
      } else {
        base = "figure";
      }
      if (o.panel_id !== undefined && o.panel_id !== null) base += "_" + o.panel_id;
      base = base.trim().replace(/[\\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
      if (base.length === 0) base = "figure";
      return base + "_" + fmtNum(box.w) + "x" + fmtNum(box.h) +
             "mm_" + fmtNum(dpi) + "dpi." + cleanExt;
    }
  };

  G.FigExport = FigExport;
})(typeof globalThis !== "undefined" ? globalThis : this);
