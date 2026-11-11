/**
 * export.js — Exporter (v1 web app)
 *
 * Export dialog on top of the frozen kernel FigExport (lib/export.js):
 *   - formats png/jpeg/tiff/svg/pdf, DPI input, live pixel size preview
 *     (FigExport.pixelSize), editable filename (FigExport.suggestFilename)
 *   - journal preset preferred_formats are highlighted and sorted first
 *   - progress display during export; failures get a Chinese reason plus
 *     troubleshooting hints (e.g. "use v2 server export" when the browser
 *     cannot handle a format)
 *   - quickExport(format) for one-click export from the top bar
 *
 * Loads after lib/* and app/state.js, app/ui.js per index.html order.
 * No build step, no modules: IIFE attached to globalThis as `Exporter`.
 * The dialog is a self-contained overlay (no dependency on Ui.modal internals);
 * notifications prefer Ui.toast, falling back to App.status / App.error.
 */
(function (root) {
  "use strict";

  var G = root;

  // ------------------------------------------------------------------
  // Format metadata
  // ------------------------------------------------------------------

  var EXPORT_FORMATS = ["png", "jpeg", "tiff", "svg", "pdf"];

  var FORMAT_META = {
    png:  { label: "PNG",  ext: "png",  desc: "无损位图，通用格式，适合屏幕预览与投稿备选" },
    jpeg: { label: "JPEG", ext: "jpg",  desc: "有损压缩位图，适合照片类图像（白色背景合成）" },
    tiff: { label: "TIFF", ext: "tiff", desc: "未压缩 RGB 位图，多数期刊投稿首选位图格式" },
    svg:  { label: "SVG",  ext: "svg",  desc: "矢量格式，文字与线条可缩放、保持可编辑" },
    pdf:  { label: "PDF",  ext: "pdf",  desc: "v1 为栅格化单页 PDF；需要矢量 PDF 请改用 v2" }
  };

  // journals.json preferred_formats tokens -> v1 formats (uppercase tokens)
  var PRESET_TO_FORMAT = { TIFF: "tiff", PNG: "png", JPEG: "jpeg", JPG: "jpeg", PDF: "pdf", SVG: "svg" };

  // Preferred journal formats that v1 cannot produce (vector source files)
  var PRESET_EXTERNAL = ["AI", "EPS"];

  // Conservative browser raster limits used for pre-export warnings
  var MAX_SIDE_PX = 16384;
  var MAX_AREA_PX = 120000000; // ~120 MP

  var state = {
    mounted: false,
    busy: false,
    dialog: null,
    boundButton: null,
    styleInjected: false
  };

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  function formatBytes(n) {
    if (typeof n !== "number" || !(n >= 0)) return "";
    if (n >= 1048576) return (n / 1048576).toFixed(2) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  }

  function notify(text, opts) {
    try {
      if (G.Ui && typeof G.Ui.toast === "function") { G.Ui.toast(text, opts || {}); return; }
    } catch (e) { /* fall through */ }
    try {
      if (G.App && typeof G.App.status === "function") { G.App.status(text); return; }
    } catch (e2) { /* fall through */ }
    try { console.log("[Exporter] " + text); } catch (e3) { /* ignore */ }
  }

  function notifyError(text) {
    try {
      if (G.Ui && typeof G.Ui.toast === "function") { G.Ui.toast(text, { type: "error", ms: 6000 }); return; }
    } catch (e) { /* fall through */ }
    try {
      if (G.App && typeof G.App.error === "function") { G.App.error(text); return; }
    } catch (e2) { /* fall through */ }
    try { console.error("[Exporter] " + text); } catch (e3) { /* ignore */ }
  }

  function requireDocContext(fnName) {
    if (typeof G.App === "undefined" || !G.App || !G.App.doc) {
      throw new Error(fnName + "：应用尚未初始化，缺少当前文档 App.doc");
    }
    return G.App.doc;
  }

  // Shallow copy of doc with canvas.dpi overridden; only used for read-only
  // previews (FigExport.pixelSize / suggestFilename), never mutated by them.
  function probeDoc(doc, dpi) {
    var canvas = {};
    var key;
    for (key in doc.canvas) {
      if (Object.prototype.hasOwnProperty.call(doc.canvas, key)) canvas[key] = doc.canvas[key];
    }
    if (dpi > 0) canvas.dpi = dpi;
    var out = {};
    for (key in doc) {
      if (Object.prototype.hasOwnProperty.call(doc, key)) out[key] = doc[key];
    }
    out.canvas = canvas;
    return out;
  }

  function singleSelectedScope(doc) {
    var ids = G.App && typeof G.App.selection === "function" ? G.App.selection() : [];
    if (!Array.isArray(ids) || ids.length !== 1) return null;
    var id = ids[0];
    var elements = Array.isArray(doc.elements) ? doc.elements : [];
    for (var i = 0; i < elements.length; i++) {
      if (elements[i] && elements[i].id === id &&
          (elements[i].type === "panel" || elements[i].type === "chart")) return elements[i];
    }
    return null;
  }

  function requireSingleSelectedScope(doc) {
    var scopeElement = singleSelectedScope(doc);
    if (!scopeElement) {
      throw new Error("导出当前子图前，请在画布上单选一个 type=panel 或 type=chart 元素；空选、多选或文本等其他类型都不会自动改为整图或第一个 panel");
    }
    return scopeElement;
  }

  function resolveDpi(canvas, dpiOverride) {
    if (typeof dpiOverride === "number" && dpiOverride > 0) return dpiOverride;
    if (canvas && typeof canvas.dpi === "number" && canvas.dpi > 0) return canvas.dpi;
    return 300;
  }

  function currentPreset() {
    try {
      if (G.App && typeof G.App.currentJournal === "function") return G.App.currentJournal();
    } catch (e) { /* no preset */ }
    return null;
  }

  // Preferred journal formats first, then the remaining v1 formats.
  function formatOrder() {
    var order = [];
    var recommended = {};
    var preset = currentPreset();
    if (preset && preset.preferred_formats && preset.preferred_formats.length) {
      for (var i = 0; i < preset.preferred_formats.length; i++) {
        var token = String(preset.preferred_formats[i]).toUpperCase();
        var f = PRESET_TO_FORMAT[token];
        if (f && order.indexOf(f) === -1) {
          order.push(f);
          recommended[f] = true;
        }
      }
    }
    for (var j = 0; j < EXPORT_FORMATS.length; j++) {
      if (order.indexOf(EXPORT_FORMATS[j]) === -1) order.push(EXPORT_FORMATS[j]);
    }
    return { order: order, recommended: recommended, preset: preset };
  }

  // Preferred tokens that v1 cannot export (AI / EPS)
  function externalPreferredTokens(preset) {
    var out = [];
    if (preset && preset.preferred_formats && preset.preferred_formats.length) {
      for (var i = 0; i < preset.preferred_formats.length; i++) {
        var token = String(preset.preferred_formats[i]).toUpperCase();
        if (PRESET_EXTERNAL.indexOf(token) !== -1 && out.indexOf(token) === -1) out.push(token);
      }
    }
    return out;
  }

  function pixelSizeFor(doc, dpi, panelId) {
    if (typeof G.FigExport === "undefined" || !G.FigExport || typeof G.FigExport.pixelSize !== "function") {
      throw new Error("Exporter：缺少内核模块 FigExport，请确认 lib/export.js 已按顺序加载");
    }
    return G.FigExport.pixelSize(probeDoc(doc, dpi), { panel_id: panelId });
  }

  // Human-readable warning when the requested pixel size exceeds what
  // browsers usually allow for canvas rasterization.
  function pixelLimitWarning(w, h) {
    if (w > MAX_SIDE_PX || h > MAX_SIDE_PX) {
      return "像素尺寸 " + w + " × " + h + " px 超过浏览器画布单边上限（约 " + MAX_SIDE_PX + " px），导出很可能失败，请降低 DPI 或改用 v2 服务端导出。";
    }
    if (w * h > MAX_AREA_PX) {
      return "像素尺寸 " + w + " × " + h + " px（约 " + Math.round(w * h / 1000000) + " MP）过大，导出可能缓慢或被浏览器拒绝，建议降低 DPI 或改用 v2 服务端导出。";
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Export pipeline (calls the frozen kernel FigExport)
  // ------------------------------------------------------------------

  // FigExport.toSVGBlob is synchronous per API.md; the raster/TIFF/PDF
  // exporters return Promises. Normalize everything to a Promise.
  function asPromise(value) {
    return (value && typeof value.then === "function") ? value : Promise.resolve(value);
  }

  function exportOne(doc, format, opts) {
    var o = opts || {};
    if (typeof G.FigExport === "undefined" || !G.FigExport) {
      return Promise.reject(new Error("缺少内核模块 FigExport，请确认 lib/export.js 已按顺序加载"));
    }
    try {
      if (format === "png" || format === "jpeg") {
        return asPromise(G.FigExport.toRasterBlob(doc, {
          format: format, dpi: o.dpi, quality: o.quality,
          panel_id: o.panel_id, transparent: o.transparent === true
        }));
      }
      if (format === "tiff") {
        return asPromise(G.FigExport.toTIFFBlob(doc, {
          dpi: o.dpi, panel_id: o.panel_id, transparent: o.transparent === true
        }));
      }
      if (format === "svg") {
        return asPromise(G.FigExport.toSVGBlob(doc, {
          panel_id: o.panel_id, transparent: o.transparent === true
        }));
      }
      if (format === "pdf") {
        return asPromise(G.FigExport.toPDFBlob(doc, {
          dpi: o.dpi, panel_id: o.panel_id, transparent: o.transparent === true
        }));
      }
      return Promise.reject(new Error("不支持的导出格式：" + format + "（支持 png/jpeg/tiff/svg/pdf）"));
    } catch (e) {
      // FigExport throws synchronously on invalid input — normalize to rejection
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // Runs one export and triggers the browser download.
  // opts: { dpi, quality, filename, onStage(text) }
  function doExport(doc, format, opts) {
    var o = opts || {};
    return new Promise(function (resolve, reject) {
      function stage(text) {
        try { if (typeof o.onStage === "function") o.onStage(text); } catch (e) { /* ignore */ }
      }
      stage("正在准备导出…");
      // Small delay so the progress UI paints before heavy synchronous work
      setTimeout(function () {
        exportOne(doc, format, o).then(function (blob) {
          if (!(blob instanceof Blob)) {
            throw new Error("导出模块未返回 Blob 文件");
          }
          stage("正在触发浏览器下载…");
          G.FigExport.download(blob, o.filename);
          resolve({ format: format, filename: o.filename, blob: blob, bytes: blob.size });
        }).catch(reject);
      }, 50);
    });
  }

  // Chinese reason + troubleshooting hints for a failed export.
  function diagnose(format, err) {
    var meta = FORMAT_META[format] || { label: String(format) };
    var msg = (err && err.message) ? err.message : String(err);
    var tips = [];
    try {
      var doc = G.App && G.App.doc;
      if (doc && doc.canvas && (format === "png" || format === "jpeg" || format === "tiff" || format === "pdf")) {
        var dpi = (state.dialog && state.dialog.ui) ? state.dialog.ui.lastDpi : null;
        var panelId = (state.dialog && state.dialog.ui) ? state.dialog.ui.lastPanelId : null;
        var px = pixelSizeFor(doc, dpi > 0 ? dpi : undefined, panelId);
        var limit = pixelLimitWarning(px.width, px.height);
        if (limit) tips.push(limit);
      }
    } catch (e) { /* context unavailable */ }
    if (format === "tiff") {
      tips.push("TIFF 编码依赖内核 lib/tiff.js（FigTiff），请确认页面按顺序加载了 lib/tiff.js 与 lib/export.js。");
    }
    if (format === "png" || format === "jpeg") {
      tips.push("请确认 DPI 没有过大（超出浏览器画布上限会失败），可降低 DPI 后重试；若文档含外部图片，请确保其已内联为 data URL。");
    }
    if (format === "pdf") {
      tips.push("v1 的 PDF 为栅格化单页实现；如需矢量 PDF/EPS/AI，请改用 v2 服务端导出。");
    }
    if (format === "svg") {
      tips.push("SVG 导出不依赖 canvas，失败通常是文档渲染出错，请检查文档元素数据是否完整。");
    }
    tips.push("若反复失败，请改用 v2 服务端导出（v2-server），或更换最新版 Chrome/Edge 后重试。");
    return "导出 " + meta.label + " 失败：" + msg + "。建议：" + tips.join(" ");
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  function quickExport(format) {
    if (state.busy) {
      return Promise.reject(new Error("已有导出任务正在进行，请等待其完成后再试"));
    }
    if (EXPORT_FORMATS.indexOf(format) === -1) {
      return Promise.reject(new Error("Exporter.quickExport：不支持的格式 " + JSON.stringify(format) + "，支持 png/jpeg/tiff/svg/pdf"));
    }
    var doc;
    try {
      doc = requireDocContext("Exporter.quickExport");
    } catch (e) {
      return Promise.reject(e);
    }
    if (typeof G.FigExport === "undefined" || !G.FigExport || typeof G.FigExport.suggestFilename !== "function") {
      return Promise.reject(new Error("Exporter.quickExport：缺少内核模块 FigExport，请确认 lib/export.js 已按顺序加载"));
    }
    var meta = FORMAT_META[format];
    var dpi = resolveDpi(doc.canvas, null);
    var filename;
    try {
      filename = G.FigExport.suggestFilename(doc, meta.ext);
    } catch (e) {
      return Promise.reject(e);
    }
    state.busy = true;
    notify("正在导出 " + meta.label + "（" + dpi + " DPI）…", { type: "info" });
    return doExport(doc, format, { dpi: dpi, quality: 0.92, filename: filename }).then(function (res) {
      state.busy = false;
      notify("已导出 " + res.filename + "（" + formatBytes(res.bytes) + "）", { type: "success" });
      return res;
    }, function (err) {
      state.busy = false;
      var reason = new Error(diagnose(format, err));
      notifyError(reason.message);
      throw reason;
    });
  }

  // ------------------------------------------------------------------
  // Dialog (self-contained overlay, mounted into #modal-root when present)
  // ------------------------------------------------------------------

  function injectStyle() {
    if (state.styleInjected) return;
    state.styleInjected = true;
    var css = "@keyframes exporter-progress-slide{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}" +
              ".exporter-progress-fill{width:30%;height:100%;background:#2f6fed;border-radius:4px;animation:exporter-progress-slide 1.1s linear infinite}";
    var styleEl = document.createElement("style");
    styleEl.id = "exporter-progress-style";
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  function el(tag, style, text) {
    var node = document.createElement(tag);
    if (style) {
      for (var k in style) {
        if (Object.prototype.hasOwnProperty.call(style, k)) node.style[k] = style[k];
      }
    }
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function buildDialog() {
    injectStyle();

    var overlay = el("div", {
      position: "fixed", left: "0", top: "0", right: "0", bottom: "0",
      background: "rgba(0,0,0,0.45)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: "1000"
    });

    var panel = el("div", {
      background: "#FFFFFF", color: "#222222", borderRadius: "10px",
      width: "470px", maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto",
      padding: "18px 20px", boxSizing: "border-box",
      fontFamily: '"Segoe UI","Microsoft YaHei",Arial,sans-serif', fontSize: "13px",
      boxShadow: "0 8px 30px rgba(0,0,0,0.35)"
    });
    overlay.appendChild(panel);

    var title = el("div", { fontSize: "16px", fontWeight: "bold", marginBottom: "10px" }, "导出图像");
    panel.appendChild(title);

    var journalInfo = el("div", {
      background: "#F5F7FA", border: "1px solid #E3E8EF", borderRadius: "6px",
      padding: "8px 10px", marginBottom: "10px", lineHeight: "1.5", color: "#444"
    });
    panel.appendChild(journalInfo);

    // --- export scope ---
    panel.appendChild(el("div", { fontWeight: "bold", margin: "6px 0 4px" }, "导出范围"));
    var scopeSelect = el("select", {
      width: "100%", boxSizing: "border-box", padding: "6px 8px",
      border: "1px solid #C9D1DB", borderRadius: "4px", background: "#FFFFFF"
    });
    var wholeOption = el("option", null, "整图画布");
    wholeOption.value = "canvas";
    var panelOption = el("option", null, "当前子图(panel/chart)");
    panelOption.value = "panel";
    scopeSelect.appendChild(wholeOption);
    scopeSelect.appendChild(panelOption);
    panel.appendChild(scopeSelect);
    var scopeHint = el("div", { margin: "5px 0 0", color: "#555", lineHeight: "1.5" });
    panel.appendChild(scopeHint);

    // --- format list ---
    panel.appendChild(el("div", { fontWeight: "bold", margin: "6px 0 4px" }, "格式"));
    var fmtList = el("div");
    panel.appendChild(fmtList);

    var transparentRow = el("label", {
      display: "flex", alignItems: "center", gap: "7px", margin: "8px 0 0",
      lineHeight: "1.5", cursor: "pointer"
    });
    var transparentInput = el("input");
    transparentInput.type = "checkbox";
    transparentRow.appendChild(transparentInput);
    transparentRow.appendChild(document.createTextNode("PNG 透明背景（仅 PNG；保留显式白色图元，去除默认画布底色）"));
    panel.appendChild(transparentRow);

    var fmtRows = {};
    var ui = {
      overlay: overlay,
      journalInfo: journalInfo,
      scopeSelect: scopeSelect,
      scopeHint: scopeHint,
      transparentInput: transparentInput,
      fmtList: fmtList,
      fmtRows: fmtRows,
      selectedFormat: null,
      dpiInput: null,
      qualityRow: null,
      qualityInput: null,
      qualityValue: null,
      pixelLine: null,
      warnLine: null,
      filenameInput: null,
      filenameDirty: false,
      progressArea: null,
      progressText: null,
      exportBtn: null,
      lastDpi: null,
      lastExport: null
    };

    function selectedMeta() { return FORMAT_META[ui.selectedFormat]; }

    function renderFormatRows() {
      var ord = formatOrder();
      fmtList.textContent = "";
      ui.fmtRows = {};
      ui.order = ord.order;
      ui.recommended = ord.recommended;
      for (var i = 0; i < ord.order.length; i++) {
        (function (format) {
          var meta = FORMAT_META[format];
          var row = el("div", {
            display: "flex", alignItems: "center", gap: "8px",
            border: "1px solid #D9DFE7", borderRadius: "6px",
            padding: "7px 10px", marginBottom: "6px", cursor: "pointer",
            background: "#FFFFFF"
          });
          var dot = el("span", {
            width: "12px", height: "12px", borderRadius: "50%",
            border: "2px solid #B8C2CE", flexShrink: "0", boxSizing: "border-box"
          });
          var name = el("span", { fontWeight: "bold", minWidth: "44px" }, meta.label);
          var badge = null;
          if (ord.recommended[format]) {
            badge = el("span", {
              background: "#E7F0FF", color: "#2F6FED", borderRadius: "4px",
              padding: "1px 6px", fontSize: "11px", flexShrink: "0"
            }, "期刊推荐");
          }
          var desc = el("span", { color: "#666", fontSize: "12px" }, meta.desc);
          row.appendChild(dot);
          row.appendChild(name);
          if (badge) row.appendChild(badge);
          row.appendChild(desc);
          row.addEventListener("click", function () {
            ui.selectedFormat = format;
            ui.filenameDirty = false; // regenerate filename with the new extension
            refresh();
          });
          fmtList.appendChild(row);
          ui.fmtRows[format] = { row: row, dot: dot };
        })(ord.order[i]);
      }
      if (!ui.selectedFormat || ord.order.indexOf(ui.selectedFormat) === -1) {
        ui.selectedFormat = ord.order[0];
      }
    }

    // --- DPI ---
    panel.appendChild(el("div", { fontWeight: "bold", margin: "10px 0 4px" }, "DPI（分辨率）"));
    var dpiRow = el("div", { display: "flex", alignItems: "center", gap: "6px" });
    var dpiInput = el("input", { width: "90px", padding: "5px 6px", border: "1px solid #C9D1DB", borderRadius: "4px" });
    dpiInput.type = "number";
    dpiInput.min = "36";
    dpiInput.max = "2400";
    dpiInput.step = "1";
    dpiRow.appendChild(dpiInput);
    var quickDpis = [72, 150, 300, 600];
    var preset = currentPreset();
    if (preset && typeof preset.dpi_recommended === "number" && quickDpis.indexOf(preset.dpi_recommended) === -1) {
      quickDpis.push(preset.dpi_recommended);
    }
    for (var qi = 0; qi < quickDpis.length; qi++) {
      (function (v) {
        var b = el("button", {
          padding: "4px 8px", border: "1px solid #C9D1DB", borderRadius: "4px",
          background: "#F5F7FA", cursor: "pointer", fontSize: "12px"
        }, String(v));
        b.type = "button";
        b.addEventListener("click", function () {
          dpiInput.value = String(v);
          refresh();
        });
        dpiRow.appendChild(b);
      })(quickDpis[qi]);
    }
    panel.appendChild(dpiRow);

    // --- pixel size preview ---
    var pixelLine = el("div", { margin: "8px 0 0", color: "#333", lineHeight: "1.5" });
    panel.appendChild(pixelLine);

    // --- jpeg quality ---
    var qualityRow = el("div", { display: "flex", alignItems: "center", gap: "8px", margin: "8px 0 0" });
    qualityRow.appendChild(el("span", null, "JPEG 质量"));
    var qualityInput = el("input", { width: "140px" });
    qualityInput.type = "range";
    qualityInput.min = "0.3";
    qualityInput.max = "1";
    qualityInput.step = "0.01";
    qualityInput.value = "0.92";
    var qualityValue = el("span", { color: "#555" }, "92%");
    qualityRow.appendChild(qualityInput);
    qualityRow.appendChild(qualityValue);
    panel.appendChild(qualityRow);

    // --- filename ---
    panel.appendChild(el("div", { fontWeight: "bold", margin: "10px 0 4px" }, "文件名"));
    var filenameInput = el("input", {
      width: "100%", boxSizing: "border-box", padding: "6px 8px",
      border: "1px solid #C9D1DB", borderRadius: "4px", fontFamily: "Consolas,monospace"
    });
    filenameInput.type = "text";
    panel.appendChild(filenameInput);

    // --- warning line ---
    var warnLine = el("div", {
      color: "#B45309", background: "#FEF6E7", border: "1px solid #F5D9A8",
      borderRadius: "6px", padding: "6px 10px", margin: "10px 0 0",
      lineHeight: "1.5", display: "none"
    });
    panel.appendChild(warnLine);

    // --- progress area ---
    var progressArea = el("div", {
      margin: "12px 0 0", padding: "8px 10px", background: "#F0F6FF",
      border: "1px solid #C9DCFA", borderRadius: "6px", display: "none"
    });
    var barTrack = el("div", {
      height: "8px", background: "#DCE7F7", borderRadius: "4px",
      overflow: "hidden", marginBottom: "6px"
    });
    var barFill = el("div", null);
    barFill.setAttribute("class", "exporter-progress-fill");
    barTrack.appendChild(barFill);
    var progressText = el("div", { color: "#2A4B8D", fontSize: "12px" }, "");
    progressArea.appendChild(barTrack);
    progressArea.appendChild(progressText);
    panel.appendChild(progressArea);

    // --- footer buttons ---
    var footer = el("div", { display: "flex", justifyContent: "flex-end", gap: "8px", margin: "14px 0 0" });
    var cancelBtn = el("button", {
      padding: "7px 14px", border: "1px solid #C9D1DB", borderRadius: "6px",
      background: "#FFFFFF", cursor: "pointer"
    }, "关闭");
    cancelBtn.type = "button";
    var exportBtn = el("button", {
      padding: "7px 16px", border: "1px solid #2F6FED", borderRadius: "6px",
      background: "#2F6FED", color: "#FFFFFF", cursor: "pointer", fontWeight: "bold"
    }, "导出");
    exportBtn.type = "button";
    exportBtn.addEventListener("click", function () { runDialogExport(); });
    footer.appendChild(cancelBtn);
    footer.appendChild(exportBtn);
    panel.appendChild(footer);

    ui.dpiInput = dpiInput;
    ui.qualityRow = qualityRow;
    ui.qualityInput = qualityInput;
    ui.qualityValue = qualityValue;
    ui.pixelLine = pixelLine;
    ui.warnLine = warnLine;
    ui.filenameInput = filenameInput;
    ui.progressArea = progressArea;
    ui.progressText = progressText;
    ui.exportBtn = exportBtn;
    ui.cancelBtn = cancelBtn;

    function getDpi() {
      var v = parseFloat(dpiInput.value);
      if (!(v > 0)) return 0;
      return Math.round(v);
    }

    function refresh() {
      var doc;
      try { doc = requireDocContext("Exporter.refresh"); } catch (e) { return; }
      var dpi = getDpi();
      var meta = selectedMeta();
      var probe = (dpi > 0) ? probeDoc(doc, dpi) : doc;
      var presetNow = currentPreset();
      var wantsPanel = scopeSelect.value === "panel";
      var selectedScope = singleSelectedScope(doc);
      var scopeOpts = { panel_id: wantsPanel && selectedScope ? selectedScope.id : null };

      if (ui.selectedFormat !== "png") transparentInput.checked = false;
      transparentInput.disabled = ui.selectedFormat !== "png";
      transparentInput.parentNode.style.color = transparentInput.disabled ? "#888888" : "#222222";
      if (!wantsPanel) {
        scopeHint.style.color = "#555555";
        scopeHint.textContent = "整图画布：保留所有现有格式与默认白底行为。";
      } else if (!selectedScope) {
        scopeHint.style.color = "#B45309";
        scopeHint.textContent = "请返回画布单选一个 type=panel 或 type=chart 元素。空选、多选或文本等其他类型不能导出子图，也不会自动改选第一个 panel。";
      } else if (selectedScope.type === "chart") {
        scopeHint.style.color = "#2A4B8D";
        scopeHint.textContent = "将导出 chart " + selectedScope.id + "：仅保留该图表，按实际 bbox 裁剪，不添加额外 padding。";
      } else {
        scopeHint.style.color = "#2A4B8D";
        scopeHint.textContent = "将导出 panel " + selectedScope.id + "：保留原图形、线条和文字，含 panel padding；外置 label 按字号贴边扩展。";
      }

      // format row highlight
      for (var f in ui.fmtRows) {
        if (Object.prototype.hasOwnProperty.call(ui.fmtRows, f)) {
          var sel = (f === ui.selectedFormat);
          ui.fmtRows[f].row.style.border = sel ? "2px solid #2F6FED" : "1px solid #D9DFE7";
          ui.fmtRows[f].row.style.background = sel ? "#EEF5FF" : "#FFFFFF";
          ui.fmtRows[f].dot.style.border = sel ? "2px solid #2F6FED" : "2px solid #B8C2CE";
          ui.fmtRows[f].dot.style.background = sel ? "#2F6FED" : "transparent";
        }
      }

      // journal info
      var external = externalPreferredTokens(presetNow);
      if (presetNow && presetNow.preferred_formats && presetNow.preferred_formats.length) {
        var text = "当前期刊预设：" + presetNow.name + "；投稿首选格式：" + presetNow.preferred_formats.join("、") + "。";
        if (external.length) {
          text += "其中 " + external.join("、") + " 为矢量源文件格式，v1 无法导出，请改用 v2 服务端导出或在专业矢量软件中处理。";
        }
        journalInfo.textContent = text;
      } else {
        journalInfo.textContent = "未应用期刊预设 —— 可在右侧“期刊预设”面板应用后，此处将推荐该期刊的首选格式。";
      }

      // quality row visibility
      qualityRow.style.display = (ui.selectedFormat === "jpeg") ? "flex" : "none";
      qualityValue.textContent = Math.round(parseFloat(qualityInput.value) * 100) + "%";

      // pixel size preview (FigExport.pixelSize)
      try {
        if (wantsPanel && !selectedScope) requireSingleSelectedScope(doc);
        var px = G.FigExport.pixelSize(probe, scopeOpts);
        var box = scopeOpts.panel_id ? G.FigRender.panelBBox(doc, scopeOpts.panel_id) : doc.canvas;
        var boxW = scopeOpts.panel_id ? box.w : box.width_mm;
        var boxH = scopeOpts.panel_id ? box.h : box.height_mm;
        pixelLine.textContent = "像素尺寸：" + px.width + " × " + px.height + " px（" +
          (selectedScope && scopeOpts.panel_id ? selectedScope.type + " " + scopeOpts.panel_id : "画布") + " " +
          boxW + " × " + boxH + " mm" + (dpi > 0 ? "，" + dpi + " DPI" : "") + "）";
      } catch (e) {
        pixelLine.textContent = "像素尺寸计算失败：" + e.message;
      }

      // filename (FigExport.suggestFilename); respect manual edits unless
      // the format changed (then regenerate so the extension follows)
      try {
        if (wantsPanel && !selectedScope) requireSingleSelectedScope(doc);
        var suggested = G.FigExport.suggestFilename(probe, meta.ext, scopeOpts);
        if (!ui.filenameDirty) {
          filenameInput.value = suggested;
        } else {
          // keep user's base name, swap only the extension
          var base = filenameInput.value.replace(/\.[A-Za-z0-9]+$/, "");
          if (base.length > 0) filenameInput.value = base + "." + meta.ext;
          else filenameInput.value = suggested;
        }
      } catch (e) {
        filenameInput.value = "";
      }

      // warnings: selection + pixel limits + journal dpi floor
      var warnings = [];
      if (wantsPanel && !selectedScope) warnings.push("单选一个 panel 或 chart 后才能按当前子图导出。");
      try {
        var px2 = G.FigExport.pixelSize(probe, scopeOpts);
        var w = pixelLimitWarning(px2.width, px2.height);
        if (w) warnings.push(w);
      } catch (e2) { /* already shown in pixelLine */ }
      if (presetNow && typeof presetNow.dpi_min === "number" && dpi > 0 && dpi < presetNow.dpi_min) {
        warnings.push("当前 DPI " + dpi + " 低于期刊「" + presetNow.name + "」的最低要求 " + presetNow.dpi_min + " DPI，投稿前请提高分辨率。");
      }
      if (warnings.length) {
        warnLine.textContent = warnings.join(" ");
        warnLine.style.display = "block";
      } else {
        warnLine.style.display = "none";
      }

      if (!state.busy) {
        exportBtn.textContent = "导出 " + (meta ? meta.label : ui.selectedFormat);
      }
      ui.lastDpi = dpi;
      ui.lastPanelId = scopeOpts.panel_id;
    }

    ui.refresh = refresh;
    ui.renderFormatRows = renderFormatRows;

    ui.getOpts = function () {
      var meta = selectedMeta();
      var doc = requireDocContext("Exporter.getOpts");
      var panelId = scopeSelect.value === "panel" ? requireSingleSelectedScope(doc).id : null;
      var transparent = transparentInput.checked === true;
      if (transparent && ui.selectedFormat !== "png") {
        throw new Error("transparent=true 仅支持 PNG；请先关闭透明背景或改选 PNG");
      }
      var dpi = getDpi();
      if (!ui.filenameDirty) {
        filenameInput.value = G.FigExport.suggestFilename(probeDoc(doc, dpi), meta.ext, { panel_id: panelId });
      }
      return {
        format: ui.selectedFormat,
        dpi: dpi,
        quality: parseFloat(qualityInput.value) || 0.92,
        panel_id: panelId,
        transparent: transparent,
        filename: filenameInput.value
      };
    };

    ui.stage = function (text) {
      progressText.textContent = text;
    };

    ui.setBusy = function (busy) {
      state.busy = busy;
      exportBtn.disabled = busy;
      exportBtn.textContent = busy ? "导出中…" : "导出 " + (selectedMeta() ? selectedMeta().label : ui.selectedFormat);
      progressArea.style.display = busy ? "block" : "none";
      if (!busy) progressText.textContent = "";
    };

    // events
    scopeSelect.addEventListener("change", function () {
      ui.filenameDirty = false;
      refresh();
    });
    dpiInput.addEventListener("input", refresh);
    dpiInput.addEventListener("change", refresh);
    qualityInput.addEventListener("input", function () {
      qualityValue.textContent = Math.round(parseFloat(qualityInput.value) * 100) + "%";
    });
    filenameInput.addEventListener("input", function () {
      ui.filenameDirty = true;
    });

    return ui;
  }

  function closeDialog() {
    var dlg = state.dialog;
    if (!dlg) return;
    state.dialog = null;
    try { document.removeEventListener("keydown", dlg.onKeydown, true); } catch (e) { /* ignore */ }
    try {
      if (dlg.ui.overlay && dlg.ui.overlay.parentNode) {
        dlg.ui.overlay.parentNode.removeChild(dlg.ui.overlay);
      }
    } catch (e2) { /* ignore */ }
    if (typeof dlg.resolve === "function") dlg.resolve(dlg.ui.lastExport || null);
  }

  function open() {
    if (state.busy) {
      var busyErr = new Error("已有导出任务正在进行，请等待其完成后再试");
      notifyError(busyErr.message);
      return Promise.reject(busyErr);
    }
    var doc;
    try {
      doc = requireDocContext("Exporter.open");
    } catch (e) {
      notifyError(e.message);
      return Promise.reject(e);
    }
    if (typeof G.FigExport === "undefined" || !G.FigExport) {
      var missing = new Error("Exporter.open：缺少内核模块 FigExport，请确认 lib/export.js 已按顺序加载");
      notifyError(missing.message);
      return Promise.reject(missing);
    }

    // Idempotent: a double-bound #btn-export or repeated open() must not
    // rebuild the dialog — hand back the existing dialog promise instead.
    if (state.dialog && state.dialog.promise) {
      return state.dialog.promise;
    }

    closeDialog(); // never two dialogs at once

    var ui = buildDialog();
    ui.renderFormatRows();
    ui.dpiInput.value = String(resolveDpi(doc.canvas, null));
    ui.refresh();

    var host = document.getElementById("modal-root") || document.body;
    host.appendChild(ui.overlay);

    function onKeydown(evt) {
      if (evt.key === "Escape") {
        evt.stopPropagation();
        closeDialog();
      }
    }
    document.addEventListener("keydown", onKeydown, true);
    ui.overlay.addEventListener("click", function (evt) {
      if (evt.target === ui.overlay) closeDialog();
    });
    ui.cancelBtn.addEventListener("click", function () { closeDialog(); });

    var promise = new Promise(function (resolve) {
      state.dialog = {
        ui: ui,
        resolve: resolve,
        onKeydown: onKeydown,
        promise: null
      };
    });
    state.dialog.promise = promise;
    return promise;
  }

  function runDialogExport() {
    var dlg = state.dialog;
    if (!dlg || state.busy) return;
    var ui = dlg.ui;
    var doc;
    try { doc = requireDocContext("Exporter.export"); } catch (e) {
      notifyError(e.message);
      return;
    }
    var opts;
    try {
      opts = ui.getOpts();
    } catch (e) {
      notifyError(e.message);
      return;
    }
    if (!opts.filename || opts.filename.trim().length === 0) {
      try {
        opts.filename = G.FigExport.suggestFilename(probeDoc(doc, opts.dpi), FORMAT_META[opts.format].ext, {
          panel_id: opts.panel_id
        });
        ui.filenameInput.value = opts.filename;
        ui.filenameDirty = false;
      } catch (e) {
        notifyError("文件名不能为空，且自动生成失败：" + e.message);
        return;
      }
    }
    ui.setBusy(true);
    doExport(doc, opts.format, {
      dpi: opts.dpi,
      quality: opts.quality,
      panel_id: opts.panel_id,
      transparent: opts.transparent,
      filename: opts.filename.trim(),
      onStage: ui.stage
    }).then(function (res) {
      var dlgNow = state.dialog;
      ui.setBusy(false);
      ui.lastExport = res;
      if (dlgNow === state.dialog && state.dialog) {
        ui.progressArea.style.display = "block";
        ui.progressText.textContent = "已下载 " + res.filename + "（" + formatBytes(res.bytes) + "）";
      }
      notify("已导出 " + res.filename + "（" + formatBytes(res.bytes) + "）", { type: "success" });
    }, function (err) {
      ui.setBusy(false);
      var reason = diagnose(opts.format, err);
      notifyError(reason);
      if (state.dialog === dlg) {
        ui.progressArea.style.display = "block";
        ui.progressText.setAttribute("role", "alert");
        ui.progressText.style.whiteSpace = "pre-wrap";
        ui.progressText.style.overflowWrap = "anywhere";
        ui.progressText.textContent = "导出失败：" + reason;
      }
    });
  }

  // ------------------------------------------------------------------
  // mount
  // ------------------------------------------------------------------

  function findExportButton(rootEl) {
    if (rootEl && rootEl.tagName === "BUTTON") return rootEl;
    if (rootEl && typeof rootEl.querySelector === "function") {
      var hit = rootEl.querySelector("#btn-export");
      if (hit) return hit;
    }
    try { return document.getElementById("btn-export"); } catch (e) { return null; }
  }

  function mount(rootEl) {
    if (state.mounted) return;
    state.mounted = true;

    var btn = findExportButton(rootEl);
    if (btn && !btn.__exporterBound) {
      btn.__exporterBound = true;
      btn.addEventListener("click", function () { open(); });
      state.boundButton = btn;
    }

    // Refresh an open dialog when the document changes (size / dpi / preset)
    try {
      if (G.App && typeof G.App.on === "function") {
        G.App.on("doc:changed", function () {
          if (state.dialog && state.dialog.ui && typeof state.dialog.ui.refresh === "function") {
            state.dialog.ui.renderFormatRows();
            state.dialog.ui.refresh();
          }
        });
        G.App.on("selection:changed", function () {
          if (state.dialog && state.dialog.ui && typeof state.dialog.ui.refresh === "function") {
            state.dialog.ui.refresh();
          }
        });
      }
    } catch (e) { /* state module not ready; dialog still works */ }
  }

  var Exporter = {
    FORMATS: EXPORT_FORMATS,
    mount: mount,
    open: open,
    quickExport: quickExport
  };

  G.Exporter = Exporter;
})(typeof globalThis !== "undefined" ? globalThis : this);
