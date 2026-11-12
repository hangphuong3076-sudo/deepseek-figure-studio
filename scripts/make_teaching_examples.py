# -*- coding: utf-8 -*-
"""生成 examples/teaching 三组教学示例工程（内核真实构建，合成演示数据）。

用途：空文档任务卡「教学示例」与 C01–C03 演示。全部标注 demo；
生成后用 docio.load_project 做完整性校验。运行：在 mcp/ 下
python -B ../scripts/make_teaching_examples.py
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MCP = ROOT / "mcp"
OUT = ROOT / "examples" / "teaching"

NODE_SCRIPT = r"""
const fs = require('fs');
for (const f of ['figdoc', 'diagram', 'ops', 'science', 'palette', 'presets', 'data',
                 'lineage', 'render', 'tiff', 'export', 'ai', 'storage'])
  require('./lib/' + f + '.js');
FigPresets.load({
  journals: JSON.parse(fs.readFileSync('../presets/journals.json', 'utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json', 'utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json', 'utf8'))
});

function projectize(doc, label) {
  // 与 FigStore.projectFromDoc 同构：history 提到顶层，doc.history 清空
  const history = doc.history || [];
  const d = JSON.parse(JSON.stringify(doc));
  d.history = [];
  d.title = label;
  (d.meta = d.meta || {});
  d.meta.teaching_demo = true;
  d.meta.demo_note = '教学示例：全部为合成演示数据，不代表真实实验结果。';
  return { format: 'figure-project', format_version: '1.0', doc: d,
    history: history, assets: {} };
}

// ---------- C01 统计图（分组柱图 + 重复观测 + 误差线 + 缺失值） ----------
let doc1 = FigDoc.create({ title: '教学：数据统计图', width_mm: 89, height_mm: 70 });
{
  const rows = [
    ['ctrl', 1.20], ['ctrl', 1.35], ['ctrl', 1.28],
    ['low', 1.90], ['low', 2.05], ['low', null],
    ['high', 2.80], ['high', 2.65], ['high', 2.95],
  ];
  const el = FigData.makeChartElement(
    { columns: ['condition', 'response'], rows },
    { chart_type: 'bar', mapping: { x: 'condition', y: 'response' } });
  el.parent_id = null;
  el.name = '(a)';
  doc1 = FigOps.applyAll(doc1, [{ op: 'add_element', element: el }], { label: '建图' }).doc;
  const cid = doc1.elements.find(e => e.type === 'chart').id;
  doc1 = FigOps.applyAll(doc1, [
    { op: 'set_chart_properties', targets: [cid], properties: {
      axes: { xLabel: '处理组', yLabel: '响应值（任意单位，演示）' } } },
    { op: 'set_scientific_contract', contract: { statistics: { [cid]: {
      n_definition: '每处理组 3 个技术重复（演示）',
      biological_replicates: 0, technical_replicates: 3,
      center: 'mean', spread: 'SD', uncertainty_source: 'replicates',
      unit_y: 'a.u.（演示）', source_data: 'teaching-c01.csv（合成）' } } } }
  ], { label: '统计申报' }).doc;
}

// ---------- C02 XPS 表征（raw + 用户拟合列 + 峰标注 + 反向轴） ----------
let doc2 = FigDoc.create({ title: '教学：XPS 高分辨谱', width_mm: 89, height_mm: 70 });
{
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const be = 280 + i * 0.12;
    const raw = 1200 * Math.exp(-Math.pow((be - 285.1) / 1.1, 2)) + 200 * Math.exp(-Math.pow((be - 286.4) / 1.0, 2)) + 60;
    const fit = 1180 * Math.exp(-Math.pow((be - 285.1) / 1.1, 2)) + 210 * Math.exp(-Math.pow((be - 286.4) / 1.0, 2)) + 55;
    const base = 55 + (be - 280) * 0.8;
    rows.push([Number(be.toFixed(2)), Math.round(raw), Math.round(fit), Math.round(base)]);
  }
  const el = FigData.makeChartElement(
    { columns: ['binding_energy', 'intensity', 'fit_total', 'baseline'], rows },
    { chart_type: 'line', mapping: { x: 'binding_energy', y: 'intensity' } });
  el.name = '(a)';
  doc2 = FigOps.applyAll(doc2, [{ op: 'add_element', element: el }], { label: '建图' }).doc;
  const cid = doc2.elements.find(e => e.type === 'chart').id;
  doc2 = FigOps.applyAll(doc2, [
    { op: 'set_chart_properties', targets: [cid], properties: {
      characterization: {
        technique: 'XPS（演示数据）',
        x_reverse: true,
        x_label: 'Binding energy (eV)', y_label: 'Intensity (counts, demo)',
        curves: [ { role: 'fit', column: 'fit_total', label: 'fit (demo)' },
                  { role: 'baseline', column: 'baseline', label: 'baseline (demo)' } ],
        fit_model: 'Gaussian（演示）',
        fit_source: 'provided_by_user_fit',
        peak_annotations: [ { x: 285.1, label: 'C–C (demo)' }, { x: 286.4, label: 'C–O (demo)' } ]
      } } }
  ], { label: '表征参数' }).doc;
}

