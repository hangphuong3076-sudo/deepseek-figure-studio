"""test_journal_rules.py — R07/A07：期刊规则证据与导出前检查（内核级）

验证：
1. rules 结构完整（官方 URL/核查日期/等级/依据），Nature/ACS Nano 标
   verified，Science 标 unverified_secondary（官方页 403，如实降级）；
2. checkJournalRules 状态机：
   - 未套预设且未指定 → 空结果 + 提示（不产生 pass）；
   - 宽度违反 required 规则 → fail，ok=false；
   - recommended 字号违反 → warning，ok 不受影响；
   - unverified_secondary 规则即使测量达标 → unknown（不产生 pass）；
   - 无位图素材的 raster_dpi → not_applicable；
   - 带像素尺寸的低 DPI 位图 → fail（有效 DPI=px/放置mm，不用 dpi 标签）；
   - 无像素尺寸的位图 → unknown + coverage partial；
   - 无任何可测字号对象 → unknown；图表字号经 describeChartStyle 实测；
3. 规则按 journal_ids 关联，未套用预设的其他期刊规则不混入。
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
function mkDoc(presetId, over) {
  let doc = FigDoc.create({ width_mm: 120, height_mm: 90 });
  if (presetId) {
    const r = FigPresets.applyCanvas(presetId, doc);
    doc = FigOps.applyAll(doc, [r.op], { label: 'journal' }).doc;
  }
  if (over && over.width_mm) doc.canvas.width_mm = over.width_mm;
  return doc;
}
"""


