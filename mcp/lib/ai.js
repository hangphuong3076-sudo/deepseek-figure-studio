/**
 * shared/lib/ai.js — FigAI
 * DeepSeek client, prompt builders and deterministic offline fallbacks.
 *
 * Frozen contract: shared/lib/API.md (section FigAI).
 * No dependencies, no module system. Loaded after figdoc/ops/palette/presets
 * via <script> tags; must also run standalone under Node.
 *
 * Load order: figdoc -> ops -> palette -> presets -> data -> render -> tiff
 *             -> export -> ai -> storage
 */
(function (global) {
  "use strict";

  var FigAI = {};

  // ------------------------------------------------------------------
  // Constants (frozen by API.md)
  // ------------------------------------------------------------------

  FigAI.DEFAULT_BASE_URL = "https://api.deepseek.com";
  FigAI.DEFAULT_MODEL = "deepseek-flash";
  FigAI.VISION_MODEL = "deepseek-flash";

  var STATE = {
    apiKey: "",
    baseUrl: FigAI.DEFAULT_BASE_URL,
    model: FigAI.DEFAULT_MODEL,
    visionModel: FigAI.VISION_MODEL,
    proxyUrl: ""
  };

  // ------------------------------------------------------------------
  // config / enabled
  // ------------------------------------------------------------------

  /**
   * FigAI.config({apiKey, baseUrl, model, visionModel, proxyUrl}) -> void
   * Empty apiKey disables the model path (enabled() === false).
   * proxyUrl (if set) replaces the request URL entirely (v2 proxy mode).
   */
  FigAI.config = function (opts) {
    if (opts === undefined || opts === null) return;
    if (typeof opts !== "object") throw new Error("config 参数必须为对象");
    if ("apiKey" in opts) STATE.apiKey = opts.apiKey ? String(opts.apiKey) : "";
    if ("baseUrl" in opts && opts.baseUrl != null && opts.baseUrl !== "") {
      if (typeof opts.baseUrl !== "string") throw new Error("baseUrl 必须为字符串");
      STATE.baseUrl = opts.baseUrl;
    }
    if ("model" in opts && opts.model) {
      if (typeof opts.model !== "string") throw new Error("model 必须为字符串");
      STATE.model = opts.model;
    }
    if ("visionModel" in opts && opts.visionModel) {
      if (typeof opts.visionModel !== "string") throw new Error("visionModel 必须为字符串");
      STATE.visionModel = opts.visionModel;
    }
    if ("proxyUrl" in opts) {
      if (opts.proxyUrl != null && opts.proxyUrl !== "" && typeof opts.proxyUrl !== "string") {
        throw new Error("proxyUrl 必须为字符串");
      }
      STATE.proxyUrl = opts.proxyUrl ? String(opts.proxyUrl) : "";
    }
  };

  FigAI.enabled = function () {
    return !!STATE.apiKey;
  };

  // ------------------------------------------------------------------
  // Small utils (self-contained: ai.js must run without other lib files)
  // ------------------------------------------------------------------

  function trimSlash(s) {
    return String(s).replace(/\/+$/, "");
  }

  function round1(v) {
    return Math.round(Number(v) * 10) / 10;
  }

  function round2(v) {
    return Math.round(Number(v) * 100) / 100;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function oneLine(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  function trunc(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function cell(s, n) {
    return trunc(oneLine(s).replace(/\|/g, "\\|"), n == null ? 24 : n);
  }

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function elementMap(doc) {
    var m = {};
    var els = (doc && doc.elements) || [];
    for (var i = 0; i < els.length; i++) {
      if (els[i] && els[i].id) m[els[i].id] = els[i];
    }
    return m;
  }

  /** Canvas size in mm; safe defaults for malformed docs. */
  function canvasSize(doc) {
    var c = (doc && doc.canvas) || {};
    return {
      w: typeof c.width_mm === "number" ? c.width_mm : 120,
      h: typeof c.height_mm === "number" ? c.height_mm : 90
    };
  }

  /**
   * Bounding box (mm) of an element; group/panel recurse over children.
   * Local implementation so ai.js works even if FigDoc is not loaded.
   */
  function elementBbox(el, byId, seen) {
    if (!el || !el.transform) return null;
    if (seen[el.id]) return null;
    seen[el.id] = true;
    var t = el.transform;
    var b = { x: Number(t.x) || 0, y: Number(t.y) || 0, w: Number(t.w) || 0, h: Number(t.h) || 0 };
    if ((el.type === "group" || el.type === "panel") && el.children && el.children.length) {
      for (var i = 0; i < el.children.length; i++) {
        var c = byId[el.children[i]];
        var cb = c ? elementBbox(c, byId, seen) : null;
        if (!cb) continue;
        var x2 = Math.max(b.x + b.w, cb.x + cb.w);
        var y2 = Math.max(b.y + b.h, cb.y + cb.h);
        b.x = Math.min(b.x, cb.x);
        b.y = Math.min(b.y, cb.y);
        b.w = x2 - b.x;
        b.h = y2 - b.y;
      }
    }
    return b;
  }

  function bboxIntersects(a, b) {
    if (!a || !b) return false;
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  // ------------------------------------------------------------------
  // Prompt builders
  // ------------------------------------------------------------------

  var OP_HELP = [
    "可用 EditOp 类型与关键字段（op 字段只能取这些值）：",
    "- move: {targets, dx, dy}（相对位移 mm）或 {targets, x, y}（绝对位置 mm）",
    "- resize: {targets, w, h}（mm，最小 0.1）",
    "- rotate: {targets, rotation}（绝对角度）或 {targets, angle}（相对角度）",
    "- set_text: {targets, text}（仅 type=text 元素）",
    "- set_style: {targets, style:{...}}（合并补丁：fontSizePt / fontWeight:normal|bold / fontStyle:normal|italic / textAlign:left|center|right / fill / stroke / strokeWidthPt / opacity / dash / fontFamily / lineHeight 等）",
    "- set_color: {targets, color, stroke?}（color 写入 style.fill，stroke 写入 style.stroke）",
    "- add_element: {element:{id?, type, transform:{x,y,w,h}, ...}}",
    "- delete: {targets}",
    "- group: {targets, id?}；ungroup: {targets}",
    "- align: {targets, mode: left|center|right|top|middle|bottom}（多目标对齐到共同包围盒；单目标对齐到画布）",
    "- distribute: {targets, orientation: horizontal|vertical}（≥3 个目标才生效）",
    "- z_order: {targets, to: front|back|forward|backward}",
    "- add_anchor: {anchor:{id?, label, bbox_mm 或 bbox_norm}}；update_anchor: {anchor:{id,...}}；remove_anchor: {anchor:{id}}",
    "- apply_template: {template_id}；apply_journal: {journal_preset_id}",
    "- apply_schematic: {contract:{id,nodes,relations,sources,canvas?,layout?},auto_layout?:false}（来源链接的严格声明式示意图；禁止猜实验体/方向）",
    "- set_chart_data: {targets:[chartId],approved:true,data:{columns,rows,source_ref?,version?,raw_source_sha256?,source_info?},source_ref,version}（显式批准后换数据，旧来源完整入 data_history；无新 raw 证明则不继承旧 hash）",
    "- recolor: {palette_id, recolor_strategy?: byHue|byOrder|byRole}",
    "- panel_layout: {targets, panel:{cols, rows, gap_mm, padding_mm, ...}}",
    "- set_canvas: {canvas:{width_mm, height_mm, dpi, background, ...}}",
    "- note: {note}（无副作用，用于说明性输出）",
    "targets 项格式：元素 id 字符串；\"@<锚点id>\" 表示锚点内的元素；{kind:\"all\"} 表示全部元素；{kind:\"type\", type:\"text\"} 表示某类元素。锚点 id 指 anchors 清单中的 id。",
    "每个 op 可附带 reason 字段（中文）说明理由。"
  ].join("\n");

  function renderElementTable(doc) {
    var els = (doc && doc.elements) || [];
    if (!els.length) return "（当前文档没有元素）";
    var byId = elementMap(doc);
    var lines = ["| id | type | name | bbox_mm(x,y,w,h) | text/说明 |", "|---|---|---|---|---|"];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || !el.id) continue;
      var b = elementBbox(el, byId, {});
      var bbox = b ? round1(b.x) + "," + round1(b.y) + "," + round1(b.w) + "," + round1(b.h) : "-";
      var desc = el.type === "text" ? cell(el.text, 24) : cell(el.name || (el.chart && el.chart.chartType) || "", 24);
      lines.push("| " + el.id + " | " + el.type + " | " + cell(el.name, 16) + " | " + bbox + " | " + desc + " |");
    }
    return lines.join("\n");
  }

  function renderAnchorTable(anchors) {
    if (!anchors || !anchors.length) return "（当前文档没有锚点）";
    var lines = ["| id | label | bbox_mm(x,y,w,h) | note |", "|---|---|---|---|"];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (!a || !a.id) continue;
      var m = a.bbox_mm || {};
      lines.push("| " + a.id + " | " + cell(a.label, 16) + " | " +
        (m.x != null ? round1(m.x) + "," + round1(m.y) + "," + round1(m.w) + "," + round1(m.h) : "-") +
        " | " + cell(a.note, 24) + " |");
    }
    return lines.join("\n");
  }

  function renderHistoryTail(historyTail) {
    if (!historyTail || !historyTail.length) return "";
    var lines = ["最近操作历史（仅供参考，勿重复执行已完成的操作）："];
    var n = Math.min(historyTail.length, 10);
    for (var i = historyTail.length - n; i < historyTail.length; i++) {
      var item = historyTail[i];
      var text = item && item.ops ? JSON.stringify({ label: item.label, ops: item.ops }) : JSON.stringify(item);
      lines.push("- " + trunc(oneLine(text), 200));
    }
    return lines.join("\n");
  }

  function requireDoc(x, fnName) {
    if (!isObj(x)) throw new Error(fnName + " 缺少有效的 doc 参数");
  }

  function requireInstruction(x, fnName) {
    if (typeof x !== "string" || !x.trim()) throw new Error(fnName + " 缺少有效的 instruction 参数");
  }

  /**
   * FigAI.buildEditMessages({doc, instruction, anchors, selection, historyTail}) -> messages
   */
  FigAI.buildEditMessages = function (opts) {
    opts = opts || {};
    requireDoc(opts.doc, "buildEditMessages");
    requireInstruction(opts.instruction, "buildEditMessages");
    var doc = opts.doc;
    var anchors = Array.isArray(opts.anchors) ? opts.anchors : (doc.anchors || []);
    var parts = [
      "你是一个科研绘图编辑器的 AI 助手。你只能通过输出 EditOp 操作来修改文档，绝不能直接声称已修改。",
      OP_HELP,
      "当前文档元素清单：",
      renderElementTable(doc),
      "锚点清单：",
      renderAnchorTable(anchors)
    ];
    if (Array.isArray(opts.selection) && opts.selection.length) {
      parts.push("当前选中元素：" + opts.selection.join(", "));
    }
    var hist = renderHistoryTail(opts.historyTail);
    if (hist) parts.push(hist);
    parts.push(
      "输出要求：只输出一个 JSON 对象：{\"ops\":[...],\"explanation\":\"...\"}。" +
      "ops 是 EditOp 数组，explanation 用一句中文说明你做了什么。" +
      "不要输出 markdown 代码块标记，不要输出 JSON 之外的任何文字。"
    );
    return [
      { role: "system", content: parts.join("\n") },
      { role: "user", content: "用户指令：" + oneLine(opts.instruction) }
    ];
  };

  /**
   * FigAI.buildReviewMessages({doc, imageDataUrl, journalPreset, checkResult}) -> messages
   */
  FigAI.buildReviewMessages = function (opts) {
    opts = opts || {};
    requireDoc(opts.doc, "buildReviewMessages");
    var doc = opts.doc;
    var preset = opts.journalPreset || null;
    var anchors = doc.anchors || [];
    var parts = [
      "你是一个科研投稿图表审阅助手。请审阅给定的图形文档" +
        (opts.imageDataUrl
          ? "（请求中包含当前渲染截图；仍不得据此保证真实视觉质量或审美/投稿验收）"
          : "（未提供渲染截图，只能依据结构化 FigureDocument、几何信息和规则告警；不得声称看过像素或完成视觉审美验收）") +
        "，从期刊规范与可读性角度找出问题。",
      "severity 取值：high=影响投稿或正确性，必须修；medium=明显影响可读性/规范性；low=建议优化。",
      "target 必须是元素 id 或锚点 id（文档级问题可用 doc.id）。",
      "op 是一个可选的 EditOp（格式见下），给出能直接修复该问题的操作；给不出就填 null。"
    ];
    if (preset) {
      parts.push(
        "期刊预设：" + (preset.name || preset.id || "") +
        "；栏宽 " + (preset.width_mm != null ? preset.width_mm + "mm" : "未限定") +
        "；最大高度 " + (preset.height_mm != null ? preset.height_mm + "mm" : "未限定") +
        "；正文字号 " + (preset.base_font_pt != null ? preset.base_font_pt + "pt" : "-") +
        "；最小字号 " + (preset.min_font_pt != null ? preset.min_font_pt + "pt" : "-") +
        "；最低 dpi " + (preset.dpi_min != null ? preset.dpi_min : "-") + "。"
      );
    }
    if (opts.checkResult && Array.isArray(opts.checkResult.warnings) && opts.checkResult.warnings.length) {
      parts.push("规则引擎已发现的告警：");
      opts.checkResult.warnings.forEach(function (w) {
        parts.push("- [" + (w.code || "?") + "] " + oneLine(w.message || "") +
          (w.element_id ? "（元素 " + w.element_id + "）" : ""));
      });
    }
    parts.push("EditOp 关键字段说明：", OP_HELP);
    parts.push("当前文档元素清单：", renderElementTable(doc));
    parts.push("锚点清单：", renderAnchorTable(anchors));
    parts.push(
      "输出要求：只输出一个 JSON 数组：[{\"severity\":\"high|medium|low\",\"target\":\"<element_id|anchor_id>\"," +
      "\"issue\":\"...\",\"suggestion\":\"...\",\"op\":<EditOp|null>}]" +
      "。没有问题输出 []。不要输出 markdown 代码块标记，不要输出 JSON 之外的任何文字。"
    );
    return [
      { role: "system", content: parts.join("\n") },
      { role: "user", content: "请审阅当前文档并列出问题。" }
    ];
  };

  // ------------------------------------------------------------------
  // AIError
  // ------------------------------------------------------------------

  /**
   * FigAI.AIError — carries .status (HTTP status, 0 for transport errors)
   * and .body (response body / detail, truncated to 500 chars).
   */
  function AIError(message, status, body) {
    var e = new Error(message);
    e.name = "AIError";
    e.status = typeof status === "number" ? status : 0;
    e.body = body == null ? "" : String(body).slice(0, 500);
    return e;
  }
  AIError.prototype = Object.create(Error.prototype);
  AIError.prototype.constructor = AIError;
  FigAI.AIError = AIError;

  // ------------------------------------------------------------------
  // chat()
  // ------------------------------------------------------------------

  function endpointUrl() {
    if (STATE.proxyUrl) return STATE.proxyUrl;
    return trimSlash(STATE.baseUrl) + "/chat/completions";
  }

  /**
   * FigAI.chat(messages, {json=true, model, timeoutMs=60000, imageDataUrl})
   *   -> Promise<{text, usage, raw}>
   * POST `${baseUrl}/chat/completions`, Bearer auth, body {model, messages, stream:false}.
   * imageDataUrl is attached to the last user message as an image_url part.
   * Non-2xx responses throw AIError with .status and .body (first 500 chars).
   */
  FigAI.chat = async function (messages, opts) {
    opts = opts || {};
    if (!Array.isArray(messages) || !messages.length) {
      throw new AIError("chat 的 messages 必须为非空数组", 0, "bad messages");
    }
    if (!STATE.apiKey) {
      throw new AIError("未配置 API Key，无法调用 AI 服务", 0, "no api key");
    }
    if (typeof fetch !== "function") {
      throw new AIError("当前运行环境不支持 fetch，无法调用 AI 服务", 0, "no fetch");
    }
    var timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 60000;
    var model = opts.model || (opts.imageDataUrl ? STATE.visionModel : STATE.model);
    var msgs = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (!m || (m.role !== "system" && m.role !== "user" && m.role !== "assistant")) {
        throw new AIError("messages 中存在非法消息（role 必须为 system/user/assistant）", 0, "bad role");
      }
      msgs.push({ role: m.role, content: m.content });
    }
    if (opts.imageDataUrl) {
      var idx = -1;
      for (var j = msgs.length - 1; j >= 0; j--) {
        if (msgs[j].role === "user") { idx = j; break; }
      }
      if (idx < 0) throw new AIError("附带图片时 messages 中必须至少有一条 user 消息", 0, "no user message");
      var last = msgs[idx];
      var contentArr = typeof last.content === "string"
        ? [{ type: "text", text: last.content }]
        : (Array.isArray(last.content) ? last.content.slice() : []);
      contentArr.push({ type: "image_url", image_url: { url: String(opts.imageDataUrl) } });
      msgs[idx] = { role: "user", content: contentArr };
    }
    var body = { model: model, messages: msgs, stream: false };
    if (opts.json !== false) body.response_format = { type: "json_object" };

    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);

    var res;
    try {
      res = await fetch(endpointUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + STATE.apiKey
        },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err && (err.name === "AbortError" || /abort/i.test(String(err.message || "")))) {
        throw new AIError("请求超时（" + timeoutMs + "ms），请检查网络或增大 timeoutMs", 0, "timeout");
      }
      throw new AIError("网络请求失败：" + (err && err.message ? err.message : String(err)), 0,
        err && err.message ? String(err.message) : "network error");
    }
    if (timer) clearTimeout(timer);

    if (!res.ok) {
      var text = "";
      try { text = await res.text(); } catch (e2) { text = ""; }
      throw new AIError("AI 服务返回错误（HTTP " + res.status + "）", res.status, text);
    }
    var data;
    try {
      data = await res.json();
    } catch (e3) {
      throw new AIError("AI 服务响应不是有效 JSON（HTTP " + res.status + "）", res.status, "invalid json");
    }
    var out = data && data.choices && data.choices[0] && data.choices[0].message &&
      typeof data.choices[0].message.content === "string"
      ? data.choices[0].message.content
      : null;
    if (out === null) {
      throw new AIError("AI 响应格式异常：缺少 choices[0].message.content", res.status,
        JSON.stringify(data).slice(0, 500));
    }
    return { text: out, usage: data.usage || null, raw: data };
  };

  // ------------------------------------------------------------------
  // JSON extraction from model output
  // ------------------------------------------------------------------

  function extractJSON(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("AI 返回内容为空");
    var s = text.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    try { return JSON.parse(s); } catch (e) { /* fall through */ }
    var o = s.indexOf("{");
    var p = s.lastIndexOf("}");
    var a = s.indexOf("[");
    var b = s.lastIndexOf("]");
    var cand = null;
    if (a >= 0 && b > a && (o < 0 || a < o)) cand = s.slice(a, b + 1);
    else if (o >= 0 && p > o) cand = s.slice(o, p + 1);
    if (cand) {
      try { return JSON.parse(cand); } catch (e2) { /* fall through */ }
    }
    throw new Error("AI 返回内容不是有效 JSON");
  }

  function firstArrayValue(obj) {
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(obj[keys[i]])) return obj[keys[i]];
    }
    return null;
  }

  function opsProblem(arr) {
    if (!Array.isArray(arr)) return "缺少 ops 数组";
    for (var i = 0; i < arr.length; i++) {
      if (!isObj(arr[i])) return "ops[" + i + "] 不是对象";
      if (typeof arr[i].op !== "string" || !arr[i].op) return "ops[" + i + "] 缺少字符串字段 op";
    }
    return null;
  }

  function parseOpsOutput(text) {
    var parsed;
    try { parsed = extractJSON(text); } catch (e) { return { problem: e.message }; }
    var ops = null, explanation = "";
    if (Array.isArray(parsed)) {
      ops = parsed;
    } else if (isObj(parsed)) {
      ops = Array.isArray(parsed.ops) ? parsed.ops : firstArrayValue(parsed);
      explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";
    }
    var problem = opsProblem(ops);
    return problem ? { problem: problem } : { ops: ops, explanation: explanation };
  }

  function validReviewArray(arr) {
    if (!Array.isArray(arr)) return null;
    for (var i = 0; i < arr.length; i++) {
      if (!isObj(arr[i])) return null;
    }
    return arr;
  }

  // ------------------------------------------------------------------
  // requestOps / requestReview / explainError
  // ------------------------------------------------------------------

  /**
   * FigAI.requestOps({doc, instruction, anchors, selection})
   *   -> Promise<{ops, explanation, mode:"model"|"fallback"}>
   * Falls back to fallbackOps when: no key, network failure, non-2xx,
   * or unparsable/invalid model output. Never throws for those cases.
   */
  FigAI.requestOps = async function (opts) {
    opts = opts || {};
    requireDoc(opts.doc, "requestOps");
    requireInstruction(opts.instruction, "requestOps");
    var fallback = function (reason, stage) {
      var r = FigAI.fallbackOps(opts);
      var out = { ops: r.ops, explanation: r.explanation, mode: "fallback" };
      if (reason) { out.fallback_reason = reason; out.fallback_stage = stage; }
      return out;
    };
    if (!FigAI.enabled()) return fallback();
    var messages, res;
    try {
      messages = FigAI.buildEditMessages({
        doc: opts.doc,
        instruction: opts.instruction,
        anchors: opts.anchors,
        selection: opts.selection,
        historyTail: opts.historyTail
      });
      res = await FigAI.chat(messages, { json: true });
    } catch (err) {
      return fallback(err && err.message ? err.message : String(err), "request");
    }
    var first = parseOpsOutput(res.text);
    if (!first.problem) return { ops: first.ops, explanation: first.explanation, mode: "model" };
    try {
      var repairMessages = messages.concat([
        { role: "assistant", content: String(res.text).slice(0, 8000) },
        { role: "user", content: "上一条输出未通过 EditOp 校验：" + first.problem +
          "。请只输出修正后的 JSON 对象 {\"ops\":[...],\"explanation\":\"...\"}，每个 op 必须包含字符串字段 op，不要输出其他文字。" }
      ]);
      var repairRes = await FigAI.chat(repairMessages, { json: true });
      var second = parseOpsOutput(repairRes.text);
      if (!second.problem) {
        return { ops: second.ops, explanation: second.explanation, mode: "model",
          repaired: true, first_problem: first.problem };
      }
      return fallback("模型输出未通过 EditOp 校验（" + first.problem + "；自我修正一次后仍不合法：" + second.problem + "）", "validate");
    } catch (err2) {
      return fallback("模型输出未通过 EditOp 校验（" + first.problem + "）；修正请求失败：" +
        (err2 && err2.message ? err2.message : String(err2)), "validate");
    }
  };

  /**
   * FigAI.requestReview({doc, imageDataUrl, journalPreset})
   *   -> Promise<{items, mode:"model"|"fallback"}>
   */
  FigAI.requestReview = async function (opts) {
    opts = opts || {};
    requireDoc(opts.doc, "requestReview");
    var fallback = function () {
      var r = FigAI.fallbackReview(opts);
      return { items: r.items, explanation: r.explanation, mode: "fallback" };
    };
    if (!FigAI.enabled()) return fallback();
    try {
      var checkResult = opts.checkResult || null;
      if (!checkResult && global.FigPresets && typeof global.FigPresets.check === "function") {
        try { checkResult = global.FigPresets.check(opts.doc); } catch (e) { checkResult = null; }
      }
      var messages = FigAI.buildReviewMessages({
        doc: opts.doc,
        imageDataUrl: opts.imageDataUrl,
        journalPreset: opts.journalPreset,
        checkResult: checkResult
      });
      var res = await FigAI.chat(messages, {
        json: true,
        model: opts.imageDataUrl ? STATE.visionModel : undefined,
        imageDataUrl: opts.imageDataUrl
      });
      var parsed = extractJSON(res.text);
      var items = null;
      if (Array.isArray(parsed)) items = parsed;
      else if (isObj(parsed)) items = firstArrayValue(parsed);
      items = validReviewArray(items);
      if (!items) throw new Error("AI 返回的审阅意见不是合法的 JSON 数组");
      return { items: items, explanation: "", mode: "model" };
    } catch (err) {
      return fallback();
    }
  };

  /**
   * FigAI.explainError(err) -> string  人类可读中文错误说明。
   */
  FigAI.explainError = function (err) {
    if (!err) return "未知错误";
    var status = typeof err.status === "number" ? err.status : null;
    if (err.name === "AIError" || err instanceof AIError || status !== null) {
      if (status === 401) return "API Key 无效或未配置，请在设置中检查密钥。";
      if (status === 403) return "没有访问权限（HTTP 403），请检查 API Key 与账户状态。";
      if (status === 404) return "接口或模型不存在（HTTP 404），请检查 baseUrl 与 model 配置。";
      if (status === 429) return "请求过于频繁或额度不足（HTTP 429），请稍后再试。";
      if (status === 500 || status === 502 || status === 503 || status === 504) {
        return "AI 服务暂时不可用（HTTP " + status + "），请稍后重试。";
      }
      if (status === 0) {
        if (/timeout|超时/.test(String(err.message || "")) || String(err.body || "") === "timeout") {
          return "请求超时，请检查网络或增大 timeoutMs。";
        }
        return "网络请求失败：" + (err.message || "未知网络错误") + "。请检查网络与 baseUrl/proxyUrl 配置。";
      }
      if (status !== null) return "AI 请求失败（HTTP " + status + "）。" + trunc(oneLine(err.message), 80);
    }
    var msg = String(err.message || err);
    if (err.name === "AbortError" || /timeout|timed out|aborted/i.test(msg)) {
      return "请求超时，请检查网络或增大 timeoutMs。";
    }
    if (err instanceof TypeError || /fetch|network|ECONN/i.test(msg)) {
      return "网络请求失败，无法连接 AI 服务。请检查网络与 baseUrl/proxyUrl 配置。";
    }
    return "AI 调用出错：" + trunc(oneLine(msg), 120);
  };

  // ------------------------------------------------------------------
  // Offline fallback — target resolution
  // ------------------------------------------------------------------

  var BUILTIN_PALETTES = [
    ["npg", "NPG (Nature 系)"],
    ["aaas", "AAAS (Science 系)"],
    ["nejm", "NEJM"],
    ["lancet", "Lancet"],
    ["jco", "JCO"],
    ["npg-classic", "NPG 经典四色"],
    ["nature-skills-6", "nature-skills 六色"],
    ["show2know-01", "Show2Know 01"],
    ["show2know-05", "Show2Know 05"],
    ["okabe-ito", "Okabe-Ito 色盲友好"],
    ["colorbrewer-set2", "ColorBrewer Set2"],
    ["colorbrewer-dark2", "ColorBrewer Dark2"],
    ["viridis", "Viridis"],
    ["magma", "Magma"],
    ["blues", "Blues"],
    ["rdbu", "RdBu (发散)"],
    ["grayscale", "灰度（黑白印刷安全）"],
    ["accent-duo", "中性+信号 双色（审阅友好）"]
  ];

  function matchPalette(name) {
    var q = oneLine(name).toLowerCase();
    if (!q) return null;
    var list = null;
    var pal = global.FigPalette;
    if (pal && typeof pal.list === "function") {
      try {
        list = (pal.list() || []).map(function (p) { return { id: p.id, name: p.name || "" }; });
      } catch (e) { list = null; }
    }
    if (!list || !list.length) {
      list = BUILTIN_PALETTES.map(function (p) { return { id: p[0], name: p[1] }; });
    }
    var i, item, idLower, nameLower;
    for (i = 0; i < list.length; i++) {
      if (String(list[i].id).toLowerCase() === q) return list[i].id;
    }
    for (i = 0; i < list.length; i++) {
      if (oneLine(list[i].name).toLowerCase() === q) return list[i].id;
    }
    for (i = 0; i < list.length; i++) {
      nameLower = oneLine(list[i].name).toLowerCase();
      idLower = String(list[i].id).toLowerCase();
      if (nameLower.indexOf(q) >= 0 || (q.length >= 3 && q.indexOf(idLower) >= 0)) return list[i].id;
    }
    return null;
  }

  var COLOR_NAMES = {
    "红": "#FF0000", "红色": "#FF0000", "深红": "#8B0000",
    "蓝": "#0000FF", "蓝色": "#0000FF", "深蓝": "#00008B", "浅蓝": "#ADD8E6",
    "绿": "#008000", "绿色": "#008000", "深绿": "#006400", "浅绿": "#90EE90",
    "黄": "#FFFF00", "黄色": "#FFFF00",
    "黑": "#000000", "黑色": "#000000", "白": "#FFFFFF", "白色": "#FFFFFF",
    "灰": "#808080", "灰色": "#808080", "深灰": "#A9A9A9", "浅灰": "#D3D3D3",
    "橙": "#FFA500", "橙色": "#FFA500", "橘": "#FFA500", "橘色": "#FFA500",
    "紫": "#800080", "紫色": "#800080",
    "青": "#00FFFF", "青色": "#00FFFF",
    "品红": "#FF00FF", "洋红": "#FF00FF",
    "粉": "#FFC0CB", "粉色": "#FFC0CB",
    "棕": "#8B4513", "棕色": "#8B4513", "褐": "#8B4513", "褐色": "#8B4513",
    "金": "#FFD700", "金色": "#FFD700", "银": "#C0C0C0", "银色": "#C0C0C0",
    "red": "#FF0000", "blue": "#0000FF", "green": "#008000", "yellow": "#FFFF00",
    "black": "#000000", "white": "#FFFFFF", "gray": "#808080", "grey": "#808080",
    "orange": "#FFA500", "purple": "#800080", "cyan": "#00FFFF",
    "magenta": "#FF00FF", "pink": "#FFC0CB", "brown": "#8B4513"
  };

  var HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

  /** "#FF0000" / "红色" / "红色的" -> hex or null. */
  function matchColor(token) {
    var s = oneLine(token);
    if (!s) return null;
    if (HEX_RE.test(s)) return s.toUpperCase();
    var t = s.toLowerCase().replace(/的$/, "").replace(/色$/, "");
    if (HEX_RE.test(t)) return t.toUpperCase();
    if (COLOR_NAMES[s.toLowerCase()]) return COLOR_NAMES[s.toLowerCase()];
    if (COLOR_NAMES[s]) return COLOR_NAMES[s];
    if (COLOR_NAMES[t.toLowerCase()]) return COLOR_NAMES[t.toLowerCase()];
    if (COLOR_NAMES[t]) return COLOR_NAMES[t];
    return null;
  }

  /**
   * Boundary-aware token match: finds whole tokens (ids, names, labels)
   * inside free-form Chinese/Latin instructions.
   */
  function tokenInText(token, text) {
    if (!token) return false;
    var re = new RegExp("(^|[^A-Za-z0-9_.:-])" + escapeRegExp(token) + "(?=$|[^A-Za-z0-9_.:-])");
    return re.test(text);
  }

  /**
   * Resolve <目标> mentioned in the instruction.
   * Priority: element id > element name > anchor label/id > keyword(全体/所有文本) > selection.
   * Returns {targets: array|null, via: string}.
   */
  function findTargets(doc, instruction, anchors, selection) {
    var text = String(instruction);
    var byId = elementMap(doc);
    var foundIds = [];

    // element ids, longest first so "t12" wins over "t1"
    var ids = Object.keys(byId).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < ids.length; i++) {
      if (tokenInText(ids[i], text) && foundIds.indexOf(ids[i]) < 0) foundIds.push(ids[i]);
    }

    // element names
    if (!foundIds.length) {
      for (var j = 0; j < ids.length; j++) {
        var el = byId[ids[j]];
        if (el && el.name && tokenInText(el.name, text)) foundIds.push(ids[j]);
      }
    }
    if (foundIds.length) return { targets: foundIds, via: "element" };

    // anchors by label or id
    var anchorList = Array.isArray(anchors) ? anchors : ((doc && doc.anchors) || []);
    var matched = [];
    for (var k = 0; k < anchorList.length; k++) {
      var a = anchorList[k];
      if (!a || !a.id) continue;
      if ((a.label && tokenInText(a.label, text)) || tokenInText(a.id, text)) matched.push(a);
    }
    if (matched.length) {
      var tg = [];
      for (var m = 0; m < matched.length; m++) tg.push("@" + matched[m].id);
      return { targets: tg, via: "anchor" };
    }

    // keywords: 全体 / 所有文本 / 所有元素
    if (/所有文本|全部文本|所有文字|全部文字|各文本/.test(text)) {
      return { targets: [{ kind: "type", type: "text" }], via: "keyword" };
    }
    if (/所有元素|全部元素|全体|所有|全部/.test(text)) {
      return { targets: [{ kind: "all" }], via: "keyword" };
    }

    if (Array.isArray(selection) && selection.length) {
      return { targets: selection.slice(), via: "selection" };
    }
    return { targets: null, via: "none" };
  }

  function findAnchorById(doc, anchors, anchorId) {
    var list = Array.isArray(anchors) ? anchors : ((doc && doc.anchors) || []);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === anchorId) return list[i];
    }
    return null;
  }

  /**
   * Expand targets into concrete element ids:
   * "@anchorId" -> the anchor's element_ids, or elements intersecting its bbox;
   * {kind:"all"} / {kind:"type",type} -> matching element ids.
   * Elements whose parent is also in the set are dropped (parent moves carry them).
   */
  function resolveTargetIds(doc, targets, anchors) {
    var byId = elementMap(doc);
    var out = [];
    var push = function (id) {
      if (byId[id] && out.indexOf(id) < 0) out.push(id);
    };
    var list = Array.isArray(targets) ? targets : [];
    for (var i = 0; i < list.length; i++) {
      var tg = list[i];
      if (typeof tg === "string") {
        if (tg.charAt(0) === "@") {
          var a = findAnchorById(doc, anchors, tg.slice(1));
          if (!a) continue;
          if (Array.isArray(a.element_ids) && a.element_ids.length) {
            a.element_ids.forEach(push);
          } else if (a.bbox_mm) {
            for (var id in byId) {
              if (bboxIntersects(elementBbox(byId[id], byId, {}), a.bbox_mm)) push(id);
            }
          }
        } else {
          push(tg);
        }
      } else if (isObj(tg)) {
        if (tg.kind === "all") {
          for (var id2 in byId) push(id2);
        } else if (tg.kind === "type" && tg.type) {
          for (var id3 in byId) {
            if (byId[id3].type === tg.type) push(id3);
          }
        }
      }
    }
    // drop elements whose ancestor is also targeted (parent op moves them already)
    var set = {};
    out.forEach(function (id) { set[id] = true; });
    var kept = out.filter(function (id) {
      var el = byId[id];
      var pid = el && el.parent_id;
      var guard = 0;
      while (pid && set[pid] === undefined && guard++ < 100) {
        var p = byId[pid];
        pid = p && p.parent_id;
      }
      return !(pid && set[pid] === true);
    });
    return kept;
  }

  // ------------------------------------------------------------------
  // Offline fallback — fallbackOps
  // ------------------------------------------------------------------

  function noTargetResult(action) {
    return {
      ops: [],
      explanation: "离线模式识别出「" + action + "」指令，但没有找到目标元素或锚点；请用元素 id、锚点标签（如 a、(a)、标题）指定目标，或先在画布中选中元素。"
    };
  }

  function okResult(ops, what, n) {
    return {
      ops: ops,
      explanation: "离线模式：已识别「" + what + "」指令，对 " + n + " 个目标生成了 " + ops.length + " 条操作。"
    };
  }

  /**
   * FigAI.fallbackOps({doc, instruction, anchors, selection}) -> {ops, explanation}
   * Deterministic Chinese-instruction parser. Covered patterns:
   *   移动/移到 <目标> 到/往 左上|右上|左下|右下|居中   -> move
   *   字号 <n>(pt|磅)                                   -> set_style fontSizePt
   *   加粗 / 斜体 / 左对齐 / 居中 / 右对齐               -> set_style
   *   换成 <palette> 配色                               -> recolor
   *   颜色改为 <颜色名|#hex>                            -> set_color
   *   删除 <目标>                                       -> delete
   *   编组 <目标>                                       -> group
   *   (顶部/底部/垂直/水平)对齐 <目标>                   -> align
   *   <目标> 可为锚点 label、元素 id/name、全体/所有文本
   */
  FigAI.fallbackOps = function (opts) {
    opts = opts || {};
    requireDoc(opts.doc, "fallbackOps");
    requireInstruction(opts.instruction, "fallbackOps");
    var doc = opts.doc;
    var instruction = String(opts.instruction);
    var t = findTargets(doc, instruction, opts.anchors, opts.selection);
    var targets = t.targets;

    // --- 换成 <palette> 配色 -> recolor ---
    var mPal = instruction.match(/(?:换成|换为|使用|采用|应用)\s*(.+?)\s*(?:配色|色板|调色板)/);
    if (mPal) {
      var pid = matchPalette(mPal[1]);
      if (pid) {
        return {
          ops: [{ op: "recolor", palette_id: pid, reason: "离线模式：按指令切换配色为 " + pid }],
          explanation: "离线模式：已把配色切换为「" + pid + "」"
            + (global.FigPalette && global.FigPalette.get && global.FigPalette.get(pid)
              ? "（" + global.FigPalette.get(pid).name + "）" : "") + "。"
        };
      }
      // palette unresolvable: keep trying other patterns
    }

    // --- 移动/移到 <目标> 到/往 <方向> -> move ---
    var mDir = instruction.match(/(左上|右上|左下|右下|居中|中间|中心|正中)/);
    var mVerb = instruction.match(/移动|移到|移至|移往|挪到|挪至|放到|放置到|摆到/);
    if (mVerb && mDir) {
      if (!targets) return noTargetResult("移动到" + mDir[1]);
      var ids = resolveTargetIds(doc, targets, opts.anchors);
      if (!ids.length) {
        return { ops: [], explanation: "离线模式：目标锚点内没有可移动的元素，请确认锚点位置或直接指定元素 id。" };
      }
      var canvas = canvasSize(doc);
      var byId = elementMap(doc);
      var moveOps = [];
      for (var i = 0; i < ids.length; i++) {
        var b = elementBbox(byId[ids[i]], byId, {});
        if (!b) continue;
        var x, y;
        if (mDir[1] === "居中" || mDir[1] === "中间" || mDir[1] === "中心" || mDir[1] === "正中") {
          x = (canvas.w - b.w) / 2;
          y = (canvas.h - b.h) / 2;
        } else {
          x = mDir[1].indexOf("左") >= 0 ? 0 : canvas.w - b.w;
          y = mDir[1].indexOf("上") >= 0 ? 0 : canvas.h - b.h;
        }
        moveOps.push({
          op: "move", targets: [ids[i]],
          x: Math.max(0, round2(x)), y: Math.max(0, round2(y)),
          reason: "离线模式：按指令把元素移动到画布" + mDir[1]
        });
      }
      if (!moveOps.length) {
        return { ops: [], explanation: "离线模式：目标元素缺少 transform，无法计算移动位置。" };
      }
      return okResult(moveOps, "移动到" + mDir[1], ids.length);
    }

    // --- 字号 <n>(pt|磅) -> set_style fontSizePt ---
    var mFont = instruction.match(/(?:字号|字体大小)[^0-9.]{0,4}(\d+(?:\.\d+)?)\s*(?:pt|PT|磅)?/);
    if (mFont) {
      var pt = parseFloat(mFont[1]);
      if (!(pt > 0) || pt > 200) {
        return { ops: [], explanation: "离线模式：字号 " + mFont[1] + " 不在合理范围（0–200pt），未生成操作。" };
      }
      var stTargets = targets || [{ kind: "type", type: "text" }];
      return okResult([{
        op: "set_style", targets: stTargets, style: { fontSizePt: pt },
        reason: "离线模式：按指令设置字号 " + pt + "pt"
      }], "字号 " + pt + "pt", 1);
    }

    // --- 删除 <目标> -> delete ---
    // "去掉加粗/斜体/边框" are style or color phrasings, not deletions.
    var mDel = /删除|删掉|移除|清除/.test(instruction) ||
      (/去掉/.test(instruction) && !/加粗|粗体|斜体|边框|描边|填充/.test(instruction));
    if (mDel) {
      if (!targets) return noTargetResult("删除");
      return okResult([{ op: "delete", targets: targets, reason: "离线模式：按指令删除目标" }], "删除", targets.length);
    }

    // --- 编组 <目标> -> group ---
    if (/编组|打组|成组|合并(?:为|成)?(?:一)?组|组合(?:为|成)?(?:一)?组/.test(instruction)) {
      if (!targets) return noTargetResult("编组");
      return okResult([{ op: "group", targets: targets, reason: "离线模式：按指令编组目标" }], "编组", targets.length);
    }

    // --- (方向)对齐 <目标> -> align（文本目标且为左右居中时转 set_style.textAlign）---
    if (/对齐/.test(instruction)) {
      var am = instruction.match(/(垂直|水平|顶部?|顶端|底[部端]?|上|下|左|右)?\s*对齐/);
      var mode = "center";
      var word = am && am[1] ? am[1] : "";
      if (word === "垂直") mode = "middle";
      else if (word === "水平") mode = "center";
      else if (word === "顶" || word === "顶部" || word === "顶端" || word === "上") mode = "top";
      else if (word === "底" || word === "底部" || word === "底端" || word === "下") mode = "bottom";
      else if (word === "左") mode = "left";
      else if (word === "右") mode = "right";
      var alTargets = targets;
      var alIds = alTargets ? resolveTargetIds(doc, alTargets, opts.anchors) : [];
      var byId2 = elementMap(doc);
      var allText = alIds.length > 0 && alIds.every(function (id) { return byId2[id] && byId2[id].type === "text"; });
      var selectorText = alTargets && alTargets.length === 1 && isObj(alTargets[0]) &&
        alTargets[0].kind === "type" && alTargets[0].type === "text";
      var wantTextAlign = (mode === "left" || mode === "right" || mode === "center") &&
        (allText || (selectorText && !alIds.length) || !alTargets);
      if (wantTextAlign) {
        if (!alTargets) alTargets = [{ kind: "type", type: "text" }];
        return okResult([{
          op: "set_style", targets: alTargets, style: { textAlign: mode },
          reason: "离线模式：按指令设置文本" + (mode === "left" ? "左" : mode === "right" ? "右" : "居中") + "对齐"
        }], "文字" + word + "对齐", alIds.length || 1);
      }
      if (!alTargets) alTargets = [{ kind: "type", type: "text" }];
      return okResult([{
        op: "align", targets: alTargets, mode: mode,
        reason: "离线模式：按指令对齐目标（" + mode + "）"
      }], (word || "默认") + "对齐", alIds.length || alTargets.length);
    }

    // --- 加粗 / 斜体 / 左对齐 / 居中 / 右对齐 -> set_style ---
    var stylePatch = null;
    var bits = [];
    if (/(取消|去掉|解除|不要)\s*.{0,6}?(加粗|粗体)/.test(instruction)) {
      stylePatch = stylePatch || {};
      stylePatch.fontWeight = "normal";
      bits.push("取消加粗");
    } else if (/加粗|粗体|bold/i.test(instruction)) {
      stylePatch = stylePatch || {};
      stylePatch.fontWeight = "bold";
      bits.push("加粗");
    }
    if (/(取消|去掉|解除|不要)\s*.{0,6}?(斜体|倾斜)/.test(instruction) || /正体/.test(instruction)) {
      stylePatch = stylePatch || {};
      stylePatch.fontStyle = "normal";
      bits.push("取消斜体");
    } else if (/斜体|italic/i.test(instruction)) {
      stylePatch = stylePatch || {};
      stylePatch.fontStyle = "italic";
      bits.push("斜体");
    }
    if (/左对齐|靠左|居左/.test(instruction)) {
      stylePatch = stylePatch || {};
      stylePatch.textAlign = "left";
      bits.push("左对齐");
    } else if (/右对齐|靠右|居右/.test(instruction)) {
      stylePatch = stylePatch || {};
      stylePatch.textAlign = "right";
      bits.push("右对齐");
    } else if (/居中|中间/.test(instruction)) {
      stylePatch = stylePatch || {};
      stylePatch.textAlign = "center";
      bits.push("文字居中");
    }
    if (stylePatch) {
      var sTargets = targets || [{ kind: "type", type: "text" }];
      return okResult([{
        op: "set_style", targets: sTargets, style: stylePatch,
        reason: "离线模式：按指令设置样式（" + bits.join("、") + "）"
      }], bits.join("、"), 1);
    }

    // --- 颜色改为 <颜色名|#hex> -> set_color ---
    if (/颜色|填充|边框|描边|改成|换(?:为|成)|变为|设为|涂成|染成/.test(instruction)) {
      var isStroke = /边框|描边|轮廓/.test(instruction);
      var mColor = instruction.match(
        /(?:颜色|填充|边框|描边|轮廓)?\s*(?:改为|换成|换为|变为|设为|设置成|改成|调成|涂成|染成|用|为)\s*([^\s,，。;；]+)/
      );
      var color = mColor ? matchColor(mColor[1]) : null;
      if (color) {
        var cTargets = targets || (Array.isArray(opts.selection) && opts.selection.length
          ? opts.selection.slice() : [{ kind: "all" }]);
        var cOp = { op: "set_color", targets: cTargets, reason: "离线模式：按指令修改颜色为 " + color };
        if (isStroke) cOp.stroke = color; else cOp.color = color;
        return okResult([cOp], "颜色改为 " + color, 1);
      }
    }

    return {
      ops: [],
      explanation: "离线模式无法理解该指令，请补充关键词。支持：把<目标>移动/移到 左上|右上|左下|右下|居中、字号 <n>(pt)、加粗、斜体、左对齐/居中/右对齐、顶部/底部/垂直/水平对齐、换成<配色名或id>配色、颜色改为<颜色名|#hex>、删除<目标>、编组<目标>；目标可用锚点标签（如 a、(a)、标题）、元素 id 或「全体/所有文本」。"
    };
  };

  // ------------------------------------------------------------------
  // Offline fallback — fallbackReview
  // ------------------------------------------------------------------

  // minimal color utils (no FigPalette dependency)
  function hexToRgbLocal(hex) {
    var s = String(hex || "").trim();
    var m = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function luminanceLocal(hex) {
    var rgb = hexToRgbLocal(hex);
    if (!rgb) return null;
    var f = function (c) {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
  }

  function contrastRatioLocal(a, b) {
    var la = luminanceLocal(a), lb = luminanceLocal(b);
    if (la === null || lb === null) return null;
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  function isNeutralFillLocal(hex) {
    var s = String(hex == null ? "" : hex).trim().toLowerCase();
    if (!s || s === "none" || s === "transparent") return true;
    var rgb = hexToRgbLocal(s);
    if (!rgb) return true;
    var max = Math.max(rgb.r, rgb.g, rgb.b), min = Math.min(rgb.r, rgb.g, rgb.b);
    return max - min <= 24; // grays / white / black
  }

  function resolvePreset(doc, journalPreset) {
    if (journalPreset && typeof journalPreset === "object") return journalPreset;
    var presets = global.FigPresets;
    var pid = doc && doc.canvas && doc.canvas.journal_preset_id;
    if (presets && typeof presets.journal === "function" && pid) {
      try { return presets.journal(pid); } catch (e) { return null; }
    }
    return null;
  }

  var CHECK_SEVERITY = {
    FONT_TOO_SMALL: "high",
    WIDTH_MISMATCH: "medium",
    DPI_TOO_LOW: "high",
    HEIGHT_TOO_TALL: "medium",
    PANEL_OVERFLOW: "medium",
    LOW_CONTRAST: "medium",
    NO_ANCHOR: "low"
  };

  var CHECK_SUGGESTION = {
    FONT_TOO_SMALL: "把该元素字号提高到期刊最小字号以上",
    WIDTH_MISMATCH: "套用期刊预设调整画布宽度",
    DPI_TOO_LOW: "把导出 dpi 提高到期刊最低要求",
    HEIGHT_TOO_TALL: "压缩内容高度或改用整页版式",
    PANEL_OVERFLOW: "把面板内元素收回面板内边距范围",
    LOW_CONTRAST: "换用与背景对比更强的颜色",
    NO_ANCHOR: "用选框工具为关键区域添加锚点，便于 AI 定位"
  };

  /**
   * FigAI.fallbackReview({doc, journalPreset}) -> {items, explanation}
   * Rules: 字号过小 / 无锚点 / 无标题 / 配色中性缺失 / 元素越界 /
   *        对比度不足 / 面板未对齐 (+ FigPresets.check warnings when available,
   *        and journal width/height/dpi rules when a preset is given).
   */
  FigAI.fallbackReview = function (opts) {
    opts = opts || {};
    requireDoc(opts.doc, "fallbackReview");
    var doc = opts.doc;
    var preset = resolvePreset(doc, opts.journalPreset);
    var canvas = canvasSize(doc);
    var minFont = preset && typeof preset.min_font_pt === "number" ? preset.min_font_pt : 5;
    var items = [];
    var seen = {};

    var push = function (severity, target, code, issue, suggestion, op) {
      var key = code + "|" + target;
      if (seen[key]) return;
      seen[key] = true;
      items.push({ severity: severity, target: target, issue: issue, suggestion: suggestion, op: op || null });
    };

    var docTarget = (doc && doc.id) ? doc.id : "doc";
    var byId = elementMap(doc);
    var els = doc.elements || [];
    var hasPresetsCheck = !!(global.FigPresets && typeof global.FigPresets.check === "function");

    // 1) FigPresets.check warnings (authoritative when available)
    if (hasPresetsCheck) {
      var cr = null;
      try { cr = global.FigPresets.check(doc); } catch (e) { cr = null; }
      if (cr && Array.isArray(cr.warnings)) {
        cr.warnings.forEach(function (w) {
          var code = w.code || "UNKNOWN";
          var target = w.element_id || docTarget;
          var op = null;
          if (code === "FONT_TOO_SMALL" && w.element_id) {
            op = { op: "set_style", targets: [w.element_id], style: { fontSizePt: minFont },
              reason: "离线审阅：字号低于下限 " + minFont + "pt" };
          } else if (code === "DPI_TOO_LOW" && preset && preset.dpi_min) {
            op = { op: "set_canvas", canvas: { dpi: preset.dpi_min }, reason: "离线审阅：dpi 低于期刊下限" };
          } else if (code === "WIDTH_MISMATCH" && preset && preset.id) {
            op = { op: "apply_journal", journal_preset_id: preset.id, reason: "离线审阅：套用期刊预设修正版面" };
          } else if (code === "LOW_CONTRAST" && w.element_id) {
            op = { op: "set_color", targets: [w.element_id], color: "#333333",
              reason: "离线审阅：提高与背景的对比度" };
          }
          push(CHECK_SEVERITY[code] || "medium", target, code,
            oneLine(w.message) || code, CHECK_SUGGESTION[code] || "按期刊规范修正", op);
        });
      }
    } else {
      // local re-implementation of the check codes
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el || el.type !== "text") continue;
        var fs = el.style && typeof el.style.fontSizePt === "number" ? el.style.fontSizePt : null;
        if (fs !== null && fs < minFont) {
          push(fs < minFont * 0.8 ? "high" : "medium", el.id, "FONT_TOO_SMALL",
            "文本字号 " + fs + "pt 低于下限 " + minFont + "pt",
            CHECK_SUGGESTION.FONT_TOO_SMALL,
            { op: "set_style", targets: [el.id], style: { fontSizePt: minFont },
              reason: "离线审阅：字号低于下限 " + minFont + "pt" });
        }
      }
      if (preset) {
        if (typeof preset.width_mm === "number" && Math.abs(canvas.w - preset.width_mm) > 0.5) {
          push("medium", docTarget, "WIDTH_MISMATCH",
            "画布宽度 " + canvas.w + "mm 与期刊预设 " + preset.width_mm + "mm 不一致",
            CHECK_SUGGESTION.WIDTH_MISMATCH,
            preset.id ? { op: "apply_journal", journal_preset_id: preset.id,
              reason: "离线审阅：套用期刊预设修正版面" } : null);
        }
        if (typeof preset.height_mm === "number" && canvas.h > preset.height_mm) {
          push("medium", docTarget, "HEIGHT_TOO_TALL",
            "画布高度 " + canvas.h + "mm 超过期刊推荐上限 " + preset.height_mm + "mm",
            CHECK_SUGGESTION.HEIGHT_TOO_TALL, null);
        }
        if (typeof preset.dpi_min === "number" &&
            typeof doc.canvas.dpi === "number" && doc.canvas.dpi < preset.dpi_min) {
          push("high", docTarget, "DPI_TOO_LOW",
            "画布 dpi " + doc.canvas.dpi + " 低于期刊最低要求 " + preset.dpi_min,
            CHECK_SUGGESTION.DPI_TOO_LOW,
            { op: "set_canvas", canvas: { dpi: preset.dpi_min }, reason: "离线审阅：dpi 低于期刊下限" });
        }
      }
      if (!doc.anchors || !doc.anchors.length) {
        push("low", docTarget, "NO_ANCHOR", "文档没有任何锚点，AI 无法按区域定位内容",
          CHECK_SUGGESTION.NO_ANCHOR, null);
      }
      for (var j = 0; j < els.length; j++) {
        var el2 = els[j];
        if (!el2 || !el2.style || el2.style.panelRelative !== true) continue;
        var tr = el2.transform || {};
        if (tr.x < 0 || tr.y < 0 || tr.x + (tr.w || 0) > 1 || tr.y + (tr.h || 0) > 1) {
          push("medium", el2.id, "PANEL_OVERFLOW",
            "面板相对坐标越界（" + [tr.x, tr.y, tr.w, tr.h].map(round2).join(",") + "）",
            CHECK_SUGGESTION.PANEL_OVERFLOW, null);
        }
      }
      var bg = doc.canvas && doc.canvas.background ? doc.canvas.background : "#FFFFFF";
      for (var k = 0; k < els.length; k++) {
        var el3 = els[k];
        if (!el3 || !el3.style || el3.style.fill == null) continue;
        if (isNeutralFillLocal(el3.style.fill)) continue;
        var ratio = contrastRatioLocal(el3.style.fill, bg);
        if (ratio !== null && ratio < 2.5) {
          push("medium", el3.id, "LOW_CONTRAST",
            "元素填充色与画布背景对比度不足（比值 " + round2(ratio) + "）",
            CHECK_SUGGESTION.LOW_CONTRAST,
            { op: "set_color", targets: [el3.id], color: "#333333",
              reason: "离线审阅：提高与背景的对比度" });
        }
      }
    }

    // 2) 元素越界（超出画布边界）— checked regardless of FigPresets availability
    for (var oi = 0; oi < els.length; oi++) {
      var oel = els[oi];
      if (!oel || !oel.transform) continue;
      var ob = elementBbox(oel, byId, {});
      if (!ob) continue;
      if (ob.x < -0.01 || ob.y < -0.01 || ob.x + ob.w > canvas.w + 0.01 || ob.y + ob.h > canvas.h + 0.01) {
        var nx = Math.max(0, Math.min(ob.x, canvas.w - ob.w));
        var ny = Math.max(0, Math.min(ob.y, canvas.h - ob.h));
        push("medium", oel.id, "OUT_OF_CANVAS",
          "元素超出画布边界（bbox " + [ob.x, ob.y, ob.w, ob.h].map(round2).join(",") +
          "，画布 " + canvas.w + "x" + canvas.h + "mm）",
          "把元素移回画布范围内",
          { op: "move", targets: [oel.id], x: round2(nx), y: round2(ny),
            reason: "离线审阅：把越界元素移回画布内" });
      }
    }

    // 3) 无标题
    var hasText = els.some(function (e) { return e && e.type === "text" && e.text && String(e.text).trim(); });
    if (!hasText) {
      push("medium", docTarget, "NO_TITLE",
        "文档内没有任何文本元素，缺少标题或标注",
        "添加主标题文本元素",
        {
          op: "add_element",
          element: {
            type: "text",
            transform: { x: 2, y: 2, w: Math.max(20, round2(canvas.w * 0.6)), h: 8 },
            text: "标题",
            style: { fontSizePt: (preset && preset.base_font_pt) || 7, fontWeight: "bold" }
          },
          reason: "离线审阅：补充标题文本"
        });
    }

    // 4) 配色中性缺失
    var hasNonNeutral = els.some(function (e) {
      return e && e.style && e.style.fill != null && !isNeutralFillLocal(e.style.fill);
    });
    if (els.length && !hasNonNeutral) {
      push("low", docTarget, "NO_COLOR",
        "所有元素填充均为中性色（白/黑/灰/无填充），缺少信息色",
        "换成一套学术配色（如 npg）",
        { op: "recolor", palette_id: "npg", reason: "离线审阅：为文档引入非中性配色" });
    }

    // 5) 面板未对齐
    var panels = els.filter(function (e) { return e && e.type === "panel"; });
    if (panels.length >= 2) {
      var ws = panels.map(function (p) { return Number(p.transform && p.transform.w) || 0; });
      var hs = panels.map(function (p) { return Number(p.transform && p.transform.h) || 0; });
      var dw = Math.max.apply(null, ws) - Math.min.apply(null, ws);
      var dh = Math.max.apply(null, hs) - Math.min.apply(null, hs);
      if (dw > 1.5 || dh > 1.5) {
        var ids = panels.map(function (p) { return p.id; });
        push("low", ids[0], "PANEL_MISALIGNED",
          "各面板尺寸不一致（宽度差 " + round2(dw) + "mm，高度差 " + round2(dh) + "mm）",
          "统一各面板宽高（复合图面板建议对齐，容差 1.5pt）",
          { op: "align", targets: ids, mode: "top", reason: "离线审阅：对齐面板顶边" });
      }
    }

    var high = items.filter(function (x) { return x.severity === "high"; }).length;
    var mid = items.filter(function (x) { return x.severity === "medium"; }).length;
    var low = items.filter(function (x) { return x.severity === "low"; }).length;
    var explanation = items.length
      ? "离线审阅：共 " + items.length + " 条意见（高 " + high + " / 中 " + mid + " / 低 " + low + "）。"
      : "离线审阅：未发现问题。";
    return { items: items, explanation: explanation };
  };

  // ------------------------------------------------------------------
  // Export
  // ------------------------------------------------------------------

  (typeof globalThis !== "undefined" ? globalThis : this).FigAI = FigAI;
})(typeof globalThis !== "undefined" ? globalThis : this);
