/*
 * presets.js — v1 web app module: journal preset panel + format lint.
 *
 * Exposes globalThis.Presets:
 *   Presets.mount(panelEl)                 journal preset dropdown (grouped by
 *                                          category, width/height/font/dpi
 *                                          summary) + apply + lint result list
 *   Presets.apply(journalId) -> Promise    FigPresets.applyCanvas -> App.commit
 *                                          -> shows the returned warnings
 *   Presets.lint() -> warnings[]           FigPresets.check(App.doc).warnings
 *
 * Contract: v1-web-app/APP-API.md and shared/lib/API.md (frozen v1.0).
 * Depends on: App (app/state.js), FigPresets (lib/presets.js). Ui is optional.
 *
 * Note: FigPresets.applyCanvas applies the apply_journal op to a cloned doc and
 * returns {doc, op, warnings}; we discard the clone and commit the very same
 * op through App.commit so the change lands in history exactly once.
 */

(function (global) {
  "use strict";

  // ------------------------------------------------------------- state

  var _panel = null;
  var _unsubDoc = null;
  var _selectedId = null;
  var _appliedWarnings = [];

  var CATEGORY_ORDER = ["journal", "thesis", "poster", "magazine", "presentation", "custom"];
  var CATEGORY_NAMES = {
    journal: "期刊",
    thesis: "学位论文",
    poster: "海报",
    magazine: "杂志",
    presentation: "演示",
    custom: "自定义"
  };
  var CODE_NAMES = {
    FONT_TOO_SMALL: "字号过小",
    WIDTH_MISMATCH: "宽度不符",
    DPI_TOO_LOW: "DPI 过低",
    HEIGHT_TOO_TALL: "高度超高",
    PANEL_OVERFLOW: "面板越界",
    LOW_CONTRAST: "对比度不足",
    NO_ANCHOR: "缺少锚点"
  };

  // ------------------------------------------------------------ helpers

  function _fail(msg) {
    throw new Error(msg);
  }

  function _requireApp() {
    if (!global.App || typeof global.App.commit !== "function") {
      _fail("presets.js 需要 app/state.js 的 App 先加载");
    }
  }

  function _requirePresets() {
    if (!global.FigPresets || typeof global.FigPresets.journals !== "function") {
      _fail("FigPresets 未加载（lib/presets.js）");
    }
  }

  function _toast(text, type) {
    if (global.Ui && typeof global.Ui.toast === "function") {
      global.Ui.toast(text, { type: type || "info" });
    } else if (global.App && typeof global.App.status === "function") {
      global.App.status(text);
    }
  }

  function _h(tag, attrs, children) {
    var el = global.document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "style") el.setAttribute("style", v);
        else if (k === "title") el.setAttribute("title", v);
        else if (k.lastIndexOf("on", 0) === 0 && typeof v === "function") {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else el.setAttribute(k, v);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? global.document.createTextNode(c) : c);
    });
    return el;
  }

  function _clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // "Nature 单栏（89×170 mm · 正文 7pt · ≥300dpi）"
  function _presetLabel(p) {
    var size = p.height_mm != null
      ? p.width_mm + "×" + p.height_mm + " mm"
      : p.width_mm + " mm（高度不限）";
    var parts = [size];
    if (p.base_font_pt != null) parts.push("正文 " + p.base_font_pt + "pt");
    if (p.dpi_min != null) parts.push("≥" + p.dpi_min + "dpi");
    return p.name + "（" + parts.join(" · ") + "）";
  }

  function _groupedPresets() {
    var presets = global.FigPresets.journals();
    var groups = {};
    var order = CATEGORY_ORDER.slice();
    presets.forEach(function (p) {
      if (groups[p.category] == null) {
        groups[p.category] = [];
        if (order.indexOf(p.category) < 0) order.push(p.category);
      }
      groups[p.category].push(p);
    });
    return order
      .filter(function (cat) { return groups[cat] && groups[cat].length; })
      .map(function (cat) {
        return { category: cat, name: CATEGORY_NAMES[cat] || cat, presets: groups[cat] };
      });
  }

  function _currentJournal() {
    if (!global.App || !global.App.doc) return null;
    if (typeof global.App.currentJournal === "function") {
      try { return global.App.currentJournal() || null; } catch (e) { /* fall through */ }
    }
    var pid = global.App.doc.canvas && global.App.doc.canvas.journal_preset_id;
    if (!pid || !global.FigPresets || typeof global.FigPresets.journal !== "function") return null;
    return global.FigPresets.journal(pid) || null;
  }

  // ------------------------------------------------------------- public

  function mount(panelEl) {
    _requireApp();
    if (!panelEl) _fail("Presets.mount 需要面板元素");
    _panel = panelEl;
    if (_unsubDoc) _unsubDoc();
    if (typeof global.App.on === "function") {
      _unsubDoc = global.App.on("doc:changed", function () { _render(); });
    }
    _render();
  }

  function apply(journalId) {
    _requireApp();
    _requirePresets();
    return new Promise(function (resolve, reject) {
      var preset;
      try {
        preset = global.FigPresets.journal(journalId);
        if (!preset) _fail("未找到期刊预设：" + journalId);
        if (!global.App.doc) _fail("当前没有文档，无法应用期刊预设");

        // Validates the op, applies it to a clone, returns op + warnings.
        var r = global.FigPresets.applyCanvas(journalId, global.App.doc);
        _appliedWarnings = r.warnings || [];
        _selectedId = journalId;

        var commitRes = global.App.commit([r.op], {
          label: "应用期刊预设：" + preset.name,
          source: "preset"
        });

        Promise.resolve(commitRes).then(function (res) {
          if (!res || !res.applied) {
            reject(new Error("期刊预设应用未生效（校验未通过）：" + preset.name));
            return;
          }
          var msg = "已应用 " + preset.name +
            (_appliedWarnings.length ? "，" + _appliedWarnings.length + " 条告警" : "，无告警");
          _toast(msg, _appliedWarnings.length ? "info" : "success");
          if (typeof global.App.status === "function") global.App.status(msg);
          resolve({ journal_id: journalId, applied: res.applied, warnings: _appliedWarnings });
        }, reject);
      } catch (e) {
        if (global.App && typeof global.App.error === "function") global.App.error(e.message);
        reject(e);
      }
    });
  }

  function lint() {
    if (!global.App || !global.App.doc) return [];
    _requirePresets();
    var res = global.FigPresets.check(global.App.doc);
    return res && Array.isArray(res.warnings) ? res.warnings : [];
  }

  // ------------------------------------------------------------- render

  function _render() {
    if (!_panel) return;
    _clear(_panel);

    var select = _renderSelect();
    _panel.appendChild(_h("div", {
      class: "panel-section",
      style: "padding:8px 10px;display:flex;flex-direction:column;gap:8px;"
    }, [
      _h("div", {
        class: "panel-section-title",
        text: "期刊与画布预设",
        style: "font-weight:bold;font-size:13px;"
      }),
      select,
      _h("button", {
        type: "button",
        text: "应用预设",
        style: "font-size:12px;padding:3px 0;cursor:pointer;",
        title: "按所选预设修改画布尺寸并缩放字号（可撤销）",
        onclick: function () {
          global.Presets.apply(select.value)
            .catch(function () { /* App.error already informed the user */ });
        }
      }),
      _renderCurrent()
    ]));

    _panel.appendChild(_renderWarningsBox());
    _panel.appendChild(_renderLintBox());
  }

  function _renderSelect() {
    var select = _h("select", {
      class: "preset-select",
      style: "font-size:12px;width:100%;",
      onchange: function () { _selectedId = this.value || null; }
    });
    var groups;
    try {
      _requirePresets();
      groups = _groupedPresets();
    } catch (e) {
      select.disabled = true;
      select.appendChild(_h("option", { value: "", text: "预设未加载：" + e.message }));
      return select;
    }
    if (!groups.length) {
      select.disabled = true;
      select.appendChild(_h("option", { value: "", text: "无可用预设" }));
      return select;
    }
    groups.forEach(function (g) {
      var og = _h("optgroup", { label: g.name });
      g.presets.forEach(function (p) {
        og.appendChild(_h("option", { value: p.id, text: _presetLabel(p) }));
      });
      select.appendChild(og);
    });
    // Keep the previous choice; default to the doc's current preset.
    var doc = global.App && global.App.doc;
    var docPid = doc && doc.canvas && doc.canvas.journal_preset_id;
    if (!_selectedId && docPid) _selectedId = docPid;
    if (_selectedId) select.value = _selectedId;
    // Assignment falls back to "" in the browser when the id no longer exists.
    if (select.value !== _selectedId && select.firstChild) {
      _selectedId = select.value = select.firstChild.value;
    }
    return select;
  }

  function _renderCurrent() {
    var preset = _currentJournal();
    return _h("div", {
      class: "preset-current",
      text: preset
        ? "当前预设：" + preset.name + "（" + preset.width_mm + "mm" +
          (preset.height_mm != null ? "×" + preset.height_mm + "mm" : "") +
          (preset.base_font_pt != null ? " · " + preset.base_font_pt + "pt" : "") + "）"
        : "当前预设：无（未套用期刊预设）",
      style: "color:#666;font-size:11px;"
    });
  }

  function _renderWarningsBox() {
    var box = _h("div", {
      class: "preset-warnings",
      style: "padding:0 10px 8px;display:flex;flex-direction:column;gap:4px;"
    });
    box.appendChild(_h("div", {
      text: "应用告警",
      style: "font-weight:bold;font-size:12px;"
    }));
    if (!_appliedWarnings.length) {
      box.appendChild(_h("div", {
        text: "（尚未应用预设或无告警）",
        style: "color:#999;font-size:11px;"
      }));
      return box;
    }
    _appliedWarnings.forEach(function (w) {
      box.appendChild(_h("div", {
        text: "⚠ " + w,
        style: "color:#a60;font-size:12px;"
      }));
    });
    return box;
  }

  function _renderLintBox() {
    var box = _h("div", {
      class: "preset-lint",
      style: "padding:0 10px 12px;display:flex;flex-direction:column;gap:4px;"
    });
    box.appendChild(_h("div", {
      text: "格式校验",
      style: "font-weight:bold;font-size:12px;"
    }));

    var warnings;
    try {
      warnings = global.Presets.lint();
    } catch (e) {
      box.appendChild(_h("div", {
        text: "校验失败：" + e.message,
        style: "color:#a00;font-size:12px;"
      }));
      return box;
    }

    if (!warnings.length) {
      box.appendChild(_h("div", {
        text: "✓ 未发现问题",
        style: "color:#080;font-size:12px;"
      }));
      return box;
    }
    warnings.forEach(function (w) {
      var clickable = !!(w.element_id && global.App &&
        typeof global.App.select === "function");
      var label = "[" + (CODE_NAMES[w.code] || w.code) + "] " + w.message;
      var row = _h("div", {
        class: "lint-item",
        text: (clickable ? "◉ " : "· ") + label,
        style: "font-size:12px;line-height:1.4;" +
          (clickable
            ? "color:#0368cf;cursor:pointer;text-decoration:underline;"
            : "color:#666;"),
        title: clickable ? "点击在画布中选中该元素" : null
      });
      if (clickable) {
        var id = w.element_id;
        row.addEventListener("click", function () {
          global.App.select([id]);
          if (typeof global.App.status === "function") {
            global.App.status("已选中元素 " + id + "（对应校验项：" + label + "）");
          }
        });
      }
      box.appendChild(row);
    });
    box.appendChild(_h("div", {
      text: "◉ 条目可点击：在画布中高亮对应元素",
      style: "color:#999;font-size:11px;"
    }));
    return box;
  }

  // ------------------------------------------------------------ exports

  var Presets = {
    mount: mount,
    apply: apply,
    lint: lint
  };

  global.Presets = Presets;
})(typeof globalThis !== "undefined" ? globalThis : this);
