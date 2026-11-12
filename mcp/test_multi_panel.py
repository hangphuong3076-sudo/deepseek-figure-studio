"""test_multi_panel.py — R06/A06：多子图协同（内核级）

四面板样例（合成数据）：两张表征线图（XPS 风格）+ 一张统计柱图 + 一张折线图。
验证：
1. 只更新一个子图的数据（set_chart_data 定向）：其余三个子图的数据、
   mapping、presentation、位置 transform 逐位不变；
2. unifySeriesColors：同一语义键（如 group|sample|s:S1）在各子图统一同色；
   色板不足时给出 warning（不静默合并不同组）；生成的 ops 全部可通过
   validateAll 且一次 commit 提交；
3. 指定子图的 presentation 修改（轴字号）不影响其他面板。
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
// 四面板：panel 容器 + 4 个 chart（表征 line ×2、bar、line_multi）
function mkFourPanel() {
  let doc = FigDoc.create({ title: 'four', width_mm: 183, height_mm: 140 });
  const panel = { id: 'panel-main', type: 'panel', name: '四面板', z: 0,
    transform: { x: 6, y: 6, w: 171, h: 128, rotation: 0 }, style: {},
    children: [], panelLayout: { cols: 2, rows: 2, gap_mm: 3, padding_mm: 2,
      label: null, labelPosition: 'top-left', labelStyle: { fontSizePt: 8 } }, clip: false };
  doc = FigOps.applyAll(doc, [{ op: 'add_element', element: panel }], { label: 'panel' }).doc;
  const cellW = 82, cellH = 61;
  function addChart(i, chartType, mapping, rows, columns) {
    const cx = i % 2, cy = Math.floor(i / 2);
    const el = FigData.makeChartElement({ columns, rows }, { chart_type: chartType, mapping });
    el.parent_id = 'panel-main';
    el.transform = { x: 8 + cx * (cellW + 3), y: 8 + cy * (cellH + 3),
      w: cellW, h: cellH, rotation: 0 };
    el.name = '(' + 'abcd'[i] + ')';
    doc = FigOps.applyAll(doc, [{ op: 'add_element', element: el }], { label: 'c' + i }).doc;
    return el.id;
  }
  const ids = [];
  ids.push(addChart(0, 'line', {x:'be',y:'int'}, [[290,50],[288,120],[286,300],[284,80]], ['be','int']));
  ids.push(addChart(1, 'line', {x:'raman',y:'int2'}, [[200,10],[400,60],[600,20]], ['raman','int2']));
  ids.push(addChart(2, 'bar', {x:'cond',y:'val'}, [['ctrl',1],['treat',2.5]], ['cond','val']));
  ids.push(addChart(3, 'line_multi', {x:'x',y:'y',group:'sample'},
    [[1,10,'S1'],[2,12,'S1'],[1,20,'S2'],[2,18,'S2']], ['x','y','sample']));
  const pel = doc.elements.find(e => e.id === 'panel-main');
  pel.children = ids.slice();
  return { doc, ids };
}
"""


