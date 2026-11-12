"""test_data_wizard.py — R02/A02：数据映射向导回归

样例数据包含：多组候选数值列（value_a/value_b/replicate）、重复观测
（同 condition 两行）、缺失值（value_b 有一行 null）、误差列（sem）。

验证（headless DOM + 真实内核，不请求模型）：
1. 向导打开：模板/映射/画布/预览四段齐备；映射默认=内核推断；
2. 改映射（y 列换 value_b）→ draft 更新；预览 SVG 相应变化；
3. 预览与最终创建一致：create() 提交的 chart.mapping/几何与
   lastBuild（预览构建）一致；提交只产生 1 次历史；
4. 取消：不触发 onCreate、无 commit、文档不变；
5. 统计语义：bar 显示「均值（mean）」；被排除行数把 value_b 缺失行计入；
6. 误差列说明：选择 error 列时提示 SD/SEM/95CI 需科学合同申报；
7. 画布：默认 keep 不改画布；explicit_preset 时提交 apply_journal op；
8. 来源保留：provenance sha256 写入 chart.data.source_info（Excel 场景
   由 selftest 的 sheet/header 断言覆盖，这里覆盖通用 source_info 链）。
"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

DATA = {
    "columns": ["condition", "value_a", "value_b", "sem"],
    "rows": [
        ["ctrl", 1.2, 10.1, 0.2],
        ["ctrl", 1.4, None, 0.2],      # 重复观测 + value_b 缺失
        ["treat", 2.1, 20.3, 0.3],
        ["treat", 2.3, 22.0, 0.3],
        ["blank", None, None, None],   # 全缺失 → 必被排除
    ],
}

HARNESS_PRELUDE = r"""
const assert = require('assert');
const fs = require('fs');
for (const file of ['figdoc', 'ops', 'palette', 'presets', 'data', 'render'])
  require('./lib/' + file + '.js');
FigPresets.load({
  journals: JSON.parse(fs.readFileSync('../presets/journals.json', 'utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json', 'utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json', 'utf8'))
});
class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null;
    this.style = {}; this.attributes = {}; this.listeners = {}; this._text = '';
    this._innerHTML = ''; this.value = ''; this.disabled = false; this.checked = false;
  }
  set textContent(v) { this.children = []; this._text = v == null ? '' : String(v); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(v) { this._innerHTML = String(v); }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; this.children.push(child); return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null; return child;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] == null ? null : this.attributes[k]; }
  addEventListener(n, h) { (this.listeners[n] || (this.listeners[n] = [])).push(h); }
  click() { for (const h of this.listeners.click || []) h({target: this}); }
}
global.document = {
  body: new Element('body'),
  createElement: tag => new Element(tag),
  createTextNode: t => { const n = new Element('#text'); n.textContent = t; return n; },
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; }
};
global.modals = [];
global.notices = [];
global.Ui = {
  modal(options) { const item = {options, closed: false}; global.modals.push(item);
    return {close() { item.closed = true; }, root: options.body}; },
  toast(text, options) { global.notices.push({text: String(text), options}); }
};
let commits = 0;
global.App = {
  doc: FigDoc.create({title: 'wizard-test', width_mm: 120, height_mm: 90}),
  commit(ops, context) {
    const result = FigOps.applyAll(this.doc, ops, {
      label: context.label, source: context.source, ts: '2026-11-12T00:00:00Z'});
    if (result.applied) { this.doc = result.doc; commits += 1; }
    return Promise.resolve({applied: result.applied, doc: this.doc});
  },
  select() {}, error() {}, status() {}
};
require('./viewer_static/app/import.js');
require('./viewer_static/app/data-wizard.js');
"""


def node_script(body):
    return HARNESS_PRELUDE + body


def run_node(body):
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    proc = subprocess.run(["node", "-e", node_script(body)], cwd=str(HERE),
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=60, env=env)
    if proc.returncode:
        raise AssertionError((proc.stdout or "") + "\n" + (proc.stderr or ""))
    out = proc.stdout.strip()
    return json.loads(out.splitlines()[-1]) if out else None


PROVENANCE = {
    "kind": "csv", "locator": "demo-wizard.csv", "sha256": "a" * 64,
    "verification_status": "input_bytes_hashed_unverified_origin",
}


class DataWizardFlow(unittest.TestCase):
    def test_full_wizard_flow(self):
        out = run_node(r"""
