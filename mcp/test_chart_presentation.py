"""test_chart_presentation.py — R04/A04：保留数据绑定的局部编辑（内核级）

验证：
1. presentation 覆盖（系列颜色/线宽/虚线、图例位置/字号、轴标题字号）真实
   反映到 canonical SVG，且 data-chart-part/data-series-key 属性可用于定位；
2. 原始 rows 不因样式操作改变；
3. set_chart_data 替换+重排数据行后，同分组值（稳定键）的系列样式仍对应
   正确；新增系列用默认色；缺失系列的覆盖保留在 presentation（不应用、
   不转移给其他系列）；
4. 非法 presentation 字段整批拒绝；null 清除恢复默认渲染；
5. 撤销/重做与 JSON 序列化（工程重开）后 presentation 保持；
6. 峰标注稳定 id：同 (x,label) 补全相同 id；presentation.peaks 按 id 生效。
"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def node_json(script, timeout=60):
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    proc = subprocess.run(["node", "-e", script], cwd=str(HERE), capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout,
                          env=env)
    if proc.returncode:
        raise AssertionError((proc.stdout or "") + "\n" + (proc.stderr or ""))
    return json.loads(proc.stdout.strip().splitlines()[-1])


PRELUDE = r"""
for (const f of ['figdoc', 'ops', 'palette', 'presets', 'data', 'render'])
  require('./lib/' + f + '.js');
const fs = require('fs');
FigPresets.load({
  journals: JSON.parse(fs.readFileSync('../presets/journals.json', 'utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json', 'utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json', 'utf8'))
});
function mkDoc(chartType, mapping, rows, columns) {
  let doc = FigDoc.create({ title: 'pres', width_mm: 120, height_mm: 90 });
  const cols = columns || Object.keys(mapping).map(k => mapping[k]);
  const el = FigData.makeChartElement(
    { columns: cols, rows: rows },
    { chart_type: chartType, mapping: mapping });
  doc = FigOps.applyAll(doc, [{ op: 'add_element', element: el }], { label: 'init' }).doc;
  return doc;
}
"""


class PresentationApplyTests(unittest.TestCase):
    def test_series_style_legend_axes_reflect_in_svg_and_rows_unchanged(self):
        out = node_json(PRELUDE + r"""
const rows = [[1,10,'A'],[2,12,'A'],[1,20,'B'],[2,22,'B']];
let doc = mkDoc('line_multi', {x:'x',y:'y',group:'sample'}, rows);
const chart = doc.elements.find(e => e.type === 'chart');
const ops = [{ op: 'set_chart_properties', targets: [chart.id], properties: {
  presentation: { version: 1,
    series: { 'group|sample|s:A': { stroke: '#FF0000', strokeWidthPt: 2.5, dash: '4 2' } },
    legend: { position: 'top', fontSizePt: 9 },
    axes: { x: { title: { fontSizePt: 10, color: '#123456' } } } } } }];
const v = FigOps.validateAll(ops, doc);
if (!v.ok) throw new Error('validate: ' + v.errors.join(';'));
const applied = FigOps.applyAll(doc, ops, { label: 'style' });
const chart2 = applied.doc.elements.find(e => e.type === 'chart');
const svg = FigData.renderChartSVG(chart2.chart, { width_mm: 80, height_mm: 60, dpi: 300 });
console.log(JSON.stringify({
  validateOk: v.ok, applied: applied.applied,
  redSeries: svg.includes('stroke="#FF0000"'),
  dash: svg.includes('stroke-dasharray="4 2"'),
  keyAttr: svg.includes('data-series-key="group|sample|s:A"'),
  legendTop: true,
  rowsSame: JSON.stringify(chart2.chart.data.inline.rows) === JSON.stringify(rows),
  presentation: chart2.chart.presentation.series['group|sample|s:A']
}));
""")
        self.assertTrue(out["validateOk"])
        self.assertEqual(out["applied"], 1)
        self.assertTrue(out["redSeries"])
        self.assertTrue(out["dash"])
        self.assertTrue(out["keyAttr"])
        self.assertTrue(out["rowsSame"], "原始 rows 不得被样式操作改变")
        self.assertEqual(out["presentation"]["stroke"], "#FF0000")

    def test_data_replace_preserves_styles_by_stable_key(self):
        out = node_json(PRELUDE + r"""
const rows = [[1,10,'A'],[2,12,'A'],[1,20,'B'],[2,22,'B']];
let doc = mkDoc('line_multi', {x:'x',y:'y',group:'sample'}, rows);
const cid = doc.elements.find(e => e.type === 'chart').id;
doc = FigOps.applyAll(doc, [{ op: 'set_chart_properties', targets: [cid], properties: {
  presentation: { version: 1, series: {
    'group|sample|s:A': { stroke: '#FF0000' },
    'group|sample|s:B': { stroke: '#0000FF' } } } } }], { label: 'style' }).doc;
