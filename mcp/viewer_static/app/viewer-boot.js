/*
 * ViewerBoot — v3 查看器与本地服务 (viewer.py) 的集成层（app/viewer-boot.js）。
 *
 * 职责（PLUGIN-API.md：viewer_static = 编辑 + 导出 + 历史的复核查看器）：
 *   1. 页面加载时优先从 GET /api/current 载入当前 doc（含 history，可撤销）；
 *      服务端暂无文档（404）或服务不在（如 file:// 直开）时回退为前端新建空文档。
 *   2. doc:changed（包括 commit，不含 boot）是唯一保存入口，发布时同步把
 *      evt.doc debounce POST 回 /api/current，不等待 commit Promise 回调。
 *      GET 提供 save_token，POST 必须带本次保存自己的 base_token；空文档
 *      初次保存使用 null。真正无变化的 commit 不发布事件，也不触发保存。
 *   3. 保存严格串行：A 在途时产生的 B 会在 A 后 drain；响应只确认该请求的
 *      版本和 save_token。失败保留最新未确认文档并明确标脏，不自动无限重试；
 *      409 save_conflict 后禁止本会话继续自动覆盖，需导出备份并刷新核对。
 *      页面关闭/隐藏时只补发最新且未在途的版本；sendBeacon 返回 true 仅
 *      表示浏览器接受排队，绝不据此认定已经落盘。
 *
 * 本文件在 app/store.js 之后、app/main.js 之前加载（index.html 中注明），
 * 同时用于主工作台与常驻 AI 面板的服务接入。挂在 globalThis.ViewerBoot。
 */
