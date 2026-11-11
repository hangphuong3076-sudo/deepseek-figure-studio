/**
 * bridge.js — Node bridge for v3-agent-plugin (contract: PLUGIN-API.md "Node 桥协议").
 *
 * Long-running process. Reads one JSON request per stdin line:
 *   {"id": <any>, "fn": "<name>", "args": {...}}
 * and answers with one JSON line on stdout:
 *   {"id": <same>, "ok": true, "result": ...}
 *   {"id": <same>, "ok": false, "error": "<Chinese message>"}
 *
 * Loads every kernel file from ./lib in the order fixed by shared/lib/API.md
 * onto globalThis (same as browser <script> loading). All calls go through an
 * explicit whitelist dispatch table — no eval of caller-supplied code, no
 * network requests, no filesystem writes. Diagnostics go to stderr only;
 * stdout carries protocol lines exclusively so the Python side stays in sync.
 *
 * Usage: node bridge.js
 */
(function (global) {
  'use strict';

  var fs = require('fs');
  var path = require('path');
  var vm = require('vm');
  var readline = require('readline');

  var BRIDGE_DIR = __dirname;
  var LIB_DIR = path.join(BRIDGE_DIR, 'lib');

  // Kernel bundle, exact order required by shared/lib/API.md.
  // science.js sits between ops.js and data.js (contract validation needs
  // FigOps; data.js renderers may call FigScience.barUncertainty at runtime).
  var KERNEL_FILES = [
    'figdoc.js', 'diagram.js', 'ops.js', 'science.js', 'palette.js', 'presets.js', 'data.js',
    'lineage.js', 'render.js', 'tiff.js', 'export.js', 'ai.js', 'storage.js'
  ];
  var REQUIRED_GLOBALS = [
    'FigDoc', 'FigDiagram', 'FigOps', 'FigScience', 'FigPalette', 'FigPresets', 'FigData', 'FigLineage',
    'FigRender', 'FigTiff', 'FigExport', 'FigAI', 'FigStore'
  ];

  function die(msg) {
    process.stderr.write('[bridge.js] ' + msg + '\n');
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Kernel loading (fixed file list; vm.runInThisContext executes the
  // bundled IIFEs against globalThis — equivalent to browser <script>.
  // No caller-supplied code ever reaches this path.)
  // ------------------------------------------------------------------

  KERNEL_FILES.forEach(function (name) {
    var p = path.join(LIB_DIR, name);
    var code;
    try {
      code = fs.readFileSync(p, 'utf8');
    } catch (e) {
      die('内核文件读取失败：' + p + '（' + e.message + '）');
    }
    try {
      vm.runInThisContext(code, { filename: p });
    } catch (e) {
      die('内核文件加载失败：' + name + '（' + e.message + '）');
    }
  });

  var missing = REQUIRED_GLOBALS.filter(function (n) { return !global[n]; });
  if (missing.length) {
    die('内核模块缺失：' + missing.join(', '));
  }

  // ------------------------------------------------------------------
  // Preset loading (journals / templates / palettes), needed by
  // presets.* handlers. Failure is non-fatal here: the presets.*
  // handlers will answer with a Chinese error instead of presets.
  // ------------------------------------------------------------------

  function firstExistingDir(candidates) {
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (fs.statSync(candidates[i]).isDirectory()) return candidates[i];
      } catch (e) { /* keep looking */ }
    }
    return null;
  }

  function loadPresets() {
    // 自包含预设目录（插件副本补丁）：优先本目录 presets/，其次上一级
    // presets/（bundle 形态），最后回退 ../shared/presets（原始布局）。
    var dir = firstExistingDir([
      path.join(BRIDGE_DIR, 'presets'),
      path.join(BRIDGE_DIR, '..', 'presets'),
      path.join(BRIDGE_DIR, '..', 'shared', 'presets')
    ]);
    if (!dir) {
      process.stderr.write('[bridge.js] 预设目录未找到（尝试 ./presets、../presets 与 ../shared/presets），presets.* 调用将返回中文错误\n');
      return;
    }
    try {
      global.FigPresets.load({
        journals: JSON.parse(fs.readFileSync(path.join(dir, 'journals.json'), 'utf8')),
        templates: JSON.parse(fs.readFileSync(path.join(dir, 'templates.json'), 'utf8')),
        palettes: JSON.parse(fs.readFileSync(path.join(dir, 'palettes.json'), 'utf8'))
      });
    } catch (e) {
      process.stderr.write('[bridge.js] 预设加载失败（' + dir + '）：' + (e && e.message ? e.message : String(e)) + '\n');
    }
  }
  loadPresets();

  // ------------------------------------------------------------------
  // Serialization guard: whitelisted fns must return JSON-safe values.
  // Typed arrays / ArrayBuffer / Blob / Function / Symbol / undefined /
  // NaN / cyclic references raise a Chinese error instead of being
  // silently corrupted by JSON.stringify.
  // ------------------------------------------------------------------

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function assertJsonSafe(value, where, seen) {
    if (value === null) return;
    var t = typeof value;
    if (t === 'string' || t === 'boolean') return;
    if (t === 'number') {
      if (!isFinite(value)) {
        throw new Error('返回值不可 JSON 序列化：' + where + ' 处出现 NaN 或 Infinity');
      }
      return;
    }
    if (t === 'undefined') {
      throw new Error('返回值不可 JSON 序列化：' + where + ' 处出现 undefined');
    }
    if (t === 'function' || t === 'symbol' || t === 'bigint') {
      throw new Error('返回值不可 JSON 序列化：' + where + ' 处出现 ' + t);
    }
    if (value instanceof Date) return;
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        throw new Error('返回值不可 JSON 序列化：' + where + ' 处出现循环引用');
      }
      seen.add(value);
      for (var j = 0; j < value.length; j++) {
        assertJsonSafe(value[j], where + '[' + j + ']', seen);
      }
      seen.delete(value);
      return;
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      throw new Error('返回值不可 JSON 序列化：' + where + ' 处出现 Blob，请改用 base64 编码后在 Python 侧解码');
    }
    if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer ||
        (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(value)))) {
      throw new Error('返回值不可 JSON 序列化：' + where + ' 处出现二进制数据（Uint8Array/ArrayBuffer 等），请转 base64 或改用支持二进制的接口');
    }
    if (!isPlainObject(value)) {
      throw new Error('返回值不可 JSON 序列化：' + where + ' 处出现类型 ' + (value && value.constructor && value.constructor.name ? value.constructor.name : t));
    }
    if (seen.has(value)) {
      throw new Error('返回值不可 JSON 序列化：' + where + ' 处出现循环引用');
    }
    seen.add(value);
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      assertJsonSafe(value[keys[i]], where + '.' + keys[i], seen);
    }
    seen.delete(value);
  }

  function jsonSafe(value) {
    assertJsonSafe(value, '$', new Set());
    return value;
  }

  // ------------------------------------------------------------------
  // Whitelist dispatch (the ONLY entry points into the kernel).
  // Handlers receive args (plain JSON object) and return JSON-safe data.
  // ------------------------------------------------------------------

  function reqObj(args, field) {
    var v = args ? args[field] : undefined;
    if (v === undefined || v === null) {
      throw new Error('缺少参数 ' + field);
    }
    return v;
  }

  function optObj(args, field) {
    var v = args ? args[field] : undefined;
    return isPlainObject(v) ? v : {};
  }

  function optNum(args, field) {
    return args && args[field] !== undefined ? args[field] : undefined;
  }

  var HANDLERS = {
    // --- FigDoc ---
    'doc.create': function (args) {
      // Accept the create options either as args itself or under args.opts.
      var opts = args && isPlainObject(args.opts) ? args.opts : args;
      return global.FigDoc.create(opts && Object.keys(opts).length ? opts : undefined);
    },
    'doc.normalize': function (args) { return global.FigDoc.normalize(reqObj(args, 'doc')); },
    'doc.validate': function (args) { return global.FigDoc.validate(reqObj(args, 'doc')); },
    'doc.sha256': function (args) {
      return Promise.resolve(global.FigDoc.sha256(reqObj(args, 'doc')));
    },
    'doc.serialize': function (args) { return global.FigDoc.serialize(reqObj(args, 'doc')); },

    // --- FigDiagram (raw entities/relations only; source text is never executed) ---
    'diagram.build': function (args) {
      var a = args || {};
      return global.FigDiagram.build(a.doc === undefined ? null : a.doc, reqObj(a, 'spec'), a.options || {});
    },
    'diagram.validate': function (args) {
      return global.FigDiagram.validateSpec(reqObj(args, 'spec'));
    },
    'diagram.preview': function (args) {
      return global.FigDiagram.previewSVG(reqObj(args, 'spec'));
    },
    'diagram.preview_svg': function (args) {
      return global.FigDiagram.previewSVG(reqObj(args, 'spec'));
    },
    'diagram.supports': function (args) {
      var template = args && args.template !== undefined ? args.template : reqObj(args, 'template_id');
      return global.FigDiagram.supportsTemplate(template);
    },
    'diagram.supports_template': function (args) {
      return global.FigDiagram.supportsTemplate(reqObj(args, 'template_id'));
    },
    'diagram.chart_slots': function (args) {
      return global.FigDiagram.chartSlots(reqObj(args, 'doc'), args && args.scene_id);
    },
    'diagram.audit': function (args) {
      return global.FigDiagram.auditLayout(reqObj(args, 'doc'));
    },

    // --- FigOps ---
    'ops.apply': function (args) {
      return global.FigOps.apply(reqObj(args, 'doc'), reqObj(args, 'op'), optObj(args, 'ctx'));
    },
    'ops.validate': function (args) {
      return global.FigOps.validate(reqObj(args, 'op'), reqObj(args, 'doc'));
    },
    'ops.apply_all': function (args) {
      var opts = args && isPlainObject(args.opts) ? args.opts : optObj(args, 'ctx');
      return global.FigOps.applyAll(reqObj(args, 'doc'), reqObj(args, 'ops'), opts);
    },
    'ops.validate_all': function (args) {
      return global.FigOps.validateAll(reqObj(args, 'ops'), reqObj(args, 'doc'));
    },
    'ops.diff': function (args) {
      var docA = args && (args.doc_a !== undefined ? args.doc_a : args.docA);
      var docB = args && (args.doc_b !== undefined ? args.doc_b : args.docB);
      if (docA === undefined || docA === null) throw new Error('缺少参数 doc_a');
      if (docB === undefined || docB === null) throw new Error('缺少参数 doc_b');
      return global.FigOps.diff(docA, docB);
    },
    'ops.describe': function (args) {
      return global.FigOps.describe(reqObj(args, 'op'), reqObj(args, 'doc'));
    },
    'ops.revert': function (args) {
      var rev = reqObj(args, 'rev');
      return global.FigOps.revertTo(reqObj(args, 'doc'), rev);
    },
    'ops.undo': function (args) { return global.FigOps.undo(reqObj(args, 'doc')); },
    'ops.redo': function (args) { return global.FigOps.redo(reqObj(args, 'doc')); },

    // --- FigPresets ---
    'presets.apply_canvas': function (args) {
      var presetId = args && (args.preset_id !== undefined ? args.preset_id : args.journal_id);
      if (typeof presetId !== 'string' || presetId === '') throw new Error('缺少参数 preset_id（或 journal_id）');
      return global.FigPresets.applyCanvas(presetId, reqObj(args, 'doc'));
    },
    'presets.check': function (args) { return global.FigPresets.check(reqObj(args, 'doc')); },
    'presets.recommend': function (args) {
      return global.FigPresets.recommend(reqObj(args, 'column_stats'),
        args && args.n !== undefined ? { n: args.n } : {});
    },
    'presets.template_from_stats': function (args) {
      return global.FigPresets.templateFromStats(reqObj(args, 'template_id'), reqObj(args, 'data'),
        { journal_id: args ? args.journal_id : undefined, palette_id: args ? args.palette_id : undefined,
          schematic: args ? args.schematic : undefined });
    },

    // --- FigData ---
    'data.parse_csv': function (args) {
      return global.FigData.parseCSV(reqObj(args, 'text'),
        { delimiter: args ? args.delimiter : undefined, header: args ? args.header : undefined });
    },
    'data.parse_json': function (args) { return global.FigData.parseJSON(reqObj(args, 'text')); },
    'data.column_stats': function (args) { return global.FigData.columnStats(reqObj(args, 'data')); },
    'data.infer_chart_type': function (args) {
      return global.FigData.inferChartType(reqObj(args, 'column_stats'));
    },
    'data.make_chart_element': function (args) {
      var a = args || {};
      return global.FigData.makeChartElement(reqObj(a, 'data'), {
        chart_type: a.chart_type,
        mapping: a.mapping,
        journal_id: a.journal_id,
        palette_id: a.palette_id,
        transform: a.transform
      });
    },

    // --- FigRender ---
    'render.to_svg': function (args) {
      var a = args || {};
      return global.FigRender.toSVG(reqObj(a, 'doc'),
        { scale: a.scale, includeGuides: a.include_guides === true, panel_id: a.panel_id });
    },
    'render.anchor_boxes': function (args) { return global.FigRender.anchorBoxes(reqObj(args, 'doc')); },

    // --- FigPalette ---
    'palette.list': function (args) {
      var a = args || {};
      return global.FigPalette.list(a.category !== undefined ? { category: a.category } : undefined);
    },
    'palette.get': function (args) { return global.FigPalette.get(reqObj(args, 'id')); },

    // --- FigAI (offline / prompt-building only; chat() is NOT exposed) ---
    'ai.build_edit_messages': function (args) {
      var a = args || {};
      return global.FigAI.buildEditMessages({
        doc: reqObj(a, 'doc'),
        instruction: a.instruction,
        anchors: a.anchors,
        selection: a.selection,
        historyTail: a.history_tail
      });
    },
    'ai.build_review_messages': function (args) {
      var a = args || {};
      return global.FigAI.buildReviewMessages({
        doc: reqObj(a, 'doc'),
        imageDataUrl: a.image_data_url,
        journalPreset: a.journal_preset,
        checkResult: a.check_result
      });
    },
    'ai.fallback_ops': function (args) {
      var a = args || {};
      return global.FigAI.fallbackOps({
        doc: reqObj(a, 'doc'),
        instruction: a.instruction,
        anchors: a.anchors,
        selection: a.selection
      });
    },
    'ai.fallback_review': function (args) {
      var a = args || {};
      return global.FigAI.fallbackReview({
        doc: reqObj(a, 'doc'),
        journalPreset: a.journal_preset
      });
    },

    // --- FigScience (scientific contract kernel; loaded after ops.js) ---
    // Applies the contract WITHOUT a kernel history record: the server
    // records exactly one traceable set_scientific_contract history entry
    // (mirroring figure_apply_edits) so server-side revert snapshots work.
    'science.apply_contract': function (args) {
      var a = args || {};
      return global.FigScience.applyContract(reqObj(a, 'doc'), reqObj(a, 'input'));
    },
    'science.audit': function (args) {
      return global.FigScience.audit(reqObj(args, 'doc'));
    },

    'lineage.audit': function (args) { return global.FigLineage.audit(reqObj(args, 'doc')); },
    'lineage.lookup': function (args) { return global.FigLineage.lookup(reqObj(args, 'doc'), args && args.query || {}); }
  };

  var WHITELIST = Object.keys(HANDLERS);

  // ------------------------------------------------------------------
  // Line protocol
  // ------------------------------------------------------------------

  function writeLine(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  function fail(id, msg) {
    writeLine({ id: id === undefined ? null : id, ok: false, error: msg });
  }

  function handleLine(line) {
    var req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      fail(null, '请求不是合法 JSON：' + (e && e.message ? e.message : String(e)));
      return;
    }
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      fail(null, '请求必须是 {"id","fn","args"} 形式的 JSON 对象');
      return;
    }
    var id = req.id === undefined ? null : req.id;
    var fnName = req.fn;
    if (typeof fnName !== 'string' || fnName === '') {
      fail(id, '请求缺少 fn 字段（函数名）');
      return;
    }
    var handler = HANDLERS[fnName];
    if (!handler) {
      fail(id, '未知的函数名：' + fnName + '（bridge 仅支持白名单函数：' + WHITELIST.join(', ') + '）');
      return;
    }
    var args = req.args;
    if (args === undefined || args === null) args = {};
    if (!isPlainObject(args)) {
      fail(id, 'args 必须是 JSON 对象');
      return;
    }
    Promise.resolve().then(function () {
      var result = handler(args);
      return Promise.resolve(result).then(function (resolved) {
        return jsonSafe(resolved);
      });
    }).then(function (result) {
      writeLine({ id: id, ok: true, result: result });
    }).catch(function (err) {
      var msg = err instanceof Error ? err.message : String(err);
      fail(id, '调用 ' + fnName + ' 失败：' + msg);
    });
  }

  var rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', function (line) {
    var trimmed = line.trim();
    if (!trimmed) return; // ignore blank lines silently
    try {
      handleLine(trimmed);
    } catch (e) {
      // Never let a bad request kill the resident process.
      fail(null, '桥内部错误：' + (e && e.message ? e.message : String(e)));
    }
  });
  rl.on('close', function () {
    process.exit(0);
  });

  process.stderr.write('[bridge.js] 已启动：内核 ' + REQUIRED_GLOBALS.join(', ') +
    '；白名单函数 ' + WHITELIST.length + ' 个\n');
})(typeof globalThis !== 'undefined' ? globalThis : this);
