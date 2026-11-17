# -*- coding: utf-8 -*-
"""test_peak_ids.py — R04 峰标注稳定 id 在属性面板草稿/补丁中的保持（内核级）

背景：props.js 的 pendFromChart/charDiffPatch 曾只复制 {x,label}，把
characterization.peak_annotations 的稳定 id 丢掉，导致 presentation.peaks
按 id 挂的样式在改标签/轴向后失联。修复后：
  - pendFromChart 用 committedPeaks(chart) 载入草稿（保留显式/自动 id）；
  - charDiffPatch 输出 {x,label,id?}（键序一致）并与 committedPeaks 同形比较，
    无关改动（如 x_reverse）不再误发 peak_annotations。

测试方式与 audit-probes.cjs 相同：从 props.js 源码切出真实辅助函数，
配合真实 mcp/lib/data.js 的 FigData.normalizeCharacterization（自动 id
内核规则），app() 打桩。覆盖：
  1) 显式 pk-user + 只切 x_reverse → patch 不含 peak_annotations；
  2) 改 pk-user 标签 → patch.peak_annotations[0].id 仍是 pk-user；
  3) 原始记录无 id + 改标签 → patch 保留自动 id（= 内核归一化结果）；
  4) 新增峰（onAddPeak 形态 {x,label} 无 id）→ 旧峰保 id、新峰无 id。
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
require('./lib/data.js'); // 真实 FigData.normalizeCharacterization（自动 id 规则）
const fs = require('fs');
const source = fs.readFileSync('viewer_static/app/props.js', 'utf8');
function helper(name) {
  const start = source.indexOf('  function ' + name + '(');
  const end = source.indexOf('\n  function ', start + 10);
  if (start < 0) throw new Error('props.js 缺少函数：' + name);
  return source.slice(start, end < 0 ? undefined : end);
}
function varBlock(name) {
  const start = source.indexOf('  var ' + name + ' =');
  const end = source.indexOf('\n  };', start);
  if (start < 0) throw new Error('props.js 缺少变量：' + name);
  return source.slice(start, end < 0 ? undefined : end + 5);
}
const FUNCS = [
  varBlock('CHAR_DEFAULTS'),
  helper('committedChar'),
  helper('effectiveChar'),
  helper('committedPeaks'),
  helper('pendFromChart'),
  helper('charDiffPatch')
].join('\n');
function makeHarness() {
  return new Function(FUNCS + `
    function app() { return { error: function (m) { throw new Error(m); } }; }
    var charState = { pend: null };
    return {
      setPend: function (chart) { charState.pend = pendFromChart(chart); },
      editPend: function (fn) { fn(charState.pend); },
      patch: function (chart) { return charDiffPatch(chart); }
    };
  `)();
}
function chartWith(peaks) {
  return {
    chartType: 'line',
    characterization: {
      technique: 'XPS', x_scale: 'linear', x_reverse: false,
      normalize: 'none', offset_each_series: 0, curves: [],
      peak_annotations: peaks
    },
    data: { inline: { columns: ['x', 'y'], rows: [[1, 2], [3, 4]] } },
    mapping: { x: 'x', y: 'y' }
  };
}
"""


class PeakIdTests(unittest.TestCase):
    def test_peak_ids_survive_draft_and_patch(self):
        out = node_json(PRELUDE + r"""
const results = {};
// 1) 显式 pk-user：只切 x_reverse → patch 不应携带 peak_annotations
{
  const h = makeHarness();
  const chart = chartWith([{ id: 'pk-user', x: 284.8, label: 'C1s' }]);
  h.setPend(chart);
  h.editPend(p => { p.x_reverse = true; });
  const patch = h.patch(chart);
  results.explicitUnrelated = {
    hasPeakKey: Object.prototype.hasOwnProperty.call(patch, 'peak_annotations'),
    xReverse: patch.x_reverse === true
  };
}
// 2) 显式 pk-user：改标签 → patch 保留 id
{
  const h = makeHarness();
  const chart = chartWith([{ id: 'pk-user', x: 284.8, label: 'C1s' }]);
  h.setPend(chart);
  h.editPend(p => { p.peak_annotations[0].label = 'C1s new'; });
  const patch = h.patch(chart);
  results.explicitLabel = patch.peak_annotations && patch.peak_annotations[0];
}
// 3) 原始记录无 id：改标签 → patch 保留内核自动 id
{
  const h = makeHarness();
  const chart = chartWith([{ x: 284.8, label: 'C1s' }]);
  const autoId = FigData.normalizeCharacterization(
    chart.characterization, ['x', 'y']).char.peak_annotations[0].id;
  h.setPend(chart);
  h.editPend(p => { p.peak_annotations[0].label = 'C1s new'; });
  const patch = h.patch(chart);
  results.autoId = autoId;
  results.autoLabel = patch.peak_annotations && patch.peak_annotations[0];
}
// 4) 新增峰（{x,label} 无 id）：旧峰保 id、新峰不带 id
{
  const h = makeHarness();
  const chart = chartWith([{ id: 'pk-user', x: 284.8, label: 'C1s' }]);
  h.setPend(chart);
  h.editPend(p => { p.peak_annotations.push({ x: 300, label: 'new peak' }); });
  const patch = h.patch(chart);
  results.addPeak = patch.peak_annotations;
}
console.log(JSON.stringify(results));
""")
        # 1) 无关改动不误发 peak_annotations
        self.assertFalse(out["explicitUnrelated"]["hasPeakKey"],
                         "x_reverse 等无关改动不应产生 peak_annotations 补丁")
        self.assertTrue(out["explicitUnrelated"]["xReverse"])
        # 2) 显式 id 在改标签后保留
        self.assertEqual(out["explicitLabel"]["id"], "pk-user")
        self.assertEqual(out["explicitLabel"]["label"], "C1s new")
        # 3) 自动 id 与内核归一化结果一致
        self.assertTrue(out["autoId"].startswith("pk-"))
        self.assertEqual(out["autoLabel"]["id"], out["autoId"],
                         "无 id 原始记录改标签后必须保留确定性自动 id")
        # 4) 新峰无 id（由内核分配），旧峰 id 不变
        peaks = out["addPeak"]
        self.assertEqual(len(peaks), 2)
        self.assertEqual(peaks[0]["id"], "pk-user")
        self.assertNotIn("id", peaks[1], "onAddPeak 新峰不应携带 id")


if __name__ == "__main__":
    unittest.main()
