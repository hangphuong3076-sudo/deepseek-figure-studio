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
  var ROLE_NAMES = {question:"问题", method:"方法", evidence:"证据", conclusion:"结论"};
  var SHAPE_NAMES = {box:"方框", ellipse:"椭圆", cell:"细胞", molecule:"分子", material:"材料",
    process:"过程", outcome:"结果", chart:"图表"};
  var NODE_KIND_NAMES = {entity:"实体", decision:"判断"};
  var REL_KIND_NAMES = {activate:"激活", inhibit:"抑制", include:"包含", associate:"关联", sequence:"顺序"};
  var DIR_NAMES = {forward:"正向", reverse:"反向", both:"双向", none:"无方向"};
  function optText(map, v) { return map[v] || v; }

  function h(tag, attrs, children) {
    return global.Ui.h(tag, attrs, children);
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
      if (hint) hint.textContent = "上面的定义有未应用的手写修改；点击“用下面的 JSON 更新图”应用，或“按上面的表单重新生成 JSON”丢弃手写修改。";
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
      select.appendChild(h("option", {value: source.id, text: source.locator ? (source.id + " · " + source.locator) : source.id}));
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
    var id = h("input", {value: node.id, title: "编号；关系通过编号引用此实体", "aria-label": "节点编号"});
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
    var label = h("input", {value: node.label, "aria-label": "实体名称"});
    label.addEventListener("input", function () { node.label = label.value; mark(); });
    var role = h("select", {"aria-label": "节点角色"});
    ROLES().forEach(function (r) { role.appendChild(h("option", {value: r, text: optText(ROLE_NAMES, r)})); });
    role.value = node.role;
    role.addEventListener("change", function () { node.role = role.value; mark(); renderPreview(); });
    var shape = h("select", {"aria-label": "形状"});
    SHAPES().forEach(function (s) { shape.appendChild(h("option", {value: s, text: optText(SHAPE_NAMES, s)})); });
    shape.value = node.shape;
    var kind = h("select", {"aria-label": "节点类别"});
    NODE_KINDS().forEach(function (k) { kind.appendChild(h("option", {value: k, text: (NODE_KIND_NAMES[k] || SHAPE_NAMES[k] || k)})); });
    kind.value = node.kind === undefined ? node.shape : node.kind;
    var slot = h("span", {class: "diagram-slot-state diagram-note", "data-slot-for": node.id});
    function syncType() {
      kind.value = node.kind;
      slot.textContent = node.data_slot ? "数据槽位：是（显式图表）" : "数据槽位：否";
    }
    shape.addEventListener("change", function () { setNodeType(node, shape.value); syncType(); mark(); renderPreview(); });
    kind.addEventListener("change", function () { setNodeType(node, node.shape, kind.value); syncType(); mark(); renderPreview(); });
    shape.title = "只有明确选择“图表”形状（或类别为 chart）才创建数据槽位；不会因角色或实体名称自动变成图表";
    kind.title = "类别未单独设置时跟随形状；类别为 chart 同样声明数据槽位";
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
      h("div", {class: "diagram-grid"}, [field("编号", id), field("名称", label),
        field("角色 / 颜色语义", role), field("形状（选“图表”才声明数据槽位）", shape),
        field("类别（默认跟随形状）", kind), field("x", x), field("y", y), slot]),
      h("div", {class: "diagram-grid"}, [field("关联来源", evidence(node, "node")), field("来源说明", note)])
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
    var kind = h("select", {"aria-label": "关系类型"});
    KINDS().forEach(function (k) { kind.appendChild(h("option", {value: k, text: (REL_KIND_NAMES[k] || k)})); });
    kind.value = relation.kind;
    kind.addEventListener("change", function () { relation.kind = kind.value; normalizeDirection(relation); mark(); buildUI(); renderPreview(); });
    var direction = h("select", {"aria-label": "方向"});
    ["forward", "reverse", "both", "none"].forEach(function (d) { direction.appendChild(h("option", {value: d, text: optText(DIR_NAMES, d)})); });
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
      h("div", {class: "diagram-record-head"}, [h("strong", {text: "关系 " + (index + 1)}),
        h("button", {type: "button", text: "删除", onclick: function () { removeAt(spec.relations, index); }})]),
      h("div", {class: "diagram-grid"}, [field("起点实体", endpoint("source")), field("终点实体", endpoint("target")),
        field("关系类型", kind), field("方向", direction)]),
      h("div", {class: "diagram-grid"}, [field("文字", label), field("关联来源", evidence(relation, "relation")), field("来源说明", note)])
    ]);
  }
  function sourceRow(source, index) {
    source.note = source.note || "";
    var id = h("input", {value: source.id});
    id.addEventListener("change", function () { source.id = id.value; mark(); buildUI(); });
    var locator = h("input", {value: source.locator, placeholder: "文件名、DOI 或网址；不会自动声称已核验"});
    locator.addEventListener("input", function () { source.locator = locator.value; mark(); });
    var note = h("input", {value: source.note, placeholder: "来源说明；不会执行其中任何代码"});
    note.addEventListener("input", function () { source.note = note.value; mark(); });
    return h("div", {class: "diagram-record"}, [h("div", {class: "diagram-record-head"},
      [h("strong", {text: "来源（用户提供，未核验）"}),
        h("button", {type: "button", text: "删除", onclick: function () {
          spec.nodes.concat(spec.relations).forEach(function (item) {
            item.evidence = item.evidence.filter(function (ev) { return ev.source_id !== source.id; });
          });
          removeAt(spec.sources, index);
        }})]),
      h("div", {class: "diagram-grid"}, [field("来源编号", id), field("来源位置（文件名、DOI 或网址）", locator), field("备注", note)])]);
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
    var area = h("textarea", {id: "diagram-json", spellcheck: "false", "aria-label": "完整结构 JSON（高级用法）"});
    var hint = h("p", {id: "diagram-json-hint", class: "diagram-note", text: "与上面的表单同步显示；手写修改后需点击“用下面的 JSON 更新图”。"});
    area.addEventListener("input", function () { jsonDirty = true; jsonText = area.value; hint.textContent = "上面的定义有未应用的手写修改。"; });
    var apply = h("button", {type: "button", text: "用下面的 JSON 更新图", onclick: function () {
      try {
        var raw = JSON.parse(area.value);
        raw.id = spec.id;
        var normalized = global.FigDiagram.normalize(raw);
        spec = normalized;
        jsonDirty = false;
        mark(); buildUI();
      } catch (err) { notify("定义未应用：" + err.message, true); }
    }});
    var reload = h("button", {type: "button", text: "按上面的表单重新生成 JSON", onclick: function () {
      jsonDirty = false; syncJson(); hint.textContent = "已按表单内容重新生成；手写修改已丢弃。";
    }});
    if (jsonDirty) area.value = jsonText;
    return h("details", {class: "diagram-json-wrap", open: true}, [h("summary", {text: "完整结构 JSON（节点 / 关系 / 来源 / 布局）· 高级用法"}), hint, area, apply, reload]);
  }
  function reviewEditor() {
    var review = spec.human_review || {reviewer: "", checked_at: "", outcome: "", notes: ""};
    var inputs = {};
    ["reviewer", "checked_at", "outcome", "notes"].forEach(function (key) {
      inputs[key] = h("input", {value: review[key], placeholder: key === "checked_at" ? "真实填写的日期时间" : key === "notes" ? "真实人工填写，不自动生成" : "真实人工填写"});
      inputs[key].addEventListener("input", function () {
        var r = spec.human_review || {reviewer: "", checked_at: "", outcome: "", notes: ""};
        r[key] = inputs[key].value;
        var all = ["reviewer", "checked_at", "outcome", "notes"].every(function (k) { return r[k].trim(); });
        spec.human_review = all ? r : null;
        mark();
      });
    });
    return h("details", {}, [h("summary", {text: "真实人工复核记录（不会自动伪造）"}),
      h("p", {class: "diagram-note", text: "全部四项由实际复核人填写后才入档；当前没有记录时状态为“未记录”。结构测试不等于人工验收。"}),
      h("div", {class: "diagram-grid"}, [field("reviewer", inputs.reviewer), field("checked_at", inputs.checked_at),
        field("outcome", inputs.outcome), field("notes", inputs.notes)])]);
  }
  // R9：主题列表（presets diagram_themes 优先，内置兜底），带缩略图的小按钮组。
  function themeList() {
    var list = [];
    if (global.FigPresets && typeof global.FigPresets.diagramThemes === "function") {
      try { list = global.FigPresets.diagramThemes() || []; } catch (e) { list = []; }
    }
    if (!list.length && global.FigDiagram && global.FigDiagram.BUILTIN_THEMES) {
      list = Object.keys(global.FigDiagram.BUILTIN_THEMES).map(function (id) {
        return {id: id, name: id};
      });
    }
    return list;
  }
  function themeThumb(theme) {
    // 纯 SVG 缩略图：节点色块 + 连线 + 小箭头；不用滤镜/渐变（MuPDF 安全）
    var n = theme.node || {}, c = theme.connector || {}, g = (theme.groupColors || [])[0] || "#E5E7EB";
    var fill = n.fill || g, stroke = n.stroke || "#9CA3AF";
    var sw = n.strokeWidthPt ? Math.max(0.6, n.strokeWidthPt) : 0.6;
    return '<svg viewBox="0 0 64 40" width="52" height="32" aria-hidden="true">' +
      '<rect x="2" y="13" width="20" height="14" rx="2" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"/>' +
      '<rect x="42" y="13" width="20" height="14" rx="2" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"/>' +
      '<path d="M24 20 H38" stroke="' + (c.stroke || "#6B7280") + '" stroke-width="' + (c.strokeWidthPt || 0.8) + '" fill="none"/>' +
      '<path d="M36 16 L42 20 L36 24 Z" fill="' + (c.stroke || "#6B7280") + '"/></svg>';
  }
  function themeBar() {
    var bar = h("div", {class: "diagram-theme-bar"});
    bar.appendChild(h("span", {class: "diagram-note", text: "主题："}));
    themeList().forEach(function (t) {
      var id = t.id || t.theme_id;
      if (!id) return;
      var btn = h("button", {type: "button", class: "diagram-theme-btn",
        "data-theme-id": id, title: t.name || id,
        "aria-pressed": String((spec.theme || "soft-card") === id)});
      var thumb = document.createElement("span");
      var th = (global.FigPresets && typeof global.FigPresets.diagramTheme === "function")
        ? global.FigPresets.diagramTheme(id) : null;
      if (!th && global.FigDiagram.BUILTIN_THEMES) th = global.FigDiagram.BUILTIN_THEMES[id];
      thumb.innerHTML = themeThumb(th || {});
      btn.appendChild(thumb);
      btn.appendChild(h("span", {class: "diagram-theme-name", text: t.name || id}));
      btn.addEventListener("click", function () {
        spec.theme = id;
        bar.querySelectorAll(".diagram-theme-btn").forEach(function (b) {
          b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-id") === id));
        });
        mark(); renderPreview();
      });
      bar.appendChild(btn);
    });
    return bar;
  }
  var TEXT_SYNTAX_DOC =
    "用文字生成语法（每行一条）：\n" +
    "  A -> B -> C      建节点并依次连线（同名标签复用同一节点）\n" +
    "  A -> B : 是      给最后一条连线加标签（判断的「是/否」贴在线上）\n" +
    "  ## 阶段名        开始一个阶段分组，之后的节点归入该组\n" +
    "  标签以 ? 或 ？结尾  生成菱形判断节点\n" +
    "  (开始) / (结束)  括号包裹生成胶囊形起止节点\n" +
    "可选：上方选择布局模式与主题；先「预览」再「提交」，提交为一次可撤销操作。\n" +
    "布局模式：layered 分层 / grid 网格 / manual 手动 / flow 流程（回边绕外）/ snake 蛇形 / " +
    "stages 阶段容器 / lanes 泳道 / tree 树形 / cycle 环形 / timeline 时间轴。";
  function textGenSection() {
    var sec = h("details", {class: "diagram-textgen"}, [h("summary", {text: "用文字生成流程图"})]);
    sec.appendChild(h("p", {class: "diagram-note", text: TEXT_SYNTAX_DOC}));
    var area = h("textarea", {id: "diagram-text-input", rows: "7", spellcheck: "false",
      placeholder: "(开始)\n## 识别\n文献调研 -> 数据采集 -> 数据预处理?\n数据预处理? -> 清洗 : 是\n数据预处理? -> 补采 : 否\n清洗 -> 建模\n建模 -> 清洗 : 迭代\n(结束)"});
    var modes = (global.FigDiagram && global.FigDiagram.LAYOUT_MODES) ||
      ["layered", "grid", "manual", "flow", "snake", "stages", "lanes", "tree", "cycle", "timeline"];
    var modeSel = h("select", {"aria-label": "文字生成布局模式"});
    modes.forEach(function (m) { modeSel.appendChild(h("option", {value: m, text: m})); });
    modeSel.value = "flow";
    var themeSel = h("select", {"aria-label": "文字生成主题"});
    themeSel.appendChild(h("option", {value: "", text: "（跟随上方主题）"}));
    themeList().forEach(function (t) {
      var id = t.id || t.theme_id; if (id) themeSel.appendChild(h("option", {value: id, text: t.name || id}));
    });
    var msg = h("div", {id: "diagram-text-msg", class: "diagram-note"});
    var parsedCache = null;
    function doParse() {
      var D = global.FigDiagram;
      var res = D.parseText(area.value, {
        layout: { mode: modeSel.value },
        theme: themeSel.value || undefined });
      parsedCache = res;
      if (!res.ok) {
        msg.textContent = "解析错误：" + res.errors.map(function (e) {
          return "第 " + e.line + " 行 " + e.message;
        }).join("；");
        return null;
      }
      msg.textContent = "解析成功：" + res.input.nodes.length + " 个节点、" +
        res.input.relations.length + " 条连线、" + (res.input.groups || []).length + " 个分组。";
      return res.input;
    }
    var previewBtn = h("button", {type: "button", text: "预览", onclick: function () {
      var input = doParse(); if (!input) return;
      try {
        var normalized = global.FigDiagram.normalize(input);
        var previewDoc = global.FigDoc.create({width_mm: 183, height_mm: 110, dpi: 300,
          background: "#FFFFFF", title: "文字生成预览（不写入当前工程）"});
        var built = global.FigDiagram.build(previewDoc, normalized);
        var mount = panel.querySelector("#diagram-live-preview");
        mount.textContent = "";
        var host = document.createElement("div");
        host.setAttribute("data-preview-owner", "isolated-figrender");
        host.innerHTML = global.FigRender.toSVG(built.doc);
        mount.appendChild(host);
        msg.textContent += " 预览已生成（隔离文档，未写入工程）。";
      } catch (err) { msg.textContent = "预览失败：" + err.message; }
    }});
    var commitBtn = h("button", {type: "button", class: "primary", text: "提交到画布", onclick: function () {
      var input = doParse(); if (!input) return;
      global.App.commit([{op: "apply_diagram_text", text: area.value,
        layout: { mode: modeSel.value }, theme: themeSel.value || null,
        id: "text-" + Date.now().toString(36)}],
        {label: "文字生成示意图", source: "user"})
        .then(function (done) {
          if (done && done.applied) notify("文字生成示意图已提交（可撤销）");
          else notify("文字生成提交未生效", true);
        })
        .catch(function (err) { notify("文字生成提交失败：" + err.message, true); });
    }});
    sec.appendChild(h("div", {class: "diagram-grid"}, [field("文字描述", area)]));
    sec.appendChild(h("div", {class: "diagram-grid"}, [field("布局模式", modeSel), field("主题", themeSel)]));
    sec.appendChild(h("div", {class: "diagram-toolbar"}, [previewBtn, commitBtn]));
    sec.appendChild(msg);
    return sec;
  }
  function buildUI() {
    if (!panel) return;
    panel.textContent = "";
    panel.appendChild(h("div", {class: "diagram-toolbar"}, [
      h("button", {type: "button", id: "diagram-preview", text: "真实矢量预览", onclick: renderPreview}),
      h("button", {type: "button", id: "diagram-commit", class: "primary", text: "提交到画布（可撤销）", onclick: function () { commit().catch(function () {}); }})]));
    panel.appendChild(h("div", {id: "diagram-validation", class: "diagram-note",
      text: dirty ? "有尚未预览/提交的修改" : "来源仅记录用户申报，不代表已核验。示例内容是合成的，不代表论文或官方案例。"}));
    var preview = h("div", {id: "diagram-live-preview", class: "diagram-live-preview", "aria-label": "真实矢量预览"});
    panel.appendChild(preview);
    var idInput = h("input", {value: spec.id});
    idInput.addEventListener("change", function () { spec.id = idInput.value; selectedDiagram = spec.id; mark(); });
    var auto = h("input", {type: "checkbox"});
    auto.checked = spec.layout.auto_layout;
    auto.addEventListener("change", function () { spec.layout.auto_layout = auto.checked; mark(); renderPreview(); });
    panel.appendChild(h("div", {class: "diagram-grid"}, [field("示意图编号", idInput),
      field("勾选后按内容自动重排（不勾选保留手动位置）", auto)]));
    panel.appendChild(themeBar());
    panel.appendChild(textGenSection());
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
        " 项；这不代表人工视觉验收通过。本预览是隔离文档的真实矢量渲染，尚未写入当前工程。");
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
      if (jsonDirty) throw new Error("上面的定义有未应用的手写修改；请先“用下面的 JSON 更新图”或“按上面的表单重新生成 JSON”，避免提交内容与所见不一致");
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