// ---------- C03 四面板（2 表征 + 1 统计 + 1 多系列折线） ----------
let doc3 = FigDoc.create({ title: '教学：四面板图版', width_mm: 183, height_mm: 140 });
{
  const panel = { id: 'panel-t', type: 'panel', name: '四面板（演示）', z: 0,
    transform: { x: 6, y: 6, w: 171, h: 128, rotation: 0 }, style: {},
    children: [], panelLayout: { cols: 2, rows: 2, gap_mm: 3, padding_mm: 2,
      label: null, labelPosition: 'top-left', labelStyle: { fontSizePt: 8 } }, clip: false };
  doc3 = FigOps.applyAll(doc3, [{ op: 'add_element', element: panel }], { label: '版式' }).doc;
  const ids = [];
  function add(i, chartType, mapping, rows, name) {
    const el = FigData.makeChartElement(
      { columns: Object.keys(mapping).map(k => mapping[k]), rows },
      { chart_type: chartType, mapping });
    el.parent_id = 'panel-t';
    el.name = name;
    doc3 = FigOps.applyAll(doc3, [{ op: 'add_element', element: el }], { label: 'c' + i }).doc;
    ids.push(el.id);
    return el.id;
  }
  const rowsA = [], rowsB = [];
  for (let i = 0; i < 40; i++) {
    const be = 278 + i * 0.25;
    rowsA.push([Number(be.toFixed(2)), Math.round(900 * Math.exp(-Math.pow((be - 284.9) / 1.2, 2)) + 50)]);
    rowsB.push([Number((200 + i * 12).toFixed(1)), Math.round(300 + 200 * Math.sin(i / 5) + i * 3)]);
  }
  add(0, 'line', { x: 'be', y: 'int' }, rowsA, '(a)');
  add(1, 'line', { x: 'shift', y: 'int2' }, rowsB, '(b)');
  add(2, 'bar', { x: 'cond', y: 'val' },
    [['ctrl', 1.2], ['low', 2.0], ['high', 2.8]], '(c)');
  add(3, 'line_multi', { x: 'x', y: 'y', group: 'sample' },
    [[1, 10, 'S1'], [2, 12, 'S1'], [3, 15, 'S1'], [1, 20, 'S2'], [2, 18, 'S2'], [3, 22, 'S2']], '(d)');
  const pel = doc3.elements.find(e => e.id === 'panel-t');
  pel.children = ids.slice();
  // 表征参数（a 为 XPS 风格反向轴）
  doc3 = FigOps.applyAll(doc3, [
    { op: 'set_chart_properties', targets: [ids[0]], properties: {
      characterization: { technique: 'XPS（演示）', x_reverse: true,
        x_label: 'Binding energy (eV)', y_label: 'Intensity (demo)' } } },
    { op: 'set_chart_properties', targets: [ids[1]], properties: {
      characterization: { technique: 'Raman（演示）',
        x_label: 'Raman shift (cm-1, demo)', y_label: 'Intensity (demo)' } } }
  ], { label: '表征参数' }).doc;
}

const out = {
  'teaching-c01-statistics.figureproj.json': projectize(doc1, '教学：数据统计图（演示数据）'),
  'teaching-c02-xps.figureproj.json': projectize(doc2, '教学：XPS 高分辨谱（演示数据）'),
  'teaching-c03-four-panel.figureproj.json': projectize(doc3, '教学：四面板图版（演示数据）')
};
for (const [name, project] of Object.entries(out)) {
  fs.writeFileSync('../examples/teaching/' + name,
    JSON.stringify(project), 'utf8');
}
console.log(JSON.stringify({ ok: true, files: Object.keys(out) }));
"""

INDEX = {
    "note": "教学示例全部为合成演示数据（demo），不代表真实实验结果。",
    "items": [
        {"file": "teaching-c01-statistics.figureproj.json",
         "label": "统计柱图（重复观测+误差）",
         "description": "C01 教学：分组柱图、重复观测均值、SD 误差线、缺失值排除；下一步试试替换数据或改轴标签"},
        {"file": "teaching-c02-xps.figureproj.json",
         "label": "XPS 高分辨谱",
         "description": "C02 教学：反向结合能轴、用户拟合/基线列、峰标注；下一步试试修改峰标注或归一化"},
        {"file": "teaching-c03-four-panel.figureproj.json",
         "label": "四面板图版",
         "description": "C03 教学：两表征+统计+多系列折线；下一步试试只更新 (d) 子图数据或统一实验组颜色"},
    ],
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(["node", "-e", NODE_SCRIPT], cwd=str(MCP),
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=120)
    if proc.returncode:
        print(proc.stdout, proc.stderr)
        raise SystemExit(1)
    (OUT / "index.json").write_text(
        json.dumps(INDEX, ensure_ascii=False, indent=2), encoding="utf-8")
    print(proc.stdout.strip())
    # docio 完整性校验
    sys.path.insert(0, str(MCP / "py"))
    import docio  # noqa: E402
    for item in INDEX["items"]:
        loaded = docio.load_project(str(OUT / item["file"]))
        assert loaded["doc"]["elements"], item["file"]
        print("verified:", item["file"], "elements:", len(loaded["doc"]["elements"]))


if __name__ == "__main__":
    main()