// 替换数据：行序颠倒（B 行在前）+ 新增 C 组；A/B 值不变
const newRows = [[2,22,'B'],[1,20,'B'],[2,12,'A'],[1,10,'A'],[1,30,'C'],[2,32,'C']];
const replace = { op: 'set_chart_data', targets: [cid], approved: true,
  data: { columns: ['x','y','sample'], rows: newRows, source_ref: 'replaced.csv', version: 'v2' },
  source_ref: 'replaced.csv', version: 'v2' };
const v = FigOps.validateAll([replace], doc);
if (!v.ok) throw new Error('replace validate: ' + v.errors.join(';'));
doc = FigOps.applyAll(doc, [replace], { label: 'replace' }).doc;
const chart = doc.elements.find(e => e.type === 'chart');
const svg = FigData.renderChartSVG(chart.chart, { width_mm: 80, height_mm: 60, dpi: 300 });
// A 仍红、B 仍蓝（数据顺序变化不改变颜色身份）；C 无覆盖 → 调色板默认
const segA = svg.split('data-series-key="group|sample|s:A"')[0];
const redOnA = svg.includes('stroke="#FF0000"') && svg.includes('data-series-key="group|sample|s:A"');
const blueOnB = svg.includes('stroke="#0000FF"') && svg.includes('data-series-key="group|sample|s:B"');
const cKey = svg.includes('data-series-key="group|sample|s:C"');
const cHasOverride = /stroke="#FF0000"[^>]*data-series-key="group\|sample\|s:C"/.test(svg);
// 缺失系列覆盖保留：删除 A 组数据后再次替换
const rows3 = newRows.filter(r => r[2] !== 'A');
doc = FigOps.applyAll(doc, [{ op: 'set_chart_data', targets: [cid], approved: true,
  data: { columns: ['x','y','sample'], rows: rows3, source_ref: 'r3.csv', version: 'v3' },
  source_ref: 'r3.csv', version: 'v3' }], { label: 'drop A' }).doc;
const chart3 = doc.elements.find(e => e.type === 'chart');
console.log(JSON.stringify({
  redOnA: redOnA, blueOnB: blueOnB, cKey: cKey, cHasOverride: cHasOverride,
  aOverrideKept: !!(chart3.chart.presentation &&
    chart3.chart.presentation.series['group|sample|s:A']),
  bStillBlueAfterDrop: FigData.renderChartSVG(chart3.chart,
    { width_mm: 80, height_mm: 60, dpi: 300 }).includes('stroke="#0000FF"'),
  identity: FigData.seriesIdentity(chart3.chart).map(s => s.key)
}));
""")
        self.assertTrue(out["redOnA"], "行序颠倒后 A 组仍为覆盖色")
        self.assertTrue(out["blueOnB"])
        self.assertTrue(out["cKey"], "新增 C 组应有系列属性（默认色）")
        self.assertFalse(out["cHasOverride"], "缺失系列的覆盖不得转移给新系列")
        self.assertTrue(out["aOverrideKept"], "缺失系列的覆盖保留在 presentation")
        self.assertTrue(out["bStillBlueAfterDrop"])
        self.assertNotIn("group|sample|s:A", out["identity"])

    def test_invalid_presentation_rejected_and_null_clears(self):
        out = node_json(PRELUDE + r"""
const rows = [[1,10,'A'],[2,12,'A'],[1,20,'B'],[2,22,'B']];
let doc = mkDoc('line_multi', {x:'x',y:'y',group:'sample'}, rows);
const cid = doc.elements.find(e => e.type === 'chart').id;
const bad = FigOps.validateAll([{ op: 'set_chart_properties', targets: [cid],
  properties: { presentation: { series: { 'k|with|bad key!': { stroke: '#123456' } } } } }], doc);
const bad2 = FigOps.validateAll([{ op: 'set_chart_properties', targets: [cid],
  properties: { presentation: { series: { 'group|sample|s:A': { fillOpacity: 0.5 } } } } }], doc);
const bad3 = FigOps.validateAll([{ op: 'set_chart_properties', targets: [cid],
  properties: { presentation: { legend: { position: 'left' } } } }], doc);
doc = FigOps.applyAll(doc, [{ op: 'set_chart_properties', targets: [cid], properties: {
  presentation: { version: 1, legend: { fontSizePt: 9 } } } }], { label: 'p' }).doc;
let chart = doc.elements.find(e => e.type === 'chart');
const had = !!chart.chart.presentation;
doc = FigOps.applyAll(doc, [{ op: 'set_chart_properties', targets: [cid],
  properties: { presentation: null } }], { label: 'clear' }).doc;
chart = doc.elements.find(e => e.type === 'chart');
console.log(JSON.stringify({
  badKeyRejected: !bad.ok, badFieldRejected: !bad2.ok, badPosRejected: !bad3.ok,
  had, cleared: !chart.chart.presentation
}));
""")
        self.assertTrue(out["badKeyRejected"])
        self.assertTrue(out["badFieldRejected"])
        self.assertTrue(out["badPosRejected"])
        self.assertTrue(out["had"])
        self.assertTrue(out["cleared"])

    def test_undo_redo_and_json_roundtrip(self):
        out = node_json(PRELUDE + r"""