class MultiPanelTests(unittest.TestCase):
    def test_update_one_panel_others_untouched(self):
        out = node_json(PRELUDE + r"""
const { doc, ids } = mkFourPanel();
const target = ids[3]; // (d) 折线多系列
const before = JSON.stringify(doc.elements.filter(e => e.id !== target && e.id !== 'panel-main'));
const replace = { op: 'set_chart_data', targets: [target], approved: true,
  data: { columns: ['x','y','sample'],
    rows: [[1,11,'S1'],[2,14,'S1'],[1,25,'S2'],[2,21,'S2'],[3,9,'S3']],
    source_ref: 'four-d.csv', version: 'v2' },
  source_ref: 'four-d.csv', version: 'v2' };
const v = FigOps.validateAll([replace], doc);
if (!v.ok) throw new Error('validate: ' + v.errors.join(';'));
const applied = FigOps.applyAll(doc, [replace], { label: 'update-d' });
const after = JSON.stringify(applied.doc.elements.filter(e => e.id !== target && e.id !== 'panel-main'));
const targetEl = applied.doc.elements.find(e => e.id === target);
console.log(JSON.stringify({
  othersIdentical: before === after,
  dRows: targetEl.chart.data.inline.rows.length,
  dHistory: applied.doc.history.length
}));
""")
        self.assertTrue(out["othersIdentical"], "只更新 (d) 时其余三个子图逐位不变")
        self.assertEqual(out["dRows"], 5)
        self.assertEqual(out["dHistory"], 6, "一次替换一条历史")

    def test_unify_series_colors(self):
        out = node_json(PRELUDE + r"""
const { doc, ids } = mkFourPanel();
const res = FigOps.unifySeriesColors(doc, {});
// ops 全部合法
const v = FigOps.validateAll(res.ops, doc);
const applied = FigOps.applyAll(doc, res.ops, { label: 'unify' });
const charts = ids.map(id => applied.doc.elements.find(e => e.id === id));
// (d) 面板 S1/S2 的覆盖色
const dPres = charts[3].chart.presentation.series;
const keyS1 = 'group|sample|s:S1', keyS2 = 'group|sample|s:S2';
// 每个子图均有覆盖且 S1 在所有出现处同色
const s1Colors = new Set();
charts.forEach(c => {
  const ident = FigData.seriesIdentity(c.chart);
  ident.forEach(s => {
    if (s.key === keyS1) s1Colors.add(c.chart.presentation.series[keyS1].stroke);
  });
});
// 渲染 SVG 中 (d) 的 S1/S2 与图例一致
const svgD = FigData.renderChartSVG(charts[3].chart, { width_mm: 82, height_mm: 61, dpi: 300 });
console.log(JSON.stringify({
  opsOk: v.ok, opsCount: res.ops.length,
  s1Unique: s1Colors.size === 1,
  keyS1: keyS1, colorS1: dPres && dPres[keyS1] && dPres[keyS1].stroke,
  hasKeyS2: !!(dPres && dPres[keyS2]),
  legendSameKey: svgD.includes('data-series-key="' + keyS1 + '"'),
  warnings: res.warnings
}));
""")
        self.assertTrue(out["opsOk"])
        self.assertEqual(out["opsCount"], 4)
        self.assertTrue(out["s1Unique"], "同一语义键跨子图唯一颜色")
        self.assertTrue(out["colorS1"])
        self.assertTrue(out["hasKeyS2"])
        self.assertTrue(out["legendSameKey"])

    def test_palette_exhaustion_warns(self):
        out = node_json(PRELUDE + r"""
// 12 个不同分组值 > 默认 10 色板
let doc = FigDoc.create({});
let rows = [], cols = ['x','y','g'];
for (let k = 0; k < 12; k++) { rows.push([k, k * 2, 'G' + k]); }
const el = FigData.makeChartElement({ columns: cols, rows },
  { chart_type: 'line_multi', mapping: { x: 'x', y: 'y', group: 'g' } });
doc = FigOps.applyAll(doc, [{ op: 'add_element', element: el }], { label: 'i' }).doc;
const res = FigOps.unifySeriesColors(doc, {});
console.log(JSON.stringify({ warned: res.warnings.length > 0, keys: res.keyOrder.length }));
""")
        self.assertTrue(out["warned"], "色板不足必须提示，不静默合并")
        self.assertEqual(out["keys"], 12)

    def test_presentation_edit_scoped_to_one_panel(self):
        out = node_json(PRELUDE + r"""
const { doc, ids } = mkFourPanel();
const before = JSON.stringify(doc.elements.filter(e => e.id !== ids[0]));
const op = { op: 'set_chart_properties', targets: [ids[0]], properties: {
  presentation: { version: 1, axes: { x: { title: { fontSizePt: 10 } } } } } };
const applied = FigOps.applyAll(doc, [op], { label: 'a-axis' });
const after = JSON.stringify(applied.doc.elements.filter(e => e.id !== ids[0]));
const a = applied.doc.elements.find(e => e.id === ids[0]);
console.log(JSON.stringify({ othersIdentical: before === after,
  aHasPres: !!(a.chart.presentation && a.chart.presentation.axes) }));
""")
        self.assertTrue(out["othersIdentical"])
        self.assertTrue(out["aHasPres"])


if __name__ == "__main__":
    unittest.main()
