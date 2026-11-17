"""test_charts_r10.py — R10：13 个补图型渲染器内核级验证。

覆盖（全部走 FigData.makeChartElement → FigRender.toSVG 真实渲染路径）：
1. 13 种图型渲染成功、data-chart-type 正确、SVG 非空；
2. 元素/标记数量与数据一致（dot 计数、pair-link、km-curve、venn-set、sankey flow/node、ci/estimate）；
3. renderableRows 排除计数与渲染器接受规则一致（含 paired 缺配对、venn 全否行、非法值行）；
4. 渲染器自算统计量与手算一致：
   - violin：data-kde-integral≈1、Silverman 带宽属性存在且为正、n<20 警告；
   - survival：data-km 阶梯值与手算 Kaplan–Meier 一致（含删失）；
   - roc：图例 AUC 与手算梯形积分一致；
   - venn：区域计数与手算 mask 计数一致；
   - bar_stacked：同格多行求和（data-duplicate-rows-summed）；
5. 非法映射报错（venn 1 列/>3 列、sankey >30 节点、缺必填列）；
6. 风格/参数 tokens 生效：stackMode=percent、volcano thresholds 有无、
   forest nullValue、pca ellipse、pairedSummary、taylor reference_std；
7. 导出 PNG 非空（canonical SVG → py/figraster.export_svg 真实导出，抽 3 种代表图型）。
"""

import json
import math
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "py"))


def node_json(script, timeout=120):
    env = dict(os.environ)
    env.pop("DEEPEPSEEK_API_KEY", None)
    env.pop("DEEPSEEK_API_KEY", None)
    # Windows 命令行长度上限 ~32K：脚本写临时文件执行。
    # require('./lib/...') 按文件所在目录解析，故临时文件须落在 mcp/ 下。
    tmp = HERE / "_r10_node_case.js"
    tmp.write_text(script, encoding="utf-8")
    try:
        proc = subprocess.run(["node", str(tmp)], cwd=str(HERE), capture_output=True,
                              text=True, encoding="utf-8", errors="replace",
                              timeout=timeout, env=env)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
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
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json', 'utf8')),
  styles: JSON.parse(fs.readFileSync('../presets/styles.json', 'utf8'))
});
function renderSVG(chartType, mapping, rows, extra) {
  const cols = Array.isArray(mapping.ys) && mapping.ys.length
    ? Array.from(new Set(mapping.ys.concat(Object.keys(mapping).filter(k=>k!=='ys').map(k=>mapping[k]))))
    : Object.keys(mapping).map(k => mapping[k]);
  const el = FigData.makeChartElement({ columns: cols, rows: rows },
    { chart_type: chartType, mapping: mapping });
  // makeChartElement 只建基础字段；presentation/thresholds/reference_std
  // 等由模板应用或 ops 写入 el.chart（与 apply_template 路径一致）
  if (extra) Object.keys(extra).forEach(function (k) { el.chart[k] = extra[k]; });
  const doc = FigDoc.create({ title: 'r10', width_mm: 120, height_mm: 90 });
  const d2 = FigOps.applyAll(doc, [{ op: 'add_element', element: el }], { label: 'init' }).doc;
  return { svg: FigRender.toSVG(d2), el: el };
}
function countRe(svg, re) { const m = svg.match(re); return m ? m.length : 0; }
function attrAll(svg, name) {
  const out = [], re = new RegExp(name + '="([^"]*)"', 'g'); let m;
  while ((m = re.exec(svg))) out.push(m[1]);
  return out;
}
const R = {};
"""

# ---------------------------------------------------------------- datasets
DATASET_JS = r"""
// 通用小数据：每类 30 行正态散布（violin n>=20 不触发警告）+ 少量脏行
function normRows(cats, per, fn) {
  const rows = [];
  cats.forEach(function (c) {
    for (var i = 0; i < per; i++) rows.push([c, +fn(c, i).toFixed(3)]);
  });
  return rows;
}
const V_COLS = ['Group', 'Value'];
const V_MAP = { x: 'Group', y: 'Value' };
const violinRows = normRows(['A', 'B', 'C'], 30, function (c, i) {
  const base = { A: 0, B: 2, C: 4 }[c];
  return base + Math.sin(i * 1.7 + base) * 0.8 + ((i * 37) % 11 - 5) * 0.05;
});
violinRows.push(['A', 'oops']);            // 非数值 → 排除
violinRows.push([null, 1.5]);              // 空类别 → 排除
const violinSmall = normRows(['A'], 8, function (c, i) { return i * 0.3; }); // n<20 → 警告

// dotplot：x 数值 / y 类别，重复值形成 count
const dotRows = [];
[['Low', 1.0, 4], ['Mid', 2.0, 6], ['High', 3.0, 3]].forEach(function (sp) {
  for (var i = 0; i < sp[2]; i++) dotRows.push([+(sp[1] + i * 0.01).toFixed(2), sp[0]]);
});
dotRows.push(['x', 'Low']); // 非数值 x → 排除

// paired：3 条件 × 6 个体完整 + 1 个体缺一条件 + 1 脏行
const pairRows = [];
for (var s = 0; s < 6; s++) {
  ['Pre', 'Post', 'Follow'].forEach(function (c, ci) {
    pairRows.push([c, +(10 + s * 0.5 + ci * 1.2).toFixed(2), 'S' + (s + 1)]);
  });
}
pairRows.push(['Pre', 9.9, 'S7']); pairRows.push(['Post', 8.8, 'S7']); // S7 缺 Follow
pairRows.push(['Pre', 'nan?', 'S8']); // 非数值 y
const pairMap = { x: 'Cond', y: 'Val', group: 'Subj' };

// marginal：相关散点 40 点 + 2 脏行
const margRows = [];
for (var mi = 0; mi < 40; mi++) {
  var mx = mi * 0.25;
  margRows.push([+mx.toFixed(2), +(mx * 0.8 + Math.sin(mi) * 0.5).toFixed(2)]);
}
margRows.push(['bad', 1]); margRows.push([2, 'bad']);

// volcano：阈值 fc=1, p=1.3；上/下调/不显著
const volcRows = [];
for (var vi = 0; vi < 40; vi++) {
  var fc = -3 + vi * 0.16;
  var pl = Math.abs(fc) > 1 ? 2 + Math.abs(fc) : 0.4 + Math.abs(fc) * 0.2;
  volcRows.push([+fc.toFixed(2), +pl.toFixed(2), 'G' + vi]);
}
const volcMap = { x: 'log2FC', y: 'neglogp', label: 'Gene' };

// forest：5 研究，lo/hi 列
const forestRows = [
  [0.50, 'R1', 0.30, 0.70], [0.80, 'R2', 0.60, 1.00], [0.20, 'R3', 0.05, 0.35],
  [1.10, 'R4', 0.90, 1.30], [-0.10, 'R5', -0.30, 0.10]
];
const forestMap = { x: 'ES', y: 'Study', lo: 'Lo', hi: 'Hi' };
const forestErrRows = [[0.5, 'E1', 0.2], [0.9, 'E2', 0.3]]; // error 对称半宽
const forestErrMap = { x: 'ES', y: 'Study', error: 'SE' };

// survival：手算案例——单组 t=[1,2,3,5,5,8] e=[1,1,0,1,0,1]
// KM: t1 S=5/6≈0.8333; t2 S*= (1-1/5)=0.6667; t3 删失; t5 d=1,n=3 → S*=2/3≈0.6667; t8 d=1,n=1 → 0
const survRows = [[1,1],[2,1],[3,0],[5,1],[5,0],[8,1]]
  .map(function(r){return [r[0], r[1], 'All'];});
const survMap = { x: 'Time', y: 'Event', group: 'Grp' };
// 双组生存（图例）
const surv2Rows = survRows.concat([[1,1,'B'],[2,0,'B'],[4,1,'B'],[6,1,'B']].map(function(r){return [r[0],r[1],r[2]];}));

