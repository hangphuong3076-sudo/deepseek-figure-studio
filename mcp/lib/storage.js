/*
 * FigStore — storage.js
 *
 * Project & history persistence layer for the shared figure-editing kernel
 * (v1 / v2 / v3). Pure JS, no build step, no module system, no dependencies.
 * Loaded last in the kernel script order:
 *   figdoc.js -> ops.js -> palette.js -> presets.js -> data.js -> render.js
 *   -> tiff.js -> export.js -> ai.js -> storage.js
 *
 * Public surface (see shared/lib/API.md, frozen v1.0):
 *   FigStore.use(adapter)
 *   FigStore.adapters.localStorage()   IndexedDB (primary) + localStorage (fallback)
 *   FigStore.adapters.http()           POST/GET /api/projects
 *   FigStore.projectFromDoc(doc, {assets})
 *   FigStore.docFromProject(project)
 *   FigStore.snapshot(doc, {label, source, checkpoint})
 *   FigStore.thumbnail(doc)
 *   FigStore.exportProjectFile(doc)
 *   FigStore.importProjectFile(file)
 *   FigStore.MIGRATIONS
 *
 * Adapter contract:
 *   { name, async open(), async saveProject(project), async loadProject(id),
 *     async listProjects(), async deleteProject(id), async saveAsset(name, blob),
 *     async loadAsset(name) }
 * Methods an adapter does not implement resolve to null (never throw).
 */
