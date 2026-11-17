# -*- coding: utf-8 -*-
"""test_dual_axis.py — R4-HB 双纵轴（mapping.ys 宽表 + axes.y2）单元测试。

覆盖：
  渲染：宽表/长表/颜色分组下的右轴刻度、左右各自 domain、图例「（右轴）」后缀、
        无 y2 时右侧无刻度、导出 SVG 含右轴元素；
  ops：axes.y2 合法/非法（未知系列名、全右轴、非支持图型、min>max、重复名）、
       null 移除、undo 恢复；
  presets：opts.mapping.ys + opts.axes.y2 创建路径与互斥校验。
"""
import json
import os
import subprocess
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
const WIDE = { columns: ['x', 'a', 'b', 'c'],
  rows: [[1, 10, 100, 5], [2, 20, 200, 15], [3, 15, 150, 10], [4, 30, 300, 20]] };
function wideChart(y2) {
  const el = FigData.makeChartElement(WIDE, {
    chart_type: 'line_multi',
    mapping: { x: 'x', y: 'a', ys: ['a', 'b', 'c'] }
  });
  if (y2 !== undefined) el.chart.axes.y2 = y2;
  return el.chart;
}
function svgOf(chart) {
  return FigData.renderChartSVG(chart, { width_mm: 120, height_mm: 90, dpi: 300 });
}
// 解析 SVG 中某 part 的文本内容与 y 坐标
function tickLabels(svg, part) {
  const out = [];
  const re2 = new RegExp('<text[^>]*data-chart-part="' + part + '"[^>]*>([^<]*)</text>', 'g');
  let m; while ((m = re2.exec(svg))) out.push(m[1]);
  return out;
}
function tickYs(svg, part) {
  const out = [];
  const re2 = new RegExp('<text[^>]*y="([\\d.]+)"[^>]*data-chart-part="' + part + '"', 'g');
  let m; while ((m = re2.exec(svg))) out.push(parseFloat(m[1]));
  return out;
}
function nums(labels) { return labels.map(function (s) { return parseFloat(s); }); }
"""


class DualAxisRenderTest(unittest.TestCase):
    """渲染层：右轴刻度/标签/域、图例后缀、无 y2 不画右刻度。"""

    def _wide_svg(self, y2="{series:['c'],label:'右轴C'}"):
        return node_json(PRELUDE + """
const chart = wideChart(%s);
const svg = svgOf(chart);
const y2l = tickLabels(svg, 'axis-tick-y2');
const yl = tickLabels(svg, 'axis-tick-y');
console.log(JSON.stringify({
  svg, y2l, yl,
  y2ys: tickYs(svg, 'axis-tick-y2'),
  legend: /（右轴）/.test(svg),
  y2title: /axis-title-y2/.test(svg)
}));
""" % y2)

    def test_right_ticks_labels_and_domains(self):
        out = self._wide_svg()
        y2n = [float(x) for x in out["y2l"]]
        yn = [float(x) for x in out["yl"]]
        self.assertTrue(y2n, "应有右轴刻度标签")
        self.assertTrue(yn, "应有左轴刻度标签")
        # 右域覆盖 c 列（5–20 + 4% padding → 约 4.4–20.6）
        self.assertLessEqual(max(y2n), 25, "右轴标签不应超出右域：%s" % y2n)
        self.assertGreaterEqual(min(y2n), 3, "右轴标签下界异常：%s" % y2n)
        # 左域覆盖 a/b（10–300）
        self.assertGreater(max(yn), 100, "左轴标签应覆盖大值域：%s" % yn)
        self.assertTrue(out["legend"], "图例应有「（右轴）」后缀")
        self.assertTrue(out["y2title"], "应有右轴标题元素")

    def test_right_series_uses_right_scale(self):
        """右系列点的像素位置按右域映射：c 列中值应落在绘图区中部，
        若误用左域（0–320）会贴近底部。"""
        out = node_json(PRELUDE + """