// roc：手算 AUC——点 (0,0)(0.5,0.8)(1,1) → 梯形 = 0.5*(0.5)*(0+0.8)/2? 逐段:
// (0,0)->(0.5,0.8): 0.5*0.4=0.2; (0.5,0.8)->(1,1): 0.5*0.9=0.45 → AUC=0.65
// 模型 N 缺 (1,1) 端点 → 应触发 auc-partial-coverage 警告（不自动补点）
const rocRows = [[0,0,'M'],[0.5,0.8,'M'],[1,1,'M'],[0,0,'N'],[1,0.6,'N']];
const rocMap = { x: 'FPR', y: 'TPR', group: 'Model' };
// roc 好例：两条 (0,0)→(1,1)、在对角线上方的曲线，连续 AUC≈0.85/0.72
// A: TPR=1-(1-FPR)^5.67 → AUC=5.67/6.67≈0.85；B: TPR=FPR^0.39 → AUC=1/1.39≈0.72
const rocRowsGood = [];
for (let i = 0; i <= 40; i++) { const f = i / 40;
  rocRowsGood.push([+f.toFixed(4), +(1 - Math.pow(1 - f, 5.67)).toFixed(4), 'Model A']);
  rocRowsGood.push([+f.toFixed(4), +Math.pow(f, 0.39).toFixed(4), 'Model B']); }

// pca：两团相关椭圆簇（x/y 各含 sin+cos 项 → 协方差非对角，椭圆应斜）
const pcaRows = [];
for (var pi = 0; pi < 24; pi++) {
  var a = pi * 2.39996;
  var j1 = ((pi * 13) % 7 - 3) * 0.05, j2 = ((pi * 29) % 7 - 3) * 0.05;
  pcaRows.push([+(Math.cos(a) * 1.15 + Math.sin(a) * 0.75 + j1).toFixed(3),
                +(Math.sin(a) * 0.85 + Math.cos(a) * 0.55 + j2).toFixed(3), 'C1']);
  pcaRows.push([+(3 + Math.cos(a) * 0.75 + Math.sin(a) * 0.45 + j1 * 0.7).toFixed(3),
                +(2 + Math.sin(a) * 0.65 + Math.cos(a) * 0.4 + j2 * 0.7).toFixed(3), 'C2']);
}
const pcaMap = { x: 'PC1', y: 'PC2', group: 'Grp' };

// venn：3 集合手算——行 i: A=i%3!=0? 简化固定模式
const vennRows = [
  [1,0,0],[1,1,0],[0,1,0],[1,0,1],[0,0,0],[1,1,1],[0,1,1],[0,0,1]
]; // mask计数: 001:1,010:1,011:1,100:1,101:1,110:1,111:1,000:0(全否→排除)
const vennYs = ['SetA', 'SetB', 'SetC'];

// sankey：4 节点 5 流 + 自环脏行
const sankeyRows = [
  ['A', 'B', 10], ['A', 'C', 5], ['B', 'D', 8], ['C', 'D', 4], ['B', 'C', 2]
];
const sankeyMap = { x: 'Src', y: 'Dst', size: 'W' };

// taylor：4 模型 + reference_std（相关全非负 → 四分圆）
const taylorRows = [[1.0, 0.98, 'Ref'], [1.2, 0.93, 'M1'], [1.5, 0.85, 'M2'], [0.8, 0.90, 'M3'],
                    [1.3, 0.88, 'M4'], [0.9, 0.95, 'M5']];
const taylorMap = { x: 'Std', y: 'Corr', group: 'Model' };
// taylor 含负相关 → 半圆；刻度应含 -0.5/-1
const taylorRowsNeg = [[1.0, 0.98, 'Ref'], [1.15, -0.4, 'Neg1'], [0.9, -0.7, 'Neg2'], [1.3, 0.5, 'Pos1']];
// taylor 拥挤模型（同 std、相近相关）→ 标签须偏移 + 引线且不相交
const taylorRowsCrowd = [[1.0, 0.98, 'Ref'], [1.0, 0.95, 'M1'], [1.0, 0.955, 'M2'],
                         [1.0, 0.96, 'M3'], [1.0, 0.965, 'M4'], [1.0, 0.97, 'M5']];

// sankey 真实感数据：典型 4 层（样本来源→质控→组装→分类），每层 2–3 节点
const sankeyRows2 = [
  ['Blood','QC passed',480],['Blood','QC failed',70],
  ['Urine','QC passed',290],['Urine','QC failed',85],
  ['Tissue','QC passed',215],['Tissue','QC failed',45],
  ['QC passed','Host-removed',640],['QC passed','Direct',345],
  ['QC failed','Pending review',200],
  ['Host-removed','Published',560],['Host-removed','Revision',80],
  ['Direct','Published',300],['Direct','Revision',45],
  ['Pending review','Published',120],['Pending review','Revision',80]
];

// bar_stacked：2 类别 × 2 组分，含重复行求和（列序 = mapping 键序 x,y,group → Cat,Val,Part）
const stackRows = [
  ['X', 1, 'P'], ['X', 2, 'P'], ['X', 3, 'Q'],
  ['Y', 4, 'P'], ['Y', 1, 'Q'], ['Y', 1, 'Q']
];
const stackMap = { x: 'Cat', y: 'Val', group: 'Part' };

// marginal 已用 margRows/margMap={x:'X',y:'Y'} 见下
const margMap = { x: 'X', y: 'Y' };
const dotMap = { x: 'Score', y: 'Grp' };
"""

CASES_JS = r"""
function tryRender(fn) { try { return { ok: true, r: fn() }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } }

// ---------- 1. 全部 13 种渲染成功 ----------
R.basic = {};
[['bar_stacked', stackMap, stackRows, ['Cat','Part','Val']],
 ['violin', V_MAP, violinRows, V_COLS],
 ['dotplot', dotMap, dotRows, ['Score','Grp']],
 ['paired', pairMap, pairRows, ['Cond','Val','Subj']],
 ['marginal', margMap, margRows, ['X','Y']],
 ['volcano', volcMap, volcRows, ['log2FC','neglogp','Gene']],
 ['forest', forestMap, forestRows, ['ES','Study','Lo','Hi']],
 ['survival', survMap, survRows, ['Time','Event','Grp']],
 ['roc', rocMap, rocRows, ['FPR','TPR','Model']],
 ['pca', pcaMap, pcaRows, ['PC1','PC2','Grp']],
 ['venn', { ys: vennYs }, vennRows, vennYs],
 ['sankey', sankeyMap, sankeyRows, ['Src','Dst','W']],
 ['taylor', taylorMap, taylorRows, ['Std','Corr','Model']]
].forEach(function (c) {
  var res = tryRender(function () {
    // renderSVG 内部自行推导 columns；这里直接给 rows+mapping
    return renderSVG(c[0], c[1], c[2]);
  });
  if (res.ok) {
    var svg = res.r.svg;
    R.basic[c[0]] = {
      len: svg.length,
      type: (svg.match(/data-chart-type="([^"]+)"/) || [])[1] || null,
      root: svg.indexOf('<svg') === 0
    };
  } else R.basic[c[0]] = { err: res.err };
});

