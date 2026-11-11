/*
 * App — global state & event bus for the v1 web app (app/state.js)
 *
 * Loaded FIRST among app/ scripts (see APP-API.md). Exposes `globalThis.App`:
 *   App.doc            current FigureDocument (single source of truth; null until
 *                      main.js creates the initial document and calls setDoc)
 *   App.selectionSet   Set<string> of selected element ids
 *   App.ui             { tool, zoom, showGuides, snap, activeTab }
 *   App.stage          canvas stage info { svgEl, overlayEl, pxPerMm, origin,
 *                      screenToMm(evt), mmToScreen(pt) } — written by Editor.mount
 *   App.on / App.emit  event bus; fixed event names only:
 *                      doc:changed, selection:changed, ui:changed, history:changed,
 *                      status, error, anchors:changed
 *   App.setDoc(doc, {reason})              immediate low-level publication (boot);
 *                                          captures a real history origin when absent
 *   App.publishDoc(docOrFactory, options)  awaitable, serialized publication
 *   App.commit(ops, {label, source})       async; the EditOp entry point
 *   App.selection() / App.select(ids) / App.toggleSelect(id) / App.clearSelection()
 *   App.status(text) / App.error(text)
 *   App.currentJournal() / App.canvas()
 *   App.setUi(patch)                   merge into App.ui + emit "ui:changed"
 *   App._markAutosaved()               internal; called by Store.autosave()
 *
 * App.commit serializes its complete document critical section:
 *   1. Read the latest doc and run FigOps.validateAll; on failure report the
 *      first error and change nothing.
 *   2. FigOps.applyAll(..., {ts, checkpoint:false}) -> new doc; a true no-op
 *      returns the current doc immediately, without finalization or events.
 *   3. For a real change, await FigOps.finalizeHistory(doc, latestRev) to fill
 *      doc_sha256, then App.setDoc + emit "history:changed".
 *   4. Release the document queue, then auto-snapshot via Store.autosave()
 *      every 10 actual commits or >2 minutes.
 *
 * App.publishDoc uses the same queue for undo/redo/restore and direct document
 * replacement. A factory receives the doc current at execution time, never the
 * stale doc visible when the operation was requested. Set finalizeHistory:true
 * for history records whose doc_sha256 still needs backfilling. Queue failures
 * reject only their own caller and do not poison later transactions.
 */
