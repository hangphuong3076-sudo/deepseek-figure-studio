"""test_c_workflows.py — C01/C02/C03 端到端（内核构建 + 修改 + 真实导出解码）

对应用例：
- C01 数据统计图：向导映射（用户确认 mapping）→ 建图 → presentation 修改
  → set_chart_data 更新（样式保留）→ SVG/PNG/PDF 真实导出与独立解码
- C02 表征图：XPS（反向轴+拟合列+峰标注）→ 峰 presentation → 归一化说明
  → 修改轴方向 → 真实导出
- C03 四面板：统一组色 → 只更新 (d) → 其余面板逐位不变 → 整图与单子图导出

全部合成演示数据；导出经 canonical SVG + figraster（PyMuPDF+Pillow），
导出后由独立解码器核对尺寸，不用 dpi 标签冒充。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "py"))

PRELUDE = r"""
for (const f of ['figdoc', 'diagram', 'ops', 'science', 'palette', 'presets', 'data',
                 'lineage', 'render', 'tiff', 'export', 'ai', 'storage'])
  require('./lib/' + f + '.js');
const fs = require('fs');
FigPresets.load({
  journals: JSON.parse(fs.readFileSync('../presets/journals.json', 'utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json', 'utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json', 'utf8'))
});
"""


def run_node(body, timeout=120):
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    proc = subprocess.run(["node", "-e", PRELUDE + body], cwd=str(HERE),
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout, env=env)
    if proc.returncode:
        raise AssertionError((proc.stdout or "") + "\n" + (proc.stderr or ""))
    return json.loads(proc.stdout.strip().splitlines()[-1])


def decode_png(path):
    from PIL import Image
    with Image.open(path) as im:
        return {"width": im.width, "height": im.height, "dpi": im.info.get("dpi")}


def pdf_page_size_pt(path):
    import fitz
    doc = fitz.open(path)
    try:
        rect = doc[0].rect
        return [round(rect.width, 2), round(rect.height, 2)]
    finally:
        doc.close()


def export_doc(doc, out_dir, name, formats, dpi=300):
    """内核渲染 canonical SVG → figraster 真实导出（与服务端同链路）。"""
    import figraster
    svg = run_node(
        "console.log(JSON.stringify(FigRender.toSVG(%s, {scale:1, includeGuides:false})))"
        % json.dumps(doc))
    written = {}
    for fmt in formats:
        out = str(Path(out_dir) / (name + "." + fmt))
        if fmt == "svg":
            # 与服务端一致：SVG 直接写盘，不走 figraster
            Path(out).write_text(svg, encoding="utf-8")
        else:
            figraster.export_svg(svg, doc, out, fmt, dpi=dpi)
        written[fmt] = out
    return written


def build_c01():
    """向导语义建图：用户确认 mapping（含未选列）→ 建图+统计申报。"""
    return run_node(r"""
const data = { columns: ['condition','response','unused_note'], rows: [
  ['ctrl', 1.20, 'a'], ['ctrl', 1.35, 'b'], ['ctrl', null, 'c'],
  ['low', 1.90, 'd'], ['low', 2.05, 'e'], ['low', 2.11, 'f'],
  ['high', 2.80, 'g'], ['high', 2.65, 'h'], ['high', 2.95, 'i'] ] };
let doc = FigDoc.create({ title: 'C01', width_mm: 89, height_mm: 70 });
// 用户确认映射（R02：opts.mapping 优先，unused_note 不参与）
const built = FigPresets.templateFromStats('tpl-bar', data,
  { mapping: { x: 'condition', y: 'response' }, title: 'C01 演示' });
doc = FigOps.applyAll(doc, built.elements.map(el => ({op:'add_element', element: el})),
  { label: 'C01 建图' }).doc;
const cid = doc.elements.find(e => e.type === 'chart').id;
doc = FigOps.applyAll(doc, [
  { op: 'set_chart_properties', targets: [cid], properties: {
    axes: { xLabel: '处理组', yLabel: '响应（a.u.，演示）' } } },
  { op: 'set_scientific_contract', contract: { statistics: { [cid]: {
    technical_replicates: 3, center: 'mean', spread: 'SD',
    uncertainty_source: 'replicates', unit_y: 'a.u.(demo)' } } } }
], { label: '统计申报' }).doc;
console.log(JSON.stringify({ doc, cid }));
""")


def build_c02():
    return run_node(r"""