const chart = wideChart({series:['c'],label:'右轴C'});
const svg = svgOf(chart);
// c 系列标记点：data-series-key="series|c|s:c" 的 circle/polygon cy
const re = /<(circle|rect|polygon)[^>]*data-series-key="series\\|c\\|s:c"[^>]*>/g;
let m, pts = [];
while ((m = re.exec(svg))) {
  const tag = m[0];
  const cy = parseFloat((tag.match(/cy="([\\d.]+)"/) || [])[1] ||
    (tag.match(/y="([\\d.]+)"/) || [])[1] || 'NaN');
  const row = (tag.match(/data-row="(\\d+)"/) || [])[1];
  if (isFinite(cy) && row !== undefined) pts.push({cy: cy, row: parseInt(row)});
}
// 左轴刻度 y 范围 → 近似绘图区上下界
const yl = tickYs(svg, 'axis-tick-y');
const yTop = Math.min.apply(null, yl), yBot = Math.max.apply(null, yl);
// c 原始值：row0=5,row1=15,row2=10,row3=20 → row2(10) 应最靠下? 排序验证
// 右域 ~[4.4,20.6]：y=10 → 约 62% 处；y=20 → 顶；y=5 → 底
console.log(JSON.stringify({pts: pts, yTop: yTop, yBot: yBot,
  midCy: (yTop + yBot) / 2, botCy: yBot}));
""")
        pts = {p["row"]: p["cy"] for p in out["pts"]}
        self.assertEqual(len(pts), 4, "应取到 4 个右系列点：%s" % out)
        # y 值升序 → cy 降序（上方值小 cy）
        rows_by_y = sorted(pts.items(), key=lambda kv: [5, 15, 10, 20][kv[0]])
        cys = [cy for _, cy in rows_by_y]
        self.assertEqual(cys, sorted(cys, reverse=True),
                         "右系列点 cy 应随原始 y 递减：%s" % pts)
        # 右域中值 y=10 的点应明显高于底部（左域误用会贴底 ~98%）
        cy_mid = pts[2]  # row2 → c=10
        frac = (cy_mid - out["yTop"]) / max(1e-6, out["yBot"] - out["yTop"])
        self.assertLess(frac, 0.8,
                        "右系列中值点不应贴近底部（frac=%.2f，疑似用了左域）" % frac)

    def test_no_y2_no_right_ticks(self):
        out = node_json(PRELUDE + """
const chart = wideChart(undefined);
const svg = svgOf(chart);
console.log(JSON.stringify({
  y2count: (svg.match(/axis-tick-y2/g) || []).length,
  suffix: /（右轴）/.test(svg),
  title: /axis-title-y2/.test(svg)
}));
""")
        self.assertEqual(out["y2count"], 0, "无 y2 时不应有右轴刻度")
        self.assertFalse(out["suffix"], "无 y2 时图例不应有后缀")
        self.assertFalse(out["title"], "无 y2 时不应有右轴标题")

    def test_long_line_multi_and_scatter_color(self):
        out = node_json(PRELUDE + """
const longData = { columns: ['x', 'y', 'g'],
  rows: [[1, 10, 'A'], [2, 20, 'A'], [1, 100, 'B'], [2, 200, 'B']] };
const longChart = FigData.makeChartElement(longData, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'y', group: 'g' }
});
longChart.chart.axes.y2 = { series: ['B'], label: 'B轴' };
const lsvg = svgOf(longChart.chart);
const cdata = { columns: ['x', 'y', 'c'],
  rows: [[1, 10, 'P'], [2, 20, 'P'], [1, 100, 'Q'], [2, 200, 'Q']] };
const cChart = FigData.makeChartElement(cdata, {
  chart_type: 'scatter', mapping: { x: 'x', y: 'y', color: 'c' }
});
cChart.chart.axes.y2 = { series: ['Q'] };
const csvg = svgOf(cChart.chart);
console.log(JSON.stringify({
  longY2: (lsvg.match(/axis-tick-y2/g) || []).length,
  longSuffix: /B（右轴）/.test(lsvg),
  longTitle: /axis-title-y2/.test(lsvg),
  scY2: (csvg.match(/axis-tick-y2/g) || []).length,
  scSuffix: /Q（右轴）/.test(csvg)
}));
""")
        self.assertGreater(out["longY2"], 0, "长表 line_multi 应有右轴刻度")
        self.assertTrue(out["longSuffix"], "长表图例应有「B（右轴）」")
        self.assertTrue(out["longTitle"], "长表应有右轴标题")
        self.assertGreater(out["scY2"], 0, "颜色分组散点应有右轴刻度")
        self.assertTrue(out["scSuffix"], "散点图例应有「Q（右轴）」")

    def test_export_svg_contains_right_axis(self):
        """导出路径（renderChartSVG 即导出 SVG 源）含右轴刻度与标签。"""
        out = node_json(PRELUDE + """