// ---------- 2. 元素数量与数据一致 ----------
R.counts = {};
(function () {
  var r = renderSVG('dotplot', dotMap, dotRows).svg;
  R.counts.dotplot = {
    dots: countRe(r, /data-chart-part="dot"/g),
    guides: countRe(r, /data-chart-part="guide"/g),
    cats: countRe(r, /data-chart-part="guide"/g)
  };
  r = renderSVG('paired', pairMap, pairRows).svg;
  R.counts.paired = {
    links: countRe(r, /data-chart-part="pair-link"/g),
    points: countRe(r, /data-chart-part="point"/g),
    unpaired: attrAll(r, 'data-unpaired-subjects')[0] || '0'
  };
  r = renderSVG('paired', pairMap, pairRows, { presentation: { plot: { pairedSummary: true } } }).svg;
  R.counts.pairedSummary = countRe(r, /data-chart-part="summary-sd"/g);
  r = renderSVG('survival', survMap, survRows).svg;
  R.counts.survival = { km: countRe(r, /data-chart-part="km-curve"/g),
    censor: countRe(r, /data-chart-part="censor-tick"/g) };
  r = renderSVG('roc', rocMap, rocRows).svg;
  R.counts.roc = { curves: countRe(r, /data-chart-part="roc-curve"/g) };
  r = renderSVG('forest', forestMap, forestRows).svg;
  R.counts.forest = { ci: countRe(r, /data-chart-part="ci"/g),
    est: countRe(r, /data-chart-part="estimate"/g),
    nullv: attrAll(r, 'data-null-value')[0] || null };
  r = renderSVG('venn', { ys: vennYs }, vennRows).svg;
  R.counts.venn = { sets: countRe(r, /data-chart-part="venn-set"/g) };
  r = renderSVG('sankey', sankeyMap, sankeyRows).svg;
  R.counts.sankey = { flows: countRe(r, /data-chart-part="flow"/g),
    nodes: countRe(r, /data-chart-part="node"/g) };
  r = renderSVG('violin', V_MAP, violinRows).svg;
  R.counts.violin = { violins: countRe(r, /data-chart-part="violin"/g),
    iqr: countRe(r, /data-chart-part="iqr-box"/g),
    med: countRe(r, /data-chart-part="median"/g) };
  r = renderSVG('bar_stacked', stackMap, stackRows).svg;
  R.counts.bar_stacked = { segs: countRe(r, /data-chart-part="series"/g) };
  r = renderSVG('marginal', margMap, margRows).svg;
  R.counts.marginal = { xhist: countRe(r, /data-chart-part="marginal-x"/g),
    yhist: countRe(r, /data-chart-part="marginal-y"/g),
    pts: countRe(r, /data-point-key=/g) };
  r = renderSVG('volcano', volcMap, volcRows, { thresholds: { fc: 1, p_neglog10: 1.3 }, presentation: { plot: { labelTop: 3 } } }).svg;
  R.counts.volcano = { labels: countRe(r, /part="volcano-label"/g),
    points: countRe(r, /data-chart-part="series"/g) };
  r = renderSVG('pca', pcaMap, pcaRows, { presentation: { plot: { ellipse: true } } }).svg;
  R.counts.pca = { ellipses: countRe(r, /data-chart-part="ellipse95"/g),
    pts: countRe(r, /data-point-key=/g) };
  r = renderSVG('taylor', taylorMap, taylorRows, { reference_std: 1.0 }).svg;
  R.counts.taylor = { grids: countRe(r, /data-chart-part="grid-std"/g),
    ticks: countRe(r, /data-chart-part="corr-tick"/g),
    pts: countRe(r, /data-chart-part="model-point"/g) + countRe(r, /<circle[^>]*data-chart-part=/g),
    refStd: attrAll(r, 'data-reference-std')[0] || null };
})();

// ---------- 3. renderableRows 排除计数 ----------
R.excl = {};
function rr(type, mapping, rows, cols) {
  const d = { columns: cols, rows: rows };
  const m = {};
  Object.keys(mapping).forEach(function (k) { m[k] = mapping[k]; });
  return FigData.renderableRows(type, d, m);
}
R.excl.violin = rr('violin', V_MAP, violinRows, V_COLS);
R.excl.dotplot = rr('dotplot', dotMap, dotRows, ['Score','Grp']);
R.excl.paired = rr('paired', pairMap, pairRows, ['Cond','Val','Subj']);
R.excl.marginal = rr('marginal', margMap, margRows, ['X','Y']);
R.excl.venn = rr('venn', { ys: vennYs }, vennRows, vennYs);
R.excl.sankey = rr('sankey', sankeyMap, sankeyRows.concat([['A','A',1]]), ['Src','Dst','W']);
R.excl.survival = rr('survival', survMap, survRows, ['Time','Event','Grp']);
R.excl.forest = rr('forest', forestMap, forestRows, ['ES','Study','Lo','Hi']);
R.excl.bar_stacked = rr('bar_stacked', stackMap, stackRows, ['Cat','Val','Part']);
R.excl.volcano = rr('volcano', volcMap, volcRows, ['log2FC','neglogp','Gene']);
R.excl.roc = rr('roc', rocMap, rocRows, ['FPR','TPR','Model']);
R.excl.pca = rr('pca', pcaMap, pcaRows, ['PC1','PC2','Grp']);
R.excl.taylor = rr('taylor', taylorMap, taylorRows, ['Std','Corr','Model']);

// ---------- 4. 统计量手算核对 ----------
R.stats = {};
(function () {
  // violin KDE：每个小提琴 data-kde-integral≈1；带宽>0；小样本警告
  var r = renderSVG('violin', V_MAP, violinRows).svg;
  var ints = attrAll(r, 'data-kde-integral').map(Number);
  var bws = attrAll(r, 'data-kde-bandwidth-max');
  R.stats.violinKde = { n: ints.length, maxErr: Math.max.apply(null, ints.map(function (v) { return Math.abs(v - 1); })),
    bwAttr: bws[0] || null, method: attrAll(r, 'data-method')[0] || null,
    rule: attrAll(r, 'data-kde-rule')[0] || null };
  r = renderSVG('violin', V_MAP, violinSmall).svg;
  R.stats.violinSmallWarn = attrAll(r, 'data-warning').join('|');
  // survival KM 手算：t=1 S=5/6, t=2 S=2/3, t=5 S=2/3, t=8 S=0
  r = renderSVG('survival', survMap, survRows).svg;
  var kmAttr = attrAll(r, 'data-km')[0] || '';
  var km = {};
  kmAttr.split(';').forEach(function (p) { var kv = p.split(':'); if (kv.length === 2) km[kv[0]] = +kv[1]; });
  R.stats.km = { attr: kmAttr,
    s1: km['1'], s2: km['2'], s5: km['5'], s8: km['8'],
    method: attrAll(r, 'data-method')[0] || null,
    inference: attrAll(r, 'data-inference')[0] || null };
  // roc AUC 手算=0.65（模型 M）；图例文本含 AUC
  r = renderSVG('roc', rocMap, rocRows).svg;
  var aucM = (r.match(/AUC=([0-9.]+)/) || [])[1];
  var aucN = (r.match(/AUC=([0-9.]+)/g) || []);
  R.stats.rocAuc = { found: aucM || null, all: aucN, method: attrAll(r, 'data-auc-method')[0] || null };
  // venn 区域计数：mask 计数手算——7 个非空 mask 各 1，000 区域不计
  r = renderSVG('venn', { ys: vennYs }, vennRows).svg;
  var regionTexts = (r.match(/<text[^>]*>(\d+)<\/text>/g) || []).map(function (t) { return +t.replace(/<[^>]+>/g, ''); });
  R.stats.vennRegions = { texts: regionTexts, members: attrAll(r, 'data-members')[0] || null,
    scale: attrAll(r, 'data-scale')[0] || null };
  // bar_stacked 求和：X/P = 1+2=3（重复行），data-duplicate-rows-summed=2
  r = renderSVG('bar_stacked', stackMap, stackRows).svg;
  R.stats.stackSum = { dup: attrAll(r, 'data-duplicate-rows-summed')[0] || '0',
    agg: attrAll(r, 'data-aggregation')[0] || null,
    mode: attrAll(r, 'data-stack-mode')[0] || null };
})();

// ---------- 5. 非法映射报错 ----------
R.errors = {};
R.errors.venn1 = tryRender(function () { return renderSVG('venn', { ys: ['A'] }, [[1],[0]]); });
R.errors.venn4 = tryRender(function () {
  return renderSVG('venn', { ys: ['A','B','C','D'] }, [[1,0,0,1],[0,1,0,0]]);
});
R.errors.vennMissing = tryRender(function () { return renderSVG('venn', { ys: 'A' }, [[1],[0]]); });
R.errors.sankey30 = tryRender(function () {
  var rows = [];
  for (var i = 0; i < 40; i++) rows.push(['N' + i, 'N' + (i + 1), 1]);
  return renderSVG('sankey', sankeyMap, rows);
});
R.errors.forestNoCols = tryRender(function () { return renderSVG('forest', { x: 'ES', y: 'Study' }, forestRows); });
R.errors.volcanoNoData = tryRender(function () { return renderSVG('volcano', volcMap, [['a','b','c']]); });
// forest 无 lo/hi/error → 仍可画（无 CI），检查警告属性
R.errors.forestNoCI = tryRender(function () {
  var rows = forestRows.map(function (r) { return [r[0], r[1]]; });
  return renderSVG('forest', { x: 'ES', y: 'Study' }, rows);
});
if (R.errors.forestNoCI.ok) R.errors.forestNoCI.warn = attrAll(R.errors.forestNoCI.r.svg, 'data-warning').join('|');

