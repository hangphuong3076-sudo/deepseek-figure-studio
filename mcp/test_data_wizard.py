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
  removeAttribute(k) { delete this.attributes[k]; }
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
function mockUiH(tag, attrs, children) {
  var el = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (key) {
    var value = attrs[key];
    if (value === null || value === undefined || value === false) return;
    if (key === "class" || key === "className") { el.className = String(value); el.setAttribute("class", String(value)); }
    else if (key === "text") el.textContent = String(value);
    else if (key === "html") el.innerHTML = String(value);
    else if (key === "style" && value && typeof value === "object") {
      var st = el.style || (el.style = {});
      Object.keys(value).forEach(function (prop) { var pv = value[prop]; if (pv === null || pv === undefined) return; st[prop] = pv; });
    } else if (key.indexOf("on") === 0 && typeof value === "function") { el.addEventListener(key.slice(2).toLowerCase(), value); }
    else if (value === true) { el.setAttribute(key, ""); } else { el.setAttribute(key, String(value)); }
  });
  if (children != null) {
    var list = Array.isArray(children) ? children : [children];
    list.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    });
  }
  return el;
}
global.Ui = {
  h: mockUiH,
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
  assert.ok(summary().includes('图表属性'), '应说明用户误差列的申报路径');

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

    def test_steps_goTo_and_visible_text(self):
        """a+d) step()/goTo() 与可见文本：无「匹配度 N」、无 uncertainty_column。"""
        out = run_node(r"""
const data = %s;
(async () => {
  let wizard = null;
  const origOpen = global.DataWizard.open;
  global.DataWizard.open = (o) => { wizard = origOpen(o); return wizard; };
  global.Import._applyDataTable(
    'condition,value_a,value_b,sem\nctrl,1.2,10.1,0.2\ntreat,2.1,20.3,0.3\n',
    'demo-steps.csv', () => {});
  assert.ok(wizard, '向导应打开');
  assert.strictEqual(wizard.step(), 1, '初始应在第 1 步');
  wizard.goTo(4);
  assert.strictEqual(wizard.step(), 4);
  const txt = wizard.body.textContent;
  for (const s of ['数据预览', '字段映射', '画布', '确认',
                   '创建后会作为一步操作写入历史', '排除的行']) {
    assert.ok(txt.includes(s), 'body 应包含「' + s + '」');
  }
  // 可见文本统计：跳过 dw-tip 子树（技术细节在 ⓘ 内不算可见文本）
  function visText(el) {
    if (el.className && (' ' + el.className + ' ').indexOf(' dw-tip ') >= 0) return '';
    let out = el._text || '';
    (el.children || []).forEach(c => { out += visText(c); });
    return out;
  }
  const visible = visText(wizard.body);
  assert.ok(!visible.includes('uncertainty_column'),
    '可见文本不应出现 uncertainty_column');
  const m = visible.match(/匹配度\s*\d+/);
  assert.ok(!m, '可见文本不应出现「匹配度 N」：' + (m && m[0]));
  console.log(JSON.stringify({ok: true}));
})().catch(err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
""" % json.dumps(DATA))
        self.assertTrue(out["ok"])

    def test_quick_create_single_commit(self):
        """b) quickCreate：恰好 1 次 commit、首个推荐模板、画布不变。"""
        out = run_node(r"""
const data = %s;
(async () => {
  const app = global.App;
  const canvas0 = JSON.parse(JSON.stringify(app.doc.canvas));
  const hist0 = app.doc.history.length;
  let wizard = null, openedOpts = null, cbInfo = null;
  const origOpen = global.DataWizard.open;
  global.DataWizard.open = (o) => { openedOpts = o; wizard = origOpen(o); return wizard; };
  global.Import._applyDataTable(
    'condition,value_a,value_b,sem\nctrl,1.2,10.1,0.2\ntreat,2.1,20.3,0.3\n',
    'demo-quick.csv', (err, info) => { cbInfo = info; });
  assert.ok(wizard, '向导应打开');
  const ok = await wizard.quickCreate();
  assert.strictEqual(ok, true, 'quickCreate 应成功');
  assert.strictEqual(commits, 1, '必须恰好一次 commit');
  assert.strictEqual(app.doc.history.length, hist0 + 1, '必须恰好一条历史');
  assert.ok(cbInfo && cbInfo.template_id === openedOpts.recommendations[0].template_id,
    '应使用首个推荐模板：' + (cbInfo && cbInfo.template_id));
  const ops = app.doc.history[hist0].ops;
  assert.ok(!ops.some(op => op.op === 'apply_journal' || op.op === 'set_canvas'),
    'quickCreate 画布应保持不变');
  assert.strictEqual(app.doc.canvas.width_mm, canvas0.width_mm);
  console.log(JSON.stringify({ok: true}));
})().catch(err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
""" % json.dumps(DATA))
        self.assertTrue(out["ok"])

    def test_mapping_memory_lru(self):
        """c) 映射记忆：同名同表头重开沿用；表头不同不套用；不存画布。"""
        out = run_node(r"""
const data = %s;
function makeLS() {
  const m = {};
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    key: i => Object.keys(m)[i],
    get length() { return Object.keys(m).length; },
    _map: m
  };
}
global.localStorage = makeLS();
const CSV_A = 'condition,value_a,value_b,sem\nctrl,1.2,10.1,0.2\ntreat,2.1,20.3,0.3\n';
const CSV_B = 'condition,value_a,value_c,sem\nctrl,1.2,5.5,0.2\ntreat,2.1,7.7,0.3\n';
(async () => {
  let w1 = null, w2 = null, w3 = null;
  const origOpen = global.DataWizard.open;
  global.DataWizard.open = (o) => {
    const w = origOpen(o);
    if (!w1) w1 = w; else if (!w2) w2 = w; else w3 = w;
    return w;
  };
  // 第一次：改映射 y→value_b 后创建成功 → 写入记忆
  global.Import._applyDataTable(CSV_A, 'demo-mem.csv', () => {});
  assert.ok(w1);
  w1.setMapping('y', 'value_b');
  const d1 = w1.draft();
  const ok1 = await w1.create();
  assert.strictEqual(ok1, true);
  // 同名同表头重开 → 沿用上次 templateId 与 mapping
  global.Import._applyDataTable(CSV_A, 'demo-mem.csv', () => {});
  assert.ok(w2, '第二次应打开向导');
  const d2 = w2.draft();
  assert.strictEqual(d2.templateId, d1.templateId, 'templateId 应沿用');
  assert.deepStrictEqual(d2.mapping, d1.mapping, 'mapping 应沿用');
  // 记忆值不含画布字段
  const ls = global.localStorage;
  let checked = 0;
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (!k || k.indexOf('figwizard:last:') !== 0) continue;
    checked++;
    const rec = JSON.parse(ls.getItem(k));
    assert.ok(!('canvas' in rec) && !('canvasChoice' in rec),
      '记忆不应包含画布：' + k);
    assert.strictEqual(typeof rec.ts, 'number');
  }
  assert.ok(checked >= 1, '应至少写入一条记忆');
  // 表头不同（同文件名）→ 键不同，不套用
  global.Import._applyDataTable(CSV_B, 'demo-mem.csv', () => {});
  assert.ok(w3, '第三次应打开向导');
  const d3 = w3.draft();
  assert.notStrictEqual(d3.mapping.y, 'value_b',
    '表头不同不应套用旧映射（value_b 列已不存在）');
  w3.closeModal();
  console.log(JSON.stringify({ok: true}));
})().catch(err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
""" % json.dumps(DATA))
        self.assertTrue(out["ok"])

    def test_g07_date_x_excluded_zero(self):
        """e) G07：日期 x 的 line_multi 排除行数为 0，drawn=渲染点数。"""
        out = run_node(r"""
(async () => {
const rows = [];
for (let i = 0; i < 40; i++) {
  rows.push(['2024-01-' + String((i % 28) + 1).padStart(2, '0') +
    ' ' + String(i % 24).padStart(2, '0') + ':00', i * 1.5, 'G' + (i % 3)]);
}
const data = {columns: ['time', 'value', 'group'], rows: rows};
const mapping = {x: 'time', y: 'value', group: 'group'};
// 1) renderableRows 直接断言：复用 prepareXY → 40 行全部画出
const rr = FigData.renderableRows('line_multi', data, mapping);
assert.strictEqual(rr.total, 40);
assert.strictEqual(rr.drawn, 40, '日期 x 不应被排除：' + JSON.stringify(rr));
assert.strictEqual(rr.excluded, 0);
// 2) 渲染器本体不抛错（同一映射真实渲染成功）
const tplId = FigPresets.templates().filter(t => t.chart_type === 'line_multi')[0].id;
const built = FigPresets.templateFromStats(tplId, data, {mapping: mapping});
assert.ok(built && built.chart, 'templateFromStats 应成功');
// 3) 向导显示「排除的行：0 / 40」
let wizard = null;
const origOpen = global.DataWizard.open;
global.DataWizard.open = (o) => { wizard = origOpen(o); return wizard; };
wizard = origOpen({
  filename: 'dates.csv', data: data,
  recommendations: [{template_id: tplId, score: 1, reasons: []}],
  currentCanvas: {width_mm: 120, height_mm: 90, dpi: 300},
  buildDraft: (templateId, map, choice, title) => {
    const opts = {journal_id: null, palette_id: null};
    if (map && Object.keys(map).length) opts.mapping = map;
    return FigPresets.templateFromStats(templateId, data, opts);
  },
  onCreate: () => Promise.resolve(true)
});
wizard.setMapping('x', 'time');
wizard.setMapping('y', 'value');
wizard.setMapping('group', 'group');
const txt = wizard.body.textContent;
assert.ok(txt.includes('排除的行：0 / 40'),
  '向导应显示排除的行：0 / 40，实际：' + (txt.match(/排除的行[^\n]*/) || ['?'])[0]);
console.log(JSON.stringify({ok: true, drawn: rr.drawn}));
})().catch(err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
""")
        self.assertTrue(out["ok"])
        self.assertEqual(out["drawn"], 40)

    def test_duplicate_x_stats(self):
        """G22：duplicateXStats 折线折返统计（真实读 examples/sample.csv）。

        sample.csv = 4 category × 2 group(g1/g2) × 5 time，共 40 行。
        推荐映射 {x:time, y:value, group:category} → 每条 category 线在每个
        日期有 g1、g2 两点 → 同线同 x 折返。实算：series=4、dupX=20、
        dupPoints=40、maxPerX=2、splitColumns 含「group」。
        """
        out = run_node(r"""
(async () => {
const fs = require('fs');
const csv = fs.readFileSync('../examples/sample.csv', 'utf8');
const data = FigData.parseCSV(csv);
const mapping = {x: 'time', y: 'value', group: 'category'};
const st = FigData.duplicateXStats('line_multi', data, mapping);
assert.strictEqual(st.applicable, true);
assert.strictEqual(st.series, 4, 'series 应为 4：' + JSON.stringify(st));
assert.strictEqual(st.dupX, 20, 'dupX 应为 20：' + JSON.stringify(st));
assert.strictEqual(st.dupPoints, 40, 'dupPoints 应为 40：' + JSON.stringify(st));
assert.strictEqual(st.maxPerX, 2, 'maxPerX 应为 2：' + JSON.stringify(st));
assert.ok(st.splitColumns.indexOf('group') >= 0,
  'splitColumns 应含 group：' + JSON.stringify(st.splitColumns));
// 每条线每个 x 只有一个点 → dupX=0
const d2 = {columns: ['x', 'y', 'g'],
  rows: [['a', 1, 'A'], ['b', 2, 'A'], ['a', 3, 'B'], ['b', 4, 'B']]};
const st2 = FigData.duplicateXStats('line_multi', d2, {x: 'x', y: 'y', group: 'g'});
assert.strictEqual(st2.applicable, true);
assert.strictEqual(st2.dupX, 0, '无重复应 dupX=0：' + JSON.stringify(st2));
// 非折线图型 → applicable:false
const stb = FigData.duplicateXStats('bar', data, {x: 'category', y: 'value'});
assert.strictEqual(stb.applicable, false, 'bar 应 applicable:false');
// 映射缺失 → applicable:false
const stm = FigData.duplicateXStats('line_multi', data, {x: 'time'});
assert.strictEqual(stm.applicable, false, '缺映射应 applicable:false');
console.log(JSON.stringify({ok: true, st: st, st2: st2}));
})().catch(err => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
""")
        self.assertTrue(out["ok"])
        self.assertEqual(out["st"]["series"], 4)
        self.assertEqual(out["st"]["dupX"], 20)
        self.assertEqual(out["st"]["dupPoints"], 40)
        self.assertEqual(out["st"]["maxPerX"], 2)
        self.assertIn("group", out["st"]["splitColumns"])
        self.assertEqual(out["st2"]["dupX"], 0)


if __name__ == "__main__":
    unittest.main()
