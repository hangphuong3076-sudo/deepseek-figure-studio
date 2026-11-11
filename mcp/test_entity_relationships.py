# -*- coding: utf-8 -*-
"""Dedicated synthetic schematic/data tests; no current project, network or official cases."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

MCP_DIR = Path(__file__).resolve().parent
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))


def node(script, timeout=60):
    proc = subprocess.run(["node", "-e", script], cwd=MCP_DIR, timeout=timeout,
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode:
        raise AssertionError(proc.stdout + "\n" + proc.stderr)
    lines = proc.stdout.strip().splitlines()
    return json.loads(lines[-1]) if lines else None


DOM_HARNESS = r"""
const assert = require('assert'), fs = require('fs'), vm = require('vm');
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this.parentNode = null; this.value = ''; this.checked = false; this._text = ''; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c),1); }
  get firstChild() { return this.children[0] || null; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  setAttribute(k,v) { this.attributes[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'id') this.id = String(v); }
  addEventListener(k,f) { (this.listeners[k] || (this.listeners[k] = [])).push(f); }
  click() { (this.listeners.click || []).forEach(f => f.call(this,{})); }
  querySelector(selector) {
    if (selector === 'svg' && this._svg) return this._svg;
    const wantedId = selector.startsWith('#') ? selector.slice(1) : null;
    const wantedClass = selector.startsWith('.') ? selector.slice(1) : null;
    const tag = !wantedId && !wantedClass ? selector.toUpperCase() : null;
    let found = null;
    const visit = n => {
      if (found) return;
      if (wantedId && n.id === wantedId) { found = n; return; }
      if (wantedClass && n.attributes.class && n.attributes.class.split(/\s+/).includes(wantedClass)) { found = n; return; }
      if (tag && n.tagName === tag) { found = n; return; }
      n.children.forEach(visit);
    };
    visit(this); return found;
  }
  querySelectorAll(selector) {
    const tags = selector.split(',').map(s => s.trim().toUpperCase());
    const out = [];
    const visit = n => { if (tags.includes(n.tagName)) out.push(n); n.children.forEach(visit); };
    visit(this); return out;
  }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; else { this._svg = new Element('svg'); this.children = [this._svg]; } }
  get innerHTML() { return this._html || ''; }
}
const document = {createElement: tag => new Element(tag), createTextNode: text => { const e = new Element('#text'); e.textContent = text; return e; }};
const sandbox = {console, document, setTimeout, clearTimeout};
vm.createContext(sandbox);
for (const name of ['figdoc','diagram','ops','render']) vm.runInContext(fs.readFileSync('lib/' + name + '.js','utf8'), sandbox);
const App = sandbox.App = {doc: sandbox.FigDoc.create(), commits: [], selections: [], messages: [],
  commit(ops, meta) { this.commits.push({ops,meta}); const result = sandbox.FigOps.applyAll(this.doc, ops, meta); this.doc = result.doc; return Promise.resolve(result); },
  select(ids) { this.selections.push(ids); }, status(v) { this.messages.push(v); }, error(v) { throw new Error(v); }};
vm.runInContext(fs.readFileSync('viewer_static/app/diagram-panel.js','utf8'), sandbox);
"""


class SchematicKernelTests(unittest.TestCase):
    def test_schema_relations_native_groups_sources_determinism_and_replay(self):
        script = r"""
