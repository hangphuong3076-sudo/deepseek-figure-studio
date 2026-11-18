/*
 * Ui — shared UI widgets for the v1 web app (app/ui.js)
 *
 * Exposes `globalThis.Ui`:
 *   Ui.mount(rootEl)                       remember app root; lazily ensure
 *                                          #modal-root and #toast-root exist
 *   Ui.modal({title, body, actions, className, isDirty, discardText}) -> handle
 *        body: Node | string; actions: [{label, primary, variant, onClick,
 *        disabled, hidden, ...data-* attributes}]
 *        onClick receives {close}; returning exactly false (or a Promise
 *        resolving to false) keeps the modal open, otherwise it closes.
 *        className adds extra classes to the .ui-modal card.
 *        isDirty() -> boolean enables requestClose() confirmation with
 *        discardText (default "放弃本次设置？").
 *        onClosed() optional hook fired once on every close path.
 *        handle: {close, root, dialog, setActions(actions), requestClose()}
 *        close() force-closes; requestClose() confirms first when dirty.
 *        Only the topmost modal on the stack answers Esc/Enter/Tab.
 *   Ui.confirm(text) -> Promise<boolean>
 *   Ui.toast(text, {type="info"|"error"|"success", ms=3000})
 *   Ui.tabs(containerEl, {tabs:[{id,label}], active, onChange})
 *        builds buttons with ids "tab-<id>", toggles "#panel-<id>" visibility
 *        with the .hidden class, syncs App.ui.activeTab
 *   Ui.button({label, title, onClick, variant}) -> HTMLButtonElement
 *        variant: "primary" | "danger" | "ghost" | undefined
 *   Ui.field({label, type, value, min, max, step, options, onChange}) -> HTMLDivElement
 *        type: "text"|"number"|"checkbox"|"select"|"color"|"textarea";
 *        fires onChange on "change"; div.getValue() reads the current value
 *   Ui.h(tag, attrs, children) -> HTMLElement
 *   Ui.formatMm(n) -> "12.3 mm"
 *
 * No build step, no dependencies; UI text is Chinese, comments English.
 */
