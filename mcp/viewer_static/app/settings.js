/*
 * settings.js — v1-web-app settings panel.
 *
 * Contract (APP-API.md):
 *   Settings.mount(panelEl)              apiKey (localStorage only) / baseUrl / model /
 *                                        proxyUrl / canvas default DPI
 *   Settings.apiKey() / Settings.setApiKey(k)
 *                                        setApiKey re-applies FigAI.config(...) and
 *                                        refreshes the AI panel state
 * Additive helpers (used by main.js / topbar):
 *   Settings.open()                      modal dialog via Ui.modal (topbar "设置" button)
 *   Settings.values()                    snapshot of all stored values
 *   Settings.defaultDpi()                canvas DPI used for newly created documents
 *   Settings.setDefaultDpi(v)            validates and persists, throws Chinese Error
 *   Settings.testConnection()            -> Promise<string>, sends one tiny real request
 *   Settings.bridgeMode()                -> true when FigAI is wired to the DSH llm 桥
 *   Settings.lastModelCall()             -> 最近一次真实 FigAI.chat 记录
 *                                        {source:"bridge"|"direct", ok, status, message, at}
 *                                        （由本模块包裹 FigAI.chat 记录，请求/返回原样透传）
 * Additive progress helpers (真实模型阶段追踪，绝不伪造百分比):
 *   Settings.reserveRequestId(ns)        -> string  为即将发出的一次模型请求登记
 *                                        request_id（ns-… 保证多次请求不互相覆盖）；
 *                                        只在本机桥路径的请求 body 上附加值，官方
 *                                        DeepSeek 请求体不携带任何额外参数
 *   Settings.releaseRequestId(id)        未被实际注入时撤销登记（离线/直连路径）
 */