const assert = require('assert'), fs = require('fs');
for (const name of ['figdoc','diagram','ops','render']) require('./lib/' + name + '.js');
assert.strictEqual(FigDiagram.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
const input = {
  id: 'synthetic-relationships', template_id: 'flow',
  nodes: [
    {id: 'container', label: '容器（合成）', role: 'method', shape: 'cell'},
    {id: 'child', label: '实体乙（合成）', role: 'evidence', shape: 'molecule'},
    {id: 'result', label: '输出（合成）', role: 'conclusion', shape: 'outcome'}
  ],
  relations: [
    {id: 'contains', from: 'container', to: 'child', kind: 'include'},
    {id: 'activation', sourceId: 'child', targetId: 'result', kind: 'activate', label: '合成因果', bend: 2},
    {id: 'parallel', source: 'container', target: 'result', kind: 'associate', direction: 'none'}
  ],
  sources: [{id: 'provided', locator: '用户提供的合成记录 #L1-L4', sha256: FigDiagram.sha256('provided-text'), version: 'v1'}],
  uncertainties: ['不对应任何论文或实验结论。']
};
input.nodes[0].evidence = [{sourceId: 'provided', note: '用户说明', uncertainties: ['用户尚未复核'] }];
for (const bad of [
  s => {s.relations[1].direction = 'none';},
  s => {s.relations[2].direction = 'forward';},
  s => {s.relations[1].source = 'not-declared';},
  s => {s.nodes[0].unexpected = true;},
  s => {s.sources[0].locator = '<script>alert(1)</script>';}
]) {
  const invalid = JSON.parse(JSON.stringify(input)); bad(invalid);
  assert.strictEqual(FigDiagram.validate(invalid).ok, false);
}
const base = FigDoc.create({title: 'synthetic', width_mm: 120, height_mm: 90});
let first = FigOps.applyAll(base, [{op: 'apply_schematic', contract: input}], {ts: '2026-01-02T03:04:05.000Z'}).doc;
assert.strictEqual(first.meta.diagrams['synthetic-relationships'].generated_at, '2026-01-02T03:04:05.000Z');
assert.strictEqual(first.meta.diagrams['synthetic-relationships'].source_verification, 'user_provided_unverified');
const originalInput = JSON.parse(JSON.stringify(input));
assert.strictEqual(FigRender.toSVG(first), FigRender.toSVG(first));
assert(FigDoc.validate(first).ok, FigDoc.validate(first).errors.join(';'));
const included = first.elements.find(el => el.diagramNodeId === 'child');
assert.strictEqual(included.parent_id, 'container');
const childNativeText = first.elements.find(el => el.id === 'child.label');
assert.strictEqual(childNativeText.type, 'text');
const connector = first.elements.find(el => el.type === 'connector' && el.relation.kind === 'activate');
const geometryBefore = FigDiagram.connectorGeometry(first, connector);
const svgBefore = FigRender.toSVG(first);
const moved = FigOps.applyAll(first, [{op: 'move', targets: ['child'], dx: 7, dy: 4}], {ts: '2026-01-02T03:04:06.000Z'}).doc;
const geometryAfter = FigDiagram.connectorGeometry(moved, moved.elements.find(el => el.id === connector.id));
assert.notDeepStrictEqual(geometryBefore.end, geometryAfter.end);
const svgAfter = FigRender.toSVG(moved);
assert.notStrictEqual(svgBefore, svgAfter);
const updatedInput = JSON.parse(JSON.stringify(input));
updatedInput.nodes[2].label = '输出（已确认的合成文本修订）';
const rebuilt = FigOps.applyAll(moved, [{op: 'apply_schematic', contract: updatedInput}], {ts: '2026-01-02T03:04:07.000Z'}).doc;
const rebuiltNode = rebuilt.elements.find(el => el.diagramNodeId === 'child');
assert.strictEqual(rebuiltNode.diagram_manual_layout, true);
const replayed = FigOps.revertTo(JSON.parse(JSON.stringify(rebuilt)), 3);
assert.strictEqual(FigRender.toSVG(replayed), FigRender.toSVG(rebuilt));
assert.deepStrictEqual(replayed.elements.map(el => el.id), rebuilt.elements.map(el => el.id));
const secondFull = FigOps.applyAll(base, [{op: 'apply_schematic', contract: input}], {ts: '2027-09-08T07:06:05.000Z'}).doc;
assert.strictEqual(FigRender.toSVG(secondFull), svgBefore);
assert.strictEqual(FigRender.toSVG(FigOps.applyAll(first, [{op: 'apply_schematic', contract: input}], {ts: '2028-01-01T00:00:00.000Z'}).doc), svgBefore);
assert.deepStrictEqual(input, originalInput);
const example = FigDiagram.example('tpl-graphical-abstract', true);
assert.strictEqual(FigDiagram.validate(example).ok, true);
assert(FigDiagram.supportsTemplate({id: 'tpl-graphical-abstract', category: 'diagram'}).supported);
assert.strictEqual(FigDiagram.supportsTemplate({id: 'tpl-diagram-decision', category: 'diagram'}).supported, false);
assert(FigDiagram.previewSVG(example).includes('data-fig-id='));
console.log(JSON.stringify({ok: true, connector: connector.type, deterministic: true, replay: true}));
"""
        self.assertTrue(node(script)["ok"])

    def test_approved_chart_data_preserves_mapping_style_and_originals(self):
        script = r"""
const assert = require('assert');
for (const name of ['figdoc','diagram','ops']) require('./lib/' + name + '.js');
const base = FigDoc.create();
const element = {
  id: 'synthetic-chart', type: 'chart', transform: {x: 0, y: 0, w: 100, h: 60},
  style: {fill: '#ABCDEF'}, chart: {chartType: 'bar',
    data: {inline: {columns: ['group','value'], rows: [['A',1]]}, ref: 'synthetic-v1', source_ref: 'synthetic-v1', version: 'v1'},
    mapping: {x: 'group', y: 'value'}, axes: {xLabel: '条件', yLabel: '响应'}, paletteId: 'npg',
    statistics: {test: 'not-computed-here', unit_x: '', unit_y: ''}
  }
};
let doc = FigOps.applyAll(base, [{op: 'add_element', element}], {ts: '2026-01-01T00:00:00.000Z'}).doc;
const next = {columns: ['group','value'], rows: [['A',3],['B',5]], source_ref: 'synthetic-table-v2', version: 'v2'};
const denied = FigOps.validate({op: 'set_chart_data', targets: [element.id], data: next, approved: false}, doc);
assert.strictEqual(denied.ok, false);
const frozenBefore = JSON.stringify(doc);
assert.throws(() => FigOps.applyAll(doc, [{op: 'set_chart_data', targets: [element.id], data: next}], {}));
assert.strictEqual(JSON.stringify(doc), frozenBefore);
const changed = FigOps.applyAll(doc, [{op: 'set_chart_data', targets: [element.id], data: next, approved: true}], {ts: '2026-01-02T00:00:00.000Z'});
assert.strictEqual(changed.applied, 1);
const chart = changed.doc.elements[0].chart;
assert.deepStrictEqual(chart.data.inline, {columns: next.columns, rows: next.rows});
assert.strictEqual(chart.data.source_ref, 'synthetic-table-v2');
assert.strictEqual(chart.data.version, 'v2');
assert.deepStrictEqual(chart.mapping, element.chart.mapping);
assert.strictEqual(changed.doc.elements[0].style.fill, '#ABCDEF');
assert.deepStrictEqual(chart.statistics, element.chart.statistics);
assert.strictEqual(chart.statistics_review.status, 'required');
assert(chart.statistics_review.missing.includes('样本量 n'));
assert(chart.statistics_review.missing.includes('坐标单位'));
assert.strictEqual(chart.data_history[0].data.inline.rows[0][1], 1);
assert.strictEqual(chart.data_history.length, 1);
assert.strictEqual(chart.data.row_mapping.length, 2);
const undone = FigOps.revertTo(JSON.parse(JSON.stringify(changed.doc)), 1);
assert.strictEqual(undone.elements[0].chart.data.inline.rows[0][1], 1);
assert.strictEqual(undone.elements[0].chart.data.source_ref, 'synthetic-v1');
const redone = FigOps.revertTo(undone, 2);
assert.strictEqual(redone.elements[0].chart.data.inline.rows[0][1], 3);
assert.strictEqual(redone.elements[0].chart.data_history[0].data.inline.rows[0][1], 1);
console.log(JSON.stringify({ok: true, approvedOnly: true, originalImmutable: true}));
"""
        self.assertTrue(node(script)["ok"])

    def test_chart_data_explicit_version_change_is_not_discarded(self):
        script = r"""
const assert = require('assert');
for (const file of ['figdoc','diagram','ops']) require('./lib/' + file + '.js');
let doc = FigDoc.create();
doc = FigOps.applyAll(doc,[{op:'add_element',element:{
  id:'versioned-chart',type:'chart',transform:{x:0,y:0,w:80,h:40},style:{fill:'#123456'},
  chart:{chartType:'bar',data:{inline:{columns:['x','y'],rows:[['A',2]]},source_ref:'synthetic',version:'v1'},mapping:{x:'x',y:'y'},statistics:{unit_x:'condition',unit_y:'response',n_definition:'one synthetic row'}}}
}],{ts:'2026-01-01T00:00:00.000Z'}).doc;
const before = JSON.parse(JSON.stringify(doc.elements[0].chart));
for (const version of ['v2','v3']) {
  doc = FigOps.applyAll(doc,[{op:'set_chart_data',targets:['versioned-chart'],approved:true,
    data:{columns:['x','y'],rows:[['A',2]],source_ref:'synthetic',version:version}}],{ts:'2026-01-01T00:00:01.000Z'}).doc;
  assert.strictEqual(doc.elements[0].chart.data.version,version);
  assert.deepStrictEqual(doc.elements[0].chart.mapping,before.mapping);
  assert.deepStrictEqual(doc.elements[0].chart.statistics,before.statistics);
}
assert.strictEqual(doc.elements[0].chart.data_history.length,2);
assert.strictEqual(doc.elements[0].chart.data_history[0].data.version,'v1');
assert.strictEqual(doc.elements[0].chart.data_history[1].data.version,'v2');
assert(doc.elements[0].chart.data.row_mapping.every(row => row.source_row_index === null));
const frozen = JSON.stringify(doc);
const noop = FigOps.applyAll(doc,[{op:'set_chart_data',targets:['versioned-chart'],approved:true,
  data:{columns:['x','y'],rows:[['A',2]],source_ref:'synthetic',version:'v3'}}],{});
assert.strictEqual(noop.applied,0);
assert.strictEqual(JSON.stringify(doc),frozen);
console.log(JSON.stringify({ok:true,versionHistory:['v1','v2'],mappingLocked:true}));
"""
        self.assertTrue(node(script)["ok"])

    def test_iife_dom_preview_commit_without_visual_claim(self):
        script = DOM_HARNESS + r"""
const panel = new Element('div');
sandbox.DiagramPanel.mount(panel);
assert(panel.querySelector('#diagram-json'));
assert(panel.querySelector('#diagram-live-preview').querySelector('svg'));
const svg = sandbox.DiagramPanel.renderPreview();
assert(svg.includes('<svg'));
assert(svg.includes('<text'));
const spec = sandbox.FigDiagram.example('synthetic-dom', true);
sandbox.DiagramPanel.loadSpec(spec, 'synthetic-dom');
(async () => {
  const result = await sandbox.DiagramPanel.commit();
  assert.strictEqual(result.applied, 1);
  assert.strictEqual(App.commits.length, 1);
  assert.strictEqual(App.commits[0].ops[0].op, 'apply_schematic');
  assert(App.doc.elements.some(el => el.type === 'connector'));
  assert(App.doc.elements.some(el => el.type === 'text' && el.text.includes('输出')));
  assert(App.selections.length && App.selections[0][0].startsWith('diagram-'));
  assert.strictEqual(App.doc.meta.diagrams['synthetic-dom'].review_status, 'not_recorded');
  const connectorId = App.doc.elements.find(el => el.type === 'connector').id;
  App.selection = () => [connectorId];
  App.on = () => () => {};
  vm.runInContext(fs.readFileSync('viewer_static/app/props.js', 'utf8'), sandbox);
  const propsPanel = new Element('div');
  sandbox.Props.mount(propsPanel);
  const relationSelects = propsPanel.querySelectorAll('select').slice(-4);
  assert.strictEqual(relationSelects.length, 4);
  relationSelects[2].value = 'inhibit';
  relationSelects[2].listeners.change.forEach(fn => fn.call(relationSelects[2], {}));
  assert.strictEqual(App.doc.elements.find(el => el.id === connectorId).relation.kind, 'inhibit');
  assert.strictEqual(App.commits.length, 2);
  assert.strictEqual(App.commits[1].ops[0].op, 'apply_schematic');
  assert(App.doc.elements.some(el => el.type === 'text' && el.text.includes('输出')));
  assert(!Object.prototype.hasOwnProperty.call(App.doc.elements.find(el => el.id === connectorId), 'pathData'));
  assert(sandbox.FigRender.toSVG(App.doc).includes('data-relation-kind="inhibit"'));
  console.log(JSON.stringify({ok: true, domIIFE: true, commit: 'App.commit', visualAcceptance: false, propsRelation: 'sequence->inhibit'}));
})().catch(err => { console.error(err); process.exitCode = 1; });
"""
        result = node(script)
        self.assertTrue(result["ok"])
        self.assertFalse(result["visualAcceptance"])

    def test_dropdown_edits_stay_in_contract_preview_and_commit(self):
        script = DOM_HARNESS + r"""
App.error = v => App.messages.push(v);
const panel = new Element('div');
sandbox.DiagramPanel.mount(panel);
const selects = label => panel.querySelectorAll('select').filter(s => s.attributes['aria-label'] === label);
const fire = (el, value, evt) => { el.value = value; (el.listeners[evt || 'change'] || []).forEach(fn => fn.call(el, {})); };
const contract = () => sandbox.DiagramPanel.getContract();
const json = () => JSON.parse(panel.querySelector('#diagram-json').value);
fire(selects('通用形状声明')[0], 'chart');
assert.strictEqual(contract().nodes[0].shape, 'chart');
assert.strictEqual(contract().nodes[0].kind, 'chart');
assert(contract().nodes[0].data_slot);
assert.strictEqual(json().nodes[0].shape, 'chart');
assert.strictEqual(selects('节点 kind')[0].value, 'chart');
fire(selects('通用形状声明')[0], 'box');
assert.strictEqual(contract().nodes[0].kind, 'box');
assert(!contract().nodes[0].data_slot);
assert(!json().nodes[0].data_slot);
fire(selects('节点 kind')[2], 'chart');
assert.strictEqual(contract().nodes[2].shape, 'box');
assert(contract().nodes[2].data_slot);
fire(selects('科学关系类型')[0], 'inhibit');
assert.strictEqual(selects('节点 kind')[2].value, 'chart');
assert.strictEqual(contract().relations[0].kind, 'inhibit');
fire(selects('通用形状声明')[1], 'ellipse');
assert.strictEqual(contract().nodes[1].shape, 'ellipse');
const area = panel.querySelector('#diagram-json');
fire(area, '{"broken":', 'input');
fire(selects('通用形状声明')[3], 'cell');
assert.strictEqual(area.value, '{"broken":');
(async () => {
  await assert.rejects(sandbox.DiagramPanel.commit(), /未应用/);
  assert.strictEqual(App.commits.length, 0);
  const reload = panel.querySelectorAll('button').find(b => b.textContent === '从表单重载 JSON');
  reload.click();
  assert.strictEqual(json().nodes[3].shape, 'cell');
  const result = await sandbox.DiagramPanel.commit();
  assert.strictEqual(result.applied, 1);
  const sent = App.commits[0].ops[0].contract;
  assert.strictEqual(JSON.stringify(sent.nodes.map(n => [n.shape, n.kind, !!n.data_slot])),
    JSON.stringify([['box','box',false],['ellipse','ellipse',false],['box','chart',true],['cell','cell',false]]));
  assert.strictEqual(sent.relations[0].kind, 'inhibit');
  assert.strictEqual(JSON.stringify(sandbox.FigDiagram.chartSlots(App.doc).map(s => s.node_id)), '["evidence"]');
  console.log(JSON.stringify({ok: true}));
})().catch(err => { console.error(err); process.exitCode = 1; });
"""
        self.assertTrue(node(script)["ok"])


class EditOpModelOutputTests(unittest.TestCase):
    def test_invalid_model_ops_get_one_repair_then_honest_fallback(self):
        script = r"""
const assert = require('assert');
for (const name of ['figdoc','ops','ai']) require('./lib/' + name + '.js');
const doc = FigDoc.create();
doc.elements.push({id: 't1', type: 'text', text: 'A', transform: {x: 1, y: 1, w: 10, h: 5}, style: {fill: '#000000', fontSizePt: 7}});
FigAI.enabled = () => true;
const replies = [];
let calls = [];
FigAI.chat = async (messages) => { calls.push(messages); return {text: replies.shift()}; };
(async () => {
  replies.push('{"ops":[{"targets":["t1"],"color":"#D62728"}]}', '{"ops":[{"op":"set_color","targets":["t1"],"color":"#D62728"}],"explanation":"ok"}');
  let r = await FigAI.requestOps({doc, instruction: '改红色'});
  assert.strictEqual(r.mode, 'model');
  assert.strictEqual(r.repaired, true);
  assert.match(r.first_problem, /ops\[0\] 缺少字符串字段 op/);
  assert.strictEqual(calls.length, 2);
  assert.match(calls[1][calls[1].length - 1].content, /未通过 EditOp 校验/);
  calls = [];
  replies.push('not json', '{"ops":[{"targets":["t1"]}]}');
  r = await FigAI.requestOps({doc, instruction: '改红色'});
  assert.strictEqual(r.mode, 'fallback');
  assert.strictEqual(r.fallback_stage, 'validate');
  assert.match(r.fallback_reason, /自我修正一次后仍不合法/);
  assert.strictEqual(calls.length, 2);
  calls = [];
  FigAI.chat = async () => { calls.push(1); throw new Error('HTTP 502 bridge down'); };
  r = await FigAI.requestOps({doc, instruction: '改红色'});
  assert.strictEqual(r.mode, 'fallback');
  assert.strictEqual(r.fallback_stage, 'request');
  assert.match(r.fallback_reason, /502/);
  assert.strictEqual(calls.length, 1);
  console.log(JSON.stringify({ok: true}));
})().catch(err => { console.error(err); process.exitCode = 1; });
"""
        self.assertTrue(node(script)["ok"])


class RealMCPExportTests(unittest.TestCase):
    def test_real_mcp_svg_png_pdf_from_synthetic_document(self):
        import server

        sandbox = tempfile.TemporaryDirectory(prefix="figure-schematics-")
        self.addCleanup(sandbox.cleanup)
        root = Path(sandbox.name)
        base = server.bcall("doc.create", title="合成示意图（非论文）")
        contract = {
            "id": "synthetic-export", "template": "flow",
            "nodes": [
                {"id": "q", "label": "研究问题（合成）", "role": "question"},
                {"id": "m", "label": "方法（合成）", "role": "method", "shape": "process"},
            ],
            "relations": [{"id": "r", "source": "q", "target": "m", "kind": "sequence"}],
            "sources": [{"id": "provided", "locator": "仅用于离线导出的合成记录"}],
            "uncertainties": ["不是正式三例；无人工科学或视觉评分。"],
        }
        edited = server.tool_figure_apply_edits({"doc": base, "ops": [{"op": "apply_schematic", "contract": contract}]})
        self.assertTrue(edited["ok"], edited.get("error"))
        self.assertIn("apply_schematic", edited["doc"]["history"][-1]["ops"][0]["op"])
        rendered = server.tool_figure_render({"doc": edited["doc"], "format": "svg"})
        self.assertTrue(rendered["ok"])
        self.assertIn('data-fig-id="q.label"', rendered["svg"])
        self.assertIn('data-relation-kind="sequence"', rendered["svg"])
        outputs = {}
        for fmt in ("svg", "png", "pdf"):
            path = root / ("synthetic." + fmt)
            result = server.tool_figure_export({"doc": edited["doc"], "format": fmt,
                                                "out_path": str(path), "dpi": 144})
            outputs[fmt] = path
            self.assertTrue(path.is_file(), result)
            self.assertGreater(path.stat().st_size, 100)
        self.assertTrue(outputs["png"].read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertTrue(outputs["pdf"].read_bytes().startswith(b"%PDF-"))
        self.assertIn("研究问题（合成）", outputs["svg"].read_text(encoding="utf-8"))
        import fitz
        with fitz.open(outputs["pdf"]) as pdf:
            self.assertEqual(pdf.page_count, 1)
            text = "".join(page.get_text() for page in pdf)
        self.assertIn("研究问题（合成）", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