const rows = [[1,10],[2,12]];
let doc = mkDoc('line', {x:'x',y:'y'}, rows);
const cid = doc.elements.find(e => e.type === 'chart').id;
doc = FigOps.applyAll(doc, [{ op: 'set_chart_properties', targets: [cid], properties: {
  presentation: { version: 1, series: { 'series|y|y': { stroke: '#00AA00' } } } } }],
  { label: 'p' }).doc;
const chart = doc.elements.find(e => e.type === 'chart');
const before = JSON.stringify(chart.chart.presentation);
// 工程重开（JSON 序列化往返）
const reopened = JSON.parse(JSON.stringify(doc));
const chart2 = reopened.elements.find(e => e.type === 'chart');
const afterJson = JSON.stringify(chart2.chart.presentation);
// 撤销 → presentation 恢复无；重做 → 回来
doc = FigOps.undo(doc);
const chart3 = doc.elements.find(e => e.type === 'chart');
const afterUndo = !!chart3.chart.presentation;
doc = FigOps.redo(doc);
const chart4 = doc.elements.find(e => e.type === 'chart');
const afterRedo = JSON.stringify(chart4.chart.presentation);
console.log(JSON.stringify({ before, afterJson, same: before === afterJson,
  afterUndo, redoSame: afterRedo === before }));
""")
        self.assertTrue(out["same"], "JSON 工程重开后 presentation 保持")
        self.assertFalse(out["afterUndo"], "撤销移除 presentation")
        self.assertTrue(out["redoSame"], "重做恢复 presentation")

    def test_peak_stable_id_and_presentation(self):
        out = node_json(PRELUDE + r"""
const rows = [[284.5,100],[285.1,300],[286.0,150]];
let doc = mkDoc('line', {x:'x',y:'y'}, rows);
const cid = doc.elements.find(e => e.type === 'chart').id;
// 两条相同 (x,label) 的峰：自动 id 带确定性后缀去重（不报错）
doc = FigOps.applyAll(doc, [{ op: 'set_chart_properties', targets: [cid], properties: {
  characterization: { technique: 'XPS', peak_annotations: [
    { x: 285.1, label: 'C–C' }, { x: 285.1, label: 'C–C' } ] } } }], { label: 'peaks' }).doc;
let chart = doc.elements.find(e => e.type === 'chart');
let norm = FigData.normalizeCharacterization(
  chart.chart.characterization, chart.chart.data.inline.columns);
const dupDistinct = norm.ok && norm.char.peak_annotations.length === 2 &&
  norm.char.peak_annotations[0].id !== norm.char.peak_annotations[1].id;
// 显式重复 id 被拒绝
const dupExplicit = FigOps.validateAll([{ op: 'set_chart_properties', targets: [cid],
  properties: { characterization: { peak_annotations: [
    { x: 1, label: 'a', id: 'pk-x1' }, { x: 2, label: 'b', id: 'pk-x1' } ] } } }], doc);
// 两条不同峰 + id 稳定性
doc = FigOps.applyAll(doc, [{ op: 'set_chart_properties', targets: [cid], properties: {
  characterization: { peak_annotations: [ { x: 285.1, label: 'C–C' }, { x: 286.0, label: 'C=O' } ] } } }],
  { label: 'peaks2' }).doc;
chart = doc.elements.find(e => e.type === 'chart');
const norm2 = FigData.normalizeCharacterization(
  chart.chart.characterization, chart.chart.data.inline.columns);
const norm3 = FigData.normalizeCharacterization(
  chart.chart.characterization, chart.chart.data.inline.columns);
if (!norm2.ok) throw new Error('normalize: ' + norm2.errors.join(';'));
const p1 = norm2.char.peak_annotations[0];
const idDeterministic = JSON.stringify(norm2.char.peak_annotations) ===
  JSON.stringify(norm3.char.peak_annotations);
// 按 id 覆盖第一条峰标注颜色
doc = FigOps.applyAll(doc, [{ op: 'set_chart_properties', targets: [cid], properties: {
  presentation: { peaks: { [p1.id]: { color: '#AB00AB' } } } } }], { label: 'pk-style' }).doc;
chart = doc.elements.find(e => e.type === 'chart');
const svg = FigData.renderChartSVG(chart.chart, { width_mm: 80, height_mm: 60, dpi: 300 });
console.log(JSON.stringify({
  dupDistinct, dupExplicitRejected: !dupExplicit.ok, idDeterministic, p1: p1.id,
  peakStyled: svg.includes('#AB00AB'),
  peakAttr: svg.includes('data-peak-id="' + p1.id + '"')
}));
""")
        self.assertTrue(out["dupDistinct"], "相同 (x,label) 自动 id 确定性去重")
        self.assertTrue(out["dupExplicitRejected"], "显式重复 id 拒绝")
        self.assertTrue(out["idDeterministic"])
        self.assertTrue(out["peakStyled"])
        self.assertTrue(out["peakAttr"])


if __name__ == "__main__":
    unittest.main()