const chart = wideChart({series:['c'],label:'右轴C',min:0,max:25});
const svg = svgOf(chart);
console.log(JSON.stringify({
  hasTicks: /axis-tick-y2/.test(svg),
  hasTitle: /axis-title-y2/.test(svg),
  minMax: /y2min/.test(svg) ? 'x' : 'y'
}));
""")
        self.assertTrue(out["hasTicks"])
        self.assertTrue(out["hasTitle"])


class DualAxisOpsTest(unittest.TestCase):
    """ops 层：axes.y2 校验、应用、移除、undo。"""

    def _doc_with_wide(self):
        return node_json(PRELUDE + r"""
let doc = FigDoc.create({ title: 'hb', width_mm: 120, height_mm: 90 });
const el = FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: ['a', 'b', 'c'] }
});
doc = FigOps.applyAll(doc, [{ op: 'add_element', element: el }], { label: 'init' }).doc;
console.log(JSON.stringify({ id: el.id, mapping: el.chart.mapping }));
""")

    def test_y2_valid_apply_undo_remove(self):
        docinfo = self._doc_with_wide()
        self.assertEqual(docinfo["mapping"]["ys"], ["a", "b", "c"])
        self.assertEqual(docinfo["mapping"]["y"], "a", "y 应兼容等于 ys[0]")
        cid = docinfo["id"]
        out = node_json(PRELUDE + """
let doc = FigDoc.create({ title: 'hb', width_mm: 120, height_mm: 90 });
const el = FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: ['a', 'b', 'c'] }
});
doc = FigOps.applyAll(doc, [{ op: 'add_element', element: el }], { label: 'init' }).doc;
const cid = el.id;
const ops = [
  { op: 'set_chart_properties', targets: [cid],
    properties: { axes: { y2: { series: ['c'], label: '右轴C' } } } },
  { op: 'set_chart_properties', targets: [cid],
    properties: { axes: { y2: null } } }
];
const v1 = FigOps.validateAll([ops[0]], doc);
const r1 = FigOps.applyAll(doc, [ops[0]], { label: 'y2' });
const after1 = r1.doc;
const stored = after1.elements[0].chart.axes.y2;
const back = FigOps.undo(after1);
const r2 = FigOps.applyAll(back.doc || back, [ops[1]], { label: 'rm' });
console.log(JSON.stringify({
  v1ok: v1.ok,
  stored: stored,
  undoY2: (back.doc || back).elements[0].chart.axes.y2 === undefined ||
          (back.doc || back).elements[0].chart.axes.y2 === null,
  removed: r2.doc.elements[0].chart.axes.y2 === null ||
           r2.doc.elements[0].chart.axes.y2 === undefined
}));
""")
        self.assertTrue(out["v1ok"], "合法 y2 应通过校验")
        self.assertEqual(out["stored"]["series"], ["c"])
        self.assertEqual(out["stored"]["label"], "右轴C")
        self.assertTrue(out["undoY2"], "undo 应移除 y2")
        self.assertTrue(out["removed"], "y2:null 应移除右轴")

    def test_y2_invalid_cases(self):
        out = node_json(PRELUDE + """
let doc = FigDoc.create({ title: 'hb', width_mm: 120, height_mm: 90 });
const el = FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: ['a', 'b', 'c'] }
});
doc = FigOps.applyAll(doc, [{ op: 'add_element', element: el }], { label: 'init' }).doc;
const cid = el.id;
function chk(y2) {
  const r = FigOps.validateAll([{ op: 'set_chart_properties', targets: [cid],
    properties: { axes: { y2: y2 } } }], doc);
  return { ok: r.ok, err: (r.errors || [])[0] || '' };
}
const res = {
  unknown: chk({ series: ['zzz'] }),
  allRight: chk({ series: ['a', 'b', 'c'] }),
  dup: chk({ series: ['c', 'c'] }),
  badMinMax: chk({ series: ['c'], min: 10, max: 5 }),
  emptySeries: chk({ series: [] }),
  nonString: chk({ series: [42] }),
  okPartial: chk({ series: ['b', 'c'], label: '右', min: 0, max: 400 }),
  okNull: chk(null)
};
// bar 图拒绝 y2
const bar = FigData.makeChartElement(WIDE, {
  chart_type: 'bar', mapping: { x: 'x', y: 'a' }
});
doc = FigOps.applyAll(doc, [{ op: 'add_element', element: bar }], { label: 'bar' }).doc;
res.bar = FigOps.validateAll([{ op: 'set_chart_properties', targets: [bar.id],
  properties: { axes: { y2: { series: ['a'] } } } }], doc);