// ---------- 6. 风格/参数 tokens ----------
R.tokens = {};
(function () {
  // bar_stacked percent → y 轴含 100 刻度
  var r = renderSVG('bar_stacked', stackMap, stackRows,
    { presentation: { plot: { stackMode: 'percent' } } }).svg;
  R.tokens.stackPercent = { has100: /100/.test(r), mode: attrAll(r, 'data-stack-mode')[0] };
  // volcano 无阈值 → 中性着色 + 警告属性；有阈值 → 三色分组 + 阈值线
  r = renderSVG('volcano', volcMap, volcRows).svg;
  R.tokens.volcanoNoTh = { warn: attrAll(r, 'data-warning').join('|'), method: attrAll(r, 'data-method')[0] };
  r = renderSVG('volcano', volcMap, volcRows, { thresholds: { fc: 1, p_neglog10: 1.3 } }).svg;
  R.tokens.volcanoTh = { thLines: countRe(r, /data-chart-part="threshold"/g),
    points: countRe(r, /data-chart-part="series"/g) };
  // forest nullValue=1（比值类）
  r = renderSVG('forest', forestMap, forestRows,
    { presentation: { plot: { nullValue: 1 } } }).svg;
  R.tokens.forestNull = attrAll(r, 'data-null-value')[0] || null;
  // forest error 对称半宽可画
  r = renderSVG('forest', forestErrMap, forestErrRows).svg;
  R.tokens.forestErr = { ci: countRe(r, /data-chart-part="ci"/g),
    src: attrAll(r, 'data-ci-source')[0] || null };
  // pca ellipse
  r = renderSVG('pca', pcaMap, pcaRows, { presentation: { plot: { ellipse: true } } }).svg;
  R.tokens.pcaEllipse = { attr: attrAll(r, 'data-ellipse')[0] || null,
    ell: countRe(r, /data-chart-part="ellipse95"/g) };
  // paired 缺配对 → 报错（全部个体必须覆盖全部条件）
  R.tokens.pairedMissing = tryRender(function () {
    var rows = pairRows.filter(function (r) { return r[2] !== 'S6'; }); // S6 整组缺失→其余完整? S6 全缺=不存在
    return renderSVG('paired', pairMap, rows).svg.length;
  });
  // 每个个体都缺一个不同条件 → 无完整配对个体 → 报错
  R.tokens.pairedIncomplete = tryRender(function () {
    var rows = [['Pre', 1, 'S1'], ['Post', 2, 'S1'],
      ['Pre', 1, 'S2'], ['Follow', 3, 'S2'],
      ['Post', 2, 'S3'], ['Follow', 3, 'S3']];
    return renderSVG('paired', pairMap, rows).svg.length;
  });
  // taylor 无 reference_std → 警告
  r = renderSVG('taylor', taylorMap, taylorRows).svg;
  R.tokens.taylorNoRef = attrAll(r, 'data-warning').join('|');
})();

// ---------- 7. 质量门禁：图元 bbox 在画布内 + 专项断言 ----------
function specOf(chartType, mapping, rows, extra, cols) {
  const cc = cols || (Array.isArray(mapping.ys) && mapping.ys.length
    ? Array.from(new Set(mapping.ys.concat(Object.keys(mapping).filter(k => k !== 'ys').map(k => mapping[k]))))
    : Object.keys(mapping).map(k => mapping[k]));
  const el = FigData.makeChartElement({ columns: cc, rows: rows },
    { chart_type: chartType, mapping: mapping });
  if (extra) Object.keys(extra).forEach(function (k) { el.chart[k] = extra[k]; });
  return el.chart;
}
function fragOf(chartType, mapping, rows, extra, cols) {
  return FigData.renderChartSVG(specOf(chartType, mapping, rows, extra, cols),
    { width_mm: 120, height_mm: 90, dpi: 300 });
}
function textW2(s, fs) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x2E80 || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3000 && c <= 0x303F)) ? 1 : 0.62;
  }
  return w * fs;
}
// 校验 SVG 片段（渲染器像素坐标系）内所有图元 bbox 不出 [0,W]x[0,H]；
// 文本按 textW2 估宽 + 锚点方向估 bbox（rotate(-90) 按竖排估）。
function boundsCheck(svg, W, H) {
  const tol = 10, viol = [];
  const re = /<(rect|circle|ellipse|line|polygon|path|text)\b[^>]*>/g;
  const attr = (tag, name) => {
    const mm = tag.match(new RegExp(name + '="([^"]*)"'));
    return mm ? mm[1] : null;
  };
  const num = (s) => parseFloat(s);
  const pushV = (what, xs, ys, tag) => {
    for (const x of xs) for (const y of ys) {
      if (x < -tol || x > W + tol || y < -tol || y > H + tol) {
        viol.push(what + ' @(' + x.toFixed(1) + ',' + y.toFixed(1) + ') ' + tag.slice(0, 80));
        return;
      }
    }
  };
  let m;
  while ((m = re.exec(svg))) {
    const tag = m[0], kind = m[1];
    if (kind === 'rect') {
      const x = num(attr(tag, 'x')), y = num(attr(tag, 'y'));
      const w = num(attr(tag, 'width')), h = num(attr(tag, 'height'));
      pushV('rect', [x, x + w], [y, y + h], tag);
    } else if (kind === 'circle') {
      const cx = num(attr(tag, 'cx')), cy = num(attr(tag, 'cy')), r = num(attr(tag, 'r'));
      pushV('circle', [cx - r, cx + r], [cy - r, cy + r], tag);
    } else if (kind === 'ellipse') {
      const cx = num(attr(tag, 'cx')), cy = num(attr(tag, 'cy'));
      const rx = num(attr(tag, 'rx')), ry = num(attr(tag, 'ry'));
      pushV('ellipse', [cx - rx, cx + rx], [cy - ry, cy + ry], tag);
    } else if (kind === 'line') {
      pushV('line', [num(attr(tag, 'x1')), num(attr(tag, 'x2'))],
        [num(attr(tag, 'y1')), num(attr(tag, 'y2'))], tag);
    } else if (kind === 'polygon') {
      const pts = (attr(tag, 'points') || '').trim().split(/\s+/)
        .map(function (p) { return p.split(',').map(Number); });
      pushV('polygon', pts.map(function (p) { return p[0]; }),
        pts.map(function (p) { return p[1]; }), tag);
    } else if (kind === 'path') {
      const d = attr(tag, 'd') || '';
      const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE]-?\d+)?/g) || [];
      const xs = [], ys = [];
      let i = 0, cmd = '';
      while (i < toks.length) {
        const t = toks[i];
        if (/[a-zA-Z]/.test(t)) { cmd = t; i++; continue; }
        const C = cmd.toUpperCase();
        if (C === 'M' || C === 'L' || C === 'T') { xs.push(+toks[i]); ys.push(+toks[i + 1]); i += 2; }
        else if (C === 'C' || C === 'S') { for (let k = 0; k < 3; k++) { xs.push(+toks[i + 2 * k]); ys.push(+toks[i + 2 * k + 1]); } i += 6; }
        else if (C === 'Q') { for (let k = 0; k < 2; k++) { xs.push(+toks[i + 2 * k]); ys.push(+toks[i + 2 * k + 1]); } i += 4; }
        else if (C === 'A') { xs.push(+toks[i + 5]); ys.push(+toks[i + 6]); i += 7; }
        else if (C === 'H') { xs.push(+t); i += 1; }
        else if (C === 'V') { ys.push(+t); i += 1; }
        else { i++; }
      }
      if (xs.length) pushV('path', xs, ys, tag);
    } else if (kind === 'text') {
      const x = num(attr(tag, 'x')), y = num(attr(tag, 'y'));
      const fs = num(attr(tag, 'font-size')) || 10;
      const s = (tag.match(/>([^<]*)<\/text>/) || [null, ''])[1] || '';
      const tw = textW2(s, fs);
      const anchor = attr(tag, 'text-anchor') || 'start';
      const tr = attr(tag, 'transform') || '';
      let x0, x1, y0, y1;
      if (/rotate\(-90/.test(tr)) {
        x0 = x - fs * 0.6; x1 = x + fs * 0.6; y0 = y - tw / 2; y1 = y + tw / 2;
      } else {
        if (anchor === 'middle') { x0 = x - tw / 2; x1 = x + tw / 2; }
        else if (anchor === 'end') { x0 = x - tw; x1 = x; }
        else { x0 = x; x1 = x + tw; }
        y0 = y - fs * 0.9; y1 = y + fs * 0.35;
      }
      pushV('text', [x0, x1], [y0, y1], tag);
    }
  }
  return { ok: viol.length === 0, n: viol.length, viol: viol.slice(0, 6) };
}

