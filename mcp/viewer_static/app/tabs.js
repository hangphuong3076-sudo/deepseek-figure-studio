/* app/tabs.js — 多画布标签页（R3 #5）
 *
 * 每个标签页 = 一个独立 FigureDocument；活动标签 = App.doc = 服务端 current。
 * 切换流程：ViewerBoot.flush() 落盘待发修改 → 取 base_token →
 * POST /api/tabs/{switch,close,new} → App.setDoc(返回 doc, {reason:'tab-switch'})
 * 不触发保存 → ViewerBoot.adoptServerDoc(doc, save_token) 采用新基准。
 * 409 → 错误提示并留在当前标签；ViewerBoot 处于 save_conflict 锁定态时
 * 所有标签操作禁用（tooltip 显示原因）。
 *
 * 重命名：双击标签 → set_doc_title op（R4 新增，可撤销）；非活动标签先切换。
 * 「已关闭」：GET /api/tabs/closed 列归档，POST /api/tabs/restore 还原。
 */
(function (global) {
  "use strict";

  var state = {
    tabs: [],          // [{id,title,elements,updated}]
    activeId: null,
    mounted: false,
    busy: false,
    renamingId: null,  // 正在内联改名的标签 id
    renamingValue: null,  // 改名草稿：render 重建输入框时保留已输入内容
    renamePending: null,  // 已受理、等待切换完成的改名目标（防双击/dblclick 重复触发）
    closedOpen: false, // 「已关闭」弹出层是否展开
    closedList: null   // 最近一次 /api/tabs/closed 结果
  };

  function has(name) { return typeof global[name] !== "undefined" && global[name]; }
  function toast(text, opts) {
    if (has("Ui") && typeof Ui.toast === "function") Ui.toast(text, opts || {});
  }
  function errText(e) { return (e && e.message) ? String(e.message) : String(e); }
  function h(tag, attrs, kids) {
    return global.Ui.h(tag, attrs, kids);
  }

  function currentDocId() {
    return (has("App") && App.doc && typeof App.doc.id === "string") ? App.doc.id : null;
  }

  function conflictLocked() {
    return has("ViewerBoot") && typeof ViewerBoot.hasConflict === "function" &&
      ViewerBoot.hasConflict();
  }

  function conflictTitle() {
    return conflictLocked()
      ? "保存冲突未解决：请先在「历史」导出备份并刷新核对，标签操作已禁用"
      : "";
  }

  // ------------------------------------------------------------------
  // 服务端调用
  // ------------------------------------------------------------------

  function api(path, payload) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok || !j || j.ok !== true) {
          var err = new Error((j && j.error) ? String(j.error) : ("HTTP " + res.status));
          err.status = res.status;
          err.payload = j || null;
          throw err;
        }
        return j;
      });
    });
  }

  function refresh(retries) {
    if (typeof fetch !== "function") return Promise.resolve(null);
    return fetch("/api/tabs", { cache: "no-store" }).then(function (res) {
      return res.json();
    }).then(function (j) {
      if (j && j.ok) {
        state.tabs = Array.isArray(j.tabs) ? j.tabs : [];
        state.activeId = j.active_id || null;
        render();
        // 首次保存还在 autosave 防抖路上：服务端尚无 current 文档，
        // tabs 为空。短暂重试让标签栏在保存落盘后自行出现。
        if (!state.tabs.length && currentDocId() && (retries || 0) < 4) {
          setTimeout(function () { refresh((retries || 0) + 1); }, 800);
        }
      }
      return j;
    }).catch(function () { return null; });
  }

  // ------------------------------------------------------------------
  // 切换后公共收尾：清选择/图表部件/悬停、作废 AI 方案、刷新面板
  // ------------------------------------------------------------------

  function afterSwitch(doc, title) {
    var A = global.App;
    if (A && typeof A.clearSelection === "function") A.clearSelection();
    if (A && A.ui) { A.ui.chartPart = null; A.ui.hover = null; }
    if (has("AiPanel")) {
      if (typeof AiPanel.hasPendingWork === "function" && AiPanel.hasPendingWork()) {
        AiPanel.discardPending("已切换到画布「" + (title || "未命名画布") +
          "」，上一份未执行的方案已作废。");
      }
      if (typeof AiPanel.clearAnchorRefs === "function") AiPanel.clearAnchorRefs();
    }
    if (has("History") && typeof History.refresh === "function") History.refresh();
    if (has("Layers") && typeof Layers.refresh === "function") Layers.refresh();
    if (has("Props") && typeof Props.refresh === "function") Props.refresh();
  }

  function adoptAndPaint(j, reason) {
    var A = global.App;
    if (!A || typeof A.setDoc !== "function" || !j || !j.doc) return;
    A.setDoc(j.doc, { reason: reason || "tab-switch" });
    if (has("ViewerBoot") && typeof ViewerBoot.adoptServerDoc === "function") {
      ViewerBoot.adoptServerDoc(j.doc, j.save_token);
    }
    // 服务端返回的 tabs/active 即权威状态，直接采用避免多一次 GET
    if (Array.isArray(j.tabs)) state.tabs = j.tabs;
    state.activeId = j.active_id || (j.doc && j.doc.id) || state.activeId;
    var t = state.tabs.filter(function (x) { return x.id === state.activeId; })[0];
    afterSwitch(j.doc, t ? t.title : "");
    render();
  }

  // ------------------------------------------------------------------
  // 操作
  // ------------------------------------------------------------------

  function baseToken() {
    return (has("ViewerBoot") && typeof ViewerBoot.baseToken === "function")
      ? ViewerBoot.baseToken() : null;
  }

  function newTab(doc) {
    if (state.busy || conflictLocked()) return Promise.resolve(null);
    state.busy = true;
    render();
    return (has("ViewerBoot") && typeof ViewerBoot.flush === "function"
      ? ViewerBoot.flush() : Promise.resolve())
      .then(function () {
        return api("/api/tabs/new", { doc: doc, base_token: baseToken() });
      })
      .then(function (j) {
        adoptAndPaint(j, "tab-new");
        toast("已新建画布标签页");
        return j;
      })
      .catch(function (err) {
        if (err && err.status === 409) {
          toast("标签操作冲突：服务端文档已更新，请刷新后重试", { type: "error" });
        } else {
          toast("新建标签页失败：" + errText(err), { type: "error" });
        }
        refresh();
        return null;
      })
      .finally(function () { state.busy = false; render(); });
  }

  function switchTab(toId) {
    if (state.busy || conflictLocked() || !toId ||
        toId === state.activeId || toId === currentDocId()) {
      return Promise.resolve(null);
    }
    state.busy = true;
    render();
    return (has("ViewerBoot") && typeof ViewerBoot.flush === "function"
      ? ViewerBoot.flush() : Promise.resolve())
      .then(function () {
        return api("/api/tabs/switch", { to_id: toId, base_token: baseToken() });
      })
      .then(function (j) {
        adoptAndPaint(j, "tab-switch");
        return j;
      })
      .catch(function (err) {
        if (err && err.status === 409) {
          toast("标签切换冲突：服务端文档已更新，请刷新后重试", { type: "error" });
        } else {
          toast("切换标签页失败：" + errText(err), { type: "error" });
        }
        refresh();
        return null;
      })
      .finally(function () { state.busy = false; render(); });
  }

  function closeTab(tabId) {
    if (state.busy || conflictLocked() || !tabId) return Promise.resolve(null);
    if (state.tabs.length <= 1) {
      toast("至少需要保留一个画布标签页", { type: "info" });
      return Promise.resolve(null);
    }
    state.busy = true;
    render();
    return (has("ViewerBoot") && typeof ViewerBoot.flush === "function"
      ? ViewerBoot.flush() : Promise.resolve())
      .then(function () {
        return api("/api/tabs/close", { id: tabId, base_token: baseToken() });
      })
      .then(function (j) {
        // 只关掉非活动标签时当前文档没变：不重铺画布、不清选择、
        // 不作废 AI 方案——仅同步标签列表。
        var prevId = currentDocId();
        var newDocId = j && j.doc ? j.doc.id : null;
        if (newDocId && newDocId !== prevId) {
          adoptAndPaint(j, "tab-close");
        } else {
          if (j && Array.isArray(j.tabs)) state.tabs = j.tabs;
          state.activeId = (j && j.active_id) || state.activeId;
          render();
        }
        toast("已关闭画布标签页（已归档）");
        refreshClosed();
        return j;
      })
      .catch(function (err) {
        toast("关闭标签页失败：" + errText(err), { type: "error" });
        refresh();
        return null;
      })
      .finally(function () { state.busy = false; render(); });
  }

  // 新建空标签：沿用当前画布尺寸/dpi/背景，标题取最小未用的「画布 N」。
  function newEmptyTab() {
    if (!has("FigDoc") || typeof FigDoc.create !== "function") {
      toast("缺少文档工厂，无法新建标签页", { type: "error" });
      return Promise.resolve(null);
    }
    var cur = has("App") ? App.doc : null;
    var c = (cur && cur.canvas) || {};
    return refresh().then(function () {
      var used = {};
      (state.tabs || []).forEach(function (t) {
        var m = /^画布 (\d+)$/.exec(String((t && t.title) || ""));
        if (m) used[Number(m[1])] = true;
      });
      var n = 1;
      while (used[n]) n++;
      var doc = FigDoc.create({
        app: "figure-app", app_version: "1.0",
        width_mm: c.width_mm, height_mm: c.height_mm,
        dpi: c.dpi, background: c.background,
        title: "画布 " + n
      });
      return newTab(doc);
    });
  }

  // 工程面板「打开」的标签判定在 Store.open 内完成（已开标签→switchTab，
  // 否则把工程文档作为新标签 tabs/new 打开），此处不再单独导出。

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

  function tabTitle(t) {
    return (t && t.title) ? String(t.title) : "未命名画布";
  }

  // 活动标签的标题以 App.doc.title 为准（改名 commit 后立刻可见，
  // 服务端 tabs 列表要等下次保存/刷新才更新）。
  function effTabTitle(t, isActive) {
    if (isActive && has("App") && App.doc &&
        typeof App.doc.title === "string") {
      return App.doc.title || "未命名画布";
    }
    return tabTitle(t);
  }

  // ------------------------------------------------------------------
  // 重命名（set_doc_title，走正常 commit → 历史/撤销/保存全通）
  // ------------------------------------------------------------------

  function startRename(t) {
    if (!t || conflictLocked()) return;
    if (state.renamingId === t.id || state.renamePending === t.id) return;
    state.renamePending = t.id;
    state.renamingValue = null;
    var release = function () {
      if (state.renamePending === t.id) state.renamePending = null;
    };
    var enterRename = function () {
      state.renamingId = t.id;
      render();
      focusRename();
    };
    var tryStart = function () {
      if (state.busy) { setTimeout(tryStart, 60); return; }
      var isActive = t.id === state.activeId || t.id === currentDocId();
      if (!isActive) {
        // 非活动标签：先切换，成功（或发现已是活动）后再进入改名
        switchTab(t.id).then(function (j) {
          release();
          var nowActive = t.id === state.activeId || t.id === currentDocId();
          if (j || nowActive) enterRename();
        });
        return;
      }
      release();
      enterRename();
    };
    tryStart();
  }

  function focusRename() {
    var inp = document.querySelector("#tab-bar .tab-rename");
    if (inp) { inp.focus(); inp.select(); }
  }

  // commit=false 取消；renamingId 先清空，Enter 提交后 blur 重入直接返回。
  function finishRename(commit, value) {
    if (!state.renamingId) return;
    state.renamingId = null;
    state.renamingValue = null;
    value = String(value || "").trim();
    if (commit && value && has("App") && typeof App.commit === "function") {
      try {
        App.commit([{ op: "set_doc_title", title: value }],
          { label: "重命名画布", source: "user" });
      } catch (e) {
        toast("重命名失败：" + errText(e), { type: "error" });
      }
    }
    render();
  }

  // ------------------------------------------------------------------
  // 「已关闭」归档列表与还原
  // ------------------------------------------------------------------

  function refreshClosed() {
    if (typeof fetch !== "function") return Promise.resolve(null);
    return fetch("/api/tabs/closed", { cache: "no-store" }).then(function (res) {
      return res.json();
    }).then(function (j) {
      if (j && j.ok) {
        state.closedList = Array.isArray(j.closed) ? j.closed : [];
        render();
      }
      return j;
    }).catch(function () { return null; });
  }

  function closedCount() {
    return state.closedList ? state.closedList.length : null;
  }

  function restoreTab(file) {
    if (state.busy || conflictLocked() || !file) return Promise.resolve(null);
    state.busy = true;
    render();
    return (has("ViewerBoot") && typeof ViewerBoot.flush === "function"
      ? ViewerBoot.flush() : Promise.resolve())
      .then(function () {
        return api("/api/tabs/restore", { file: file, base_token: baseToken() });
      })
      .then(function (j) {
        adoptAndPaint(j, "tab-restore");
        state.closedOpen = false;
        toast("已还原画布标签页");
        refreshClosed();
        return j;
      })
      .catch(function (err) {
        if (err && err.status === 409) {
          toast("标签操作冲突：服务端文档已更新，请刷新后重试", { type: "error" });
        } else {
          toast("还原标签页失败：" + errText(err), { type: "error" });
        }
        refresh();
        return null;
      })
      .finally(function () { state.busy = false; render(); });
  }

  function fmtClosedAt(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  var _closedDocClose = null;
  function closeClosedPop() {
    state.closedOpen = false;
    if (_closedDocClose) {
      document.removeEventListener("mousedown", _closedDocClose, true);
      _closedDocClose = null;
    }
    render();
  }

  function toggleClosedPop() {
    if (state.closedOpen) { closeClosedPop(); return; }
    state.closedOpen = true;
    render();
    refreshClosed();
    // 点击弹出层/按钮之外时关闭
    _closedDocClose = function (ev) {
      var pop = document.querySelector("#tab-bar .tab-closed-pop");
      var btn = document.getElementById("tab-closed");
      if (pop && pop.contains(ev.target)) return;
      if (btn && btn.contains(ev.target)) return;
      closeClosedPop();
    };
    document.addEventListener("mousedown", _closedDocClose, true);
  }

  function renderClosedPop(bar) {
    if (!state.closedOpen) return;
    var list = state.closedList || [];
    var kids = [h("div", { class: "tab-closed-head" }, [
      h("span", { class: "tab-closed-title", text: "已关闭的画布" }),
      h("button", {
        class: "tab-closed-x", title: "收起", "aria-label": "收起已关闭列表",
        onclick: function () { closeClosedPop(); }
      }, [h("span", { text: "×" })])
    ])];
    if (!list.length) {
      kids.push(h("div", { class: "tab-closed-empty", text: "没有已关闭的画布" }));
    } else {
      list.forEach(function (c) {
        var meta = [];
        if (c.closed_at) meta.push(fmtClosedAt(c.closed_at));
        meta.push((typeof c.elements === "number" ? c.elements : 0) + " 个元素");
        var item = h("button", {
          class: "tab-closed-item",
          title: "还原「" + tabTitle({ title: c.title }) + "」",
          disabled: state.busy || conflictLocked() ? "disabled" : null,
          onclick: function () { restoreTab(c.file); }
        }, [
          h("span", { class: "tab-closed-name", text: tabTitle({ title: c.title }) }),
          h("span", { class: "tab-closed-meta", text: meta.join(" · ") })
        ]);
        kids.push(item);
      });
    }
    var pop = h("div", { class: "tab-closed-pop" }, kids);
    bar.appendChild(pop);
    // fixed 定位（#tab-bar 有 overflow 裁剪），每次 render 按按钮位置重算
    var cbtn = document.getElementById("tab-closed");
    if (cbtn) {
      var r = cbtn.getBoundingClientRect();
      pop.style.top = (r.bottom + 4) + "px";
      pop.style.left = Math.max(8, r.right - 320) + "px";
    }
  }

  function render() {
    var bar = document.getElementById("tab-bar");
    if (!bar) return;
    var locked = conflictLocked();
    var tip = conflictTitle();
    bar.innerHTML = "";
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "画布标签页");
    state.tabs.forEach(function (t) {
      var isActive = t.id === state.activeId || t.id === currentDocId();
      var title = effTabTitle(t, isActive);
      var labelKids;
      if (state.renamingId === t.id) {
        // 改名时预填真实标题；「未命名画布」只是显示回退，预填空串
        var rawTitle = (isActive && has("App") && App.doc &&
          typeof App.doc.title === "string") ? App.doc.title : (t.title || "");
        // render() 会整体重建标签栏：已输入内容存草稿，重建后由
        // 文末 focusRename 重新聚焦，避免改名被无关刷新打断。
        var draft = state.renamingValue != null ? state.renamingValue : rawTitle;
        var inp = h("input", {
          class: "tab-rename", type: "text", value: draft,
          "aria-label": "重命名画布", maxlength: "120"
        });
        inp.addEventListener("input", function () {
          state.renamingValue = inp.value;
        });
        inp.addEventListener("keydown", function (ev) {
          ev.stopPropagation();
          if (ev.key === "Enter") finishRename(true, inp.value);
          else if (ev.key === "Escape") finishRename(false);
        });
        inp.addEventListener("blur", function () {
          if (state.renamingId !== t.id) return;
          // render() 拆掉旧输入框也会触发 blur——此时不是用户提交，
          // 保留 renamingId，由新输入框继续改名。
          if (!inp.isConnected) return;
          finishRename(true, inp.value);
        });
        labelKids = [inp];
      } else {
        labelKids = [h("span", { class: "tab-label", text: title })];
      }
      var label = h("button", {
        class: "tab-item" + (isActive ? " active" : ""),
        role: "tab",
        "aria-selected": isActive ? "true" : "false",
        title: tip || title,
        // busy 时保持可点：双击改名的第二击可能落在切换进行中，
        // disabled 会让 click/dblclick 事件根本不派发；
        // 具体操作（switch/close）内部已有 busy 守卫。
        disabled: locked ? "disabled" : null
      }, labelKids);
      label.addEventListener("click", function (ev) {
        // 双击的第二击（detail>1）不再触发切换，改走改名流程；
        // 标签名在 busy 期间保持可点（见 render 的 disabled），
        // 否则切换中的标签会吞掉 dblclick，非活动标签无法改名。
        if (ev.detail > 1) { startRename(t); return; }
        switchTab(t.id);
      });
      label.addEventListener("dblclick", function () { startRename(t); });
      var x = h("button", {
        class: "tab-close",
        title: locked ? tip : "关闭这个画布标签页（可从「已关闭」找回）",
        "aria-label": "关闭标签页",
        disabled: locked || state.busy ? "disabled" : null
      }, [h("span", { text: "×" })]);
      x.addEventListener("click", function (ev) {
        ev.stopPropagation();
        closeTab(t.id);
      });
      bar.appendChild(h("div", { class: "tab-wrap" + (isActive ? " active" : "") },
        [label, x]));
    });
    var plus = h("button", {
      id: "tab-new",
      class: "tab-new",
      title: locked ? tip : "新建画布标签页",
      "aria-label": "新建画布标签页",
      disabled: locked || state.busy ? "disabled" : null
    }, [h("span", { text: "+" })]);
    plus.addEventListener("click", function () { newEmptyTab(); });
    bar.appendChild(plus);
    // 「已关闭」归档入口：列表为空或冲突锁定时禁用
    var closedBtn = h("button", {
      id: "tab-closed",
      class: "tab-closed",
      title: locked ? tip : "查看已关闭的画布标签页（可还原）",
      "aria-label": "已关闭的画布",
      disabled: (locked || state.busy || closedCount() === 0) ? "disabled" : null
    }, [h("span", { text: "已关闭" })]);
    closedBtn.addEventListener("click", function () { toggleClosedPop(); });
    bar.appendChild(closedBtn);
    renderClosedPop(bar);
    // 改名中被无关 render 重建时，把焦点还给新输入框
    if (state.renamingId) focusRename();
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    render();
    refresh();
    refreshClosed();
    // 文档被 MCP/外部整体替换（doc id 变化）后标签列表可能过期；
    // 普通编辑不触发网络刷新，仅在 id 不一致时惰性拉取。
    if (has("App") && typeof App.on === "function") {
      App.on("doc:changed", function () {
        var cid = currentDocId();
        if (cid && cid !== state.activeId) refresh();
        else render();
      });
    }
  }

  global.Tabs = {
    mount: mount,
    refresh: refresh,
    render: render,
    newTab: newTab,
    newEmptyTab: newEmptyTab,
    switchTab: switchTab,
    closeTab: closeTab,
    restoreTab: restoreTab,
    refreshClosed: refreshClosed,
    // file:// 或无 fetch 环境没有 /api/tabs，调用方应回退旧路径
    available: function () {
      return typeof fetch === "function" &&
        typeof location !== "undefined" &&
        /^https?:$/.test(location.protocol);
    },
    state: state
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