(function (global) {
    "use strict";

    var LS_KEY = "figai.settings.v1";
    var DPI_MIN = 72;
    var DPI_MAX = 2400;
    var TEST_TIMEOUT_MS = 20000;

    var state = { apiKey: "", baseUrl: "", model: "", proxyUrl: "", defaultDpi: 300 };
    var statusEl = null;
    var testOutEl = null;
    // 由 DSH Host 插件启动时，viewer.py 会通过 /api/ai/health 暴露本机 llm 桥；
    // 检测到后窗口右栏 AI 面板走该桥，实现「零 key 复用 DSH DeepSeek」。
    var harnessBridgeUrl = "";
    // 最近一次真实 FigAI.chat 的结果记录（含失败原因）。内核 lib/ai.js 的
    // requestOps/requestReview 会把网络/HTTP 错误静默吞掉并回退离线，
    // 这里只做旁路记录，供 AI 面板在回退后如实展示「模型请求失败」。
    var lastModelCallRec = null;
    // request_id 登记：AiPanel 在发起一次模型请求前 reserve，fetch 钩子只在
    // 检测到「本机桥 chat 路径」的 POST 时把该 id 附加进 body（注入即消费）。
    // 一次请求一个 id，多组拆分（多编号）各拿各的 id，进度互不覆盖。
    var bridgeRequestId = null;
    var bridgeReqSeq = 0;

    function warn(text) {
        console.warn("[settings] " + text);
    }

    function msgOf(err) {
        return (err && err.message) ? err.message : String(err);
    }

    function figAi() {
        return global.FigAI || null;
    }

    function defaultBaseUrl() {
        var a = figAi();
        return (a && a.DEFAULT_BASE_URL) || "https://api.deepseek.com";
    }

    function defaultModel() {
        var a = figAi();
        return (a && a.DEFAULT_MODEL) || "deepseek-flash";
    }

    // ----------------------------------------------------------- persistence

    function loadPersisted() {
        try {
            var raw = global.localStorage ? global.localStorage.getItem(LS_KEY) : null;
            if (!raw) return;
            var obj = JSON.parse(raw);
            if (!obj || typeof obj !== "object") return;
            if (typeof obj.apiKey === "string") state.apiKey = obj.apiKey;
            if (typeof obj.baseUrl === "string") state.baseUrl = obj.baseUrl;
            if (typeof obj.model === "string") state.model = obj.model;
            if (typeof obj.proxyUrl === "string") state.proxyUrl = obj.proxyUrl;
            if (typeof obj.defaultDpi === "number" && isFinite(obj.defaultDpi) &&
                obj.defaultDpi >= DPI_MIN && obj.defaultDpi <= DPI_MAX) {
                state.defaultDpi = Math.round(obj.defaultDpi);
            }
        } catch (err) {
            // Unreadable storage: keep in-memory defaults.
            warn("读取本地设置失败：" + msgOf(err));
        }
    }

    function persist() {
        try {
            if (!global.localStorage) return;
            global.localStorage.setItem(LS_KEY, JSON.stringify(state));
        } catch (err) {
            // Storage may be unavailable (privacy mode, file:// quota...).
            warn("设置写入 localStorage 失败：" + msgOf(err));
        }
    }

    // ------------------------------------------------------------- AI config

    function applyToFigAI() {
        var a = figAi();
        if (!a || typeof a.config !== "function") return;
        var useBridge = !state.apiKey && !!harnessBridgeUrl;
        try {
            a.config({
                // 走 harness 桥时填占位 key（非空 → enabled()===true），proxyUrl 替换请求 URL。
                apiKey: useBridge ? "harness" : state.apiKey, // "" clears the key -> enabled() === false
                baseUrl: state.baseUrl || defaultBaseUrl(),
                model: state.model || defaultModel(),
                proxyUrl: useBridge ? harnessBridgeUrl : (state.proxyUrl || "") // "" clears the proxy
            });
        } catch (err) {
            warn("FigAI.config 失败：" + msgOf(err));
        }
    }

    // 当前配置是否走 DSH llm 桥（与 applyToFigAI 的 useBridge 判定一致）。
    function bridgeMode() {
        return !state.apiKey && !!harnessBridgeUrl;
    }

    function lastModelCall() {
        return lastModelCallRec;
    }

    // 包裹 FigAI.chat：请求参数与返回值 {text, usage, raw} 原样透传，
    // 失败时原样 rethrow（不改变内核语义），仅旁路记录最近一次真实调用，
    // 供 AiPanel 在 requestOps 静默回退后如实展示桥/直连的失败原因。
    function wrapFigAIChat() {
        var a = figAi();
        if (!a || typeof a.chat !== "function" || a.__viewerChatWrapped) return;
        var orig = a.chat;
        var wrapped = function (messages, opts) {
            var source = bridgeMode() ? "bridge" : "direct";
            var t0 = Date.now();
            return orig.call(a, messages, opts).then(function (res) {
                lastModelCallRec = {
                    source: source, ok: true, status: 0, message: "", at: t0
                };
                return res;
            }, function (err) {
                lastModelCallRec = {
                    source: source, ok: false,
                    status: (err && typeof err.status === "number") ? err.status : 0,
                    message: describeChatError(err),
                    at: t0
                };
                throw err;
            });
        };
        try {
            Object.defineProperty(a, "__viewerChatWrapped", { value: true });
        } catch (err) {
            a.__viewerChatWrapped = true;
        }
        a.chat = wrapped;
    }

    // 人类可读失败描述：优先内核 explainError，再把响应体里的服务端
    // error 字段（如桥返回的「ctx.llm 未命中」）原样带出，不擅自改写结论。
    function describeChatError(err) {
        var text = explainErr(err);
        var body = err && typeof err.body === "string" ? err.body : "";
        if (body) {
            try {
                var j = JSON.parse(body);
                var e = j && (typeof j.error === "string" ? j.error
                    : (typeof j.message === "string" ? j.message : ""));
                if (e && e.trim()) text += "：" + e.trim();
            } catch (err2) {
                var snippet = body.trim().slice(0, 120);
                if (snippet) text += "：" + snippet;
            }
        }
        return text;
    }

    function notifyAiPanel() {
        var panel = global.AiPanel;
        if (!panel) return;
        var hooks = ["refreshStatus", "refresh", "updateMode"];
        for (var i = 0; i < hooks.length; i++) {
            if (typeof panel[hooks[i]] === "function") {
                try {
                    panel[hooks[i]]();
                    return;
                } catch (err) {
                    // Try the next known hook.
                }
            }
        }
        // No known refresh hook on AiPanel: it will pick the new mode up
        // through its own events; we surface the change in the status bar.
        pushStatus("AI 设置已更新：" + modeText());
    }

    function modeText() {
        var a = figAi();
        var enabled = !!(a && typeof a.enabled === "function" && a.enabled());
        if (!enabled) return "离线模式（未配置 API Key）";
        return bridgeMode()
            ? "模型模式（DSH 桥，零 key；连通性以真实请求为准）"
            : "模型模式（Key 已配置）";
    }

    function pushStatus(text, isError) {
        if (global.Ui && typeof global.Ui.toast === "function") {
            global.Ui.toast(text, { type: isError ? "error" : "info" });
            return;
        }
        if (!global.App || typeof global.App.status !== "function") return;
        if (isError && typeof global.App.error === "function") global.App.error(text);
        else global.App.status(text);
    }

    // ----------------------------------------------------------- public API

    function apiKey() {
        return state.apiKey;
    }

    function setApiKey(k) {
        if (k !== undefined && k !== null && typeof k !== "string") {
            throw new Error("API Key 必须为字符串");
        }
        state.apiKey = String(k || "").trim();
        persist();
        applyToFigAI();
        refreshStatusLine();
        notifyAiPanel();
        return state.apiKey;
    }

    function defaultDpi() {
        return state.defaultDpi;
    }

    function setDefaultDpi(v) {
        var n = typeof v === "string" ? parseFloat(v) : v;
        if (typeof n !== "number" || !isFinite(n)) {
            throw new Error("画布默认 DPI 必须为数字");
        }
        n = Math.round(n);
        if (n < DPI_MIN || n > DPI_MAX) {
            throw new Error("画布默认 DPI 需在 " + DPI_MIN + "–" + DPI_MAX + " 之间");
        }
        state.defaultDpi = n;
        persist();
        return n;
    }

    function values() {
        return {
            apiKey: state.apiKey,
            baseUrl: state.baseUrl,
            model: state.model,
            proxyUrl: state.proxyUrl,
            defaultDpi: state.defaultDpi
        };
    }

    // ------------------------------------------------------- test connection

    function explainErr(err) {
        var a = figAi();
        if (a && typeof a.explainError === "function") {
            try {
                return a.explainError(err);
            } catch (e2) {
                // Fall through to the raw message.
            }
        }
        return msgOf(err);
    }

    // Sends one minimal real request through FigAI.chat; resolves with a
    // human-readable success line or rejects with the actual error.
    function testConnection() {
        var a = figAi();
        if (!a || typeof a.chat !== "function") {
            return Promise.reject(new Error("AI 模块未加载（lib/ai.js）"));
        }
        if (!(a && typeof a.enabled === "function" && a.enabled())) {
            return Promise.reject(new Error(
                "AI 未启用：请先在设置里填写 API Key，或由 DSH 插件启动以复用其 DeepSeek"));
        }
        var t0 = Date.now();
        return a.chat(
            [
                { role: "system", content: "你是连通性测试助手。" },
                { role: "user", content: "只回复两个字母：OK" }
            ],
            { json: false, timeoutMs: TEST_TIMEOUT_MS }
        ).then(function (res) {
            var ms = Date.now() - t0;
            var model = state.model || defaultModel();
            var tokens = (res && res.usage && res.usage.total_tokens != null)
                ? "，tokens " + res.usage.total_tokens
                : "";
            var text = (res && res.text) ? String(res.text).trim().slice(0, 80) : "";
            return "连接成功（" + ms + "ms，模型 " + model + tokens + "），回复：" + (text || "（空）");
        });
    }

    // ------------------------------------------------------------- DOM utils

    // Minimal element builder so the form works even if Ui.h is absent.
    function h(tag, attrs, children) {
        var el = document.createElement(tag);
        if (attrs) {
            for (var k in attrs) {
                if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
                if (k === "style") el.setAttribute("style", attrs[k]);
                else if (k === "class") el.className = attrs[k];
                else el.setAttribute(k, attrs[k]);
            }
        }
        (children || []).forEach(function (c) {
            if (c === null || c === undefined) return;
            el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
        });
        return el;
    }

    function row(labelText, control, hintText) {
        var wrap = h("div", { style: "margin:0 0 10px 0" }, [
            h("label", { style: "display:block;font-size:12px;color:#555;margin-bottom:3px" }, [labelText]),
            control
        ]);
        if (hintText) {
            wrap.appendChild(h("div", { style: "font-size:11px;color:#999;margin-top:2px" }, [hintText]));
        }
        return wrap;
    }

    function textInput(value, placeholder, onChange, maxLength) {
        var inp = h("input", {
            type: "text",
            autocomplete: "off",
            maxLength: String(maxLength || 2048),
            style: "width:100%;box-sizing:border-box;padding:7px 8px;font-size:13px;line-height:1.4"
        });
        inp.value = value || "";
        if (placeholder) inp.placeholder = placeholder;
        inp.addEventListener("change", function () { onChange(inp.value); });
        return inp;
    }

    function apiKeyControl() {
        var inp = h("input", {
            type: "password",
            autocomplete: "new-password",
            placeholder: "sk-…",
            maxLength: "512",
            style: "width:100%;box-sizing:border-box;padding:7px 8px;font-size:13px"
        });
        inp.value = state.apiKey;
        var show = h("input", { type: "checkbox" });
        show.addEventListener("change", function () {
            inp.type = show.checked ? "text" : "password";
        });
        inp.addEventListener("change", function () {
            try {
                setApiKey(inp.value);
                inp.value = state.apiKey;
                pushStatus("API Key 已保存（仅存本机 localStorage）");
            } catch (err) {
                pushStatus(msgOf(err), true);
            }
        });
        return h("div", { style: "display:flex;gap:6px;align-items:center" }, [
            h("div", { style: "flex:1" }, [inp]),
            h("label", { style: "font-size:12px;color:#555;white-space:nowrap" }, [show, " 显示"])
        ]);
    }

    function plainChange(key, label) {
        return function (value) {
            state[key] = String(value || "").trim();
            persist();
            applyToFigAI();
            refreshStatusLine();
            notifyAiPanel();
            pushStatus("设置已保存：" + label);
        };
    }

    function dpiControl() {
        var inp = h("input", {
            type: "number",
            min: String(DPI_MIN),
            max: String(DPI_MAX),
            step: "1",
            style: "width:120px;padding:4px 6px;font-size:13px"
        });
        inp.value = String(state.defaultDpi);
        inp.addEventListener("change", function () {
            try {
                setDefaultDpi(inp.value);
                pushStatus("新建文档默认 DPI 已保存：" + state.defaultDpi);
            } catch (err) {
                pushStatus(msgOf(err), true);
            }
            inp.value = String(state.defaultDpi);
        });
        var btn = h("button", {
            type: "button",
            style: "margin-left:8px;padding:4px 10px;font-size:12px;cursor:pointer"
        }, ["应用到当前文档"]);
        btn.addEventListener("click", function () {
            try {
                if (!global.App || typeof global.App.commit !== "function") {
                    throw new Error("App 模块未就绪，无法修改当前文档");
                }
                var r = global.App.commit(
                    [{ op: "set_canvas", canvas: { dpi: state.defaultDpi } }],
                    { label: "设置画布 DPI 为 " + state.defaultDpi, source: "user" }
                );
                if (r && typeof r.catch === "function") {
                    r.catch(function (err) { pushStatus(msgOf(err), true); });
                } else {
                    pushStatus("当前文档 DPI 已设为 " + state.defaultDpi);
                }
            } catch (err) {
                pushStatus(msgOf(err), true);
            }
        });
        return h("div", { style: "display:flex;align-items:center" }, [inp, btn]);
    }

    function validateDimensions(width, height) {
        var w = typeof width === "number" ? width : Number(width);
        var h = typeof height === "number" ? height : Number(height);
        if (!isFinite(w) || !isFinite(h) || w < 1 || h < 1) {
            throw new Error("画布宽度和高度必须是 ≥1mm 的有效数字");
        }
        if (w > 1000 || h > 1000) {
            throw new Error("为避免超大画布误操作，单边不能超过 1000mm");
        }
        return { w: w, h: h };
    }

    function canvasOps(doc, dimensions, fitContent) {
        var c = (doc && doc.canvas) || {};
        var oldW = Number(c.width_mm) || 120, oldH = Number(c.height_mm) || 90;
        var ops = [{ op: "set_canvas", canvas: {
            width_mm: dimensions.w, height_mm: dimensions.h
        } }];
        if (!fitContent) return ops;
        var sx = dimensions.w / oldW, sy = dimensions.h / oldH;
        var byId = Object.create(null);
        (doc.elements || []).forEach(function (el) {
            if (el && el.id) byId[el.id] = el;
        });
        function ancestorDepth(el) {
            var depth = 0, current = el, seen = Object.create(null);
            while (current && current.parent_id && byId[current.parent_id] && !seen[current.id]) {
                seen[current.id] = true;
                current = byId[current.parent_id];
                depth += 1;
            }
            return depth;
        }
        var targets = [];
        (doc.elements || []).forEach(function (el, index) {
            if (!el || !el.transform || (el.style && el.style.panelRelative === true)) return;
            targets.push({ el: el, index: index, depth: ancestorDepth(el) });
        });
        targets.sort(function (a, b) {
            return (a.depth - b.depth) || (a.index - b.index);
        });
        targets.forEach(function (entry) {
            var el = entry.el, t = el.transform;
            var x = (Number(t.x) || 0) * sx, y = (Number(t.y) || 0) * sy;
            var w = (Number(t.w) || 0) * sx, h = (Number(t.h) || 0) * sy;
            if (Math.abs(w) < 0.1) w = w < 0 ? -0.1 : 0.1;
            if (Math.abs(h) < 0.1) h = h < 0 ? -0.1 : 0.1;
            ops.push({ op: "resize", targets: [el.id], w: Math.abs(w), h: Math.abs(h) });
            ops.push({ op: "move", targets: [el.id],
                x: w < 0 ? x + w : x, y: h < 0 ? y + h : y
            });
        });
        (doc.anchors || []).forEach(function (anchor) {
            if (!anchor || !anchor.bbox_mm) return;
            var b = anchor.bbox_mm;
            var box = { x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy };
            ops.push({ op: "update_anchor", anchor: {
                id: anchor.id, bbox_mm: box,
                bbox_norm: global.FigDoc.mmToNorm(box, {
                    width_mm: dimensions.w, height_mm: dimensions.h
                })
            } });
        });
        return ops;
    }

    function dimensionInput(key, value) {
        var inp = h("input", {
            type: "number", min: "1", max: "1000", step: "0.1",
            style: "width:84px;padding:4px 6px;font-size:13px"
        });
        inp.value = String(value);
        return inp;
    }

    function canvasSizeControl() {
        var canvas = global.App && global.App.canvas ? global.App.canvas() : {};
        var widthInput = dimensionInput("width", canvas.width_mm || 120);
        var heightInput = dimensionInput("height", canvas.height_mm || 90);
        var fit = h("input", { type: "checkbox", title: "按比例调整现有图形和编号选框" });
        fit.checked = true;
        var apply = h("button", {
            type: "button",
            style: "margin-left:8px;padding:4px 10px;font-size:12px;cursor:pointer"
        }, ["应用画布尺寸"]);
        apply.addEventListener("click", function () {
            try {
                if (!global.App || !global.App.doc || typeof global.App.commit !== "function") {
                    throw new Error("当前文档尚未就绪");
                }
                var dimensions = validateDimensions(widthInput.value, heightInput.value);
                var ops = canvasOps(global.App.doc, dimensions, fit.checked);
                Promise.resolve(global.App.commit(ops, {
                    label: "设置画布为 " + dimensions.w + " × " + dimensions.h + " mm",
                    source: "user"
                })).then(function (res) {
                    if (!res || !res.applied) throw new Error("画布尺寸校验未通过，未修改文档");
                    if (global.Editor && typeof global.Editor.fit === "function") global.Editor.fit();
                    pushStatus("画布已设为 " + dimensions.w + " × " + dimensions.h + " mm" +
                        (fit.checked ? "，图形与选框已等比调整" : "，保留原始元素布局"));
                }).catch(function (err) { pushStatus(msgOf(err), true); });
            } catch (err) {
                pushStatus(msgOf(err), true);
            }
        });
        return h("div", null, [
            h("div", { style: "display:flex;align-items:center;gap:4px;flex-wrap:wrap" }, [
                widthInput, h("span", { text: "×", style: "color:#666" }), heightInput,
                h("span", { text: "mm", style: "color:#666" }), apply
            ]),
            h("label", { style: "display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:#555" }, [
                fit, h("span", { text: "等比调整现有图形与编号选框（字号、原始数据和导出 DPI 不变）" })
            ])
        ]);
    }

    function refreshStatusLine() {
        // AI 面板已挂载时优先采用它的徽章文案（基于真实请求/探测结果），
        // 避免设置面板给出「模型已连接」这类未经真实请求验证的结论。
        var panel = global.AiPanel;
        var text = null;
        if (panel && typeof panel.statusText === "function") {
            try { text = panel.statusText(); } catch (err) { text = null; }
        }
        if (!text) text = modeText();
        if (statusEl) statusEl.textContent = "当前 AI 状态：" + text;
    }

    function testControl() {
        var btn = h("button", {
            id: "settings-test-connection",
            type: "button",
            style: "padding:6px 14px;font-size:13px;cursor:pointer"
        }, ["本地测试连接"]);
        testOutEl = h("div", {
            id: "settings-test-result", role: "status", "aria-live": "polite",
            style: "margin-top:8px;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;min-height:18px"
        });
        btn.addEventListener("click", function () {
            if (!testOutEl) return;
            btn.disabled = true;
            testOutEl.style.color = "#555";
            testOutEl.textContent = "本地实测中：向当前配置接口发送一条最小请求（最长 " +
                Math.round(TEST_TIMEOUT_MS / 1000) + " 秒）";
            testConnection().then(function (line) {
                testOutEl.style.color = "#1a7f37";
                testOutEl.textContent = "本地实测结果：" + line;
            }).catch(function (err) {
                var line = "本地实测连接失败：" + explainErr(err);
                testOutEl.style.color = "#c0392b";
                testOutEl.textContent = line;
                pushStatus(line, true);
            }).finally(function () {
                btn.disabled = false;
            });
        });
        return h("div", null, [btn, testOutEl]);
    }

    // ------------------------------------------------------------------ form

    function buildForm() {
        var root = h("div", { style: "padding:8px 10px;font-size:13px;max-width:640px;min-width:0" });
        root.appendChild(h("div", { style: "font-weight:bold;font-size:14px;margin:2px 0 8px" }, ["AI 连接（DeepSeek）"]));
        root.appendChild(h("div", {
            style: "padding:8px 10px;margin-bottom:12px;border:1px solid #bfdbfe;border-radius:6px;" +
                "background:#eff6ff;color:#1e3a5f;font-size:12px;line-height:1.55"
        }, ["DSH 复用优先（不需要单独填 key）：由 DSH 插件启动时自动使用本机 llm 桥。" +
            "不填写 API Key 即可复用；填写后才改为直连。是否可用以“本地测试连接”的真实请求结果为准。"]));
        root.appendChild(row("API Key（留空则优先复用 DSH；仅存本机 localStorage）", apiKeyControl()));
        root.appendChild(h("div", { style: "font-size:11px;color:#6b7280;line-height:1.5;margin:-4px 0 12px" },
            ["Key 不会随文档或工程文件导出，也不会显示在连接结果中。"]));
        statusEl = h("div", {
            id: "settings-ai-status",
            style: "font-size:12px;color:#4b5563;line-height:1.5;margin:2px 0 10px"
        });
        refreshStatusLine();
        root.appendChild(statusEl);
        root.appendChild(testControl());

        root.appendChild(h("div", { style: "font-weight:bold;font-size:14px;margin:18px 0 10px" }, ["画布"]));
        root.appendChild(row("当前画布宽高（mm）", canvasSizeControl(),
            "确认后才写入文档；保留现有宽高自定义和等比适配逻辑。"));
        root.appendChild(row("新建文档默认 DPI", dpiControl(),
            "DPI 与画布尺寸集中在这里；已打开的文档请用“应用到当前文档”。"));

        var advanced = h("details", {
            class: "settings-advanced",
            style: "margin-top:18px;padding:10px 12px;border:1px solid #dbe1e8;border-radius:6px;background:#fafbfc"
        });
        advanced.open = !!state.apiKey;
        advanced.appendChild(h("summary", {
            style: "cursor:pointer;font-weight:bold;font-size:13px;color:#374151;margin-bottom:10px"
        }, ["高级设置（Base URL / 模型 / 代理）"]));
        advanced.appendChild(h("div", { style: "font-size:11px;color:#6b7280;line-height:1.5;margin:8px 0 12px" },
            ["DSH 复用模式通常无需修改以下项目。更改后会立即重新应用 AI 配置。"]));
        advanced.appendChild(row("Base URL",
            textInput(state.baseUrl, defaultBaseUrl(), plainChange("baseUrl", "Base URL"), 2048)));
        advanced.appendChild(row("模型",
            textInput(state.model, defaultModel(), plainChange("model", "模型"), 128)));
        advanced.appendChild(row("代理地址 proxyUrl（可选）",
            textInput(state.proxyUrl, "留空则直连官方地址", plainChange("proxyUrl", "代理地址"), 2048)));
        root.appendChild(advanced);
        return root;
    }

    function mount(panelEl) {
        if (!panelEl) {
            warn("mount：未提供面板元素，跳过内嵌面板（可从顶栏“设置”按钮打开）");
            return;
        }
        panelEl.textContent = "";
        panelEl.appendChild(buildForm());
    }

    function open() {
        var ui = global.Ui;
        if (!ui || typeof ui.modal !== "function") {
            throw new Error("设置窗口需要 Ui.modal（app/ui.js）支持");
        }
        var host = document.createElement("div");
        var modal = ui.modal({
            title: "设置",
            body: host,
            actions: [{ label: "关闭", primary: true, onClick: function () { modal.close(); } }]
        });
        var dialog = modal.root && modal.root.querySelector(".ui-modal");
        var body = modal.root && modal.root.querySelector(".ui-modal-body");
        if (dialog) {
            dialog.style.width = "640px";
            dialog.style.maxWidth = "calc(100vw - 40px)";
            dialog.style.boxSizing = "border-box";
        }
        if (body) {
            body.style.maxHeight = "calc(100vh - 160px)";
            body.style.overflowY = "auto";
        }
        mount(host);
        return modal;
    }

    // ------------------------------------------------------ harness llm 桥

    // 启动时探测同源 /api/ai/health：若 viewer.py 已注入本机 llm 桥（DSH 启动），
    // 则把桥地址交给 FigAI，窗口右栏 AI 面板零 key 复用 DSH DeepSeek。
    function detectLocalBridge() {
        if (typeof fetch !== "function") return;
        fetch("/api/ai/health", { cache: "no-store" })
            .then(function (r) {
                if (!r || !r.ok) return null;
                return r.json();
            })
            .then(function (d) {
                if (!d || d.bridge !== true) return;
                harnessBridgeUrl = d.chatUrl || "/api/ai/chat";
                applyToFigAI();
                refreshStatusLine();
                notifyAiPanel();
                pushStatus("已检测到 DSH 模型桥，正在验证连通性…");
            })
            .catch(function () {
                // 非 DSH 宿主或桥未启动：保持原有 key/proxyUrl 设置路径。
            });
    }

    // ------------------------------------------------- bridge request 追踪

    // 为一次即将发出的模型请求登记 request_id；ns 用于区分请求类别
    // （如 "ask" / "review"），同一 ns 多次调用各得唯一 id。
    function reserveRequestId(ns) {
        bridgeReqSeq += 1;
        var id = String(ns || "req") + "-" + Date.now().toString(36) + "-" + bridgeReqSeq;
        bridgeRequestId = id;
        return id;
    }

    // 撤销登记（仅当尚未被 fetch 钩子注入；离线/直连路径在请求结束后调用）。
    function releaseRequestId(id) {
        if (bridgeRequestId === id) bridgeRequestId = null;
    }

    // 是否为本机桥 chat 路径（相对或绝对 URL 均可；忽略 query）。
    function isBridgeChatUrl(url) {
        if (!harnessBridgeUrl) return false;
        var u = String(url || "").split("?")[0];
        var b = String(harnessBridgeUrl).replace(/\/+$/, "");
        return u === b || u.indexOf(b) === u.length - b.length;
    }

    // fetch 钩子：只拦截「本机桥 chat 路径」的 POST，把已登记的 request_id
    // 附加进 JSON body（一次注入即消费）。绝不改动发往 DeepSeek 官方地址的
    // 请求——它们不会带任何本桥私有参数。任何异常都不影响原请求发出。
    function installBridgeChatFetchHook() {
        var g = typeof globalThis !== "undefined" ? globalThis : global;
        if (typeof g.fetch !== "function" || g.__figBridgeFetchHooked) return;
        var orig = g.fetch;
        var hooked = function (input, init) {
            try {
                var url = (typeof input === "string") ? input
                    : (input && typeof input.url === "string" ? input.url : "");
                var method = String((init && init.method) ||
                    (input && input.method) || "GET").toUpperCase();
                if (method === "POST" && bridgeRequestId && isBridgeChatUrl(url)) {
                    var body = init && typeof init.body === "string" ? init.body : null;
                    if (body) {
                        var obj = JSON.parse(body);
                        if (obj && typeof obj === "object" && !Array.isArray(obj) &&
                            !obj.request_id) {
                            obj.request_id = bridgeRequestId;
                            init = Object.assign({}, init, { body: JSON.stringify(obj) });
                            bridgeRequestId = null; // 注入即消费：后续请求不再复用该 id
                        }
                    }
                }
            } catch (err) {
                warn("request_id 注入失败（请求原样发出）：" + msgOf(err));
            }
            return orig.call(g, input, init);
        };
        try {
            Object.defineProperty(g, "__figBridgeFetchHooked", { value: true });
        } catch (err) {
            g.__figBridgeFetchHooked = true;
        }
        g.fetch = hooked;
    }

    // ---------------------------------------------------------------- export

    global.Settings = {
        mount: mount,
        open: open,
        apiKey: apiKey,
        setApiKey: setApiKey,
        values: values,
        defaultDpi: defaultDpi,
        setDefaultDpi: setDefaultDpi,
        testConnection: testConnection,
        bridgeMode: bridgeMode,
        lastModelCall: lastModelCall,
        reserveRequestId: reserveRequestId,
        releaseRequestId: releaseRequestId
    };

    // Apply persisted settings as soon as this script loads (before main.js).
    loadPersisted();
    applyToFigAI();
    wrapFigAIChat();
    installBridgeChatFetchHook();
    detectLocalBridge();
})(typeof globalThis !== "undefined" ? globalThis : this);
