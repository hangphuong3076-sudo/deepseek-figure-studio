/*
 * Store — project persistence for the v1 web app (app/store.js)
 *
 * Exposes `globalThis.Store`. Wraps the kernel FigStore (lib/storage.js) with
 * the localStorage adapter (IndexedDB primary + localStorage fallback):
 *   Store.attach() -> Promise<"indexeddb"|"localstorage">
 *       FigStore.use(FigStore.adapters.localStorage()) + adapter.open()
 *   Store.save({label}) -> Promise<project>        manual save (checkpoint)
 *   Store.saveAs({label}) -> Promise<project>      save under a new doc id
 *       (switches the editor to the copy, like "save as")
 *   Store.open([id]) -> Promise<doc>               no id -> pick from a dialog
 *   Store.newProject() -> Promise<doc|null>        confirm-protected new doc
 *   Store.autosave() -> Promise<project|null>      "自动快照" snapshot; marks
 *       App._markAutosaved() on success
 *   Store.mount(panelEl)                           新建/保存/另存为按钮 + 最近工程列表
 *   Store.list() -> Promise<summary[]>             sorted by updated desc
 *   Store.refreshList()                            re-render the recent list
 *
 * Errors carry Chinese messages and propagate to callers; UI feedback uses
 * App.status/App.error and Ui.toast.
 */
