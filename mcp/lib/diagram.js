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
  // labelBoxFor 上下内缩合计占用的节点高度；fittedLabel 必须把它计入
  // requiredHeight，否则自动适应高度的节点会被审计误报 LABEL_TRUNCATION_RISK。
  var LABEL_BOX_V_MM = 1.0;
  var PT_TO_MM = 25.4 / 72;
  var LAYOUT_EPS_MM = 0.001;
  var ID_RE = /^[A-Za-z0-9_.:-]+$/;
  var ROLES = ["question", "method", "evidence", "conclusion"];
  var SHAPES = ["box", "ellipse", "cell", "molecule", "material", "process", "outcome",
    "sample", "device", "group", "container", "diamond", "chart", "terminal", "chevron"];
  var KINDS = ["entity", "decision"].concat(SHAPES);
  var RELATIONS = ["activate", "inhibit", "include", "associate", "sequence"];
  var DIRECTIONS = ["forward", "reverse", "both", "none"];
  var TEMPLATES = ["flow", "decision", "loop", "experiment", "timeline", "compare", "graphical_abstract",
    "prisma", "consort", "stages", "chevron", "roadmap", "merge", "numbered", "feedback",
    "swimlane", "hierarchy", "model"];
  var TEMPLATE_IDS = {
    flow: "flow", decision: "decision", loop: "loop", experiment: "experiment",
    timeline: "timeline", compare: "compare", graphical_abstract: "graphical_abstract",
    "graphical-abstract": "graphical_abstract", graphicalAbstract: "graphical_abstract",
    entity_relationship: "flow", "entity-relationship": "flow",
    relationship_schematic: "flow", schematic: "flow",
    "tpl-diagram-flow": "flow", "tpl-diagram-arch": "flow",
    "tpl-diagram-pipeline": "flow", "tpl-diagram-decision": "decision",
    "tpl-diagram-loop": "loop", "tpl-diagram-experiment": "experiment",
    "tpl-diagram-swimlane": "swimlane", "tpl-diagram-timeline": "timeline",
    "tpl-diagram-hierarchy": "hierarchy", "tpl-diagram-model": "model",
    "tpl-diagram-compare": "compare",
    "tpl-diagram-prisma": "prisma", "tpl-diagram-consort": "consort",
    "tpl-diagram-stages": "stages", "tpl-diagram-chevron": "chevron",
    "tpl-diagram-roadmap": "roadmap", "tpl-diagram-merge": "merge",
    "tpl-diagram-numbered": "numbered", "tpl-diagram-feedback": "feedback",
    "tpl-graphical-abstract": "graphical_abstract",
    // 规范名恒等映射：normalize 必须幂等（面板/ops 会二次 normalize）
    swimlane: "swimlane", hierarchy: "hierarchy", model: "model",
    prisma: "prisma", consort: "consort", stages: "stages", chevron: "chevron",
    roadmap: "roadmap", merge: "merge", numbered: "numbered", feedback: "feedback"
  };
  // R9：布局模式全集（layered/grid/manual 为旧网格行为，保持不变）
  var LAYOUT_MODES = ["layered", "grid", "manual", "flow", "snake", "stages",
    "lanes", "tree", "cycle", "timeline", "prisma", "roadmap"];
  // R9：模板默认布局/主题（theme 对应 presets/diagram_themes.json 的 id）
  var TEMPLATE_DEFAULTS = {
    flow: { layout: "flow", theme: "soft-card" },
    decision: { layout: "flow", theme: "outline-academic" },
    loop: { layout: "cycle", theme: "soft-card" },
    experiment: { layout: "stages", theme: "numbered-card" },
    timeline: { layout: "timeline", theme: "outline-academic" },
    compare: { layout: "snake", theme: "mono-grey" },
    graphical_abstract: { layout: "flow", theme: "soft-card" },
    prisma: { layout: "prisma", theme: "side-bar" },
    consort: { layout: "flow", theme: "soft-card" },
    stages: { layout: "stages", theme: "side-bar" },
    chevron: { layout: "snake", theme: "solid-block" },
    roadmap: { layout: "roadmap", theme: "numbered-card" },
    merge: { layout: "flow", theme: "soft-card" },
    numbered: { layout: "snake", theme: "numbered-card" },
    feedback: { layout: "flow", theme: "outline-academic" },
    swimlane: { layout: "lanes", theme: "mono-grey" },
    hierarchy: { layout: "tree", theme: "outline-academic" },
    model: { layout: "flow", theme: "solid-block" }
  };
  var ROOT_KEYS = ["id", "schema_version", "schemaVersion", "template", "template_id", "templateId",
    "nodes", "relations", "sources", "canvas", "layout", "uncertainties", "human_review",
    "groups", "theme"];
  var NODE_KEYS = ["id", "label", "role", "shape", "kind", "x", "y", "w", "h",
    "evidence", "source_refs", "sourceRefs", "color", "fill", "stroke", "fontSizePt", "data_slot",
    "group", "step", "subtitle"];
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
    // R9：根级 groups（泳道/阶段容器）与 theme（presets/diagram_themes.json）
    spec.groups = [];
    if (input.groups !== undefined) {
      if (!Array.isArray(input.groups)) throw new Error("INVALID_SCHEMA: groups 必须是数组");
      var groupSeen = Object.create(null);
      input.groups.forEach(function (raw, i) {
        keys(raw, ["id", "label", "color", "position"], "groups[" + i + "]");
        var gid = id(raw.id, "groups[" + i + "].id");
        if (groupSeen[gid]) throw new Error("DUPLICATE_ID: group " + gid);
        groupSeen[gid] = true;
        var g = { id: gid, label: text(raw.label, "groups[" + i + "].label", false) };
        if (raw.color !== undefined) g.color = text(raw.color, "groups[" + i + "].color", false);
        if (raw.position !== undefined) {
          g.position = text(raw.position, "groups[" + i + "].position", false);
          if (g.position !== "left" && g.position !== "right") {
            throw new Error("INVALID_SCHEMA: groups[" + i + "].position 只允许 left/right");
          }
        }
        spec.groups.push(g);
      });
    }
    spec.theme = null;
    if (input.theme !== undefined && input.theme !== null) {
      spec.theme = text(input.theme, "theme", false);
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
      // R9：group 引用根级 groups；step 副标题徽标文字
      if (raw.group !== undefined) n.group = id(raw.group, "nodes[" + i + "].group");
      if (raw.step !== undefined) n.step = text(raw.step, "nodes[" + i + "].step", true);
      if (raw.subtitle !== undefined) n.subtitle = text(raw.subtitle, "nodes[" + i + "].subtitle", true);
      var ev = raw.evidence !== undefined ? raw.evidence : alias(raw, "source_refs", "sourceRefs", "nodes[" + i + "]");
      n.evidence = normalizeEvidence(ev, sourceMap, warnings, "nodes[" + i + "].evidence");
      nodeMap[nid] = n; spec.nodes.push(n);
    });
    if (spec.groups.length) {
      var groupIds = Object.create(null);
      spec.groups.forEach(function (g) { groupIds[g.id] = true; });
      spec.nodes.forEach(function (n) {
        if (n.group !== undefined && !groupIds[n.group]) {
          throw new Error("INVALID_GROUP_REF: nodes[" + n.id + "].group 引用了未声明的组 " + n.group);
        }
      });
    } else {
      spec.nodes.forEach(function (n) { if (n.group !== undefined) delete n.group; });
    }
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
    // R9：模板默认布局模式/主题（用户显式 layout.mode/theme 优先）。
    // 仅当调用方显式给了 template 时才套用模板默认——未给 template 的
    // 裸 spec 沿用旧行为 mode="layered"（template 缺省回退 "flow" 只是
    // 模板名占位，不代表用户选择了 flow 布局）。
    var tplDefaults = (rawTpl != null && rawTpl !== "") ? (TEMPLATE_DEFAULTS[template] || {}) : {};
    spec.layout = { mode: tplDefaults.layout || "layered", direction: "LR",
      columns: Math.min(hasChartSlot ? 2 : 4, spec.nodes.length),
      gap_x: 5, gap_y: 8, margin: 7, auto_layout: false, palette_id: null };
    if (input.layout !== undefined) {
      keys(input.layout, ["mode", "direction", "columns", "gap_x", "gap_y", "gapX", "gapY", "margin", "page_fill", "auto_layout", "autoLayout", "palette_id", "paletteId"], "layout");
      if (input.layout.page_fill !== undefined) {
        if ([0.8, 1].indexOf(input.layout.page_fill) < 0) throw new Error("INVALID_LAYOUT: page_fill 只允许 0.8 或 1");
        spec.layout.page_fill = input.layout.page_fill;
      }
      var paletteId = alias(input.layout, "palette_id", "paletteId", "layout");
      if (paletteId !== undefined && paletteId !== null) spec.layout.palette_id = text(paletteId, "layout.palette_id", false);
      if (input.layout.mode !== undefined) {
        if (LAYOUT_MODES.indexOf(input.layout.mode) < 0) throw new Error("INVALID_LAYOUT: layout.mode 只允许 " + LAYOUT_MODES.join("/"));
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
    if (!spec.theme && tplDefaults.theme) spec.theme = tplDefaults.theme;
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
    return kinsokuLines(lines);
  }
  // R9：中文换行禁则——行首不得出现闭合标点（全角 ，。、；：！？）」』】》
  // 与半角 ? ! ) ] } , . : ; > ”’）；行尾不得留开括号
  // （「『【《 与半角 ( [ { < “‘。越界字符移到相邻行。
  var KINSOKU_CLOSE = "，。、；：！？）」』】》?!)]}.,:;>”’";
  var KINSOKU_OPEN = "（「『【《([{<“‘";
  function kinsokuLines(lines) {
    if (!lines || lines.length < 2) {
      // 单行两头都可能违规：闭合标点在行首无法上移（无上一行），开括号
      // 在行尾同理；仅当有相邻行可移动时才处理（上面已处理多行）。
      return lines;
    }
    for (var i = 1; i < lines.length; i++) {
      while (lines[i] && KINSOKU_CLOSE.indexOf(lines[i].charAt(0)) >= 0) {
        var ch = lines[i].charAt(0);
        lines[i] = lines[i].slice(1);
        lines[i - 1] += ch;
      }
    }
    for (var j = lines.length - 2; j >= 0; j--) {
      while (lines[j] && KINSOKU_OPEN.indexOf(lines[j].charAt(lines[j].length - 1)) >= 0) {
        var ch2 = lines[j].charAt(lines[j].length - 1);
        lines[j] = lines[j].slice(0, -1);
        lines[j + 1] = ch2 + lines[j + 1];
      }
    }
    // 开括号上移后可能再次把闭合标点顶到行首，再扫一遍
    for (var k = 1; k < lines.length; k++) {
      while (lines[k] && KINSOKU_CLOSE.indexOf(lines[k].charAt(0)) >= 0) {
        var ch3 = lines[k].charAt(0);
        lines[k] = lines[k].slice(1);
        lines[k - 1] += ch3;
      }
    }
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
  var SUBTITLE_H_MM = 4.6;
  // reserveMm：左侧徽标/色条占用的宽度（布局与渲染两侧必须一致地把文字区右移）；
  // extraMM：节点内第二行副标题占用的高度（roadmap 等把副标题移到右栏时传 0）。
  function fittedLabel(node, maxWidthMm, reserveMm, extraMM) {
    var base = size(node), fontPt = node.fontSizePt === undefined ? 7 : node.fontSizePt;
    var reserve = finite(reserveMm) && reserveMm > 0 ? reserveMm : 0;
    var extra = finite(extraMM) && extraMM > 0 ? extraMM : 0;
    var oneLine = Math.max.apply(Math, String(node.label).split(/\r\n|\n|\r/).map(function (line) {
      return measureLine(line, fontPt);
    }).concat([0])) + 2 * LABEL_PAD_X_MM + reserve;
    var limit = Math.max(1, maxWidthMm);
    var w = node.w === undefined ? Math.round(Math.max(Math.min(base.w, limit), Math.min(limit, oneLine)) * 1000000) / 1000000 : node.w;
    var contentWidth = Math.max(0.35, w - 2 * LABEL_PAD_X_MM - reserve);
    var wrapped = wrapLabel(node.label, contentWidth, fontPt);
    var lineCount = wrapped.split("\n").length;
    var requiredHeight = lineCount * fontPt * PT_TO_MM * 1.2 + 2 * LABEL_PAD_Y_MM + extra + LABEL_BOX_V_MM;
    var h = node.h === undefined ? Math.max(base.h + extra, requiredHeight) : node.h;
    return { w: round(w), h: round(h) };
  }
  // ---- R9 布局模式 -------------------------------------------------------
  // 通用：每个节点分到一个槽位 (x,y,slotW,slotH)，标签在槽内居中、
  // fittedLabel 负责换行与尺寸；节点显式 x/y 时保留手动位置。
  // ---- R9 内容驱动布局 ----------------------------------------------------
  // 节点尺寸由 fittedLabel 实测（含徽标/色条占位与副标题高度），槽位紧贴
  // 内容；画布 = 内容 bbox + layout.margin（buildElements 统一收口，
  // 手动位置一并计入）。MAX_NODE_W_MM 限制单节点标签宽度上限。
  var MAX_NODE_W_MM = 34;
  var LAYOUT_PAD_MM = 1;
  function labelReserve(spec, n) {
    var theme = diagramTheme(spec), tn = theme.node || {}, r = 0;
    if (n.step) r += 9;                    // 左侧编号徽标区
    if (tn.sideBar) r += 3.4;              // 左侧主题色条区
    return r;
  }
  function subtitleInside(spec) { return spec.layout.mode !== "roadmap"; }
  function fitNode(spec, n, maxW) {
    var extra = (n.subtitle && subtitleInside(spec)) ? SUBTITLE_H_MM : 0;
    return fittedLabel(n, maxW === undefined ? MAX_NODE_W_MM : maxW,
      labelReserve(spec, n), extra);
  }
  function emitPlaced(spec, slots, extras) {
    var placed = Object.create(null), rowHeights = [], columns = 0;
    spec.nodes.forEach(function (n) {
      var s = slots[n.id] || { x: spec.layout.margin, y: spec.layout.margin,
        slotW: 24, slotH: 14 };
      var extra = (n.subtitle && subtitleInside(spec)) ? SUBTITLE_H_MM : 0;
      var fitted = fittedLabel(n, Math.max(6, s.slotW - 1), labelReserve(spec, n), extra);
      var w = n.w !== undefined ? n.w : fitted.w;
      var h = n.h !== undefined ? n.h : fitted.h;
      w = Math.min(w, Math.max(6, s.slotW + 8)); h = Math.max(4, h);
      placed[n.id] = {
        x: round(n.x !== undefined ? n.x : s.x + Math.max(0, (s.slotW - w) / 2)),
        y: round(n.y !== undefined ? n.y : s.y + Math.max(0, (s.slotH - h) / 2)),
        w: round(w), h: round(h), rotation: 0 };
    });
    var ex = extras || {};
    return { placed: placed, row_heights_mm: rowHeights, columns: columns,
      containers: ex.containers || [], decor: ex.decor || [],
      subtitles: ex.subtitles || null, texts: ex.texts || null,
      ellipse: ex.ellipse || null };
  }
  // 内容 bbox（节点 + 容器 + 装饰）→ 画布 = bbox + 边距；bbox.min 平移到 margin。
  function finishLayout(spec, out) {
    var m = spec.layout.margin;
    var box = null;
    function eat(b) {
      if (!b || !finite(b.x) || !finite(b.y)) return;
      var x2 = b.x + (b.w || 0), y2 = b.y + (b.h || 0);
      box = box ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
        x2: Math.max(box.x2, x2), y2: Math.max(box.y2, y2) } :
        { x: b.x, y: b.y, x2: x2, y2: y2 };
    }
    Object.keys(out.placed).forEach(function (id) { eat(out.placed[id]); });
    (out.containers || []).forEach(eat); (out.decor || []).forEach(eat);
    // roadmap 等把文字移出节点的布局：字幕/阶段标签也计入 bbox
    if (out.subtitles) Object.keys(out.subtitles).forEach(function (id) { eat(out.subtitles[id]); });
    (out.texts || []).forEach(function (tx) { eat({ x: tx.x, y: tx.y, w: tx.w, h: tx.h });
      if (tx.barX !== undefined) eat({ x: tx.barX, y: tx.barY, w: tx.barW, h: tx.barH }); });
    if (!box) {
      out.canvas = clone(spec.canvas);
      return out;
    }
    // 自动布局可自由平移：内容 bbox 左/上缘对齐 margin，左右边距相等
    var dx = m - box.x, dy = m - box.y;
    if (dx || dy) {
      Object.keys(out.placed).forEach(function (id) {
        out.placed[id].x = round(out.placed[id].x + dx);
        out.placed[id].y = round(out.placed[id].y + dy);
      });
      (out.containers || []).forEach(function (c) { c.x = round(c.x + dx); c.y = round(c.y + dy); });
      (out.decor || []).forEach(function (d) { d.x = round(d.x + dx); d.y = round(d.y + dy); });
      if (out.subtitles) Object.keys(out.subtitles).forEach(function (id) {
        out.subtitles[id].x = round(out.subtitles[id].x + dx);
        out.subtitles[id].y = round(out.subtitles[id].y + dy);
      });
      (out.texts || []).forEach(function (tx) {
        tx.x = round(tx.x + dx); tx.y = round(tx.y + dy);
        if (tx.barX !== undefined) { tx.barX = round(tx.barX + dx); tx.barY = round(tx.barY + dy); }
      });
      box.x += dx; box.y += dy; box.x2 += dx; box.y2 += dy;
    }
    out.canvas = { width_mm: Math.max(30, round(box.x2 - box.x + 2 * m)),
      height_mm: Math.max(20, round(box.y2 - box.y + 2 * m)),
      dpi: spec.canvas.dpi, background: spec.canvas.background };
    return out;
  }
  // direction=TB：把已落位的节点/容器/装饰做 x↔y 转置（节点宽高不变，
  // 仅位置转置——在 emitPlaced 之后调用，避免槽位宽高互换导致节点被压扁）。
  function transposeBoxes(list) {
    return (list || []).map(function (b) {
      return { x: b.y, y: b.x, w: b.h, h: b.w,
        kind: b.kind, label: b.label, color: b.color, fill: b.fill,
        barW: b.barW, pathData: b.pathData, group: b.group };
    });
  }
  function transposeDetail(out) {
    var placed = {};
    Object.keys(out.placed).forEach(function (id) {
      var p = out.placed[id];
      placed[id] = { x: round(p.y), y: round(p.x), w: p.w, h: p.h, rotation: 0 };
    });
    out.placed = placed;
    out.containers = transposeBoxes(out.containers);
    out.decor = transposeBoxes(out.decor);
    return out;
  }
  // 逻辑边：include 不参与布局；reverse 视为 target→source；both 双向都计。
  function layoutEdges(spec) {
    var out = [], inn = [];
    spec.nodes.forEach(function (n) { out[n.id] = []; inn[n.id] = []; });
    spec.relations.forEach(function (r) {
      if (r.kind === "include") return;
      if (r.direction === "none") return;
      var a = r.direction === "reverse" ? r.target : r.source;
      var b = r.direction === "reverse" ? r.source : r.target;
      out[a].push(b); inn[b].push(a);
      if (r.direction === "both") { out[b].push(a); inn[a].push(b); }
    });
    return { out: out, inn: inn };
  }
  // flow：最长路径分层（Bellman-Ford 式有界松弛，环安全）；层内按前驱
  // 重心排序 2 轮；层居中。回边（target 能沿出边回到 source）与自环
  // 不参与分层——否则环会让所有层序整体错位；回边仍由连线正交外绕。
  function flowLayers(spec, E) {
    var layer = {}, ids = spec.nodes.map(function (n) { return n.id; }), i, j;
    ids.forEach(function (id) { layer[id] = 0; });
    // DFS 回边识别：指向递归栈祖先（gray）的边是回边，不参与分层；
    // 树边/前向边/横叉边保留——剩余图是 DAG，最长路径松弛收敛。
    // （不能按 SCC 整块剔除：反馈边会把下游整条链圈进同一分量，
    //   主链结构会丢失。）
    var color = {}, outF = {}, innF = {}, seenEdge = Object.create(null),
        backKeys = Object.create(null);
    ids.forEach(function (id) { color[id] = 0; outF[id] = []; innF[id] = []; });
    function dfs(u) {
      color[u] = 1;
      (E.out[u] || []).forEach(function (v) {
        var key = u + ">" + v;
        if (seenEdge[key]) return;
        seenEdge[key] = true;
        if (color[v] === 1) { backKeys[key] = true; return; } // 回边/自环
        if (color[v] === 0) dfs(v);
        outF[u].push(v); innF[v].push(u);
      });
      color[u] = 2;
    }
    ids.forEach(function (id) { if (color[id] === 0) dfs(id); });
    for (i = 0; i < ids.length; i++) {
      var changed = false;
      ids.forEach(function (u) {
        outF[u].forEach(function (v) {
          if (layer[v] < layer[u] + 1) { layer[v] = layer[u] + 1; changed = true; }
        });
      });
      if (!changed) break;
    }
    // 层内排序：初始按节点序，2 轮按前驱重心
    var byLayer = {};
    ids.forEach(function (id) {
      var l = layer[id]; (byLayer[l] = byLayer[l] || []).push(id);
    });
    var layers = Object.keys(byLayer).map(Number).sort(function (a, b) { return a - b; });
    for (var round = 0; round < 2; round++) {
      layers.forEach(function (l) {
        var arr = byLayer[l];
        arr.sort(function (a, b) {
          var ba = bary(innF[a], byLayer, layer), bb = bary(innF[b], byLayer, layer);
          return ba - bb || ids.indexOf(a) - ids.indexOf(b);
        });
      });
    }
    return { layer: layer, byLayer: byLayer, layers: layers, order: ids,
      backEdges: spec.relations.filter(function (r) {
        if (r.kind === "include" || r.direction === "none") return false;
        var a = r.direction === "reverse" ? r.target : r.source;
        var b = r.direction === "reverse" ? r.source : r.target;
        return a === b || backKeys[a + ">" + b] === true;
      }).map(function (r) { return r.id; }) };
  }
  function bary(preds, byLayer, layer) {
    if (!preds || !preds.length) return 0;
    var sum = 0, cnt = 0;
    preds.forEach(function (p) {
      var arr = byLayer[layer[p]] || [];
      var idx = arr.indexOf(p);
      if (idx >= 0) { sum += idx; cnt++; }
    });
    return cnt ? sum / cnt : 0;
  }
  function dagDepths(spec, E, reverse) {
    // 自上而下 depth（最长路径）；reverse=true 时沿反向边
    var depth = {}, ids = spec.nodes.map(function (n) { return n.id; });
    ids.forEach(function (id) { depth[id] = 0; });
    for (var i = 0; i < ids.length; i++) {
      var changed = false;
      ids.forEach(function (u) {
        var outs = reverse ? E.inn[u] : E.out[u];
        outs.forEach(function (v) {
          var d = depth[u] + 1;
          if (depth[v] < d) { depth[v] = d; changed = true; }
        });
      });
      if (!changed) break;
    }
    return depth;
  }
  // 按 group 分组（无 group 节点各自成段），groups 声明顺序优先。
  function groupBuckets(spec) {
    var groupsOrder = (spec.groups || []).map(function (g) { return g.id; });
    var byGroup = {}, gorder = [];
    spec.nodes.forEach(function (n) {
      var g = n.group === undefined ? "__solo_" + n.id : n.group;
      if (!byGroup[g]) { byGroup[g] = []; gorder.push(g); }
      byGroup[g].push(n.id);
    });
    gorder.sort(function (a, b) {
      var ia = groupsOrder.indexOf(a), ib = groupsOrder.indexOf(b);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return 0;
    });
    return { byGroup: byGroup, gorder: gorder,
      groupOf: function (gid) {
        return (spec.groups || []).filter(function (gg) { return gg.id === gid; })[0] || null;
      } };
  }
  function slotFor(f, x, y) {
    return { x: round(x - LAYOUT_PAD_MM), y: round(y - LAYOUT_PAD_MM),
      slotW: round(f.w + 2 * LAYOUT_PAD_MM), slotH: round(f.h + 2 * LAYOUT_PAD_MM) };
  }
  function layoutSpecial(spec, mode) {
    var lay = spec.layout, m = lay.margin;
    var E = layoutEdges(spec);
    var slots = {}, extras = { containers: [], decor: [], subtitles: null, texts: null, ellipse: null };
    var TB = lay.direction === "TB";
    var needTranspose = false;
    var nById = {};
    spec.nodes.forEach(function (n) { nById[n.id] = n; });
    var fits = {};
    function fit(nid) {
      if (!fits[nid]) fits[nid] = fitNode(spec, nById[nid]);
      return fits[nid];
    }
    var i;

    if (mode === "flow") {
      // DAG 分层：层=列（LR）/行（TB 转置）；层内纵向堆叠、整体垂直居中。
      var fl = flowLayers(spec, E);
      var colW = {}, layerH = {}, maxH = 0, xs = {}, xcur = m;
      fl.layers.forEach(function (l) {
        var arr = fl.byLayer[l] || [], wmax = 0, hsum = -(arr.length - 1) * lay.gap_y;
        arr.forEach(function (nid) { var f = fit(nid); wmax = Math.max(wmax, f.w); hsum += f.h; });
        colW[l] = wmax; layerH[l] = hsum; maxH = Math.max(maxH, hsum);
      });
      fl.layers.forEach(function (l) { xs[l] = xcur; xcur += colW[l] + lay.gap_x; });
      fl.layers.forEach(function (l) {
        var arr = fl.byLayer[l] || [], ycur = m + Math.max(0, (maxH - layerH[l]) / 2);
        arr.forEach(function (nid) {
          var f = fit(nid);
          slots[nid] = slotFor(f, xs[l] + (colW[l] - f.w) / 2, ycur);
          ycur += f.h + lay.gap_y;
        });
      });
      needTranspose = TB;
    } else if (mode === "snake") {
      // 蛇形网格：列/行尺寸取所在行列最大节点，奇数行反向。
      var cols = Math.max(1, Math.min(lay.columns || 4, spec.nodes.length));
      var colW2 = [], rowH2 = [];
      spec.nodes.forEach(function (n, idx) {
        var r = Math.floor(idx / cols), c = idx % cols;
        if (r % 2 === 1) c = cols - 1 - c;
        var f = fit(n.id);
        colW2[c] = Math.max(colW2[c] || 0, f.w);
        rowH2[r] = Math.max(rowH2[r] || 0, f.h);
      });
      var xs2 = [], xcur2 = m;
      for (i = 0; i < cols; i++) { xs2[i] = xcur2; xcur2 += (colW2[i] || 0) + lay.gap_x; }
      var ys2 = [], ycur2 = m;
      for (i = 0; i < rowH2.length; i++) { ys2[i] = ycur2; ycur2 += (rowH2[i] || 0) + lay.gap_y; }
      spec.nodes.forEach(function (n, idx) {
        var r = Math.floor(idx / cols), c = idx % cols;
        if (r % 2 === 1) c = cols - 1 - c;
        var f = fit(n.id);
        slots[n.id] = slotFor(f, xs2[c] + ((colW2[c] || 0) - f.w) / 2,
          ys2[r] + ((rowH2[r] || 0) - f.h) / 2);
      });
    } else if (mode === "stages") {
      // 阶段列容器：每组一列，容器高=组内容高（统一取最高列），节点纵向居中。
      var gb = groupBuckets(spec);
      var stColW = {}, stMembersH = {}, stMaxH = 0, stX = {}, sx = m;
      gb.gorder.forEach(function (g) {
        var members = gb.byGroup[g], wmax = 0, hsum = -(members.length - 1) * lay.gap_y;
        members.forEach(function (nid) { var f = fit(nid); wmax = Math.max(wmax, f.w); hsum += f.h; });
        stColW[g] = wmax + 6; stMembersH[g] = hsum;
        stMaxH = Math.max(stMaxH, 6 + hsum + 4);
        stX[g] = sx; sx += stColW[g] + lay.gap_x * 1.6;
      });
      gb.gorder.forEach(function (g, gi) {
        var members = gb.byGroup[g], gl = gb.groupOf(g);
        var gx = stX[g], gy = m;
        extras.containers.push({ kind: "stage", x: gx, y: gy, w: stColW[g],
          h: stMaxH, label: gl ? gl.label : g, color: gl ? gl.color : null, group: g });
        var y0 = gy + 6 + Math.max(0, (stMaxH - 6 - stMembersH[g]) / 2);
        members.forEach(function (nid, mi) {
          var f = fit(nid), prevH = 0;
          for (var k = 0; k < mi; k++) prevH += fit(members[k]).h + lay.gap_y;
          slots[nid] = slotFor(f, gx + 3 + (stColW[g] - 6 - f.w) / 2, y0 + prevH);
        });
      });
      needTranspose = TB;
    } else if (mode === "lanes") {
      // 横向泳道：整条浅色底带 + 左侧标题栏；x 按全局 DAG 层对齐各泳道。
      var gb2 = groupBuckets(spec);
      var fl2 = flowLayers(spec, E);
      var laneColW = {}, lx = {};
      var barW = 10, xcur3 = m + barW + lay.gap_x;
      fl2.layers.forEach(function (l) {
        var wmax = 0;
        (fl2.byLayer[l] || []).forEach(function (nid) { wmax = Math.max(wmax, fit(nid).w); });
        laneColW[l] = wmax; lx[l] = xcur3; xcur3 += wmax + lay.gap_x;
      });
      var laneContentW = xcur3 - m - barW - lay.gap_x + 2;
      var bandY = m;
      gb2.gorder.forEach(function (g) {
        var members = gb2.byGroup[g], gl = gb2.groupOf(g);
        var label = gl ? gl.label : g;
        var labelNeed = measureLine(label, 6.5) + 4;
        var hmax = 0;
        members.forEach(function (nid) { hmax = Math.max(hmax, fit(nid).h); });
        var bandH = Math.max(hmax + 5, Math.min(labelNeed, 30));
        extras.containers.push({ kind: "lane", x: m, y: bandY, w: laneContentW,
          h: bandH, label: label, color: gl ? gl.color : null, barW: barW, group: g });
        members.forEach(function (nid) {
          var l = fl2.layer[nid] || 0, f = fit(nid);
          slots[nid] = slotFor(f, lx[l] + (laneColW[l] - f.w) / 2,
            bandY + (bandH - f.h) / 2);
        });
        bandY += bandH + lay.gap_y;
      });
    } else if (mode === "tree") {
      // 整齐树：深度=最长路径；叶槽均分（槽宽=最大节点宽），行高按内容。
      var depth = dagDepths(spec, E, false);
      var maxD = 0, maxNW = 0;
      spec.nodes.forEach(function (n) {
        if (depth[n.id] > maxD) maxD = depth[n.id];
        maxNW = Math.max(maxNW, fit(n.id).w);
      });
      var rowH3 = [], rowTop3 = [], yt = m;
      for (i = 0; i <= maxD; i++) {
        var rh = 0;
        spec.nodes.forEach(function (n) { if (depth[n.id] === i) rh = Math.max(rh, fit(n.id).h); });
        rowH3[i] = rh + lay.gap_y; rowTop3[i] = yt; yt += rowH3[i];
      }
      var leafW = {};
      function computeLeaf(nid, seen) {
        if (leafW[nid] !== undefined) return leafW[nid];
        if (seen[nid]) return leafW[nid] = 1;
        seen[nid] = true;
        var kids = E.out[nid].filter(function (v) { return depth[v] === depth[nid] + 1; });
        if (!kids.length) return leafW[nid] = 1;
        return leafW[nid] = kids.reduce(function (s, k) { return s + computeLeaf(k, seen); }, 0);
      }
      spec.nodes.forEach(function (n) { computeLeaf(n.id, {}); });
      var pitchX = maxNW + lay.gap_x, cursor = { v: 0 };
      function placeTree(nid) {
        var w = leafW[nid] || 1;
        var l0 = cursor.v; cursor.v += w;
        var x0 = m + l0 * pitchX;
        var slotW = w * maxNW + (w - 1) * lay.gap_x;
        var d = depth[nid];
        var f = fit(nid);
        slots[nid] = { x: round(x0 + (slotW - f.w) / 2 - LAYOUT_PAD_MM),
          y: round(rowTop3[d] + Math.max(0, (rowH3[d] - lay.gap_y - f.h) / 2) - LAYOUT_PAD_MM),
          slotW: round(slotW + 2 * LAYOUT_PAD_MM), slotH: round(rowH3[d] - lay.gap_y + 2 * LAYOUT_PAD_MM) };
        E.out[nid].forEach(function (k) { if (depth[k] === depth[nid] + 1) placeTree(k); });
      }
      spec.nodes.forEach(function (n) { if (depth[n.id] === 0) placeTree(n.id); });
      // 孤立/环节点兜底：追加到本层行尾
      spec.nodes.forEach(function (n) {
        if (!slots[n.id]) {
          var d2 = depth[n.id], f2 = fit(n.id);
          slots[n.id] = { x: round(m + cursor.v * pitchX - LAYOUT_PAD_MM),
            y: round(rowTop3[d2] + Math.max(0, (rowH3[d2] - lay.gap_y - f2.h) / 2) - LAYOUT_PAD_MM),
            slotW: round(f2.w + 2 * LAYOUT_PAD_MM), slotH: round(rowH3[d2] - lay.gap_y + 2 * LAYOUT_PAD_MM) };
          cursor.v++;
        }
      });
    } else if (mode === "cycle") {
      // 环形：贪心最大邻接排序（出边优先）减少弦跨越；椭圆尺寸按内容。
      var outAdj = {}, inAdj = {}, undAdj = {};
      spec.nodes.forEach(function (n) { outAdj[n.id] = []; inAdj[n.id] = []; undAdj[n.id] = []; });
      spec.relations.forEach(function (r) {
        if (r.kind === "include" || r.direction === "none") return;
        var a = r.direction === "reverse" ? r.target : r.source;
        var b = r.direction === "reverse" ? r.source : r.target;
        if (a === b) return;
        outAdj[a].push(b); inAdj[b].push(a);
        if (undAdj[a].indexOf(b) < 0) undAdj[a].push(b);
        if (undAdj[b].indexOf(a) < 0) undAdj[b].push(a);
      });
      function greedyOrder(start) {
        var order = [start], seen = {}, cur = start;
        seen[start] = true;
        while (order.length < spec.nodes.length) {
          var nxt = null, cands = outAdj[cur].concat(inAdj[cur]), j;
          for (j = 0; j < cands.length && nxt === null; j++) {
            if (!seen[cands[j]]) nxt = cands[j];
          }
          if (nxt === null) {
            for (j = 0; j < cands.length && nxt === null; j++) {
              if (!seen[cands[j]]) nxt = cands[j];
            }
          }
          if (nxt === null) {
            for (j = 0; j < spec.nodes.length; j++) {
              var cand = spec.nodes[j].id;
              if (!seen[cand] && undAdj[cur].indexOf(cand) >= 0) { nxt = cand; break; }
            }
          }
          if (nxt === null) {
            for (j = 0; j < spec.nodes.length; j++) {
              if (!seen[spec.nodes[j].id]) { nxt = spec.nodes[j].id; break; }
            }
          }
          seen[nxt] = true; order.push(nxt); cur = nxt;
        }
        return order;
      }
      function orderScore(order) {
        var s = 0;
        for (var k = 0; k < order.length; k++) {
          if (undAdj[order[k]].indexOf(order[(k + 1) % order.length]) >= 0) s++;
        }
        return s;
      }
      var bestOrder = null, bestScore = -1;
      spec.nodes.forEach(function (n) {
        var ord = greedyOrder(n.id), sc = orderScore(ord);
        if (sc > bestScore) { bestScore = sc; bestOrder = ord; }
      });
      var nN = spec.nodes.length || 1, avgW = 0, maxNW2 = 0, maxNH = 0;
      spec.nodes.forEach(function (n) { var f = fit(n.id); avgW += f.w; maxNW2 = Math.max(maxNW2, f.w); maxNH = Math.max(maxNH, f.h); });
      avgW = nN ? avgW / nN : 20;
      var need = nN * (avgW + lay.gap_x) / Math.PI * 1.12;
      var ry = Math.max(10, need * 0.4), rx = Math.max(maxNW2 / 2 + 5, need - ry);
      var cx = m + rx + maxNW2 / 2, cy = m + ry + maxNH / 2;
      bestOrder.forEach(function (nid, idx) {
        var ang = -Math.PI / 2 + idx * 2 * Math.PI / nN;
        var px = cx + rx * Math.cos(ang), py = cy + ry * Math.sin(ang);
        var f = fit(nid);
        slots[nid] = slotFor(f, px, py);
      });
      extras.ellipse = { cx: cx, cy: cy, rx: rx, ry: ry };
    } else if (mode === "timeline") {
      // 水平时间轴：里程碑上下交替，短竖线连轴上圆点；轴带箭头；
      // 节点间不画连线（关系元素由 build 标记 visible:false）。
      var dotR = 1.6, tickGap = 4, nT = spec.nodes.length;
      var dotX = [], xcur4 = m, aboveH = 0, belowH = 0;
      spec.nodes.forEach(function (n, idx) {
        var f = fit(n.id), above = idx % 2 === 0;
        dotX[idx] = xcur4 + f.w / 2;
        xcur4 += f.w + lay.gap_x * 1.6;
        if (above) aboveH = Math.max(aboveH, f.h); else belowH = Math.max(belowH, f.h);
      });
      var axisY = m + aboveH + tickGap + dotR;
      var axisX0 = dotX[0] - 5, axisX1 = dotX[nT - 1] + 9;
      spec.nodes.forEach(function (n, idx) {
        var f = fit(n.id), above = idx % 2 === 0, dx = dotX[idx];
        var ny = above ? axisY - tickGap - dotR - f.h : axisY + tickGap + dotR;
        slots[n.id] = slotFor(f, dx, ny + f.h / 2);
        // 节点→圆点的短竖线
        var ty = above ? ny + f.h : ny;
        var th = (above ? axisY - dotR : axisY + dotR) - ty;
        if (th > 0.2) extras.decor.push({ kind: "decor_line", x: dx - 0.15,
          y: Math.min(ty, ty + th), w: 0.3, h: th, fill: "#9CA3AF" });
        extras.decor.push({ kind: "decor_dot", x: dx - dotR, y: axisY - dotR,
          w: dotR * 2, h: dotR * 2, fill: "#374151" });
      });
      extras.decor.push({ kind: "decor_line", x: axisX0, y: axisY - 0.18,
        w: axisX1 - axisX0, h: 0.36, fill: "#9CA3AF" });
      extras.decor.push({ kind: "decor_path", x: axisX1, y: axisY - 2,
        w: 3.2, h: 4, fill: "#374151", stroke: "#374151",
        pathData: "M 0 0 L 3.2 2 L 0 4 Z" });
    } else if (mode === "prisma") {
      // PRISMA：左侧竖排阶段色条 + 单列主流程（自上而下）+
      // 右侧排除列（group.position==='right' 的组）。
      var groups3 = spec.groups || [];
      var gpos = {};
      groups3.forEach(function (g) { gpos[g.id] = g.position || "left"; });
      var mainIds = [], sideIds = [];
      spec.nodes.forEach(function (n) {
        (gpos[n.group] === "right" ? sideIds : mainIds).push(n.id);
      });
      var pdepth = dagDepths(spec, E, false), declIdx = {};
      spec.nodes.forEach(function (n, i2) { declIdx[n.id] = i2; });
      mainIds.sort(function (a, b) {
        return (pdepth[a] - pdepth[b]) || (declIdx[a] - declIdx[b]);
      });
      // 侧节点锚定：取其入边主流程节点的行区间中心
      var mainRow = {}; mainIds.forEach(function (nid, i3) { mainRow[nid] = i3; });
      var sideAnchor = {};
      sideIds.forEach(function (nid) {
        var rows = [];
        spec.relations.forEach(function (r) {
          var src = r.direction === "reverse" ? r.target : r.source;
          var dst = r.direction === "reverse" ? r.source : r.target;
          if (dst !== nid) return;
          if (mainRow[src] !== undefined) rows.push(mainRow[src]);
        });
        sideAnchor[nid] = rows.length ? { lo: Math.min.apply(null, rows),
          hi: Math.max.apply(null, rows) } : { lo: 0, hi: mainIds.length - 1 };
      });
      var barW2 = 7, mainColW = 0;
      mainIds.forEach(function (nid) { mainColW = Math.max(mainColW, fit(nid).w); });
      var sideColW = 0;
      sideIds.forEach(function (nid) { sideColW = Math.max(sideColW, fit(nid).w); });
      var rowH4 = [], yt4 = m;
      mainIds.forEach(function (nid, i4) {
        var h = fit(nid).h;
        sideIds.forEach(function (sid) {
          var a = sideAnchor[sid];
          if (i4 >= a.lo && i4 <= a.hi) h = Math.max(h, fit(sid).h / Math.max(1, a.hi - a.lo + 1));
        });
        rowH4[i4] = h + lay.gap_y; yt4 += rowH4[i4];
      });
      var rowTop4 = [], yt5 = m;
      rowH4.forEach(function (h) { rowTop4.push(yt5); yt5 += h; });
      var mainX = m + barW2 + lay.gap_x;
      var rightX = mainX + mainColW + lay.gap_x * 2;
      mainIds.forEach(function (nid, i6) {
        var f = fit(nid);
        slots[nid] = slotFor(f, mainX + (mainColW - f.w) / 2,
          rowTop4[i6] + (rowH4[i6] - lay.gap_y - f.h) / 2);
      });
      // 右列：按锚定行区间纵向居中，重叠时顺延
      var sidePlaced = [];
      sideIds.forEach(function (nid) {
        var a = sideAnchor[nid], f = fit(nid);
        var y1 = rowTop4[a.lo], y2 = rowTop4[a.hi] + rowH4[a.hi] - lay.gap_y;
        sidePlaced.push({ nid: nid, cy: (y1 + y2) / 2, f: f });
      });
      sidePlaced.sort(function (a, b) { return a.cy - b.cy; });
      var lastBottom = -1e9;
      sidePlaced.forEach(function (sp) {
        var y = Math.max(sp.cy - sp.f.h / 2, lastBottom + lay.gap_y);
        lastBottom = y + sp.f.h;
        slots[sp.nid] = slotFor(sp.f, rightX + (sideColW - sp.f.w) / 2, y + sp.f.h / 2);
      });
      // 右组容器（排除框）
      var rightGroups = {};
      sideIds.forEach(function (nid) {
        var g = nById[nid].group;
        if (g) (rightGroups[g] = rightGroups[g] || []).push(nid);
      });
      Object.keys(rightGroups).forEach(function (g) {
        var gl = groups3.filter(function (gg) { return gg.id === g; })[0];
        var ys = rightGroups[g].map(function (nid) { return slots[nid].y - LAYOUT_PAD_MM; });
        var hs = rightGroups[g].map(function (nid) { return fit(nid).h; });
        var y0 = Math.min.apply(null, ys) - 3, y1 = Math.max.apply(null, ys.map(function (v, k) { return v + hs[k]; })) + 3;
        extras.containers.push({ kind: "stage", x: rightX - 3, y: y0, w: sideColW + 6,
          h: y1 - y0, label: gl ? gl.label : g, color: gl ? gl.color : null, group: g });
      });
      // 左侧阶段竖条：覆盖本组成员行区间
      var leftGroups = {};
      mainIds.forEach(function (nid, i7) {
        var g = nById[nid].group;
        if (g && gpos[g] !== "right") (leftGroups[g] = leftGroups[g] || []).push(i7);
      });
      Object.keys(leftGroups).forEach(function (g) {
        var idxs = leftGroups[g], gl = groups3.filter(function (gg) { return gg.id === g; })[0];
        var y0 = rowTop4[idxs[0]], y1 = rowTop4[idxs[idxs.length - 1]] + rowH4[idxs[idxs.length - 1]] - lay.gap_y;
        extras.containers.push({ kind: "stagebar", x: m, y: y0 - 1, w: barW2,
          h: y1 - y0 + 2, label: gl ? gl.label : g, color: gl ? gl.color : null, group: g });
      });
    } else if (mode === "roadmap") {
      // 三栏：左=阶段标签（竖色条+文字）、中=主流程节点（纵向链）、
      // 右=细节说明文字（节点 subtitle 移出，与中栏同行，细线相连）。
      extras.subtitles = {};
      extras.texts = [];
      var leftW = 0, detailW = 0;
      spec.nodes.forEach(function (n) {
        if (n.group) {
          var gl = (spec.groups || []).filter(function (gg) { return gg.id === n.group; })[0];
          if (gl) leftW = Math.max(leftW, measureLine(gl.label, 6.5) + 6);
        }
        if (n.subtitle) detailW = Math.max(detailW, Math.min(46, measureLine(n.subtitle, 5.5) + 2));
      });
      leftW = leftW ? Math.min(22, Math.max(10, leftW)) : 0;
      detailW = detailW ? Math.min(46, Math.max(12, detailW)) : 0;
      var midX = m + leftW + (leftW ? lay.gap_x : 0);
      var maxNW3 = 0, rowH5 = [];
      spec.nodes.forEach(function (n) {
        var f = fit(n.id); maxNW3 = Math.max(maxNW3, f.w);
        rowH5.push(Math.max(f.h, 6) + lay.gap_y);
      });
      var rowTops5 = [], yt6 = m;
      rowH5.forEach(function (h) { rowTops5.push(yt6); yt6 += h; });
      var nodeRight = midX + maxNW3;
      var detailX = nodeRight + 3 + (detailW ? lay.gap_x : 0);
      spec.nodes.forEach(function (n, idx) {
        var f = fit(n.id), rowH = rowH5[idx] - lay.gap_y;
        var cy = rowTops5[idx] + rowH / 2;
        slots[n.id] = slotFor(f, midX + (maxNW3 - f.w) / 2, cy);
        // 左栏：竖色条 + 阶段名（相邻同组并入一块）
        if (n.group) {
          var gl = (spec.groups || []).filter(function (gg) { return gg.id === n.group; })[0];
          if (gl) {
            var mergeWithPrev = idx > 0 && nById[spec.nodes[idx - 1].id].group === n.group &&
              extras.texts[extras.texts.length - 1] &&
              extras.texts[extras.texts.length - 1].group === n.group;
            if (mergeWithPrev) {
              var prev = extras.texts[extras.texts.length - 1];
              prev.h = round(cy + rowH / 2 - prev.y);
              prev.barH = prev.h;
            } else {
              // 左栏 = 竖色条(2.2) + 间隙 + 文字；文字起点须在条右缘之后
              extras.texts.push({ kind: "group_label", parent: n.id, group: n.group,
                x: m + 3.6, y: round(cy - 3), w: Math.max(4, leftW - 4.8), h: 6,
                barX: m + 0.6, barW: 2.2, barY: round(rowTops5[idx] + 1),
                barH: round(rowH - 2), barColor: gl.color || "#6366F1",
                text: gl.label });
            }
          }
        }
        // 右栏：细节文字（subtitle）+ 细连接线
        if (n.subtitle && detailW) {
          extras.subtitles[n.id] = { x: detailX, y: round(cy - 2.4),
            w: detailW, h: 4.8 };
          var nx = slots[n.id].x - LAYOUT_PAD_MM + f.w;
          extras.decor.push({ kind: "decor_line", x: nx + 0.8, y: round(cy - 0.15),
            w: Math.max(0.5, detailX - nx - 1.6), h: 0.3, fill: "#CBD5E1" });
        }
      });
    }
    var out = emitPlaced(spec, slots, extras);
    if (needTranspose) transposeDetail(out);
    return finishLayout(spec, out);
  }
  function layoutDetail(spec) {
    if (["flow", "snake", "stages", "lanes", "tree", "cycle", "timeline", "prisma", "roadmap"].indexOf(spec.layout.mode) >= 0) {
      return layoutSpecial(spec, spec.layout.mode);
    }
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
    return { placed: placed, row_heights_mm: rowHeights.map(round), columns: columns,
      containers: [], decor: [] };
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
  // R9：主题。presets/diagram_themes.json 经 FigPresets.diagramTheme 提供；
  // 内核内置同名默认保证无 presets 环境也可渲染（两边保持一致）。
  var BUILTIN_THEMES = {
    "soft-card": {
      node: { fill: null, stroke: null, strokeWidthPt: 0, cornerRadiusMm: 2,
        fontFamily: "Arial, sans-serif", fontWeight: "normal", fillText: "#374151",
        subtitleColor: "#4B5563", groupFill: "declared" },
      groupColors: ["#FDE68A", "#BBF7D0", "#BFDBFE", "#FBCFE8", "#DDD6FE", "#FED7AA"],
      connector: { stroke: "#6B7280", strokeWidthPt: 0.6 },
      container: { fill: "#F9FAFB", stroke: "#E5E7EB", strokeWidthPt: 0.5,
        dash: null, titleFill: "#374151", titleBar: false },
      badge: { fill: "#6B7280", text: "#FFFFFF" },
      arrow: { size: "small" }
    },
    "outline-academic": {
      node: { fill: "#FFFFFF", stroke: "#1F2937", strokeWidthPt: 0.5,
        cornerRadiusMm: 0.6, fontFamily: "Times New Roman, SimSun, serif",
        fontWeight: "normal", fillText: "#111827", subtitleColor: "#4B5563",
        groupFill: "theme" },
      groupColors: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
      connector: { stroke: "#111827", strokeWidthPt: 0.6 },
      container: { fill: "#FFFFFF", stroke: "#9CA3AF", strokeWidthPt: 0.5,
        dash: "3 2", titleFill: "#111827", titleBar: true },
      badge: { fill: "#1F2937", text: "#FFFFFF" },
      arrow: { size: "small" }
    },
    "numbered-card": {
      node: { fill: "#FFFFFF", stroke: "#E5E7EB", strokeWidthPt: 0.4,
        cornerRadiusMm: 1.5, fontFamily: "Arial, sans-serif", fontWeight: "bold",
        fillText: "#111827", subtitleColor: "#6B7280", groupFill: "theme" },
      groupColors: ["#60A5FA", "#34D399", "#FBBF24", "#F472B6", "#A78BFA", "#FB923C"],
      connector: { stroke: "#9CA3AF", strokeWidthPt: 0.6 },
      container: { fill: "#F9FAFB", stroke: "#E5E7EB", strokeWidthPt: 0.5,
        dash: null, titleFill: "#374151", titleBar: false },
      badge: { fill: null, text: "#1F2937", ungroupedPalette: true },
      arrow: { size: "small" }
    },
    "side-bar": {
      node: { fill: "#FFFFFF", stroke: "#E5E7EB", strokeWidthPt: 0.5,
        cornerRadiusMm: 1.2, fontFamily: "Arial, sans-serif", fontWeight: "normal",
        fillText: "#111827", subtitleColor: "#6B7280", sideBar: true,
        groupFill: "theme" },
      groupColors: ["#6366F1", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"],
      connector: { stroke: "#6B7280", strokeWidthPt: 0.6 },
      container: { fill: "#FFFFFF", stroke: "#E5E7EB", strokeWidthPt: 0.5,
        dash: null, titleFill: "#111827", titleBar: false, sideBar: true },
      badge: { fill: "#6B7280", text: "#FFFFFF" },
      arrow: { size: "small" }
    },
    "solid-block": {
      node: { fill: null, stroke: null, strokeWidthPt: 0, cornerRadiusMm: 1,
        fontFamily: "Arial, sans-serif", fontWeight: "bold", fillText: "#FFFFFF",
        subtitleColor: "#FFFFFF", ungroupedPalette: true, groupFill: "palette" },
      groupColors: ["#2F5D8C", "#2E7D5B", "#B4572E", "#6B4FA0", "#8C3B5C", "#3D6E8F"],
      connector: { stroke: "#4B5563", strokeWidthPt: 0.8 },
      container: { fill: null, stroke: null, strokeWidthPt: 0, dash: null,
        titleFill: "#FFFFFF", titleBar: true },
      badge: { fill: "#FFFFFF", text: "#1F2937" },
      arrow: { size: "medium" }
    },
    "mono-grey": {
      node: { fill: "#F3F4F6", stroke: null, strokeWidthPt: 0, cornerRadiusMm: 1.5,
        fontFamily: "Arial, sans-serif", fontWeight: "bold", fillText: "#111827",
        subtitleColor: "#4B5563", groupFill: "palette" },
      groupColors: ["#E5E7EB", "#E5E7EB", "#E5E7EB", "#E5E7EB", "#E5E7EB", "#E5E7EB"],
      connector: { stroke: "#374151", strokeWidthPt: 0.7 },
      container: { fill: "#F9FAFB", stroke: null, strokeWidthPt: 0, dash: null,
        titleFill: "#374151", titleBar: false },
      badge: { fill: "#374151", text: "#FFFFFF" },
      arrow: { size: "small" }
    }
  };
  function diagramTheme(spec) {
    var id = spec && spec.theme ? spec.theme : "soft-card";
    if (global.FigPresets && typeof global.FigPresets.diagramTheme === "function") {
      var t = global.FigPresets.diagramTheme(id);
      if (t) return t;
    }
    return BUILTIN_THEMES[id] || BUILTIN_THEMES["soft-card"];
  }
  // ---- R9-A：文字/填充 WCAG 对比与组色解析 ----
  function hexRgb(hex) {
    var s = String(hex || "").trim();
    if (s.charAt(0) === "#") s = s.slice(1);
    if (s.length === 3) s = s.split("").map(function (c) { return c + c; }).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return [parseInt(s.substr(0, 2), 16), parseInt(s.substr(2, 2), 16),
      parseInt(s.substr(4, 2), 16)];
  }
  function relLum(hex) {
    var rgb = hexRgb(hex);
    if (!rgb) return null;
    var c = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrastRatio(a, b) {
    var l1 = relLum(a), l2 = relLum(b);
    if (l1 == null || l2 == null) return null;
    var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  // 文字色：优先主题色；对比度不足 4.5 时退回纯黑/纯白中对比更高者
  //（纯黑对中明度彩条也能 ≥4.5，#111827 在 L≈0.21 的彩条上只有 4.47）。
  function inkFor(bg, preferred) {
    var dark = "#000000", light = "#FFFFFF";
    if (preferred && (contrastRatio(preferred, bg) || 0) >= 4.5) return preferred;
    var cd = contrastRatio(dark, bg), cl = contrastRatio(light, bg);
    if (cd == null && cl == null) return preferred || dark;
    return (cd == null ? -1 : cd) >= (cl == null ? -1 : cl) ? dark : light;
  }
  function groupIndexOf(spec, groupId) {
    var order = (spec.groups || []).map(function (g) { return g.id; });
    var idx = order.indexOf(groupId);
    return idx < 0 ? 0 : idx;
  }
  function declaredGroupColor(spec, groupId) {
    var g = (spec.groups || []).filter(function (gg) { return gg.id === groupId; })[0];
    return g && g.color ? g.color : null;
  }
  // 组强调色（徽标/侧条/阶段条/标题条）：declared 主题尊重 schematic 声明的
  // 浅色组色；palette/theme 主题忽略声明色、改用主题调色板（饱和或灰阶），
  // 保证实色块白字、侧条可见、主题间区分度。
  function groupAccentColor(spec, theme, groupId) {
    if (groupId == null) return null;
    var idx = groupIndexOf(spec, groupId);
    var palette = Array.isArray(theme.groupColors) ? theme.groupColors : [];
    var pc = palette.length ? palette[idx % palette.length] : null;
    var dc = declaredGroupColor(spec, groupId);
    var gf = theme.node && theme.node.groupFill;
    if (!gf || gf === "declared") return dc || pc;
    return pc || dc;
  }
  // 分组节点填充：declared=声明色|调色板浅色；palette=主题调色板；
  // theme=主题 node.fill（白卡/灰底主题不吃组色）。
  function nodeGroupFill(spec, theme, node) {
    if (node.group == null) return null;
    var tn = theme.node || {};
    var gf = tn.groupFill || "declared";
    if (gf === "theme") return tn.fill || null;
    return groupAccentColor(spec, theme, node.group);
  }
  // 节点形状 → 原生元素：diamond/decision 画菱形 path，chevron 画人字
  // 形 path，terminal 画胶囊 rect（圆角=h/2），其余 rect/ellipse。
  function shapePlan(node) {
    var kind = node.kind || node.shape, shape = node.shape || "box";
    if (kind === "decision" || shape === "diamond") return { type: "path", path: "diamond" };
    if (shape === "chevron" || kind === "chevron") return { type: "path", path: "chevron" };
    if (shape === "terminal" || kind === "terminal") return { type: "rect", capsule: true };
    if (["ellipse", "cell", "molecule", "outcome"].indexOf(shape) >= 0) return { type: "ellipse" };
    return { type: "rect" };
  }
  function shapePathData(plan, w, h) {
    if (plan.path === "diamond") {
      return "M " + round(w / 2) + " 0 L " + round(w) + " " + round(h / 2) +
        " L " + round(w / 2) + " " + round(h) + " L 0 " + round(h / 2) + " Z";
    }
    if (plan.path === "chevron") {
      var notch = Math.min(w * 0.22, 5);
      return "M 0 0 L " + round(w - notch) + " 0 L " + round(w) + " " + round(h / 2) +
        " L " + round(w - notch) + " " + round(h) + " L 0 " + round(h) + " L " + round(notch) +
        " " + round(h / 2) + " Z";
    }
    return null;
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
    // 内容驱动模式：画布已按自动布局收紧；手动位置可能把节点移出，
    // 按最终 bbox（节点+容器+装饰）重新收口，保证一切元素在画布内。
    var docCanvas = calculated.canvas || spec.canvas;
    if (calculated.canvas) {
      var bb = null;
      function eatBox(b) {
        if (!b || !finite(b.x) || !finite(b.y)) return;
        var x2 = b.x + (b.w || 0), y2 = b.y + (b.h || 0);
        bb = bb ? { x: Math.min(bb.x, b.x), y: Math.min(bb.y, b.y),
          x2: Math.max(bb.x2, x2), y2: Math.max(bb.y2, y2) } :
          { x: b.x, y: b.y, x2: x2, y2: y2 };
      }
      Object.keys(placed).forEach(function (id) { eatBox(placed[id]); });
      (calculated.containers || []).forEach(eatBox);
      (calculated.decor || []).forEach(eatBox);
      if (calculated.subtitles) Object.keys(calculated.subtitles).forEach(function (id) { eatBox(calculated.subtitles[id]); });
      (calculated.texts || []).forEach(function (tx) {
        eatBox({ x: tx.x, y: tx.y, w: tx.w, h: tx.h });
        if (tx.barX !== undefined) eatBox({ x: tx.barX, y: tx.barY, w: tx.barW, h: tx.barH });
      });
      if (bb) {
        var lm = spec.layout.margin;
        // 仅当内容越过 margin（手动移出）才平移补齐；否则保留手动坐标，
        // 画布右/下缘 = 内容最大缘 + margin，左/上缘保留实际位置。
        var dx2 = lm - bb.x, dy2 = lm - bb.y;
        if (dx2 > 0.01 || dy2 > 0.01) {
          Object.keys(placed).forEach(function (id) {
            placed[id].x = round(placed[id].x + Math.max(0, dx2));
            placed[id].y = round(placed[id].y + Math.max(0, dy2));
          });
          (calculated.containers || []).forEach(function (c) { c.x = round(c.x + Math.max(0, dx2)); c.y = round(c.y + Math.max(0, dy2)); });
          (calculated.decor || []).forEach(function (d) { d.x = round(d.x + Math.max(0, dx2)); d.y = round(d.y + Math.max(0, dy2)); });
          if (calculated.subtitles) Object.keys(calculated.subtitles).forEach(function (id) {
            calculated.subtitles[id].x = round(calculated.subtitles[id].x + Math.max(0, dx2));
            calculated.subtitles[id].y = round(calculated.subtitles[id].y + Math.max(0, dy2));
          });
          (calculated.texts || []).forEach(function (tx) {
            tx.x = round(tx.x + Math.max(0, dx2)); tx.y = round(tx.y + Math.max(0, dy2));
            if (tx.barX !== undefined) { tx.barX = round(tx.barX + Math.max(0, dx2)); tx.barY = round(tx.barY + Math.max(0, dy2)); }
          });
          bb.x += Math.max(0, dx2); bb.y += Math.max(0, dy2);
          bb.x2 += Math.max(0, dx2); bb.y2 += Math.max(0, dy2);
        }
        docCanvas = { width_mm: Math.max(30, round(bb.x2 + lm)),
          height_mm: Math.max(20, round(bb.y2 + lm)),
          dpi: spec.canvas.dpi, background: spec.canvas.background };
      }
    }
    var z = startZ || 1, root = tag(base("diagram-" + spec.id + ":root", "group",
      { x: 0, y: 0, w: docCanvas.width_mm, h: docCanvas.height_mm }, z++), spec, null, "scene");
    root.children = [];
    var theme = diagramTheme(spec);
    // R9：stages/lanes/prisma 容器与 timeline 装饰画在节点之下（z 更小）
    (calculated.containers || []).forEach(function (ct, ci) {
      var cid = "diagram-" + spec.id + ":container:" + ci;
      var tc = theme.container || {};
      var cEl = tag(base(cid, "group",
        { x: ct.x, y: ct.y, w: ct.w, h: ct.h, rotation: 0 }, z++), spec, null, "stage_container");
      cEl.parent_id = root.id; cEl.children = [];
      // R9-A：容器强调色走主题解析（declared 主题用声明浅色；其余用主题
      // 调色板——实色块得饱和色、侧条/编号得彩色，保证色条与白字可读）。
      var cAccent = ct.group != null ?
        (groupAccentColor(spec, theme, ct.group) || ct.color || null) : (ct.color || null);
      var gfMode = theme.node && theme.node.groupFill;
      var bgTint = (!gfMode || gfMode === "declared") ? ct.color : null;
      if (ct.kind === "stagebar") {
        // prisma 左侧竖排阶段色条：纯色条 + 竖排字（墨色按条色自动对比）
        var sbar = tag(base(cid + ".bar", "rect",
          { x: ct.x, y: ct.y, w: ct.w, h: ct.h, rotation: 0 }, z++), spec, null, "lane_bar");
        sbar.parent_id = cid;
        var sbarFill = cAccent || "#6366F1";
        sbar.style = { fill: sbarFill, stroke: null, strokeWidthPt: 0,
          cornerRadiusMm: 0.8 };
        cEl.children.push(sbar.id); elements.push(sbar);
        var sbw = ct.w || 7;
        var slt = tag(base(cid + ".label", "text",
          { x: ct.x + sbw / 2 - (ct.h - 4) / 2, y: ct.y + ct.h / 2 - (sbw - 1.5) / 2,
            w: Math.max(4, ct.h - 4), h: Math.max(3, sbw - 1.5), rotation: -90 },
          z++), spec, null, "lane_label");
        slt.parent_id = cid; slt.text = ct.label || "";
        slt.style = { fill: inkFor(sbarFill, "#FFFFFF"), fontFamily: "Arial, sans-serif",
          fontSizePt: 6.5, textAlign: "center", verticalAlign: "middle", fontWeight: "bold" };
        cEl.children.push(slt.id); elements.push(slt);
        elements.push(cEl); root.children.push(cEl.id);
        return;
      }
      var fill = bgTint || tc.fill || "#F9FAFB";
      var bg = tag(base(cid + ".bg", "rect",
        { x: ct.x, y: ct.y, w: ct.w, h: ct.h, rotation: 0 }, z++), spec, null, "stage_bg");
      bg.parent_id = cid;
      bg.style = { fill: ct.kind === "lane" ? (tc.fill || "#F8FAFC") : fill,
        stroke: tc.stroke || "#E5E7EB",
        strokeWidthPt: tc.strokeWidthPt != null ? tc.strokeWidthPt : 0.5,
        cornerRadiusMm: ct.kind === "stage" ? 1.5 : 0,
        dash: tc.dash || undefined, opacity: tc.fill ? 1 : 0.55 };
      cEl.children.push(bg.id); elements.push(bg);
      if (ct.kind === "lane") {
        // 左侧色条（barW 宽）+ 竖排标题，居中于条内
        var barW = ct.barW || 9;
        var bar = tag(base(cid + ".bar", "rect",
          { x: ct.x, y: ct.y, w: barW, h: ct.h, rotation: 0 }, z++), spec, null, "lane_bar");
        bar.parent_id = cid;
        var barFill = cAccent || "#6366F1";
        bar.style = { fill: barFill, stroke: null, strokeWidthPt: 0,
          cornerRadiusMm: 0 };
        cEl.children.push(bar.id); elements.push(bar);
        var lt = tag(base(cid + ".label", "text",
          { x: ct.x + barW / 2 - (ct.h - 5) / 2, y: ct.y + ct.h / 2 - (barW - 2) / 2,
            w: Math.max(4, ct.h - 5), h: Math.max(3, barW - 2), rotation: -90 },
          z++), spec, null, "lane_label");
        lt.parent_id = cid; lt.text = ct.label || "";
        lt.style = { fill: inkFor(barFill, "#FFFFFF"), fontFamily: "Arial, sans-serif",
          fontSizePt: 6.5, textAlign: "center", verticalAlign: "middle", fontWeight: "bold" };
        cEl.children.push(lt.id); elements.push(lt);
      } else {
        var titleBarFill = cAccent || "#E5E7EB";
        var st = tag(base(cid + ".label", "text",
          { x: ct.x + 2, y: ct.y + 1, w: ct.w - 4, h: 5, rotation: 0 }, z++),
          spec, null, "stage_label");
        st.parent_id = cid; st.text = ct.label || "";
        // 标题文字落在标题条（titleBar）或容器底（淡色）上，墨色按实际底色取对比
        st.style = { fill: inkFor(tc.titleBar ? titleBarFill : fill,
            tc.titleFill || "#374151"), fontFamily: "Arial, sans-serif",
          fontSizePt: 7.5, textAlign: "left", verticalAlign: "middle",
          fontWeight: "bold" };
        cEl.children.push(st.id); elements.push(st);
        if (tc.titleBar) {
          var tb = tag(base(cid + ".titlebar", "rect",
            { x: ct.x, y: ct.y, w: ct.w, h: 5.5, rotation: 0 }, z++), spec, null, "stage_titlebar");
          tb.parent_id = cid;
          tb.style = { fill: titleBarFill, stroke: null, strokeWidthPt: 0,
            cornerRadiusMm: 0 };
          cEl.children.push(tb.id); elements.push(tb);
        }
      }
      elements.push(cEl); root.children.push(cEl.id);
    });
    (calculated.decor || []).forEach(function (dc, di) {
      var did = "diagram-" + spec.id + ":decor:" + di;
      var dType = dc.kind === "decor_dot" ? "ellipse" : dc.kind === "decor_path" ? "path" : "rect";
      var dEl = tag(base(did, dType,
        { x: dc.x || 0, y: dc.y || 0, w: dc.w || 0, h: dc.h || 0, rotation: 0 }, z++), spec, null, "decor");
      if (dType === "path") dEl.pathData = dc.pathData;
      dEl.parent_id = root.id;
      dEl.style = { fill: dc.fill || "#9CA3AF", stroke: dc.stroke || null,
        strokeWidthPt: dc.stroke ? 0.4 : 0 };
      elements.push(dEl); root.children.push(dEl.id);
    });
    // R9-B：徽标放节点左侧居中，文字区整体右移；色条主题再让位。
    // 布局侧 labelReserve(step=9 / sideBar=3.4) 必须 ≥ 此处实际占位。
    function badgeMetrics(t) {
      var br = Math.min(3.2, t.h * 0.28);
      return { br: br, zone: 2 * br + 2.0, cx: t.x + 1.0 + br, cy: t.y + t.h / 2 };
    }
    function nodeLeftReserve(n, t) {
      var r = 0;
      if (n.step) r += badgeMetrics(t).zone;
      if (theme.node && theme.node.sideBar) r += 2.8;
      return r;
    }
    function labelBoxFor(n, t) {
      if (n.data_slot) return slotLabelTransform(t);
      var subOverride = calculated.subtitles && calculated.subtitles[n.id];
      var subH = (n.subtitle && !subOverride) ? SUBTITLE_H_MM : 0;
      var leftRes = nodeLeftReserve(n, t);
      return { x: round(t.x + leftRes), y: round(t.y + 0.3),
        w: round(Math.max(4, t.w - leftRes - 0.6)),
        h: round(Math.max(3, t.h - subH - LABEL_BOX_V_MM)), rotation: t.rotation || 0 };
    }
    spec.nodes.forEach(function (n, ni) {
      var t = clone(placed[n.id]);
      var group = tag(base(n.id, "group", t, z++), spec, n.id, "node");
      group.semantic_node = { id: n.id, role: n.role, kind: n.kind, shape: n.shape };
      group.semantic_role = n.role; group.entity_kind = n.kind; group.declared_shape = n.shape;
      group.declared_transform = clone(t); group.diagram_manual_layout = !!(old[n.id] && old[n.id].diagram_manual_layout);
      group.evidence = clone(n.evidence); group.source_refs = clone(n.evidence); group.children = [];
      group.parent_id = root.id; elements.push(group); groups[n.id] = group;
      var plan = shapePlan(n);
      var shape = tag(base(n.id + ".shape", plan.type, t, z++), spec, n.id, "node_shape");
      shape.parent_id = n.id; shape.declared_shape = n.shape; shape.semantic_role = n.role;
      if (plan.type === "path") shape.pathData = shapePathData(plan, t.w, t.h);
      var semanticPaint = paletteStyle(spec, n);
      var tn = theme.node || {};
      // R9-A：节点填充按主题 groupFill 模式解析（declared/palette/theme）；
      // accent 为徽标/侧条/容器强调色（declared 主题用声明色，其余用主题调色板）。
      var ngf = nodeGroupFill(spec, theme, n);
      var accent = groupAccentColor(spec, theme, n.group);
      // solid-block 等主题：无 group 节点也按主题调色板取饱和深色（配白字）
      var nodePalette = tn.ungroupedPalette === true &&
        Array.isArray(theme.groupColors) && theme.groupColors.length ?
        theme.groupColors[ni % theme.groupColors.length] : null;
      var shapeFill = n.color || n.fill || ngf || (!n.group ? nodePalette : null) ||
        (tn.fill ? null : semanticPaint.fill);
      if (shapeFill == null && tn.fill) shapeFill = tn.fill;
      if (shapeFill == null) shapeFill = semanticPaint.fill;
      shape.style = { fill: shapeFill,
        stroke: n.stroke || tn.stroke || (accent ? "#9CA3AF" : "#334155"),
        strokeWidthPt: n.stroke ? 0.9 : (tn.strokeWidthPt != null ? tn.strokeWidthPt : 0.9),
        cornerRadiusMm: plan.capsule ? t.h / 2 :
          (n.shape === "cell" || n.shape === "process" ? 3 : (tn.cornerRadiusMm != null ? tn.cornerRadiusMm : 1)),
        role: semanticPaint.role, semanticRole: semanticPaint.semanticRole };
      shape.evidence = clone(n.evidence);
      var priorShape = old[shape.id];
      if (keepManual && priorShape && priorShape.diagram_manual_layout) shape.transform = clone(priorShape.transform);
      elements.push(shape); group.children.push(shape.id);
      var labelTransform = labelBoxFor(n, t);
      var label = tag(base(n.id + ".label", "text", labelTransform, z++), spec, n.id, "node_text");
      var metrics = labelMetrics(n, labelTransform.w, labelTransform.h);
      label.parent_id = n.id; label.text = metrics.text; label.contract_label = n.label; label.semantic_role = n.role;
      label.diagram_label_layout = clone(metrics);
      // R9-A：文字色对节点填充做 WCAG≥4.5 兜底（主题色优先，不足时换深/浅墨）
      label.style = { fill: inkFor(shapeFill, tn.fillText || "#172033"),
        fontFamily: tn.fontFamily || "Arial, sans-serif",
        fontSizePt: n.fontSizePt === undefined ? 7 : n.fontSizePt,
        fontWeight: tn.fontWeight || undefined,
        textAlign: "center", verticalAlign: "middle", lineHeight: 1.2, role: n.role };
      label.evidence = clone(n.evidence);
      var priorText = old[label.id];
      if (keepManual && priorText) {
        if (priorText.contract_label === n.label && typeof priorText.text === "string") label.text = priorText.text;
        if (priorText.semantic_role === n.role && obj(priorText.style)) label.style = Object.assign({}, clone(priorText.style), { role: n.role });
        label.diagram_label_layout.text = label.text;
      }
      elements.push(label); group.children.push(label.id);
      // R9：subtitle 第二行小字；roadmap 移到右栏（calculated.subtitles 覆盖）
      if (n.subtitle) {
        var subBox = (calculated.subtitles && calculated.subtitles[n.id]) ||
          (function () {
            var lr = nodeLeftReserve(n, t);
            return { x: round(t.x + lr + 0.4), y: round(t.y + t.h - SUBTITLE_H_MM - 0.3),
              w: round(Math.max(4, t.w - lr - 1.4)), h: SUBTITLE_H_MM, rotation: 0 };
          })();
        var sub = tag(base(n.id + ".subtitle", "text", subBox, z++),
          spec, n.id, "node_subtitle");
        sub.parent_id = n.id; sub.text = n.subtitle; sub.contract_label = n.subtitle;
        // roadmap 等把 subtitle 移出节点时，底色是画布而非节点填充
        var subBg = calculated.subtitles && calculated.subtitles[n.id] ?
          ((spec.canvas && spec.canvas.background) || "#FFFFFF") : shapeFill;
        sub.style = { fill: inkFor(subBg, tn.subtitleColor || "#6B7280"),
          fontFamily: tn.fontFamily || "Arial, sans-serif", fontSizePt: 5.5,
          textAlign: calculated.subtitles && calculated.subtitles[n.id] ? "left" : "center",
          verticalAlign: "middle", lineHeight: 1.15 };
        elements.push(sub); group.children.push(sub.id);
      }
      // R9-B：编号徽标在节点左侧居中，文字区已右移（labelBoxFor）
      if (n.step) {
        var bm = badgeMetrics(t);
        var badgeBox = { x: round(t.x + 1.0), y: round(bm.cy - bm.br),
          w: round(bm.br * 2), h: round(bm.br * 2), rotation: 0 };
        var badge = tag(base(n.id + ".stepbadge", "ellipse", badgeBox, z++),
          spec, n.id, "step_badge");
        badge.parent_id = n.id;
        // R9-A：numbered-card 徽标始终取主题彩色调色板（组内按组序、无组按
        // 节点序）；其余主题用 badge.fill 固定色，不再吃浅色组色导致白字不可见。
        var badgeIdx = n.group != null ? groupIndexOf(spec, n.group) : ni;
        var badgePalette = theme.badge && theme.badge.ungroupedPalette === true &&
          Array.isArray(theme.groupColors) && theme.groupColors.length ?
          theme.groupColors[badgeIdx % theme.groupColors.length] : null;
        var bcol = badgePalette || (theme.badge && theme.badge.fill) || accent || "#6B7280";
        badge.style = { fill: bcol, stroke: null, strokeWidthPt: 0 };
        elements.push(badge); group.children.push(badge.id);
        var bt = tag(base(n.id + ".steptext", "text", badgeBox, z++),
          spec, n.id, "step_text");
        bt.parent_id = n.id; bt.text = n.step;
        bt.style = { fill: inkFor(bcol, (theme.badge && theme.badge.text) || "#FFFFFF"),
          fontFamily: "Arial, sans-serif", fontSizePt: Math.max(5, bm.br * 1.5),
          fontWeight: "bold", textAlign: "center", verticalAlign: "middle" };
        elements.push(bt); group.children.push(bt.id);
      }
      // R9-10：side-bar 主题左侧 1.2mm 阶段色条
      if (theme.node && theme.node.sideBar) {
        var sbar = tag(base(n.id + ".sidebar", "rect",
          { x: round(t.x + 0.5), y: round(t.y + 0.6), w: 1.4,
            h: round(Math.max(2, t.h - 1.2)), rotation: 0 }, z++),
          spec, n.id, "node_sidebar");
        sbar.parent_id = n.id;
        // R9-A：侧条用组强调色（side-bar 主题 palette 优先 → 饱和色条可见）
        var sideFill = accent ||
          (Array.isArray(theme.groupColors) && theme.groupColors.length ?
            theme.groupColors[ni % theme.groupColors.length] : "#6366F1");
        sbar.style = { fill: sideFill, stroke: null, strokeWidthPt: 0,
          cornerRadiusMm: 0.5 };
        elements.push(sbar); group.children.push(sbar.id);
      }
      // R9：roadmap 左栏阶段标签（竖色条 + 文字，相邻同组并入一块）
      (calculated.texts || []).forEach(function (gt) {
        if (gt.parent !== n.id) return;
        var gbar = tag(base(n.id + ".gbar", "rect",
          { x: gt.barX, y: gt.barY, w: gt.barW, h: gt.barH, rotation: 0 }, z++),
          spec, n.id, "group_bar");
        gbar.parent_id = n.id;
        gbar.style = { fill: (gt.group != null ?
            groupAccentColor(spec, theme, gt.group) : null) || gt.barColor || "#6366F1",
          stroke: null, strokeWidthPt: 0, cornerRadiusMm: 0.6 };
        elements.push(gbar); group.children.push(gbar.id);
        var gl = tag(base(n.id + ".glabel", "text",
          { x: gt.x, y: gt.y, w: gt.w, h: gt.h, rotation: 0 }, z++),
          spec, n.id, "group_label");
        gl.parent_id = n.id; gl.text = gt.text;
        gl.style = { fill: "#374151", fontFamily: "Arial, sans-serif", fontSizePt: 6.5,
          textAlign: "left", verticalAlign: "middle", fontWeight: "bold" };
        elements.push(gl); group.children.push(gl.id);
      });
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
        includedChildren[nid] ? { x: box.x+2, y: box.y+1, w: Math.max(1,box.w-4), h: 6, rotation: 0 } : labelBoxFor(specNode, box);
      var slot = elements.filter(function (el) { return el.id === nid + ".slot"; })[0];
      if (slot) slot.transform = slotTransform(box);
      // include 容器会改变节点外框：徽标/副标题/色条同步重算（手动位保留）
      if (!manual) {
        var bm2 = badgeMetrics(box);
        [[".stepbadge", { x: round(box.x + 1.0), y: round(bm2.cy - bm2.br),
            w: round(bm2.br * 2), h: round(bm2.br * 2), rotation: 0 }],
          [".steptext", { x: round(box.x + 1.0), y: round(bm2.cy - bm2.br),
            w: round(bm2.br * 2), h: round(bm2.br * 2), rotation: 0 }],
          [".sidebar", { x: round(box.x + 0.5), y: round(box.y + 0.6), w: 1.4,
            h: round(Math.max(2, box.h - 1.2)), rotation: 0 }]
        ].forEach(function (pair) {
          var ex = elements.filter(function (el) { return el.id === nid + pair[0]; })[0];
          if (ex && !(old[ex.id] && old[ex.id].diagram_manual_layout)) ex.transform = pair[1];
        });
        var subEl = elements.filter(function (el) { return el.id === nid + ".subtitle"; })[0];
        if (subEl && !(calculated.subtitles && calculated.subtitles[nid]) &&
            !(old[subEl.id] && old[subEl.id].diagram_manual_layout)) {
          var lr2 = nodeLeftReserve(specNode, box);
          subEl.transform = { x: round(box.x + lr2 + 0.4),
            y: round(box.y + box.h - SUBTITLE_H_MM - 0.3),
            w: round(Math.max(4, box.w - lr2 - 1.4)), h: SUBTITLE_H_MM, rotation: 0 };
        }
      }
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
    var ORTHO_ROUTE_MODES = { stages: true, lanes: true, tree: true, prisma: true, roadmap: true };
    // cycle 环形弧线：bend 让弦中点沿椭圆外法向鼓出；弧线两两可能相交，
    // 对每条边贪心尝试翻转鼓出方向，取与其它弧线交叉最少的符号（沿环单向、不交叉）。
    var cycleBends = null;
    if (spec.layout.mode === "cycle" && calculated.ellipse) {
      var bc0 = calculated.ellipse;
      var cycRels = spec.relations.filter(function (r) {
        return r.kind !== "include" && r.bend === undefined && placed[r.source] && placed[r.target];
      });
      if (cycRels.length) {
        var mag0 = Math.min(bc0.rx, bc0.ry) * 0.38;
        var cinfo = cycRels.map(function (r) {
          var pa = placed[r.source], pb = placed[r.target];
          var sx = pa.x + pa.w / 2, sy = pa.y + pa.h / 2;
          var ex = pb.x + pb.w / 2, ey = pb.y + pb.h / 2;
          var edx = ex - sx, edy = ey - sy, elen = Math.sqrt(edx * edx + edy * edy) || 1;
          var mx = (sx + ex) / 2 - bc0.cx, my = (sy + ey) / 2 - bc0.cy;
          var sgn = (edx * my - edy * mx) >= 0 ? 1 : -1;
          return { id: r.id, sx: sx, sy: sy, ex: ex, ey: ey, sgn: sgn,
            mx: (sx + ex) / 2, my: (sy + ey) / 2, elen: elen, edx: edx, edy: edy };
        });
        function bendMid(ci, sgn) {
          var b = sgn * mag0;
          return { x: ci.mx - ci.edy / ci.elen * b, y: ci.my + ci.edx / ci.elen * b };
        }
        function bezier(ci, sgn) {
          var m = bendMid(ci, sgn), pts = [], n = 14;
          for (var i = 0; i <= n; i++) {
            var t = i / n, u = 1 - t;
            pts.push({ x: u * u * ci.sx + 2 * u * t * m.x + t * t * ci.ex,
              y: u * u * ci.sy + 2 * u * t * m.y + t * t * ci.ey });
          }
          return pts;
        }
        function segX(a, b, c, d) {
          function cr(p, q, r) { return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x); }
          var o1 = cr(a, b, c), o2 = cr(a, b, d), o3 = cr(c, d, a), o4 = cr(c, d, b);
          return o1 * o2 < 0 && o3 * o4 < 0;
        }
        function pathX(ptsA, ptsB) {
          for (var i = 0; i < ptsA.length - 1; i++)
            for (var j = 0; j < ptsB.length - 1; j++)
              if (segX(ptsA[i], ptsA[i + 1], ptsB[j], ptsB[j + 1])) return true;
          return false;
        }
        var sampled = cinfo.map(function (ci) { return bezier(ci, ci.sgn); });
        function crosses(idx) {
          var n = 0;
          for (var j = 0; j < cinfo.length; j++) {
            if (j === idx) continue;
            if (pathX(sampled[idx], sampled[j])) n++;
          }
          return n;
        }
        for (var pass = 0; pass < 2; pass++) {
          var changed = false;
          for (var k = 0; k < cinfo.length; k++) {
            var before = crosses(k);
            var altPts = bezier(cinfo[k], -cinfo[k].sgn);
            var oldPts = sampled[k];
            sampled[k] = altPts;
            var after = crosses(k);
            if (after < before) { cinfo[k].sgn = -cinfo[k].sgn; changed = true; }
            else sampled[k] = oldPts;
          }
          if (!changed) break;
        }
        cycleBends = Object.create(null);
        cinfo.forEach(function (ci) {
          cycleBends[ci.id] = round(ci.sgn * mag0 * 10) / 10;
        });
      }
    }
    spec.relations.filter(function (r) { return r.kind !== "include"; }).forEach(function (r) {
      var c = tag(base("diagram-" + spec.id + ":relation:" + r.id, "connector",
        { x: 0, y: 0, w: docCanvas.width_mm, h: docCanvas.height_mm }, z++), spec, null, "relation");
      c.relation = { source: r.source, target: r.target, kind: r.kind, direction: r.direction };
      if (r.bend !== undefined) c.relation.bend = r.bend;
      else if (cycleBends && cycleBends[r.id] !== undefined) c.relation.bend = cycleBends[r.id];
      if (r.label !== undefined) c.relation.label = r.label;
      // 阶段/容器类布局一律正交走线；timeline 关系仅作语义保留不渲染
      c.orthogonal_route = ORTHO_ROUTE_MODES[spec.layout.mode] === true;
      if (spec.layout.mode === "timeline") c.visible = false;
      c.semantic_relation = { id: r.id, source: r.source, target: r.target, kind: r.kind, direction: r.direction };
      c.parent_id = root.id;
      c.evidence = clone(r.evidence); c.source_refs = clone(r.evidence);
      var tc2 = theme.connector || {};
      c.style = { stroke: r.kind === "activate" ? "#2E7D32" : r.kind === "inhibit" ? "#C62828" :
          (tc2.stroke || "#334155"),
        strokeWidthPt: tc2.strokeWidthPt != null ? tc2.strokeWidthPt : 1.1,
        fill: null, arrowHead: "none", role: "relation_" + r.kind };
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
    return { elements: all, placements: placed, canvas: docCanvas, layout: {
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
    var other = base.elements.filter(function (el) { return !el || el.diagram_id !== spec.id; });
    var maxZ = 0; other.forEach(function (el) { if (el && finite(el.z)) maxZ = Math.max(maxZ, el.z); });
    var built = buildElements(spec, previous, opts.auto_layout !== true && spec.layout.auto_layout !== true, maxZ + 1);
    if (spec.layout.page_fill) {
      var cw = spec.canvas.width_mm, ch = spec.canvas.height_mm, fill = spec.layout.page_fill;
      var visible = built.elements.filter(function (el) {
        return el.visible !== false && el.diagram_part !== "scene" && el.type !== "connector" && !el.relation_label_for;
      });
      var left = Math.min.apply(null, visible.map(function (e) { return e.transform.x; }));
      var top = Math.min.apply(null, visible.map(function (e) { return e.transform.y; }));
      var right = Math.max.apply(null, visible.map(function (e) { return e.transform.x + e.transform.w; }));
      var bottom = Math.max.apply(null, visible.map(function (e) { return e.transform.y + e.transform.h; }));
      built.layout.page_fit = global.FigDoc.fitElements(built.elements,
        {x:left, y:top, w:right-left, h:bottom-top},
        {x:cw*(1-fill)/2, y:ch*(1-fill)/2, w:cw*fill, h:ch*fill});
      built.elements[0].transform = {x:0, y:0, w:cw, h:ch, rotation:0};
      built.canvas = spec.canvas;
    }
    base.canvas = Object.assign({}, base.canvas, clone(built.canvas || spec.canvas));
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
    // R9：中性占位文字（不再给每个标签加「（示例）」后缀造成难看折行）；
    // 「合成示例」声明保留在 sources/uncertainties。
    var labels = synthetic === false ? roles.map(function (_, i) { return "待填写实体 " + (i + 1); }) :
      graphical ? ["研究问题", "方法路线", "核心证据", "结论"] :
        ["输入", "预处理", "输出"];
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
    // R9：所有 tpl-diagram-* / tpl-graphical-abstract 模板均可应用——
    // apply 路径统一要求用户提供 schematic（或模板自带默认结构），
    // templateCapability / supportsTemplate / apply_template 三处一致。
    var generic = { "tpl-diagram-flow": true, "tpl-diagram-arch": true,
      "tpl-diagram-pipeline": true, "tpl-graphical-abstract": true };
    var value = typeof tpl === "string" ? tpl : obj(tpl) && (tpl.id || tpl.template_id || tpl.template || tpl.chart_type);
    var supported = !!generic[value];
    if (typeof value === "string" &&
        (/^tpl-diagram-[a-z0-9-]+$/.test(value) || value === "tpl-graphical-abstract")) {
      supported = TEMPLATE_IDS[value] !== undefined || generic[value] === true;
    }
    if (obj(tpl) && !value && tpl.chart_type === "graphical_abstract") supported = true;
    if (obj(tpl) && tpl.category === "diagram" && typeof value === "string" &&
        /^tpl-diagram-/.test(value)) supported = TEMPLATE_IDS[value] !== undefined;
    return { supported: supported, mode: "raw_parameters_only", requires_data: false,
      requires: supported ? "apply_schematic.contract" : null,
      reason: supported ? "可编辑的矢量图；只按你提供的节点、关系、来源绘制，不会自动关联数据；示例不代表论文" :
        "没有可用的通用实体关系模板，暂不能生成；占位预览不等于已支持" };
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
    // R9-D：中点肘形候选——竖-横-竖 / 横-竖-横，覆盖无障碍也需拐弯的
    // 阶段/容器/树形布局（同列对齐时 compactPolyline 自动退化为直线）。
    var midY = (ca.y + cb.y) / 2, midX = (ca.x + cb.x) / 2;
    if (Math.abs(midY - ca.y) > LAYOUT_EPS_MM || Math.abs(midY - cb.y) > LAYOUT_EPS_MM) {
      candidates.push(compactPolyline([portStart, { x: portStart.x, y: midY },
        { x: portEnd.x, y: midY }, portEnd]));
    }
    if (Math.abs(midX - ca.x) > LAYOUT_EPS_MM || Math.abs(midX - cb.x) > LAYOUT_EPS_MM) {
      candidates.push(compactPolyline([portStart, { x: midX, y: portStart.y },
        { x: midX, y: portEnd.y }, portEnd]));
    }
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
    // R10 修复：端口在边上的顺序按对端节点中心沿边方向的投影排序，
    // 使同侧扇出的连线端口方位与目标方位一致，避免弧线/折线交叉
    // （loop 顶部两条弧线互相穿过即由此引起）。
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
    var rank = peers.map(function (p, i) { return i; })
      .sort(function (a, b) { return centers[a] - centers[b] || a - b; })
      .indexOf(index);
    if (count === 2) {
      fraction = rank === 0 ? 0.25 : 0.75;
      var mean = (centers[0] + centers[1]) / 2;
      fraction += Math.max(-0.125, Math.min(0.125, 0.125 * (centers[index] - mean) / Math.max(sideLength, LAYOUT_EPS_MM)));
    } else if (count === 1) fraction = 0.5;
    else {
      var margin = Math.max(0.1, Math.min(0.25, 2 / Math.max(sideLength, LAYOUT_EPS_MM)));
      fraction = margin + (1 - 2 * margin) * rank / Math.max(1, count - 1);
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
    } else if (rel.kind !== "include" &&
        (connector.orthogonal_route === true || !pathIsClear(points, obstacles))) {
      var routed = orthogonalRoute(a, b, obstacles, start, end);
      if (routed) {
        points = routed; pathType = "orthogonal"; middle = polylineMidpoint(points);
        start = points[0]; end = points[points.length - 1];
      } else if (!pathIsClear(points, obstacles)) routeResolved = false;
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

  // R9：文字生成解析。语法：
  //   A -> B -> C        建节点与连线（同标签复用节点）
  //   A -> B : 是        连线标签（链式时作用于最后一条边）
  //   ## 阶段名          开始一个 group，之后节点归入该组
  //   标签以 ?/？ 结尾   判定节点（菱形）
  //   (开始)             括号包裹 → terminal 起止形
  // 返回 {ok, input, errors:[{line,message}]}；input 可直接喂 normalize/build。
  function parseText(src, opts) {
    opts = opts || {};
    var errors = [];
    var nodes = [], relations = [], groups = [];
    var nodeByLabel = Object.create(null), seq = 0, relSeq = 0;
    var currentGroup = null;
    function nid() { return "n" + (++seq); }
    function rid() { return "r" + (++relSeq); }
    function ensureNode(rawLabel, lineNo) {
      var label = String(rawLabel).trim();
      var tm = /^[（(]([^()（）]*)[)）]$/.exec(label);
      var terminal = !!tm;
      var inner = terminal ? tm[1].trim() : label;
      var decision = /[?？]$/.test(inner);
      if (decision) inner = inner.replace(/[?？]\s*$/, "").trim();
      // 形状语义参与去重键：(开始) 与 开始、判断? 与 判断 是不同节点
      var key = (terminal ? "T:" : "") + (decision ? "D:" : "") + inner;
      if (nodeByLabel[key]) return nodeByLabel[key];
      var n = { id: nid(), label: inner || label, role: "method", shape: "box", evidence: [] };
      if (decision) { n.kind = "decision"; n.shape = "diamond"; }
      if (terminal) { n.kind = "terminal"; n.shape = "terminal"; }
      if (currentGroup) n.group = currentGroup;
      nodeByLabel[key] = n.id;
      nodes.push(n);
      return n.id;
    }
    String(src || "").split(/\r\n|\n|\r/).forEach(function (raw, li) {
      var line = raw.trim();
      var ln = li + 1;
      if (!line || line.indexOf("//") === 0) return;
      var gm = /^##\s*(.+)$/.exec(line);
      if (gm) {
        var gname = gm[1].trim();
        if (!gname) { errors.push({ line: ln, message: "## 后需要阶段名" }); return; }
        currentGroup = "g" + (groups.length + 1);
        groups.push({ id: currentGroup, label: gname });
        return;
      }
      if (line.indexOf("->") < 0) {
        // 独立成行的 (标签) 声明一个起止节点（不产生连线）
        if (/^[（(][^()（）]*[)）]$/.test(line)) { ensureNode(line, ln); return; }
        errors.push({ line: ln, message: "无法识别：每行应为「A -> B」连线、「## 阶段名」分组或「(起止节点)」" });
        return;
      }
      var segs = line.split("->");
      var edgeLabel = null;
      var last = segs[segs.length - 1];
      var cm = /^(.*?)\s*[:：]\s*(\S.*?)\s*$/.exec(last);
      if (cm && cm[2]) { edgeLabel = cm[2].trim(); segs[segs.length - 1] = cm[1]; }
      var ids = [];
      for (var si = 0; si < segs.length; si++) {
        var lab = segs[si].trim();
        if (!lab) { errors.push({ line: ln, message: "-> 两侧缺少节点名" }); return; }
        ids.push(ensureNode(lab, ln));
      }
      for (var ei = 1; ei < ids.length; ei++) {
        var rel = { id: rid(), source: ids[ei - 1], target: ids[ei],
          kind: "sequence", direction: "forward" };
        if (ei === ids.length - 1 && edgeLabel) rel.label = edgeLabel;
        relations.push(rel);
      }
    });
    var input = {
      id: opts.id || "text-diagram",
      template_id: opts.template_id || opts.template || "flow",
      nodes: nodes, relations: relations,
      sources: [{ id: "text-input", locator: "用文字生成（用户输入的结构化描述）" }],
      uncertainties: ["文字生成的节点/连线为结构占位，不是已核实的论文或实验结论；请人工确认内容。"]
    };
    if (groups.length) input.groups = groups;
    if (opts.layout) input.layout = opts.layout;
    if (opts.theme) input.theme = opts.theme;
    if (opts.canvas) input.canvas = opts.canvas;
    if (!nodes.length) errors.push({ line: 0, message: "没有解析到任何节点" });
    return { ok: errors.length === 0, input: input, errors: errors };
  }

  global.FigDiagram = {
    SCHEMA_VERSION: VERSION, ROLES: ROLES.slice(), SHAPES: SHAPES.slice(), NODE_KINDS: KINDS.slice(),
    RELATION_KINDS: RELATIONS.slice(), DIRECTIONS: DIRECTIONS.slice(), TEMPLATES: TEMPLATES.slice(),
    LAYOUT_MODES: LAYOUT_MODES.slice(), parseText: parseText,
    diagramTheme: diagramTheme, BUILTIN_THEMES: clone(BUILTIN_THEMES),
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