(function (global) {
  "use strict";

  // Fixed event names (APP-API.md). Emitting/subscribing to anything else throws.
  var EVENT_NAMES = [
    "doc:changed", "selection:changed", "ui:changed", "history:changed",
    "status", "error", "anchors:changed"
  ];

  var AUTOSAVE_EVERY_N_COMMITS = 10;
  var AUTOSAVE_INTERVAL_MS = 2 * 60 * 1000; // >2 minutes since last snapshot

  var listeners = {};            // eventName -> Set<handler>
  var commitsSinceSnapshot = 0;
  var lastSnapshotAt = Date.now();
  var docQueue = Promise.resolve();

  function assertEventName(name, fnName) {
    if (typeof name !== "string" || EVENT_NAMES.indexOf(name) < 0) {
      throw new Error("App." + fnName + ": 未知事件名 \"" + name +
        "\"，允许的事件：" + EVENT_NAMES.join("、"));
    }
  }

  function assertDoc() {
    if (!App.doc || typeof App.doc !== "object") {
      throw new Error("App: 文档尚未初始化，请先通过 App.setDoc() 载入文档");
    }
  }

  function assertDocValue(doc, caller) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(caller + ": doc 必须是文档对象");
    }
  }

  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  function enqueueDoc(task) {
    var result = docQueue.then(task);
    // Keep the internal tail fulfilled while preserving this task's rejection
    // for its own caller. Later edits must remain usable after any failure.
    docQueue = result.then(function () {}, function () {});
    return result;
  }

  var App = {
    doc: null,
    selectionSet: new Set(),

    ui: {
      tool: "select",
      zoom: 1,
      showGuides: true,
      snap: true,
      activeTab: "ai"
    },

    // Default stage values; Editor.mount overwrites svgEl/overlayEl/pxPerMm and
    // typically replaces screenToMm/mmToScreen with rect-based implementations.
    stage: {
      svgEl: null,
      overlayEl: null,
      pxPerMm: 96 / 25.4,
      origin: { x: 0, y: 0 },
      screenToMm: function (evt) {
        var x = evt && typeof evt.clientX === "number" ? evt.clientX : 0;
        var y = evt && typeof evt.clientY === "number" ? evt.clientY : 0;
        var st = App.stage;
        return {
          x_mm: (x - st.origin.x) / st.pxPerMm,
          y_mm: (y - st.origin.y) / st.pxPerMm
        };
      },
      mmToScreen: function (pt) {
        var st = App.stage;
        return {
          x: st.origin.x + (pt.x_mm || 0) * st.pxPerMm,
          y: st.origin.y + (pt.y_mm || 0) * st.pxPerMm
        };
      }
    },

    // ------------------------------------------------------------- event bus

    on: function (name, handler) {
      assertEventName(name, "on");
      if (typeof handler !== "function") {
        throw new Error("App.on: handler 必须是函数");
      }
      if (!listeners[name]) listeners[name] = new Set();
      listeners[name].add(handler);
      return function unsubscribe() {
        listeners[name].delete(handler);
      };
    },

    emit: function (name, payload) {
      assertEventName(name, "emit");
      var set = listeners[name];
      if (!set || !set.size) return;
      // Copy so handlers may unsubscribe during dispatch.
      Array.from(set).forEach(function (handler) {
        try {
          handler(payload);
        } catch (err) {
          if (global.console && global.console.error) {
            global.console.error("App.emit: 事件处理出错（" + name + "）：" + errText(err));
          }
        }
      });
    },

    // ------------------------------------------------------------------ doc

    setDoc: function (doc, opts) {
      assertDocValue(doc, "App.setDoc");
      if (!(doc.meta && doc.meta.history_origin) && global.FigOps &&
          typeof global.FigOps.captureHistoryOrigin === "function") {
        doc = global.FigOps.captureHistoryOrigin(doc);
      }
      App.doc = doc;
      // Drop selection ids that no longer exist in the new document.
      var alive = null;
      Array.from(App.selectionSet).forEach(function (id) {
        if (!alive) {
          alive = {};
          if (global.FigDoc && typeof global.FigDoc.get === "function") {
            Array.from(App.selectionSet).forEach(function (eid) {
              alive[eid] = !!global.FigDoc.get(doc, eid);
            });
          }
        }
        if (alive[id] === false) App.selectionSet.delete(id);
      });
      App.emit("doc:changed", { doc: doc, reason: opts && opts.reason ? opts.reason : "" });
    },

    publishDoc: function (docOrFactory, opts) {
      opts = opts || {};
      return enqueueDoc(function () {
        var produced;
        try {
          produced = typeof docOrFactory === "function"
            ? docOrFactory(App.doc) : docOrFactory;
        } catch (err) {
          return Promise.reject(err);
        }
        return Promise.resolve(produced).then(function (doc) {
          assertDocValue(doc, "App.publishDoc");
          if (!opts.finalizeHistory) return doc;
          if (!global.FigOps || typeof global.FigOps.finalizeHistory !== "function") {
            throw new Error("App.publishDoc: 缺少 FigOps.finalizeHistory");
          }
          var hist = doc.history || [];
          if (!hist.length) return doc;
          var lastRev = hist[hist.length - 1].rev;
          return global.FigOps.finalizeHistory(doc, lastRev);
        }).then(function (doc) {
          App.setDoc(doc, { reason: opts.reason || "update" });
          if (opts.history !== false) {
            App.emit("history:changed", { doc: doc, reason: opts.reason || "update" });
          }
          return doc;
        });
      });
    },

    commit: function (ops, opts) {
      opts = opts || {};
      var snapshotDue = false;
      var transaction = enqueueDoc(function () {
        assertDoc();
        if (!Array.isArray(ops)) throw new Error("App.commit: ops 必须是 EditOp 数组");
        if (!global.FigOps) throw new Error("App.commit: 缺少内核 FigOps，请先加载 lib/ops.js");

        // Read App.doc only after every earlier document transaction completed.
        var check = global.FigOps.validateAll(ops, App.doc);
        if (!check || !check.ok) {
          var first = check && check.errors && check.errors.length
            ? check.errors[0] : "操作校验失败";
          App.error(first);
          return { doc: App.doc, applied: 0 };
        }

        var result = global.FigOps.applyAll(App.doc, ops, {
          label: typeof opts.label === "string" ? opts.label : "",
          source: typeof opts.source === "string" && opts.source ? opts.source : "user",
          ts: new Date().toISOString(),
          checkpoint: false
        });
        // Some kernel versions return the original doc for a no-op, while
        // others let applied=0 fall through to history finalization. Neither
        // case is a publication: preserve the current history/hash, emit no
        // commit event and never schedule local or server autosave.
        if (result.changed === false || result.applied === 0 || result.doc === App.doc) {
          return {
            doc: App.doc,
            applied: typeof result.applied === "number" ? result.applied : 0
          };
        }
        var hist = result.doc.history || [];
        var lastRev = hist.length ? hist[hist.length - 1].rev : 0;
        return Promise.resolve(global.FigOps.finalizeHistory(result.doc, lastRev))
          .then(function (doc) {
            App.setDoc(doc, { reason: "commit" });
            App.emit("history:changed", { doc: doc, applied: result.applied });

            commitsSinceSnapshot += 1;
            snapshotDue = commitsSinceSnapshot >= AUTOSAVE_EVERY_N_COMMITS ||
              (Date.now() - lastSnapshotAt) > AUTOSAVE_INTERVAL_MS;
            return { doc: doc, applied: result.applied };
          });
      });

      return transaction.then(function (result) {
        if (!snapshotDue) return result;
        var Store = global.Store;
        if (!Store || typeof Store.autosave !== "function") return result;
        return Promise.resolve(Store.autosave()).catch(function (err) {
          App.error("自动快照失败：" + errText(err));
        }).then(function () { return result; });
      });
    },

    // -------------------------------------------------------------- selection

    selection: function () {
      return Array.from(App.selectionSet);
    },

    select: function (ids) {
      if (typeof ids === "string") ids = [ids];
      if (!Array.isArray(ids)) throw new Error("App.select: ids 必须是字符串数组");
      var next = new Set(ids);
      var changed = next.size !== App.selectionSet.size;
      if (!changed) {
        next.forEach(function (id) {
          if (!App.selectionSet.has(id)) changed = true;
        });
      }
      if (!changed) return App.selection();
      App.selectionSet = next;
      App.emit("selection:changed", { ids: Array.from(next) });
      return Array.from(next);
    },

    toggleSelect: function (id) {
      if (typeof id !== "string" || !id) {
        throw new Error("App.toggleSelect: id 必须是非空字符串");
      }
      if (App.selectionSet.has(id)) App.selectionSet.delete(id);
      else App.selectionSet.add(id);
      App.emit("selection:changed", { ids: Array.from(App.selectionSet) });
      return Array.from(App.selectionSet);
    },

    clearSelection: function () {
      if (!App.selectionSet.size) return [];
      App.selectionSet = new Set();
      App.emit("selection:changed", { ids: [] });
      return [];
    },

    // ----------------------------------------------------------------- misc

    status: function (text) {
      App.emit("status", { text: String(text) });
    },

    error: function (text) {
      App.emit("error", { text: String(text) });
    },

    currentJournal: function () {
      if (!App.doc || !App.doc.canvas) return null;
      var pid = App.doc.canvas.journal_preset_id;
      if (!pid || !global.FigPresets || typeof global.FigPresets.journal !== "function") {
        return null;
      }
      return global.FigPresets.journal(pid);
    },

    canvas: function () {
      assertDoc();
      return App.doc.canvas;
    },

    // Merge a patch into App.ui and notify subscribers.
    setUi: function (patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("App.setUi: patch 必须是对象");
      }
      Object.keys(patch).forEach(function (key) { App.ui[key] = patch[key]; });
      App.emit("ui:changed", { ui: App.ui, patch: patch });
      return App.ui;
    },

    // Internal: called by Store.autosave() after a successful snapshot.
    _markAutosaved: function () {
      commitsSinceSnapshot = 0;
      lastSnapshotAt = Date.now();
    },

    _EVENT_NAMES: EVENT_NAMES
  };

  global.App = App;
})(typeof globalThis !== "undefined" ? globalThis : this);