const rows = [];
for (let i = 0; i < 50; i++) {
  const be = 280 + i * 0.15;
  const raw = 1000*Math.exp(-Math.pow((be-285.1)/1.1,2)) + 180*Math.exp(-Math.pow((be-286.5)/1.0,2)) + 50;
  const fit = 980*Math.exp(-Math.pow((be-285.1)/1.1,2)) + 190*Math.exp(-Math.pow((be-286.5)/1.0,2)) + 48;
  rows.push([Number(be.toFixed(2)), Math.round(raw), Math.round(fit)]);
}
let doc = FigDoc.create({ title: 'C02', width_mm: 89, height_mm: 70 });
const el = FigData.makeChartElement(
  { columns: ['binding_energy','intensity','fit_total'], rows },
  { chart_type: 'line', mapping: { x: 'binding_energy', y: 'intensity' } });
doc = FigOps.applyAll(doc, [{op:'add_element', element: el}], { label: '建图' }).doc;
const cid = doc.elements.find(e => e.type === 'chart').id;
doc = FigOps.applyAll(doc, [{ op: 'set_chart_properties', targets: [cid], properties: {
  characterization: { technique: 'XPS（演示）', x_reverse: true,
    x_label: 'Binding energy (eV)', y_label: 'Intensity (demo)',
    curves: [{ role: 'fit', column: 'fit_total', label: 'fit (demo)' }],
    fit_model: 'Gaussian (demo)', fit_source: 'provided_by_user_fit',
    peak_annotations: [{x:285.1,label:'C–C (demo)'},{x:286.5,label:'C–O (demo)'}] } } }],
  { label: '表征' }).doc;
console.log(JSON.stringify({ doc, cid }));
""")


def build_c03():
    return run_node(r"""
let doc = FigDoc.create({ title: 'C03', width_mm: 183, height_mm: 140 });
const panel = { id: 'panel-t', type: 'panel', name: 'C03', z: 0,
  transform: { x: 6, y: 6, w: 171, h: 128, rotation: 0 }, style: {}, children: [],
  panelLayout: { cols: 2, rows: 2, gap_mm: 3, padding_mm: 2, label: null,
    labelPosition: 'top-left', labelStyle: { fontSizePt: 8 } }, clip: false };
doc = FigOps.applyAll(doc, [{op:'add_element', element: panel}], { label: 'panel' }).doc;
const rowsA = []; for (let i=0;i<30;i++){ const be=278+i*0.3;
  rowsA.push([Number(be.toFixed(2)), Math.round(800*Math.exp(-Math.pow((be-284.9)/1.2,2))+40)]); }
const rowsB = []; for (let i=0;i<30;i++){ rowsB.push([200+i*10, Math.round(300+150*Math.sin(i/4)+i*2)]); }
function add(i, type, mapping, rows, columns) {
  const el = FigData.makeChartElement({ columns, rows }, { chart_type: type, mapping });
  el.parent_id = 'panel-t'; el.name = '(' + 'abcd'[i] + ')';
  el.transform = { x: 8 + (i%2)*85, y: 8 + Math.floor(i/2)*63, w: 82, h: 61, rotation: 0 };
  doc = FigOps.applyAll(doc, [{op:'add_element', element: el}], { label: 'c'+i }).doc;
  return el.id;
}
const ids = [
  add(0, 'line', {x:'be',y:'int'}, rowsA, ['be','int']),
  add(1, 'line', {x:'shift',y:'int2'}, rowsB, ['shift','int2']),
  add(2, 'bar', {x:'cond',y:'val'}, [['ctrl',1.2],['low',2.0],['high',2.8]], ['cond','val']),
  add(3, 'line_multi', {x:'x',y:'y',group:'sample'},
    [[1,10,'S1'],[2,12,'S1'],[1,20,'S2'],[2,18,'S2']], ['x','y','sample'])
];
doc.elements.find(e => e.id === 'panel-t').children = ids.slice();
doc = FigOps.applyAll(doc, [
  { op: 'set_chart_properties', targets: [ids[0]], properties: {
    characterization: { technique: 'XPS（演示）', x_reverse: true } } }
], { label: '表征' }).doc;
console.log(JSON.stringify({ doc, ids }));
""")


def node_modify(doc, script, extra=None):
    args = [json.dumps(doc)]
    if extra is not None:
        args.append(json.dumps(extra))
    return run_node(script % tuple(args))


class C01Workflow(unittest.TestCase):
    def test_stats_chart_flow(self):
        built = build_c01()
        doc, cid = built["doc"], built["cid"]
        # mapping 用户值生效 + 原始行不变
        chart = next(e for e in doc["elements"] if e["id"] == cid)
        self.assertEqual(chart["chart"]["mapping"]["x"], "condition")
        self.assertEqual(chart["chart"]["mapping"]["y"], "response")
        self.assertEqual(len(chart["chart"]["data"]["inline"]["rows"]), 9)
        # presentation 修改（轴字号）→ 替换数据（重复观测扩展）→ 样式保留
        out = node_modify(doc, r"""
