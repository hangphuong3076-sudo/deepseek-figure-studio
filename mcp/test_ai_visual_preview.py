"""test_ai_visual_preview.py — R05/A05：可视化修改预览（内核级）

验证 AiPanel.buildVisualPreview 的真实行为（不请求模型；GUI 渲染待浏览器验证）：
1. 基线文档不被修改：serialize、history、rev 调用前后一致；
2. 非法操作批 → ok:false 带具体错误（不产出预览）；
3. 合法操作（move/set_style/add_element）→ 前后 SVG 真实不同、受影响对象
   含移动目标与新增元素；
4. 物化 ID 稳定：把 materializedOps 应用到同一基线的另一个副本，新增元素
   id 与预览 afterDoc 中一致（应用=预览，不重新抽取随机 ID）；
5. 空操作/空数组 → 明确错误；
6. 修改前后 SVG 由同一 canonical 渲染链产生（FigRender.toSVG 确定性：
   同 doc 两次输出一致）。
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
globalThis.location = { pathname: '/index.html' };  // app/ai.js 载入期只读 location
for (const f of ['figdoc', 'diagram', 'ops', 'science', 'palette', 'presets', 'data',
                 'lineage', 'render', 'tiff', 'export', 'ai', 'storage'])
  require('./lib/' + f + '.js');
require('./viewer_static/app/ai.js');
function mkDoc() {
  let doc = FigDoc.create({ title: 'pv', width_mm: 120, height_mm: 90 });
  doc = FigOps.applyAll(doc, [
    { op: 'add_element', element: { id: 'txt-1', type: 'text', name: '标题',
      transform: { x: 5, y: 4, w: 60, h: 8, rotation: 0 },
      style: { fontSizePt: 10 }, text: 'Title' } },
    { op: 'add_element', element: { id: 'rect-1', type: 'rect', name: '框',
      transform: { x: 10, y: 20, w: 40, h: 25, rotation: 0 },
      style: { fill: '#cccccc', stroke: '#333333' } } }
  ], { label: 'init' }).doc;
  return doc;
}
"""


class VisualPreviewTests(unittest.TestCase):
    def test_preview_leaves_baseline_untouched(self):
        out = node_json(PRELUDE + r"""
const doc = mkDoc();
const before = JSON.stringify(doc);
const ops = [
  { op: 'move', targets: ['rect-1'], dx: 5, dy: 3 },
  { op: 'set_style', targets: ['txt-1'], style: { fontSizePt: 12 } },
  { op: 'add_element', element: { type: 'text', transform: { x: 8, y: 40, w: 40, h: 6 },
    style: { fontSizePt: 7 }, text: 'note' } }
];
const pv = AiPanel.buildVisualPreview(doc, ops);
const after = JSON.stringify(doc);
const addedId = pv.afterDoc.elements.filter(e => e.type === 'text' && e.text === 'note')
  .map(e => e.id)[0];
console.log(JSON.stringify({
  ok: pv.ok, baselineStable: before === after,
  historyLen: doc.history.length,
  beforeSvg: pv.beforeSvg ? pv.beforeSvg.slice(0, 80) : null,
  svgDiffer: pv.ok ? pv.beforeSvg !== pv.afterSvg : null,
  affected: pv.affectedIds,
  addedId: addedId,
  addedInAffected: pv.affectedIds.indexOf(addedId) >= 0,
  appliedCount: pv.appliedCount
}));
""")
        self.assertTrue(out["ok"])
        self.assertTrue(out["baselineStable"], "基线文档不得被预览修改")
        self.assertEqual(out["historyLen"], 1, "预览不写正式历史")
        self.assertTrue(out["svgDiffer"], "真实变更必须产生不同 SVG")
        self.assertIn("rect-1", out["affected"])
        self.assertTrue(out["addedInAffected"], "新增元素应列入受影响对象")
        self.assertEqual(out["appliedCount"], 3)

    def test_invalid_batch_rejected(self):
        out = node_json(PRELUDE + r"""
const doc = mkDoc();
const pv = AiPanel.buildVisualPreview(doc, [
  { op: 'set_style', targets: ['txt-1'], style: { fontSizePt: 9 } },
  { op: 'bogus_op', targets: ['txt-1'] }
]);
console.log(JSON.stringify({ ok: pv.ok, hasError: /bogus_op|未知/.test(pv.error || '') }));
""")
        self.assertFalse(out["ok"])
        self.assertTrue(out["hasError"], out)

    def test_empty_ops_error(self):
        out = node_json(PRELUDE + r"""
const doc = mkDoc();
const pv = AiPanel.buildVisualPreview(doc, []);
console.log(JSON.stringify({ ok: pv.ok, error: pv.error }));
""")
        self.assertFalse(out["ok"])
        self.assertIn("没有待预览", out["error"])

    def test_materialized_ids_frozen_on_apply(self):
        out = node_json(PRELUDE + r"""
const doc = mkDoc();
const ops = [
  { op: 'move', targets: ['rect-1'], dx: 2, dy: 2 },
  { op: 'add_element', element: { type: 'text', transform: { x: 8, y: 40, w: 40, h: 6 },
    style: { fontSizePt: 7 }, text: 'm' } }
];
const pv = AiPanel.buildVisualPreview(doc, ops);
// 预览里新增元素的 id
const pvAdded = pv.afterDoc.elements.filter(e => e.type === 'text' && e.text === 'm')
  .map(e => e.id);
// 把物化操作应用到同一基线的另一个副本（模拟 App.commit）
const applied = FigOps.applyAll(FigDoc.clone(doc), pv.materializedOps, { label: 'commit' });
const cmAdded = applied.doc.elements.filter(e => e.type === 'text' && e.text === 'm')
  .map(e => e.id);
console.log(JSON.stringify({
  ok: pv.ok, pvAdded: pvAdded, cmAdded: cmAdded,
  idsStable: JSON.stringify(pvAdded) === JSON.stringify(cmAdded),
  historyLen: applied.doc.history.length
}));
""")
        self.assertTrue(out["ok"])
        self.assertEqual(out["pvAdded"], out["cmAdded"], "应用的新增 ID 必须与预览一致")
        self.assertTrue(out["idsStable"])
        self.assertEqual(out["historyLen"], 2, "一次 applyAll 一条历史")

    def test_canonical_render_deterministic(self):
        out = node_json(PRELUDE + r"""
const doc = mkDoc();
const a = FigRender.toSVG(doc, { scale: 1, includeGuides: false });
const b = FigRender.toSVG(doc, { scale: 1, includeGuides: false });
console.log(JSON.stringify({ deterministic: a === b }));
""")
        self.assertTrue(out["deterministic"])


if __name__ == "__main__":
    unittest.main()
