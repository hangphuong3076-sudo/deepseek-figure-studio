/*
 * Ui — shared UI widgets for the v1 web app (app/ui.js)
 *
 * Exposes `globalThis.Ui`:
 *   Ui.mount(rootEl)                       remember app root; lazily ensure
 *                                          #modal-root and #toast-root exist
 *   Ui.modal({title, body, actions}) -> {close}
 *        body: Node | string; actions: [{label, primary, onClick}]
 *        onClick receives {close}; returning exactly false (or a Promise
 *        resolving to false) keeps the modal open, otherwise it closes.
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

  function errText(err) {
    return err && err.message ? err.message : String(err);
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

      var overlay = Ui.h("div", { class: "ui-modal-overlay" });
      var dialog = Ui.h("div", { class: "ui-modal", role: "dialog" });
      var bodyEl = Ui.h("div", { class: "ui-modal-body" });
      var footerEl = Ui.h("div", { class: "ui-modal-footer" });

      if (typeof opts.title === "string" && opts.title) {
        dialog.appendChild(Ui.h("div", { class: "ui-modal-title" }, [
          Ui.h("span", { text: opts.title })
        ]));
      }
      var closeBtn = Ui.h("button", {
        class: "ui-modal-close", title: "关闭", text: "✕",
        onclick: function () { close(); }
      });
      dialog.appendChild(closeBtn);

      if (opts.body instanceof Node) bodyEl.appendChild(opts.body);
      else if (typeof opts.body === "string") bodyEl.innerHTML = opts.body;
      else if (opts.body != null) bodyEl.textContent = String(opts.body);
      dialog.appendChild(bodyEl);

      function close() {
        if (closed) return;
        closed = true;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        document.removeEventListener("keydown", onKey);
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

      var actions = Array.isArray(opts.actions) && opts.actions.length
        ? opts.actions
        : [{ label: "关闭" }];
      actions.forEach(function (action) {
        var btn = Ui.button({
          label: action.label || "确定",
          variant: action.primary ? "primary" : (action.variant || "ghost"),
          onClick: function () { runAction(action); }
        });
        footerEl.appendChild(btn);
      });
      dialog.appendChild(footerEl);
      overlay.appendChild(dialog);

      function onKey(evt) {
        if (evt.key === "Escape") { evt.preventDefault(); close(); }
      }
      overlay.addEventListener("mousedown", function (evt) {
        if (evt.target === overlay) close();
      });
      document.addEventListener("keydown", onKey);

      roots.modalRoot.appendChild(overlay);
      var primary = footerEl.querySelector(".ui-btn-primary");
      if (primary) primary.focus();
      return { close: close, root: overlay };
    },

    confirm: function (text) {
      return new Promise(function (resolve) {
        var settled = false;
        function decide(value) {
          if (settled) return;
          settled = true;
          resolve(value);
        }
        var handle = Ui.modal({
          title: "确认",
          body: typeof text === "string" ? text : String(text == null ? "" : text),
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
        // Closing via ✕ / ESC / overlay click also counts as "cancel".
        var origClose = handle.close;
        handle.close = function () { decide(false); origClose(); };
      });
    },

    // ---------------------------------------------------------------- toast

    toast: function (text, opts) {
      opts = opts || {};
      var roots = ensureRoots();
      var type = ["info", "error", "success"].indexOf(opts.type) >= 0 ? opts.type : "info";
      var el = Ui.h("div", { class: "ui-toast ui-toast-" + type, text: String(text == null ? "" : text) });
      roots.toastRoot.appendChild(el);
      var ms = typeof opts.ms === "number" && opts.ms > 0 ? opts.ms : 3000;
      global.setTimeout(function () {
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
          if (key === "class") el.className = String(value);
          else if (key === "text") el.textContent = String(value);
          else if (key === "html") el.innerHTML = String(value);
          else if (key === "style" && value && typeof value === "object") {
            Object.keys(value).forEach(function (prop) {
              el.style.setProperty(prop, String(value[prop]));
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