// 长表 line_multi：分组值作系列名
const longData = { columns: ['x', 'y', 'g'],
  rows: [[1, 10, 'A'], [2, 20, 'A'], [1, 100, 'B'], [2, 200, 'B']] };
const le = FigData.makeChartElement(longData, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'y', group: 'g' }
});
doc = FigOps.applyAll(doc, [{ op: 'add_element', element: le }], { label: 'long' }).doc;
res.longOk = FigOps.validateAll([{ op: 'set_chart_properties', targets: [le.id],
  properties: { axes: { y2: { series: ['B'] } } } }], doc);
res.longBadName = FigOps.validateAll([{ op: 'set_chart_properties', targets: [le.id],
  properties: { axes: { y2: { series: ['A', 'B'] } } } }], doc);
console.log(JSON.stringify(res));
""")
        for k in ("unknown", "allRight", "dup", "badMinMax", "emptySeries",
                  "nonString", "bar", "longBadName"):
            self.assertFalse(out[k]["ok"], "%s 应校验失败：%s" % (k, out[k].get("err")))
        self.assertTrue(out["okPartial"]["ok"], "部分系列右轴应合法")
        self.assertTrue(out["okNull"]["ok"], "y2:null 应合法（移除）")
        self.assertTrue(out["longOk"]["ok"], "长表分组值作右轴名应合法")

    def test_make_chart_element_ys_validation(self):
        out = node_json(PRELUDE + """
function t(fn) { try { fn(); return 'ok'; } catch (e) { return e.message; } }
const res = {};
res.tooFew = t(() => FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: ['a'] } }));
res.dupCol = t(() => FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: ['a', 'a'] } }));
res.missingCol = t(() => FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: ['a', 'zzz'] } }));
res.groupConflict = t(() => FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: ['a', 'b'], group: 'x' } }));
res.scatterColorConflict = t(() => FigData.makeChartElement(WIDE, {
  chart_type: 'scatter', mapping: { x: 'x', y: 'a', ys: ['a', 'b'], color: 'c' } }));
res.barType = t(() => FigData.makeChartElement(WIDE, {
  chart_type: 'bar', mapping: { x: 'x', y: 'a', ys: ['a', 'b'] } }));
res.notArray = t(() => FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: 'a' } }));
res.okWide = t(() => FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: ['a', 'b'] } }));
res.scatterOk = t(() => FigData.makeChartElement(WIDE, {
  chart_type: 'scatter', mapping: { x: 'x', y: 'a', ys: ['a', 'b'] } }));
console.log(JSON.stringify(res));
""")
        for k in ("tooFew", "dupCol", "missingCol", "groupConflict",
                  "scatterColorConflict", "barType", "notArray"):
            self.assertNotEqual(out[k], "ok", "%s 应抛错" % k)
        self.assertEqual(out["okWide"], "ok")
        self.assertEqual(out["scatterOk"], "ok")

    def test_set_chart_data_ys_columns_checked(self):
        """set_chart_data 替换数据时 mapping.ys 各列必须仍存在。"""
        out = node_json(PRELUDE + r"""
let doc = FigDoc.create({ title: 'hb', width_mm: 120, height_mm: 90 });
const el = FigData.makeChartElement(WIDE, {
  chart_type: 'line_multi', mapping: { x: 'x', y: 'a', ys: ['a', 'b', 'c'] }
});
doc = FigOps.applyAll(doc, [{ op: 'add_element', element: el }], { label: 'init' }).doc;
const cid = el.id;
const bad = FigOps.validateAll([{ op: 'set_chart_data', targets: [cid], approved: true,
  source_ref: 's', version: 'v1',
  data: { columns: ['x', 'a', 'b'], rows: [[1, 1, 2]] } }], doc);
