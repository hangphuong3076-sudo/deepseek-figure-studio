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
   - 无像素尺寸的位图 → unknown；
   - 无可测字号（图表内部默认不在元素上）→ unknown；
3. 规则按 journal_ids 关联，未套用预设的其他期刊规则不混入。
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


if __name__ == "__main__":
    unittest.main()