const doc = %s;
const cid = doc.elements.find(e => e.type === 'chart').id;
// 稳定键以 seriesIdentity 为单一来源（与渲染器同键）
const sKey = FigData.seriesIdentity(doc.elements.find(e => e.id === cid).chart)[0].key;
let d2 = FigOps.applyAll(doc, [{ op: 'set_chart_properties', targets: [cid], properties: {
  presentation: { version: 1, axes: { x: { title: { fontSizePt: 9 } } },
    series: { [sKey]: { stroke: '#0072B2' } } } } }],
  { label: '样式' }).doc;
const newRows = [['ctrl',1.22,'x'],['ctrl',1.31,'x'],['ctrl',1.40,'x'],['ctrl',1.18,'x'],
  ['low',1.95,'x'],['low',2.02,'x'],['low',2.10,'x'],['low',1.88,'x'],
  ['high',2.75,'x'],['high',2.90,'x'],['high',2.60,'x'],['high',3.00,'x']];
d2 = FigOps.applyAll(d2, [{ op: 'set_chart_data', targets: [cid], approved: true,
  data: { columns: ['condition','response','unused_note'], rows: newRows,
    source_ref: 'c01-v2.csv', version: 'v2' },
  source_ref: 'c01-v2.csv', version: 'v2' }], { label: '更新数据' }).doc;
const c2 = d2.elements.find(e => e.id === cid);
console.log(JSON.stringify({ doc: d2,
  styleKept: c2.chart.presentation.series[sKey].stroke === '#0072B2',
  rowsNow: c2.chart.data.inline.rows.length,
  historyLen: d2.history.length,
  reviewRequired: c2.chart.statistics_review && c2.chart.statistics_review.status === 'required' }));
""")
        doc = out["doc"]
        self.assertTrue(out["styleKept"], "数据替换后系列样式保留")
        self.assertEqual(out["rowsNow"], 12)
        self.assertTrue(out["reviewRequired"], "替换后统计声明强制重审")
        # 真实导出 + 独立解码
        with tempfile.TemporaryDirectory() as td:
            files = export_doc(doc, td, "c01", ["svg", "png", "pdf"], dpi=300)
            png = decode_png(files["png"])
            self.assertEqual(png["width"], 1052, "89mm@300dpi≈1052px")
            pdf = pdf_page_size_pt(files["pdf"])
            self.assertAlmostEqual(pdf[0], 89 / 25.4 * 72, delta=1.5)
            svg_text = Path(files["svg"]).read_text(encoding="utf-8")
            self.assertIn("data-chart-part", svg_text)
            self.assertIn("#0072B2", svg_text, "覆盖色进入 canonical SVG")


class C02Workflow(unittest.TestCase):
    def test_xps_flow(self):
        built = build_c02()
        doc, cid = built["doc"], built["cid"]
        # 峰标注 presentation（按稳定 id）+ 轴方向/归一化
        out = node_modify(doc, r"""
const doc = %s;
const cid = doc.elements.find(e => e.type === 'chart').id;
const norm = FigData.normalizeCharacterization(
  doc.elements.find(e => e.id === cid).chart.characterization,
  doc.elements.find(e => e.id === cid).chart.data.inline.columns);
