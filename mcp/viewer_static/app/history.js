/*
 * app/history.js — 版本历史面板（v1-web-app）
 *
 * Contract (APP-API.md):
 *   History.mount(panelEl)              时间线：rev、时间、label、source、缩略图、checkpoint 标记
 *   History.restore(rev) -> Promise     FigOps.revertTo -> App.publishDoc（先 Ui.confirm）
 *   History.tag(rev, label) -> Promise  给某版本命名，等待发布与 companion note
 *   History.diff(revA, revB) -> string  FigOps.diff + FigOps.describe 生成中文差异说明
 *   History.exportProject()             FigStore.exportProjectFile 下载 *.figureproj.json
 *   History.importProject(file)         App.publishDoc 替换当前文档（先 Ui.confirm）
 *
 * Known contract gap: History.tag() renames a record inside doc.history by
 * direct doc mutation (clone -> relabel -> App.publishDoc); the frozen EditOp enum
 * has no op for it. To leave a trace anyway, tag() additionally commits a
 * companion `note` op ("版本标记 rev N = 标签") through App.commit in the
 * same user action, so the rename appears in doc.history and provenance.
 * LIMITATION: the relabel itself is NOT undoable — undo/restore reverts doc
 * content from snapshots and cannot bring back a previous label; it can only
 * be traced after the fact via the note record.
 *
 * Depends on (load order): lib/* -> app/state.js (App) -> app/ui.js (Ui) -> this file.
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Module state
  // ------------------------------------------------------------------

  var panelEl = null;
  var summaryEl = null;
  var listEl = null;
  var fileInput = null;

  // Only content-addressed records enter the persistent thumbnail cache.
  // A doc id + rev can name different content after a reverted branch is edited.
  var thumbCache = new Map();
  var thumbChain = Promise.resolve(); // serialize raster jobs, newest last
  var THUMB_LIMIT = 40;               // only preview the 40 most recent revs

  var SOURCE_LABELS = {
    user: "用户",
    ai: "AI",
    preset: "预设",
    template: "模板",
    import: "导入",
    system: "系统"
  };

  // ------------------------------------------------------------------
  // Small helpers (no dependency on Ui internals beyond the contract)
  // ------------------------------------------------------------------

  function appDoc() {
    return global.App && global.App.doc ? global.App.doc : null;
  }

  function hasUi(name) {
    return global.Ui && typeof global.Ui[name] === "function";
  }

  function toast(msg, type) {
    if (hasUi("toast")) global.Ui.toast(msg, { type: type || "info" });
  }

  // Report failure through the status bar (App.error) and a toast.
  function fail(msg) {
    if (global.App && typeof global.App.error === "function") global.App.error(msg);
    toast(msg, "error");
  }

  function confirmBox(text) {
    if (hasUi("confirm")) return global.Ui.confirm(text);
    return Promise.resolve(global.confirm(text));
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function btn(label, title, onClick) {
    if (hasUi("button")) {
      return global.Ui.button({ label: label, title: title, onClick: onClick });
    }
    var b = el("button", null, label);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function formatTs(iso) {
    if (typeof iso !== "string") return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
      p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function findRecord(doc, rev) {
    var hist = (doc && doc.history) || [];
    for (var i = 0; i < hist.length; i++) {
      if (hist[i] && hist[i].rev === rev) return hist[i];
    }
    return null;
  }

  // The kernel owns the content playhead, including chained revert records.
  function contentRev(doc) {
    var Ops = global.FigOps;
    var fn = Ops && (Ops.contentRev || Ops.contentRevOf || Ops.getContentRev);
    if (typeof fn !== "function") throw new Error("缺少 FigOps.contentRev，无法读取历史播放位置");
    return fn(doc);
  }

  function historyOrigin(doc) {
    var origin = doc && doc.meta && doc.meta.history_origin;
    return origin && typeof origin.rev === "number" && origin.doc ? origin : null;
  }

  function replayError(doc, rev, err) {
    var origin = historyOrigin(doc);
    var detail = err && err.message ? err.message : String(err);
    var wrapped;
    if (origin && rev < origin.rev) {
      wrapped = new Error("版本 " + rev + " 早于持久化检查点 rev " + origin.rev +
        "；该旧工程只保留检查点及之后的完整重放能力，无法精确恢复更早内容");
      wrapped.historyCompatibility = "before-origin";
    } else {
      wrapped = new Error("版本 " + rev + " 的历史重放失败：" + detail);
      wrapped.historyCompatibility = origin ? "replay-failed" : "no-origin";
    }
    return wrapped;
  }

  function previewFallback(doc, rev, err) {
    var origin = historyOrigin(doc);
    if (origin && rev >= origin.rev && (!err || err.historyCompatibility !== "replay-failed")) {
      return "可按历史重放";
    }
    if (origin && rev < origin.rev) return "早于 rev " + origin.rev + " · 有限兼容";
    return "无法生成预览";
  }

  // ------------------------------------------------------------------
  // Snapshot access — doc content at a given rev (read-only)
  // ------------------------------------------------------------------

  // Persistent origins and the runtime cache are both interpreted by FigOps.
  // Never reconstruct history independently in the UI.
  function snapshotAt(rev, sourceDoc) {
    var doc = sourceDoc || appDoc();
    if (!doc) throw new Error("当前没有打开的文档");
    if (typeof rev !== "number" || !isFinite(rev) || Math.floor(rev) !== rev || rev < 0) {
      throw new Error("rev 必须是非负整数");
    }
    var origin = historyOrigin(doc);
    if (rev !== 0 && !findRecord(doc, rev) && (!origin || origin.rev !== rev)) {
      throw new Error("版本不存在或已被清理: rev " + rev);
    }
    if (!global.FigOps || typeof global.FigOps.ensureSnapshot !== "function") {
      throw new Error("缺少 FigOps.ensureSnapshot，无法按历史重放");
    }
    try {
      var cache = doc.__snapshots || {};
      return global.FigDoc.clone(global.FigOps.ensureSnapshot(doc, rev, cache));
    } catch (err) {
      throw replayError(doc, rev, err);
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async function restore(rev) {
    var doc = appDoc();
    if (!doc) { fail("当前没有打开的文档，无法还原"); return false; }
    var rec = findRecord(doc, rev);
    var origin = historyOrigin(doc);
    if (!rec && (!origin || origin.rev !== rev)) {
      fail("版本不存在: rev " + rev);
      return false;
    }

    var name = rec && rec.label ? "（" + rec.label + "）" : "";
    var ok = await confirmBox(
      "确定要还原到版本 " + rev + name + " 吗？画布将回到该版本的内容，" +
      "之后的所有操作仍保留在历史记录中。"
    );
    if (!ok) return false;

    try {
      // 在事务真正执行时读取最新 doc；确认对话框期间完成的 commit 不会被
      // 对话框打开前的旧 doc 覆盖。finalizeHistory 也在同一临界区内完成。
      await global.App.publishDoc(function (current) {
        return global.FigOps.revertTo(current, rev);
      }, { reason: "history:restore", finalizeHistory: true });
      global.App.status("已还原到版本 " + rev);
      toast("已还原到版本 " + rev, "success");
      return true;
    } catch (err) {
      fail("还原失败：" + (err && err.message ? err.message : err));
      return false;
    }
  }

  function tag(rev, label) {
    if (!appDoc()) throw new Error("当前没有打开的文档");
    if (typeof label !== "string" || label.trim().length === 0) {
      throw new Error("版本名称不能为空");
    }
    var cleanLabel = label.trim();
    return global.App.publishDoc(function (doc) {
      if (!findRecord(doc, rev)) throw new Error("版本不存在: rev " + rev);
      var next = global.FigDoc.touch(doc);
      // touch 深拷贝会丢弃运行期快照，图层/命名事务必须保留旧缓存才能撤销。
      var cache = doc.__snapshots || null;
      if (cache) {
        try {
          Object.defineProperty(next, "__snapshots", {
            value: cache, enumerable: false, configurable: true, writable: true
          });
        } catch (e) {
          try { next.__snapshots = cache; } catch (e2) { /* ignore */ }
        }
      }
      var rec = findRecord(next, rev);
      rec.label = cleanLabel;
      return next;
    }, { reason: "history:tag" }).then(function (next) {
      toast("版本 " + rev + " 已命名为“" + cleanLabel + "”", "success");
      // 等直接命名发布后再排入 companion note，避免在 publishDoc 临界区内
      // 重入 App.commit 所造成的数据倒退或队列自等待。
      var note = "版本标记 rev " + rev + " = " + cleanLabel;
      return global.App.commit([{ op: "note", note: note, reason: note }],
        { label: note, source: "user" })
        .catch(function (err) {
          fail("记录版本标记失败：" + (err && err.message ? err.message : err));
        })
        .then(function () { return next; });
    });
  }

  // Chinese diff report between two revs: summary + one line per op.
  function diff(revA, revB) {
    var docA = snapshotAt(revA);
    var docB = snapshotAt(revB);
    var result = global.FigOps.diff(docA, docB);
    var lines = ["版本 " + revA + " → 版本 " + revB + "：" + result.summary];
    if (!result.ops.length) {
      lines.push("两个版本内容完全一致，没有逐条变化。");
    } else {
      lines.push("逐条变化（共 " + result.ops.length + " 条）：");
      for (var i = 0; i < result.ops.length; i++) {
        lines.push((i + 1) + ". " + global.FigOps.describe(result.ops[i], docB));
      }
    }
    return lines.join("\n");
  }

  async function exportProject() {
    var doc = appDoc();
    if (!doc) { fail("当前没有打开的文档，无法导出"); return false; }
    try {
      // FigStore.projectFromDoc empties doc.history on the object it receives;
      // hand it a clone so the live document keeps its history.
      var copy = global.FigDoc.clone(doc);
      var blob = await global.FigStore.exportProjectFile(copy);
      var filename = "figure.figureproj.json";
      try {
        filename = global.FigExport.suggestFilename(doc, "json")
          .replace(/\.json$/, ".figureproj.json");
      } catch (e) { /* keep fallback name */ }
      global.FigExport.download(blob, filename);
      toast("工程文件已导出：" + filename, "success");
      return true;
    } catch (err) {
      fail("导出工程文件失败：" + (err && err.message ? err.message : err));
      return false;
    }
  }

  async function importProject(file) {
    var doc = appDoc();
    if (doc) {
      var ok = await confirmBox("导入工程文件将替换当前文档（历史记录随工程文件一起恢复）。是否继续？");
      if (!ok) return false;
    }
    try {
      if (!file) throw new Error("未选择文件");
      var res = await global.FigStore.importProjectFile(file);
      thumbCache.clear();
      await global.App.publishDoc(res.doc, { reason: "history:import" });
      var n = (res.doc.history || []).length;
      toast("工程导入成功，共 " + n + " 条历史记录", "success");
      return true;
    } catch (err) {
      fail("导入工程文件失败：" + (err && err.message ? err.message : err));
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Timeline UI
  // ------------------------------------------------------------------

  function render() {
    if (!listEl) return;
    listEl.textContent = "";
    var doc = appDoc();
    if (!doc) {
      listEl.appendChild(el("div", "history-empty", "当前没有打开的文档。"));
      if (summaryEl) summaryEl.textContent = "";
      return;
    }
    var hist = (doc.history || []).slice().reverse();
    var cur = contentRev(doc);
    if (summaryEl) {
      summaryEl.textContent = "共 " + hist.length + " 条记录 · 当前版本 rev " + cur;
    }
    if (!hist.length) {
      listEl.appendChild(el("div", "history-empty", "暂无历史记录，编辑画布后将自动生成。"));
      return;
    }

    var thumbRows = 0;
    for (var i = 0; i < hist.length; i++) {
      var rec = hist[i];
      if (!rec || typeof rec.rev !== "number") continue;
      var isCurrent = rec.rev === cur;
      listEl.appendChild(buildRow(rec, isCurrent, thumbRows < THUMB_LIMIT));
      if (thumbRows < THUMB_LIMIT) thumbRows++;
    }
  }

  function buildRow(rec, isCurrent, wantThumb) {
    var row = el("div", "history-row");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.alignItems = "flex-start";
    row.style.padding = "6px 4px";
    row.style.borderBottom = "1px solid rgba(0,0,0,0.08)";
    if (isCurrent) row.style.background = "rgba(64,158,255,0.10)";

    // --- thumbnail ---
    var thumbBox = el("div", "history-thumb");
    thumbBox.style.cssText =
      "flex:0 0 56px;height:42px;display:flex;align-items:center;justify-content:center;" +
      "background:#eef1f4;border:1px solid rgba(0,0,0,0.12);border-radius:3px;overflow:hidden;";
    thumbBox.textContent = wantThumb ? "…" : "无快照";
    if (wantThumb) thumbBox.title = "仅预览最近 " + THUMB_LIMIT + " 个版本";
    row.appendChild(thumbBox);
    if (wantThumb) scheduleThumb(rec, thumbBox);

    // --- info ---
    var info = el("div", "history-info");
    info.style.cssText = "flex:1 1 auto;min-width:0;line-height:1.5;";

    var head = el("div", "history-head");
    head.appendChild(el("b", "history-rev", "#" + rec.rev));
    var timeText = formatTs(rec.ts);
    if (timeText) head.appendChild(el("span", "history-time", " · " + timeText));
    var src = SOURCE_LABELS[rec.source] || rec.source || "未知";
    var srcBadge = el("span", "history-source", src);
    srcBadge.style.cssText =
      "margin-left:6px;padding:0 6px;border-radius:8px;font-size:11px;" +
      "background:" + (rec.source === "ai" ? "#fdf0e6" : "#e8f0fe") + ";";
    head.appendChild(srcBadge);
    if (rec.checkpoint) {
      var cp = el("span", "history-checkpoint", "★ 检查点");
      cp.style.cssText =
        "margin-left:6px;padding:0 6px;border-radius:8px;font-size:11px;background:#fff7e0;color:#8a6d00;";
      head.appendChild(cp);
    }
    if (rec.kind === "revert") {
      head.appendChild(el("span", "history-kind", " · 回退自 #" + (rec.revert_to != null ? rec.revert_to : "?")));
    }
    if (isCurrent) {
      var curBadge = el("span", "history-current", "当前");
      curBadge.style.cssText =
        "margin-left:6px;padding:0 6px;border-radius:8px;font-size:11px;background:#409eff;color:#fff;";
      head.appendChild(curBadge);
    }
    info.appendChild(head);

    info.appendChild(el("div", "history-label", rec.label ? rec.label : "未命名"));
    var opsLen = Array.isArray(rec.ops) ? rec.ops.length : 0;
    info.appendChild(el(
      "div",
      "history-meta",
      opsLen ? opsLen + " 项操作" + (rec.doc_sha256 ? " · sha256 已记录" : "") : "无操作明细"
    ));
    row.appendChild(info);

    // --- actions ---
    var actions = el("div", "history-actions");
    actions.style.cssText = "flex:0 0 auto;display:flex;flex-direction:column;gap:4px;";
    var rename = btn("命名", "给该版本命名", function () { openTagModal(rec.rev, rec.label); });
    if (rename.style) rename.style.fontSize = "12px";
    var restoreBtn = btn("还原", "把画布还原到该版本", function () { restore(rec.rev); });
    if (restoreBtn.style) restoreBtn.style.fontSize = "12px";
    actions.appendChild(rename);
    actions.appendChild(restoreBtn);
    row.appendChild(actions);

    return row;
  }

  function thumbCacheKey(doc, rec) {
    var hash = rec && rec.doc_sha256;
    if (typeof hash !== "string" || !hash) return null;
    return doc.id + ":" + rec.rev + ":" + hash;
  }

  function isThumbGeneration(doc, rec) {
    return appDoc() === doc && findRecord(doc, rec.rev) === rec;
  }

  // Thumbnails are produced one at a time so the canvas stays responsive.
  function scheduleThumb(rec, box) {
    var doc = appDoc();
    if (!doc) return;
    var key = thumbCacheKey(doc, rec);
    if (key && thumbCache.has(key)) {
      applyThumb(thumbCache.get(key), box, rec.rev, doc);
      return;
    }
    thumbChain = thumbChain.then(function () {
      if (!isThumbGeneration(doc, rec)) return;
      if (key && thumbCache.has(key)) {
        if (box.isConnected) applyThumb(thumbCache.get(key), box, rec.rev, doc);
        return;
      }
      return generateThumb(rec, doc).then(function (url) {
        if (!isThumbGeneration(doc, rec)) return;
        if (key) thumbCache.set(key, url);
        if (box.isConnected) applyThumb(url, box, rec.rev, doc);
      }).catch(function (err) {
        if (!isThumbGeneration(doc, rec)) return;
        if (key) thumbCache.set(key, null);
        if (box.isConnected) {
          box.textContent = previewFallback(doc, rec.rev, err);
          box.title = err && err.message ? err.message : String(err);
        }
      });
    });
  }

  async function generateThumb(rec, doc) {
    if (typeof rec.thumbnail_ref === "string" && rec.thumbnail_ref) {
      return rec.thumbnail_ref; // stored by FigStore.snapshot
    }
    var snap = snapshotAt(rec.rev, doc);
    var url = await global.FigStore.thumbnail(snap);
    return url || null;
  }

  function applyThumb(url, box, rev, doc) {
    if (url) {
      var img = document.createElement("img");
      img.src = url;
      img.alt = "版本缩略图";
      img.style.cssText = "width:100%;height:100%;object-fit:contain;";
      box.textContent = "";
      box.appendChild(img);
    } else {
      box.textContent = previewFallback(doc, rev);
      box.title = historyOrigin(doc) && rev >= historyOrigin(doc).rev
        ? "运行期没有缩略图；还原与对比仍可从持久化检查点按历史重放"
        : "该版本早于当前持久化检查点，只有有限兼容";
    }
  }

  // ------------------------------------------------------------------
  // Modals
  // ------------------------------------------------------------------

  function closeModal(handle) {
    try { if (handle && typeof handle.close === "function") handle.close(); } catch (e) { /* noop */ }
  }

  function openTagModal(rev, currentLabel) {
    if (!hasUi("modal")) {
      var name = global.prompt("给版本 " + rev + " 命名：", currentLabel || "");
      if (name != null && name.trim()) {
        try {
          Promise.resolve(tag(rev, name)).catch(function (err) { fail(err.message); });
        } catch (err) { fail(err.message); }
      }
      return;
    }
    var body = el("div");
    body.appendChild(el("div", null, "版本 #" + rev + " 的名称："));
    var input = document.createElement("input");
    input.type = "text";
    input.value = currentLabel || "";
    input.placeholder = "如：初稿 / 终版-已核对字号";
    input.style.cssText = "width:100%;margin-top:6px;padding:4px 6px;";
    body.appendChild(input);
    var handle = global.Ui.modal({
      title: "命名版本",
      body: body,
      actions: [
        {
          label: "取消",
          onClick: function () { closeModal(handle); }
        },
        {
          label: "确定",
          primary: true,
          onClick: function () {
            try {
              Promise.resolve(tag(rev, input.value)).then(function () {
                closeModal(handle);
              }).catch(function (err) {
                fail(err.message); // 保留模态框，修正名称后可重试
              });
            } catch (err) {
              fail(err.message);
            }
          }
        }
      ]
    });
    if (input && typeof input.focus === "function") input.focus();
  }

  function openDiffModal() {
    var doc = appDoc();
    if (!doc) { fail("当前没有打开的文档，无法对比"); return; }
    var hist = (doc.history || []).slice().sort(function (a, b) { return (a.rev || 0) - (b.rev || 0); });
    if (!hist.length) { toast("暂无历史记录，无法对比", "info"); return; }

    var body = el("div");

    function selectBox(labelText) {
      var wrap = el("div");
      wrap.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
      wrap.appendChild(el("span", null, labelText));
      var sel = document.createElement("select");
      sel.style.cssText = "flex:1;padding:3px 5px;";
      var cur = contentRev(doc);
      var optCur = document.createElement("option");
      optCur.value = "cur";
      optCur.textContent = "当前版本（rev " + cur + "）";
      sel.appendChild(optCur);
      for (var i = 0; i < hist.length; i++) {
        var r = hist[i];
        var opt = document.createElement("option");
        opt.value = String(r.rev);
        opt.textContent = "#" + r.rev + " " + (r.label ? r.label : "未命名") + " " + formatTs(r.ts);
        sel.appendChild(opt);
      }
      wrap.appendChild(sel);
      body.appendChild(wrap);
      return sel;
    }

    var selA = selectBox("版本 A（旧）：");
    var selB = selectBox("版本 B（新）：");
    selA.selectedIndex = 1;    // earliest record (options: 当前版本 + revs ascending)
    selB.selectedIndex = 0;    // 当前版本 (the live content playhead)

    var pre = el("pre", "history-diff-result");
    pre.style.cssText =
      "max-height:320px;overflow:auto;white-space:pre-wrap;background:#f6f7f9;" +
      "border:1px solid rgba(0,0,0,0.10);padding:8px;font-size:12px;line-height:1.6;";
    pre.textContent = "选择两个版本后点击“生成差异说明”。";
    body.appendChild(pre);

    function resolveRev(value) {
      if (value === "cur") return contentRev(doc);
      return parseInt(value, 10);
    }

    function runDiff() {
      try {
        var a = resolveRev(selA.value);
        var b = resolveRev(selB.value);
        if (a === b) {
          pre.textContent = "两个选择指向同一版本（rev " + a + "），没有差异。";
          return;
        }
        pre.textContent = diff(a, b);
      } catch (err) {
        pre.textContent = "生成差异说明失败：" + (err && err.message ? err.message : err);
      }
    }

    var handle = hasUi("modal")
      ? global.Ui.modal({
          title: "版本对比",
          body: body,
          actions: [
            { label: "关闭", onClick: function () { closeModal(handle); } },
            { label: "生成差异说明", primary: true, onClick: runDiff }
          ]
        })
      : null;
    if (!handle) runDiff(); // no Ui modal available: still computed, result in `pre` (detached)
  }

  // ------------------------------------------------------------------
  // Mount
  // ------------------------------------------------------------------

  function mount(panel) {
    if (!panel || typeof panel.appendChild !== "function") {
      throw new Error("History.mount: 需要传入历史面板的挂载元素");
    }
    panelEl = panel;
    panelEl.textContent = "";

    var header = el("div", "history-toolbar");
    header.style.cssText =
      "display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:6px 4px;";

    header.appendChild(btn("导出工程", "下载 *.figureproj.json 工程文件（含全部历史）", function () {
      exportProject();
    }));
    header.appendChild(btn("导入工程", "从 *.figureproj.json 工程文件恢复（替换当前文档）", function () {
      if (fileInput) fileInput.click();
    }));
    header.appendChild(btn("版本对比", "对比两个版本并生成中文差异说明", function () {
      openDiffModal();
    }));

    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json,.figureproj.json";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      if (f) importProject(f);
      fileInput.value = ""; // allow picking the same file again
    });
    header.appendChild(fileInput);
    panelEl.appendChild(header);

    summaryEl = el("div", "history-summary");
    summaryEl.style.cssText = "padding:0 4px 4px;font-size:12px;color:#666;";
    panelEl.appendChild(summaryEl);

    listEl = el("div", "history-list");
    listEl.style.cssText = "overflow:auto;";
    panelEl.appendChild(listEl);

    // Refresh on the standard event bus — no polling.
    if (global.App && typeof global.App.on === "function") {
      global.App.on("doc:changed", render);
      global.App.on("history:changed", render);
    }
    render();
  }

  // ------------------------------------------------------------------
  // Export (IIFE on globalThis; replaces the legacy DOM History interface
  // as required by APP-API.md)
  // ------------------------------------------------------------------

  var History = {
    mount: mount,
    restore: restore,
    tag: tag,
    diff: diff,
    exportProject: exportProject,
    importProject: importProject
  };

  global.History = History;
})(typeof globalThis !== "undefined" ? globalThis : this);
