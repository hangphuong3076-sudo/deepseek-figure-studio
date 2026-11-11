/* Deterministic declaration-to-schematic builder. Source text is data, never code. */
(function (global) {
  "use strict";

  var VERSION = "1.0";
  var MAX_NODES = 256;
  var MAX_RELATIONS = 1024;
  var MAX_LABEL_LENGTH = 2048;
  var MAX_AUDIT_ELEMENTS = 10000;
  var MAX_AUDIT_WARNINGS = 1000;
  var LABEL_PAD_X_MM = 1.5;
  var LABEL_PAD_Y_MM = 1;
  var PT_TO_MM = 25.4 / 72;
  var LAYOUT_EPS_MM = 0.001;
  var ID_RE = /^[A-Za-z0-9_.:-]+$/;
  var ROLES = ["question", "method", "evidence", "conclusion"];
  var SHAPES = ["box", "ellipse", "cell", "molecule", "material", "process", "outcome",
    "sample", "device", "group", "container", "diamond", "chart"];
  var KINDS = ["entity", "decision"].concat(SHAPES);
  var RELATIONS = ["activate", "inhibit", "include", "associate", "sequence"];
  var DIRECTIONS = ["forward", "reverse", "both", "none"];
  var TEMPLATES = ["flow", "decision", "loop", "experiment", "timeline", "compare", "graphical_abstract"];
  var TEMPLATE_IDS = {
    flow: "flow", decision: "decision", loop: "loop", experiment: "experiment",
    timeline: "timeline", compare: "compare", graphical_abstract: "graphical_abstract",
    "graphical-abstract": "graphical_abstract", graphicalAbstract: "graphical_abstract",
    entity_relationship: "flow", "entity-relationship": "flow",
    relationship_schematic: "flow", schematic: "flow",
    "tpl-diagram-flow": "flow", "tpl-diagram-arch": "flow",
    "tpl-graphical-abstract": "graphical_abstract"
  };
  var ROOT_KEYS = ["id", "schema_version", "schemaVersion", "template", "template_id", "templateId",
    "nodes", "relations", "sources", "canvas", "layout", "uncertainties", "human_review"];
  var NODE_KEYS = ["id", "label", "role", "shape", "kind", "x", "y", "w", "h",
    "evidence", "source_refs", "sourceRefs", "color", "fill", "stroke", "fontSizePt", "data_slot"];
  var REL_KEYS = ["id", "source", "target", "from", "to", "sourceId", "targetId", "kind",
    "direction", "bend", "label", "evidence", "source_refs", "sourceRefs"];
  var SOURCE_KEYS = ["id", "locator", "sha256", "version", "title", "note", "text", "content", "metadata", "verification"];
  var EVIDENCE_KEYS = ["source_id", "sourceId", "locator", "note", "uncertainties"];
  var COLORS = { question: "#FFF2CC", method: "#DDEBF7", evidence: "#E2F0D9", conclusion: "#FCE4D6" };
  var CONNECTOR_CONTRACT = {
    element_type: "connector", node_type: "group", coordinate_space: "world-mm",
    node_fields: { diagramId: "spec.id", diagramNodeId: "semantic node id", children: "shape/text and include descendants" },
    relation_fields: ["source", "target", "kind", "direction"],
    source_target: "semantic node ids resolved to exactly one same-diagram native group",
    geometry: "dynamic-node-bbox; straight/deterministic orthogonal/explicit quadratic; never persisted pathData",
    endpoint_policy: "stable per-node/per-side ports sorted by connector id; one centered, two based at 25%/75% with <=12.5% direction offset, larger sets in a clamped 2mm edge band; orthogonal routes and arrow tangents use actual points",
    routing: "automatic only when an unbent direct segment crosses an unrelated node; unresolved routes retain audit warnings", 
    recompute_on: ["node.transform", "node.parent_id", "panel.transform", "panel.panelLayout"],
    kind: { activate: "arrow", inhibit: "T-bar", associate: "plain line", sequence: "arrow", include: "native parent/children; no connector" },
    direction: { forward: "target", reverse: "source", both: "both", none: "required for include/associate" },
    labels: "native text; connector.label_element_id points to it and renderer re-anchors it"
  };

  function obj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function finite(v) { return typeof v === "number" && isFinite(v); }
  function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function clone(v) {
    if (typeof structuredClone === "function") return structuredClone(v);
    return JSON.parse(JSON.stringify(v));
  }
  function stable(v) {
    if (v === undefined) return "undefined";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ":" + stable(v[k]);
    }).join(",") + "}";
  }
  function same(a, b) { return stable(a) === stable(b); }
  function round(v) { var n = Math.round(v * 1000000) / 1000000; return n === 0 ? 0 : n; }
  function warning(code, message) { return { code: code, message: message }; }
  function keys(raw, allowed, where) {
    if (!obj(raw)) throw new Error("INVALID_SCHEMA: " + where + " 必须是对象");
    Object.keys(raw).forEach(function (k) {
      if (allowed.indexOf(k) < 0) throw new Error("UNKNOWN_FIELD: " + where + "." + k);
      if (k === "__proto__" || k === "prototype" || k === "constructor") throw new Error("UNSAFE_KEY: " + where + "." + k);
    });
  }
  function text(value, where, allowEmpty) {
    if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
      throw new Error("INVALID_TEXT: " + where + " 必须是" + (allowEmpty ? "字符串" : "非空字符串"));
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error("INVALID_TEXT: " + where + " 含控制字符");
    if (/<\s*\/?\s*[A-Za-z][^>]*>|<\s*!|<\s*\?/.test(value)) throw new Error("UNSAFE_HTML: " + where + " 只接受纯文本，不接受 HTML/XML");
    if (/(?:javascript|vbscript|data)\s*:/i.test(value)) throw new Error("UNSAFE_URL: " + where + " 含危险协议");
    return value;
  }
  function locator(value, where) {
    text(value, where, false);
    var scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value.trim());
    if (scheme && ["http", "https", "doi"].indexOf(scheme[1].toLowerCase()) < 0) {
      throw new Error("UNSAFE_URL: " + where + " 只允许 http/https/doi 或无协议来源定位");
    }
    if (/^https?:\/\//i.test(value) && /[\s<>"']/.test(value)) throw new Error("UNSAFE_URL: " + where + " 的 URL 含危险字符");
    return value;
  }
  function id(value, where) {
    if (typeof value !== "string" || !ID_RE.test(value)) throw new Error("INVALID_ID: " + where + " 必须是匹配合法字符的非空字符串");
    return value;
  }
  function finiteNumber(value, where) { if (!finite(value)) throw new Error("INVALID_GEOMETRY: " + where); return value; }
  function positive(value, where) { if (!finite(value) || value <= 0) throw new Error("INVALID_GEOMETRY: " + where + " 必须是正数"); return value; }
  function alias(raw, snake, camel, where) {
    var a = raw[snake], b = camel ? raw[camel] : undefined;
    if (a !== undefined && b !== undefined && !same(a, b)) throw new Error("CONFLICTING_ALIAS: " + where + " 的 " + snake + "/" + camel);
    return a !== undefined ? a : b;
  }
  function safeJSON(value, where) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") { if (!isFinite(value)) throw new Error("INVALID_JSON: " + where); return; }
    if (Array.isArray(value)) { value.forEach(function (v, i) { safeJSON(v, where + "[" + i + "]"); }); return; }
    if (!obj(value)) throw new Error("INVALID_JSON: " + where + " 只接受 JSON 数据");
    Object.keys(value).forEach(function (k) {
      if (k === "__proto__" || k === "prototype" || k === "constructor") throw new Error("UNSAFE_KEY: " + where + "." + k);
      safeJSON(value[k], where + "." + k);
    });
  }

  function sha256(textValue) {
    var K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
    var bytes = unescape(encodeURIComponent(String(textValue))).split("").map(function (c) { return c.charCodeAt(0); });
    var bitLen = bytes.length * 8, hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    bytes.push(128); while (bytes.length % 64 !== 56) bytes.push(0);
    [hi >>> 24, hi >>> 16, hi >>> 8, hi, lo >>> 24, lo >>> 16, lo >>> 8, lo].forEach(function (b) { bytes.push(b & 255); });
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
      for (var t = 0; t < 16; t++) { var j = off + t * 4; w[t] = ((bytes[j] << 24) | (bytes[j+1] << 16) | (bytes[j+2] << 8) | bytes[j+3]) >>> 0; }
      for (t = 16; t < 64; t++) {
        var s0 = rr(w[t-15],7)^rr(w[t-15],18)^(w[t-15]>>>3), s1 = rr(w[t-2],17)^rr(w[t-2],19)^(w[t-2]>>>10);
        w[t] = (w[t-16]+s0+w[t-7]+s1)>>>0;
      }
      var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for (t = 0; t < 64; t++) {
        var S1=rr(e,6)^rr(e,11)^rr(e,25), ch=(e&f)^(~e&g), t1=(h+S1+ch+K[t]+w[t])>>>0;
        var S0=rr(a,2)^rr(a,13)^rr(a,22), maj=(a&b)^(a&c)^(b&c), t2=(S0+maj)>>>0;
        h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
      H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
    }
    return H.map(function (v) { return ("00000000" + v.toString(16)).slice(-8); }).join("");
  }
  function hash(v) { return sha256(stable(v)); }

  function normalizeEvidence(raw, sourceMap, warnings, where) {
    var list = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]), out = [];
    list.forEach(function (item, i) {
      var sid, loc = null, note = null, at = where + "[" + i + "]";
      if (typeof item === "string") sid = id(item, at);
      else {
        keys(item, EVIDENCE_KEYS, at);
        sid = id(alias(item, "source_id", "sourceId", at), at + ".source_id");
        if (item.locator !== undefined) loc = locator(item.locator, at + ".locator");
        if (item.note !== undefined) note = text(item.note, at + ".note", true);
      }
      if (!sourceMap[sid]) throw new Error("INVALID_SOURCE_REFERENCE: " + at + " 引用未声明的 " + sid);
      var entry = { source_id: sid, locator: loc || sourceMap[sid].locator };
      if (note !== null) entry.note = note;
      if (item && typeof item === "object" && item.uncertainties !== undefined) {
        if (!Array.isArray(item.uncertainties)) throw new Error("INVALID_SCHEMA: " + at + ".uncertainties 必须是数组");
        entry.uncertainties = item.uncertainties.map(function (v, ui) { return text(v, at + ".uncertainties[" + ui + "]", false); });
      }
      out.push(entry);
    });
    if (!out.length) warnings.push(warning("EVIDENCE_MISSING", where + " 未绑定可定位来源，仍为待复核声明"));
    return out;
  }

  function normalize(input) {
    keys(input, ROOT_KEYS, "spec");
    safeJSON(input, "spec");
    var version = alias(input, "schema_version", "schemaVersion", "spec");
    if (version !== undefined && version !== VERSION && version !== 1) throw new Error("INVALID_SCHEMA_VERSION: 只支持 1.0");
    var rawTpl = alias(input, "template", ["template_id"][0], "spec");
    if (input.templateId !== undefined) {
      var byCamel = alias(input, "template_id", "templateId", "spec");
      if (rawTpl !== undefined && !same(rawTpl, byCamel)) throw new Error("CONFLICTING_ALIAS: spec.template/templateId");
      rawTpl = byCamel;
    }
    var template = rawTpl == null || rawTpl === "" ? "flow" : TEMPLATE_IDS[rawTpl];
    if (!template) throw new Error("UNSUPPORTED_TEMPLATE: " + String(rawTpl) + "；仅支持 " + TEMPLATES.join("/") + "，不臆造学科标准答案");
    var spec = { schema_version: VERSION, id: id(input.id, "spec.id"), template_id: template,
      nodes: [], relations: [], sources: [], uncertainties: [], human_review: null }, warnings = [], sourceMap = Object.create(null);
    if (input.uncertainties !== undefined) {
      if (!Array.isArray(input.uncertainties)) throw new Error("INVALID_SCHEMA: uncertainties 必须是字符串数组");
      spec.uncertainties = input.uncertainties.map(function (v, i) { return text(v, "uncertainties[" + i + "]", false); });
    }
    if (input.human_review !== undefined && input.human_review !== null) {
      keys(input.human_review, ["reviewer", "checked_at", "outcome", "notes"], "human_review");
      ["reviewer", "checked_at", "outcome", "notes"].forEach(function (k) {
        text(input.human_review[k], "human_review." + k, false);
      });
      spec.human_review = clone(input.human_review);
    }
    if (!Array.isArray(input.nodes) || !input.nodes.length) throw new Error("MISSING_MATERIALS: nodes 必须是非空数组");
    if (input.nodes.length > MAX_NODES) throw new Error("LAYOUT_LIMIT_EXCEEDED: nodes 最多 " + MAX_NODES + " 个，当前 " + input.nodes.length + " 个");
    if (input.relations !== undefined && !Array.isArray(input.relations)) throw new Error("INVALID_SCHEMA: relations 必须是数组");
    if ((input.relations || []).length > MAX_RELATIONS) throw new Error("LAYOUT_LIMIT_EXCEEDED: relations 最多 " + MAX_RELATIONS + " 条，当前 " + input.relations.length + " 条");
    if (input.sources !== undefined && !Array.isArray(input.sources)) throw new Error("INVALID_SCHEMA: sources 必须是数组");
    (input.sources || []).forEach(function (raw, i) {
      keys(raw, SOURCE_KEYS, "sources[" + i + "]");
      var sid = id(raw.id, "sources[" + i + "].id");
      if (sourceMap[sid]) throw new Error("DUPLICATE_ID: source " + sid);
      var src = { id: sid, locator: locator(raw.locator, "sources[" + i + "].locator"), verification: "user_provided_unverified" };
      if (raw.sha256 != null) {
        if (typeof raw.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(raw.sha256)) throw new Error("INVALID_SOURCE_HASH: sources[" + i + "]");
        src.sha256 = raw.sha256.toLowerCase();
      }
      ["version", "title", "note"].forEach(function (k) { if (raw[k] !== undefined) src[k] = text(raw[k], "sources[" + i + "]." + k, true); });
      if (raw.text !== undefined && raw.content !== undefined && raw.text !== raw.content) throw new Error("CONFLICTING_ALIAS: sources[" + i + "] text/content");
      if (raw.text !== undefined || raw.content !== undefined) src.text = text(raw.text !== undefined ? raw.text : raw.content, "sources[" + i + "].text", true);
      if (raw.metadata !== undefined) { safeJSON(raw.metadata, "sources[" + i + "].metadata"); src.metadata = clone(raw.metadata); }
      sourceMap[sid] = src; spec.sources.push(src);
    });
    if (!spec.sources.length) warnings.push(warning("MISSING_MATERIALS", "没有 sources；内容仅为用户声明，不是已核实论文或官方案例结果"));
    var nodeMap = Object.create(null);
    input.nodes.forEach(function (raw, i) {
      keys(raw, NODE_KEYS, "nodes[" + i + "]");
      var nid = id(raw.id, "nodes[" + i + "].id");
      if (nodeMap[nid]) throw new Error("DUPLICATE_ID: node " + nid);
      if (ROLES.indexOf(raw.role) < 0) throw new Error("INVALID_ROLE: nodes[" + i + "].role 必须是 " + ROLES.join("/"));
      var shape = raw.shape === undefined ? "box" : raw.shape;
      if (SHAPES.indexOf(shape) < 0) throw new Error("INVALID_SHAPE: nodes[" + i + "].shape 只允许 " + SHAPES.join("/"));
      var kind = raw.kind === undefined ? shape : raw.kind;
      if (KINDS.indexOf(kind) < 0) throw new Error("INVALID_NODE_KIND: nodes[" + i + "].kind 未知：" + String(kind));
      if (typeof raw.label === "string" && Array.from(raw.label).length > MAX_LABEL_LENGTH) {
        throw new Error("LAYOUT_LIMIT_EXCEEDED: nodes[" + i + "].label 最多 " + MAX_LABEL_LENGTH + " 个 Unicode 字符");
      }
      var n = { id: nid, label: text(raw.label, "nodes[" + i + "].label", false), role: raw.role,
        shape: shape, kind: kind, evidence: [] };
      if (shape === "chart" || kind === "chart") n.data_slot = { type: "chart", declared: "explicit_shape_or_kind" };
      if (raw.data_slot !== undefined && !same(raw.data_slot, n.data_slot)) {
        throw new Error("INVALID_CHART_SLOT: data_slot 只能由显式 kind:'chart' 或 shape:'chart' 声明，不能单独伪造 normalized 字段");
      }
      if ((raw.x === undefined) !== (raw.y === undefined)) throw new Error("INVALID_GEOMETRY: nodes[" + i + "].x/y 必须同时提供");
      ["x", "y"].forEach(function (k) { if (raw[k] !== undefined) n[k] = finiteNumber(raw[k], "nodes[" + i + "]." + k); });
      ["w", "h"].forEach(function (k) { if (raw[k] !== undefined) n[k] = positive(raw[k], "nodes[" + i + "]." + k); });
      ["color", "fill", "stroke"].forEach(function (k) { if (raw[k] !== undefined) n[k] = text(raw[k], "nodes[" + i + "]." + k, false); });
      if (raw.fontSizePt !== undefined) n.fontSizePt = positive(raw.fontSizePt, "nodes[" + i + "].fontSizePt");
      var ev = raw.evidence !== undefined ? raw.evidence : alias(raw, "source_refs", "sourceRefs", "nodes[" + i + "]");
      n.evidence = normalizeEvidence(ev, sourceMap, warnings, "nodes[" + i + "].evidence");
      nodeMap[nid] = n; spec.nodes.push(n);
    });
    var relMap = Object.create(null), includeParent = Object.create(null);
    (input.relations || []).forEach(function (raw, i) {
      keys(raw, REL_KEYS, "relations[" + i + "]");
      var rid = id(raw.id, "relations[" + i + "].id");
      if (relMap[rid]) throw new Error("DUPLICATE_ID: relation " + rid);
      var sourceA = raw.source !== undefined ? raw.source : raw.sourceId, sourceB = raw.from;
      var targetA = raw.target !== undefined ? raw.target : raw.targetId, targetB = raw.to;
      if (sourceA !== undefined && sourceB !== undefined && sourceA !== sourceB) throw new Error("CONFLICTING_ALIAS: relations[" + i + "].source/from");
      if (targetA !== undefined && targetB !== undefined && targetA !== targetB) throw new Error("CONFLICTING_ALIAS: relations[" + i + "].target/to");
      var source = id(sourceA !== undefined ? sourceA : sourceB, "relations[" + i + "].source");
      var target = id(targetA !== undefined ? targetA : targetB, "relations[" + i + "].target");
      if (!nodeMap[source] || !nodeMap[target]) throw new Error("INVALID_RELATION_REFERENCE: relations[" + i + "] source/target 悬挂");
      if (source === target) throw new Error("INVALID_RELATION_REFERENCE: relations[" + i + "] 不允许自引用");
      if (RELATIONS.indexOf(raw.kind) < 0) throw new Error("INVALID_RELATION_KIND: " + String(raw.kind));
      var direction = raw.direction === undefined ? (raw.kind === "include" || raw.kind === "associate" ? "none" : "forward") : raw.direction;
      if (direction === "backwards") direction = "reverse";
      if (DIRECTIONS.indexOf(direction) < 0) throw new Error("INVALID_DIRECTION: relations[" + i + "]");
      if ((raw.kind === "include" || raw.kind === "associate") && direction !== "none") throw new Error("DIRECTION_KIND_CONFLICT: " + raw.kind + " 必须为 none");
      if (raw.kind !== "include" && raw.kind !== "associate" && direction === "none") throw new Error("DIRECTION_KIND_CONFLICT: " + raw.kind + " 需要方向");
      var r = { id: rid, source: source, target: target, kind: raw.kind, direction: direction, evidence: [] };
      if (raw.bend !== undefined) { if (!finite(raw.bend) || Math.abs(raw.bend) > 100) throw new Error("INVALID_GEOMETRY: relations[" + i + "].bend"); r.bend = raw.bend; }
      if (raw.label !== undefined) r.label = text(raw.label, "relations[" + i + "].label", true);
      var ev = raw.evidence !== undefined ? raw.evidence : alias(raw, "source_refs", "sourceRefs", "relations[" + i + "]");
      r.evidence = normalizeEvidence(ev, sourceMap, warnings, "relations[" + i + "].evidence");
      if (raw.kind === "include") {
        if (includeParent[target]) throw new Error("INCLUDE_PARENT_CONFLICT: " + target + " 不能有多个容器");
        includeParent[target] = source;
      }
      relMap[rid] = r; spec.relations.push(r);
    });
    spec.nodes.forEach(function (n) {
      var seen = Object.create(null), cur = n.id;
      while (includeParent[cur]) {
        if (seen[cur]) throw new Error("INCLUDE_CYCLE: 包含关系存在环，涉及 " + n.id);
        seen[cur] = true; cur = includeParent[cur];
      }
    });
    spec.canvas = { width_mm: 120, height_mm: 90, dpi: 300, background: "#FFFFFF" };
    if (input.canvas !== undefined) {
      keys(input.canvas, ["width_mm", "height_mm", "widthMm", "heightMm", "dpi", "background"], "canvas");
      var cw = alias(input.canvas, "width_mm", "widthMm", "canvas"), ch = alias(input.canvas, "height_mm", "heightMm", "canvas");
      if (cw !== undefined) spec.canvas.width_mm = positive(cw, "canvas.width_mm");
      if (ch !== undefined) spec.canvas.height_mm = positive(ch, "canvas.height_mm");
      if (input.canvas.dpi !== undefined) spec.canvas.dpi = positive(input.canvas.dpi, "canvas.dpi");
      if (input.canvas.background !== undefined) spec.canvas.background = text(input.canvas.background, "canvas.background", false);
    }
    var hasChartSlot = spec.nodes.some(function (n) { return !!n.data_slot; });
    spec.layout = { mode: "layered", direction: "LR", columns: Math.min(hasChartSlot ? 2 : 4, spec.nodes.length), gap_x: 5, gap_y: 8, margin: 7, auto_layout: false, palette_id: null };
    if (input.layout !== undefined) {
      keys(input.layout, ["mode", "direction", "columns", "gap_x", "gap_y", "gapX", "gapY", "margin", "auto_layout", "autoLayout", "palette_id", "paletteId"], "layout");
      var paletteId = alias(input.layout, "palette_id", "paletteId", "layout");
      if (paletteId !== undefined && paletteId !== null) spec.layout.palette_id = text(paletteId, "layout.palette_id", false);
      if (input.layout.mode !== undefined) {
        if (["layered", "grid", "manual"].indexOf(input.layout.mode) < 0) throw new Error("INVALID_LAYOUT: layout.mode");
        spec.layout.mode = input.layout.mode;
      }
      if (input.layout.direction !== undefined) {
        if (["LR", "TB"].indexOf(input.layout.direction) < 0) throw new Error("INVALID_LAYOUT: layout.direction");
        spec.layout.direction = input.layout.direction;
      }
      if (input.layout.columns !== undefined) {
        if (!Number.isInteger(input.layout.columns) || input.layout.columns < 1) throw new Error("INVALID_LAYOUT: columns");
        spec.layout.columns = input.layout.columns;
      }
      ["gap_x", "gap_y", "margin"].forEach(function (k) {
        var v = k === "gap_x" ? alias(input.layout, "gap_x", "gapX", "layout") : k === "gap_y" ? alias(input.layout, "gap_y", "gapY", "layout") : input.layout[k];
        if (v !== undefined) { if (!finite(v) || v < 0) throw new Error("INVALID_LAYOUT: " + k); spec.layout[k] = v; }
      });
      var auto = alias(input.layout, "auto_layout", "autoLayout", "layout");
      if (auto !== undefined) { if (typeof auto !== "boolean") throw new Error("INVALID_LAYOUT: auto_layout"); spec.layout.auto_layout = auto; }
    }
    var coverage = { question: false, method: false, evidence: false, conclusion: false };
    spec.nodes.forEach(function (n) { coverage[n.role] = true; });
    var complete = true;
    if (template === "graphical_abstract") {
      ROLES.forEach(function (r) {
        if (!coverage[r]) { complete = false; warnings.push(warning("GA_ROLE_MISSING", "Graphical Abstract 缺少 role=" + r + "，状态为 partial")); }
      });
      if (!spec.sources.length) complete = false;
      spec.nodes.filter(function (n) { return n.role === "conclusion"; }).forEach(function (n) {
        if (!n.evidence.length) complete = false;
      });
    }
    return { spec: spec, warnings: warnings, coverage: coverage, complete: complete };
  }

  function size(n) { return n.data_slot ? { w: 46, h: 44 } : n.shape === "cell" ? { w: 25, h: 16 } : n.shape === "outcome" ? { w: 25, h: 15 } : { w: 24, h: 14 }; }
  function wideGlyph(cp) {
    return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd));
  }
  function glyphWidthMm(ch, fontPt) {
    var cp = ch.codePointAt(0), em = fontPt * PT_TO_MM, width;
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) ||
        (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) ||
        (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f)) return 0;
    if (wideGlyph(cp)) width = 1;
    else if (ch === "\t") width = 1.12;
    else if (/\s/u.test(ch)) width = 0.34;
    else if (cp < 128) {
      if (/[A-Z]/.test(ch)) width = 0.72;
      else if (/[a-z]/.test(ch)) width = 0.58;
      else if (/[0-9]/.test(ch)) width = 0.62;
      else if (/[.,:;'"!|iIjJltf()\[\]{}\-_/\\]/.test(ch)) width = 0.4;
      else width = 0.62;
    } else width = 0.65;
    return width * em;
  }
  function measureLine(value, fontPt) {
    return Array.from(String(value)).reduce(function (sum, ch) { return sum + glyphWidthMm(ch, fontPt); }, 0);
  }
  function labelUnits(paragraph) {
    return String(paragraph).match(/[A-Za-z0-9]+(?:[._:+\-\/][A-Za-z0-9]+)*|\s+|[\s\S]/gu) || [];
  }
  function wrapParagraph(paragraph, maxWidthMm, fontPt) {
    var lines = [], current = "";
    labelUnits(paragraph).forEach(function (unit) {
      var unitWidth = measureLine(unit, fontPt);
      if (measureLine(current + unit, fontPt) <= maxWidthMm + LAYOUT_EPS_MM) { current += unit; return; }
      if (unitWidth <= maxWidthMm + LAYOUT_EPS_MM) {
        lines.push(current); current = unit; return;
      }
      lines.push(current);
      var chunk = "";
      Array.from(unit).forEach(function (ch) {
        if (chunk && measureLine(chunk + ch, fontPt) > maxWidthMm + LAYOUT_EPS_MM) {
          lines.push(chunk); chunk = ch;
        } else chunk += ch;
      });
      current = chunk;
    });
    lines.push(current);
    return lines;
  }
  function wrapLabel(value, maxWidthMm, fontPt) {
    var available = Math.max(0.35, maxWidthMm);
    return String(value).split(/\r\n|\n|\r/).map(function (paragraph) {
      return wrapParagraph(paragraph, available, fontPt).join("\n");
    }).join("\n");
  }
  function labelMetrics(node, w, h) {
    var fontPt = node.fontSizePt === undefined ? 7 : node.fontSizePt;
    var rendered = wrapLabel(node.label, Math.max(0.35, w - 2 * LABEL_PAD_X_MM), fontPt);
    var lines = rendered.split("\n"), widths = lines.map(function (line) { return measureLine(line, fontPt); });
    return {
      node_id: node.id, text: rendered, font_size_pt: fontPt, line_height: 1.2,
      line_count: lines.length, line_widths_mm: widths.map(round),
      expected_width_mm: round(Math.max.apply(Math, widths.concat([0])) + 2 * LABEL_PAD_X_MM),
      expected_height_mm: round(lines.length * fontPt * PT_TO_MM * 1.2 + 2 * LABEL_PAD_Y_MM),
      body_width_mm: round(w), body_height_mm: round(h),
      original_label_length: Array.from(node.label).length
    };
  }
  function fittedLabel(node, maxWidthMm) {
    var base = size(node), fontPt = node.fontSizePt === undefined ? 7 : node.fontSizePt;
    var oneLine = Math.max.apply(Math, String(node.label).split(/\r\n|\n|\r/).map(function (line) {
      return measureLine(line, fontPt);
    }).concat([0])) + 2 * LABEL_PAD_X_MM;
    var limit = Math.max(1, maxWidthMm);
    var w = node.w === undefined ? Math.round(Math.max(Math.min(base.w, limit), Math.min(limit, oneLine)) * 1000000) / 1000000 : node.w;
    var contentWidth = Math.max(0.35, w - 2 * LABEL_PAD_X_MM);
    var wrapped = wrapLabel(node.label, contentWidth, fontPt);
    var lineCount = wrapped.split("\n").length;
    var requiredHeight = lineCount * fontPt * PT_TO_MM * 1.2 + 2 * LABEL_PAD_Y_MM;
    var h = node.h === undefined ? Math.max(base.h, requiredHeight) : node.h;
    return { w: round(w), h: round(h) };
  }
  function layoutDetail(spec) {
    var ordered = spec.nodes.map(function (n, i) { return { n: n, i: i }; });
    if (spec.template_id === "graphical_abstract") ordered.sort(function (a, b) { return ROLES.indexOf(a.n.role) - ROLES.indexOf(b.n.role) || a.i - b.i; });
    var columns = spec.layout.direction === "TB" ? 1 : Math.max(1, Math.min(spec.layout.columns, ordered.length));
    var rows = Math.ceil(ordered.length / columns), placed = Object.create(null), rowHeights = new Array(rows).fill(0);
    var cw = (spec.canvas.width_mm - 2 * spec.layout.margin - (columns - 1) * spec.layout.gap_x) / columns;
    var records = ordered.map(function (entry, i) {
      var n = entry.n, row = Math.floor(i / columns), col = i % columns;
      var maxWidth = n.x === undefined ? cw : Math.min(spec.canvas.width_mm - 2 * spec.layout.margin,
        spec.canvas.width_mm - spec.layout.margin - n.x);
      var fitted = fittedLabel(n, maxWidth);
      rowHeights[row] = Math.max(rowHeights[row], fitted.h);
      return { n: n, row: row, col: col, w: fitted.w, h: fitted.h };
    });
    var rowTops = [], top = spec.layout.margin;
    rowHeights.forEach(function (height) { rowTops.push(top); top += height + spec.layout.gap_y; });
    records.forEach(function (record) {
      var n = record.n, w = record.w, h = record.h;
      placed[n.id] = {
        x: n.x === undefined ? round(spec.layout.margin + record.col * (cw + spec.layout.gap_x) + Math.max(0, (cw - w) / 2)) : n.x,
        y: n.y === undefined ? round(rowTops[record.row] + Math.max(0, (rowHeights[record.row] - h) / 2)) : n.y,
        w: w, h: round(h), rotation: 0
      };
    });
    return { placed: placed, row_heights_mm: rowHeights.map(round), columns: columns };
  }
  function layout(spec) { return layoutDetail(spec).placed; }
  function base(idValue, type, t, z) {
    return { id: idValue, name: idValue, type: type, transform: { x: t.x, y: t.y, w: t.w, h: t.h, rotation: t.rotation || 0 },
      z: z, parent_id: null, locked: false, visible: true, style: {} };
  }
  function tag(el, spec, nodeIdValue, part) {
    el.diagram_id = spec.id; el.diagramId = spec.id;
    if (nodeIdValue !== null && nodeIdValue !== undefined) {
      el.diagramNodeId = nodeIdValue; el.semantic_node = { id: nodeIdValue };
    }
    el.diagram_part = part; el.source_claim = "user_provided_unverified";
    return el;
  }
  function union(a, b) {
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), right = Math.max(a.x+a.w,b.x+b.w), bottom = Math.max(a.y+a.h,b.y+b.h);
    return { x: round(x), y: round(y), w: round(right-x), h: round(bottom-y), rotation: 0 };
  }
  function ownedIds(doc, diagramId) {
    return doc.elements.filter(function (el) { return el && el.diagram_id === diagramId; }).map(function (el) { return el.id; });
  }
  var PALETTE_ROLES = { question: "neutral", method: "primary", evidence: "accent", conclusion: "signal" };
  function paletteStyle(spec, node) {
    var role = PALETTE_ROLES[node.role], color = COLORS[node.role];
    if (spec.layout.palette_id && global.FigPalette && typeof global.FigPalette.roleColor === "function") {
      var selected = global.FigPalette.roleColor(spec.layout.palette_id, role);
      if (selected) color = selected;
    }
    return { semanticRole: node.role, role: role, fill: color };
  }
  function slotLabelTransform(t) {
    return { x: t.x, y: t.y, w: t.w, h: round(Math.min(6, t.h * 0.25)), rotation: t.rotation || 0 };
  }
  function slotTransform(t) {
    var pad = Math.min(1, t.w * 0.05, t.h * 0.05), label = slotLabelTransform(t);
    return { x: round(t.x + pad), y: round(label.y + label.h),
      w: round(Math.max(0.1, t.w - 2 * pad)), h: round(Math.max(0.1, t.h - label.h - pad)), rotation: t.rotation || 0 };
  }
  function buildElements(spec, previous, keepManual, startZ) {
    var calculated = layoutDetail(spec), placed = calculated.placed;
    var automaticPlacements = clone(placed), old = Object.create(null), elements = [], groups = Object.create(null);
    var positionBasis = Object.create(null), previousPlacements = Object.create(null);
    (previous || []).forEach(function (el) { old[el.id] = el; });
    spec.nodes.forEach(function (n) {
      var prior = old[n.id];
      positionBasis[n.id] = !keepManual ? "auto_layout" : n.x !== undefined ? "spec_explicit_xy" : "computed_layout";
      if (prior && obj(prior.transform)) previousPlacements[n.id] = clone(prior.transform);
      if (keepManual && prior && prior.type === "group" && obj(prior.transform)) {
        var priorTransform = prior.declared_transform || prior.transform;
        placed[n.id] = Object.assign({}, placed[n.id], { x: priorTransform.x, y: priorTransform.y });
        positionBasis[n.id] = "previous_declared_position";
        if (prior.diagram_manual_layout === true) {
          placed[n.id] = clone(prior.transform);
          positionBasis[n.id] = "previous_manual_transform";
        }
      }
    });
    var z = startZ || 1, root = tag(base("diagram-" + spec.id + ":root", "group",
      { x: 0, y: 0, w: spec.canvas.width_mm, h: spec.canvas.height_mm }, z++), spec, null, "scene");
    root.children = [];
    spec.nodes.forEach(function (n) {
      var t = clone(placed[n.id]), group = tag(base(n.id, "group", t, z++), spec, n.id, "node");
      group.semantic_node = { id: n.id, role: n.role, kind: n.kind, shape: n.shape };
      group.semantic_role = n.role; group.entity_kind = n.kind; group.declared_shape = n.shape;
      group.declared_transform = clone(t); group.diagram_manual_layout = !!(old[n.id] && old[n.id].diagram_manual_layout);
      group.evidence = clone(n.evidence); group.source_refs = clone(n.evidence); group.children = [];
      group.parent_id = root.id; elements.push(group); groups[n.id] = group;
      var shapeType = ["ellipse", "cell", "molecule", "outcome"].indexOf(n.shape) >= 0 ? "ellipse" : "rect";
      var shape = tag(base(n.id + ".shape", shapeType, t, z++), spec, n.id, "node_shape");
      shape.parent_id = n.id; shape.declared_shape = n.shape; shape.semantic_role = n.role;
      var semanticPaint = paletteStyle(spec, n);
      shape.style = { fill: n.color || n.fill || semanticPaint.fill, stroke: n.stroke || "#334155", strokeWidthPt: 0.9,
        cornerRadiusMm: n.shape === "cell" || n.shape === "process" ? 3 : 1,
        role: semanticPaint.role, semanticRole: semanticPaint.semanticRole };
      shape.evidence = clone(n.evidence);
      var priorShape = old[shape.id];
      if (keepManual && priorShape && priorShape.diagram_manual_layout) shape.transform = clone(priorShape.transform);
      elements.push(shape); group.children.push(shape.id);
      var labelTransform = n.data_slot ? slotLabelTransform(t) : clone(t);
      var label = tag(base(n.id + ".label", "text", labelTransform, z++), spec, n.id, "node_text");
      var metrics = labelMetrics(n, labelTransform.w, labelTransform.h);
      label.parent_id = n.id; label.text = metrics.text; label.contract_label = n.label; label.semantic_role = n.role;
      label.diagram_label_layout = clone(metrics);
      label.style = { fill: "#172033", fontFamily: "Arial, sans-serif", fontSizePt: n.fontSizePt === undefined ? 7 : n.fontSizePt,
        textAlign: "center", verticalAlign: "middle", lineHeight: 1.2, role: n.role };
      label.evidence = clone(n.evidence);
      var priorText = old[label.id];
      if (keepManual && priorText) {
        if (priorText.contract_label === n.label && typeof priorText.text === "string") label.text = priorText.text;
        if (priorText.semantic_role === n.role && obj(priorText.style)) label.style = Object.assign({}, clone(priorText.style), { role: n.role });
        label.diagram_label_layout.text = label.text;
      }
      elements.push(label); group.children.push(label.id);
      if (n.data_slot) {
        var slot = tag(base(n.id + ".slot", "rect", slotTransform(t), z++), spec, n.id, "chart_slot");
        slot.parent_id = n.id; slot.slot_type = "chart";
        slot.intentional_overlap = { element_id: n.id, declared: true, reason: "explicit chart data slot inside declared subject" };
        slot.style = { fill: null, stroke: "#64748B", strokeWidthPt: 0.65, dash: "2 1", role: "chart_slot" };
        group.chart_slot = { element_id: slot.id, slot_type: "chart", intentional_overlap: true };
        elements.push(slot); group.children.push(slot.id);
      }
    });
    var parent = Object.create(null), includedChildren = Object.create(null);
    spec.relations.filter(function (r) { return r.kind === "include"; }).forEach(function (r) {
      parent[r.target] = r.source; includedChildren[r.source] = true;
      groups[r.target].parent_id = groups[r.source].id;
      groups[r.source].children.push(groups[r.target].id);
      groups[r.source].include_evidence = (groups[r.source].include_evidence || []).concat(clone(r.evidence));
    });
    function grow(nid) {
      var specNode = spec.nodes.filter(function (n) { return n.id === nid; })[0];
      var g = groups[nid], own = clone(g.declared_transform), box = clone(own);
      spec.relations.filter(function (r) { return r.kind === "include" && r.source === nid; }).forEach(function (r) {
        var child = grow(r.target); box = union(box, child.transform);
      });
      if (includedChildren[nid]) { box.x=round(box.x-3);box.y=round(box.y-3);box.w=round(box.w+6);box.h=round(box.h+6); }
      var previousNode = old[nid];
      var manual = keepManual && previousNode && previousNode.diagram_manual_layout === true;
      if (manual) box = clone(previousNode.transform);
      g.transform = clone(box);
      var sh = elements.filter(function (el) { return el.id === nid + ".shape"; })[0];
      var tx = elements.filter(function (el) { return el.id === nid + ".label"; })[0];
      sh.transform = manual && old[sh.id] ? clone(old[sh.id].transform) : clone(box);
      tx.transform = specNode.data_slot ? slotLabelTransform(box) : manual && old[tx.id] ? clone(old[tx.id].transform) :
        includedChildren[nid] ? { x: box.x+2, y: box.y+1, w: Math.max(1,box.w-4), h: 6, rotation: 0 } : clone(box);
      var slot = elements.filter(function (el) { return el.id === nid + ".slot"; })[0];
      if (slot) slot.transform = slotTransform(box);
      if (!manual || !old[tx.id]) tx.diagram_label_layout = labelMetrics(specNode, tx.transform.w, tx.transform.h);
      return g;
    }
    spec.nodes.forEach(function (n) { if (!parent[n.id]) { grow(n.id); root.children.push(n.id); } });
    (previous || []).forEach(function (prior) {
      if (!prior || typeof prior.diagram_slot_id !== "string" || prior.diagram_part === "chart_slot") return;
      var owner = groups[prior.diagram_slot_id];
      if (!owner || !owner.chart_slot) return;
      var kept = clone(prior);
      if (kept.slot_generated_chart === true && (!keepManual || kept.diagram_manual_layout !== true)) {
        kept.transform = slotTransform(groups[kept.diagram_slot_id].transform);
        kept.declared_transform = clone(kept.transform);
      }
      kept.parent_id = owner.id; owner.children.push(kept.id); elements.push(kept);
    });
    spec.relations.filter(function (r) { return r.kind !== "include"; }).forEach(function (r) {
      var c = tag(base("diagram-" + spec.id + ":relation:" + r.id, "connector",
        { x: 0, y: 0, w: spec.canvas.width_mm, h: spec.canvas.height_mm }, z++), spec, null, "relation");
      c.relation = { source: r.source, target: r.target, kind: r.kind, direction: r.direction };
      if (r.bend !== undefined) c.relation.bend = r.bend;
      if (r.label !== undefined) c.relation.label = r.label;
      c.semantic_relation = { id: r.id, source: r.source, target: r.target, kind: r.kind, direction: r.direction };
      c.parent_id = root.id;
      c.evidence = clone(r.evidence); c.source_refs = clone(r.evidence);
      c.style = { stroke: r.kind === "activate" ? "#2E7D32" : r.kind === "inhibit" ? "#C62828" : "#334155",
        strokeWidthPt: 1.1, fill: null, arrowHead: "none", role: "relation_" + r.kind };
      if (r.label) {
        var l = tag(base(c.id + ".label", "text", { x: 0, y: 0, w: 20, h: 5 }, z++), spec, null, "relation_text");
        l.parent_id = root.id; l.text = r.label; l.relation_label_for = c.id;
        l.style = { fill: "#374151", fontFamily: "Arial, sans-serif", fontSizePt: 6, textAlign: "center", verticalAlign: "middle" };
        c.label_element_id = l.id; elements.push(l); root.children.push(l.id);
      }
      elements.push(c); root.children.push(c.id);
    });
    root.diagram_id = spec.id; root.diagramId = spec.id;
    var all = [root].concat(elements), byId = Object.create(null);
    all.forEach(function (el) { if (byId[el.id]) throw new Error("DUPLICATE_ELEMENT_ID: " + el.id); byId[el.id] = el; });
    function depth(el) { var d = 0, p = el.parent_id; while (p) { d++; p = byId[p] && byId[p].parent_id; } return d; }
    all.sort(function (a, b) { return depth(a) - depth(b) || a.z - b.z; });
    var slotPlacements = Object.create(null);
    elements.filter(function (el) { return el.diagram_part === "chart_slot"; }).forEach(function (el) {
      slotPlacements[el.diagramNodeId] = { element_id: el.id, transform: clone(el.transform) };
    });
    return { elements: all, placements: placed, layout: {
      row_heights_mm: calculated.row_heights_mm, columns: calculated.columns,
      coordinate_space: "element-mm", auto_layout: !keepManual,
      automatic_placements: automaticPlacements, previous_placements: previousPlacements,
      position_basis: positionBasis, chart_slot_placements: slotPlacements
    } };
  }

  function build(doc, input, opts) {
    opts = opts || {};
    if (!global.FigDoc) throw new Error("FigDiagram.build 依赖 FigDoc");
    var base = doc == null ? global.FigDoc.create() : clone(doc);
    if (!obj(base) || !Array.isArray(base.elements) || !obj(base.canvas)) throw new Error("INVALID_DOCUMENT: build 需要 FigureDocument");
    var normalized = normalize(input), spec = normalized.spec, warnings = normalized.warnings.slice();
    var previous = base.elements.filter(function (el) { return el && el.diagram_id === spec.id; });
    var collisions = base.elements.filter(function (el) {
      if (!el || el.diagram_id === spec.id) return false;
      if (el.id === "diagram-" + spec.id + ":root") return true;
      return spec.nodes.some(function (n) { return n.id === el.id || n.id + ".shape" === el.id || n.id + ".label" === el.id; });
    });
    if (collisions.length) throw new Error("ELEMENT_ID_CONFLICT: 语义元素 id 已被无关文档元素占用：" + collisions[0].id);
    base.canvas = Object.assign({}, base.canvas, clone(spec.canvas));
    var other = base.elements.filter(function (el) { return !el || el.diagram_id !== spec.id; });
    var maxZ = 0; other.forEach(function (el) { if (el && finite(el.z)) maxZ = Math.max(maxZ, el.z); });
    var built = buildElements(spec, previous, opts.auto_layout !== true && spec.layout.auto_layout !== true, maxZ + 1);
    base.elements = other.concat(built.elements);
    base.meta = base.meta || {}; base.meta.diagrams = base.meta.diagrams || {};
    var layoutNodes = built.elements.filter(function (el) { return el.diagram_part === "node"; }).map(function (el) {
      var label = built.elements.filter(function (candidate) {
        return candidate.type === "text" && candidate.diagramNodeId === el.diagramNodeId;
      })[0];
      var slot = built.elements.filter(function (candidate) {
        return candidate.diagram_part === "chart_slot" && candidate.parent_id === el.id;
      })[0];
      return { id: el.diagramNodeId, element_id: el.id, parent_id: el.parent_id, role: el.semantic_role,
        declared_shape: el.declared_shape, transform: clone(el.transform), chart_slot: slot ? {
          element_id: slot.id, transform: clone(slot.transform), intentional_overlap: true,
          child_element_ids: built.elements.filter(function (child) {
            return child.parent_id === el.id && typeof child.diagram_slot_id === "string";
          }).map(function (child) { return child.id; })
        } : null,
        label_layout: label && label.diagram_label_layout ? clone(label.diagram_label_layout) : null };
    });
    var materialRelations = spec.relations.map(function (r) {
      return { id: r.id, element_id: r.kind === "include" ? r.source : "diagram-" + spec.id + ":relation:" + r.id,
        source: r.source, target: r.target, kind: r.kind, direction: r.direction,
        render: r.kind === "include" ? "container" : "connector", evidence: clone(r.evidence) };
    });
    var wholeAudit = auditLayout(base);
    var layoutAudit = wholeAudit.diagrams.filter(function (entry) { return entry.diagram_id === spec.id; })[0];
    if (!layoutAudit) layoutAudit = wholeAudit;
    warnings = warnings.concat(clone(layoutAudit.warnings));
    var contractHash = hash(spec), sourceHash = hash(spec.sources);
    var layoutHash = hash({ canvas: spec.canvas, layout: built.layout, nodes: layoutNodes, relations: materialRelations });
    var status = normalized.complete && !layoutAudit.warnings.length ? "ready_for_human_review" : "partial";
    warnings.push(warning("CLONE_AND_REVIEW_BOUNDARY", "build 返回可变克隆且不改输入 doc；来源只按用户提供保存，未执行来源抓取、科学核实或真实人类视觉复核"));
    if (previous.length) warnings.push(warning("SCENE_REPLACED", "仅重建 diagram_id=" + spec.id + " 的声明场景；其他 panel/chart 与同 slot 的已绑定/用户内容保留，旧场景恢复依赖 FigOps 完整 history"));
    var meta = {
      schema_version: VERSION, id: spec.id, template_id: spec.template_id,
      spec: clone(spec), contract: clone(spec), contract_sha256: contractHash,
      sources: clone(spec.sources), source_sha256: sourceHash, source_verification: "user_provided_unverified",
      coverage: clone(normalized.coverage), status: status,
      scientific_review: { human_reviewed: false, sources_fetched: false,
        user_review_record: spec.human_review ? clone(spec.human_review) : null },
      review_status: spec.human_review ? "user_record_present" : "not_recorded",
      uncertainties: clone(spec.uncertainties),
      layout: Object.assign(clone(spec.layout), { resolution: clone(built.layout) }),
      resolved_layout: clone(built.layout), layout_sha256: layoutHash,
      layout_status: layoutAudit.warnings.length ? "needs_layout_review" : "no_automatic_risk_detected",
      layout_audit: { status: layoutAudit.warnings.length ? "needs_layout_review" : "no_automatic_risk_detected",
        risk_count: layoutAudit.warnings.length, visual_acceptance: "not_assessed", human_reviewed: false,
        canvas: clone(layoutAudit.canvas || wholeAudit.canvas), warnings: clone(layoutAudit.warnings) },
      nodes: layoutNodes, relations: materialRelations,
      generated_at: opts.generated_at === undefined ? null : opts.generated_at,
      materialized_ids_frozen: true, element_ids: built.elements.map(function (el) { return el.id; }),
      warnings: clone(warnings)
    };
    base.meta.diagrams[spec.id] = meta;
    (base.anchors || []).forEach(function (a) {
      if (!Array.isArray(a.element_ids)) return;
      a.element_ids = a.element_ids.filter(function (eid) { return base.elements.some(function (el) { return el.id === eid; }); });
    });
    if (Array.isArray(base.panels)) base.panels = base.panels.filter(function (p) {
      return !previous.some(function (el) { return el.id === p.element_id; });
    });
    return { doc: base, warnings: warnings };
  }

  function validateSpec(input) {
    try { var n = normalize(input); layout(n.spec); return { ok: true, errors: [], warnings: n.warnings,
      partial: !n.complete, spec: n.spec, supported_templates: TEMPLATES.slice() }; }
    catch (e) { return { ok: false, errors: [e.message], warnings: [], spec: null, supported_templates: TEMPLATES.slice() }; }
  }
  function example(templateId, synthetic) {
    var idValue = templateId || "workbench-schematic";
    var graphical = idValue === "tpl-graphical-abstract" || idValue === "graphical_abstract" || idValue === "workbench-schematic";
    var roles = graphical ? ["question", "method", "evidence", "conclusion"] : ["question", "method", "conclusion"];
    var labels = synthetic === false ? roles.map(function (_, i) { return "待填写实体 " + (i + 1); }) :
      graphical ? ["研究问题（示例）", "方法路线（示例）", "核心证据（示例）", "结论（示例）"] :
        ["输入（示例）", "处理（示例）", "输出（示例）"];
    return { id: idValue, template_id: TEMPLATE_IDS[idValue] ? idValue : "flow",
      nodes: roles.map(function (role, i) {
        return { id: graphical ? role : "node-" + (i + 1), label: labels[i], role: role, shape: role === "method" ? "process" : "box" };
      }),
      relations: roles.slice(1).map(function (_, i) {
        var nodes = graphical ? roles : roles.map(function (r, ri) { return "node-" + (ri + 1); });
        return { id: "relation-" + (i + 1), source: nodes[i], target: nodes[i + 1], kind: "sequence" };
      }),
      sources: [{ id: "synthetic", locator: "用户界面合成示例；无论文、实验来源、单位或百分比" }],
      uncertainties: [(graphical ? "四阶段 Graphical Abstract" : "结构") + "仅为合成参数示例，不是论文图、正式案例或科学结论。"]
    };
  }
  function supportsTemplate(tpl) {
    var generic = { "tpl-diagram-flow": true, "tpl-diagram-arch": true,
      "tpl-diagram-pipeline": true, "tpl-graphical-abstract": true };
    var value = typeof tpl === "string" ? tpl : obj(tpl) && (tpl.id || tpl.template_id || tpl.template || tpl.chart_type);
    var supported = !!generic[value];
    if (obj(tpl) && !value && tpl.chart_type === "graphical_abstract") supported = true;
    return { supported: supported, mode: "raw_parameters_only", requires_data: false,
      requires: supported ? "apply_schematic.contract" : null,
      reason: supported ? "原生可编辑矢量；仅原始 nodes/relations/sources，不做数据自动关联，合成示例不代表论文" :
        "没有保守的通用实体关系映射，保持 unsupported，不把占位预览称为自动支持" };
  }
  function templateCapability(tpl) {
    var verdict = supportsTemplate(tpl), supported = verdict.supported;
    var value = typeof tpl === "string" ? tpl : tpl && (tpl.id || tpl.template_id || tpl.chart_type);
    return { template_id: value || null, supported: supported, status: supported ? "full" : "unsupported",
      can_generate: supported, can_apply: supported, can_preview: supported, requires_schematic: supported,
      reason: verdict.reason };
  }

  function previewSVG(input) {
    if (!global.FigDoc || !global.FigRender) throw new Error("PREVIEW_UNAVAILABLE: previewSVG 需要 FigDoc 与 FigRender");
    var spec = normalize(input).spec;
    var created = global.FigDoc.create({ title: "声明式示意图预览", width_mm: spec.canvas.width_mm,
      height_mm: spec.canvas.height_mm, dpi: spec.canvas.dpi, background: spec.canvas.background });
    return global.FigRender.toSVG(build(created, spec).doc);
  }

  function rawNodeBox(doc, el) {
    var t = obj(el.transform) ? el.transform : {};
    var box = { x: finite(t.x) ? t.x : 0, y: finite(t.y) ? t.y : 0,
      w: finite(t.w) ? t.w : 0, h: finite(t.h) ? t.h : 0,
      rotation: finite(t.rotation) ? t.rotation : 0 };
    if (el.style && el.style.panelRelative === true && el.parent_id) {
      var panel = doc.elements.find(function (candidate) { return candidate && candidate.id === el.parent_id; });
      if (panel && panel.type === "panel" && obj(panel.transform)) {
        var pl = obj(panel.panelLayout) ? panel.panelLayout : {};
        var pad = finite(pl.padding_mm) && pl.padding_mm >= 0 ? pl.padding_mm : 0;
        var iw = Math.max(0, panel.transform.w - 2 * pad), ih = Math.max(0, panel.transform.h - 2 * pad);
        box.x = panel.transform.x + pad + box.x * iw;
        box.y = panel.transform.y + pad + box.y * ih;
        box.w *= iw; box.h *= ih;
      }
    }
    return box;
  }
  function boxCenter(box) { return { x: box.x + box.w / 2, y: box.y + box.h / 2 }; }
  function rotatedPoint(point, box, angle) {
    if (!angle) return { x: point.x, y: point.y };
    var c = boxCenter(box), r = angle * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
    var dx = point.x - c.x, dy = point.y - c.y;
    return { x: c.x + dx * co - dy * si, y: c.y + dx * si + dy * co };
  }
  function parentChain(doc, el) {
    var chain = [], seen = Object.create(null), current = el;
    while (current && current.parent_id) {
      if (seen[current.id]) throw new Error("INVALID_PARENT_FRAME: 父级引用循环 " + current.id);
      seen[current.id] = true;
      if (chain.length >= 64) throw new Error("INVALID_PARENT_FRAME: 父级层级超过 64");
      current = doc.elements.find(function (candidate) { return candidate && candidate.id === current.parent_id; });
      if (!current) break;
      chain.push(current);
    }
    return chain;
  }
  function worldNodeBox(doc, el) {
    var box = rawNodeBox(doc, el), points = [
      { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y },
      { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }
    ];
    var chain = parentChain(doc, el);
    points = points.map(function (point) {
      var out = rotatedPoint(point, box, box.rotation);
      chain.forEach(function (parent) {
        var pb = rawNodeBox(doc, parent);
        out = rotatedPoint(out, pb, pb.rotation);
      });
      return out;
    });
    var xs = points.map(function (p) { return p.x; }), ys = points.map(function (p) { return p.y; });
    var x1 = Math.min.apply(Math, xs), x2 = Math.max.apply(Math, xs);
    var y1 = Math.min.apply(Math, ys), y2 = Math.max.apply(Math, ys);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, rotation: 0 };
  }
  function chartSlots(doc, sceneId) {
    if (!obj(doc) || !Array.isArray(doc.elements)) throw new Error("INVALID_DOCUMENT: chartSlots 需要 FigureDocument");
    return doc.elements.filter(function (el) {
      return el && el.visible !== false && el.diagram_part === "chart_slot" && el.slot_type === "chart" &&
        (sceneId === undefined || sceneId === null || (el.diagram_id || el.diagramId) === sceneId);
    }).map(function (slot) {
      var owner = doc.elements.filter(function (el) { return el && el.id === slot.parent_id && el.type === "group"; })[0];
      if (!owner) throw new Error("INVALID_CHART_SLOT: slot 缺少原生 group 容器：" + slot.id);
      if (!obj(slot.transform) || ![slot.transform.x, slot.transform.y, slot.transform.w, slot.transform.h].every(finite) ||
          slot.transform.w <= 0 || slot.transform.h <= 0) throw new Error("INVALID_CHART_SLOT: slot bbox 无效：" + slot.id);
      return { scene_id: slot.diagram_id || slot.diagramId, node_id: slot.diagramNodeId,
        slot_element_id: slot.id, parent_id: owner.id, transform: clone(slot.transform),
        group_transform: clone(owner.transform), intentional_overlap: true,
        generated_chart_ids: doc.elements.filter(function (el) {
          return el && el.type === "chart" && el.slot_generated_chart === true && el.diagram_slot_id === slot.diagramNodeId;
        }).map(function (el) { return el.id; }).sort() };
    }).sort(function (a, b) {
      return (a.scene_id + "\u0000" + a.node_id) < (b.scene_id + "\u0000" + b.node_id) ? -1 : 1;
    });
  }
  function boundary(box, towards) {
    var c = boxCenter(box), dx = towards.x - c.x, dy = towards.y - c.y;
    if (!dx && !dy) return c;
    var tx = dx ? (box.w / 2) / Math.abs(dx) : Infinity;
    var ty = dy ? (box.h / 2) / Math.abs(dy) : Infinity;
    var scale = Math.min(tx, ty);
    return { x: c.x + dx * scale, y: c.y + dy * scale };
  }
  function relationNode(doc, connector, ref) {
    if (typeof ref !== "string" || !ref) throw new Error("INVALID_RELATION_REFERENCE: connector " + connector.id + " 缺少节点 id");
    var direct = doc.elements.filter(function (el) { return el && el.id === ref && el.type !== "connector"; });
    if (direct.length === 1) return direct[0];
    var diagramId = connector.diagramId || connector.diagram_id;
    var matches = doc.elements.filter(function (el) {
      return el && el.type === "group" && el.diagramNodeId === ref &&
        (el.diagramId || el.diagram_id) === diagramId;
    });
    if (matches.length !== 1) throw new Error("INVALID_RELATION_REFERENCE: connector " + connector.id + " 的节点引用无效或重复：" + ref);
    return matches[0];
  }
  function toConnectorPoint(doc, connector, point) {
    var chain = parentChain(doc, connector);
    for (var i = chain.length - 1; i >= 0; i--) {
      var box = rawNodeBox(doc, chain[i]);
      point = rotatedPoint(point, box, -box.rotation);
    }
    return point;
  }
  function toConnectorBox(doc, connector, box) {
    var points = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y },
      { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }
    ].map(function (point) { return toConnectorPoint(doc, connector, point); });
    var xs = points.map(function (p) { return p.x; }), ys = points.map(function (p) { return p.y; });
    var x1 = Math.min.apply(Math, xs), x2 = Math.max.apply(Math, xs);
    var y1 = Math.min.apply(Math, ys), y2 = Math.max.apply(Math, ys);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function connectorObstacles(doc, connector, sourceNode, targetNode) {
    var diagramId = connector.diagramId || connector.diagram_id;
    var ancestors = Object.create(null);
    [sourceNode, targetNode].forEach(function (node) {
      parentChain(doc, node).forEach(function (parent) {
        if (typeof parent.diagramNodeId === "string") ancestors[parent.id] = true;
      });
    });
    return doc.elements.filter(function (el) {
      return el && el.type === "group" && typeof el.diagramNodeId === "string" && el.visible !== false &&
        (el.diagramId || el.diagram_id) === diagramId &&
        el.id !== sourceNode.id && el.id !== targetNode.id && el.diagramNodeId !== sourceNode.diagramNodeId &&
        el.diagramNodeId !== targetNode.diagramNodeId && !ancestors[el.id];
    }).map(function (el) { return { id: el.id, node_id: el.diagramNodeId, box: worldNodeBox(doc, el) }; });
  }
  function pathIsClear(points, obstacles) {
    return obstacles.every(function (obstacle) {
      for (var i = 0; i + 1 < points.length; i++) {
        if (segmentThroughBox(points[i], points[i + 1], obstacle.box)) return false;
      }
      return true;
    });
  }
  function compactPolyline(points) {
    var compact = [];
    points.forEach(function (point) {
      var prior = compact[compact.length - 1];
      if (!prior || Math.abs(point.x - prior.x) > 1e-9 || Math.abs(point.y - prior.y) > 1e-9) compact.push(point);
    });
    var out = [];
    compact.forEach(function (point) {
      var n = out.length;
      if (n >= 2) {
        var a = out[n - 2], b = out[n - 1];
        var abx = b.x - a.x, aby = b.y - a.y, bcx = point.x - b.x, bcy = point.y - b.y;
        if (Math.abs(abx * bcy - aby * bcx) < 1e-9 && abx * bcx + aby * bcy > 0) out.pop();
      }
      out.push(point);
    });
    return out;
  }
  function pathLength(points) {
    var total = 0;
    for (var i = 0; i + 1 < points.length; i++) {
      total += Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y);
    }
    return total;
  }
  function polylineMidpoint(points) {
    var halfway = pathLength(points) / 2;
    for (var i = 0; i + 1 < points.length; i++) {
      var a = points[i], b = points[i + 1], length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (!length) continue;
      if (halfway <= length) {
        var ratio = halfway / length;
        return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
      }
      halfway -= length;
    }
    return { x: points[0].x, y: points[0].y };
  }
  function orthogonalRoute(a, b, obstacles, portStart, portEnd) {
    var ca = boxCenter(a), cb = boxCenter(b), candidates = [];
    function channels(axis) {
      var values = [];
      obstacles.forEach(function (obstacle) {
        var box = obstacle.box;
        values.push(axis === "y" ? box.y - 2 : box.y + box.h + 2);
        if (axis === "x") values[values.length - 1] = box.x + box.w + 2;
        values.push(axis === "y" ? box.y + box.h + 2 : box.x - 2);
      });
      values.sort(function (p, q) { return p - q; });
      return values.filter(function (value, i) { return !i || Math.abs(value - values[i - 1]) > LAYOUT_EPS_MM; });
    }
    channels("y").forEach(function (channel) {
      if (Math.abs(channel - ca.y) <= LAYOUT_EPS_MM || Math.abs(channel - cb.y) <= LAYOUT_EPS_MM) return;
      candidates.push(compactPolyline([portStart, { x: portStart.x, y: channel },
        { x: portEnd.x, y: channel }, portEnd]));
    });
    channels("x").forEach(function (channel) {
      if (Math.abs(channel - ca.x) <= LAYOUT_EPS_MM || Math.abs(channel - cb.x) <= LAYOUT_EPS_MM) return;
      candidates.push(compactPolyline([portStart, { x: channel, y: portStart.y },
        { x: channel, y: portEnd.y }, portEnd]));
    });
    candidates = candidates.filter(function (points) { return pathIsClear(points, obstacles); });
    candidates.sort(function (p, q) {
      var difference = pathLength(p) - pathLength(q);
      if (Math.abs(difference) > LAYOUT_EPS_MM) return difference;
      var ps = stable(p), qs = stable(q);
      return ps < qs ? -1 : ps > qs ? 1 : 0;
    });
    return candidates.length ? candidates[0] : null;
  }
  function portSide(box, otherBox) {
    var c = boxCenter(box), other = boxCenter(otherBox), dx = other.x - c.x, dy = other.y - c.y;
    if (Math.abs(dx) * Math.max(box.h, LAYOUT_EPS_MM) >= Math.abs(dy) * Math.max(box.w, LAYOUT_EPS_MM)) {
      return dx >= 0 ? "right" : "left";
    }
    return dy >= 0 ? "bottom" : "top";
  }
  function portPoint(box, side, fraction) {
    if (side === "right") return { x: box.x + box.w, y: box.y + box.h * fraction };
    if (side === "left") return { x: box.x, y: box.y + box.h * fraction };
    if (side === "bottom") return { x: box.x + box.w * fraction, y: box.y + box.h };
    return { x: box.x + box.w * fraction, y: box.y };
  }
  function endpointPort(doc, connector, endpoint, node, otherNode) {
    var diagramId = connector.diagramId || connector.diagram_id;
    var box = worldNodeBox(doc, node), otherBox = worldNodeBox(doc, otherNode), side = portSide(box, otherBox);
    var peers = doc.elements.filter(function (candidate) {
      if (!candidate || candidate === connector || candidate.visible === false || candidate.type !== "connector" ||
          (candidate.diagramId || candidate.diagram_id) !== diagramId || !obj(candidate.relation) ||
          candidate.relation.kind === "include") return false;
      var relation = candidate.relation, otherEndpoint = endpoint === "source" ? "target" : "source";
      if (relation[endpoint] !== node.diagramNodeId && relation[endpoint] !== node.id) return false;
      var peerOther = doc.elements.filter(function (el) {
        return el && el.type === "group" && el.id !== node.id &&
          (el.id === relation[otherEndpoint] || el.diagramNodeId === relation[otherEndpoint]) &&
          (el.diagramId || el.diagram_id) === diagramId;
      })[0];
      return peerOther && portSide(box, worldNodeBox(doc, peerOther)) === side;
    }).concat(connector).sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    var index = peers.indexOf(connector), count = peers.length, fraction;
    var sideLength = side === "left" || side === "right" ? box.h : box.w;
    if (count === 2) {
      fraction = index === 0 ? 0.25 : 0.75;
      var otherEndpointName = endpoint === "source" ? "target" : "source";
      var centers = peers.map(function (peer) {
        var ref = peer.relation[otherEndpointName];
        var peerNode = doc.elements.filter(function (el) {
          return el && el.type === "group" && (el.id === ref || el.diagramNodeId === ref) &&
            (el.diagramId || el.diagram_id) === diagramId;
        })[0];
        var center = boxCenter(worldNodeBox(doc, peerNode));
        return side === "left" || side === "right" ? center.y : center.x;
      });
      var mean = (centers[0] + centers[1]) / 2;
      fraction += Math.max(-0.125, Math.min(0.125, 0.125 * (centers[index] - mean) / Math.max(sideLength, LAYOUT_EPS_MM)));
    } else if (count === 1) fraction = 0.5;
    else {
      var margin = Math.max(0.1, Math.min(0.25, 2 / Math.max(sideLength, LAYOUT_EPS_MM)));
      fraction = margin + (1 - 2 * margin) * index / Math.max(1, count - 1);
    }
    fraction = Math.max(0, Math.min(1, fraction));
    var ids = peers.map(function (peer) { return peer.id; });
    return { id: "port-" + hash({ diagram_id: diagramId, node_id: node.diagramNodeId || node.id,
      connector_id: connector.id, endpoint: endpoint, side: side, connector_ids: ids }).slice(0, 16),
      endpoint: endpoint, side: side, index: index, count: count, fraction: round(fraction),
      connector_ids: ids, point: portPoint(box, side, fraction), coordinate_space: "world-mm",
      spread_policy: "n=1:50%;n=2:25%/75% plus direction offset <=12.5%;n>=3:even in 2mm edge band, fraction clamp 10%-25%" };
  }

  function connectorGeometry(doc, connector) {
    if (!obj(doc) || !Array.isArray(doc.elements) || !obj(connector) || !obj(connector.relation)) {
      throw new Error("INVALID_RELATION: connectorGeometry 需要含 relation 的文档元素");
    }
    var rel = connector.relation;
    if (RELATIONS.indexOf(rel.kind) < 0) throw new Error("INVALID_RELATION_KIND: " + rel.kind);
    var direction = rel.direction === "backwards" ? "reverse" : rel.direction;
    if (direction === undefined) direction = rel.kind === "include" || rel.kind === "associate" ? "none" : "forward";
    if (DIRECTIONS.indexOf(direction) < 0 ||
        ((rel.kind === "associate" || rel.kind === "include") && direction !== "none") ||
        (rel.kind !== "associate" && rel.kind !== "include" && direction === "none")) {
      throw new Error("DIRECTION_KIND_CONFLICT: " + connector.id);
    }
    var sourceNode = relationNode(doc, connector, rel.source), targetNode = relationNode(doc, connector, rel.target);
    var a = worldNodeBox(doc, sourceNode), b = worldNodeBox(doc, targetNode);
    var sourcePort = rel.kind === "include" ? null : endpointPort(doc, connector, "source", sourceNode, targetNode);
    var targetPort = rel.kind === "include" ? null : endpointPort(doc, connector, "target", targetNode, sourceNode);
    var start = sourcePort ? sourcePort.point : boundary(a, boxCenter(b));
    var end = targetPort ? targetPort.point : boundary(b, boxCenter(a));
    var obstacles = connectorObstacles(doc, connector, sourceNode, targetNode);
    var dx = end.x - start.x, dy = end.y - start.y, length = Math.sqrt(dx * dx + dy * dy) || 1;
    var bend = finite(rel.bend) ? rel.bend : 0;
    var middle = { x: (start.x + end.x) / 2 - dy / length * bend,
      y: (start.y + end.y) / 2 + dx / length * bend };
    var points = [start, end], pathType = bend ? "quadratic" : "straight", routeResolved = true;
    if (bend) {
      points = [start, middle, end];
    } else if (rel.kind !== "include" && !pathIsClear(points, obstacles)) {
      var routed = orthogonalRoute(a, b, obstacles, start, end);
      if (routed) {
        points = routed; pathType = "orthogonal"; middle = polylineMidpoint(points);
        start = points[0]; end = points[points.length - 1];
      } else routeResolved = false;
    }
    if (!points.length || points.some(function (point) { return !point || !finite(point.x) || !finite(point.y); }) ||
        !finite(middle.x) || !finite(middle.y)) throw new Error("INVALID_CONNECTOR_POINTS: " + connector.id);
    if (sourcePort) sourcePort.point = toConnectorPoint(doc, connector, sourcePort.point);
    if (targetPort) targetPort.point = toConnectorPoint(doc, connector, targetPort.point);
    if (sourcePort) sourcePort.coordinate_space = "connector-mm";
    if (targetPort) targetPort.coordinate_space = "connector-mm";
    return { kind: rel.kind, direction: direction, source: rel.source, target: rel.target,
      sourceNodeId: sourceNode.id, targetNodeId: targetNode.id,
      start: toConnectorPoint(doc, connector, start), end: toConnectorPoint(doc, connector, end),
      middle: toConnectorPoint(doc, connector, middle),
      points: points.map(function (point) { return toConnectorPoint(doc, connector, point); }),
      source_port: sourcePort, target_port: targetPort,
      path_type: pathType, route_resolved: routeResolved,
      obstacle_node_ids: obstacles.map(function (obstacle) { return obstacle.id; }),
      sourceBox: toConnectorBox(doc, connector, a), targetBox: toConnectorBox(doc, connector, b),
      arrow: { start: direction === "reverse" || direction === "both",
        end: direction === "forward" || direction === "both" } };
  }

  function freshLayoutAudit(doc) {
    var canvas = obj(doc) && obj(doc.canvas) ? doc.canvas : {};
    return {
      schema_version: "1.0", status: "no_automatic_risk_detected", risk_count: 0,
      visual_acceptance: "not_assessed", human_reviewed: false,
      canvas: { width_mm: finite(canvas.width_mm) ? canvas.width_mm : null,
        height_mm: finite(canvas.height_mm) ? canvas.height_mm : null },
      limits: { max_nodes: MAX_NODES, max_relations: MAX_RELATIONS, max_label_length: MAX_LABEL_LENGTH },
      diagrams: [], warnings: []
    };
  }
  function addLayoutWarning(audit, entry) {
    if (audit.warnings.length >= MAX_AUDIT_WARNINGS) {
      if (!audit.warnings.some(function (w) { return w.code === "LAYOUT_AUDIT_TRUNCATED"; })) {
        audit.warnings.push(warning("LAYOUT_AUDIT_TRUNCATED", "版面风险数量超过有界审计上限；未显示全部风险，不判定版面通过"));
      }
      return;
    }
    entry.scope = "layout";
    entry.severity = "warning";
    entry.canvas = clone(audit.canvas);
    audit.warnings.push(entry);
  }
  function labelSizeWarning(audit, node, metrics, code, message) {
    addLayoutWarning(audit, {
      code: code, node_id: node.id, element_id: node.id,
      expected_width_mm: metrics.expected_width_mm, expected_height_mm: metrics.expected_height_mm,
      actual_width_mm: metrics.body_width_mm, actual_height_mm: metrics.body_height_mm,
      message: "node_id=" + node.id + "；" + message + "；预计宽/高=" +
        round(metrics.expected_width_mm) + "/" + round(metrics.expected_height_mm) + " mm，canvas=" +
        audit.canvas.width_mm + "x" + audit.canvas.height_mm + " mm；不判定人工视觉验收通过"
    });
  }
  function boxesOverlap(a, b) {
    return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > LAYOUT_EPS_MM &&
      Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > LAYOUT_EPS_MM;
  }
  function overlapArea(a, b) {
    var x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    var right = Math.min(a.x + a.w, b.x + b.w), bottom = Math.min(a.y + a.h, b.y + b.h);
    return { x: round(x), y: round(y), w: round(right - x), h: round(bottom - y),
      area_mm2: round((right - x) * (bottom - y)) };
  }
  function auditChartDiagramCollisions(audit, doc, diagramId, entries) {
    var elements = doc.elements, candidates = elements.filter(function (el) {
      return el && (el.type === "chart" || el.type === "panel") && el.visible !== false;
    });
    var slots = [];
    try { slots = chartSlots(doc, diagramId); } catch (ignore) { slots = []; }
    var seen = Object.create(null);
    entries.forEach(function (entry) {
      candidates.forEach(function (candidate) {
        if (parentChain(doc, entry.node).some(function (parent) { return parent.id === candidate.id; })) return;
        var declaredSlot = candidate.type === "chart" && candidate.diagram_slot_id === entry.node.diagramNodeId &&
          candidate.parent_id === entry.node.id && (candidate.diagram_id || candidate.diagramId) === diagramId &&
          elements.some(function (slot) { return slot && slot.diagram_part === "chart_slot" &&
            slot.parent_id === entry.node.id && slot.intentional_overlap && slot.intentional_overlap.declared === true; });
        if (declaredSlot || !boxesOverlap(candidateBox(doc, candidate), entry.box)) return;
        var owner = candidate, chain = parentChain(doc, candidate);
        for (var c = 0; c < chain.length; c++) {
          if (chain[c].type === "panel" && boxesOverlap(candidateBox(doc, chain[c]), entry.box)) {
            owner = chain[c]; break;
          }
        }
        var key = owner.id + "\u0000" + entry.node.id;
        if (seen[key]) return;
        seen[key] = true;
        var ownerBox = candidateBox(doc, owner), area = overlapArea(ownerBox, entry.box);
        var warningId = "layout-collision-" + hash({ code: "DIAGRAM_CONTENT_OCCLUSION",
          element_id: owner.id, diagram_id: diagramId, node_id: entry.node.diagramNodeId }).slice(0, 16);
        var improvement;
        if (slots.length === 1) {
          improvement = { action: "rebind_to_explicit_chart_slot", tool: "figure_create_chart",
            scene_id: slots[0].scene_id, node_id: slots[0].node_id,
            remove_unbound_element_id: owner.id,
            path: "先撤销/删除本次未绑定 chart/panel，再以同一 data/template 调用 figure_create_chart，并显式传 scene_id、node_id；不要再次保留满画面板" };
        } else {
          improvement = { action: slots.length ? "choose_explicit_chart_slot" : "move_or_resize_unbound_element",
            tool: slots.length ? "figure_create_chart" : "figure_apply_edits", target_element_id: owner.id,
            available_slots: slots.slice(0, 16).map(function (slot) { return { scene_id: slot.scene_id, node_id: slot.node_id }; }),
            path: slots.length ? "多个 slot 必须分别明确 scene_id/node_id；先移除旧未绑定 chart/panel" : "移动或缩小该 chart/panel，或在合同中显式声明 kind/shape=chart 的数据 slot" };
        }
        addLayoutWarning(audit, { id: warningId, code: "DIAGRAM_CONTENT_OCCLUSION",
          diagram_id: diagramId, node_id: entry.node.diagramNodeId, element_id: owner.id,
          other_element_id: candidate.id === owner.id ? null : candidate.id,
          collision_role: "chart_or_panel_over_node_shape", collision_area: area,
          actual_bbox_chart: [round(ownerBox.x), round(ownerBox.y), round(ownerBox.w), round(ownerBox.h)],
          actual_bbox_node: [round(entry.box.x), round(entry.box.y), round(entry.box.w), round(entry.box.h)],
          improvement: improvement,
          message: "element_id=" + owner.id + " 覆盖 diagram_id=" + diagramId + " 的 node_id=" +
            entry.node.diagramNodeId + "；collision=" + [area.x, area.y, area.w, area.h].join(",") +
            " mm，area=" + area.area_mm2 + " mm²；需按 improvement 明确绑定或移动，不代表人工视觉验收" });
      });
    });
  }
  function candidateBox(doc, el) {
    try { return worldNodeBox(doc, el); }
    catch (error) { return { x: 0, y: 0, w: 0, h: 0 }; }
  }
  function segmentThroughBox(a, b, box) {
    var minX = box.x + LAYOUT_EPS_MM, maxX = box.x + box.w - LAYOUT_EPS_MM;
    var minY = box.y + LAYOUT_EPS_MM, maxY = box.y + box.h - LAYOUT_EPS_MM;
    if (minX >= maxX || minY >= maxY) return false;
    var dx = b.x - a.x, dy = b.y - a.y, lo = 0, hi = 1;
    var tests = [[-dx, a.x - minX], [dx, maxX - a.x], [-dy, a.y - minY], [dy, maxY - a.y]];
    for (var i = 0; i < tests.length; i++) {
      var p = tests[i][0], q = tests[i][1];
      if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue; }
      var t = q / p;
      if (p < 0) { if (t > hi) return false; lo = Math.max(lo, t); }
      else { if (t < lo) return false; hi = Math.min(hi, t); }
    }
    return hi - lo > 1e-9;
  }
  function connectorSegments(geometry) {
    if (geometry.path_type !== "quadratic" && (geometry.path_type || !(geometry.middle && geometry.points.length === 3))) return geometry.points;
    if (geometry.points.length < 3) return geometry.points;
    var points = [geometry.start], count = 16;
    for (var i = 1; i <= count; i++) {
      var t = i / count, u = 1 - t;
      points.push({ x: u*u*geometry.start.x + 2*u*t*geometry.middle.x + t*t*geometry.end.x,
        y: u*u*geometry.start.y + 2*u*t*geometry.middle.y + t*t*geometry.end.y });
    }
    return points;
  }
  function connectorWorldSegments(doc, connector, geometry) {
    var chain = parentChain(doc, connector);
    return connectorSegments(geometry).map(function (point) {
      chain.forEach(function (parent) {
        var box = rawNodeBox(doc, parent);
        point = rotatedPoint(point, box, box.rotation);
      });
      return point;
    });
  }
  function auditLayout(doc) {
    var audit = freshLayoutAudit(doc);
    if (!obj(doc) || !Array.isArray(doc.elements) || !audit.canvas.width_mm || !audit.canvas.height_mm) {
      addLayoutWarning(audit, warning("INVALID_DOCUMENT_GEOMETRY", "缺少有效 elements 或 canvas 尺寸，无法判定图内布局"));
      audit.status = "needs_layout_review";
      return audit;
    }
    var elements = doc.elements;
    if (elements.length > MAX_AUDIT_ELEMENTS) {
      addLayoutWarning(audit, warning("LAYOUT_AUDIT_LIMIT", "文档元素超过 " + MAX_AUDIT_ELEMENTS + "，仅审计前 " + MAX_AUDIT_ELEMENTS + " 个，不判定图内其余元素"));
      elements = elements.slice(0, MAX_AUDIT_ELEMENTS);
    }
    var diagramGroups = Object.create(null), order = [];
    elements.forEach(function (el) {
      if (!el || typeof el.id !== "string" || el.visible === false) return;
      var did = el.diagramId !== undefined ? el.diagramId : el.diagram_id;
      if (typeof did !== "string" || !did || el.type !== "group" || typeof el.diagramNodeId !== "string") return;
      if (!diagramGroups[did]) { diagramGroups[did] = []; order.push(did); }
      diagramGroups[did].push(el);
    });
    order.sort();
    order.forEach(function (diagramId) {
      var before = audit.warnings.length, allNodes = diagramGroups[diagramId];
      if (allNodes.length > MAX_NODES) {
        addLayoutWarning(audit, warning("NODE_LIMIT_EXCEEDED", "diagram_id=" + diagramId + " 含 " + allNodes.length +
          " 个节点，超过 " + MAX_NODES + "；仅审计前 " + MAX_NODES + " 个节点"));
      }
      var nodes = allNodes.slice(0, MAX_NODES), entries = [], byId = Object.create(null);
      var labels = elements.filter(function (el) {
        return el && el.type === "text" && el.diagram_part === "node_text" &&
          (el.diagramId !== undefined ? el.diagramId : el.diagram_id) === diagramId;
      });
      var labelsByNode = Object.create(null);
      labels.forEach(function (label) {
        if (typeof label.diagramNodeId === "string" && !labelsByNode[label.diagramNodeId]) labelsByNode[label.diagramNodeId] = label;
      });
      nodes.forEach(function (node) {
        var t = node.transform;
        if (!obj(t) || !finite(t.x) || !finite(t.y) || !finite(t.w) || !finite(t.h) || t.w <= 0 || t.h <= 0) {
          addLayoutWarning(audit, { code: "INVALID_NODE_GEOMETRY", node_id: node.diagramNodeId, element_id: node.id,
            message: "node_id=" + node.diagramNodeId + " 的 transform 无效，不能按有效图内节点验收" });
          return;
        }
        var box;
        try { box = worldNodeBox(doc, node); }
        catch (error) {
          addLayoutWarning(audit, { code: "INVALID_NODE_GEOMETRY", node_id: node.diagramNodeId, element_id: node.id,
            message: "node_id=" + node.diagramNodeId + " 的父级几何无效：" + error.message });
          return;
        }
        var entry = { node: node, box: box };
        entries.push(entry); byId[node.id] = entry;
        if (box.x < -LAYOUT_EPS_MM || box.y < -LAYOUT_EPS_MM ||
            box.x + box.w > audit.canvas.width_mm + LAYOUT_EPS_MM ||
            box.y + box.h > audit.canvas.height_mm + LAYOUT_EPS_MM) {
          addLayoutWarning(audit, { code: "NODE_OUTSIDE_CANVAS", node_id: node.diagramNodeId, element_id: node.id,
            actual_x_mm: round(box.x), actual_y_mm: round(box.y), actual_width_mm: round(box.w), actual_height_mm: round(box.h),
            message: "node_id=" + node.diagramNodeId + " 超出 canvas=" + audit.canvas.width_mm + "x" + audit.canvas.height_mm +
              " mm；实际 bbox=" + [round(box.x), round(box.y), round(box.w), round(box.h)].join(",") + " mm" });
        }
        var ownerPanel = parentChain(doc, node).filter(function (parent) { return parent.type === "panel"; })[0];
        if (ownerPanel) {
          var panelBox = worldNodeBox(doc, ownerPanel);
          var panelLayout = obj(ownerPanel.panelLayout) ? ownerPanel.panelLayout : {};
          var padding = finite(panelLayout.padding_mm) && panelLayout.padding_mm >= 0 ? panelLayout.padding_mm : 0;
          var contentBox = { x: panelBox.x + padding, y: panelBox.y + padding,
            w: Math.max(0, panelBox.w - 2 * padding), h: Math.max(0, panelBox.h - 2 * padding) };
          if (box.x < contentBox.x - LAYOUT_EPS_MM || box.y < contentBox.y - LAYOUT_EPS_MM ||
              box.x + box.w > contentBox.x + contentBox.w + LAYOUT_EPS_MM ||
              box.y + box.h > contentBox.y + contentBox.h + LAYOUT_EPS_MM) {
            addLayoutWarning(audit, { code: "NODE_OUTSIDE_PANEL", node_id: node.diagramNodeId,
              element_id: node.id, panel_id: ownerPanel.id,
              actual_x_mm: round(box.x), actual_y_mm: round(box.y), actual_width_mm: round(box.w), actual_height_mm: round(box.h),
              message: "node_id=" + node.diagramNodeId + " 超出 panel_id=" + ownerPanel.id + " 的内容区；canvas=" +
                audit.canvas.width_mm + "x" + audit.canvas.height_mm + " mm" });
          }
        }
        var label = labelsByNode[node.diagramNodeId];
        if (!label || typeof label.text !== "string") return;
        var original = typeof label.contract_label === "string" ? label.contract_label : label.text;
        var originalLength = Array.from(original).length;
        var fontPt = label.style && finite(Number(label.style.fontSizePt)) && Number(label.style.fontSizePt) > 0 ?
          Number(label.style.fontSizePt) : 7;
        var lineHeight = label.style && finite(Number(label.style.lineHeight)) && Number(label.style.lineHeight) > 0 ?
          Number(label.style.lineHeight) : 1.2;
        var textBox;
        try { textBox = worldNodeBox(doc, label); }
        catch (error) {
          addLayoutWarning(audit, { code: "INVALID_NODE_GEOMETRY", node_id: node.diagramNodeId, element_id: label.id,
            message: "node_id=" + node.diagramNodeId + " 的 label 父级几何无效：" + error.message });
          return;
        }
        var actualLines = label.text.split(/\r\n|\n|\r/);
        var width = Math.max.apply(Math, actualLines.map(function (line) { return measureLine(line, fontPt); }).concat([0]));
        var metrics = { expected_width_mm: width + 2 * LABEL_PAD_X_MM,
          expected_height_mm: actualLines.length * fontPt * PT_TO_MM * lineHeight + 2 * LABEL_PAD_Y_MM,
          body_width_mm: textBox.w, body_height_mm: textBox.h };
        if (originalLength > MAX_LABEL_LENGTH) {
          labelSizeWarning(audit, { id: node.diagramNodeId }, metrics, "LABEL_LIMIT_EXCEEDED",
            "原 label 为 " + originalLength + " 个 Unicode 字符，超过有界上限 " + MAX_LABEL_LENGTH);
          return;
        }
        if (metrics.expected_width_mm > textBox.w + LAYOUT_EPS_MM ||
            metrics.expected_height_mm > textBox.h + LAYOUT_EPS_MM) {
          labelSizeWarning(audit, { id: node.diagramNodeId }, metrics, "LABEL_TRUNCATION_RISK",
            "长 label 可能截断或溢出（字号保持 " + fontPt + " pt）");
        }
      });
      entries.forEach(function (entry) {
        entry.includes = [];
        if (entry.node.parent_id && byId[entry.node.parent_id]) {
          byId[entry.node.parent_id].includes.push(entry.node.parent_id + "\u0000" + entry.node.id);
        }
      });
      var connectors = elements.filter(function (el) {
        return el && el.type === "connector" &&
          (el.diagramId !== undefined ? el.diagramId : el.diagram_id) === diagramId && el.visible !== false;
      });
      if (connectors.length > MAX_RELATIONS) {
        addLayoutWarning(audit, warning("RELATION_LIMIT_EXCEEDED", "diagram_id=" + diagramId + " 连接关系超过 " +
          MAX_RELATIONS + "，仅审计前 " + MAX_RELATIONS + " 条"));
      }
      connectors.slice(0, MAX_RELATIONS).forEach(function (connector) {
        if (connector.relation && connector.relation.kind === "include") {
          var included = connector.relation.source + "\u0000" + connector.relation.target;
          if (byId[connector.relation.source]) byId[connector.relation.source].includes.push(included);
        }
      });
      for (var i = 0; i < entries.length; i++) {
        for (var j = i + 1; j < entries.length; j++) {
          var a = entries[i], b = entries[j];
          var pair = a.node.diagramNodeId + "\u0000" + b.node.diagramNodeId;
          var reversePair = b.node.diagramNodeId + "\u0000" + a.node.diagramNodeId;
          if (a.includes.indexOf(pair) >= 0 || b.includes.indexOf(reversePair) >= 0) continue;
          if (boxesOverlap(a.box, b.box)) {
            addLayoutWarning(audit, { code: "NODE_OVERLAP", node_id: a.node.diagramNodeId,
              other_node_id: b.node.diagramNodeId, element_id: a.node.id, other_element_id: b.node.id,
              actual_bbox_a: [round(a.box.x), round(a.box.y), round(a.box.w), round(a.box.h)],
              actual_bbox_b: [round(b.box.x), round(b.box.y), round(b.box.w), round(b.box.h)],
              message: "node_id=" + a.node.diagramNodeId + " 与 node_id=" + b.node.diagramNodeId + " 存在节点 shape 重叠风险" });
          }
        }
      }
      connectors.slice(0, MAX_RELATIONS).forEach(function (connector) {
        var geometry;
        try { geometry = connectorGeometry(doc, connector); }
        catch (error) {
          addLayoutWarning(audit, { code: "DANGLING_RELATION", connector_id: connector.id,
            source: obj(connector.relation) ? connector.relation.source : null,
            target: obj(connector.relation) ? connector.relation.target : null,
            message: "connector_id=" + connector.id + " 引用或几何无效（" + error.message + "）；该关系不作为有效答案关系" });
          return;
        }
        if (geometry.kind === "include") return;
        var points = connectorWorldSegments(doc, connector, geometry);
        entries.forEach(function (entry) {
          var semanticId = entry.node.diagramNodeId;
          if (entry.node.id === geometry.sourceNodeId || entry.node.id === geometry.targetNodeId ||
              semanticId === geometry.source || semanticId === geometry.target ||
              geometry.obstacle_node_ids.indexOf(entry.node.id) < 0) return;
          for (var p = 0; p + 1 < points.length; p++) {
            if (segmentThroughBox(points[p], points[p + 1], entry.box)) {
              addLayoutWarning(audit, { code: "CONNECTOR_THROUGH_NODE", connector_id: connector.id,
                source: geometry.source, target: geometry.target, node_id: semanticId, element_id: entry.node.id,
                message: "connector_id=" + connector.id + "（" + geometry.source + "→" + geometry.target +
                  "）可能穿过无关节点 node_id=" + semanticId + "；合法 source/target 端点未计为穿越" });
              break;
            }
          }
        });
      });
      auditChartDiagramCollisions(audit, doc, diagramId, entries);
      var diagramWarnings = audit.warnings.slice(before);
      audit.diagrams.push({ diagram_id: diagramId, node_count: allNodes.length,
        relation_count: connectors.length, risk_count: diagramWarnings.length, warnings: diagramWarnings });
    });
    audit.risk_count = audit.warnings.length;
    audit.status = audit.warnings.length ? "needs_layout_review" : "no_automatic_risk_detected";
    return audit;
  }

  global.FigDiagram = {
    SCHEMA_VERSION: VERSION, ROLES: ROLES.slice(), SHAPES: SHAPES.slice(), NODE_KINDS: KINDS.slice(),
    RELATION_KINDS: RELATIONS.slice(), DIRECTIONS: DIRECTIONS.slice(), TEMPLATES: TEMPLATES.slice(),
    CONNECTOR_CONTRACT: clone(CONNECTOR_CONTRACT), build: build, supportsTemplate: supportsTemplate,
    templateCapability: templateCapability, previewSVG: previewSVG, example: example, validate: validateSpec, validateSpec: validateSpec,
    stableStringify: stable, sha256: sha256, hash: hash, sameContract: same,
    normalize: function (input) { return normalize(input).spec; }, ownedIds: ownedIds,
    connectorGeometry: connectorGeometry, auditLayout: auditLayout, chartSlots: chartSlots,
    measureLabel: function (value, fontPt) { return measureLine(String(value), fontPt === undefined ? 7 : fontPt); },
    wrapLabel: function (value, widthMm, fontPt) { return wrapLabel(String(value), widthMm, fontPt === undefined ? 7 : fontPt); },
    LAYOUT_LIMITS: Object.freeze({ max_nodes: MAX_NODES, max_relations: MAX_RELATIONS, max_label_length: MAX_LABEL_LENGTH })
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
