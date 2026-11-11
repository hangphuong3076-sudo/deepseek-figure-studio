/* Entity/relation editor. Preview is isolated; App.commit is the only document write. */
(function (global) {
  "use strict";
  var panel = null, spec = null, dirty = false, jsonDirty = false, jsonText = "", selectedDiagram = "workbench-schematic";
  function kernelList(key, fallback) {
    return global.FigDiagram && Array.isArray(global.FigDiagram[key]) ? global.FigDiagram[key] : fallback;
  }
  function ROLES() { return kernelList("ROLES", ["question", "method", "evidence", "conclusion"]); }
  function SHAPES() { return kernelList("SHAPES", ["box", "ellipse", "cell", "molecule", "material", "process", "outcome", "chart"]); }
  function NODE_KINDS() { return kernelList("NODE_KINDS", ["entity", "decision"].concat(SHAPES())); }
  function KINDS() { return kernelList("RELATION_KINDS", ["activate", "inhibit", "include", "associate", "sequence"]); }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null) return;
      if (key === "text") el.textContent = String(value);
      else if (key === "class") el.className = value;
      else if (key.indexOf("on") === 0 && typeof value === "function") el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value);
    });
    (children || []).forEach(function (child) {
      if (child !== null && child !== undefined) el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return el;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function requireKernel() {
    if (!global.FigDoc || !global.FigDiagram || !global.FigRender || !global.App) {
      throw new Error("实体关系面板需要 FigDoc、FigDiagram、FigRender 与 App");
    }
  }
  function notify(text, error) {
    if (error && global.App.error) global.App.error(text);
    else if (global.App.status) global.App.status(text);
  }
  function mark() {
    dirty = true;
    var node = panel && panel.querySelector("#diagram-validation");
    if (node) node.textContent = "有尚未预览/提交的修改；图面仍是上一份已提交版本。";
    syncJson();
  }
  function contract() {
    var draft = clone(spec);
    draft.nodes.forEach(function (n) { delete n.data_slot; });
    return global.FigDiagram.normalize(draft);
  }
  function setNodeType(node, shape, kind) {
    var derived = node.kind === undefined || node.kind === node.shape;
    node.shape = shape;
    node.kind = kind !== undefined ? kind : (derived ? shape : node.kind);
    delete node.data_slot;
    if (node.shape === "chart" || node.kind === "chart") node.data_slot = {type: "chart", declared: "explicit_shape_or_kind"};
  }
  function syncJson() {
    var area = panel && panel.querySelector("#diagram-json");
    if (!area) return;
    if (jsonDirty) {
      var hint = panel.querySelector("#diagram-json-hint");
      if (hint) hint.textContent = "JSON 区有未应用的手写修改，未被表单覆盖；点击「应用 JSON」或「从表单重载 JSON」。";
      return;
    }
    var text;
    try { text = JSON.stringify(contract(), null, 2); } catch (err) { text = JSON.stringify(spec, null, 2); }
    area.value = text;
  }
  function nextId(items, prefix) {
    var used = {};
    items.forEach(function (item) { used[item.id] = true; });
    var i = items.length + 1;
    while (used[prefix + "-" + i]) i++;
    return prefix + "-" + i;
  }
  function emptySource() {
    return {id: nextId(spec.sources, "source"), locator: "用户提供定位（必填）", note: ""};
  }
  function normalizeDirection(relation) {
    if (relation.kind === "associate") relation.direction = "none";
    else if (relation.kind === "include") relation.direction = "none";
    else if (relation.direction === "none") relation.direction = "forward";
  }
  function sourceOptions(value) {
    var select = h("select", {"aria-label": "来源"});
    select.appendChild(h("option", {value: "", text: "未关联来源"}));
    spec.sources.forEach(function (source) {
      select.appendChild(h("option", {value: source.id, text: source.id + " · " + source.locator}));
    });
    select.value = value || "";
    return select;
  }
  function evidence(editor, type) {
    var source = sourceOptions(editor.evidence.length ? editor.evidence[0].source_id : "");
    source.addEventListener("change", function () {
      if (source.value) {
        editor.evidence = [{source_id: source.value,
          locator: type === "relation" ? "关系对应段落（用户填写）" : "实体对应段落（用户填写）",
          note: editor.evidence.length ? editor.evidence[0].note : "", uncertainties: []}];
      } else editor.evidence = [];
      mark();
    });
    return source;
  }
  function field(label, input) {
    return h("label", {class: "diagram-field"}, [h("span", {text: label}), input]);
  }
  function removeAt(list, index) {
    list.splice(index, 1);
    mark();
    buildUI();
    renderPreview();
  }
  function nodeRow(node, index) {
    var id = h("input", {value: node.id, title: "语义 id；关系必须引用此 id", "aria-label": "节点 id"});
    id.addEventListener("change", function () {
      var value = id.value.trim();
      if (!value || spec.nodes.some(function(n, i) { return i !== index && n.id === value; })) {
        notify("节点 id 不能为空或重复", true); id.value = node.id; return;
      }
      spec.relations.forEach(function (r) {
        if (r.source === node.id) r.source = value;
        if (r.target === node.id) r.target = value;
      });
      node.id = value; mark(); buildUI();
    });
    var label = h("input", {value: node.label, "aria-label": "科学实体名称"});
    label.addEventListener("input", function () { node.label = label.value; mark(); });
    var role = h("select", {"aria-label": "节点 role"});
    ROLES().forEach(function (r) { role.appendChild(h("option", {value: r, text: r})); });
    role.value = node.role;
    role.addEventListener("change", function () { node.role = role.value; mark(); renderPreview(); });
    var shape = h("select", {"aria-label": "通用形状声明"});
    SHAPES().forEach(function (s) { shape.appendChild(h("option", {value: s, text: s})); });
    shape.value = node.shape;
    var kind = h("select", {"aria-label": "节点 kind"});
    NODE_KINDS().forEach(function (k) { kind.appendChild(h("option", {value: k, text: k})); });
    kind.value = node.kind === undefined ? node.shape : node.kind;
    var slot = h("span", {class: "diagram-slot-state diagram-note", "data-slot-for": node.id});
    function syncType() {
      kind.value = node.kind;
      slot.textContent = node.data_slot ? "数据 slot：是（显式 chart）" : "数据 slot：否";
    }
    shape.addEventListener("change", function () { setNodeType(node, shape.value); syncType(); mark(); renderPreview(); });
    kind.addEventListener("change", function () { setNodeType(node, node.shape, kind.value); syncType(); mark(); renderPreview(); });
    shape.title = "只有明确选择 chart（或 kind=chart）才创建数据 slot；不会因 role/实体名称自动转图表";
    kind.title = "kind 未单独设置时跟随 shape；kind=chart 同样声明数据 slot";
    syncType();
    var x = h("input", {type: "number", step: "any", value: node.x === undefined ? "" : node.x, title: "x mm（留空自动布局）"});
    var y = h("input", {type: "number", step: "any", value: node.y === undefined ? "" : node.y, title: "y mm（留空自动布局）"});
    x.addEventListener("change", function () {
      if (x.value === "") delete node.x; else node.x = Number(x.value); mark(); renderPreview();
    });
    y.addEventListener("change", function () {
      if (y.value === "") delete node.y; else node.y = Number(y.value); mark(); renderPreview();
    });
    var note = h("input", {value: node.evidence.length ? node.evidence[0].note : "", placeholder: "来源说明（非复核结论）"});
    note.addEventListener("input", function () {
      if (note.value && !node.evidence.length && spec.sources.length) {
        node.evidence = [{source_id: spec.sources[0].id, locator: "待用户精确填写", uncertainties: ["定位未精确复核"]}];
      }
      if (node.evidence.length) node.evidence[0].note = note.value;
      mark();
    });
    return h("div", {class: "diagram-record", "data-node-id": node.id}, [
      h("div", {class: "diagram-record-head"}, [h("strong", {text: "实体 " + (index + 1)}),
        h("button", {type: "button", text: "删除", onclick: function () {
          spec.relations = spec.relations.filter(function (r) { return r.source !== node.id && r.target !== node.id; });
          removeAt(spec.nodes, index);
        }})]),
      h("div", {class: "diagram-grid"}, [field("id", id), field("label（可编辑文字）", label),
        field("role / 颜色语义", role), field("shape / 通用类型（chart=显式数据 slot）", shape),
        field("kind（默认跟随 shape）", kind), field("x", x), field("y", y), slot]),
      h("div", {class: "diagram-grid"}, [field("source", evidence(node, "node")), field("source note", note)])
    ]);
  }
  function relationRow(relation, index) {
    var endpoint = function (key) {
      var select = h("select", {"aria-label": key});
      spec.nodes.forEach(function (n) { select.appendChild(h("option", {value: n.id, text: n.id + " · " + n.label})); });
      select.value = relation[key];
      select.addEventListener("change", function () { relation[key] = select.value; mark(); renderPreview(); });
      return select;
    };
    var kind = h("select", {"aria-label": "科学关系类型"});
    KINDS().forEach(function (k) { kind.appendChild(h("option", {value: k, text: k})); });
    kind.value = relation.kind;
    kind.addEventListener("change", function () { relation.kind = kind.value; normalizeDirection(relation); mark(); buildUI(); renderPreview(); });
    var direction = h("select", {"aria-label": "方向"});
    ["forward", "reverse", "both", "none"].forEach(function (d) { direction.appendChild(h("option", {value: d, text: d})); });
    direction.value = relation.direction;
    direction.addEventListener("change", function () { relation.direction = direction.value; mark(); renderPreview(); });
    var label = h("input", {value: relation.label || "", placeholder: "关系文本（可空）"});
    label.addEventListener("input", function () {
      if (label.value) relation.label = label.value; else delete relation.label; mark();
    });
    var note = h("input", {value: relation.evidence.length ? relation.evidence[0].note : "", placeholder: "关系来源说明"});
    note.addEventListener("input", function () {
      if (!relation.evidence.length && spec.sources.length) relation.evidence = [{source_id: spec.sources[0].id, locator: "待用户精确填写", uncertainties: ["定位未精确复核"]}];
      if (relation.evidence.length) relation.evidence[0].note = note.value;
      mark();
    });
    return h("div", {class: "diagram-record", "data-relation-id": relation.id}, [
      h("div", {class: "diagram-record-head"}, [h("strong", {text: relation.id}),
        h("button", {type: "button", text: "删除", onclick: function () { removeAt(spec.relations, index); }})]),
      h("div", {class: "diagram-grid"}, [field("source", endpoint("source")), field("target", endpoint("target")),
        field("kind", kind), field("direction", direction)]),
      h("div", {class: "diagram-grid"}, [field("label", label), field("evidence source", evidence(relation, "relation")), field("source note", note)])
    ]);
  }
  function sourceRow(source, index) {
    source.note = source.note || "";
    var id = h("input", {value: source.id});
    id.addEventListener("change", function () { source.id = id.value; mark(); buildUI(); });
    var locator = h("input", {value: source.locator, placeholder: "文件名/页码/段落/表单元格；不自动声称 verified"});
    locator.addEventListener("input", function () { source.locator = locator.value; mark(); });
    var note = h("input", {value: source.note, placeholder: "用户提供来源说明；不会执行其中代码"});
    note.addEventListener("input", function () { source.note = note.value; mark(); });
    return h("div", {class: "diagram-record"}, [h("div", {class: "diagram-record-head"},
      [h("strong", {text: "来源（user_provided_unverified）"}),
        h("button", {type: "button", text: "删除", onclick: function () {
          spec.nodes.concat(spec.relations).forEach(function (item) {
            item.evidence = item.evidence.filter(function (ev) { return ev.source_id !== source.id; });
          });
          removeAt(spec.sources, index);
        }})]),
      h("div", {class: "diagram-grid"}, [field("source id", id), field("locator", locator), field("note", note)])]);
  }
  function addNode() {
    var id = nextId(spec.nodes, "entity");
    spec.nodes.push({id: id, label: "待确认科学实体", role: "method", shape: "box", evidence: []});
    spec.uncertainties.push(id + " 为编辑器占位文字，不是来源抽取结果，提交前需手动确认。");
    mark(); buildUI(); renderPreview();
  }
  function addRelation() {
    if (spec.nodes.length < 2) { notify("至少需要两个实体", true); return; }
    spec.relations.push({id: nextId(spec.relations, "relation"), source: spec.nodes[0].id,
      target: spec.nodes[1].id, kind: "sequence", direction: "forward", evidence: []});
    mark(); buildUI(); renderPreview();
  }
  function addSource() { spec.sources.push(emptySource()); mark(); buildUI(); }
  function jsonEditor() {
    var area = h("textarea", {id: "diagram-json", spellcheck: "false", "aria-label": "完整 Nodes Relations Sources JSON"});
    var hint = h("p", {id: "diagram-json-hint", class: "diagram-note", text: "与表单同步显示规范化合同；手写修改需点击应用。"});
    area.addEventListener("input", function () { jsonDirty = true; jsonText = area.value; hint.textContent = "JSON 区有未应用的手写修改。"; });
    var apply = h("button", {type: "button", text: "应用 JSON 到编辑器", onclick: function () {
      try {
        var raw = JSON.parse(area.value);
        raw.id = spec.id;
        var normalized = global.FigDiagram.normalize(raw);
        spec = normalized;
        jsonDirty = false;
        mark(); buildUI();
      } catch (err) { notify("JSON 未应用：" + err.message, true); }
    }});
    var reload = h("button", {type: "button", text: "从表单重载 JSON", onclick: function () {
      jsonDirty = false; syncJson(); hint.textContent = "已按表单重载；手写修改已丢弃。";
    }});
    if (jsonDirty) area.value = jsonText;
    return h("details", {class: "diagram-json-wrap", open: true}, [h("summary", {text: "完整 Nodes / Relations / Sources / 布局 JSON"}), hint, area, apply, reload]);
  }
  function reviewEditor() {
    var review = spec.human_review || {reviewer: "", checked_at: "", outcome: "", notes: ""};
    var inputs = {};
    ["reviewer", "checked_at", "outcome", "notes"].forEach(function (key) {
      inputs[key] = h("input", {value: review[key], placeholder: key === "checked_at" ? "真实 ISO 时间" : key === "outcome" ? "accepted / changes_requested / rejected" : "真实人工填写，不自动生成"});
      inputs[key].addEventListener("input", function () {
        var r = spec.human_review || {reviewer: "", checked_at: "", outcome: "", notes: ""};
        r[key] = inputs[key].value;
        var all = ["reviewer", "checked_at", "outcome", "notes"].every(function (k) { return r[k].trim(); });
        spec.human_review = all ? r : null;
        mark();
      });
    });
    return h("details", {}, [h("summary", {text: "真实人工复核记录（不会自动伪造）"}),
      h("p", {class: "diagram-note", text: "全部四项由实际复核人填写后才入档；当前没有记录时 review_status=not_recorded。结构测试不是人工验收。"}),
      h("div", {class: "diagram-grid"}, [field("reviewer", inputs.reviewer), field("checked_at", inputs.checked_at),
        field("outcome", inputs.outcome), field("notes", inputs.notes)])]);
  }
  function buildUI() {
    if (!panel) return;
    panel.textContent = "";
    panel.appendChild(h("div", {class: "diagram-toolbar"}, [
      h("button", {type: "button", id: "diagram-preview", text: "真实矢量预览", onclick: renderPreview}),
      h("button", {type: "button", id: "diagram-commit", class: "primary", text: "提交到画布（可撤销）", onclick: function () { commit().catch(function () {}); }})]));
    panel.appendChild(h("div", {id: "diagram-validation", class: "diagram-note",
      text: dirty ? "有尚未预览/提交的修改" : "来源仅记录用户申报，不代表已核验。四阶段内容是合成示例，非论文/官方三例。"}));
    var preview = h("div", {id: "diagram-live-preview", class: "diagram-live-preview", "aria-label": "FigRender 真实矢量预览"});
    panel.appendChild(preview);
    var idInput = h("input", {value: spec.id});
    idInput.addEventListener("change", function () { spec.id = idInput.value; selectedDiagram = spec.id; mark(); });
    var auto = h("input", {type: "checkbox"});
    auto.checked = spec.layout.auto_layout;
    auto.addEventListener("change", function () { spec.layout.auto_layout = auto.checked; mark(); renderPreview(); });
    panel.appendChild(h("div", {class: "diagram-grid"}, [field("示意图语义 id", idInput),
      field("明确 auto_layout 才重排（同 id 默认保留手动位置）", auto)]));
    var nodes = h("section", {}, [h("div", {class: "diagram-section"}, [h("strong", {text: "实体"}),
      h("button", {type: "button", id: "diagram-add-node", text: "新增实体", onclick: addNode})])]);
    spec.nodes.forEach(function (node, i) { nodes.appendChild(nodeRow(node, i)); });
    panel.appendChild(nodes);
    var relations = h("section", {}, [h("div", {class: "diagram-section"}, [h("strong", {text: "关系（原生 connector）"}),
      h("button", {type: "button", id: "diagram-add-relation", text: "新增关系", onclick: addRelation})])]);
    spec.relations.forEach(function (rel, i) { relations.appendChild(relationRow(rel, i)); });
    panel.appendChild(relations);
    var sources = h("section", {}, [h("div", {class: "diagram-section"}, [h("strong", {text: "来源与定位"}),
      h("button", {type: "button", id: "diagram-add-source", text: "新增来源", onclick: addSource})])]);
    spec.sources.forEach(function (source, i) { sources.appendChild(sourceRow(source, i)); });
    panel.appendChild(sources);
    var uncertainty = h("textarea", {id: "diagram-uncertainties", "aria-label": "不确定性"});
    uncertainty.value = spec.uncertainties.join("\n");
    uncertainty.addEventListener("input", function () {
      spec.uncertainties = uncertainty.value.split(/\r?\n/).filter(function (v) { return v.trim(); }); mark();
    });
    panel.appendChild(field("不确定性 / 缺失材料（每行一项）", uncertainty));
    panel.appendChild(reviewEditor());
    panel.appendChild(jsonEditor());
    syncJson();
    renderPreview();
  }
  function renderPreview() {
    if (!panel) return null;
    try {
      var normalized = contract();
      var previewDoc = global.FigDoc.create({width_mm: 183, height_mm: 110, dpi: 300,
        background: "#FFFFFF", title: "临时合成预览（不写入当前工程）"});
      var built = global.FigDiagram.build(previewDoc, normalized);
      var svg = global.FigRender.toSVG(built.doc);
      var mount = panel.querySelector("#diagram-live-preview");
      mount.textContent = "";
      var host = document.createElement("div");
      host.setAttribute("data-preview-owner", "isolated-figrender");
      host.setAttribute("data-contract-hash", global.FigDiagram.hash(normalized));
      var layoutAudit = built.doc.meta.diagrams[normalized.id].layout_audit;
      host.setAttribute("data-layout-status", layoutAudit.status);
      host.innerHTML = svg;
      mount.appendChild(host);
      var message = built.warnings.map(function (warning) {
        return typeof warning === "string" ? warning : warning.code + "：" + warning.message;
      });
      message.push("版面：" + layoutAudit.status + "，自动风险 " + layoutAudit.risk_count +
        " 项；这不是人工视觉验收通过。本预览是隔离 FigDoc 的真实 FigRender 矢量；未发生 App.commit。");
      panel.querySelector("#diagram-validation").textContent = message.join(" ");
      return svg;
    } catch (err) {
      panel.querySelector("#diagram-validation").textContent = "预览失败，当前工程未修改：" + err.message;
      return null;
    }
  }
  function loadSpec(input, diagramId) {
    requireKernel();
    spec = global.FigDiagram.normalize(clone(input));
    selectedDiagram = diagramId || spec.id;
    dirty = false;
    buildUI();
    return spec;
  }
  function commit() {
    try {
      if (jsonDirty) throw new Error("JSON 区有未应用的手写修改；请先「应用 JSON 到编辑器」或「从表单重载 JSON」，避免提交内容与所见不一致");
      var normalized = contract();
      var result = global.App.commit([{op: "apply_schematic", contract: clone(normalized)}],
        {label: "实体关系示意图：" + normalized.id, source: "user"});
      return Promise.resolve(result).then(function (done) {
        if (!done || !done.applied) throw new Error("提交未生效，请检查契约与历史");
        spec = normalized;
        dirty = false;
        var root = global.App.doc.elements.filter(function (el) {
          return el.type === "group" && el.diagramId === spec.id && !el.diagramNodeId;
        })[0];
        if (root && typeof global.App.select === "function") global.App.select([root.id]);
        notify("已提交原生矢量分组：文字可双击编辑，关系随节点移动重算；来源未自动核验，未见真实人工复核记录");
        buildUI();
        return done;
      }).catch(fail);
    } catch (err) {
      return fail(err);
    }
    function fail(err) {
      notify("示意图提交失败：" + err.message, true);
      return Promise.reject(err);
    }
  }
  function mount(element) {
    requireKernel();
    panel = element;
    if (!spec) spec = global.FigDiagram.normalize(global.FigDiagram.example(selectedDiagram, true));
    buildUI();
  }
  global.DiagramPanel = {mount: mount, loadSpec: loadSpec, getSpec: function () { return clone(spec); },
    getContract: function () { return contract(); }, renderPreview: renderPreview, commit: commit};
})(typeof globalThis !== "undefined" ? globalThis : this);