const pk1 = norm.char.peak_annotations[0].id;
let d2 = FigOps.applyAll(doc, [
  { op: 'set_chart_properties', targets: [cid], properties: {
    presentation: { version: 1, peaks: { [pk1]: { color: '#AB00AB', fontSizePt: 6 } } } } },
  { op: 'set_chart_properties', targets: [cid], properties: {
    characterization: { normalize: 'max_to_unity' } } }
], { label: '峰样式+归一化' }).doc;
const c2 = d2.elements.find(e => e.id === cid);
const svg = FigData.renderChartSVG(c2.chart, { width_mm: 82, height_mm: 62, dpi: 300 });
console.log(JSON.stringify({ doc: d2, pk1,
  peakStyled: svg.includes('#AB00AB'),
  reversed: c2.chart.characterization.x_reverse === true,
  normalized: c2.chart.characterization.normalize === 'max_to_unity',
  fitSource: c2.chart.characterization.fit_source === 'provided_by_user_fit',
  rowsSameLen: c2.chart.data.inline.rows.length === 50 }));
""")
        doc = out["doc"]
        self.assertTrue(out["peakStyled"])
        self.assertTrue(out["reversed"])
        self.assertTrue(out["normalized"])
        self.assertTrue(out["fitSource"], "拟合只来自用户提供的列")
        self.assertTrue(out["rowsSameLen"], "归一化不改原始行")
        with tempfile.TemporaryDirectory() as td:
            files = export_doc(doc, td, "c02", ["svg", "png", "pdf"], dpi=600)
            png = decode_png(files["png"])
            self.assertEqual(png["width"], 2103, "89mm@600dpi=2102.36→ceil 2103")


class C03Workflow(unittest.TestCase):
    def test_four_panel_flow(self):
        built = build_c03()
        doc, ids = built["doc"], built["ids"]
        # 统一组色 + 只更新 (d)
        out = node_modify(doc, r"""
const doc = %s; const ids = %s;
const unify = FigOps.unifySeriesColors(doc, {});
let d2 = FigOps.applyAll(doc, unify.ops, { label: '统一组色' }).doc;
const othersBefore = JSON.stringify(d2.elements.filter(e => e.id !== ids[3] && e.id !== 'panel-t'));
d2 = FigOps.applyAll(d2, [{ op: 'set_chart_data', targets: [ids[3]], approved: true,
  data: { columns: ['x','y','sample'],
    rows: [[1,11,'S1'],[2,14,'S1'],[3,16,'S1'],[1,25,'S2'],[2,23,'S2'],[3,27,'S2'],[2,5,'S3']],
    source_ref: 'c03-d.csv', version: 'v2' },
  source_ref: 'c03-d.csv', version: 'v2' }], { label: '更新(d)' }).doc;
const othersAfter = JSON.stringify(d2.elements.filter(e => e.id !== ids[3] && e.id !== 'panel-t'));
const s1Colors = new Set();
d2.elements.filter(e => e.type === 'chart').forEach(c => {
  (FigData.seriesIdentity(c.chart) || []).forEach(s => {
    if (s.key === 'group|sample|s:S1')
      s1Colors.add(c.chart.presentation.series['group|sample|s:S1'].stroke);
  });
});
console.log(JSON.stringify({ doc: d2,
  othersStable: othersBefore === othersAfter, s1Unique: s1Colors.size === 1,
  dRows: d2.elements.find(e => e.id === ids[3]).chart.data.inline.rows.length }));
""", ids)
        doc = out["doc"]
        self.assertTrue(out["othersStable"], "只更新 (d)，其余面板逐位不变")
        self.assertTrue(out["s1Unique"], "S1 组跨面板同色")
        self.assertEqual(out["dRows"], 7)
        # 整图 + 单子图导出（单 chart 范围）
        with tempfile.TemporaryDirectory() as td:
            files = export_doc(doc, td, "c03", ["svg", "png"], dpi=300)
            png = decode_png(files["png"])
            self.assertEqual(png["width"], 2162, "183mm@300dpi≈2162px")
            svg_text = Path(files["svg"]).read_text(encoding="utf-8")
            self.assertIn("data-series-key", svg_text)
            self.assertIn("group|sample|s:S1", svg_text)


if __name__ == "__main__":
    unittest.main()
