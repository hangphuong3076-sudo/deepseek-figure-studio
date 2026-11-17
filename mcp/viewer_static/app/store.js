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
  var openPromise = null;   // adapter.open() 的在途 Promise；open 完成前 mode 仍为 null
  var listEl = null;        // recent-projects list container

  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  function requireKernel() {
    if (!global.FigStore || typeof global.FigStore.use !== "function") {
      throw new Error("工程存储：缺少存储内核");
    }
  }

  function requireAttached() {
    if (!adapter) {
      throw new Error("Store: 本地存储尚未初始化，请先调用 Store.attach()");
    }
  }

  // adapter 在 attach() 里同步赋值、open() 异步完成；open 完成前
  // adapter.mode 仍为 null，任何 FigStore 读写都会抛「尚未 open()」。
  // 所有对外操作先 await ready()，等 open 落定再碰存储。
  function ready() {
    requireAttached();
    return openPromise || Promise.resolve();
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
      openPromise = adapter.open(); // "indexeddb" | "localstorage"
      try {
        var mode = await openPromise;
      } catch (err) {
        // open 失败：列表区显示不可用原因（refreshList 内部 await ready() 会拿到同一拒绝）
        Store.refreshList();
        throw err;
      }
      Store.refreshList(); // open 落定后刷新一次，修掉 mount 早于 open 的竞态
      return mode;
    },

    attached: function () {
      return !!adapter;
    },

    save: async function (opts) {
      await ready();
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
      await ready();
      requireDoc();
      if (!global.FigDoc) {
        throw new Error("另存为：缺少文档内核");
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
      await ready();
      if (id === undefined || id === null) {
        return Store.pickAndOpen();
      }
      if (typeof id !== "string" || !id) {
        throw new Error("Store.open: id 必须是非空字符串");
      }
      var useTabs = global.Tabs && typeof Tabs.available === "function" &&
        Tabs.available() && typeof Tabs.switchTab === "function";
      if (useTabs) {
        try { await Tabs.refresh(); } catch (e) { /* 列表过期不影响判断 */ }
        var openTabs = (Tabs.state && Tabs.state.tabs) || [];
        for (var ti = 0; ti < openTabs.length; ti++) {
          if (openTabs[ti].id === id) {
            var sw = await Tabs.switchTab(id);
            if (sw) {
              global.App.status("已切换到画布标签页");
              Store.refreshList();
              return global.App.doc;
            }
            break; // 切换失败（409/网络）：不再重复尝试，走新标签路径
          }
        }
      }
      var project = await global.FigStore.loadProject(id);
      if (!project) {
        throw new Error("Store.open: 找不到工程 \"" + id + "\"");
      }
      var doc = global.FigStore.docFromProject(project);
      // R3 #5：查看器在线时把工程作为一个新画布标签页打开；
      // file:// 等无服务环境维持原「替换当前文档」行为。
      if (useTabs && doc && typeof Tabs.newTab === "function") {
        var j = await Tabs.newTab(doc);
        if (j) {
          global.App.status("已在新标签页打开：" + docTitle(doc));
          Store.refreshList();
          return global.App.doc;
        }
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
      await ready();
      var summaries = await Store.list();
      if (!summaries.length) {
        toast("还没有保存过工程。先点「保存」，之后可以在这里重新打开；也可以用「导入工程文件」打开 *.figureproj.json。", { type: "info" });
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
        throw new Error("新建工程：编辑器尚未就绪");
      }
      // R3 #5：有查看器服务时「新建」= 新建一个空画布标签页，
      // 不再替换当前文档（无破坏性确认）。
      if (global.Tabs && typeof Tabs.newEmptyTab === "function" &&
          typeof Tabs.available === "function" && Tabs.available()) {
        var j = await Tabs.newEmptyTab();
        if (j) {
          global.App.status("已新建画布标签页");
          Store.refreshList();
          return global.App.doc;
        }
        return null; // 冲突/失败：留在当前标签，不做破坏性替换
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
      await ready();
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
      await ready();
      var summaries = await global.FigStore.listProjects();
      summaries = (summaries || []).slice().sort(function (a, b) {
        var ta = a && a.updated ? a.updated : "";
        var tb = b && b.updated ? b.updated : "";
        return tb.localeCompare(ta);
      });
      return summaries;
    },

    deleteProject: async function (id) {
      await ready();
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

      // 术语说明（R03）：工程=完整可再编辑存档；投稿图像用顶栏「导出」
      panelEl.appendChild(global.Ui.h("div", {
        style: "font-size:11px;color:#5b6472;line-height:1.6;margin:2px 0 8px;white-space:normal;",
        text: "「工程」= 完整可再编辑的存档（当前文档 + 全部修改历史 + 数据来源，"
          + "即 *.figureproj.json 文件），用于以后重开继续改。"
          + "投稿/插图用的图像（PNG/PDF/SVG/TIFF）请点顶栏「导出」。"
      }));

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
      // R09：导出/导入工程文件按钮复用「历史」页能力，入口就近放在工程页
      btnRow.appendChild(global.Ui.button({
        label: "导出工程文件",
        title: "下载 *.figureproj.json（文档+全部历史；受限窗口若下载不落地，"
          + "可到工程数据目录直接取文件）",
        onClick: function () {
          if (global.History && typeof global.History.exportProject === "function") {
            global.History.exportProject();
          } else {
            toast("缺少 History.exportProject，请刷新页面", { type: "error" });
          }
        }
      }));
      btnRow.appendChild(global.Ui.button({
        label: "导入工程文件",
        title: "从 *.figureproj.json 恢复（替换当前文档，历史随文件恢复）",
        onClick: function () {
          var input = document.createElement("input");
          input.type = "file";
          input.accept = ".json,application/json,.figureproj.json";
          input.style.display = "none";
          input.addEventListener("change", function () {
            if (input.parentNode) input.parentNode.removeChild(input);
            var file = input.files && input.files[0];
            if (!file) return;
            if (global.History && typeof global.History.importProject === "function") {
              global.History.importProject(file).catch(function (err) {
                toast("导入工程失败：" + errText(err), { type: "error" });
              });
            }
          });
          document.body.appendChild(input);
          input.click();
        }
      }));
      panelEl.appendChild(btnRow);

      // 数据目录路径（R08）：让用户知道工程文件实际存在哪里
      var dirLine = global.Ui.h("div", {
        style: "font-size:11px;color:#6b7280;margin:6px 0 0;line-height:1.5;word-break:break-all;",
        text: "正在查询工程数据目录…"
      });
      panelEl.appendChild(dirLine);
      if (typeof global.fetch === "function") {
        global.fetch("/api/data-dirs", { cache: "no-store" })
          .then(function (r) { return r && r.ok ? r.json() : null; })
          .then(function (j) {
            if (!j || j.ok !== true) {
              dirLine.textContent = "数据目录查询失败（不影响使用）";
              return;
            }
            dirLine.textContent = "工程保存在本机：" + j.data_dir +
              "（当前文档自动保存于 projects/current.figureproj.json）";
            // R08：旧版内嵌工程目录有待迁移清单时给出显式复制入口
            // （只复制不移动、冲突不覆盖、原文件保留；迁移走 loopback POST）。
            var pending = Array.isArray(j.legacy_pending_migration)
              ? j.legacy_pending_migration : [];
            if (!pending.length) return;
            var migLine = global.Ui.h("div", {
              style: "font-size:11px;color:#6b7280;margin:6px 0 0;line-height:1.5;word-break:break-all;",
              text: "发现 " + pending.length + " 个旧版工程（" +
                (j.legacy_project_dir || "") + "），原文件会保留"
            });
            var migBtn = global.Ui.button({
              label: "复制旧工程到当前目录",
              title: "把旧目录中的工程复制到当前数据目录（同名冲突不覆盖，原文件保留）",
              onClick: function () {
                migBtn.disabled = true;
                global.fetch("/api/projects/migrate", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ overwrite: false })
                })
                  .then(function (r) { return r && r.json ? r.json() : null; })
                  .then(function (res) {
                    if (!res || res.ok !== true) {
                      migLine.textContent = "迁移失败：" +
                        ((res && res.error) || "服务无响应");
                      migBtn.disabled = false;
                      return;
                    }
                    var conflicts = Array.isArray(res.conflicts) ? res.conflicts : [];
                    var names = conflicts.map(function (c) {
                      return c && c.name;
                    }).filter(function (n) { return !!n; });
                    migLine.textContent = "已复制 " + (res.copied || 0) +
                      " 个；相同已跳过 " + (res.skipped_identical || 0) +
                      " 个；同名冲突未覆盖 " + conflicts.length + " 个" +
                      (names.length ? "（" + names.join("、") + "）" : "") +
                      "；无效 " +
                      (Array.isArray(res.invalid) ? res.invalid.length : 0) + " 个";
                    Store.refreshList();
                  })
                  .catch(function (err) {
                    migLine.textContent = "迁移失败：" + errText(err);
                    migBtn.disabled = false;
                  });
              }
            });
            panelEl.appendChild(migLine);
            panelEl.appendChild(global.Ui.h("div", {
              style: "margin:4px 0 0;"
            }, [migBtn]));
          })
          .catch(function () {
            dirLine.textContent = "数据目录查询失败（不影响使用）";
          });
      }

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
      try {
        await ready(); // 等 adapter.open() 落定；失败走「本机存储不可用」
      } catch (err) {
        listEl.textContent = "本机存储不可用：" + errText(err) +
          "。仍可用「导出工程文件」保存到磁盘。";
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