const good = FigOps.validateAll([{ op: 'set_chart_data', targets: [cid], approved: true,
  source_ref: 's', version: 'v1',
  data: { columns: ['x', 'a', 'b', 'c'], rows: [[1, 1, 2, 3]] } }], doc);
console.log(JSON.stringify({ badOk: bad.ok, badErr: (bad.errors || [])[0] || '',
  goodOk: good.ok }));
""")
        self.assertFalse(out["badOk"], "缺列应拒绝：%s" % out["badErr"])
        self.assertIn("mapping.ys", out["badErr"])
        self.assertTrue(out["goodOk"], "列齐全应通过")


class DualAxisPresetTest(unittest.TestCase):
    """presets：opts.mapping.ys + opts.axes.y2 创建路径。"""

    def _tpl_id(self, chart_type):
        out = node_json(PRELUDE + """
const hit = FigPresets.templates().find(t => t.chart_type === '%s');
console.log(JSON.stringify(hit ? hit.id : null));
""" % chart_type)
        self.assertIsNotNone(out, "找不到 %s 模板" % chart_type)
        return out

    def test_template_from_stats_wide_and_y2(self):
        tid = self._tpl_id("line_multi")
        out = node_json(PRELUDE + """
const r = FigPresets.templateFromStats('%s', WIDE, {
  mapping: { x: 'x', ys: ['a', 'b', 'c'] },
  axes: { y2: { series: ['c'], label: '右轴C' } }
});
const ch = r.chart || (r.elements && r.elements[0] && r.elements[0].chart);
console.log(JSON.stringify({
  ys: ch && ch.mapping && ch.mapping.ys,
  y: ch && ch.mapping && ch.mapping.y,
  group: ch && ch.mapping && ch.mapping.group,
  y2: ch && ch.axes && ch.axes.y2
}));
""" % tid)
        self.assertEqual(out["ys"], ["a", "b", "c"])
        self.assertEqual(out["y"], "a", "y 应兼容等于 ys[0]")
        self.assertIsNone(out["group"], "宽表不应残留 group")
        self.assertEqual(out["y2"]["series"], ["c"])
        self.assertEqual(out["y2"]["label"], "右轴C")

    def test_template_from_stats_ys_conflicts(self):
        tid_lm = self._tpl_id("line_multi")
        tid_bar = self._tpl_id("bar")
        out = node_json(PRELUDE + """
function t(fn) { try { fn(); return 'ok'; } catch (e) { return e.message; } }
const res = {};
res.groupConflict = t(() => FigPresets.templateFromStats('%s', WIDE, {
  mapping: { x: 'x', group: 'c', ys: ['a', 'b'] } }));
res.barType = t(() => FigPresets.templateFromStats('%s', WIDE, {
  mapping: { x: 'x', ys: ['a', 'b'] } }));
res.badCol = t(() => FigPresets.templateFromStats('%s', WIDE, {
  mapping: { x: 'x', ys: ['a', 'zzz'] } }));
res.oneCol = t(() => FigPresets.templateFromStats('%s', WIDE, {
  mapping: { x: 'x', ys: ['a'] } }));
res.y2BadSeries = t(() => FigPresets.templateFromStats('%s', WIDE, {
  mapping: { x: 'x', ys: ['a', 'b', 'c'] },
  axes: { y2: { series: ['zzz'] } } }));
res.y2AllRight = t(() => FigPresets.templateFromStats('%s', WIDE, {
  mapping: { x: 'x', ys: ['a', 'b'] },
  axes: { y2: { series: ['a', 'b'] } } }));
console.log(JSON.stringify(res));
""" % (tid_lm, tid_bar, tid_lm, tid_lm, tid_lm, tid_lm))
        for k in ("groupConflict", "barType", "badCol", "oneCol",
                  "y2BadSeries", "y2AllRight"):
            self.assertNotEqual(out[k], "ok", "%s 应抛错：%s" % (k, out[k]))


class DualAxisTitlesTest(unittest.TestCase):
    """R4-HB2：宽表默认轴标题——左/右系列名「 / 」连接，显式值优先。"""

    def test_default_titles_join_series_names(self):
        """ys=[a,b,c]、c 在右轴：左标题「a / b」，右标题「c」；
        建图不再把 yLabel=ys[0] 烘焙进 axes。"""
        out = node_json(PRELUDE + """