class RuleEvidenceTests(unittest.TestCase):
    def test_rules_structure_and_verification(self):
        out = node_json(PRELUDE + r"""
const all = FigPresets.journalRules();
const nature = all.filter(r => r.id.startsWith('nature-'));
const science = all.filter(r => r.id.startsWith('science-'));
const acs = all.filter(r => r.id.startsWith('acsnano-'));
const complete = all.every(r => r.id && r.property && r.level && r.appliesTo &&
  r.operator && r.sourceUrl && r.checkedAt && r.evidence && r.journal_ids.length);
console.log(JSON.stringify({
  total: all.length, complete,
  natureVerified: nature.length > 0 && nature.every(r => r.verification === 'verified'),
  scienceSecondary: science.length > 0 && science.every(r => r.verification === 'unverified_secondary'),
  acsVerified: acs.length > 0 && acs.every(r => r.verification === 'verified')
}));
""")
        self.assertEqual(out["total"], 19)
        self.assertTrue(out["complete"], "每条规则都要有 URL/日期/等级/依据")
        self.assertTrue(out["natureVerified"])
        self.assertTrue(out["scienceSecondary"], "Science 官方页不可达必须如实降级")
        self.assertTrue(out["acsVerified"])

    def test_status_machine(self):
        out = node_json(PRELUDE + r"""
// 1) 未套预设
const none = FigPresets.checkJournalRules(FigDoc.create({}));
// 2) Nature 单栏：宽度正确(89) 但高度超 247 → fail
const bad = mkDoc('nature-single', { width_mm: 89 });
bad.canvas.height_mm = 300;
const badRes = FigPresets.checkJournalRules(bad);
const heightRule = badRes.results.find(r => r.property === 'figure_height');
// 3) ACS 单栏：宽度 84.7 边界通过；无位图 → dpi not_applicable；无文本 → 字号 unknown
const ok = mkDoc('acs-single');
ok.canvas.width_mm = 84.7;
const okRes = FigPresets.checkJournalRules(ok);
const dpiRule = okRes.results.find(r => r.property === 'raster_dpi');
const fontRule = okRes.results.find(r => r.property === 'min_font_size');
// 4) Science（unverified）：宽度即使符合也 unknown
const sci = mkDoc('science-single');
sci.canvas.width_mm = 57;
const sciRes = FigPresets.checkJournalRules(sci);
const sciWidth = sciRes.results.find(r => r.property === 'figure_width');
console.log(JSON.stringify({
  noneEmpty: none.results.length === 0 && !!none.note,
  heightFail: heightRule && heightRule.status === 'fail' && badRes.ok === false,
  dpiNA: dpiRule && dpiRule.status === 'not_applicable',
  fontUnknown: fontRule && fontRule.status === 'unknown',
  sciUnknown: sciWidth && sciWidth.status === 'unknown' && sciWidth.verification === 'unverified_secondary'
}));
""")
        self.assertTrue(out["noneEmpty"])
        self.assertTrue(out["heightFail"])
        self.assertTrue(out["dpiNA"])
        self.assertTrue(out["fontUnknown"], "无可测字号对象必须 unknown，不产生 pass")
        self.assertTrue(out["sciUnknown"], "未核实规则即使达标也是 unknown")

    def test_effective_raster_dpi(self):
        out = node_json(PRELUDE + r"""
// 低有效 DPI 位图：300×300 px 放置 50.8mm 宽 → 150 dpi < 300 required → fail
let doc = mkDoc('nature-single');
doc = FigOps.applyAll(doc, [{ op: 'add_element', element: {
  id: 'img-low', type: 'image', name: 'low',
  transform: { x: 5, y: 5, w: 50.8, h: 50.8, rotation: 0 },
  style: {}, src: 'data:image/png;base64,x', pxWidth: 300, pxHeight: 300 } }],
  { label: 'img' }).doc;
const res = FigPresets.checkJournalRules(doc);
const dpi = res.results.find(r => r.property === 'raster_dpi' && r.status !== 'not_applicable');
// 无像素尺寸位图 → unknown
let doc2 = mkDoc('nature-single');
doc2 = FigOps.applyAll(doc2, [{ op: 'add_element', element: {
  id: 'img-nopx', type: 'image', name: 'nopx',
  transform: { x: 5, y: 5, w: 50.8, h: 50.8, rotation: 0 },
  style: {}, src: 'data:image/png;base64,x' } }], { label: 'img2' }).doc;
const res2 = FigPresets.checkJournalRules(doc2);
const dpi2 = res2.results.find(r => r.property === 'raster_dpi');
console.log(JSON.stringify({
  lowDpiFail: dpi && dpi.status === 'fail' && Math.round(dpi.measured) === 150,
  noPxUnknown: dpi2 && dpi2.status === 'unknown'
}));
""")
        self.assertTrue(out["lowDpiFail"], "有效 DPI=px/放置mm，低于要求必须 fail")
        self.assertTrue(out["noPxUnknown"])

    def test_rules_scoped_by_journal(self):
        out = node_json(PRELUDE + r"""
const res = FigPresets.checkJournalRules(mkDoc('nature-single'));
const ids = res.results.map(r => r.rule_id);
const mixed = ids.some(id => id.startsWith('acsnano-') || id.startsWith('science-'));
console.log(JSON.stringify({ scoped: !mixed, count: ids.length }));
""")
        self.assertTrue(out["scoped"])
        self.assertEqual(out["count"], 5)  # width/max-height/font-min/font-max/dpi

    def test_per_object_measurement_and_figure_type(self):
        """逐对象测量出证 + appliesTo.figureType 未知类别降级（审计反例回归）。"""
        out = node_json(PRELUDE + r"""
function img(id, pxw, pxh, w, h) {
  const e = { id, type: 'image', name: id,
    transform: { x: 0, y: 0, w, h, rotation: 0 },
    style: {}, src: 'data:image/png;base64,x' };
  if (pxw !== undefined) e.pxWidth = pxw;
  if (pxh !== undefined) e.pxHeight = pxh;
  return e;
}
function dpiRules(res) {
  return res.results.filter(r => r.property === 'raster_dpi');
}
// a) 1200×150px 放 50.8mm → 高向 75dpi 为最小 → nature-dpi-color fail
let da = FigDoc.create({ width_mm: 89, height_mm: 70 });
da.elements.push(img('vertical-low', 1200, 150, 50.8, 50.8));
const dpiA = dpiRules(FigPresets.checkJournalRules(da, { journal_id: 'nature-single' }))
  .find(r => r.rule_id === 'nature-dpi-color');
// b) 一张 600dpi + 一张无像素尺寸 → unknown + coverage partial
let db = FigDoc.create({ width_mm: 89, height_mm: 70 });
db.elements.push(img('known', 1200, 1200, 50.8, 50.8),
                 img('unknown', undefined, undefined, 50.8, 50.8));
const dpiB = dpiRules(FigPresets.checkJournalRules(db, { journal_id: 'nature-single' }))
  .find(r => r.rule_id === 'nature-dpi-color');
// c) ACS 300dpi 无图类别 → color pass、grayscale/lineart unknown（不 fail）
let dc = FigDoc.create({ width_mm: 84.7, height_mm: 100 });
dc.elements.push(img('photo', 600, 600, 50.8, 50.8)); // 300 dpi
const acsNoType = dpiRules(FigPresets.checkJournalRules(dc, { journal_id: 'acs-single' }));
const acsColorType = dpiRules(FigPresets.checkJournalRules(
  dc, { journal_id: 'acs-single', figure_type: 'halftone_color' }));
dc.elements[0] = img('photo', 400, 400, 50.8, 50.8); // 200 dpi
const acsLow = dpiRules(FigPresets.checkJournalRules(dc, { journal_id: 'acs-single' }));
// d) tpl-bar 图表轴标题 40pt + 6pt 文本 → max_font warning（图表参与测量）
const built = FigPresets.templateFromStats('tpl-bar',
  { columns: ['group', 'value'], rows: [['a', 1], ['b', 2]] },
  { mapping: { x: 'group', y: 'value' } });
let dd = FigDoc.create({ width_mm: 89, height_mm: 70 });
dd.elements.push(...built.elements);
const chartD = dd.elements.find(e => e.type === 'chart');
chartD.chart.presentation = { version: 1, axes: { x: { title: { fontSizePt: 40 } } } };
dd.elements.push({ id: 'label-6pt', type: 'text', text: 'label',
  transform: { x: 0, y: 0, w: 10, h: 5, rotation: 0 }, style: { fontSizePt: 6 } });
const fontRes = FigPresets.checkJournalRules(dd, { journal_id: 'nature-single' }).results;
// e) 只有默认 tpl-bar 图表 → min_font 实测 7 pass（此前 null/unknown）
let de = FigDoc.create({ width_mm: 89, height_mm: 70 });
de.elements.push(...FigPresets.templateFromStats('tpl-bar',
  { columns: ['group', 'value'], rows: [['a', 1], ['b', 2]] },
  { mapping: { x: 'group', y: 'value' } }).elements);
const minOnly = FigPresets.checkJournalRules(de, { journal_id: 'nature-single' }).results
  .find(r => r.property === 'min_font_size');
console.log(JSON.stringify({
  a: dpiA, b: dpiB,
  acsNoType: acsNoType.map(r => ({ id: r.rule_id, status: r.status, measured: r.measured })),
  acsColorType: acsColorType.map(r => ({ id: r.rule_id, status: r.status })),
  acsLow: acsLow.map(r => ({ id: r.rule_id, status: r.status })),
  chartId: chartD.id,
  maxFont: fontRes.find(r => r.property === 'max_font_size'),
  minFontD: fontRes.find(r => r.property === 'min_font_size'),
  minOnly
}));
""")
        a = out["a"]
        self.assertEqual(a["status"], "fail")
        self.assertEqual(a["measured"], 75)  # min(1200/2, 150/2)：高向决定有效 DPI
        self.assertEqual(a["element_ids"], ["vertical-low"])
        b = out["b"]
        self.assertEqual(b["status"], "unknown")
        self.assertEqual(b["coverage"], "partial")
        self.assertEqual(b["measured"], 600)
        self.assertIn("unknown", b["unmeasured_ids"])
        by_id = {r["id"]: r for r in out["acsNoType"]}
        self.assertEqual(by_id["acsnano-dpi-color"]["status"], "pass")
        self.assertEqual(by_id["acsnano-dpi-grayscale"]["status"], "unknown")
        self.assertEqual(by_id["acsnano-dpi-lineart"]["status"], "unknown")
        self.assertTrue(all(r["status"] == "fail" for r in out["acsLow"]),
                        "200dpi 低于所有类别下限必须全部 fail")
        by_id2 = {r["id"]: r for r in out["acsColorType"]}
        self.assertEqual(by_id2["acsnano-dpi-color"]["status"], "pass")
        self.assertEqual(by_id2["acsnano-dpi-grayscale"]["status"], "not_applicable")
        self.assertEqual(by_id2["acsnano-dpi-lineart"]["status"], "not_applicable")
        max_font = out["maxFont"]
        self.assertEqual(max_font["status"], "warning")
        self.assertEqual(max_font["measured"], 40)
        self.assertIn(out["chartId"], max_font["element_ids"],
                      "图表轴标题 40pt 必须计入 max_font_size 并定位到图表元素")
        self.assertEqual(out["minFontD"]["measured"], 6)
        self.assertEqual(out["minOnly"]["status"], "pass")
        self.assertEqual(out["minOnly"]["measured"], 7,
                         "默认图表刻度字号 7pt 必须可测（渲染器默认值）")


if __name__ == "__main__":
    unittest.main()
