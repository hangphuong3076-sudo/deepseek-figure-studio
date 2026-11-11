/**
 * app/ai.js — AI 对话面板（v1-web-app）
 * Contract (APP-API.md):
 *   AiPanel.mount(panelEl)      固定对话区：自然问答 + 编辑预览 + 独立审阅
 *   AiPanel.chat(instruction)   FigAI.chat(messages,{json:false})，严格要求非空 {text}；
 *                               展示用户/模型消息、等待与真实错误重试，不虚构离线评价
 *   AiPanel.retryChat()         仅重试最近一次失败的问答，不重复追加用户消息
 *   AiPanel.ask(instruction)    FigAI.requestOps({doc, instruction, anchors, selection})
 *                               展示 explanation 与 ops 列表（逐条 FigOps.describe）
 *   AiPanel.applyPending()      App.commit(ops, {source:"ai"})
 *   AiPanel.discardPending()
 *   AiPanel.referenceElement(id) App.select 定位；复用匹配锚点，否则经
 *                               Anchors.addFromSelection 真实提交一次并追加一条 chip
 *   AiPanel.referenceAnchor(id) 直接引用已有原生锚点，不创建或提交
 *   AiPanel.appendAnchorRef(a)  输入框追加 [n]（幂等、保留正文）；chip 显示
 *                               [n]、@锚点id、元素名与 mm 坐标，不抢键盘焦点。
 *                               ask 时 [n]/裸数字按映射改写为原生 "@<锚点id>"，
 *                               引用了不同编号的子句拆分逐段请求，每个编号精确
 *                               路由到对应锚点，绝不靠模型猜（离线 fallback 同样有效）
 *   AiPanel.clearAnchorRefs()   清除本次 [n] 引用记录
 *   AiPanel.review()            仅明确 direct 模式栅格化画布；bridge/offline 均只用
 *                               无截图结构化上下文 → FigAI.requestReview → 逐条应用/忽略
 *   AiPanel.mode()              -> Promise<"model"|"fallback"|"mixed">
 *   AiPanel.refreshStatus()     桥检测/设置变更后刷新徽章；桥模式下用一次真实
 *                               chat 探测确认模型可用（而非 FigAI.enabled()），
 *                               探测有去重，不会在每次 ask 时多发模型请求
 *   AiPanel.statusText()        -> string|null  徽章当前文案（供设置面板状态行复用）
 *   AiPanel.hasPendingWork()    -> bool  有待应用 AI 操作/审阅意见或请求进行中
 *                                        （独立助手窗口据此决定能否安全刷新文档）
 * 「模型响应无法解析，已回退」；未配置 key 的独立窗口 → 传统离线模式。
 * 进度显示绝不伪造：AiPanel 在收集选区/文档 → 触达模型（桥路径下按 request_id
 * 轮询 GET /api/ai/progress 的真实阶段：model_pending → model_prepare →
 * model_stream（真实增量计数）→ model_complete）→ 解析输出 → 等待确认 →
 * 写入文档各阶段显示 indeterminate busy 条 + 阶段徽章（与模式徽章同色系），
 * 失败时显示真实原因；操作在「应用」前一律只是 intents 预览，绝不显示
 * 「已完成/已写入」。request_id 由 Settings.reserveRequestId 登记、fetch 钩子
 * 只附加到本机桥请求体（不影响 DeepSeek 官方参数），多组拆分请求各持各的 id。
 */