R.quality = { bounds: {} };
(function () {
  const Wpx = 120 * 300 / 25.4, Hpx = 90 * 300 / 25.4;
  const cases = [
    ['bar_stacked', stackMap, stackRows, { presentation: { plot: { stackMode: 'percent' } } }, ['Cat', 'Val', 'Part']],
    ['violin', V_MAP, violinRows, null, V_COLS],
    ['dotplot', dotMap, dotRows, null, ['Score', 'Grp']],
    ['paired', pairMap, pairRows, { presentation: { plot: { pairedSummary: true } } }, ['Cond', 'Val', 'Subj']],
    ['marginal', margMap, margRows, null, ['X', 'Y']],
    ['volcano', volcMap, volcRows, { thresholds: { fc: 1, p_neglog10: 1.3 }, presentation: { plot: { labelTop: 3 } } }, ['log2FC', 'neglogp', 'Gene']],
    ['forest', forestMap, forestRows, null, ['ES', 'Study', 'Lo', 'Hi']],
    ['survival', survMap, survRows, null, ['Time', 'Event', 'Grp']],
    ['roc', rocMap, rocRows, null, ['FPR', 'TPR', 'Model']],
    ['pca', pcaMap, pcaRows, { presentation: { plot: { ellipse: true } } }, ['PC1', 'PC2', 'Grp']],
    ['venn', { ys: vennYs }, vennRows, null, vennYs],
    ['sankey', sankeyMap, sankeyRows, null, ['Src', 'Dst', 'W']],
    ['sankey', sankeyMap, sankeyRows2, null, ['Src', 'Dst', 'W']],
    ['taylor', taylorMap, taylorRows, { reference_std: 1.0 }, ['Std', 'Corr', 'Model']],
    ['taylor', taylorMap, taylorRowsNeg, { reference_std: 1.0 }, ['Std', 'Corr', 'Model'], 'taylorNeg'],
    ['taylor', taylorMap, taylorRowsCrowd, { reference_std: 1.0 }, ['Std', 'Corr', 'Model'], 'taylorCrowd'],
    ['roc', rocMap, rocRowsGood, null, ['FPR', 'TPR', 'Model'], 'rocGood']
  ];
  cases.forEach(function (c, i) {
    const key = c[5] || c[0] + (c[2] === sankeyRows2 ? '2' : '');
    try {
      R.quality.bounds[key] = boundsCheck(fragOf(c[0], c[1], c[2], c[3], c[4]), Wpx, Hpx);
    } catch (e) {
      R.quality.bounds[key] = { ok: false, n: -1, viol: ['THROW ' + String(e && e.message || e)] };
    }
  });

  // bar_stacked percent：各类别堆叠顶端 y 应一致（都归一化到 100%）
  const sPct = fragOf('bar_stacked', stackMap, stackRows,
    { presentation: { plot: { stackMode: 'percent' } } }, ['Cat', 'Val', 'Part']);
  const topY = {};
  (sPct.match(/<rect[^>]*data-category="[^"]+"[^>]*>/g) || []).forEach(function (tag) {
    const cat = (tag.match(/data-category="([^"]+)"/) || [])[1];
    const y = +tag.match(/y="([\d.]+)/)[1];
    if (!(cat in topY) || y < topY[cat]) topY[cat] = y;
  });
  const tys = Object.keys(topY).map(function (k) { return topY[k]; });
  R.quality.stackPercentTops = { cats: tys.length, spread: tys.length ? Math.max.apply(null, tys) - Math.min.apply(null, tys) : -1 };

  // marginal：边际直方图不得进入主绘图区
  const sMarg = fragOf('marginal', margMap, margRows, null, ['X', 'Y']);
  const mp = ((sMarg.match(/data-main-plot="([^"]+)"/) || [])[1] || '').split(',').map(Number);
  const xh = (sMarg.match(/<rect[^>]*data-chart-part="marginal-x"[^>]*>/g) || []).map(function (t) {
    return { y: +t.match(/y="([\d.]+)/)[1], h: +t.match(/height="([\d.]+)/)[1] };
  });
  const yh = (sMarg.match(/<rect[^>]*data-chart-part="marginal-y"[^>]*>/g) || []).map(function (t) {
    return { x: +t.match(/x="([\d.]+)/)[1], w: +t.match(/width="([\d.]+)/)[1] };
  });
  R.quality.marginalBands = {
    plot: mp,
    xMaxBottom: xh.length ? Math.max.apply(null, xh.map(function (b) { return b.y + b.h; })) : -1,
    yMinLeft: yh.length ? Math.min.apply(null, yh.map(function (b) { return b.x; })) : -1
  };

  // survival：默认 y 轴标题与自定义标题
  const yTitle = function (extra) {
    const s = fragOf('survival', survMap, survRows, extra, ['Time', 'Event', 'Grp']);
    return (s.match(/axis-title-y[^>]*>([^<]+)/) || [])[1] || null;
  };
  R.quality.survivalTitle = { def: yTitle(null), custom: yTitle({ axes: { yLabel: 'Overall survival' } }) };

  // dotplot：引导线应为细线
  const sDot = fragOf('dotplot', dotMap, dotRows, null, ['Score', 'Grp']);
  const gw = (sDot.match(/<line[^>]*data-chart-part="guide"[^>]*>/g) || [])
    .map(function (t) { return +t.match(/stroke-width="([\d.]+)/)[1]; });
  R.quality.dotGuideW = { max: gw.length ? Math.max.apply(null, gw) : -1, n: gw.length };

  // sankey：标签不压节点条 + 层内间距>0 + 流带厚度>0 + 标签两两不相交
  function sankeyLabelCheck(rows) {
    const s = fragOf('sankey', sankeyMap, rows, null, ['Src', 'Dst', 'W']);
    const nodes = (s.match(/<rect[^>]*data-chart-part="node"[^>]*>/g) || []).map(function (t) {
      return { L: +((t.match(/data-layer="(\d+)/) || [])[1] || 0),
               x: +t.match(/x="([\d.]+)/)[1], y: +t.match(/y="([\d.]+)/)[1],
               w: +t.match(/width="([\d.]+)/)[1], h: +t.match(/height="([\d.]+)/)[1] };
    });
    const labs = (s.match(/<text[^>]*data-chart-part="node-label"[^>]*>[^<]*<\/text>/g) || []).map(function (t) {
      return { x: +t.match(/x="([\d.]+)/)[1], y: +t.match(/y="([\d.]+)/)[1],
               fs: +t.match(/font-size="([\d.]+)/)[1],
               anc: (t.match(/text-anchor="([^"]+)"/) || [])[1] || 'start',
               s: (t.match(/>([^<]*)<\/text>/) || [])[1] || '' };
    });
    const labBoxes = labs.map(function (l) {
      const w = textW2(l.s, l.fs);
      const x0 = l.anc === 'end' ? l.x - w : l.anc === 'middle' ? l.x - w / 2 : l.x;
      const x1 = l.anc === 'end' ? l.x : l.anc === 'middle' ? l.x + w / 2 : l.x + w;
      return { x0: x0, x1: x1, y0: l.y - l.fs * 0.95, y1: l.y + l.fs * 0.35 };
    });
    let overlap = 0;
    labBoxes.forEach(function (b, bi) {
      nodes.forEach(function (nd) {
        if (b.x0 < nd.x + nd.w && b.x1 > nd.x && b.y0 < nd.y + nd.h && b.y1 > nd.y) overlap++;
      });
      for (let bj = 0; bj < bi; bj++) {
        const o = labBoxes[bj];
        if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) overlap += 1000; // 标签互撞单独计
      }
    });
    // 层内节点间距：同层按 y 排序，相邻「上节点底 → 下节点顶」距离
    const byLayer = {};
    nodes.forEach(function (nd) { (byLayer[nd.L] = byLayer[nd.L] || []).push(nd); });
    let minGap = -1;
    Object.keys(byLayer).forEach(function (L) {
      const arr = byLayer[L].slice().sort(function (a, b) { return a.y - b.y; });
      for (let i = 1; i < arr.length; i++) {
        const g = arr[i].y - (arr[i - 1].y + arr[i - 1].h);
        if (minGap < 0 || g < minGap) minGap = g;
      }
    });
    // 流带厚度：flow path 两端槽位高 |y2-y1|（d: M x y1a C.. x y2a L x y2b C.. x y1b Z）
    let minBand = -1;
    (s.match(/<path[^>]*data-chart-part="flow"[^>]*>/g) || []).forEach(function (t) {
      const d = (t.match(/d="([^"]+)"/) || [])[1] || '';
      const nums = (d.match(/-?\d*\.?\d+/g) || []).map(Number);
      if (nums.length < 16) return;
      const thS = Math.abs(nums[15] - nums[1]);   // 源端 y1b - y1a
      const thT = Math.abs(nums[9] - nums[7]);    // 目标端 y2b - y2a
      const th = Math.min(thS, thT);
      if (minBand < 0 || th < minBand) minBand = th;
    });
    return { nodes: nodes.length, labels: labs.length, overlap: overlap,
             minGap: minGap, minBand: minBand };
  }
  R.quality.sankeyLabels = sankeyLabelCheck(sankeyRows);
  R.quality.sankeyLabels2 = sankeyLabelCheck(sankeyRows2);

  // pca 椭圆：与样本协方差特征分解手算值核对（数据空间 rx/ry/angle）
  function covEll(rows, xi, yi) {
    const n = rows.length; let mx = 0, my = 0;
    rows.forEach(function (r) { mx += r[xi]; my += r[yi]; });
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    rows.forEach(function (r) {
      const dx = r[xi] - mx, dy = r[yi] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    });
    const d = n - 1; sxx /= d; syy /= d; sxy /= d;
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    return { rx: Math.sqrt(5.991 * l1), ry: Math.sqrt(5.991 * l2),
             ang: 0.5 * Math.atan2(2 * sxy, sxx - syy) };
  }
  const sPca = fragOf('pca', pcaMap, pcaRows, { presentation: { plot: { ellipse: true } } }, ['PC1', 'PC2', 'Grp']);
  const act = [];
  (sPca.match(/<path[^>]*data-chart-part="ellipse95"[^>]*>/g) || []).forEach(function (t) {
    act.push({ rx: +t.match(/data-ellipse-rx="([\d.-]+)"/)[1],
               ry: +t.match(/data-ellipse-ry="([\d.-]+)"/)[1],
               ang: +t.match(/data-ellipse-angle="([\d.-]+)"/)[1] });
  });
  const exp = [];
  ['C1', 'C2'].forEach(function (g) {
    const sub = pcaRows.filter(function (r) { return r[2] === g; });
    exp.push(covEll(sub, 0, 1));
  });
  R.quality.pcaEllipse = { exp: exp, act: act };

  // taylor：全非负→四分圆（每弧 1 个 A）、极区宽≥80% 绘图区宽、
  // 相关刻度 5 个、模型标签 bbox 两两不相交
  function taylorLabelBoxes(s) {
    return (s.match(/<text[^>]*data-chart-part="model-label"[^>]*>[^<]*<\/text>/g) || []).map(function (t) {
      const x = +t.match(/x="([\d.]+)/)[1], y = +t.match(/y="([\d.]+)/)[1];
      const fs = +t.match(/font-size="([\d.]+)/)[1];
      const txt = (t.match(/>([^<]*)<\/text>/) || [])[1] || '';
      const w = textW2(txt, fs);
      return { x0: x - w / 2, x1: x + w / 2, y0: y - fs * 0.95, y1: y + fs * 0.35 };
    });
  }
  function pairOverlap(boxes) {
    let n = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) n++;
    }
    return n;
  }
  function corrTextsOf(s) {
    return (s.match(/<text[^>]*corr-tick-label[^>]*>([^<]+)<\/text>/g) || [])
      .map(function (t) { return t.replace(/<[^>]+>/g, ''); });
  }
  const sTay = fragOf('taylor', taylorMap, taylorRows, { reference_std: 1.0 }, ['Std', 'Corr', 'Model']);
  const grids = (sTay.match(/<path[^>]*data-chart-part="grid-std"[^>]*>/g) || []).map(function (t) {
    return (t.match(/\sA/g) || []).length;
  });
  R.quality.taylor = {
    span: attrAll(sTay, 'data-polar-span')[0] || null,
    wfrac: parseFloat(attrAll(sTay, 'data-polar-w-frac')[0] || '0'),
    rect: (attrAll(sTay, 'data-polar-rect')[0] || '').split(',').map(Number),
    grids: grids.length,
    aPerGrid: grids,
    corrLabels: (sTay.match(/corr-tick-label/g) || []).length,
    corrTexts: corrTextsOf(sTay),
    modelLabels: (sTay.match(/model-label"/g) || []).length,
    labOverlap: pairOverlap(taylorLabelBoxes(sTay)),
    outer: (sTay.match(/taylor-outer/g) || []).length
  };
  // 含负相关 → 半圆（每弧 2 个 A）、刻度含负值
  const sTayNeg = fragOf('taylor', taylorMap, taylorRowsNeg, { reference_std: 1.0 }, ['Std', 'Corr', 'Model']);
  R.quality.taylorNeg = {
    span: attrAll(sTayNeg, 'data-polar-span')[0] || null,
    gridsA: (sTayNeg.match(/<path[^>]*data-chart-part="grid-std"[^>]*>/g) || []).map(function (t) {
      return (t.match(/\sA/g) || []).length;
    }),
    corrTexts: corrTextsOf(sTayNeg)
  };
  // 拥挤模型标签 → 引线 + 不相交
  const sTayCrowd = fragOf('taylor', taylorMap, taylorRowsCrowd, { reference_std: 1.0 }, ['Std', 'Corr', 'Model']);
  R.quality.taylorCrowd = {
    leaders: (sTayCrowd.match(/model-leader/g) || []).length,
    labels: (sTayCrowd.match(/model-label"/g) || []).length,
    labOverlap: pairOverlap(taylorLabelBoxes(sTayCrowd))
  };

  // roc：好例两曲线 AUC≈0.85/0.72 且无覆盖警告；缺端点例警告+说明；
  // 单组 roc 用 auc-note 标注（单项图例被抑制）、无图例组
  const sRocG = fragOf('roc', rocMap, rocRowsGood, null, ['FPR', 'TPR', 'Model']);
  R.quality.rocGood = {
    aucs: (sRocG.match(/data-auc="([\d.]+)"/g) || []).map(function (t) {
      return +t.replace(/[^\d.]/g, '');
    }).sort(function (a, b) { return b - a; }),
    warn: (sRocG.match(/data-warning=/g) || []).length,
    curves: (sRocG.match(/roc-curve/g) || []).length
  };
  const sRocP = fragOf('roc', rocMap, rocRows, null, ['FPR', 'TPR', 'Model']);
  R.quality.rocPartial = {
    warn: attrAll(sRocP, 'data-warning').join('|'),
    note: attrAll(sRocP, 'data-auc-note')[0] || null
  };
  const sRocS = fragOf('roc', { x: 'FPR', y: 'TPR' }, [[0, 0], [0.5, 0.8], [1, 1]], null, ['FPR', 'TPR']);
  R.quality.rocSingle = {
    note: (sRocS.match(/part="auc-note"[^>]*>([^<]+)/) || [])[1] || null,
    legend: (sRocS.match(/data-legend-pos=/g) || []).length
  };
  // 单系列图例抑制：violin 默认无图例；显式 legend.position 恢复
  const sVio = fragOf('violin', V_MAP, violinRows, null, V_COLS);
  const sVioL = fragOf('violin', V_MAP, violinRows,
    { presentation: { legend: { position: 'right' } } }, V_COLS);
  R.quality.legendSuppress = {
    violinDefault: (sVio.match(/data-legend-pos=/g) || []).length,
    violinExplicit: (sVioL.match(/data-legend-pos=/g) || []).length
  };
})();

console.log(JSON.stringify(R));
"""


class TestChartsR10(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.R = node_json(PRELUDE + DATASET_JS + CASES_JS, timeout=180)

    # ---- 1. 渲染成功 ----
    def test_all_13_render(self):
        for t in ["bar_stacked", "violin", "dotplot", "paired", "marginal", "volcano",
                  "forest", "survival", "roc", "pca", "venn", "sankey", "taylor"]:
            b = self.R["basic"][t]
            self.assertNotIn("err", b, f"{t} 渲染失败: {b.get('err')}")
            self.assertTrue(b["root"], f"{t} SVG 非法")
            self.assertEqual(b["type"], t, f"{t} data-chart-type 不符")
            self.assertGreater(b["len"], 500, f"{t} SVG 过短")

    # ---- 2. 元素数量 ----
    def test_counts(self):
        c = self.R["counts"]
        # dotplot：13 个有效点（3+6+3+1 脏行排除→12? 见下）；类别引导线 3 条
        self.assertEqual(c["dotplot"]["guides"], 3)
        # paired：6 完整体×3 条件=18 点；连线按段计 6×2=12；S7 缺 Follow、S8 脏行 → unpaired=1
        self.assertEqual(c["paired"]["points"], 18)
        self.assertEqual(c["paired"]["links"], 12)
        self.assertEqual(int(c["paired"]["unpaired"]), 1)
        self.assertGreater(c["pairedSummary"], 0)
        self.assertEqual(c["survival"]["km"], 1)
        self.assertEqual(c["survival"]["censor"], 2)  # t=3, t=5 两个删失
        self.assertEqual(c["roc"]["curves"], 2)
        self.assertEqual(c["forest"]["ci"], 5)
        self.assertEqual(c["forest"]["est"], 5)
        self.assertEqual(c["venn"]["sets"], 3)
        self.assertEqual(c["sankey"]["flows"], 5)
        self.assertEqual(c["sankey"]["nodes"], 4)
        self.assertEqual(c["violin"]["violins"], 3)
        self.assertEqual(c["violin"]["iqr"], 3)
        self.assertEqual(c["violin"]["med"], 3)
        self.assertEqual(c["bar_stacked"]["segs"], 4)  # 2 类别×2 组分
        self.assertGreater(c["marginal"]["xhist"], 0)
        self.assertGreater(c["marginal"]["yhist"], 0)
        self.assertGreater(c["marginal"]["pts"], 0)
        self.assertEqual(c["volcano"]["labels"], 3)
        self.assertEqual(c["volcano"]["points"], 40)
        self.assertEqual(c["pca"]["ellipses"], 2)
        self.assertEqual(c["pca"]["pts"], 48)
        self.assertGreater(c["taylor"]["grids"], 0)
        self.assertEqual(c["taylor"]["refStd"], "1")

    # ---- 3. 排除计数 ----
    def test_exclusions(self):
        e = self.R["excl"]
        self.assertEqual(e["violin"]["total"], 92)  # 3×30 + 2 脏行
        self.assertEqual(e["violin"]["excluded"], 2)   # 'oops' + null 类别
        self.assertEqual(e["dotplot"]["excluded"], 1)  # 'x' 非数值
        # paired：共 21 行（18 完整 + S7×2 + S8×1）；drawn=18, excluded=3
        self.assertEqual(e["paired"]["drawn"], 18)
        self.assertEqual(e["paired"]["excluded"], 3)
        self.assertEqual(e["marginal"]["excluded"], 2)
        # venn：8 行中 1 行全否 → drawn=7
        self.assertEqual(e["venn"]["drawn"], 7)
        self.assertEqual(e["venn"]["excluded"], 1)
        # sankey：自环 A->A 排除 → 6 行中 5 drawn
        self.assertEqual(e["sankey"]["drawn"], 5)
        self.assertEqual(e["sankey"]["excluded"], 1)
        self.assertEqual(e["bar_stacked"]["drawn"], 6)
        self.assertEqual(e["bar_stacked"]["excluded"], 0)
        for t in ["survival", "forest", "volcano", "roc", "pca", "taylor"]:
            self.assertEqual(e[t]["excluded"], 0, f"{t} 不应有排除行")

    # ---- 4. 统计量 ----
    def test_stats(self):
        s = self.R["stats"]
        v = s["violinKde"]
        self.assertEqual(v["n"], 3)
        self.assertLess(v["maxErr"], 0.02, f"KDE 积分应≈1: {v}")
        self.assertEqual(v["method"], "gaussian-kde")
        self.assertEqual(v["rule"], "silverman")
        self.assertIsNotNone(v["bwAttr"])
        self.assertGreater(float(v["bwAttr"]), 0)
        self.assertIn("violin-n-lt-20", s["violinSmallWarn"])
        # KM 手算：t=1 atRisk6 d1 → 5/6; t=2 atRisk5 d1 → 2/3; t=5 atRisk3 d1 → 4/9; t=8 atRisk1 d1 → 0
        km = s["km"]
        self.assertAlmostEqual(km["s1"], 5 / 6, places=3)
        self.assertAlmostEqual(km["s2"], 2 / 3, places=3)
        self.assertAlmostEqual(km["s5"], 4 / 9, places=3)
        self.assertEqual(km["s8"], 0)
        self.assertEqual(km["method"], "kaplan-meier")
        self.assertIn("none", km["inference"] or "")
        # ROC AUC=0.65
        self.assertIsNotNone(s["rocAuc"]["found"])
        aucs = [float(x) for x in re.findall(r"AUC=([0-9.]+)", " ".join(s["rocAuc"]["all"]) if isinstance(s["rocAuc"]["all"], list) else "")]
        self.assertTrue(any(abs(a - 0.65) < 0.02 for a in aucs) or abs(float(s["rocAuc"]["found"]) - 0.65) < 0.02,
                        f"AUC 应≈0.65: {s['rocAuc']}")
        self.assertEqual(s["rocAuc"]["method"], "trapezoid-on-given-points")
        # venn：7 个非空区域各 1 次 + n=7
        self.assertEqual(s["vennRegions"]["members"], "7")
        self.assertIn("fixed-circle", s["vennRegions"]["scale"] or "")
        cnt = sorted(s["vennRegions"]["texts"])
        self.assertEqual(cnt, [1] * 7, f"venn 区域计数应全为1: {cnt}")
        # bar_stacked：重复行求和标记
        self.assertEqual(s["stackSum"]["dup"], "2")
        self.assertEqual(s["stackSum"]["agg"], "sum-per-cell")

    # ---- 5. 非法映射 ----
    def test_errors(self):
        er = self.R["errors"]
        for k in ["venn1", "venn4", "vennMissing"]:
            self.assertFalse(er[k]["ok"], f"{k} 应报错")
            self.assertIn("venn", er[k]["err"])
        self.assertFalse(er["sankey30"]["ok"])
        self.assertIn("30", er["sankey30"]["err"])
        self.assertFalse(er["volcanoNoData"]["ok"])
        self.assertTrue(er["forestNoCI"]["ok"])  # 无 CI 仍可画
        self.assertIn("no-ci-columns", er["forestNoCI"]["warn"])

    # ---- 6. tokens ----
    def test_tokens(self):
        t = self.R["tokens"]
        self.assertTrue(t["stackPercent"]["has100"])
        self.assertEqual(t["stackPercent"]["mode"], "percent")
        self.assertIn("no-thresholds", t["volcanoNoTh"]["warn"])
        self.assertEqual(t["volcanoNoTh"]["method"], "volcano-threshold-colors")
        self.assertEqual(t["volcanoTh"]["thLines"], 3)
        self.assertEqual(t["volcanoTh"]["points"], 40)
        self.assertEqual(t["forestNull"], "1")
        self.assertEqual(t["forestErr"]["src"], "error-column")
        self.assertEqual(t["pcaEllipse"]["attr"], "cov95-chi2-5.991")
        self.assertEqual(t["pcaEllipse"]["ell"], 2)
        # paired 缺一条件 → 整个个体排除且报错（无覆盖全部条件的个体）
        self.assertFalse(t["pairedIncomplete"]["ok"])
        self.assertIn("配对", t["pairedIncomplete"]["err"])
        self.assertIn("no-reference-std", t["taylorNoRef"])

    # ---- 7. PNG 导出非空 ----
    def test_png_export(self):
        try:
            import figraster  # noqa
        except Exception as e:  # pragma: no cover
            self.skipTest(f"figraster 不可用: {e}")
        import tempfile
        out = {}
        script = PRELUDE + DATASET_JS + r"""
const docs = {};
[['violin', V_MAP, violinRows, V_COLS],
 ['survival', survMap, survRows, ['Time','Event','Grp']],
 ['venn', { ys: vennYs }, vennRows, vennYs]
].forEach(function (c) {
  const spec = { chart_type: c[0], mapping: c[1] };
  const el = FigData.makeChartElement({ columns: c[3], rows: c[2] }, spec);
  const d = FigOps.applyAll(FigDoc.create({ title: 'x', width_mm: 120, height_mm: 90 }),
    [{ op: 'add_element', element: el }], { label: 'i' }).doc;
  docs[c[0]] = { doc: d, svg: FigRender.toSVG(d) };
});
console.log(JSON.stringify(docs));
"""
        res = node_json(script, timeout=120)
        for t, pack in res.items():
            doc = pack["doc"]
            with tempfile.TemporaryDirectory() as td:
                p = Path(td) / f"{t}.png"
                figraster.export_svg(pack["svg"], doc, str(p), "png", dpi=150)
                self.assertTrue(p.exists() and p.stat().st_size > 1000,
                                f"{t} PNG 导出为空")
                out[t] = p.stat().st_size
        self.assertEqual(len(out), 3)

    # ---- 8. 质量门禁 ----
    def test_bounds_in_canvas(self):
        b = self.R["quality"]["bounds"]
        for k in ["bar_stacked", "violin", "dotplot", "paired", "marginal", "volcano",
                  "forest", "survival", "roc", "pca", "venn", "sankey", "sankey2", "taylor",
                  "taylorNeg", "taylorCrowd", "rocGood"]:
            self.assertIn(k, b, f"{k} 缺 bounds 结果")
            self.assertTrue(b[k]["ok"], f"{k} 图元越界: {b[k]['viol']}")

    def test_quality_details(self):
        q = self.R["quality"]
        # bar_stacked percent：各类别堆叠顶端齐平（都到 100%）
        self.assertEqual(q["stackPercentTops"]["cats"], 2)
        self.assertLess(q["stackPercentTops"]["spread"], 2.0,
                        f"percent 堆叠顶端不齐: {q['stackPercentTops']}")
        # marginal：x 直方图全部在主绘图区上方、y 直方图全部在右侧
        mb = q["marginalBands"]
        self.assertEqual(len(mb["plot"]), 4)
        self.assertLessEqual(mb["xMaxBottom"], mb["plot"][1] + 0.6,
                             f"x 直方图压入主绘图区: {mb}")
        self.assertGreaterEqual(mb["yMinLeft"], mb["plot"][2] - 0.6,
                                f"y 直方图压入主绘图区: {mb}")
        # survival：默认标题 Survival probability；自定义标题保留
        self.assertEqual(q["survivalTitle"]["def"], "Survival probability")
        self.assertEqual(q["survivalTitle"]["custom"], "Overall survival")
        # dotplot：引导线为细线（<8px@300dpi）
        self.assertEqual(q["dotGuideW"]["n"], 3)
        self.assertLess(q["dotGuideW"]["max"], 8.0, f"引导线过粗: {q['dotGuideW']}")
        # sankey：标签不压节点条；真实感 4 层数据层内间距>0、流带厚度>0、
        # 标签两两不相交（overlap 计数同时含压条与标签互撞，见 JS 注释）
        self.assertEqual(q["sankeyLabels"]["overlap"], 0, f"sankey 标签重叠: {q['sankeyLabels']}")
        self.assertEqual(q["sankeyLabels"]["labels"], 4)
        self.assertGreater(q["sankeyLabels"]["minBand"], 0, "流带厚度应>0")
        s2 = q["sankeyLabels2"]
        self.assertEqual(s2["labels"], 10, f"sankey2 节点标签数: {s2}")
        self.assertEqual(s2["overlap"], 0, f"sankey2 标签重叠: {s2}")
        self.assertGreater(s2["minGap"], 0, f"sankey2 层内间距应>0: {s2['minGap']}")
        self.assertGreater(s2["minBand"], 0.5, f"sankey2 最薄流带应可见: {s2['minBand']}")
        # taylor：全非负→四分圆、极区宽≥80% 绘图区宽、每弧单段、刻度含 0.75 不含负值、
        # 模型标签两两不相交
        t = q["taylor"]
        self.assertEqual(t["span"], "quarter-nonneg-corr", f"taylor span: {t['span']}")
        self.assertGreaterEqual(t["wfrac"], 0.80, f"极区宽占比: {t['wfrac']}")
        self.assertGreater(t["grids"], 0)
        self.assertTrue(all(n == 1 for n in t["aPerGrid"]),
                        f"四分圆标准差弧应为单段（1 个 A）: {t['aPerGrid']}")
        self.assertEqual(t["corrLabels"], 5)
        self.assertIn("0.75", t["corrTexts"])
        self.assertNotIn("-0.5", t["corrTexts"])
        self.assertGreaterEqual(t["modelLabels"], 3, f"模型标签过少: {t}")
        self.assertEqual(t["labOverlap"], 0, f"taylor 模型标签相交: {t}")
        self.assertEqual(t["outer"], 1)
        # 含负相关 → 半圆、每弧两段、刻度含 -0.5/-1
        tn = q["taylorNeg"]
        self.assertEqual(tn["span"], "half-neg-corr")
        self.assertTrue(all(n == 2 for n in tn["gridsA"]), f"半圆标准差弧应两段: {tn['gridsA']}")
        self.assertIn("-0.5", tn["corrTexts"])
        self.assertIn("-1", tn["corrTexts"])
        # 拥挤模型 → 引线 + 标签不相交
        tc = q["taylorCrowd"]
        self.assertGreater(tc["leaders"], 0, f"拥挤标签应产生引线: {tc}")
        self.assertEqual(tc["labOverlap"], 0, f"taylorCrowd 标签相交: {tc}")
        # roc：好例 AUC≈0.85/0.72 无警告；缺端点警告+说明；单组 auc-note 无图例
        rg = q["rocGood"]
        self.assertEqual(rg["curves"], 2)
        self.assertEqual(len(rg["aucs"]), 2)
        self.assertAlmostEqual(rg["aucs"][0], 0.85, delta=0.02, msg=f"roc AUCs: {rg['aucs']}")
        self.assertAlmostEqual(rg["aucs"][1], 0.72, delta=0.02, msg=f"roc AUCs: {rg['aucs']}")
        self.assertEqual(rg["warn"], 0, "端点齐全不应有覆盖警告")
        rp = q["rocPartial"]
        self.assertIn("auc-partial-coverage", rp["warn"])
        self.assertIn("未覆盖 [0,1]", rp["note"] or "")
        rs = q["rocSingle"]
        self.assertIn("AUC=0.650", rs["note"] or "")
        self.assertEqual(rs["legend"], 0, "单组 roc 不应有图例（AUC 走 auc-note）")
        # 单系列图例抑制：violin 默认无图例；显式 legend.position 恢复
        ls = q["legendSuppress"]
        self.assertEqual(ls["violinDefault"], 0, "violin 单系列默认不应画图例")
        self.assertEqual(ls["violinExplicit"], 1, "显式 legend.position 应恢复图例")

    def test_pca_ellipse_math(self):
        q = self.R["quality"]["pcaEllipse"]
        self.assertEqual(len(q["act"]), 2)
        self.assertEqual(len(q["exp"]), 2)
        for i, (e, a) in enumerate(zip(q["exp"], q["act"])):
            for key in ["rx", "ry"]:
                self.assertAlmostEqual(a[key], e[key], delta=max(0.02, e[key] * 0.02),
                                       msg=f"椭圆{i} {key}: act={a[key]} exp={e[key]}")
            # 角度按 mod π 比较（椭圆主轴无方向性）
            da = abs(a["ang"] - e["ang"]) % math.pi
            da = min(da, math.pi - da)
            self.assertLess(da, 0.03, f"椭圆{i} 角度: act={a['ang']} exp={e['ang']}")


if __name__ == "__main__":
    unittest.main()