(function (global) {
  "use strict";

  var rootEl = null;
  var modalRoot = null;
  var toastRoot = null;

  // Stacked modals: only the top entry receives Esc / Enter / Tab handling.
  var modalStack = [];
  var modalTitleSeq = 0;
  var modalKeyBound = false;

  var FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), " +
    "input:not([disabled]):not([type='hidden']), select:not([disabled]), " +
    "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  function topModalEntry() {
    for (var i = modalStack.length - 1; i >= 0; i--) {
      if (!modalStack[i].isClosed()) return modalStack[i];
    }
    return null;
  }

  function findPrimaryIn(dialog) {
    var btns = dialog.querySelectorAll(".ui-modal-footer .ui-btn-primary");
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i].disabled && !btns[i].hidden) return btns[i];
    }
    return null;
  }

  function focusableWithin(container) {
    var nodes = container.querySelectorAll(FOCUSABLE_SELECTOR);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // offsetParent is null for display:none subtrees (and position:fixed,
      // which nothing inside a dialog uses); keep the active element anyway.
      if (el.offsetParent !== null || el === document.activeElement) out.push(el);
    }
    return out;
  }

  function trapModalTab(top, evt) {
    var items = focusableWithin(top.dialog);
    if (!items.length) {
      evt.preventDefault();
      try { top.dialog.focus(); } catch (e) { /* best effort */ }
      return;
    }
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    var inside = !!(active && top.dialog.contains(active));
    var inItems = inside && items.indexOf(active) >= 0;
    var escape = !inside || active === top.dialog || (inside && !inItems);
    if (evt.shiftKey) {
      if (escape || active === first) {
        evt.preventDefault();
        last.focus();
      }
    } else if (escape || active === last) {
      evt.preventDefault();
      first.focus();
    }
  }

  // Canvas-level shortcuts that must never reach the document while a
  // dialog is on top (G02). Ctrl/Meta letter combos are listed explicitly;
  // plain letters are left alone so typing-like keys keep working.
  function isCanvasShortcut(evt) {
    var k = evt.key || "";
    if (k === "Delete" || k === "Backspace") return true;
    if (k.indexOf("Arrow") === 0) return true;
    if (k === "+" || k === "=" || k === "-" || k === "_") return true;
    if (evt.ctrlKey || evt.metaKey) {
      return "zysadcvxg".indexOf(k.toLowerCase()) >= 0;
    }
    return false;
  }

  function isEditableTarget(t) {
    if (!t || !t.tagName) return false;
    return t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" || !!t.isContentEditable;
  }

  // 声明自己处理按键的控件（如数据向导单元格编辑 input 带
  // data-modal-keys="own"）：Escape/Enter 放行给控件自己处理，
  // 不 preventDefault/stopPropagation，也不触发对话框主按钮/关闭。
  function modalOwnKeys(t) {
    return !!(t && t.closest && t.closest('[data-modal-keys="own"]'));
  }

  function onModalKeydown(evt) {
    var top = topModalEntry();
    if (!top) return;
    if (evt.key === "Escape") {
      if (modalOwnKeys(evt.target)) return; // 控件自理 Esc（如取消单元格编辑）
      evt.preventDefault();
      // Capture phase: also stop the event so canvas handlers
      // (main.js 清除选择 / editor escapeAction) never see it.
      evt.stopPropagation();
      top.requestClose();
      return;
    }
    if (evt.key === "Enter") {
      if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) return;
      // IME composition (e.g. Chinese pinyin candidate window) must not
      // confirm the dialog; keyCode 229 is the legacy signal.
      if (evt.isComposing || evt.keyCode === 229) return;
      if (modalOwnKeys(evt.target)) return; // 控件自理 Enter（如提交单元格编辑）
      var t = evt.target;
      if (t && t.tagName) {
        var tag = t.tagName;
        if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A" ||
            tag === "SELECT" || t.isContentEditable) return;
      }
      var primary = findPrimaryIn(top.dialog);
      if (primary) {
        evt.preventDefault();
        primary.click();
      }
      return;
    }
    if (evt.key === "Tab") { trapModalTab(top, evt); return; }
    // Remaining keys: editable controls inside the dialog keep normal
    // input; app shortcuts are stopped from leaking to the canvas behind
    // the modal. stopPropagation only — no preventDefault, so radio arrow
    // keys, scrolling and other native behavior are unaffected.
    if (isEditableTarget(evt.target)) return;
    if (isCanvasShortcut(evt)) evt.stopPropagation();
  }

  function ensureModalKeyHandler() {
    if (modalKeyBound) return;
    if (typeof document === "undefined" || !document.addEventListener) return;
    modalKeyBound = true;
    // Capture phase on document: runs before the canvas keydown handlers
    // (editor.js / main.js listen on bubble) so shortcuts cannot穿透.
    document.addEventListener("keydown", onModalKeydown, true);
  }

  function ensureRoots() {
    var host = rootEl || (typeof document !== "undefined" ? document.body : null);
    if (!host) throw new Error("Ui: 当前环境没有可用的 DOM，无法挂载界面");
    if (!modalRoot || !modalRoot.isConnected) {
      modalRoot = document.getElementById("modal-root");
      if (!modalRoot) {
        modalRoot = global.Ui.h("div", { id: "modal-root" });
        host.appendChild(modalRoot);
      }
    }
    if (!toastRoot || !toastRoot.isConnected) {
      toastRoot = document.getElementById("toast-root");
      if (!toastRoot) {
        toastRoot = global.Ui.h("div", { id: "toast-root" });
        host.appendChild(toastRoot);
      }
    }
    return { modalRoot: modalRoot, toastRoot: toastRoot };
  }

  // ------------------------------------------------------------------- Ui

  var Ui = {

    mount: function (root) {
      if (!root || typeof root.appendChild !== "function") {
        throw new Error("Ui.mount: rootEl 必须是 DOM 元素");
      }
      rootEl = root;
      ensureRoots();
      return root;
    },

    // ---------------------------------------------------------------- modal

    modal: function (opts) {
      opts = opts || {};
      var roots = ensureRoots();
      var closed = false;
      var prevFocus = (typeof document !== "undefined" && document.activeElement) || null;

      var overlay = Ui.h("div", { class: "ui-modal-overlay" });
      var dialogClass = "ui-modal" +
        (opts.className ? " " + String(opts.className) : "");
      var dialog = Ui.h("div", { class: dialogClass, role: "dialog" });
      dialog.setAttribute("aria-modal", "true");
      dialog.tabIndex = -1;
      var bodyEl = Ui.h("div", { class: "ui-modal-body" });
      var footerEl = Ui.h("div", { class: "ui-modal-footer" });

      if (typeof opts.title === "string" && opts.title) {
        var titleId = "ui-modal-title-" + (++modalTitleSeq);
        dialog.appendChild(Ui.h("div", { class: "ui-modal-title", id: titleId }, [
          Ui.h("span", { text: opts.title })
        ]));
        dialog.setAttribute("aria-labelledby", titleId);
      }
      var closeBtn = Ui.h("button", {
        class: "ui-modal-close", title: "关闭", text: "✕",
        onclick: function () { requestClose(); }
      });
      dialog.appendChild(closeBtn);

      if (opts.body instanceof Node) bodyEl.appendChild(opts.body);
      else if (typeof opts.body === "string") {
        // 字符串一律按纯文本插入：工程标题/风格名等用户数据可能含
        // <img onerror>，绝不能当 HTML 解析。pre-wrap 只加在字符串 body 上，
        // Node body（表单/列表等复杂结构）的排版不受影响。
        bodyEl.textContent = opts.body;
        bodyEl.style.whiteSpace = "pre-wrap";
      }
      else if (opts.body != null) bodyEl.textContent = String(opts.body);
      dialog.appendChild(bodyEl);

      function isDirtyNow() {
        if (typeof opts.isDirty !== "function") return false;
        try { return !!opts.isDirty(); } catch (e) { return false; }
      }

      function close() {
        if (closed) return;
        closed = true;
        var idx = modalStack.indexOf(entry);
        if (idx >= 0) modalStack.splice(idx, 1);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        try {
          if (prevFocus && prevFocus.isConnected &&
              typeof prevFocus.focus === "function" &&
              document.activeElement !== prevFocus) {
            prevFocus.focus();
          }
        } catch (e) { /* focus restore is best effort */ }
        // Fires on every close path (buttons, Esc, ✕, backdrop, programmatic
        // close) so callers like Ui.confirm can settle non-button closes.
        if (typeof opts.onClosed === "function") {
          try { opts.onClosed(); } catch (e2) { /* listener errors are ignored */ }
        }
      }

      function requestClose() {
        if (closed) return;
        if (isDirtyNow()) {
          var text = typeof opts.discardText === "string" && opts.discardText
            ? opts.discardText : "放弃本次设置？";
          Ui.confirm(text).then(function (ok) {
            if (ok) close();
          });
          return;
        }
        close();
      }

      function runAction(action) {
        if (!action || typeof action.onClick !== "function") { close(); return; }
        var result;
        try { result = action.onClick({ close: close }); }
        catch (err) {
          Ui.toast("操作失败：" + errText(err), { type: "error" });
          return;
        }
        if (result === false) return; // keep the modal open
        if (result && typeof result.then === "function") {
          result.then(function (value) {
            if (value !== false) close();
          }).catch(function (err) {
            Ui.toast("操作失败：" + errText(err), { type: "error" });
          });
          return;
        }
        close();
      }

      function renderActions(list) {
        footerEl.textContent = "";
        var acts = Array.isArray(list) && list.length
          ? list : [{ label: "关闭" }];
        acts.forEach(function (action) {
          var btn = Ui.button({
            label: action.label || "确定",
            variant: action.primary ? "primary" : (action.variant || "ghost"),
            onClick: function () { runAction(action); }
          });
          if (action.disabled) btn.disabled = true;
          if (action.hidden) btn.hidden = true;
          Object.keys(action).forEach(function (key) {
            if (key.indexOf("data-") === 0) {
              btn.setAttribute(key, String(action[key]));
            }
          });
          footerEl.appendChild(btn);
        });
      }

      function setActions(actions) {
        if (closed) return;
        renderActions(actions);
      }

      renderActions(opts.actions);
      dialog.appendChild(footerEl);
      overlay.appendChild(dialog);

      // Backdrop click counts only when both mousedown and click land on the
      // overlay itself; a dirty dialog ignores it entirely (no confirm).
      var downOnOverlay = false;
      overlay.addEventListener("mousedown", function (evt) {
        downOnOverlay = evt.target === overlay;
      });
      overlay.addEventListener("click", function (evt) {
        var wasDown = downOnOverlay;
        downOnOverlay = false;
        if (wasDown && evt.target === overlay && !isDirtyNow()) requestClose();
      });

      var entry = {
        overlay: overlay,
        dialog: dialog,
        isClosed: function () { return closed; },
        requestClose: requestClose
      };
      modalStack.push(entry);
      ensureModalKeyHandler();

      roots.modalRoot.appendChild(overlay);

      // Initial focus: [data-autofocus] -> first usable field in the body ->
      // primary action -> the dialog itself.
      var focusTarget = null;
      var auto = dialog.querySelector("[data-autofocus]");
      if (auto && (auto.matches(FOCUSABLE_SELECTOR) || auto.hasAttribute("tabindex"))) {
        focusTarget = auto;
      }
      if (!focusTarget) {
        var fields = bodyEl.querySelectorAll(
          "input:not([disabled]):not([type='hidden']), " +
          "select:not([disabled]), textarea:not([disabled])");
        for (var i = 0; i < fields.length; i++) {
          if (fields[i].offsetParent !== null) { focusTarget = fields[i]; break; }
        }
      }
      if (!focusTarget) focusTarget = findPrimaryIn(dialog);
      if (!focusTarget) focusTarget = dialog;
      try { focusTarget.focus(); } catch (e) { /* focus is best effort */ }

      return {
        close: close,
        root: overlay,
        dialog: dialog,
        setActions: setActions,
        requestClose: requestClose
      };
    },

    confirm: function (text) {
      return new Promise(function (resolve) {
        var settled = false;
        function decide(value) {
          if (settled) return;
          settled = true;
          resolve(value);
        }
        Ui.modal({
          title: "确认",
          body: typeof text === "string" ? text : String(text == null ? "" : text),
          // Closing via ✕ / ESC / overlay click also counts as "cancel":
          // onClosed fires on every close path, decide() is idempotent.
          onClosed: function () { decide(false); },
          actions: [
            {
              label: "取消",
              onClick: function () { decide(false); }
            },
            {
              label: "确定",
              primary: true,
              onClick: function () { decide(true); }
            }
          ]
        });
      });
    },

    // ---------------------------------------------------------------- toast

    toast: function (text, opts) {
      opts = opts || {};
      var roots = ensureRoots();
      var type = ["info", "error", "success"].indexOf(opts.type) >= 0 ? opts.type : "info";
      var message = String(text == null ? "" : text);
      var el = Ui.h("div", { class: "ui-toast ui-toast-" + type });
      var details;
      if (type === "error") {
        var previous = Array.from(roots.toastRoot.children).find(function (item) {
          return item.toastMessage === message;
        });
        if (previous) return previous;
        el.toastMessage = message;
        var summary = opts.summary || (message.length > 100 ? message.slice(0, 96) + "…" : message);
        el.appendChild(Ui.h("span", { role: "alert", text: summary }));
        el.appendChild(Ui.h("button", { type: "button", class: "toast-close", "aria-label": "关闭提示",
          text: "×", onclick: function () { el.remove(); } }));
        if (summary !== message) {
          details = Ui.h("details", {}, [Ui.h("summary", { text: "查看详情" }), Ui.h("pre", { text: message })]);
          el.appendChild(details);
        }
      } else el.textContent = message;
      roots.toastRoot.appendChild(el);
      var ms = typeof opts.ms === "number" && opts.ms > 0 ? opts.ms : 3000;
      global.setTimeout(function () {
        if (details && details.open) return;
        el.classList.add("ui-toast-out");
        global.setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 300);
      }, ms);
      return el;
    },

    // ----------------------------------------------------------------- tabs

    tabs: function (containerEl, opts) {
      if (!containerEl || typeof containerEl.appendChild !== "function") {
        throw new Error("Ui.tabs: containerEl 必须是 DOM 元素");
      }
      opts = opts || {};
      var tabs = Array.isArray(opts.tabs) ? opts.tabs : [];
      if (!tabs.length) throw new Error("Ui.tabs: tabs 不能为空");
      var activeId = null;

      containerEl.innerHTML = "";

      function activate(id, skipOnChange) {
        var found = null;
        tabs.forEach(function (t) { if (t.id === id) found = t; });
        if (!found) throw new Error("Ui.tabs: 未知的标签页 \"" + id + "\"");
        activeId = id;
        Array.from(containerEl.children).forEach(function (btn) {
          var on = btn.getAttribute("data-tab") === id;
          btn.classList.toggle("active", on);
          btn.setAttribute("aria-selected", on ? "true" : "false");
        });
        // Panels are siblings of #tabs inside the side pane.
        tabs.forEach(function (t) {
          var panel = document.getElementById("panel-" + t.id);
          if (panel) panel.classList.toggle("hidden", t.id !== id);
        });
        if (global.App) {
          if (global.App.ui) global.App.ui.activeTab = id;
          global.App.emit("ui:changed", { activeTab: id });
        }
        if (!skipOnChange && typeof opts.onChange === "function") opts.onChange(id);
      }

      tabs.forEach(function (t) {
        var btn = Ui.h("button", {
          id: "tab-" + t.id,
          class: "ui-tab",
          "data-tab": t.id,
          text: t.label || t.id,
          role: "tab",
          onclick: function () { activate(t.id); }
        });
        containerEl.appendChild(btn);
      });

      var initial = null;
      tabs.forEach(function (t) { if (t.id === (opts.active || global.App && global.App.ui && global.App.ui.activeTab)) initial = t.id; });
      activate(initial || tabs[0].id, true);

      return {
        el: containerEl,
        active: function () { return activeId; },
        activate: function (id) { activate(id); }
      };
    },

    // ------------------------------------------------------ button / field

    button: function (opts) {
      opts = opts || {};
      var variants = ["primary", "danger", "ghost"];
      var variant = variants.indexOf(opts.variant) >= 0 ? opts.variant : "ghost";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ui-btn ui-btn-" + variant;
      btn.textContent = opts.label != null ? String(opts.label) : "按钮";
      if (opts.title) btn.title = String(opts.title);
      if (typeof opts.onClick === "function") {
        btn.addEventListener("click", opts.onClick);
      }
      return btn;
    },

    field: function (opts) {
      opts = opts || {};
      var type = opts.type || "text";
      var wrap = Ui.h("div", { class: "ui-field" });
      var labelEl = Ui.h("label", { class: "ui-field-label", text: opts.label != null ? String(opts.label) : "" });
      var input;

      if (type === "select") {
        input = document.createElement("select");
        input.className = "ui-field-input";
        var options = Array.isArray(opts.options) ? opts.options : [];
        options.forEach(function (opt) {
          var isObj = opt && typeof opt === "object";
          var value = isObj ? opt.value : opt;
          var label = isObj && opt.label != null ? opt.label : value;
          var o = document.createElement("option");
          o.value = String(value);
          o.textContent = String(label);
          input.appendChild(o);
        });
        if (opts.value != null) input.value = String(opts.value);
      } else if (type === "textarea") {
        input = document.createElement("textarea");
        input.className = "ui-field-input";
        input.value = opts.value != null ? String(opts.value) : "";
        input.rows = 3;
      } else {
        input = document.createElement("input");
        input.className = "ui-field-input";
        input.type = type === "number" ? "number" : (type === "checkbox" ? "checkbox" : (type === "color" ? "color" : "text"));
        if (type === "checkbox") input.checked = !!opts.value;
        else if (opts.value != null) input.value = String(opts.value);
        if (type === "number") {
          if (opts.min != null) input.min = String(opts.min);
          if (opts.max != null) input.max = String(opts.max);
          if (opts.step != null) input.step = String(opts.step);
        }
      }

      wrap.appendChild(labelEl);
      if (type === "checkbox") {
        labelEl.insertBefore(input, labelEl.firstChild);
      } else {
        wrap.appendChild(input);
      }

      input.addEventListener("change", function (evt) {
        if (typeof opts.onChange !== "function") return;
        var value = type === "checkbox" ? input.checked
          : (type === "number" ? (input.value === "" ? null : Number(input.value))
            : input.value);
        try { opts.onChange(value, evt); }
        catch (err) { Ui.toast("处理输入失败：" + errText(err), { type: "error" }); }
      });

      wrap.getValue = function () {
        return type === "checkbox" ? input.checked : input.value;
      };
      return wrap;
    },

    // -------------------------------------------------------------- helpers

    // Tiny hyperscript helper: Ui.h(tag, attrs, children)
    h: function (tag, attrs, children) {
      if (typeof tag !== "string" || !tag) throw new Error("Ui.h: tag 必须是非空字符串");
      var el = document.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach(function (key) {
          var value = attrs[key];
          if (value === null || value === undefined || value === false) return;
          if (key === "class" || key === "className") el.className = String(value);
          else if (key === "text") el.textContent = String(value);
          else if (key === "html") el.innerHTML = String(value);
          else if (key === "style" && value && typeof value === "object") {
            // 对象样式：kebab-case 走 setProperty，camelCase 走 style 属性
            // （兼容各旧 h() 的 el.style[p]=v 写法）；null/undefined 跳过。
            Object.keys(value).forEach(function (prop) {
              var pv = value[prop];
              if (pv === null || pv === undefined) return;
              if (prop.indexOf("-") >= 0) el.style.setProperty(prop, String(pv));
              else el.style[prop] = pv;
            });
          } else if (key === "dataset" && value && typeof value === "object") {
            Object.keys(value).forEach(function (prop) {
              el.dataset[prop] = String(value[prop]);
            });
          } else if (key.indexOf("on") === 0 && typeof value === "function") {
            el.addEventListener(key.slice(2).toLowerCase(), value);
          } else if (value === true) {
            el.setAttribute(key, "");
          } else {
            el.setAttribute(key, String(value));
          }
        });
      }
      if (children != null) {
        var list = Array.isArray(children) ? children : [children];
        list.forEach(function (child) {
          if (child == null || child === false) return;
          if (child instanceof Node) el.appendChild(child);
          else el.appendChild(document.createTextNode(String(child)));
        });
      }
      return el;
    },

    formatMm: function (n) {
      if (typeof n !== "number" || !isFinite(n)) {
        throw new Error("Ui.formatMm: 参数必须是有限数字");
      }
      var rounded = Math.round(n * 10) / 10;
      return rounded + " mm";
    }
  };

  global.Ui = Ui;
})(typeof globalThis !== "undefined" ? globalThis : this);