const data = %s;
(async () => {
  const Import = global.Import;
  const app = global.App;
  const canvas0 = JSON.parse(JSON.stringify(app.doc.canvas));
  const history0 = app.doc.history.length;

  // CSV 文本（带缺失值与重复观测），走真实 _applyDataTable 入口；
  // 仅拦截 DataWizard.open 捕获 handle，buildDraft/onCreate 都是
  // import.js 的真实闭包（含 source_info/note/画布语义）。
  const csvText = 'condition,value_a,value_b,sem\n' +
    'ctrl,1.2,10.1,0.2\ntctrl,1.4,,0.2\n' +
    'treat,2.1,20.3,0.3\ntreat,2.3,22.0,0.3\n,,,';
  const origOpen = global.DataWizard.open;
  let wizardHandle = null;
  global.DataWizard.open = (opts) => { wizardHandle = origOpen(opts); return wizardHandle; };
  let cbInfo = null, cbErr = null;
  Import._applyDataTable(csvText, 'demo-wizard.csv', (err, info) => {
    cbErr = err; cbInfo = info;
  });
  assert.ok(wizardHandle, '向导应同步打开');

  const summary = () => wizardHandle.body.textContent;

  // 1) 打开即有推断默认映射与统计语义
  const draft0 = wizardHandle.draft();
  assert.ok(draft0.mapping && draft0.mapping.x, '默认映射应来自内核推断');
  assert.ok(summary().includes('渲染语义'), '应显示渲染语义');
  assert.ok(summary().includes('排除'), '应显示被排除行');

  // 2) 改映射：y → value_b（含缺失），预览摘要更新
  wizardHandle.setMapping('y', 'value_b');
  assert.strictEqual(wizardHandle.draft().mapping.y, 'value_b');
  assert.strictEqual(wizardHandle.lastBuild().chart.mapping.y, 'value_b');
  assert.ok(summary().includes('缺失'), '缺失列提示');
  // 排除行：value_b 缺失 2 行（第2行 + 全空行）
  assert.ok(/排除的行：\s*2/.test(summary()), '被排除行应为 2：' +
    (summary().match(/排除的行：[^\n]*/) || ['?'])[0]);

  // 3) 误差线路径说明（重复观测计算 或 科学合同 uncertainty_column）
  assert.ok(summary().includes('SD/SEM/95CI'), '应说明误差线统计量类型需科学合同申报');
  assert.ok(summary().includes('uncertainty_column'), '应说明用户误差列的申报路径');

  // 4) 预览与最终一致 + 一次历史
  const previewBuild = wizardHandle.lastBuild();
  const ok = await wizardHandle.create();
  assert.strictEqual(ok, true, '创建应成功');
  assert.strictEqual(commits, 1, '必须恰好一次 commit');
  assert.strictEqual(app.doc.history.length, history0 + 1, '必须恰好一条历史');
  const chart = app.doc.elements.find(e => e.type === 'chart');
  assert.ok(chart, '应创建 chart');
  assert.strictEqual(chart.chart.mapping.y, 'value_b', '用户确认映射生效');
  const parsed = FigData.parseCSV(csvText, {delimiter: 'auto', header: true});
  assert.deepStrictEqual(chart.chart.data.inline.rows, parsed.rows, '原始行不变');
  // 预览构建与最终提交几何/映射/数据一致（元素 id 不同但内容相同）
  const sig = (b) => b.elements.filter(e => e.type === 'chart').map(e =>
    [e.transform.x, e.transform.y, e.transform.w, e.transform.h,
     e.chart.mapping.y, JSON.stringify(e.chart.data.inline.rows)]);
  assert.deepStrictEqual(sig({elements: [chart]}),
    sig(previewBuild).map(r => [r[0], r[1], r[2], r[3], r[4], r[5]]),
    '最终 chart 几何/映射/数据应与预览构建一致');
  // 来源保留：真实闭包把 source_info 附到 chart.data
  assert.ok(chart.chart.data.source_info && chart.chart.data.source_info.sha256,
    'source_info.sha256 应保留');
  assert.ok(!cbErr && cbInfo && cbInfo.template_id, '回调应成功');

  // 5) 画布默认 keep：未写 apply_journal/set_canvas
  const opsUsed = app.doc.history[history0].ops;
  assert.ok(!opsUsed.some(op => op.op === 'apply_journal' || op.op === 'set_canvas'),
    '默认 keep 不改画布');
  assert.strictEqual(app.doc.canvas.width_mm, canvas0.width_mm);

  // 6) 取消无变更（重开向导后直接关闭）
  const wizard2 = global.DataWizard.open({
    filename: 'demo-wizard.csv', data: data, recommendations:
      [{template_id: 'tpl-bar', score: 1, reasons: []}],
    currentCanvas: app.doc.canvas,
    buildDraft: () => { throw new Error('取消流程不应构建'); },
    onCreate: () => { throw new Error('取消流程不应提交'); }
  });
  wizard2.closeModal();
  assert.strictEqual(commits, 1, '取消不产生新 commit');

  // 7) 重复 create 不重复提交
  const again = await wizardHandle.create();
  assert.strictEqual(commits, 1, '重复 create 不重复提交');

  console.log(JSON.stringify({ok: true, mapping: chart.chart.mapping}));
})().catch(err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
""" % json.dumps(DATA))
        self.assertTrue(out["ok"])
        self.assertEqual(out["mapping"]["y"], "value_b")

    def test_bar_semantics_and_preset_canvas(self):
        out = run_node(r"""
const data = %s;
(async () => {
  const stats = FigData.columnStats(data);
  const recs = FigPresets.recommend(stats, {n: 8})
    .filter(r => FigPresets.validateTemplateCapability(r.template_id).ok);
  const barRec = recs.find(r => {
    const t = FigPresets.template(r.template_id);
    return t && t.chart_type === 'bar';
  });
  assert.ok(barRec, '应能推荐 bar 模板');
  const app = global.App;
  let wizard = global.DataWizard.open({
    filename: 'demo.csv', data: data, recommendations: [barRec],
    currentCanvas: app.doc.canvas,
    buildDraft: (templateId, mapping, canvasChoice, title) => {
      const opts = {journal_id: null, palette_id: null, title: title || undefined};
      if (mapping && Object.keys(mapping).length) opts.mapping = mapping;
      const built = FigPresets.templateFromStats(templateId, data, opts);
      const preset = canvasChoice.mode === 'explicit_preset' && canvasChoice.preset;
      const ops = [];
      let canvas = app.doc.canvas;
      if (preset) {
        const ap = FigPresets.applyCanvas(preset.id, app.doc);
        ops.push(ap.op); canvas = ap.doc.canvas;
      }
      built.effectiveCanvas = canvas; built._canvasOps = ops;
      return built;
    },
    onCreate: (templateId, mapping, canvasChoice) => Promise.resolve().then(() => {
      const built = wizard.lastBuild();
      const ops = built._canvasOps.concat(
        built.elements.map(el => ({op: 'add_element', element: el})));
      return app.commit(ops, {label: 'x', source: 'import'}).then(r => !!r.applied);
    })
  });
  // bar 语义：均值
  assert.ok(wizard.body.textContent.includes('均值（mean）'),
    'bar 必须展示 mean 聚合');
  // 用户确认套模板期刊预设 → apply_journal 进入同一 commit
  wizard.setCanvasChoice({mode: 'explicit_preset'});
  const presetId = FigPresets.template(barRec.template_id).journal_default;
  assert.ok(presetId, 'bar 模板应有 journal_default');
  const ok = await wizard.create();
  assert.ok(ok);
  const ops = app.doc.history[0].ops;
  assert.ok(ops.some(op => op.op === 'apply_journal' && op.journal_preset_id === presetId),
    '确认预设后 apply_journal 应在提交内');
  assert.notStrictEqual(app.doc.canvas.width_mm, 120);
  console.log(JSON.stringify({ok: true, canvas: app.doc.canvas.width_mm}));
})().catch(err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
""" % json.dumps(DATA))
        self.assertTrue(out["ok"])

    def test_import_entry_routes_to_wizard_and_cancel_keeps_doc(self):
        out = run_node(r"""
(async () => {
  const Import = global.Import;
  const before = JSON.stringify(global.App.doc);
  const commitsBefore = commits;
  // 走真实入口（DataWizard 已加载 → 同步打开向导）
  Import._applyDataTable('condition,value_a,value_b\nA,1,2\nA,1.5,\nB,3,4', 'demo2.csv');
  const modal = global.modals[global.modals.length - 1];
  assert.ok(modal, '应打开向导 modal');
  const cancel = modal.options.actions.find(a => a.label === '取消');
  const create = modal.options.actions.find(a => a.label === '创建图表');
  assert.ok(cancel && create, '向导动作齐备');
  // 点击取消
  if (typeof cancel.onClick === 'function') cancel.onClick();
  assert.strictEqual(commits, commitsBefore, '取消不提交');
  assert.strictEqual(JSON.stringify(global.App.doc), before, '取消文档不变');
  console.log(JSON.stringify({ok: true}));
})().catch(err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
""")
        self.assertTrue(out["ok"])


if __name__ == "__main__":
    unittest.main()