(function (global) {
  "use strict";

  var adapter = null;       // the registered FigStore adapter
  var listEl = null;        // recent-projects list container

  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  function requireKernel() {
    if (!global.FigStore || typeof global.FigStore.use !== "function") {
      throw new Error("Store: 缺少内核 FigStore，请先加载 lib/storage.js");
    }
  }

  function requireAttached() {
    if (!adapter) {
      throw new Error("Store: 本地存储尚未初始化，请先调用 Store.attach()");
    }
  }

  function requireDoc() {
    if (!global.App || !global.App.doc) {
      throw new Error("Store: 文档尚未初始化，无法保存");
    }
  }

  function toast(text, opts) {
    if (global.Ui && typeof global.Ui.toast === "function") {
      global.Ui.toast(text, opts);
    }
  }

  function docTitle(doc) {
    return doc && doc.title ? String(doc.title) : "未命名工程";
  }

  // FigStore.snapshot() -> projectFromDoc() moves doc.history into the project
  // and empties doc.history on the object passed in. Passing a deep clone keeps
  // the live App.doc.history intact (the undo/history panels depend on it).
  function cloneForSnapshot() {
    return JSON.parse(JSON.stringify(global.App.doc));
  }

  function fmtTime(iso) {
    if (typeof iso !== "string" || !iso) return "—";
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "—";
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
        " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch (err) {
      return "—";
    }
  }

  // ------------------------------------------------------------------- API

  var Store = {

    attach: async function () {
      requireKernel();
      adapter = global.FigStore.adapters.localStorage();
      global.FigStore.use(adapter);
      var mode = await adapter.open(); // "indexeddb" | "localstorage"
      return mode;
    },

    attached: function () {
      return !!adapter;
    },

    save: async function (opts) {
      requireAttached();
      requireDoc();
      opts = opts || {};
      var project = await global.FigStore.snapshot(cloneForSnapshot(), {
        label: typeof opts.label === "string" && opts.label ? opts.label : "手动保存",
        source: "user",
        checkpoint: true
      });
      toast("已保存：" + docTitle(global.App.doc), { type: "success" });
      Store.refreshList();
      return project;
    },

    // Save the current document under a brand-new doc id and switch to it.
    saveAs: async function (opts) {
      requireAttached();
      requireDoc();
      if (!global.FigDoc) {
        throw new Error("Store.saveAs: 缺少内核 FigDoc，请先加载 lib/figdoc.js");
      }
      opts = opts || {};
      await global.App.publishDoc(function (current) {
        var next = JSON.parse(JSON.stringify(current));
        next.id = global.FigDoc.uid("doc");
        var now = new Date().toISOString();
        next.meta = next.meta || {};
        next.meta.created = now;
        next.meta.updated = now;
        return next;
      }, { reason: "save-as" });
      return Store.save({ label: opts.label || "另存为" });
    },

    open: async function (id) {
      requireAttached();
      if (id === undefined || id === null) {
        return Store.pickAndOpen();
      }
      if (typeof id !== "string" || !id) {
        throw new Error("Store.open: id 必须是非空字符串");
      }
      var project = await global.FigStore.loadProject(id);
      if (!project) {
        throw new Error("Store.open: 找不到工程 \"" + id + "\"");
      }
      return Store.loadIntoEditor(project);
    },

    loadIntoEditor: async function (project) {
      if (!global.App || !global.FigStore) {
        throw new Error("Store.loadIntoEditor: 缺少 App 或 FigStore");
      }
      var doc = global.FigStore.docFromProject(project);
      await global.App.publishDoc(doc, { reason: "open" });
      global.App.clearSelection();
      global.App.status("已打开：" + docTitle(doc));
      Store.refreshList();
      return global.App.doc;
    },

    // Dialog listing saved projects; resolves with the opened doc, or null if
    // the user cancels / there is nothing to open.
    pickAndOpen: async function () {
      requireAttached();
      var summaries = await Store.list();
      if (!summaries.length) {
        toast("暂无已保存的工程", { type: "info" });
        return null;
      }
      return new Promise(function (resolve) {
        var listNode = global.Ui.h("div", { class: "ui-project-picker" });
        summaries.forEach(function (s) {
          var row = global.Ui.h("div", { class: "ui-project-row" }, [
            global.Ui.h("div", { class: "ui-project-info" }, [
              global.Ui.h("div", { class: "ui-project-title", text: s.title || s.id }),
              global.Ui.h("div", {
                class: "ui-project-meta",
                text: "更新于 " + fmtTime(s.updated) + " · " + s.id
              })
            ]),
            global.Ui.button({
              label: "打开",
              variant: "primary",
              onClick: function () { handle.close(); Store.open(s.id).then(resolve).catch(function (err) { toast(errText(err), { type: "error" }); resolve(null); }); }
            })
          ]);
          listNode.appendChild(row);
        });
        var handle = global.Ui.modal({
          title: "打开工程",
          body: listNode,
          actions: [{ label: "取消" }]
        });
        var origClose = handle.close;
        handle.close = function () { resolve(null); origClose(); };
      });
    },

    newProject: async function () {
      if (!global.App || !global.FigDoc) {
        throw new Error("Store.newProject: 缺少 App 或内核 FigDoc");
      }
      var doc = global.App.doc;
      var hasContent = doc && ((doc.elements && doc.elements.length) ||
        (doc.history && doc.history.length));
      if (hasContent && global.Ui && typeof global.Ui.confirm === "function") {
        var ok = await global.Ui.confirm("新建工程将放弃当前未保存的内容，是否继续？");
        if (!ok) return null;
      }
      var created = global.FigDoc.create({ app: "figure-app", app_version: "1.0" });
      await global.App.publishDoc(created, { reason: "new" });
      global.App.clearSelection();
      global.App.status("已新建工程");
      Store.refreshList();
      return global.App.doc;
    },

    autosave: async function () {
      requireAttached();
      if (!global.App || !global.App.doc) return null; // nothing to snapshot yet
      var project = await global.FigStore.snapshot(cloneForSnapshot(), {
        label: "自动快照",
        source: "system",
        checkpoint: true
      });
      if (global.App && typeof global.App._markAutosaved === "function") {
        global.App._markAutosaved();
      }
      return project;
    },

    list: async function () {
      requireAttached();
      var summaries = await global.FigStore.listProjects();
      summaries = (summaries || []).slice().sort(function (a, b) {
        var ta = a && a.updated ? a.updated : "";
        var tb = b && b.updated ? b.updated : "";
        return tb.localeCompare(ta);
      });
      return summaries;
    },

    deleteProject: async function (id) {
      requireAttached();
      var ok = await global.FigStore.deleteProject(id);
      Store.refreshList();
      return ok;
    },

    // ---------------------------------------------------------------- mount

    mount: function (panelEl) {
      if (!panelEl || typeof panelEl.appendChild !== "function") {
        throw new Error("Store.mount: panelEl 必须是 DOM 元素");
      }
      panelEl.innerHTML = "";

      panelEl.appendChild(global.Ui.h("div", { class: "ui-panel-title", text: "工程" }));

      var btnRow = global.Ui.h("div", { class: "ui-btn-row" });
      btnRow.appendChild(global.Ui.button({
        label: "新建",
        title: "新建空白工程",
        onClick: function () {
          Store.newProject().catch(function (err) {
            toast(errText(err), { type: "error" });
          });
        }
      }));
      btnRow.appendChild(global.Ui.button({
        label: "保存",
        title: "保存当前工程",
        variant: "primary",
        onClick: function () {
          Store.save({}).catch(function (err) {
            toast(errText(err), { type: "error" });
          });
        }
      }));
      btnRow.appendChild(global.Ui.button({
        label: "另存为",
        title: "以新 id 保存一份副本并切换过去",
        onClick: function () {
          Store.saveAs({}).catch(function (err) {
            toast(errText(err), { type: "error" });
          });
        }
      }));
      panelEl.appendChild(btnRow);

      panelEl.appendChild(global.Ui.h("div", { class: "ui-panel-title", text: "最近工程" }));
      listEl = global.Ui.h("div", { class: "ui-project-list", id: "store-project-list" });
      panelEl.appendChild(listEl);

      Store.refreshList();
      return panelEl;
    },

    refreshList: async function () {
      if (!listEl) return;
      if (!adapter) {
        listEl.textContent = "存储未初始化";
        return;
      }
      var summaries;
      try {
        summaries = await Store.list();
      } catch (err) {
        listEl.textContent = "读取工程列表失败：" + errText(err);
        return;
      }
      listEl.innerHTML = "";
      if (!summaries.length) {
        listEl.appendChild(global.Ui.h("div", { class: "ui-project-empty", text: "暂无已保存的工程" }));
        return;
      }
      summaries.forEach(function (s) {
        var row = global.Ui.h("div", { class: "ui-project-row" }, [
          global.Ui.h("div", { class: "ui-project-info" }, [
            global.Ui.h("div", { class: "ui-project-title", text: s.title || s.id }),
            global.Ui.h("div", {
              class: "ui-project-meta",
              text: "更新于 " + fmtTime(s.updated) + " · " + s.history_length + " 条历史"
            })
          ]),
          global.Ui.h("div", { class: "ui-project-actions" }, [
            global.Ui.button({
              label: "打开",
              onClick: function () {
                Store.open(s.id).catch(function (err) {
                  toast(errText(err), { type: "error" });
                });
              }
            }),
            global.Ui.button({
              label: "删除",
              variant: "danger",
              onClick: async function () {
                var ok = await global.Ui.confirm("确定删除工程 \"" + (s.title || s.id) + "\"？此操作不可撤销。");
                if (!ok) return;
                try {
                  await Store.deleteProject(s.id);
                  toast("已删除：" + (s.title || s.id), { type: "success" });
                } catch (err) {
                  toast(errText(err), { type: "error" });
                }
              }
            })
          ])
        ]);
        listEl.appendChild(row);
      });
    }
  };

  global.Store = Store;
})(typeof globalThis !== "undefined" ? globalThis : this);