(function () {
  "use strict";

  var g = globalThis;
  var AiPanel = {};
  g.AiPanel = AiPanel;

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------
  var els = { root: null, badge: null, input: null, chatBtn: null, askBtn: null,
              chatLog: null, taskDetails: null,
              pendingBox: null, pendingModeEl: null, pendingExpEl: null,
              pendingSegmentsEl: null, emptyHint: null, pendingList: null, pendingBtnRow: null,
              applyBtn: null, discardBtn: null, reviewBtn: null, reviewList: null,
              refChips: null };
  var state = {
    pendingOps: null,        // EditOp[] | null
    pendingExplanation: "",
    pendingInstruction: "",
    pendingVersion: null,    // 生成时的文档对象、id、内容 sha 与事件代次
    pendingStale: false,
    pendingMode: null,       // 本批预览自己的模式，不受后续问答/审阅覆盖
    pendingSegments: [],     // 多编号分组的逐段 mode/error
    applying: null,          // pending 与单条 review 共用的在途应用 Promise
    documentEpoch: 0,        // 每次 doc:changed 都递增；不以 rev 充当变更锁
    anchorLedgerDocId: null,
    knownAnchorIds: {},
    anchorTombstones: {},    // 本文件生命周期内删除过的 anchor id，防止旧引用复活
    lastMode: null,          // "model" | "fallback" | "mixed"
    busy: false,
    reviewItems: [],         // 当前展示的审阅意见
    reviewVersion: null,     // 审阅生成时的 base document/history epoch
    reviewStale: false,
    lastBadge: null,         // {kind, detail, src:"ask"|"probe", at} 最近徽章状态
    anchorRefs: [],          // 本次会话的 [n] @anchor-id 引用记录
    messages: [],            // 用户、模型与本地错误消息；只保存文本，不写入文档
    lastChatText: "",
    lastChatError: null,     // 仅最近一次失败显示重试，避免旧按钮重试错请求
    activeChatMessage: null
  };

  // ------------------------------------------------------------------
  // 阶段进度（真实阶段，绝不伪造百分比）
  // ------------------------------------------------------------------
  var progress = {
    kind: null,              // PHASE_DEFS 的 key；null = 无阶段可显示
    detail: "",
    groupIndex: 0,           // 多组拆分（多编号）时当前组序号（1 起），0 = 不分组
    groupTotal: 0,
    requestId: null,         // 最近一次登记的 request_id（仅用于展示追踪）
    busyLabel: ""            // 非空 = busy 条可见（indeterminate，无百分比）
  };
  var els2 = {};             // 进度区 DOM（与 els 分开，mount 时填充）
  var pollTimer = null;
  var pollGen = 0;           // 轮询代次：stop 后在途 tick 的迟到响应一律丢弃
  var askSeq = 0;
  var reviewSeq = 0;
  var POLL_INTERVAL_MS = 1000;

  var PHASE_DEFS = {
    collect:        { text: "收集选区与文档", tone: "idle" },
    local_answer:   { text: "整理对话与文档上下文（尚未请求模型）", tone: "idle" },
    model_pending:  { text: "已提交模型请求，等待响应", tone: "idle" },
    model_prepare:  { text: "模型请求准备中", tone: "model" },
    model_stream:   { text: "模型返回中", tone: "model" },
    model_complete: { text: "模型返回完成", tone: "model" },
    parse:          { text: "解析模型输出", tone: "idle" },
    chat_forward:   { text: "请求已转发到模型桥", tone: "idle" },
    bridge_done:    { text: "模型桥返回完成", tone: "model" },
    bridge_error:   { text: "模型桥请求失败", tone: "error" },
    model_error:    { text: "模型请求失败", tone: "error" },
    review_wait:    { text: "等待确认：以下操作仅为预览，尚未写入文档", tone: "fallback" },
    applying:       { text: "正在写入文档", tone: "model" },
    apply_error:    { text: "写入未生效，待应用操作已保留", tone: "error" },
    applied_done:   { text: "已写入文档", tone: "model" },
    offline:        { text: "离线模式（未调用模型）", tone: "fallback" }
  };

  // tone 与模式徽章同色系（STYLE_* 在下方定义，此处延迟解析）。
  function toneStyle(tone) {
    if (tone === "model") return STYLE_MODEL;
    if (tone === "fallback") return STYLE_FALLBACK;
    if (tone === "error") return STYLE_ERROR;
    return STYLE_IDLE;
  }

  // busy 条自包含样式：indeterminate 滑动条，无百分比——阶段文字才是真实信息。
  function ensureProgressStyles() {
    if (document.getElementById("ai-progress-style")) return;
    var css =
      ".ai-busy-track{height:6px;border-radius:3px;background:#e5e7eb;overflow:hidden;position:relative;width:100%;}" +
      ".ai-busy-fill{position:absolute;top:0;left:0;height:100%;width:30%;background:#2f6fed;border-radius:3px;" +
      "animation:ai-busy-slide 1.1s linear infinite;}" +
      "@keyframes ai-busy-slide{0%{left:-30%}100%{left:100%}}" +
      ".ai-phase-chip{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:bold;}";
    var el = document.createElement("style");
    el.id = "ai-progress-style";
    el.textContent = css;
    document.head.appendChild(el);
  }

  function setProgressPhase(kind, detail, meta) {
    progress.kind = PHASE_DEFS[kind] ? kind : null;
    progress.detail = detail || "";
    if (meta) {
      if (meta.gi != null) progress.groupIndex = meta.gi;
      if (meta.gt != null) progress.groupTotal = meta.gt;
      progress.requestId = meta.rid || null;
    }
    renderProgress();
  }

  function setProgressBusy(label) {
    progress.busyLabel = label || "";
    renderProgress();
  }

  function clearProgress() {
    progress.kind = null;
    progress.detail = "";
    progress.groupIndex = 0;
    progress.groupTotal = 0;
    progress.requestId = null;
    progress.busyLabel = "";
    renderProgress();
  }

  function renderProgress() {
    if (!els2.wrap) return;
    var show = !!(progress.busyLabel || progress.kind);
    els2.wrap.style.display = show ? "block" : "none";
    if (!show) return;
    els2.busyRow.style.display = progress.busyLabel ? "flex" : "none";
    els2.busyLabel.textContent = progress.busyLabel || "";
    els2.phaseRow.style.display = progress.kind ? "flex" : "none";
    if (progress.kind) {
      var def = PHASE_DEFS[progress.kind];
      els2.chip.setAttribute("style", toneStyle(def.tone) + "white-space:nowrap;");
      els2.chip.textContent = def.text;
      var groupText = progress.groupTotal > 1
        ? "第 " + progress.groupIndex + "/" + progress.groupTotal + " 组 · " : "";
      var detailText = (def.text.indexOf("预览") >= 0 ? "" : groupText) + (progress.detail || "");
      els2.detail.style.display = detailText ? "block" : "none";
      els2.detail.textContent = detailText;
      els2.detail.title = progress.requestId ? ("request_id: " + progress.requestId) : "";
    }
  }

  function startProgressPolling(rid, gi, gt) {
    stopProgressPolling();
    if (!rid || typeof fetch !== "function") return;
    if (!(g.Settings && typeof g.Settings.bridgeMode === "function" && g.Settings.bridgeMode())) return;
    var gen = ++pollGen;
    var tick = function () {
      fetch("/api/ai/progress?request_id=" + encodeURIComponent(rid), { cache: "no-store" })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (j) {
          // 已停止（gen 已过期）或在途旧代次的迟到响应：不覆盖当前阶段 UI
          if (gen !== pollGen) return;
          if (!j || !j.ok || !j.task || j.task.request_id !== rid) return;
          var t = j.task;
          var detail = t.error || t.detail || "";
          setProgressPhase(t.phase, detail, { gi: gi, gt: gt, rid: rid });
        })
        .catch(function () { /* 状态查询失败不打扰用户，下一轮再试 */ });
    };
    tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }

  function stopProgressPolling() {
    pollGen += 1; // 使在途 tick 的响应失效
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // 本页是否为独立助手窗口（assistant.html）——决定标题按钮形态。
  var IS_ASSISTANT_PAGE = /(^|\/)assistant\.html$/.test(String(location.pathname));

  // ------------------------------------------------------------------
  // small DOM helpers（不依赖 app/ui.js，避免跨模块耦合）
  // ------------------------------------------------------------------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (k === "style") el.setAttribute("style", v);
        else if (k === "className") el.className = v;
        else if (k === "disabled") el.disabled = !!v;
        else if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else el.setAttribute(k, v == null ? "" : String(v));
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function toast(text, opts) {
    if (g.Ui && typeof g.Ui.toast === "function") {
      try { g.Ui.toast(text, opts || {}); return; } catch (e) { /* fallthrough */ }
    }
    try { console.log("[AiPanel] " + text); } catch (e) { /* ignore */ }
  }

  // App.commit 可能是同步也可能返回 Promise，统一处理。
  function doCommit(ops, opts) {
    var r = g.App.commit(ops, opts);
    if (r && typeof r.then === "function") return r;
    return Promise.resolve(r);
  }

  function requireApp() {
    if (!g.App || !g.App.doc) throw new Error("App 尚未初始化，无法使用 AI 面板");
  }

  // ------------------------------------------------------------------
  // mode badge —— 绝不伪装
  // ------------------------------------------------------------------
  var STYLE_MODEL = "display:inline-block;padding:2px 10px;border-radius:10px;" +
    "background:#e6f4ea;color:#1a7f37;font-weight:bold;font-size:12px;";
  var STYLE_FALLBACK = "display:inline-block;padding:2px 10px;border-radius:10px;" +
    "background:#ffd21e;color:#7a2e00;font-weight:bold;font-size:13px;border:2px solid #d97706;";
  var STYLE_ERROR = "display:inline-block;padding:2px 10px;border-radius:10px;" +
    "background:#fde8e8;color:#b91c1c;font-weight:bold;font-size:13px;border:2px solid #dc2626;";
  var STYLE_IDLE = "display:inline-block;padding:2px 10px;border-radius:10px;" +
    "background:#f0f0f0;color:#666;font-weight:bold;font-size:12px;";

  var BADGE_KINDS = {
    "model":          { text: "当前模式：DeepSeek 模型", style: STYLE_MODEL },
    "mixed":          { text: "当前模式：混合（模型 + 离线规则）", style: STYLE_FALLBACK },
    "model-bridge":   { text: "当前模式：DeepSeek 模型（DSH 桥）", style: STYLE_MODEL },
    "bridge-probing": { text: "正在检测 DSH 桥…", style: STYLE_IDLE },
    "bridge-down":    { text: "DSH 桥未连接", style: STYLE_ERROR },
    "model-error":    { text: "模型请求失败，已回退", style: STYLE_ERROR },
    "parse-error":    { text: "模型响应无法解析，已回退", style: STYLE_FALLBACK },
    "offline":        { text: "离线模式（未配置 API Key）", style: STYLE_FALLBACK },
    "fallback":       { text: "离线模式（未调用模型）", style: STYLE_FALLBACK },
    "idle":           { text: "当前模式：未调用", style: STYLE_IDLE }
  };

  // 探测/配置推导可以覆盖的徽章种类；ask/review 的真实请求结果不被探测覆盖。
  var PROBE_OWNED_KINDS = {
    "bridge-probing": 1, "model-bridge": 1, "bridge-down": 1, "idle": 1, "offline": 1
  };

  function badgeDef(kind) {
    return BADGE_KINDS[kind] || BADGE_KINDS.idle;
  }

  function renderBadge() {
    if (!els.badge) return;
    var b = state.lastBadge;
    var def = badgeDef(b ? b.kind : "idle");
    els.badge.textContent = def.text;
    els.badge.setAttribute("style", def.style);
    els.badge.title = (b && b.detail) ? b.detail : "";
  }

  function badgeShortText() {
    return badgeDef(state.lastBadge ? state.lastBadge.kind : "idle")
      .text.replace(/^当前模式：/, "");
  }

  function setBadge(kind, detail, src) {
    state.lastBadge = { kind: kind, detail: detail || "", src: src || "probe", at: Date.now() };
    renderBadge();
  }

  // 当前配置形态："bridge"（DSH 桥，零 key）| "direct"（用户自填 key）| "off"（传统离线）
  function configKind() {
    if (g.Settings && typeof g.Settings.bridgeMode === "function") {
      try { if (g.Settings.bridgeMode()) return "bridge"; } catch (e) { /* fallthrough */ }
    }
    return (g.FigAI && typeof g.FigAI.enabled === "function" && g.FigAI.enabled())
      ? "direct" : "off";
  }

  // requestOps/requestReview 返回 mode="fallback" 时，结合包裹层记录的
  // 最近一次 FigAI.chat 结果推断真实原因（内核 lib/ai.js 会吞掉所有错误）。
  function fallbackCause(sinceT0) {
    var rec = (g.Settings && typeof g.Settings.lastModelCall === "function")
      ? g.Settings.lastModelCall() : null;
    if (rec && rec.at >= sinceT0 && !rec.ok) {
      return (rec.source === "bridge")
        ? { kind: "bridge-down", detail: rec.message || "DSH 桥请求失败" }
        : { kind: "model-error", detail: rec.message || "模型请求失败" };
    }
    if (rec && rec.at >= sinceT0 && rec.ok) {
      return { kind: "parse-error", detail: "模型已返回内容，但无法解析为可用的操作" };
    }
    var enabled = !!(g.FigAI && typeof g.FigAI.enabled === "function" && g.FigAI.enabled());
    return enabled ? { kind: "fallback", detail: "" } : { kind: "offline", detail: "" };
  }

  // ------------------------------------------------------------------
  // DSH 桥连通性探测（真实 chat 请求，非 enabled() 推断）
  // ------------------------------------------------------------------
  var PROBE_MIN_INTERVAL_MS = 30000;
  var PROBE_TIMEOUT_MS = 15000;
  var probe = { inFlight: false, lastAt: 0, ok: null, detail: "", configKind: null };

  function lastRecordSince(t0) {
    var rec = (g.Settings && typeof g.Settings.lastModelCall === "function")
      ? g.Settings.lastModelCall() : null;
    return (rec && rec.at >= t0 && !rec.ok) ? rec : null;
  }

  function maybeProbeBridge() {
    if (configKind() !== "bridge") return;
    if (probe.inFlight) return;
    if (probe.lastAt && Date.now() - probe.lastAt < PROBE_MIN_INTERVAL_MS) return;
    if (!g.FigAI || typeof g.FigAI.chat !== "function") return;
    probe.inFlight = true;
    var t0 = Date.now();
    if (!state.lastBadge || PROBE_OWNED_KINDS[state.lastBadge.kind]) {
      setBadge("bridge-probing", "", "probe");
    }
    g.FigAI.chat(
      [{ role: "user", content: "连通性测试，请只回复两个字：正常" }],
      { json: false, timeoutMs: PROBE_TIMEOUT_MS }
    ).then(function () {
      probe.ok = true;
      probe.detail = "";
    }, function (err) {
      probe.ok = false;
      var rec = lastRecordSince(t0);
      probe.detail = rec ? rec.message
        : ((g.FigAI && g.FigAI.explainError) ? g.FigAI.explainError(err)
          : (err && err.message ? err.message : String(err)));
    }).then(function () {
      probe.inFlight = false;
      probe.lastAt = Date.now();
      if (!state.lastBadge || PROBE_OWNED_KINDS[state.lastBadge.kind]) {
        setBadge(probe.ok ? "model-bridge" : "bridge-down", probe.detail, "probe");
      }
    });
  }

  function defaultBadge() {
    var kind = configKind();
    if (kind === "off") return { kind: "offline", detail: "" };
    if (kind === "direct") return { kind: "idle", detail: "" };
    if (probe.ok === true) return { kind: "model-bridge", detail: "" };
    if (probe.ok === false) return { kind: "bridge-down", detail: probe.detail };
    return { kind: "bridge-probing", detail: "" };
  }

  /** AiPanel.refreshStatus() —— 桥检测/设置变更后刷新徽章并按需探测桥。 */
  AiPanel.refreshStatus = function () {
    var kind = configKind();
    if (probe.configKind !== kind) {
      // 配置形态变化后，旧的探测与请求结论不再可信，全部重置。
      probe.configKind = kind;
      probe.lastAt = 0;
      probe.ok = null;
      probe.detail = "";
      state.lastBadge = null;
    }
    if (!state.lastBadge) {
      var d = defaultBadge();
      setBadge(d.kind, d.detail, "probe");
    } else {
      renderBadge();
    }
    maybeProbeBridge();
  };

  /** AiPanel.statusText() -> string|null（设置面板状态行复用徽章文案） */
  AiPanel.statusText = function () {
    if (!els.badge) return null;
    var text = badgeShortText();
    var b = state.lastBadge;
    if (b && b.detail) text += "（" + b.detail + "）";
    return text;
  };

  /** AiPanel.mode() -> Promise<"model"|"fallback"|"mixed"> */
  AiPanel.mode = function () {
    return Promise.resolve(state.lastMode || (g.FigAI && g.FigAI.enabled() ? "model" : "fallback"));
  };

  // ------------------------------------------------------------------
  // pending ops rendering
  // ------------------------------------------------------------------
  function describeOp(op, doc) {
    try {
      if (g.FigOps && typeof g.FigOps.describe === "function") {
        var s = g.FigOps.describe(op, doc);
        if (s) return s;
      }
    } catch (e) { /* fallthrough to raw text */ }
    return op && op.op ? "(" + op.op + ")" : "(未知操作)";
  }

  function captureDocumentVersion(doc) {
    var history = Array.isArray(doc.history) ? doc.history : [];
    var stamp = history.map(function (r) {
      return [r && r.rev, r && r.kind, r && r.base_rev,
        r && r.revert_to, r && r.doc_sha256];
    });
    var contentHash = null;
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].doc_sha256) {
        contentHash = String(history[i].doc_sha256);
        break;
      }
    }
    return {
      doc: doc,
      docId: String(doc.id || ""),
      contentHash: contentHash,
      historyStamp: JSON.stringify(stamp),
      epoch: state.documentEpoch
    };
  }

  function documentVersionIsCurrent(version) {
    if (!version || !g.App || !g.App.doc) return false;
    var current = captureDocumentVersion(g.App.doc);
    return version.doc === g.App.doc && version.docId === current.docId &&
      version.epoch === state.documentEpoch && version.contentHash === current.contentHash &&
      version.historyStamp === current.historyStamp;
  }

  function renderPending() {
    if (!els.pendingBox || !els.pendingList) return;
    var hasPending = !!(state.pendingOps && state.pendingOps.length);
    var stale = hasPending && (state.pendingStale || !documentVersionIsCurrent(state.pendingVersion));
    els.pendingModeEl.style.display = hasPending ? "" : "none";
    els.pendingModeEl.textContent = hasPending ? "AI 模式：" +
      modeFractionText(state.pendingSegments, state.pendingMode) : "";
    els.pendingExpEl.style.display = hasPending ? "" : "none";
    els.pendingExpEl.textContent = hasPending
      ? (stale ? "【预览已过期】文档在生成后发生变化，已禁止应用；请放弃并重新生成。\n" : "") +
        (state.pendingExplanation || "")
      : "";
    if (els.pendingSegmentsEl) {
      els.pendingSegmentsEl.style.display = hasPending && state.pendingSegments.length > 1 ? "block" : "none";
      els.pendingSegmentsEl.textContent = state.pendingSegments.map(function (seg) {
        return "第 " + seg.groupIndex + "/" + seg.groupTotal + " 组：" +
          (seg.mode === "model" ? "模型" : "离线规则") +
          (seg.error ? "；错误：" + seg.error : "");
      }).join("\n");
    }
    els.emptyHint.style.display = hasPending ? "none" : "";
    els.pendingList.textContent = "";
    if (hasPending) {
      var doc = state.pendingVersion ? state.pendingVersion.doc : g.App.doc;
      state.pendingOps.forEach(function (op, i) {
        els.pendingList.appendChild(h("li", { style: "margin:2px 0;" }, [
          h("span", { style: "color:#555;", text: (i + 1) + ". [" + (op && op.op ? op.op : "?") + "] " }),
          h("span", { text: describeOp(op, doc) })
        ]));
      });
    }
    els.pendingBtnRow.style.display = hasPending ? "" : "none";
    if (els.applyBtn) {
      els.applyBtn.disabled = !hasPending || stale || !!state.applying;
      els.applyBtn.title = stale ? "文档已变化，请放弃旧预览并重新生成" :
        (state.applying ? "另一项 AI 操作正在写入" : "将预览操作写入当前文档");
    }
    if (els.discardBtn) els.discardBtn.disabled = !hasPending || !!state.applying;
  }

  function clearPending() {
    state.pendingOps = null;
    state.pendingExplanation = "";
    state.pendingInstruction = "";
    state.pendingVersion = null;
    state.pendingStale = false;
    state.pendingMode = null;
    state.pendingSegments = [];
    renderPending();
  }

  // ------------------------------------------------------------------
  // review items rendering
  // ------------------------------------------------------------------
  var SEV_STYLE = {
    high:   "display:inline-block;padding:0 6px;border-radius:4px;background:#fde8e8;color:#b91c1c;font-size:11px;font-weight:bold;",
    medium: "display:inline-block;padding:0 6px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:bold;",
    low:    "display:inline-block;padding:0 6px;border-radius:4px;background:#e5e7eb;color:#4b5563;font-size:11px;font-weight:bold;"
  };
  var SEV_LABEL = { high: "高", medium: "中", low: "低" };

  function reviewIsStale() {
    return !!state.reviewStale || !documentVersionIsCurrent(state.reviewVersion);
  }

  function beginApply(work) {
    if (state.applying) return state.applying;
    var run = Promise.resolve().then(work);
    var tracked = run.finally(function () {
      if (state.applying === tracked) state.applying = null;
      setActionsBusy(state.busy);
      setProgressBusy("");
      renderPending();
      renderReview();
    });
    state.applying = tracked;
    setActionsBusy(true);
    renderPending();
    renderReview();
    return tracked;
  }

  function renderReview() {
    if (!els.reviewList) return;
    els.reviewList.textContent = "";
    if (!state.reviewItems.length) {
      els.reviewList.appendChild(h("div", { style: "color:#888;font-size:12px;", text: "暂无审阅意见。" }));
      return;
    }
    var stale = reviewIsStale();
    if (stale) {
      els.reviewList.appendChild(h("div", {
        "data-review-stale": "true",
        style: "color:#b91c1c;margin:4px 0;white-space:pre-wrap;",
        text: "【审阅结果已过期】文档在审阅生成后发生变化，已禁止应用；请重新审阅。"
      }));
    }
    state.reviewItems.forEach(function (item, idx) {
      if (!item) return;
      var sev = SEV_LABEL[item.severity] ? item.severity : "low";
      var row = h("div", { style: "border:1px solid #ddd;border-radius:6px;padding:6px 8px;margin:6px 0;" }, [
        h("div", {}, [
          h("span", { style: SEV_STYLE[sev], text: SEV_LABEL[sev] }),
          h("span", { style: "color:#555;margin-left:6px;font-size:11px;",
            text: "目标：" + (item.target != null ? String(item.target) : "—") })
        ]),
        h("div", { style: "margin:3px 0;", text: item.issue || "" }),
        item.suggestion ? h("div", { style: "color:#374151;font-size:12px;", text: "建议：" + item.suggestion }) : null,
        h("div", { style: "margin-top:5px;" }, [
          item.op && item.op.op ? h("button", {
            text: "应用", style: "margin-right:6px;padding:2px 10px;cursor:pointer;",
            disabled: !!state.applying || stale,
            "data-review-action": "apply", "data-review-index": idx,
            onClick: function () { return applyReviewItem(item); }
          }) : null,
          h("button", {
            text: "忽略", style: "padding:2px 10px;cursor:pointer;",
            disabled: !!state.applying,
            onClick: function () { ignoreReviewItem(item); }
          })
        ])
      ]);
      els.reviewList.appendChild(row);
    });
  }

  function applyReviewItem(item) {
    if (state.applying) return state.applying;
    if (!item || state.reviewItems.indexOf(item) < 0 || !item.op || !item.op.op) {
      return Promise.resolve({ doc: g.App && g.App.doc, applied: 0 });
    }
    requireApp();
    if (reviewIsStale()) {
      state.reviewStale = true;
      renderReview();
      var staleError = new Error("审阅结果已过期：文档在审阅生成后发生变化，未写入任何操作。请重新审阅");
      setProgressPhase("apply_error", staleError.message);
      toast(staleError.message, { type: "error" });
      return Promise.reject(staleError);
    }
    return beginApply(function () {
      setProgressBusy("正在写入审阅修复（App.commit）");
      setProgressPhase("applying", "正在应用该审阅意见的操作");
      return doCommit([item.op], {
        label: "AI 审阅：" + String(item.issue || "").slice(0, 40),
        source: "ai"
      }).then(function (r) {
        if (r && r.applied > 0) {
          var currentIndex = state.reviewItems.indexOf(item);
          if (currentIndex >= 0) state.reviewItems.splice(currentIndex, 1);
          setProgressPhase(state.reviewItems.length ? "review_wait" : "applied_done",
            state.reviewItems.length
              ? "该条已写入；文档已变化，剩余旧审阅意见已过期禁用，请重新审阅"
              : "审阅修复已写入文档");
          toast("已应用该审阅意见", { type: "success" });
        } else {
          setProgressPhase("apply_error", "该审阅意见的操作未能应用（目标可能已不存在）");
          toast("该审阅意见的操作未能应用（目标可能已不存在）", { type: "error" });
        }
        renderReview();
        return r;
      }).catch(function (err) {
        setProgressPhase("apply_error", err && err.message ? err.message : String(err));
        toast("应用失败：" + (err && err.message ? err.message : err), { type: "error" });
        throw err;
      });
    });
  }

  function ignoreReviewItem(item) {
    if (state.applying) return;
    var idx = state.reviewItems.indexOf(item);
    if (idx < 0) return;
    state.reviewItems.splice(idx, 1);
    renderReview();
    if (!state.reviewItems.length &&
        !(state.pendingOps && state.pendingOps.length)) {
      clearProgress();
    }
  }

  // ------------------------------------------------------------------
  // anchor references（选框/选区建锚点后自动注入 [n] 引用）
  // 输入框里的人读标记是 [1][2]（也兼容 @1 / @<anchorid>）。ask 时把编号按
  // 映射改写为原生 "@<anchorid>"，并把引用了不同编号的子句拆分成多次请求，
  // 使每个编号的操作精确路由到对应锚点；模型与离线 fallback 都按 anchors
  // 清单解析 "@<锚点id>"，数字标记只是人读形式，路由绝不靠模型猜。
  // 编号映射来自本次引用记录与 doc.anchors 中现有的数字标签。
  // ------------------------------------------------------------------

  var MARKER_SRC = "(?:\\[\\s*[^\\[\\]\\n]{1,24}\\s*\\]|@\\s*\\d{1,4}(?![0-9A-Za-z_.:-])|@anchor-[A-Za-z0-9_-]+)";
  // 引用记号：[编号或标签] / @n / 原生 @anchor-id / 裸数字。裸数字前后不能是
  // id 字符（避免命中 8pt、1.5、t12），后面不能是顿号逗号等列举标点（避免把
  // 步骤编号“1、”当成锚点引用）。
  var REF_RE = new RegExp(
    "@(anchor-[A-Za-z0-9_-]+)|\\[\\s*([^\\[\\]\\n]{1,24}?)\\s*\\]|@\\s*(\\d{1,4})(?![0-9A-Za-z_.:-])|" +
    "(^|[^0-9A-Za-z_.:-])(\\d{1,4})(?=$|[^0-9A-Za-z_.:-])(?![、，。；;])", "g");
  function bareNumberIsValue(text, index, digits) {
    var source = String(text);
    var after = source.slice(index + String(digits).length);
    if (/^\s*(?:pt|mm|cm|px|dpi|%|％|°)(?![A-Za-z])/i.test(after) ||
        /^\s*(?:磅|毫米|厘米|像素|度|倍|行高|行距)/i.test(after)) return true;
    var before = source.slice(0, index);
    return /(?:字号|字体大小|行高|行距|间距|宽度|高度|角度|旋转|透明度|缩放|尺寸|半径|粗细|边距|dpi)\s*(?:为|设为|设置为|改为|改成|调成|调整到|设置成|=|:|：)?\s*$/i.test(before);
  }

  // 只匹配首尾成串的引用记号（选框后自动追加的上下文标记）。
  var EDGE_MARKERS_RE = new RegExp(
    "^\\s*" + MARKER_SRC + "(?:[\\s，、,]*" + MARKER_SRC + ")*[\\s，、,]*");

  function refCoordsText(ref) {
    var m = ref && ref.bbox_mm;
    if (!m || typeof m.x !== "number") return "";
    return "(" + m.x + "," + m.y + " · " + m.w + "×" + m.h + " mm)";
  }

  function refToken(id) {
    return "@" + String(id);
  }

  function docAnchorList() {
    try { return (g.App.doc && g.App.doc.anchors) || []; } catch (e) { return []; }
  }

  function docAnchorIds() {
    var ids = {};
    docAnchorList().forEach(function (a) { if (a && a.id) ids[a.id] = true; });
    return ids;
  }

  // 编号/标签 -> 锚点 id。本次引用优先，其次补齐 doc.anchors 现有标签：
  // num 是纯数字标签（“1”“2”，供裸数字与 [1] 记号查表），label 是任意
  // 文本标签（供 [柱状图区] 这类记号查表）。清空引用后直接输入“把1的……”
  // 也能通过 doc.anchors 的数字标签路由到正确锚点。
  function refMap() {
    var map = { num: {}, label: {} };
    var put = function (raw, id) {
      raw = String(raw == null ? "" : raw).trim();
      if (!raw || !id || state.anchorTombstones[String(id)]) return;
      id = String(id);
      var n = parseInt(raw, 10);
      if (isFinite(n) && n > 0 && String(n) === raw) {
        if (!map.num[raw]) map.num[raw] = id;
      } else if (raw.length <= 24 && !map.label[raw]) {
        map.label[raw] = id;
      }
    };
    state.anchorRefs.forEach(function (r) { put(r.label, r.id); });
    docAnchorList().forEach(function (a) { if (a) put(a.label, a.id); });
    return map;
  }

  // 文本里出现的引用 key：数字编号返回 "n:<编号>"，文本标签返回 "L:<标签>"，
  // 原生 @anchor-id 返回 "id:<id>"。
  function refKeys(text, map, opts) {
    var keys = [];
    var push = function (k) { if (k && keys.indexOf(k) < 0) keys.push(k); };
    var allowMarkers = !opts || opts.markers !== false;
    var m;
    var source = String(text);
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(source))) {
      if (m[1]) { // 原生 @anchor-id（已被改写或用户粘贴）
        if (docAnchorIds()[m[1]] && !state.anchorTombstones[m[1]]) push("id:" + m[1]);
      } else if (m[2] != null) { // [编号或标签]
        if (!allowMarkers) continue;
        var inner = m[2].trim();
        if (/^\d{1,4}$/.test(inner)) {
          if (map.num[inner]) push("n:" + inner);
        } else if (map.label[inner]) {
          push("L:" + inner);
        }
      } else if (m[3] != null) { // @n
        if (allowMarkers) {
          var k = String(parseInt(m[3], 10));
          if (map.num[k]) push("n:" + k);
        }
      } else if (m[5] != null) { // 裸数字
        var numberAt = m.index + m[0].length - m[5].length;
        if (bareNumberIsValue(source, numberAt, m[5])) continue;
        var k2 = String(parseInt(m[5], 10));
        if (map.num[k2]) push("n:" + k2);
      }
    }
    return keys;
  }

  // 剥离首尾成串的引用记号（自动追加的上下文），只在剩余文本仍以裸数字
  // 点名了锚点时才采用剥离结果——避免把未点名的编号卷进操作目标。
  function stripEdgeMarkers(text, map) {
    var s = String(text);
    var m = EDGE_MARKERS_RE.exec(s);
    if (!m || !m[0]) return s;
    var rest = s.slice(m[0].length);
    if (!rest.trim()) return s; // 只剩标记：保留原样
    var trailRe = new RegExp("[\\s，、,]*" + MARKER_SRC.slice(0) + "(?:[\\s，、,]*" + MARKER_SRC + ")*\\s*$");
    var t = trailRe.exec(rest);
    var candidate = t && t[0] ? rest.slice(0, rest.length - t[0].length) : rest;
    if (refKeys(candidate, map, { markers: false }).length) return candidate;
    return s;
  }

  // 按编号把指令拆成若干组：出现了新引用编号的子句开启新组，无引用的子句
  // 归入当前组。每组只携带自己点名到的锚点，模型与 fallback 都不会串组。
  function splitByRefs(text, map) {
    var keys = refKeys(text, map);
    if (!keys.length) return [{ text: text, keys: [] }];
    var parts = String(text).split(/([，,；;。\n]+)/);
    var groups = [];
    var curText = "", curKeys = [];
    for (var i = 0; i < parts.length; i += 2) {
      var content = parts[i] || "";
      var delim = parts[i + 1] || "";
      var ks = refKeys(content, map);
      if (ks.length && curText.trim()) {
        groups.push({ text: curText, keys: curKeys });
        curText = "";
        curKeys = [];
      }
      curText += content + delim;
      ks.forEach(function (k) { if (curKeys.indexOf(k) < 0) curKeys.push(k); });
    }
    if (curText.trim()) groups.push({ text: curText, keys: curKeys });
    return groups.length ? groups : [{ text: text, keys: keys }];
  }

  // 编号/标签记号 -> 原生 "@<anchorid>"；key 为 "id:" 前缀的已是原生 id，原样保留。
  function rewriteGroup(text, keys, map) {
    var ids = {};
    keys.forEach(function (k) {
      if (k.indexOf("id:") === 0) ids[k.slice(3)] = k.slice(3);
      else if (k.indexOf("n:") === 0) { var a = map.num[k.slice(2)]; if (a) ids[a] = a; }
      else if (k.indexOf("L:") === 0) { var b = map.label[k.slice(2)]; if (b) ids[b] = b; }
    });
    if (!Object.keys(ids).length) return text;
    return String(text).replace(REF_RE, function (all, native, inner, atN, pre, bare, offset, whole) {
      if (native) return all; // 已是原生 id，原样保留
      var id = null;
      if (inner != null) {
        var t = inner.trim();
        id = /^\d{1,4}$/.test(t) ? map.num[t] : map.label[t];
      } else if (atN != null) {
        id = map.num[String(parseInt(atN, 10))];
      } else if (bare != null) {
        var numberAt = offset + all.length - bare.length;
        if (bareNumberIsValue(whole, numberAt, bare)) return all;
        id = map.num[String(parseInt(bare, 10))];
      }
      if (!id || !ids[id]) return all;
      if (bare != null) return (pre || "") + "@" + id;
      return "@" + id;
    });
  }

  function renderAnchorRefs() {
    if (!els.refChips) return;
    els.refChips.textContent = "";
    els.refChips.style.display = state.anchorRefs.length ? "flex" : "none";
    state.anchorRefs.forEach(function (ref) {
      var chip = h("span", {
        className: "ai-anchor-chip",
        "data-anchor-id": ref.id,
        title: "锚点 " + ref.label + "（id " + ref.id + "）" +
          ((ref.element_names || []).length ? "；元素 " + ref.element_names.join("、") : "") +
          (refCoordsText(ref) ? " " + refCoordsText(ref) : ""),
        style: "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;" +
          "border:1px solid #b7d3f2;border-radius:10px;background:#e8f1fb;font-size:11px;"
      }, [
        h("span", { text: "[" + ref.label + "]", style: "font-weight:bold;color:#1c4d8f;" }),
        h("span", { text: refToken(ref.id), style: "color:#2f6fbf;font-size:10px;" }),
        (ref.element_names || []).length ? h("span", {
          text: ref.element_names.join("、"), style: "color:#26374a;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        }) : null,
        refCoordsText(ref) ? h("span", { text: refCoordsText(ref), style: "color:#5a6b7f;" }) : null,
        h("button", {
          type: "button", text: "×",
          title: "清除本次引用 " + "[" + ref.label + "]",
          style: "border:none;background:transparent;cursor:pointer;font-size:12px;" +
            "color:#5a6b7f;padding:0 2px;line-height:1;",
          onClick: function () { removeAnchorRef(ref.id); }
        })
      ]);
      els.refChips.appendChild(chip);
    });
    if (state.anchorRefs.length) {
      els.refChips.appendChild(h("button", {
        type: "button", text: "清除引用",
        title: "移除全部锚点引用标记（不影响已创建的锚点）",
        style: "border:none;background:transparent;cursor:pointer;font-size:11px;" +
          "color:#5a6b7f;text-decoration:underline;padding:0 2px;",
        onClick: function () { clearAnchorRefs(); }
      }));
    }
  }

  function removeMarkerFromInput(ref) {
    if (!els.input || !ref || !ref.autoMarker) return;
    var v = String(els.input.value || "");
    var marker = "[" + ref.label + "]";
    var at = v.indexOf(marker);
    if (at < 0) return;
    var from = at > 0 && v.charAt(at - 1) === " " ? at - 1 : at;
    els.input.value = v.slice(0, from) + v.slice(at + marker.length);
  }

  function renameMarkerInInput(ref, nextLabel) {
    if (!els.input || !ref || !ref.autoMarker) return true;
    var v = String(els.input.value || "");
    var oldMarker = "[" + ref.label + "]";
    var at = v.indexOf(oldMarker);
    if (at < 0) return false;
    els.input.value = v.slice(0, at) + "[" + nextLabel + "]" + v.slice(at + oldMarker.length);
    return true;
  }

  function removeAnchorRef(id) {
    var gone = null;
    state.anchorRefs = state.anchorRefs.filter(function (r) {
      if (r.id === id) { gone = r; return false; }
      return true;
    });
    if (gone) removeMarkerFromInput(gone);
    renderAnchorRefs();
  }

  function clearAnchorRefs() {
    if (!state.anchorRefs.length) return;
    state.anchorRefs.slice().forEach(removeMarkerFromInput);
    state.anchorRefs = [];
    renderAnchorRefs();
  }

  // 固定下栏不切换上半栏的工具 tab，也不抢输入焦点。
  function revealAiTab() {
    try {
      var panel = document.getElementById("panel-ai") ||
        document.getElementById("panel-assistant-ai");
      if (!panel) return;
      panel.classList.remove("hidden");
      panel.dispatchEvent(new CustomEvent("ai:reveal", { bubbles: true }));
    } catch (e) { /* ignore */ }
  }

  // 即使没有输入正文，也追加新的引用；只补入尚不存在的标记，保留用户原文和光标。
  function appendMarkerToInput(label) {
    if (!els.input) return false;
    var v = String(els.input.value || "");
    var marker = "[" + label + "]";
    if (v.indexOf(marker) >= 0) return false;
    els.input.value = (v ? v.replace(/\s+$/, "") + " " : "") + marker;
    return true;
  }

  function elementNames(ids) {
    var names = [];
    (ids || []).forEach(function (id) {
      var el = null;
      try { el = g.FigDoc && typeof g.FigDoc.get === "function" ? g.FigDoc.get(g.App.doc, id) : null; }
      catch (e) { el = null; }
      names.push(el && el.name ? String(el.name) : String(id));
    });
    return names;
  }

  /**
   * AiPanel.appendAnchorRef(anchor) — 新建锚点后由 Editor/Anchors 调用。
   * 在输入框追加 "[n]" 引用标记（幂等，不重复追加），并在输入框上方展示
   * [n] @id、元素名称与坐标 chip；不抢占输入焦点，不修改文档。
   */
  AiPanel.appendAnchorRef = function (anchor) {
    if (!anchor || !anchor.id) return false;
    var id = String(anchor.id);
    if (state.anchorTombstones[id]) {
      toast("锚点引用已失效（" + id + "）；请从当前文档重新明确选择锚点", { type: "error" });
      return false;
    }
    for (var i = 0; i < state.anchorRefs.length; i++) {
      if (state.anchorRefs[i].id === id) return true;
    }
    var ids = Array.isArray(anchor.element_ids) ? anchor.element_ids.slice() : [];
    var label = String(anchor.label != null ? anchor.label : id);
    state.anchorRefs.push({
      id: id,
      label: label,
      bbox_mm: anchor.bbox_mm || null,
      element_ids: ids,
      element_names: elementNames(ids),
      autoMarker: appendMarkerToInput(label)
    });
    renderAnchorRefs();
    revealAiTab();
    return true;
  };

  function findElement(id) {
    requireApp();
    var el = g.FigDoc && typeof g.FigDoc.get === "function"
      ? g.FigDoc.get(g.App.doc, String(id)) : null;
    if (!el) throw new Error("找不到要发送给 AI 的元素：" + id);
    return el;
  }

  function elementBbox(id) {
    try {
      return g.FigDoc && typeof g.FigDoc.bbox === "function"
        ? g.FigDoc.bbox(g.App.doc, id, { recursive: true }) : null;
    } catch (e) { return null; }
  }

  function sameIdSet(a, b) {
    return Array.isArray(a) && a.length === b.length &&
      b.every(function (id) { return a.indexOf(id) >= 0; });
  }

  function editorSelectionBbox(ids) {
    var union = null;
    for (var i = 0; i < ids.length; i++) {
      var b = elementBbox(ids[i]);
      if (!b) return null;
      if (!union) union = { x: b.x, y: b.y, w: b.w, h: b.h };
      else {
        var x2 = Math.max(union.x + union.w, b.x + b.w);
        var y2 = Math.max(union.y + union.h, b.y + b.h);
        union.x = Math.min(union.x, b.x);
        union.y = Math.min(union.y, b.y);
        union.w = x2 - union.x;
        union.h = y2 - union.y;
      }
    }
    if (!union) return null;
    ["x", "y", "w", "h"].forEach(function (k) {
      union[k] = Math.round(union[k] * 1000) / 1000;
    });
    return union;
  }

  function sameEditorBbox(a, b) {
    return !!(a && b) && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 &&
      Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
  }

  function anchorForSelection(ids) {
    var list = docAnchorList();
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a && a.id && !state.anchorTombstones[a.id] && sameIdSet(a.element_ids, ids)) return a;
    }
    var exact = editorSelectionBbox(ids);
    for (var j = 0; j < list.length; j++) {
      var b = list[j];
      if (b && b.id && !state.anchorTombstones[b.id] && sameEditorBbox(b.bbox_mm, exact)) return b;
    }
    return null;
  }

  function referenceError(err) {
    var text = err && err.message ? err.message : String(err);
    setProgressBusy("");
    setProgressPhase("model_error", text);
    toast(text, { type: "error" });
    return null;
  }

  /** 右键发送：定位选区，复用匹配锚点；没有时才经 Anchors 真实提交一次。 */
  AiPanel.referenceElement = function (elementId) {
    return Promise.resolve().then(function () {
      requireApp();
      var id = String(elementId || "");
      findElement(id);
      var current = typeof g.App.selection === "function" ? g.App.selection() : [];
      var ids = current.length > 1 && current.indexOf(id) >= 0 ? current.slice() : [id];
      ids.forEach(findElement);
      g.App.select(ids);
      var existing = anchorForSelection(ids);
      if (existing) {
        AiPanel.appendAnchorRef(existing);
        return existing;
      }
      if (!g.Anchors || typeof g.Anchors.addFromSelection !== "function") {
        throw new Error("锚点模块 Anchors 未加载，无法从选区创建引用");
      }
      return Promise.resolve(g.Anchors.addFromSelection()).then(function (created) {
        if (!created) throw new Error("未能创建锚点，请检查选区是否具有有效包围盒");
        // addFromSelection 已回调 appendAnchorRef；仅在旧宿主未回调时补一次。
        if (!state.anchorRefs.some(function (r) { return r.id === created.id; })) {
          AiPanel.appendAnchorRef(created);
        }
        return created;
      });
    }).catch(referenceError);
  };

  /** 已存在锚点直接引用：不再创建锚点，也不重复提交。 */
  AiPanel.referenceAnchor = function (anchorId) {
    return Promise.resolve().then(function () {
      requireApp();
      var id = String(anchorId || "");
      var anchor = docAnchorList().filter(function (a) { return a && a.id === id; })[0];
      if (!anchor) throw new Error("找不到要发送给 AI 的锚点：" + id);
      // 当前文档中的一次明确点击可以再次引用撤销后恢复的原 id；旧自动引用不会因此复活。
      delete state.anchorTombstones[id];
      if (!AiPanel.appendAnchorRef(anchor)) throw new Error("该锚点引用已失效，请重新选择");
      return anchor;
    }).catch(referenceError);
  };

  /** AiPanel.clearAnchorRefs() — 清除本次 [n] 引用（不动已创建的锚点） */
  AiPanel.clearAnchorRefs = clearAnchorRefs;

  /** doc:changed 后登记 id tombstone、同步引用，并只移除失效的自动标记。 */
  function syncAnchorRefsWithDoc() {
    var docId = String(g.App && g.App.doc && g.App.doc.id || "");
    if (state.anchorLedgerDocId !== docId) {
      clearAnchorRefs();
      state.anchorLedgerDocId = docId;
      state.knownAnchorIds = {};
      state.anchorTombstones = {};
    }
    var byId = {};
    var currentIds = {};
    docAnchorList().forEach(function (a) {
      if (!a || !a.id) return;
      byId[a.id] = a;
      currentIds[a.id] = String(a.label != null ? a.label : a.id);
    });
    Object.keys(state.knownAnchorIds).forEach(function (id) {
      if (!currentIds[id]) state.anchorTombstones[id] = true;
    });
    state.knownAnchorIds = currentIds;

    var next = [];
    var changed = false;
    var removed = [];
    var renameFailures = [];
    state.anchorRefs.forEach(function (r) {
      var a = byId[r.id];
      if (!a || state.anchorTombstones[r.id]) {
        changed = true;
        removed.push(r);
        removeMarkerFromInput(r);
        return;
      }
      var label = String(a.label != null ? a.label : r.id);
      if (label !== r.label && !renameMarkerInInput(r, label)) {
        changed = true;
        removed.push(r);
        renameFailures.push("[" + r.label + "] → [" + label + "]");
        return;
      }
      var bbox = a.bbox_mm || null;
      if (label !== r.label || bbox !== r.bbox_mm) changed = true;
      var ids = Array.isArray(a.element_ids) ? a.element_ids.slice() : [];
      next.push({ id: r.id, label: label, bbox_mm: bbox,
        element_ids: ids, element_names: elementNames(ids), autoMarker: r.autoMarker });
    });
    if (changed || next.length !== state.anchorRefs.length) {
      state.anchorRefs = next;
      renderAnchorRefs();
    }
    if (removed.length) {
      toast("已移除 " + removed.length + " 个失效锚点引用；剩余有效编号保持不变", { type: "info" });
    }
    if (renameFailures.length) {
      toast("以下锚点自动标记已失效并移出引用，请重新明确选择：" + renameFailures.join("、"), { type: "error" });
    }
  }

  /** AiPanel.anchorRefs() -> 当前引用的浅拷贝（供测试/其他模块读取） */
  AiPanel.anchorRefs = function () {
    return state.anchorRefs.slice();
  };

  /**
   * AiPanel.hasPendingWork() -> bool —— 供文档同步与版本冲突保护判断：
   * 请求进行中、有待应用 AI 操作预览或待处理审阅意见时，都不能静默刷新文档。
   */
  AiPanel.hasPendingWork = function () {
    return !!state.busy || !!state.applying ||
      !!(state.pendingOps && state.pendingOps.length) ||
      !!(state.reviewItems && state.reviewItems.length);
  };

  // ------------------------------------------------------------------
  // conversation（自然语言问答与编辑预览共用记录，但请求路径严格分开）
  // ------------------------------------------------------------------
  var CHAT_HISTORY_MESSAGES = 10;
  var MAX_MESSAGES = 60;

  function appendMessage(message) {
    state.messages.push(message);
    if (state.messages.length > MAX_MESSAGES) {
      state.messages = state.messages.slice(state.messages.length - MAX_MESSAGES);
    }
    renderConversation();
    return message;
  }

  function renderConversation() {
    if (!els.chatLog) return;
    els.chatLog.textContent = "";
    if (!state.messages.length) {
      els.chatLog.appendChild(h("div", {
        className: "ai-chat-hint",
        style: "color:#6b7280;font-size:12px;line-height:1.55;padding:8px;",
        text: "可以直接讨论这张图的布局、字号、配色和图表表达。回答依据结构化文档与可计算检查，不等同于看像素、数据验证或论文审美验收。"
      }));
      return;
    }
    state.messages.forEach(function (m) {
      var isUser = m.role === "user";
      var isError = m.role === "error";
      var label = isUser ? "你" : (m.role === "assistant" ? "AI 模型" : "操作状态");
      if (isError) label = "未能获得模型回复";
      var row = h("div", {
        className: "ai-message ai-message-" + m.role,
        "data-message-role": m.role,
        "data-message-kind": m.kind || "local",
        "data-message-status": m.status || "done",
        style: "margin:6px 0;display:flex;justify-content:" + (isUser ? "flex-end" : "flex-start") + ";"
      });
      var children = [
        h("div", { style: "font-size:10px;color:#64748b;margin-bottom:3px;", text: label +
          (m.kind === "edit" ? " · 编辑预览" : "") }),
        h("div", { style: "white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55;",
          text: m.text || "" })
      ];
      if (isError && m.kind === "chat" && state.lastChatError === m && !state.busy) {
        children.push(h("button", {
          type: "button", text: "重试这次问答", "data-action": "retry-chat",
          style: "margin-top:6px;padding:2px 10px;cursor:pointer;font-size:11px;",
          onClick: function () { AiPanel.retryChat().catch(function () {}); }
        }));
      }
      row.appendChild(h("div", {
        style: "max-width:94%;box-sizing:border-box;padding:7px 9px;border-radius:8px;" +
          (isUser ? "background:#dcecff;color:#172b4d;" :
            (isError ? "background:#fff1f0;color:#a51d1d;border:1px solid #ffd0cc;" :
              "background:#f3f4f6;color:#1f2937;border:1px solid #e5e7eb;"))
      }, children));
      els.chatLog.appendChild(row);
    });
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function setActionsBusy(busy) {
    [els.chatBtn, els.askBtn, els.reviewBtn].forEach(function (btn) {
      if (btn) btn.disabled = !!busy;
    });
  }

  function boundedValue(value, depth) {
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return value.length > 500 ? value.slice(0, 499) + "…" : value;
    if (depth <= 0) return "[省略]";
    if (Array.isArray(value)) return value.slice(0, 20).map(function (v) { return boundedValue(v, depth - 1); });
    if (typeof value !== "object") return String(value);
    var out = {};
    Object.keys(value).slice(0, 40).forEach(function (k) {
      if (k === "apiKey" || k === "authorization") return;
      out[k] = boundedValue(value[k], depth - 1);
    });
    return out;
  }

  function chartSummary(chart) {
    if (!chart || typeof chart !== "object") return null;
    var out = {};
    Object.keys(chart).forEach(function (k) {
      if (k !== "data") out[k] = boundedValue(chart[k], 4);
    });
    var data = chart.data || {};
    var inline = data.inline;
    var rows = Array.isArray(inline) ? inline
      : (inline && Array.isArray(inline.rows) ? inline.rows : []);
    var columns = inline && !Array.isArray(inline) && Array.isArray(inline.columns)
      ? inline.columns.slice(0, 40)
      : (rows.length && rows[0] && typeof rows[0] === "object" && !Array.isArray(rows[0])
        ? Object.keys(rows[0]).slice(0, 40) : []);
    out.data_summary = {
      row_count: rows.length,
      columns: columns,
      has_external_data: !!data.ref
    };
    return out;
  }

  function elementSummary(el) {
    var out = {
      id: el.id, type: el.type, name: el.name || "",
      transform: boundedValue(el.transform || null, 2),
      style: boundedValue(el.style || null, 3),
      parent_id: el.parent_id || null,
      children: Array.isArray(el.children) ? el.children.slice(0, 40) : []
    };
    if (el.type === "text") out.text = String(el.text || "").slice(0, 500);
    if (el.type === "chart") out.chart = chartSummary(el.chart);
    if (el.statistics) out.declared_statistics = boundedValue(el.statistics, 4);
    return out;
  }

  function buildChatContext() {
    var doc = g.App.doc;
    var selection = typeof g.App.selection === "function" ? g.App.selection() : [];
    var refs = state.anchorRefs.map(function (r) {
      var current = docAnchorList().filter(function (a) { return a && a.id === r.id; })[0] || r;
      var ids = Array.isArray(current.element_ids) ? current.element_ids : (r.element_ids || []);
      return {
        role: "用户通过右键/选框指定的原生文档区域",
        id: current.id, label: current.label,
        bbox_mm: current.bbox_mm || null,
        bbox_norm: current.bbox_norm || null,
        element_ids: ids,
        element_names: elementNames(ids),
        note: current.note || ""
      };
    });
    var checks = [];
    if (g.FigPresets && typeof g.FigPresets.check === "function") {
      try {
        var result = g.FigPresets.check(doc);
        checks = ((result && result.warnings) || []).slice(0, 24).map(function (w) {
          return { code: w.code || "", severity: w.severity || "",
            element_id: w.element_id || null, message: w.message || "" };
        });
      } catch (e) { checks = []; }
    }
    var profile = null;
    if (typeof g.App.currentJournal === "function") {
      var p = g.App.currentJournal();
      if (p) profile = { id: p.id || null, name: p.name || "", width_mm: p.width_mm,
        height_mm: p.height_mm, base_font_pt: p.base_font_pt,
        min_font_pt: p.min_font_pt, dpi_min: p.dpi_min };
    }
    return {
      scope: "figure_conversation_not_edit_not_science_argument_audit",
      evidence_limits: "依据结构化 FigureDocument 和可计算检查；未直接观察渲染像素，未证明原始数据完整性或统计正确性。",
      document: {
        id: doc.id, title: doc.title || "", canvas: doc.canvas || {},
        journal_profile: profile,
        panels: boundedValue(doc.panels || [], 3),
        anchors: boundedValue(doc.anchors || [], 3),
        elements: (doc.elements || []).slice(0, 80).map(elementSummary)
      },
      selected_element_ids: selection,
      referenced_anchors: refs,
      computable_layout_checks: checks
    };
  }

  function chatHistory() {
    return state.messages.filter(function (m) {
      return m.kind === "chat" && m.status === "done" &&
        ((m.role === "user" && m.text.trim()) || (m.role === "assistant" && m.text.trim()));
    }).slice(-CHAT_HISTORY_MESSAGES).map(function (m) {
      return { role: m.role, content: m.modelContent || m.text };
    });
  }

  function routedChatText(text) {
    var map = refMap();
    var keys = refKeys(text, map);
    return keys.length ? rewriteGroup(text, keys, map) : text;
  }

  function runChat(text, isRetry) {
    requireApp();
    if (state.busy) return Promise.reject(new Error("正在处理上一条请求，请稍候"));
    state.busy = true;
    setActionsBusy(true);
    state.lastChatText = text;
    state.lastChatError = null;
    var routed = routedChatText(text);
    if (!isRetry) {
      appendMessage({ role: "user", kind: "chat", status: "done",
        text: text, modelContent: routed });
      if (els.input) els.input.value = "";
    }
    var history = chatHistory();
    var active = {
      role: "assistant", kind: "chat", status: "waiting",
      text: "正在等待模型回复…（尚未生成评价，也未修改文档）"
    };
    state.activeChatMessage = active;
    appendMessage(active);
    setProgressBusy("正在整理图中文档与最近对话");
    setProgressPhase("local_answer", "准备自然语言请求，不生成编辑操作");

    var rid = null;
    return Promise.resolve().then(function () {
      if (configKind() === "bridge" && g.Settings && typeof g.Settings.reserveRequestId === "function") {
        rid = g.Settings.reserveRequestId("chat");
      }
      var system = [
        "你是科研绘图编辑器里的对话助手。用户在讨论当前这张图，不是在要求你输出 EditOp，也不是在要求自动改图。",
        "请用自然、具体、克制的中文先回答问题，再据需要给少量布局/可读性建议；不要输出 JSON 或代码块。",
        "你可以讨论整体排版是否协调、图表面板、字号、颜色、布局与已声明的统计呈现；机制图只讨论视觉流程是否清楚，不认定机制或实验结论正确。",
        "回答只能依据所给结构化 FigureDocument、引用的原生元素/锚点 bbox/style/chart/statistics、期刊 profile 和可计算告警。",
        "你没有直接看到渲染像素，也不能证明原始数据完整、单位可比、统计方法适当或结论成立；涉及时必须明确这些边界。",
        "统计字段是作者已声明的信息，不是重新计算或独立核验的事实。不要编造未记录的数据、显著性、样本量或来源。",
        "此问答与整图科学问题/多面板证据作用的论证工作不同，也不是逐条修复的 AI 审阅；不要宣称通过论文审美、投稿或科学正确性验收。",
        "当前结构化上下文：" + JSON.stringify(buildChatContext())
      ].join("\n");
      var messages = [{ role: "system", content: system }].concat(history);
      setProgressPhase(configKind() === "off" ? "offline" : "model_pending",
        configKind() === "off" ? "当前没有可用模型，不能生成 AI 评价" : "等待自然语言回复（json:false）",
        { rid: rid });
      startProgressPolling(rid, 0, 0);
      return g.FigAI.chat(messages, { json: false });
    }).then(function (res) {
      if (!res || typeof res.text !== "string" || !res.text.trim()) {
        throw new Error("模型返回结构异常：自然语言问答要求非空 {text}，未生成评价");
      }
      var answer = { text: res.text.trim() };
      active.role = "assistant";
      active.status = "done";
      active.text = answer.text;
      state.lastMode = "model";
      state.lastChatError = null;
      setBadge("model", "", "chat");
      setProgressPhase("model_complete", "自然语言回复已返回；未生成编辑操作，文档未修改", { rid: rid });
      renderConversation();
      return answer;
    }).catch(function (err) {
      var msg = configKind() === "off"
        ? "当前没有可用模型连接，未生成 AI 评价。请在设置中复用 DSH 桥或填写 API Key。"
        : ((g.FigAI && g.FigAI.explainError) ? g.FigAI.explainError(err)
          : (err && err.message ? err.message : String(err)));
      active.role = "error";
      active.status = "error";
      active.text = msg + "。本次没有获得 AI 回复；可检查连接后重试。";
      state.lastChatError = active;
      setBadge(configKind() === "bridge" ? "bridge-down" : "model-error", msg, "chat");
      setProgressPhase(configKind() === "bridge" ? "bridge_error" : "model_error", msg, { rid: rid });
      renderConversation();
      throw err;
    }).finally(function () {
      stopProgressPolling();
      if (rid && g.Settings && typeof g.Settings.releaseRequestId === "function") {
        g.Settings.releaseRequestId(rid);
      }
      state.busy = false;
      state.activeChatMessage = null;
      setActionsBusy(false);
      setProgressBusy("");
      renderConversation();
    });
  }

  /** AiPanel.chat(instruction) -> Promise<{text}>；绝不回退成虚构的模型评价。 */
  AiPanel.chat = function (instruction) {
    var text = String(instruction == null ? (els.input ? els.input.value : "") : instruction).trim();
    if (!text) return Promise.reject(new Error("请先输入想讨论的问题"));
    if (!g.FigAI || typeof g.FigAI.chat !== "function") {
      var err = new Error("FigAI.chat 未加载，无法请求模型；未生成 AI 评价");
      toast(err.message, { type: "error" });
      return Promise.reject(err);
    }
    return runChat(text, false);
  };

  AiPanel.retryChat = function () {
    if (!state.lastChatText) return Promise.reject(new Error("没有可重试的问答"));
    if (!g.FigAI || typeof g.FigAI.chat !== "function") {
      return Promise.reject(new Error("FigAI.chat 未加载，无法重试"));
    }
    return runChat(state.lastChatText, true);
  };

  AiPanel.chatMessages = function () {
    return state.messages.map(function (m) {
      return { role: m.role, kind: m.kind, status: m.status, text: m.text };
    });
  };

  // ------------------------------------------------------------------
  // core actions
  // ------------------------------------------------------------------

  function modeFractionText(segments, mode) {
    if (!segments || !segments.length) return mode === "model" ? "DeepSeek 模型" : "离线规则";
    var modelCount = segments.filter(function (s) { return s.mode === "model"; }).length;
    var total = segments.length;
    if (modelCount === total) return "DeepSeek 模型（" + total + "/" + total + " 组）";
    if (!modelCount) return "离线规则（0/" + total + " 组模型）";
    return "混合（模型 " + modelCount + "/" + total + " 组，离线规则 " +
      (total - modelCount) + "/" + total + " 组）";
  }

  // 多组请求逐段保留真实来源；只有全模型才是 model，全离线才是 fallback。
  function mergeResults(results, segments) {
    var ops = [];
    var expl = [];
    var modelCount = 0;
    var resultCount = 0;
    results.forEach(function (r) {
      if (!r) return;
      resultCount += 1;
      (Array.isArray(r.ops) ? r.ops : []).forEach(function (op) { if (op) ops.push(op); });
      if (r.explanation) expl.push(r.explanation);
      if (r.mode === "model") modelCount += 1;
    });
    var mode = resultCount && modelCount === resultCount ? "model" :
      (modelCount ? "mixed" : "fallback");
    return { ops: ops, explanation: expl.join("\n"), mode: mode,
      segments: (segments || []).slice() };
  }

  /** AiPanel.ask(instruction) -> Promise<{ops, explanation, mode}> */
  AiPanel.ask = function (instruction) {
    requireApp();
    var text = String(instruction == null ? (els.input ? els.input.value : "") : instruction).trim();
    if (!text) return Promise.reject(new Error("请输入自然语言指令"));
    if (state.busy || state.applying) return Promise.reject(new Error("正在处理上一条请求，请稍候"));
    var generation = ++askSeq;
    state.busy = true;
    setActionsBusy(true);
    appendMessage({ role: "user", kind: "edit", status: "done", text: text });
    if (els.input) els.input.value = "";
    setProgressBusy("AI 编辑请求进行中（阶段实时更新，非百分比）");
    setProgressPhase("local_answer", "构建编辑请求前，先收集选区与结构化文档");

    // [n] 引用路由：编号映射 -> 剥离首尾自动追加的标记 -> 按编号拆分子句 ->
    // 每组把编号改写为原生 "@<锚点id>" 后单独请求。单编号/无编号指令退化为
    // 一次请求，行为与从前一致。
    var map = refMap();
    var workText = text;
    if (Object.keys(map.num).length || Object.keys(map.label).length) {
      var stripped = stripEdgeMarkers(text, map);
      if (stripped !== text) workText = stripped;
    }
    var groups = splitByRefs(workText, map);
    var requestVersion = captureDocumentVersion(g.App.doc);
    var reqs = groups.map(function (gp, gi) {
      return {
        groupIndex: gi + 1,
        groupTotal: groups.length,
        payload: {
          doc: requestVersion.doc,
          instruction: gp.keys.length ? rewriteGroup(gp.text, gp.keys, map) : gp.text,
          anchors: (requestVersion.doc && requestVersion.doc.anchors) || [],
          selection: (typeof g.App.selection === "function") ? g.App.selection() : []
        }
      };
    });

    var t0 = Date.now();
    var results = [];
    var segments = [];
    var chain = Promise.resolve();
    reqs.forEach(function (rq) {
      chain = chain.then(function () {
        if (generation !== askSeq) return;
        // 桥路径下登记本组专属 request_id（进度互不覆盖）；离线/直连不登记。
        var rid = null;
        if (configKind() === "bridge" && g.Settings &&
            typeof g.Settings.reserveRequestId === "function") {
          rid = g.Settings.reserveRequestId("ask");
        }
        setProgressPhase(rid ? "model_pending" : (configKind() === "off" ? "offline" : "model_pending"),
          rid ? "已提交模型请求，等待响应" : (configKind() === "direct" ? "直连模型请求中" : "离线规则生成操作"),
          { gi: rq.groupIndex, gt: rq.groupTotal, rid: rid });
        startProgressPolling(rid, rq.groupIndex, rq.groupTotal);
        var groupT0 = Date.now();
        return g.FigAI.requestOps(rq.payload).then(function (res) {
          if (generation === askSeq) stopProgressPolling();
          if (rid && g.Settings && typeof g.Settings.releaseRequestId === "function") {
            g.Settings.releaseRequestId(rid);
          }
          results.push(res);
          var segment = {
            groupIndex: rq.groupIndex, groupTotal: rq.groupTotal,
            mode: res && res.mode === "model" ? "model" : "fallback", error: "", errorKind: ""
          };
          if (res && res.repaired) {
            res.explanation = (res.explanation || "") + "（模型首次输出未通过 EditOp 校验：" +
              res.first_problem + "；已请模型自我修正一次，修正结果仍需你确认后才会应用）";
          }
          if (segment.mode === "fallback" && res && res.fallback_stage === "validate") {
            segment.error = res.fallback_reason;
            segment.errorKind = "parse-error";
          } else if (segment.mode === "fallback" && res && res.fallback_stage === "request") {
            var failed = lastRecordSince(groupT0);
            segment.error = (failed && failed.message) || res.fallback_reason;
            segment.errorKind = configKind() === "bridge" ? "bridge-down" : "model-error";
          } else if (segment.mode === "fallback") {
            var segmentCause = fallbackCause(groupT0);
            if (segmentCause.kind !== "fallback" && segmentCause.kind !== "offline") {
              segment.error = segmentCause.detail || badgeDef(segmentCause.kind).text;
              segment.errorKind = segmentCause.kind;
            }
          }
          segments.push(segment);
          if (generation === askSeq && rq.groupIndex < rq.groupTotal) {
            setProgressPhase("parse", "本组返回完成，准备下一组请求",
              { gi: rq.groupIndex, gt: rq.groupTotal, rid: rid });
          }
        }, function (err) {
          if (generation === askSeq) stopProgressPolling();
          if (rid && g.Settings && typeof g.Settings.releaseRequestId === "function") {
            g.Settings.releaseRequestId(rid);
          }
          throw err;
        });
      });
    });
    return chain.then(function () {
      var res = mergeResults(results, segments);
      if (generation !== askSeq) return res;
      setProgressBusy("");
      setProgressPhase("parse", "解析模型输出");
      state.lastMode = res.mode;
      var errorCause = null;
      if (res.mode === "model") {
        setBadge("model", "", "ask");
      } else if (res.mode === "mixed") {
        var failedSegment = segments.filter(function (s) { return !!s.error; })[0];
        if (failedSegment) {
          errorCause = { kind: failedSegment.errorKind, detail: failedSegment.error };
          setBadge("mixed", failedSegment.error, "ask");
          toast(failedSegment.error, { type: "error", ms: 8000 });
        } else {
          setBadge("mixed", modeFractionText(segments, "mixed"), "ask");
        }
      } else {
        var cause = segments.length === 1 && segments[0].error
          ? { kind: segments[0].errorKind, detail: segments[0].error } : fallbackCause(t0);
        setBadge(cause.kind, cause.detail, "ask");
        // 内核静默回退不代表没有发生错误：桥/直连失败、响应不可解析都要如实可见。
        if (cause.kind !== "fallback" && cause.kind !== "offline") {
          errorCause = cause;
          toast(cause.detail || badgeShortText(), { type: "error", ms: 8000 });
        }
      }
      state.pendingOps = Array.isArray(res.ops) ? res.ops : [];
      state.pendingExplanation = res.explanation || "";
      state.pendingInstruction = text;
      state.pendingVersion = requestVersion;
      state.pendingStale = !documentVersionIsCurrent(requestVersion);
      state.pendingMode = res.mode;
      state.pendingSegments = segments.slice();
      renderPending();
      if (state.pendingOps.length) {
        // intents 预览：绝不在「应用」前显示已完成/已写入。
        if (state.pendingStale) {
          setProgressPhase("apply_error", "文档在生成期间已变化；旧预览已禁用，请放弃并重新生成");
        } else if (res.mode === "model") {
          setProgressPhase("review_wait", "共 " + state.pendingOps.length +
            " 条操作待确认；点「应用」才会写入文档");
        } else if (res.mode === "mixed") {
          setProgressPhase("review_wait", modeFractionText(segments, "mixed") + "；共 " +
            state.pendingOps.length + " 条操作待确认" +
            (errorCause ? "；离线组错误：" + errorCause.detail : ""));
        } else if (errorCause) {
          setProgressPhase(errorCause.kind === "bridge-down" ? "bridge_error" : "model_error",
            (errorCause.detail || badgeShortText()) +
            "｜已回退离线规则，以下 " + state.pendingOps.length + " 条操作仅为预览");
        } else {
          setProgressPhase("offline", "离线规则生成 " + state.pendingOps.length +
            " 条操作预览；点「应用」才会写入文档");
        }
      } else {
        setProgressPhase(res.mode === "model" ? "model_complete" : "offline",
          res.explanation || (res.mode === "mixed" ? modeFractionText(segments, "mixed") + "；没有生成可应用的操作" : "没有生成可应用的操作"));
      }
      if (!state.pendingOps.length) {
        toast(res.explanation || "没有生成可应用的操作，请补充或澄清指令", { type: "info" });
      }
      var messagePrefix = res.mode === "mixed"
        ? "分组编辑预览：" + modeFractionText(segments, "mixed") + "；共 "
        : (res.mode === "model" ? "模型" : "离线规则") + "生成了 ";
      appendMessage({
        role: res.mode === "model" ? "assistant" : "local", kind: "edit", status: "done",
        text: messagePrefix + state.pendingOps.length +
          " 条编辑操作预览，尚未写入文档。" +
          (segments.filter(function (s) { return !!s.error; }).map(function (s) {
            return "\n第 " + s.groupIndex + "/" + s.groupTotal + " 组离线回退错误：" + s.error;
          }).join("")) +
          (res.explanation ? "\n" + res.explanation : "") +
          "\n请在下方“编辑预览与审阅结果”中确认或放弃。"
      });
      if (els.taskDetails && state.pendingOps.length) els.taskDetails.open = true;
      return res;
    }).catch(function (err) {
      if (generation === askSeq) {
        var msg = (g.FigAI && g.FigAI.explainError) ? g.FigAI.explainError(err)
          : (err && err.message ? err.message : String(err));
        setProgressPhase("model_error", msg);
        appendMessage({ role: "error", kind: "edit", status: "error",
          text: "编辑请求失败：" + msg + "；文档未修改。" });
        toast(msg, { type: "error" });
      }
      throw err;
    }).finally(function () {
      if (generation !== askSeq) return;
      state.busy = false;
      setProgressBusy("");
      stopProgressPolling();
      setActionsBusy(!!state.applying);
    });
  };

  /** AiPanel.applyPending() —— 用户点「应用」才写入文档 */
  AiPanel.applyPending = function () {
    if (state.applying) return state.applying;
    if (!state.pendingOps || !state.pendingOps.length) {
      toast("没有待应用的 AI 操作", { type: "info" });
      return Promise.resolve({ doc: g.App.doc, applied: 0 });
    }
    requireApp();
    if (state.pendingStale || !documentVersionIsCurrent(state.pendingVersion)) {
      state.pendingStale = true;
      renderPending();
      var staleError = new Error("AI 预览已过期：文档在生成后发生变化，未写入任何操作。请放弃并重新生成");
      setProgressBusy("");
      setProgressPhase("apply_error", staleError.message);
      toast(staleError.message, { type: "error" });
      return Promise.reject(staleError);
    }
    var ops = state.pendingOps;
    var label = "AI：" + (state.pendingInstruction || "编辑指令").slice(0, 40);
    return beginApply(function () {
      setProgressBusy("正在写入文档（App.commit）");
      setProgressPhase("applying", "正在通过 App.commit 应用 " + ops.length + " 条操作");
      return doCommit(ops, { label: label, source: "ai" }).then(function (r) {
        if (r && r.applied > 0) {
          var n = r.applied;
          if (state.pendingOps === ops) clearPending();
          setProgressPhase("applied_done", "已写入文档（" + n + " 条操作）");
          toast("已应用 " + n + " 条 AI 操作", { type: "success" });
          return r;
        }
        setProgressPhase("apply_error", "操作校验未通过或目标不存在；待应用操作已保留，可修改后重试");
        toast("操作未能应用，请检查目标是否存在", { type: "error" });
        return r;
      }).catch(function (err) {
        setProgressPhase("apply_error", err && err.message ? err.message : String(err));
        throw err;
      });
    });
  };

  /** AiPanel.discardPending() */
  AiPanel.discardPending = function () {
    clearPending();
    clearProgress();
    toast("已放弃待应用的 AI 操作", { type: "info" });
  };

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(new Error("读取栅格图像失败（FileReader 出错）")); };
      fr.readAsDataURL(blob);
    });
  }

  /** AiPanel.review() -> Promise<{items, mode}> */
  AiPanel.review = function () {
    requireApp();
    if (state.busy || state.applying) return Promise.reject(new Error("正在处理上一条请求，请稍候"));
    var generation = ++reviewSeq;
    var kind = configKind();
    var withImage = kind === "direct";
    if (withImage && (!g.FigExport || typeof g.FigExport.toRasterBlob !== "function")) {
      return Promise.reject(new Error("FigExport 未加载，无法栅格化画布"));
    }
    var requestVersion = captureDocumentVersion(g.App.doc);
    state.busy = true;
    setActionsBusy(true);
    if (els.taskDetails) els.taskDetails.open = true;
    setProgressBusy("AI 审阅进行中（阶段实时更新，非百分比）");
    setProgressPhase("collect", withImage
      ? "正在栅格化画布作为审阅输入"
      : (kind === "off" ? "离线审阅不生成截图，仅使用结构化文档与规则检查"
        : "DSH 桥仅支持文本：本次不发送截图，仅使用结构化文档与规则检查"));

    var dpi = (g.App.canvas && g.App.canvas() && g.App.canvas().dpi) || 300;
    var t0 = Date.now();
    return Promise.resolve()
      .then(function () {
        if (!withImage) return null;
        return g.FigExport.toRasterBlob(requestVersion.doc, { format: "png", dpi: dpi })
          .then(blobToDataURL);
      })
      .then(function (dataUrl) {
        if (generation !== reviewSeq) return { items: [], mode: "fallback" };
        setProgressPhase("collect", withImage
          ? "审阅输入已就绪，准备模型请求"
          : "无截图的结构化审阅上下文已就绪，未声称视觉审阅");
        var request = {
          doc: requestVersion.doc,
          imageDataUrl: withImage ? dataUrl : null,
          journalPreset: (typeof g.App.currentJournal === "function") ? g.App.currentJournal() : null
        };
        if (g.SciencePanel && typeof g.SciencePanel.reviewContext === "function") {
          request.checkResult = g.SciencePanel.reviewContext();
        }
        var rid = null;
        if (kind === "bridge" && g.Settings &&
            typeof g.Settings.reserveRequestId === "function") {
          rid = g.Settings.reserveRequestId("review");
        }
        setProgressPhase(rid || kind === "direct" ? "model_pending" : "offline",
          rid ? "已提交审阅请求，等待模型响应" : (kind === "direct" ? "直连模型请求中" : "离线规则审阅"),
          { rid: rid });
        startProgressPolling(rid, 0, 0);
        return g.FigAI.requestReview(request).then(function (res) {
          stopProgressPolling();
          if (rid && g.Settings && typeof g.Settings.releaseRequestId === "function") {
            g.Settings.releaseRequestId(rid);
          }
          if (generation === reviewSeq) {
            setProgressBusy("");
            setProgressPhase("parse", "解析审阅意见");
          }
          return res;
        }, function (err) {
          stopProgressPolling();
          if (rid && g.Settings && typeof g.Settings.releaseRequestId === "function") {
            g.Settings.releaseRequestId(rid);
          }
          throw err;
        });
      })
      .then(function (res) {
        if (generation !== reviewSeq) return res;
        state.lastMode = res.mode;
        var errorCause = null;
        if (res.mode === "model") {
          setBadge("model", "", "ask");
        } else {
          var cause = fallbackCause(t0);
          setBadge(cause.kind, cause.detail, "ask");
          if (cause.kind !== "fallback" && cause.kind !== "offline") {
            errorCause = cause;
            toast("审阅回退离线：" + (cause.detail || badgeShortText()),
              { type: "error", ms: 8000 });
          }
        }
        state.reviewItems = Array.isArray(res.items) ? res.items.filter(Boolean) : [];
        state.reviewVersion = requestVersion;
        state.reviewStale = !documentVersionIsCurrent(requestVersion);
        renderReview();
        if (state.reviewStale) {
          setProgressPhase("apply_error", "文档在审阅生成期间已变化；旧审阅结果已禁用，请重新审阅");
        } else if (state.reviewItems.length) {
          if (res.mode === "model") {
            setProgressPhase("review_wait", (withImage ? "" : "无截图结构化审阅；") +
              "共 " + state.reviewItems.length + " 条意见待处理；单条「应用」才会写入文档");
          } else if (errorCause) {
            setProgressPhase(errorCause.kind === "bridge-down" ? "bridge_error" : "model_error",
              "审阅回退：" + (errorCause.detail || badgeShortText()) +
              "｜以下 " + state.reviewItems.length + " 条意见来自离线规则");
          } else {
            setProgressPhase("offline", "离线审阅共 " + state.reviewItems.length +
              " 条意见；单条「应用」才会写入文档");
          }
        } else {
          setProgressPhase(res.mode === "model" ? "model_complete" : "offline",
            withImage ? "审阅完成：没有发现问题" : "结构化审阅未发现问题；未进行像素级视觉审美验收");
        }
        if (!state.reviewItems.length) {
          toast(withImage ? "审阅完成：没有发现问题" : "结构化审阅未发现问题；未进行像素级视觉审美验收",
            { type: "success" });
        }
        return res;
      })
      .catch(function (err) {
        if (generation === reviewSeq) {
          var msg = (g.FigAI && g.FigAI.explainError) ? g.FigAI.explainError(err)
            : (err && err.message ? err.message : String(err));
          setProgressPhase("model_error", msg);
          toast("审阅失败：" + msg, { type: "error" });
        }
        throw err;
      })
      .finally(function () {
        if (generation !== reviewSeq) return;
        state.busy = false;
        setProgressBusy("");
        stopProgressPolling();
        setActionsBusy(!!state.applying);
      });
  };

  // ------------------------------------------------------------------
  // mount
  // ------------------------------------------------------------------
  AiPanel.mount = function (panelEl) {
    if (!panelEl) throw new Error("AiPanel.mount：panelEl 不能为空");
    els.root = panelEl;
    panelEl.textContent = "";
    panelEl.style.display = "flex";
    panelEl.style.flexDirection = "column";
    panelEl.style.minHeight = "0";
    panelEl.style.height = "100%";
    panelEl.style.boxSizing = "border-box";
    panelEl.style.overflow = "hidden";
    ensureProgressStyles();

    var titleBtn = IS_ASSISTANT_PAGE ? h("button", {
      text: "打开主工作台", title: "回到完整编辑器（同一绘图服务的主窗口）",
      style: "padding:2px 10px;cursor:pointer;font-size:12px;white-space:nowrap;",
      onClick: function () {
        try { window.open("/", "figure-workbench"); } catch (e) { /* ignore */ }
      }
    }) : null;
    var title = h("div", {
      style: "display:flex;align-items:center;gap:6px;margin-bottom:5px;flex:0 0 auto;white-space:nowrap;"
    }, [
      h("strong", { text: "AI 对话" }),
      els.badge = h("span", { text: "当前模式：未调用" }),
      h("span", { style: "flex:1;" }),
      titleBtn
    ]);
    AiPanel.refreshStatus();

    els.chatLog = h("div", {
      id: "ai-chat-log", role: "log", "aria-live": "polite",
      style: "flex:1 1 auto;min-height:86px;overflow-y:auto;overflow-x:hidden;padding:2px 3px;" +
        "border:1px solid #e3e7ed;border-radius:6px;background:#fff;"
    });

    els2.busyBar = h("div", { className: "ai-busy-track" }, [
      h("div", { className: "ai-busy-fill" })
    ]);
    els2.busyLabel = h("span", { style: "font-size:11px;color:#475569;white-space:nowrap;" });
    els2.busyRow = h("div", {
      style: "display:none;align-items:center;gap:8px;margin:5px 0 3px 0;flex:0 0 auto;"
    }, [els2.busyBar, els2.busyLabel]);
    els2.chip = h("span", { className: "ai-phase-chip", text: "" });
    els2.detail = h("span", { style: "font-size:11px;color:#64748b;", text: "" });
    els2.phaseRow = h("div", {
      style: "display:none;align-items:center;gap:6px;margin:4px 0;flex-wrap:wrap;flex:0 0 auto;"
    }, [els2.chip, els2.detail]);
    els2.wrap = h("div", { style: "display:none;flex:0 0 auto;" }, [els2.busyRow, els2.phaseRow]);
    renderProgress();

    els.input = h("textarea", {
      id: "ai-chat-input", maxLength: "4000",
      placeholder: "讨论这张图，或右键画布元素/选框发送给 AI 后说明局部修改；[1] 会精确对应锚点",
      style: "width:100%;height:58px;box-sizing:border-box;font-size:13px;margin-top:6px;resize:none;flex:0 0 auto;"
    });
    els.refChips = h("div", {
      className: "ai-anchor-refs",
      style: "display:none;flex-wrap:wrap;gap:4px;margin-top:4px;align-items:center;" +
        "max-height:52px;overflow-y:auto;flex:0 0 auto;"
    });

    function onAction(promise) {
      promise.catch(function (err) {
        if (err) toast(err.message || String(err), { type: "error" });
      });
    }
    els.chatBtn = h("button", {
      id: "ai-discuss-btn", text: "问问这张图", title: "自然语言讨论；不会生成或应用编辑操作",
      style: "padding:4px 10px;cursor:pointer;white-space:nowrap;",
      onClick: function () { onAction(AiPanel.chat()); }
    });
    els.askBtn = h("button", {
      id: "ai-edit-btn", text: "生成编辑操作", title: "请求 EditOp 预览，确认应用后才写入文档",
      style: "padding:4px 10px;cursor:pointer;white-space:nowrap;",
      onClick: function () { onAction(AiPanel.ask()); }
    });
    els.reviewBtn = h("button", {
      id: "ai-review-btn", text: "审阅当前图", title: "独立检查当前画布、布局、可读性与统计声明",
      style: "padding:4px 10px;cursor:pointer;white-space:nowrap;",
      onClick: function () { onAction(AiPanel.review()); }
    });
    var actions = h("div", {
      style: "display:flex;gap:5px;flex-wrap:wrap;margin:6px 0;flex:0 0 auto;"
    }, [els.chatBtn, els.askBtn, els.reviewBtn]);

    els.pendingBox = h("div", { style: "margin:4px 0 8px;padding:7px;background:#f8f9fa;border-radius:6px;" });
    els.pendingModeEl = h("div", { style: "margin:3px 0;font-weight:bold;" });
    els.pendingExpEl = h("div", { style: "margin:3px 0;white-space:pre-wrap;font-size:12px;" });
    els.pendingSegmentsEl = h("div", {
      "data-pending-segments": "true",
      style: "display:none;margin:3px 0;white-space:pre-wrap;font-size:11px;color:#7c2d12;"
    });
    els.pendingList = h("ol", { style: "margin:4px 0 4px 18px;padding:0;font-size:12px;" });
    els.emptyHint = h("div", { style: "color:#888;font-size:12px;", text: "尚无待应用的 AI 操作。" });
    els.applyBtn = h("button", { text: "应用", style: "padding:3px 16px;cursor:pointer;font-weight:bold;",
      onClick: function () { onAction(AiPanel.applyPending()); } });
    els.discardBtn = h("button", { text: "放弃", style: "padding:3px 16px;cursor:pointer;margin-left:8px;",
      onClick: function () { AiPanel.discardPending(); } });
    els.pendingBtnRow = h("div", { style: "margin-top:6px;" }, [els.applyBtn, els.discardBtn]);
    els.pendingBox.appendChild(els.pendingModeEl);
    els.pendingBox.appendChild(els.pendingExpEl);
    els.pendingBox.appendChild(els.pendingSegmentsEl);
    els.pendingBox.appendChild(els.emptyHint);
    els.pendingBox.appendChild(els.pendingList);
    els.pendingBox.appendChild(els.pendingBtnRow);

    els.reviewList = h("div", { style: "margin-top:4px;font-size:12px;" });
    els.taskDetails = h("details", {
      style: "flex:0 1 auto;min-height:24px;max-height:180px;overflow-y:auto;margin-top:2px;font-size:12px;"
    }, [
      h("summary", { text: "编辑预览与审阅结果（与自然问答、科学论证分开）",
        style: "cursor:pointer;color:#475569;padding:3px 0;" }),
      els.pendingBox,
      h("div", { style: "font-weight:bold;margin-top:4px;", text: "AI 审阅当前图" }),
      els.reviewList
    ]);

    panelEl.appendChild(title);
    panelEl.appendChild(els.chatLog);
    panelEl.appendChild(els2.wrap);
    panelEl.appendChild(els.input);
    panelEl.appendChild(els.refChips);
    panelEl.appendChild(actions);
    panelEl.appendChild(els.taskDetails);

    if (g.App && g.App.doc) syncAnchorRefsWithDoc();
    renderConversation();
    renderPending();
    renderReview();
    renderAnchorRefs();

    if (g.App && typeof g.App.on === "function") {
      g.App.on("doc:changed", function () {
        state.documentEpoch += 1;
        if (state.pendingOps && state.pendingOps.length) state.pendingStale = true;
        if (state.reviewItems.length) state.reviewStale = true;
        syncAnchorRefsWithDoc();
        renderPending();
        renderReview();
      });
    }
  };
})();