(function (global) {
    "use strict";

    var FORMAT = "figure-project";
    var FORMAT_VERSION = "1.0";
    var THUMB_WIDTH_PX = 240;
    var THUMB_DPI = 96;
    var IDB_NAME = "figstore";
    var IDB_VERSION = 1;
    var IDB_STORE_PROJECTS = "projects";
    var IDB_STORE_ASSETS = "assets";
    var LS_PREFIX = "figstore.";
    var ADAPTER_METHODS = ["open", "saveProject", "loadProject", "listProjects",
        "deleteProject", "saveAsset", "loadAsset"];

    // ------------------------------------------------------------------ utils

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function cloneJSON(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function errText(err) {
        return err && err.message ? err.message : String(err);
    }

    function requireObject(value, message) {
        if (!isObject(value)) throw new Error(message);
    }

    function requireId(id, fnName) {
        if (typeof id !== "string" || !id) {
            throw new Error("FigStore." + fnName + ": id 必须是非空字符串");
        }
    }

    function requireAssetName(name, fnName) {
        if (typeof name !== "string" || !name) {
            throw new Error("FigStore." + fnName + ": 资产名称必须是非空字符串");
        }
    }

    function requireProject(project, fnName) {
        requireObject(project, "FigStore." + fnName + ": project 必须是工程对象");
        if (!isObject(project.doc) || typeof project.doc.id !== "string" || !project.doc.id) {
            throw new Error("FigStore." + fnName + ": project 缺少 doc.id，无法确定存储键");
        }
    }

    function notOpen() {
        return new Error("FigStore: 存储适配器尚未 open()，或当前存储模式不可用");
    }

    function bytesToBase64(bytes) {
        if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
            return Buffer.from(bytes).toString("base64");
        }
        var chunkSize = 0x8000;
        var binary = "";
        for (var i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        if (typeof btoa !== "function") {
            throw new Error("FigStore: 当前环境缺少 base64 编码能力（Buffer/btoa 均不可用）");
        }
        return btoa(binary);
    }

    function base64ToBytes(base64) {
        if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
            return new Uint8Array(Buffer.from(base64, "base64"));
        }
        if (typeof atob !== "function") {
            throw new Error("FigStore: 当前环境缺少 base64 解码能力（Buffer/atob 均不可用）");
        }
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // Blob -> "data:<mime>;base64,<...>"；字符串原样返回（视为已是 data URL / 文本）。
    async function blobToDataURL(blob) {
        if (typeof blob === "string") return blob;
        if (typeof Blob === "undefined" || !(blob instanceof Blob)) {
            throw new Error("FigStore.saveAsset: 资产数据必须是 Blob 或字符串（data URL）");
        }
        var buffer = await blob.arrayBuffer();
        var mime = blob.type || "application/octet-stream";
        return "data:" + mime + ";base64," + bytesToBase64(new Uint8Array(buffer));
    }

    function dataURLToBlob(dataURL) {
        if (typeof Blob === "undefined") return dataURL;
        var match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataURL);
        if (!match || !match[2]) {
            throw new Error("FigStore: 无法识别的资产 data URL");
        }
        var mime = match[1] || "application/octet-stream";
        return new Blob([base64ToBytes(match[3])], { type: mime });
    }

    // IndexedDB helpers -------------------------------------------------------

    function idbRequest(request) {
        return new Promise(function (resolve, reject) {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () {
                reject(request.error || new Error("IndexedDB 请求失败"));
            };
        });
    }

    function idbTxComplete(tx) {
        return new Promise(function (resolve, reject) {
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error || new Error("IndexedDB 事务失败")); };
            tx.onabort = function () { reject(tx.error || new Error("IndexedDB 事务中止")); };
        });
    }

    function openIDB() {
        return new Promise(function (resolve, reject) {
            var request = global.indexedDB.open(IDB_NAME, IDB_VERSION);
            request.onupgradeneeded = function (event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE_PROJECTS)) {
                    db.createObjectStore(IDB_STORE_PROJECTS, { keyPath: "doc.id" });
                }
                if (!db.objectStoreNames.contains(IDB_STORE_ASSETS)) {
                    db.createObjectStore(IDB_STORE_ASSETS);
                }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () {
                reject(request.error || new Error("打开 IndexedDB 失败"));
            };
            request.onblocked = function () {
                reject(new Error("打开 IndexedDB 被阻塞：请关闭占用该数据库的其他页面后重试"));
            };
        });
    }

    // -------------------------------------------------------------- migrations

    var MIGRATIONS = {
        // "1.0" is the baseline format; the identity migration documents that.
        "1.0": function (project) { return project; }
    };

    function migrateProject(project) {
        requireObject(project, "FigStore.importProjectFile: 不是有效的 figure-project 工程文件");
        if (project.format !== FORMAT) {
            throw new Error("FigStore.importProjectFile: 不是有效的 figure-project 工程文件（format=\"" +
                (project && project.format) + "\"）");
        }
        if (typeof project.format_version !== "string" || !project.format_version) {
            throw new Error("FigStore.importProjectFile: 工程文件缺少 format_version 字段");
        }
        var version = project.format_version;
        if (!Object.prototype.hasOwnProperty.call(MIGRATIONS, version)) {
            throw new Error("FigStore.importProjectFile: 不支持的项目格式版本 \"" + version + "\"");
        }
        var versions = Object.keys(MIGRATIONS).sort();
        var latest = versions[versions.length - 1];
        var guard = 0;
        while (version !== latest) {
            project = MIGRATIONS[version](project);
            if (!isObject(project) || typeof project.format_version !== "string") {
                throw new Error("FigStore.importProjectFile: 迁移函数未返回有效的工程对象");
            }
            version = project.format_version;
            if (!Object.prototype.hasOwnProperty.call(MIGRATIONS, version)) {
                throw new Error("FigStore.importProjectFile: 迁移链出现未知版本 \"" + version + "\"");
            }
            if (++guard > 64) {
                throw new Error("FigStore.importProjectFile: 迁移链异常（疑似死循环）");
            }
        }
        return project;
    }

    // ------------------------------------------------------------- FigStore API

    // Keep one durable replay base in meta. Legacy files are initialized at
    // their actual current content playhead, never mislabeled as revision 0.
    function initializeHistoryOrigin(doc) {
        if (!isObject(doc) || (isObject(doc.meta) && doc.meta.history_origin) ||
            !global.FigOps || typeof global.FigOps.captureHistoryOrigin !== "function") {
            return doc;
        }
        var initialized = global.FigOps.captureHistoryOrigin(doc);
        doc.meta = isObject(doc.meta) ? doc.meta : {};
        doc.meta.history_origin = cloneJSON(initialized.meta.history_origin);
        return doc;
    }

    function isLegacySaveRecord(rec) {
        // Storage's old snapshots had no content op. Real edits remain pinned
        // checkpoints and must never be reclassified as save bookkeeping.
        return isObject(rec) && rec.kind !== "revert" &&
            Array.isArray(rec.ops) && rec.ops.length === 0;
    }

    function boundedLegacyMetadata(doc, records) {
        var previous = isObject(doc.meta) && isObject(doc.meta.legacy_save_checkpoints)
            ? doc.meta.legacy_save_checkpoints : null;
        var firstRev = records[0] && records[0].rev;
        var last = records[records.length - 1] || {};
        var previousLast = previous && isObject(previous.last) ? previous.last : null;
        var lastRecord = {
            rev: last.rev,
            ts: last.ts,
            label: last.label,
            source: last.source,
            base_rev: last.base_rev,
            doc_sha256: last.doc_sha256,
            checkpoint: last.checkpoint,
            thumbnail_ref: last.thumbnail_ref
        };
        return {
            count: (previous && typeof previous.count === "number" ? previous.count : 0) + records.length,
            first_rev: previous && previous.first_rev !== undefined ? previous.first_rev : firstRev,
            last_rev: last.rev,
            last: previousLast || lastRecord
        };
    }

    function migrateLegacySaveHistory(doc) {
        if (!Array.isArray(doc.history) || !global.FigOps ||
            typeof global.FigOps.captureHistoryOrigin !== "function" ||
            typeof global.FigOps.contentRev !== "function") return doc;
        var removed = doc.history.filter(isLegacySaveRecord);
        if (!removed.length) return doc;
        doc.history = doc.history.filter(function (rec) { return !isLegacySaveRecord(rec); });
        var playhead = global.FigOps.contentRev(doc);
        // Removed revisions have no fabricated snapshots. The actual current P
        // becomes the recovery boundary; older retained ops remain as audit
        // events, and pre-origin restores still fail explicitly.
        var initialized = global.FigOps.captureHistoryOrigin(doc, playhead);
        doc.meta = isObject(doc.meta) ? doc.meta : {};
        doc.meta.history_origin = cloneJSON(initialized.meta.history_origin);
        doc.meta.legacy_save_checkpoints = boundedLegacyMetadata(doc, removed);
        return doc;
    }

    function projectFromDoc(doc, opts) {
        if (!isObject(doc)) {
            throw new Error("FigStore.projectFromDoc: doc 必须是文档对象");
        }
        var assets = {};
        if (opts !== undefined && opts !== null) {
            if (!isObject(opts)) {
                throw new Error("FigStore.projectFromDoc: opts 必须是对象");
            }
            if (opts.assets !== undefined && opts.assets !== null) {
                if (!isObject(opts.assets)) {
                    throw new Error("FigStore.projectFromDoc: assets 必须是对象");
                }
                assets = opts.assets;
            }
        }
        initializeHistoryOrigin(doc);
        // Move doc.history to the project top level and empty doc.history,
        // so the history is stored exactly once.
        var history = Array.isArray(doc.history) ? doc.history : [];
        doc.history = [];
        return {
            format: FORMAT,
            format_version: FORMAT_VERSION,
            doc: doc,
            history: history,
            assets: assets
        };
    }

    function docFromProject(project) {
        requireObject(project, "FigStore.docFromProject: project 必须是工程对象");
        requireObject(project.doc, "FigStore.docFromProject: project.doc 必须是文档对象");
        var doc = cloneJSON(project.doc);
        // Restore the top-level history onto the doc so undo/redo can continue
        // after a project is loaded back into the editor.
        if (Array.isArray(project.history)) {
            doc.history = cloneJSON(project.history);
        }
        initializeHistoryOrigin(doc);
        return migrateLegacySaveHistory(doc);
    }

    async function thumbnail(doc) {
        // No DOM (Node / worker): FigExport cannot rasterize.
        if (typeof document === "undefined") return null;
        var FigExport = global.FigExport;
        if (!FigExport || typeof FigExport.toRasterBlob !== "function") return null;
        var blob = await FigExport.toRasterBlob(doc, { format: "png", dpi: THUMB_DPI });
        var img = await loadImageFromBlob(blob);
        var naturalWidth = img.naturalWidth || img.width;
        var naturalHeight = img.naturalHeight || img.height;
        if (!naturalWidth || !naturalHeight) {
            throw new Error("FigStore.thumbnail: 导出的 PNG 尺寸无效");
        }
        var width = THUMB_WIDTH_PX;
        var height = Math.max(1, Math.round(naturalHeight * width / naturalWidth));
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext("2d");
        if (!ctx) {
            throw new Error("FigStore.thumbnail: 无法创建 2D 画布上下文");
        }
        ctx.drawImage(img, 0, 0, width, height);
        return canvas.toDataURL("image/png");
    }

    function loadImageFromBlob(blob) {
        return new Promise(function (resolve, reject) {
            var objectUrl = null;
            if (global.URL && typeof global.URL.createObjectURL === "function") {
                try { objectUrl = global.URL.createObjectURL(blob); } catch (err) { objectUrl = null; }
            }
            function cleanup() {
                if (objectUrl && global.URL && typeof global.URL.revokeObjectURL === "function") {
                    try { global.URL.revokeObjectURL(objectUrl); } catch (err) { /* noop */ }
                }
            }
            function load(src) {
                var img = new Image();
                img.onload = function () { cleanup(); resolve(img); };
                img.onerror = function () {
                    cleanup();
                    reject(new Error("FigStore.thumbnail: 缩略图图片加载失败"));
                };
                img.src = src;
            }
            if (objectUrl) { load(objectUrl); return; }
            if (typeof FileReader !== "function") {
                reject(new Error("FigStore.thumbnail: 无法读取导出的 PNG 数据"));
                return;
            }
            var reader = new FileReader();
            reader.onload = function () { load(reader.result); };
            reader.onerror = function () {
                reject(new Error("FigStore.thumbnail: 缩略图数据读取失败"));
            };
            reader.readAsDataURL(blob);
        });
    }

    async function snapshot(doc, opts) {
        if (!isObject(doc)) {
            throw new Error("FigStore.snapshot: doc 必须是文档对象");
        }
        if (!current) {
            throw new Error("FigStore.snapshot: 未设置存储适配器，请先调用 FigStore.use(adapter)");
        }
        opts = opts || {};
        // Read P before projectFromDoc moves doc.history to the project root.
        var playhead = global.FigOps && typeof global.FigOps.contentRev === "function"
            ? global.FigOps.contentRev(doc) : null;
        var project = projectFromDoc(doc, {});
        var thumb = await thumbnail(doc);
        project.thumbnail = thumb;
        var history = Array.isArray(project.history) ? project.history : (project.history = []);
        if (playhead === null) {
            playhead = 0;
            for (var i = 0; i < history.length; i++) {
                var rev = history[i] && history[i].rev;
                if (typeof rev === "number" && rev > playhead) playhead = rev;
            }
        }
        // A save observes the current content revision; it is not a user edit.
        // Replace bounded metadata instead of pinning another no-op history row.
        var entry = {
            rev: playhead,
            ts: new Date().toISOString(),
            label: typeof opts.label === "string" && opts.label ? opts.label : "快照",
            source: typeof opts.source === "string" && opts.source ? opts.source : "user",
            base_rev: playhead,
            ops: [],
            doc_sha256: null,
            checkpoint: opts.checkpoint === undefined ? true : !!opts.checkpoint,
            thumbnail_ref: thumb
        };
        project.doc.meta = isObject(project.doc.meta) ? project.doc.meta : {};
        if (isObject(project.doc.meta.legacy_save_checkpoints)) {
            entry.legacy_history = cloneJSON(project.doc.meta.legacy_save_checkpoints);
        }
        project.doc.meta.save_checkpoint = entry;
        if (global.FigDoc && typeof global.FigDoc.sha256 === "function") {
            entry.doc_sha256 = await global.FigDoc.sha256(project.doc);
        }
        await current.saveProject(project);
        return project;
    }

    async function exportProjectFile(doc) {
        if (!isObject(doc)) {
            throw new Error("FigStore.exportProjectFile: doc 必须是文档对象");
        }
        if (typeof Blob === "undefined") {
            throw new Error("FigStore.exportProjectFile: 当前环境不支持 Blob");
        }
        var project = projectFromDoc(doc, {});
        var thumb = await thumbnail(doc);
        if (thumb) project.thumbnail = thumb;
        var json = JSON.stringify(project, null, 2);
        return new Blob([json], { type: "application/json" });
    }

    async function importProjectFile(file) {
        if (!file || typeof file.text !== "function") {
            throw new Error("FigStore.importProjectFile: 参数必须是 Blob/File 文件对象");
        }
        var text = await file.text();
        var project;
        try {
            project = JSON.parse(text);
        } catch (err) {
            throw new Error("FigStore.importProjectFile: 工程文件不是有效的 JSON（" + errText(err) + "）");
        }
        project = migrateProject(project);
        if (!isObject(project.doc)) {
            throw new Error("FigStore.importProjectFile: 工程文件缺少 doc 字段");
        }
        return { doc: docFromProject(project), project: project };
    }

    // ------------------------------------------------------------- adapter glue

    var current = null;

    function use(adapter) {
        if (!isObject(adapter)) {
            throw new Error("FigStore.use: adapter 必须是适配器对象");
        }
        if (typeof adapter.name !== "string" || !adapter.name) {
            throw new Error("FigStore.use: adapter.name 必须是非空字符串");
        }
        current = normalizeAdapter(adapter);
    }

    // Wrap the adapter: methods it does not implement resolve to null.
    function normalizeAdapter(adapter) {
        var normalized = { name: adapter.name, __raw: adapter };
        ADAPTER_METHODS.forEach(function (method) {
            if (typeof adapter[method] === "function") {
                normalized[method] = function () {
                    return adapter[method].apply(adapter, arguments);
                };
            } else {
                normalized[method] = function () { return Promise.resolve(null); };
            }
        });
        return normalized;
    }

    function summaryOf(project) {
        var doc = isObject(project) && isObject(project.doc) ? project.doc : {};
        var meta = isObject(doc.meta) ? doc.meta : {};
        return {
            id: typeof doc.id === "string" ? doc.id : null,
            title: typeof doc.title === "string" ? doc.title : "",
            updated: typeof meta.updated === "string" ? meta.updated : null,
            format_version: isObject(project) && project.format_version
                ? project.format_version : FORMAT_VERSION,
            history_length: isObject(project) && Array.isArray(project.history)
                ? project.history.length : 0
        };
    }

    // ------------------------------------------- built-in adapter: localStorage
    // IndexedDB as the primary backend, localStorage as the fallback.

    function localStorageAdapterFactory(opts) {
        var adapter = {
            name: "localStorage",
            mode: null,          // "indexeddb" | "localstorage"
            _db: null,
            _ls: null
        };

        adapter.open = async function () {
            if (global.indexedDB && typeof global.indexedDB.open === "function") {
                try {
                    adapter._db = await openIDB();
                    adapter.mode = "indexeddb";
                    return adapter.mode;
                } catch (err) {
                    adapter._db = null; // fall back to localStorage
                }
            }
            var ls = global.localStorage;
            if (ls && typeof ls.getItem === "function" && typeof ls.setItem === "function") {
                try {
                    ls.setItem(LS_PREFIX + "__probe", "1");
                    ls.removeItem(LS_PREFIX + "__probe");
                } catch (err) {
                    throw new Error("FigStore.adapters.localStorage: localStorage 写入失败（" +
                        errText(err) + "）");
                }
                adapter._ls = ls;
                adapter.mode = "localstorage";
                return adapter.mode;
            }
            throw new Error("FigStore.adapters.localStorage: 当前环境没有可用的本地存储" +
                "（IndexedDB 与 localStorage 均不可用）");
        };

        adapter.saveProject = async function (project) {
            requireProject(project, "saveProject");
            if (adapter.mode === "indexeddb") {
                var tx = adapter._db.transaction(IDB_STORE_PROJECTS, "readwrite");
                tx.objectStore(IDB_STORE_PROJECTS).put(project);
                await idbTxComplete(tx);
                return project;
            }
            if (adapter.mode === "localstorage") {
                var map = lsReadJSON(adapter._ls, "projects", {});
                map[project.doc.id] = project;
                lsWriteJSON(adapter._ls, "projects", map);
                return project;
            }
            throw notOpen();
        };

        adapter.loadProject = async function (id) {
            requireId(id, "loadProject");
            if (adapter.mode === "indexeddb") {
                var tx = adapter._db.transaction(IDB_STORE_PROJECTS, "readonly");
                var found = await idbRequest(tx.objectStore(IDB_STORE_PROJECTS).get(id));
                return found === undefined ? null : found;
            }
            if (adapter.mode === "localstorage") {
                var map = lsReadJSON(adapter._ls, "projects", {});
                return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
            }
            throw notOpen();
        };

        adapter.listProjects = async function () {
            if (adapter.mode === "indexeddb") {
                var tx = adapter._db.transaction(IDB_STORE_PROJECTS, "readonly");
                var all = await idbRequest(tx.objectStore(IDB_STORE_PROJECTS).getAll());
                return (all || []).map(summaryOf);
            }
            if (adapter.mode === "localstorage") {
                var map = lsReadJSON(adapter._ls, "projects", {});
                return Object.keys(map).map(function (id) { return summaryOf(map[id]); });
            }
            throw notOpen();
        };

        adapter.deleteProject = async function (id) {
            requireId(id, "deleteProject");
            if (adapter.mode === "indexeddb") {
                var tx = adapter._db.transaction(IDB_STORE_PROJECTS, "readwrite");
                tx.objectStore(IDB_STORE_PROJECTS).delete(id);
                await idbTxComplete(tx);
                return true;
            }
            if (adapter.mode === "localstorage") {
                var map = lsReadJSON(adapter._ls, "projects", {});
                if (!Object.prototype.hasOwnProperty.call(map, id)) return false;
                delete map[id];
                lsWriteJSON(adapter._ls, "projects", map);
                return true;
            }
            throw notOpen();
        };

        adapter.saveAsset = async function (name, blob) {
            requireAssetName(name, "saveAsset");
            var value = await blobToDataURL(blob);
            if (adapter.mode === "indexeddb") {
                var tx = adapter._db.transaction(IDB_STORE_ASSETS, "readwrite");
                tx.objectStore(IDB_STORE_ASSETS).put(value, name);
                await idbTxComplete(tx);
                return true;
            }
            if (adapter.mode === "localstorage") {
                var map = lsReadJSON(adapter._ls, "assets", {});
                map[name] = value;
                lsWriteJSON(adapter._ls, "assets", map);
                return true;
            }
            throw notOpen();
        };

        adapter.loadAsset = async function (name) {
            requireAssetName(name, "loadAsset");
            var value = null;
            if (adapter.mode === "indexeddb") {
                var tx = adapter._db.transaction(IDB_STORE_ASSETS, "readonly");
                value = await idbRequest(tx.objectStore(IDB_STORE_ASSETS).get(name));
            } else if (adapter.mode === "localstorage") {
                var map = lsReadJSON(adapter._ls, "assets", {});
                value = Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null;
            } else {
                throw notOpen();
            }
            if (value === undefined || value === null) return null;
            if (typeof value === "string") return dataURLToBlob(value);
            return value;
        };

        function lsReadJSON(ls, key, fallback) {
            var raw = ls.getItem(LS_PREFIX + key);
            if (raw === null || raw === undefined) return fallback;
            try { return JSON.parse(raw); } catch (err) { return fallback; }
        }

        function lsWriteJSON(ls, key, value) {
            ls.setItem(LS_PREFIX + key, JSON.stringify(value));
        }

        return adapter;
    }

    // ------------------------------------------------- built-in adapter: http
    // REST backend: projects live under <baseUrl> ("/api/projects"), assets
    // under <assetsUrl> (default "/api/assets", derived from baseUrl).

    function httpAdapterFactory(opts) {
        opts = opts || {};
        var baseUrl = typeof opts.baseUrl === "string" && opts.baseUrl
            ? opts.baseUrl.replace(/\/+$/, "") : "/api/projects";
        var assetsUrl = typeof opts.assetsUrl === "string" && opts.assetsUrl
            ? opts.assetsUrl.replace(/\/+$/, "")
            : baseUrl.replace(/\/projects$/, "") + "/assets";
        var doFetch = typeof opts.fetch === "function" ? opts.fetch
            : (typeof global.fetch === "function" ? global.fetch.bind(global) : null);

        var adapter = { name: "http", baseUrl: baseUrl, assetsUrl: assetsUrl };

        function fetchImpl(url, init) {
            if (!doFetch) {
                throw new Error("FigStore.adapters.http: 当前环境没有可用的 fetch 实现");
            }
            return doFetch(url, init);
        }

        async function readBody(response) {
            var text = await response.text();
            if (!text) return null;
            try { return JSON.parse(text); } catch (err) { return text; }
        }

        function ensureOK(response, action) {
            if (response.ok) return;
            throw new Error("FigStore.adapters.http: " + action + "失败（HTTP " +
                response.status + "）");
        }

        adapter.open = async function () {
            if (!doFetch) {
                throw new Error("FigStore.adapters.http: 当前环境没有可用的 fetch 实现");
            }
            return "http";
        };

        adapter.saveProject = async function (project) {
            requireProject(project, "saveProject");
            var response = await fetchImpl(baseUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(project)
            });
            ensureOK(response, "保存项目");
            return readBody(response);
        };

        adapter.loadProject = async function (id) {
            requireId(id, "loadProject");
            var response = await fetchImpl(baseUrl + "/" + encodeURIComponent(id));
            if (response.status === 404) return null;
            ensureOK(response, "读取项目");
            return readBody(response);
        };

        adapter.listProjects = async function () {
            var response = await fetchImpl(baseUrl);
            ensureOK(response, "列出项目");
            var body = await readBody(response);
            if (Array.isArray(body)) return body;
            if (isObject(body) && Array.isArray(body.projects)) return body.projects;
            return [];
        };

        adapter.deleteProject = async function (id) {
            requireId(id, "deleteProject");
            var response = await fetchImpl(baseUrl + "/" + encodeURIComponent(id),
                { method: "DELETE" });
            if (response.status === 404) return false;
            ensureOK(response, "删除项目");
            return true;
        };

        adapter.saveAsset = async function (name, blob) {
            requireAssetName(name, "saveAsset");
            var response = await fetchImpl(assetsUrl + "/" + encodeURIComponent(name),
                { method: "POST", body: blob });
            ensureOK(response, "保存资产");
            return true;
        };

        adapter.loadAsset = async function (name) {
            requireAssetName(name, "loadAsset");
            var response = await fetchImpl(assetsUrl + "/" + encodeURIComponent(name));
            if (response.status === 404) return null;
            ensureOK(response, "读取资产");
            if (typeof response.blob === "function") return await response.blob();
            return await response.text();
        };

        return adapter;
    }

    // ------------------------------------------------------------- assembling

    var FigStore = {
        use: use,
        projectFromDoc: projectFromDoc,
        docFromProject: docFromProject,
        snapshot: snapshot,
        thumbnail: thumbnail,
        exportProjectFile: exportProjectFile,
        importProjectFile: importProjectFile,
        MIGRATIONS: MIGRATIONS,
        adapters: {
            localStorage: localStorageAdapterFactory,
            http: httpAdapterFactory
        }
    };

    // Convenience delegators to the adapter registered via use(). These are
    // additive helpers on top of the frozen API surface (callers may equally
    // keep the adapter object returned by the factories and call it directly).
    ADAPTER_METHODS.forEach(function (method) {
        FigStore[method] = function () {
            if (!current) {
                throw new Error("FigStore." + method +
                    ": 未设置存储适配器，请先调用 FigStore.use(adapter)");
            }
            return current[method].apply(null, arguments);
        };
    });

    global.FigStore = FigStore;
})(typeof globalThis !== "undefined" ? globalThis : this);