(function (global) {
  "use strict";

  var CURRENT_URL = "/api/current";
  var DEBOUNCE_MS = 800;          // 实际 doc:changed 发布后等待回写的防抖时长
  var SAVE_TIMEOUT_MS = 10000;    // 单次回写超时
  var SAVE_FAIL_TOASTS = 3;       // 连续失败达到该次数后每次都弹提示

  var saveTimer = null;
  var pending = null;             // 最新未发送版本 {doc,version,reason}
  var active = null;              // 当前在途版本，禁止用旧响应确认新文档
  var drainPromise = null;
  var baseToken = null;           // 最后一次由服务端确认的 save_token
  var queuedVersion = 0;
  var acknowledgedVersion = 0;
  var consecutiveFailures = 0;
  var attached = false;
  var lastSavedAt = 0;
  var dirty = false;
  var saveConflict = null;
  var beaconHeld = false;         // 无响应 beacon 后保持 dirty，不盲目重发同一版本

  function has(name) {
    return typeof global[name] !== "undefined" && global[name] !== null;
  }

  function msgOf(err) {
    return err && err.message ? err.message : String(err);
  }

  function status(text) {
    if (has("App") && typeof App.status === "function") App.status(text);
  }

  function notifyError(text) {
    if (has("App") && typeof App.error === "function") App.error(text);
    if (has("Ui") && typeof Ui.toast === "function") {
      Ui.toast(text, { type: "error", ms: 8000 });
    }
  }

  function resultState(extra) {
    return {
      ok: !saveConflict && !dirty,
      dirty: dirty,
      save_conflict: !!saveConflict,
      version: acknowledgedVersion,
      extra: extra || null
    };
  }

  // ------------------------------------------------------------------
  // 1. 启动载入：GET /api/current 优先，失败回退空文档（由 main.js 兜底）
  // ------------------------------------------------------------------

  async function loadInitialDoc() {
    baseToken = null;
    if (typeof fetch !== "function") return null;
    try {
      var res = await fetch(CURRENT_URL, { cache: "no-store" });
      if (res.status === 404) {
        // 空文档初次保存必须把 base_token 明确发送为 null。
        console.info("[ViewerBoot] 服务端暂无文档，将新建空文档");
        return null;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      var j = await res.json();
      if (j && j.ok && j.doc && typeof j.doc === "object" && j.doc.canvas) {
        baseToken = typeof j.save_token === "string" ? j.save_token : null;
        status("已从查看器服务载入文档（GET " + CURRENT_URL + "）");
        return j.doc;
      }
      console.warn("[ViewerBoot] /api/current 响应异常，将新建空文档：", j);
      return null;
    } catch (err) {
      // 服务不在时同样从 null 开始；若服务恢复后已有文档，条件保存会返回
      // 409，而不是把可能已经存在的正式文档当作空文档覆盖。
      console.warn("[ViewerBoot] 未能从查看器服务载入文档（" + msgOf(err) +
        "），将新建空文档");
      return null;
    }
  }

  // ------------------------------------------------------------------
  // 2. 条件回写与有界 drain
  // ------------------------------------------------------------------

  function conflictError(payload) {
    var err = new Error("save_conflict：服务端文档已被其他窗口或外部请求替换");
    err.saveConflict = true;
    err.payload = payload || null;
    return err;
  }

  function postDoc(doc, reason, token, extra) {
    var body = JSON.stringify({
      doc: doc,
      reason: reason || "auto",
      base_token: token === undefined ? null : token,
      client_saved_at: new Date().toISOString()
    });
    var opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body
    };
    if (extra && extra.keepalive) opts.keepalive = true;
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, SAVE_TIMEOUT_MS);
    }
    return fetch(CURRENT_URL, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        var code = j && (j.error || j.code || j.error_code);
        var namedConflict = j && (j.save_conflict === true || code === "save_conflict" ||
          (code && code.code === "save_conflict"));
        if (res.status === 409 || namedConflict) throw conflictError(j);
        if (!res.ok) throw new Error("HTTP " + res.status + (code ? "：" + code : ""));
        if (!j || !j.ok) throw new Error(code ? String(code) : "服务端返回异常");
        // 新令牌是下一次条件保存的唯一合法基准；缺失时宁可标脏停下，
        // 也不能把后续保存降级成无条件的整文档覆盖。
        if (typeof j.save_token !== "string" || !j.save_token) {
          throw new Error("保存响应缺少 save_token，未确认后续保存基准");
        }
        return j;
      });
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  function scheduleSave(doc, reason) {
    queuedVersion += 1;
    pending = { doc: doc, version: queuedVersion, reason: reason || "" };
    dirty = true;
    // beacon 没有响应；只有出现更新版本或用户明确保存时才再次尝试。
    beaconHeld = false;
    if (saveTimer) clearTimeout(saveTimer);
    if (saveConflict) {
      status("修改仅保留在本页：save_conflict 未解决，自动保存已停止");
      return;
    }
    saveTimer = setTimeout(function () {
      ViewerBoot.flush().catch(function () {});
    }, DEBOUNCE_MS);
  }

  function keepLatestAfterFailure(batch) {
    if (!pending || pending.version < batch.version) pending = batch;
    active = null;
    dirty = true;
  }

  function reportFailure(err) {
    consecutiveFailures += 1;
    var text = "自动回写文档失败（最新修改仍保留在本页，未确认落盘）：" + msgOf(err);
    console.warn("[ViewerBoot] " + text);
    if (consecutiveFailures >= SAVE_FAIL_TOASTS || !has("App")) notifyError(text);
    else status(text + "；可继续编辑产生新版本，或点击保存重试");
  }

  function blockOnConflict(err) {
    saveConflict = err || conflictError();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var text = "保存冲突（save_conflict）：服务端已有更新文档。当前所有修改仍保留在本页，" +
      "自动保存已停止，绝不会自动覆盖；请先用“历史→导出工程”备份，再刷新页面核对并手动合并。";
    console.warn("[ViewerBoot] " + text);
    notifyError(text);
  }

  function flush(opts) {
    opts = opts || {};
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (opts.force) beaconHeld = false;
    if (saveConflict) return Promise.resolve(resultState());
    if (beaconHeld && !opts.force) return Promise.resolve(resultState("beacon-unconfirmed"));
    if (drainPromise) return drainPromise;
    if (!pending) return Promise.resolve(resultState());

    drainPromise = (async function () {
      while (pending && !saveConflict) {
        var batch = pending;
        pending = null;
        active = batch;
        dirty = true;
        try {
          // baseToken 在进入本批次时固定；B 必须等待 A 的新令牌后再发送。
          var j = await postDoc(batch.doc, batch.reason || "auto", baseToken, opts);
          baseToken = j.save_token;
          acknowledgedVersion = Math.max(acknowledgedVersion, batch.version);
          active = null;
          consecutiveFailures = 0;
          lastSavedAt = Date.now();
          dirty = !!pending;
          status("已自动回写文档到查看器服务（" +
            new Date(lastSavedAt).toLocaleTimeString() + "）");
          if (j.path) console.info("[ViewerBoot] 文档已落盘：" + j.path);
        } catch (err) {
          var hasNewer = !!(pending && pending.version > batch.version);
          keepLatestAfterFailure(batch);
          if (err && err.saveConflict) {
            blockOnConflict(err);
            break;
          }
          reportFailure(err);
          // 不重试同一个失败版本；若 A 在途时已产生 B，则仍尝试一次完整
          // 的 B。若服务端其实已写入 A，B 的旧 base_token 会安全地得到 409。
          if (!hasNewer) break;
        }
      }
      return resultState();
    })().catch(function (err) {
      // 非网络异常也不得破坏队列或丢掉最新文档。
      if (active) keepLatestAfterFailure(active);
      dirty = true;
      reportFailure(err);
      return resultState();
    }).finally(function () {
      active = null;
      drainPromise = null;
    });
    return drainPromise;
  }

  // 页面关闭/隐藏前的尽力补发。任何分支都不会清除 pending 或确认版本。
  function flushBeacon() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (saveConflict || !pending) return false;
    if (active || drainPromise) {
      // 在途 A 尚未取得新令牌，不能再发 B，更不能用重复 beacon 让 A 晚于 B。
      status("仍有保存请求在途，最新未确认文档继续保留为本页未保存状态");
      return false;
    }
    if (beaconHeld) return false;

    var batch = pending;
    var body = JSON.stringify({
      doc: batch.doc,
      reason: "pagehide",
      base_token: baseToken,
      client_saved_at: new Date().toISOString()
    });
    if (typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function") {
      try {
        var blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(CURRENT_URL, blob)) {
          beaconHeld = true;
          dirty = true;
          status("关闭前补发已被浏览器接收，但 sendBeacon=true 不代表已落盘；仍保留未保存标记");
          return true;
        }
      } catch (err) { /* 落到可由响应确认的 keepalive 分支 */ }
    }
    flush({ keepalive: true, force: true }).catch(function () {});
    return false;
  }

  // ------------------------------------------------------------------
  // 3. 挂接统一文档发布入口
  // ------------------------------------------------------------------

  function attachAutoSave() {
    if (!has("App") || typeof App.commit !== "function") {
      throw new Error("ViewerBoot.attachAutoSave：App 模块未就绪（app/state.js）");
    }
    if (attached) return;
    attached = true;

    if (typeof App.on === "function") {
      App.on("doc:changed", function (evt) {
        var reason = evt && evt.reason;
        if (!evt || !evt.doc || reason === "boot") return;
        // doc:changed 是唯一保存入口，并在事务发布时同步接收实际发布的
        // document。不能再等 App.commit 外层 Promise：自动快照或后续 undo
        // 可能先完成，旧 result.doc 回调会覆盖已经排队的新文档。
        scheduleSave(evt.doc, reason || "");
      });
    }

    if (typeof global.addEventListener === "function") {
      global.addEventListener("pagehide", flushBeacon);
    }
    if (global.document && typeof global.document.addEventListener === "function") {
      global.document.addEventListener("visibilitychange", function () {
        if (global.document.visibilityState === "hidden") flushBeacon();
      });
    }
  }

  global.ViewerBoot = {
    loadInitialDoc: loadInitialDoc,
    attachAutoSave: attachAutoSave,
    flush: flush,
    saveNow: function () { return flush({ force: true }); },
    flushBeacon: flushBeacon
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