const chart = wideChart({series:['c'], label:null});
const baked = chart.axes.yLabel;
const svg = svgOf(chart);
const desc = FigData.describeChartStyle(chart);
console.log(JSON.stringify({
  baked: baked,
  lt: tickLabels(svg, 'axis-title-y'),
  rt: tickLabels(svg, 'axis-title-y2'),
  descY: desc.labels && desc.labels.y,
  descY2: desc.y2 && desc.y2.label
}));
""")
        self.assertEqual(out["baked"], "",
                         "宽表建图不应烘焙 yLabel=ys[0]：%r" % out["baked"])
        self.assertIn("a / b", out["lt"],
                      "左轴默认标题应为左系列名连接：%s" % out["lt"])
        self.assertIn("c", out["rt"],
                      "右轴默认标题应为右系列名：%s" % out["rt"])
        self.assertEqual(out["descY"], "a / b",
                         "describeChartStyle 应报告有效左标题")
        self.assertEqual(out["descY2"], "c",
                         "describeChartStyle 应报告有效右标题")

    def test_explicit_labels_win(self):
        """显式 yLabel / y2.label 优先于系列名拼接。"""
        out = node_json(PRELUDE + """
const chart = wideChart({series:['c'], label:'右轴C'});
chart.axes.yLabel = '我的左轴';
const svg = svgOf(chart);
const desc = FigData.describeChartStyle(chart);
console.log(JSON.stringify({
  lt: tickLabels(svg, 'axis-title-y'),
  rt: tickLabels(svg, 'axis-title-y2'),
  descY: desc.labels && desc.labels.y,
  descY2: desc.y2 && desc.y2.label
}));
""")
        self.assertIn("我的左轴", out["lt"], "显式 yLabel 应生效：%s" % out["lt"])
        self.assertNotIn("a / b", " ".join(out["lt"]))
        self.assertIn("右轴C", out["rt"], "显式 y2.label 应生效：%s" % out["rt"])
        self.assertEqual(out["descY"], "我的左轴")
        self.assertEqual(out["descY2"], "右轴C")

    def test_all_left_no_right_title_default(self):
        """无右轴系列时 y2 不存在：左标题仍为全部系列名连接。"""
        out = node_json(PRELUDE + """
const chart = wideChart(undefined);
const svg = svgOf(chart);
console.log(JSON.stringify({
  lt: tickLabels(svg, 'axis-title-y'),
  rt: tickLabels(svg, 'axis-title-y2'),
  y2count: (svg.match(/axis-tick-y2/g) || []).length
}));
""")
        self.assertIn("a / b / c", " ".join(out["lt"]),
                      "全左轴时左标题应含全部系列名：%s" % out["lt"])
        self.assertEqual(out["rt"], [], "无右轴不应有右标题")
        self.assertEqual(out["y2count"], 0)

    def test_template_from_stats_no_baked_y_label(self):
        """templateFromStats 宽表路径同样不烘焙 yLabel。"""
        tid = node_json(PRELUDE + """
const hit = FigPresets.templates().find(t => t.chart_type === 'line_multi');
console.log(JSON.stringify(hit.id));
""")
        out = node_json(PRELUDE + """
const r = FigPresets.templateFromStats(%s, WIDE, {
  mapping: { x: 'x', ys: ['a', 'b', 'c'] },
  axes: { y2: { series: ['c'] } }
});
const ch = r.chart || (r.elements && r.elements[0] && r.elements[0].chart);
const svg = FigData.renderChartSVG(ch, { width_mm: 120, height_mm: 90, dpi: 300 });
console.log(JSON.stringify({
  yLabel: ch.axes.yLabel || null,
  lt: tickLabels(svg, 'axis-title-y'),
  rt: tickLabels(svg, 'axis-title-y2')
}));
""" % json.dumps(tid))
        self.assertIsNone(out["yLabel"],
                          "templateFromStats 不应写 yLabel：%r" % out["yLabel"])
        self.assertIn("a / b", " ".join(out["lt"]))
        self.assertIn("c", " ".join(out["rt"]))


if __name__ == "__main__":
    unittest.main()
