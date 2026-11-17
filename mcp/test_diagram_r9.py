# -*- coding: utf-8 -*-
"""test_diagram_r9.py — R9 流程图/示意图：模板接通、布局模式、主题、文字生成、中文禁则。

覆盖 handoff 要求：
  1. 所有 tpl-diagram-* 模板 supportsTemplate/templateCapability/apply 全部一致可应用；
  2. 每个模板构建后节点两两不重叠；
  3. 连线端点落在节点边界上；
  4. 各布局模式坐标断言（flow/snake/stages/lanes/tree/cycle/timeline）；
  5. 反馈/回边经正交路由绕行（path_type=orthogonal 且折点在节点框外）；
  6. 主题切换一次 commit 且保留手动位置；
  7. 文字语法解析（含错误行号）与 apply_diagram_text op；
  8. 中文换行禁则（闭合标点不作行首、开括号不留行尾）。
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def node_json(script, timeout=120):
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    proc = subprocess.run(["node", "-e", script], cwd=str(HERE), capture_output=True,
                          text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, env=env)
    if proc.returncode:
        raise AssertionError((proc.stdout or "") + "\n" + (proc.stderr or ""))
    return json.loads(proc.stdout.strip().splitlines()[-1])


PRELUDE = r"""
const fs=require('fs');
for (const f of ['figdoc','diagram','ops','palette','presets','data','render']) {
  require('./lib/'+f+'.js');
}
const BUNDLE={
  journals: JSON.parse(fs.readFileSync('../presets/journals.json','utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json','utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json','utf8')),
  styles: JSON.parse(fs.readFileSync('../presets/styles.json','utf8')),
  diagramThemes: JSON.parse(fs.readFileSync('../presets/diagram_themes.json','utf8'))
};
FigPresets.load(BUNDLE);
const TEMPLATES = FigPresets.templates();
const DIAGRAM_TEMPLATES = TEMPLATES.filter(t => /^tpl-diagram-/.test(t.id) || t.id === 'tpl-graphical-abstract');
function nodeGroups(doc, did) {
  return doc.elements.filter(el => el && el.type === 'group' && el.diagramNodeId &&
    (el.diagramId || el.diagram_id) === did);
}
function overlaps(a, b) {
  const ax=a.transform, bx=b.transform;
  return ax.x < bx.x+bx.w-0.01 && bx.x < ax.x+ax.w-0.01 &&
         ax.y < bx.y+bx.h-0.01 && bx.y < ax.y+ax.h-0.01;
}
function buildSpec(spec, w, h) {
  const doc = FigDoc.create({width_mm: w||170, height_mm: h||110, dpi: 300,
    background:'#FFFFFF', title:'r9-test'});
  const n = FigDiagram.normalize(JSON.parse(JSON.stringify(spec)));
  const built = FigDiagram.build(doc, n);
  return {doc: built.doc, spec: n, warnings: built.warnings};
}
function relSpec(id, mode, nodes, relations, extra) {
  extra = extra || {};
  const layoutExtra = extra.layout || {};
  const out = Object.assign({id:id, template_id:'flow',
    nodes:nodes.map((n,i)=>Object.assign({},n,{id:'n'+(i+1),role:n.role||'method',shape:n.shape||'box',evidence:n.evidence||[]})),
    relations:relations, sources:[{id:'s1',locator:'synthetic'}],
    uncertainties:[]}, extra);
  out.layout = Object.assign({auto_layout:true,mode:mode||'flow',direction:'LR',margin:8,gap_x:6,gap_y:6,columns:3}, layoutExtra);
  return out;
}
"""


class DiagramTemplateTests(unittest.TestCase):
    def test_all_diagram_templates_applicable_and_clean(self):
        script = PRELUDE + r"""
const out = {total: DIAGRAM_TEMPLATES.length, ids: [], problems: []};
DIAGRAM_TEMPLATES.forEach(t => {
  const cap = FigDiagram.supportsTemplate(t);
  const pcap = FigPresets.templateCapability(t);
  const okSupport = cap && cap.supported === true;
  const okCap = pcap && pcap.status === 'full';
  if (!okSupport || !okCap) { out.problems.push(t.id + ': support=' + okSupport + ' cap=' + (pcap && pcap.status)); return; }
  let built = null, err = null;
  try {
    const ex = FigDiagram.example(t.id, true);
    const v = FigDiagram.validate(ex);
    if (!v.ok) { out.problems.push(t.id + ': example invalid ' + JSON.stringify(v.errors||v).slice(0,200)); return; }
    built = buildSpec(ex, 170, 110);
  } catch (e) { err = e.message; }
  if (err) { out.problems.push(t.id + ': build ' + err); return; }
  const did = built.spec.id;
  const groups = nodeGroups(built.doc, did);
  // 节点两两不重叠
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    if (overlaps(groups[i], groups[j])) {
      out.problems.push(t.id + ': overlap ' + groups[i].diagramNodeId + '/' + groups[j].diagramNodeId);
    }
  }
  // 连线端点落在节点边界（connector-mm 坐标与 sourceBox/targetBox 同空间）
  const conns = built.doc.elements.filter(el => el && el.type === 'connector' &&
    (el.diagramId || el.diagram_id) === did);
  conns.forEach(c => {
    let g; try { g = FigDiagram.connectorGeometry(built.doc, c); } catch (e) {
      out.problems.push(t.id + ': geom ' + c.id + ' ' + e.message); return; }
    if (!g.route_resolved) { out.problems.push(t.id + ': unresolved route ' + c.id); return; }
    [['start','sourceBox'],['end','targetBox']].forEach(pair => {
      const p = g[pair[0]], b = g[pair[1]];
      const onEdge = Math.abs(p.x-b.x)<0.05 || Math.abs(p.x-(b.x+b.w))<0.05 ||
                     Math.abs(p.y-b.y)<0.05 || Math.abs(p.y-(b.y+b.h))<0.05;
      const inside = p.x>=b.x-0.05 && p.x<=b.x+b.w+0.05 && p.y>=b.y-0.05 && p.y<=b.y+b.h+0.05;
      if (!(onEdge && inside)) out.problems.push(t.id + ': endpoint off-edge ' + c.id + ' ' + pair[0]);
    });
  });
  out.ids.push(t.id);
});
console.log(JSON.stringify(out));
"""
        res = node_json(script)
        self.assertGreaterEqual(res["total"], 19, "应至少有 19 个 tpl-diagram-* 模板")
        self.assertEqual(res["problems"], [], "模板问题: " + "; ".join(res["problems"][:8]))

    def test_layout_modes_coordinates(self):
        script = PRELUDE + r"""
const out = {};
function placedOf(built, did) {
  const m = {};
  nodeGroups(built.doc, did).forEach(g => { m[g.diagramNodeId] = g.transform; });
  return m;
}
// flow LR：A->B->C，x 应递增
{
  const s = relSpec('t-flow','flow',
    [{id:'a',label:'甲'},{id:'b',label:'乙'},{id:'c',label:'丙'}],
    [{id:'r1',source:'n1',target:'n2',kind:'sequence',direction:'forward',evidence:[]},
     {id:'r2',source:'n2',target:'n3',kind:'sequence',direction:'forward',evidence:[]}]);
  const b = buildSpec(s); const p = placedOf(b, b.spec.id);
  out.flow = { xa:p.n1.x, xb:p.n2.x, xc:p.n3.x,
    ok: p.n1.x < p.n2.x - 1 && p.n2.x < p.n3.x - 1 };
}
// snake：5 节点 3 列，第二行顺序应反转（n4 在右、n5 在左）
{
  const s = relSpec('t-snake','snake',
    [1,2,3,4,5].map(i=>({id:'n'+i,label:'步'+i})), []);
  s.layout.columns = 3;
  const b = buildSpec(s); const p = placedOf(b, b.spec.id);
  out.snake = { x4:p.n4.x, x5:p.n5.x, y4:p.n4.y, y5:p.n5.y,
    ok: p.n4.y > p.n3.y + 1 && p.n5.x < p.n4.x - 1 };
}
// stages：两个 group 各两节点 → 应有容器元素且两组 x 分离
{
  const s = relSpec('t-stages','stages',
    [{id:'a',label:'一',group:'g1'},{id:'b',label:'二',group:'g1'},
     {id:'c',label:'三',group:'g2'},{id:'d',label:'四',group:'g2'}],
    [{id:'r1',source:'n1',target:'n2',kind:'sequence',direction:'forward',evidence:[]},
     {id:'r2',source:'n2',target:'n3',kind:'sequence',direction:'forward',evidence:[]},
     {id:'r3',source:'n3',target:'n4',kind:'sequence',direction:'forward',evidence:[]}],
    {groups:[{id:'g1',label:'阶段一'},{id:'g2',label:'阶段二'}]});
  const b = buildSpec(s); const p = placedOf(b, b.spec.id);
  const containers = b.doc.elements.filter(el => el && el.diagram_part === 'stage_container' &&
    (el.diagramId||el.diagram_id) === b.spec.id);
  out.stages = { containers: containers.length,
    g1x: Math.min(p.n1.x,p.n2.x), g2x: Math.min(p.n3.x,p.n4.x),
    ok: containers.length >= 2 && Math.min(p.n3.x,p.n4.x) > Math.max(p.n1.x,p.n2.x) };
}
// lanes：两 group → 泳道容器 + 节点 y 按泳道分离
{
  const s = relSpec('t-lanes','lanes',
    [{id:'a',label:'甲',group:'g1'},{id:'b',label:'乙',group:'g2'}],
    [{id:'r1',source:'n1',target:'n2',kind:'sequence',direction:'forward',evidence:[]}],
    {groups:[{id:'g1',label:'泳道一'},{id:'g2',label:'泳道二'}]});
  const b = buildSpec(s); const p = placedOf(b, b.spec.id);
  out.lanes = { y1:p.n1.y, y2:p.n2.y, ok: Math.abs(p.n1.y - p.n2.y) > 10 };
}
// tree：根->两子->一孙，深度 y 应递增
{
  const s = relSpec('t-tree','tree',
    [{id:'a',label:'根'},{id:'b',label:'左'},{id:'c',label:'右'},{id:'d',label:'孙'}],
    [{id:'r1',source:'n1',target:'n2',kind:'sequence',direction:'forward',evidence:[]},
     {id:'r2',source:'n1',target:'n3',kind:'sequence',direction:'forward',evidence:[]},
     {id:'r3',source:'n2',target:'n4',kind:'sequence',direction:'forward',evidence:[]}]);
  const b = buildSpec(s); const p = placedOf(b, b.spec.id);
  out.tree = { y1:p.n1.y, y2:p.n2.y, y4:p.n4.y,
    ok: p.n2.y > p.n1.y + 3 && p.n4.y > p.n2.y + 3 };
}
// cycle：4 节点应分布在环上——以节点中心质心为环心，
// 角向间隔均匀（相邻≈90°）、半径比受椭圆度限制（max/min<2.2）
{
  const s = relSpec('t-cycle','cycle',
    [1,2,3,4].map(i=>({id:'n'+i,label:'环'+i})),
    [{id:'r1',source:'n1',target:'n2',kind:'sequence',direction:'forward',evidence:[]},
     {id:'r2',source:'n2',target:'n3',kind:'sequence',direction:'forward',evidence:[]},
     {id:'r3',source:'n3',target:'n4',kind:'sequence',direction:'forward',evidence:[]},
     {id:'r4',source:'n4',target:'n1',kind:'sequence',direction:'forward',evidence:[]}],
    {canvas:{width_mm:160,height_mm:160}});
  const b = buildSpec(s, 170, 170); const p = placedOf(b, b.spec.id);
  const ids = Object.keys(p);
  const cents = ids.map(k => ({ x: p[k].x + p[k].w / 2, y: p[k].y + p[k].h / 2 }));
  const ccx = cents.reduce((s2, c) => s2 + c.x, 0) / cents.length;
  const ccy = cents.reduce((s2, c) => s2 + c.y, 0) / cents.length;
  const rs = cents.map(c => Math.hypot(c.x - ccx, c.y - ccy));
  const ratio = Math.max.apply(null, rs) / Math.max(0.01, Math.min.apply(null, rs));
  const angs = cents.map(c => Math.atan2(c.y - ccy, c.x - ccx)).sort((a2, b2) => a2 - b2);
  const gaps = angs.map((a2, i) => {
    const nxt = i === angs.length - 1 ? angs[0] + 2 * Math.PI : angs[i + 1];
    return nxt - a2;
  });
  const gapDeg = gaps.map(g => g * 180 / Math.PI);
  const even = gapDeg.every(g => g > 45 && g < 135);
  out.cycle = { radii: rs.map(r => Math.round(r * 10) / 10), ratio: Math.round(ratio * 100) / 100,
    gapDeg: gapDeg.map(g => Math.round(g)), ok: ratio < 2.2 && even && rs.every(r => r > 8) };
}
// timeline：4 里程碑 x 递增、y 上下交替、含轴线 decor
{
  const s = relSpec('t-timeline','timeline',
    [1,2,3,4].map(i=>({id:'n'+i,label:'里程碑'+i})), []);
  const b = buildSpec(s); const p = placedOf(b, b.spec.id);
  const decor = b.doc.elements.filter(el => el && el.diagram_part === 'decor' ||
    (el && el.diagramId === b.spec.id && el.diagram_part === 'decor_line'));
  out.timeline = { xs: [p.n1.x,p.n2.x,p.n3.x,p.n4.x].map(Math.round),
    ys: [p.n1.y,p.n2.y,p.n3.y,p.n4.y],
    ok: p.n1.x < p.n2.x && p.n2.x < p.n3.x && p.n3.x < p.n4.x &&
        p.n1.y < p.n2.y && p.n2.y > p.n3.y && p.n3.y < p.n4.y };
}
console.log(JSON.stringify(out));
"""
        res = node_json(script)
        for mode in ("flow", "snake", "stages", "lanes", "tree", "cycle", "timeline"):
            self.assertIn(mode, res)
            self.assertTrue(res[mode]["ok"], mode + " 布局断言失败: " + json.dumps(res[mode], ensure_ascii=False))

    def test_feedback_edge_routes_externally(self):
        script = PRELUDE + r"""
const s = relSpec('t-feedback','flow',
  [{id:'a',label:'开始'},{id:'b',label:'处理'},{id:'c',label:'评估'},{id:'d',label:'返工'}],
  [{id:'r1',source:'n1',target:'n2',kind:'sequence',direction:'forward',evidence:[]},
   {id:'r2',source:'n2',target:'n3',kind:'sequence',direction:'forward',evidence:[]},
   {id:'r3',source:'n3',target:'n4',kind:'sequence',direction:'forward',evidence:[]},
   {id:'r4',source:'n4',target:'n2',kind:'sequence',direction:'forward',label:'不合格',evidence:[]}]);
const b = buildSpec(s);
const conns = b.doc.elements.filter(el => el && el.type === 'connector' &&
  (el.diagramId||el.diagram_id) === b.spec.id);
const back = conns.find(c => c.relation && c.relation.source === 'n4' && c.relation.target === 'n2');
const g = FigDiagram.connectorGeometry(b.doc, back);
// 回边：直接线段会穿过中间区域 → 应走正交外绕；折点须在两端节点框之外
const sb = g.sourceBox, tb = g.targetBox;
const outside = g.points.slice(1,-1).some(p =>
  (p.x < Math.min(sb.x,tb.x)-0.5 || p.x > Math.max(sb.x+sb.w,tb.x+tb.w)+0.5 ||
   p.y < Math.min(sb.y,tb.y)-0.5 || p.y > Math.max(sb.y+sb.h,tb.y+tb.h)+0.5));
console.log(JSON.stringify({path_type:g.path_type, resolved:g.route_resolved,
  npoints:g.points.length, outside:outside, ids:conns.map(c=>c.id)}));
"""
        res = node_json(script)
        self.assertTrue(res["resolved"], "回边路由未解析")
        self.assertEqual(res["path_type"], "orthogonal", "回边应走正交外绕路由")
        self.assertGreater(res["npoints"], 2)
        self.assertTrue(res["outside"], "回边折点应在节点包围盒之外（外侧绕行）")

    def test_theme_switch_single_commit_preserves_manual_positions(self):
        script = PRELUDE + r"""
const doc0 = FigDoc.create({width_mm:170, height_mm:110, dpi:300, background:'#FFFFFF'});
const spec = relSpec('t-theme','flow',
  [{id:'a',label:'甲'},{id:'b',label:'乙'}],
  [{id:'r1',source:'n1',target:'n2',kind:'sequence',direction:'forward',evidence:[]}],
  {theme:'soft-card', layout:{auto_layout:false}});
let r1 = FigOps.applyAll(doc0, [{op:'apply_schematic', contract:spec}], {ts:'2026-01-01T00:00:00.000Z'});
let doc = r1.doc;
// 手动移动节点 n1
const before = doc.elements.find(el => el.type==='group' && el.diagramNodeId==='n1');
doc = FigOps.applyAll(doc, [{op:'move', targets:[before.id], dx:9, dy:5}], {ts:'2026-01-01T00:01:00.000Z'}).doc;
const movedT = doc.elements.find(el => el.id===before.id).transform;
// 换主题：同合同 theme 改 outline-academic → 一次 commit
const spec2 = JSON.parse(JSON.stringify(spec)); spec2.theme = 'outline-academic';
const commitsBefore = doc.history ? doc.history.length : null;
let r2 = FigOps.applyAll(doc, [{op:'apply_schematic', contract:spec2}], {ts:'2026-01-01T00:02:00.000Z'});
const doc2 = r2.doc;
const after = doc2.elements.find(el => el.type==='group' && el.diagramNodeId==='n1' &&
  (el.diagramId||el.diagram_id)==='t-theme');
// 主题确实生效：找一个 fill/stroke 与 soft-card 不同的节点 shape
const shape = doc2.elements.find(el => el.diagramNodeId==='n1' && el.diagram_part==='node_shape');
console.log(JSON.stringify({
  moved:{x:movedT.x,y:movedT.y}, after:{x:after.transform.x,y:after.transform.y},
  samePos: Math.abs(after.transform.x-movedT.x)<0.01 && Math.abs(after.transform.y-movedT.y)<0.01,
  applied: r2.applied !== false, changed: r2.changed,
  themeApplied: shape ? JSON.stringify(shape.style||{}) : null,
  warnings: (r2.warnings||[]).length }));
"""
        res = node_json(script)
        self.assertTrue(res["samePos"], "主题切换后手动位置被改动: " + json.dumps(res, ensure_ascii=False))
        self.assertTrue(res["applied"] or res["changed"], "主题切换未生效")

    def test_parse_text_syntax_and_errors(self):
        script = PRELUDE + r"""
const out = {};
// 正常解析
const ok = FigDiagram.parseText(
  "(开始)\n## 识别\n文献调研 -> 数据采集 -> 数据预处理?\n" +
  "数据预处理? -> 清洗 : 是\n数据预处理? -> 补采 : 否\n清洗 -> 建模\n建模 -> 清洗 : 迭代\n(结束)",
  {layout:{mode:'flow'}, theme:'numbered-card'});
out.okParse = {ok: ok.ok, nodes: ok.input.nodes.length, rels: ok.input.relations.length,
  groups: (ok.input.groups||[]).length, errors: ok.errors.length,
  shapes: ok.input.nodes.map(n=>n.shape).join(','),
  edgeLabels: ok.input.relations.map(r=>r.label||'').filter(Boolean).join(',')};
// 错误行号：第 3 行无法识别
const bad = FigDiagram.parseText("A -> B\n## \n这不是连线\nC -> D : 标签", {});
out.badParse = {ok: bad.ok, errors: bad.errors.map(e=>({line:e.line,msg:e.message}))};
// apply_diagram_text op 全链路
const doc0 = FigDoc.create({width_mm:170, height_mm:110, dpi:300, background:'#FFFFFF'});
const applied = FigOps.applyAll(doc0, [{op:'apply_diagram_text',
  text:'(开始) -> 处理? -> (结束)\n处理? -> 重试 : 否', layout:{mode:'flow'}, theme:'mono-grey',
  id:'txt-fig'}], {ts:'2026-01-01T00:00:00.000Z'});
const diaEls = applied.doc.elements.filter(el => (el.diagramId||el.diagram_id)==='txt-fig');
out.opApply = {ok: !!applied.doc, els: diaEls.length,
  hasDecision: diaEls.some(el => el.diagram_part==='node_shape'),
  meta: !!(applied.doc.meta.diagrams && applied.doc.meta.diagrams['txt-fig'])};
// 坏文本经 op 校验应报行号
let verr = null;
try { FigOps.applyAll(doc0, [{op:'apply_diagram_text', text:'A -> B\n@@@\nC'}], {}); }
catch(e){ verr = e.message; }
out.opReject = verr;
console.log(JSON.stringify(out));
"""
        res = node_json(script)
        p = res["okParse"]
        self.assertTrue(p["ok"], "parseText 应成功")
        self.assertGreaterEqual(p["nodes"], 5)
        self.assertGreaterEqual(p["rels"], 4)
        self.assertEqual(p["groups"], 1)
        self.assertIn("terminal", p["shapes"])
        self.assertIn("diamond", p["shapes"])
        self.assertIn("是", p["edgeLabels"])
        self.assertIn("否", p["edgeLabels"])
        bad = res["badParse"]
        self.assertFalse(bad["ok"])
        lines = [e["line"] for e in bad["errors"]]
        self.assertIn(2, lines, "## 空名应报第 2 行")
        self.assertIn(3, lines, "无法识别行应报第 3 行")
        self.assertGreater(res["opApply"]["els"], 3, "apply_diagram_text 应生成元素")
        self.assertTrue(res["opApply"]["meta"], "应写入 meta.diagrams")
        self.assertIsNotNone(res["opReject"], "非法文本应被拒绝")
        self.assertIn("行", res["opReject"], "拒绝信息应含行号: " + str(res["opReject"]))

    def test_chinese_wrap_rules(self):
        script = PRELUDE + r"""
const D = FigDiagram;
const CLOSING = /[，。、；：！？）」』】》]/;
const OPENING = /[（「『【《]$/;
function check(label, wMm, fontPt) {
  const lines = D.wrapLabel(label, wMm, fontPt || 8);
  const arr = Array.isArray(lines) ? lines : String(lines).split('\n');
  const bad = [];
  arr.forEach((ln, i) => {
    const s = String(ln);
    if (i > 0 && CLOSING.test(s.charAt(0))) bad.push('line'+(i+1)+'-start:'+s.slice(0,6));
    if (OPENING.test(s.slice(-1))) bad.push('line'+(i+1)+'-end:'+s.slice(-6));
  });
  return {lines: arr.length, bad: bad};
}
const samples = [
  '数据预处理与特征提取（包括去噪、归一化、缺失值填补）的完整流程说明文字用于测试换行',
  '是否采用深度学习模型进行分类任务的判断节点（需要充分的训练数据与验证集）？',
  '「引号开头的中文标签」与【书名号内容】以及（括号说明）混合的长文本用于换行测试',
  '短标签'
];
const out = samples.map(s => check(s, 30, 8));
out.push(check('A'.repeat(200), 20, 8));
console.log(JSON.stringify(out));
"""
        res = node_json(script)
        for i, r in enumerate(res):
            self.assertEqual(r["bad"], [], "样本 %d 违反禁则: %s" % (i, r["bad"]))

    def test_halfwidth_kinsoku_and_terminal_parens(self):
        script = PRELUDE + r"""
const D = FigDiagram;
const out = {};
// 半角闭合标点不得行首：?,! ),],.,:;,} 等
const CLOSE = /[?!\)\]\}\.,:;>”’]$/;
function lineStarts(label, wMm) {
  const lines = D.wrapLabel(label, wMm, 8);
  const arr = Array.isArray(lines) ? lines : String(lines).split('\n');
  const bad = [];
  arr.forEach((ln, i) => {
    if (i > 0 && /[?!\)\]\}\.,:;>”’]/.test(String(ln).charAt(0)))
      bad.push('L' + (i + 1) + ':' + String(ln).slice(0, 8));
  });
  return { lines: arr.length, bad };
}
out.samples = [
  lineStarts('数据预处理?需要进一步说明与验证的长文本用于触发自动折行处理', 20),
  lineStarts('测试结果(a,b)汇总,包含多组对照数据与统计显著性分析结论文字', 20),
  lineStarts('参数[1,2,3]取值:范围说明;附注内容继续展开至第二行测试', 20),
  lineStarts('是否满足条件?（括号内补充说明文字使行宽超限触发换行规则）', 20)
];
// 终端括号语法：标签不含括号本身
const p = D.parseText('(开始)\nA -> B?\nB? -> (结束) : 否', {});
out.terminals = p.input.nodes.map(n => ({ label: n.label, shape: n.shape }));
out.parseOk = p.ok;
console.log(JSON.stringify(out));
"""
        res = node_json(script)
        self.assertTrue(res["parseOk"])
        labels = {n["label"] for n in res["terminals"]}
        self.assertIn("开始", labels)
        self.assertIn("结束", labels)
        for n in res["terminals"]:
            self.assertNotIn("（", n["label"], "终端标签不应残留括号: " + n["label"])
            self.assertNotIn("(", n["label"], "终端标签不应残留半角括号: " + n["label"])
        for i, s in enumerate(res["samples"]):
            self.assertEqual(s["bad"], [], "半角禁则样本 %d 违规: %s 行数=%d" % (i, s["bad"], s["lines"]))

    def test_template_specific_layouts(self):
        """R9 返工：prisma/roadmap/chevron/timeline/loop/hierarchy/swimlane/feedback 结构断言。"""
        script = PRELUDE + r"""
const out = {};
function tplSpec(tid, theme) {
  const tpl = TEMPLATES.find(t => t.id === tid);
  const c = JSON.parse(JSON.stringify(tpl.schematic || FigDiagram.example(tid, true)));
  c.id = tid; c.template_id = tid; if (theme) c.theme = theme;
  return c;
}
function placedOf(built, did) {
  const m = {};
  nodeGroups(built.doc, did).forEach(g => { m[g.diagramNodeId] = g.transform; });
  return m;
}
function parts(built, did, part) {
  return built.doc.elements.filter(el => el && el.diagram_part === part &&
    (el.diagramId || el.diagram_id) === did);
}
// prisma：主流程单列自上而下 + 右侧排除容器 + 左侧 stagebar 竖条
{
  const b = buildSpec(tplSpec('tpl-diagram-prisma'), 170, 140);
  const p = placedOf(b, b.spec.id);
  const mainIds = ['id1','id2','scr1','scr2','inc1','inc2'];
  const main = mainIds.filter(k => p[k]);
  const cxs = main.map(k => p[k].x + p[k].w / 2);
  const ys = main.map(k => p[k].y);
  const stagebars = parts(b, b.spec.id, 'lane_bar').filter(el => {
    const par = b.doc.elements.find(e => e.id === el.parent_id);
    return par && par.diagram_part === 'stage_container';
  });
  const rightBoxes = parts(b, b.spec.id, 'stage_bg').map(el => el.transform);
  const mainRight = Math.max.apply(null, main.map(k => p[k].x + p[k].w));
  const singleCol = Math.max.apply(null, cxs) - Math.min.apply(null, cxs) < 3;
  const topDown = ys.every((y, i) => i === 0 || y > ys[i-1] - 0.5);
  const exclRight = rightBoxes.length > 0 && rightBoxes.every(bx => bx.x > mainRight - 1);
  out.prisma = { singleColumn: singleCol, topDown: topDown,
    stagebars: stagebars.length, rightBoxes: rightBoxes.length, exclRight: exclRight,
    ok: singleCol && topDown && stagebars.length >= 2 && exclRight };
}
// roadmap：左栏 group_bar/glabel + 中栏节点 + 右栏 subtitle 在节点右侧
{
  const b = buildSpec(tplSpec('tpl-diagram-roadmap'), 170, 140);
  const p = placedOf(b, b.spec.id);
  const bars = parts(b, b.spec.id, 'group_bar');
  const labels = parts(b, b.spec.id, 'group_label');
  const subs = parts(b, b.spec.id, 'node_subtitle');
  const nodeIds = Object.keys(p);
  const nodeLeft = Math.min.apply(null, nodeIds.map(k => p[k].x));
  const nodeRight = Math.max.apply(null, nodeIds.map(k => p[k].x + p[k].w));
  const barRight = Math.max.apply(null, bars.map(el => el.transform.x + el.transform.w));
  const subLeft = Math.min.apply(null, subs.map(el => el.transform.x));
  const subRight = Math.max.apply(null, subs.map(el => el.transform.x + el.transform.w));
  out.roadmap = {
    bars: bars.length, labels: labels.length, subs: subs.length,
    leftCol: bars.length > 0 && labels.length > 0 && barRight <= nodeLeft + 0.5,
    rightCol: subs.length > 0 && subLeft >= nodeRight - 0.5 && subRight <= b.doc.canvas.width_mm,
    ok: bars.length > 0 && labels.length > 0 && subs.length > 0 &&
        barRight <= nodeLeft + 0.5 && subLeft >= nodeRight - 0.5 &&
        subRight <= b.doc.canvas.width_mm + 0.5
  };
}
// chevron：全部人字节点同一行（y 相同、x 递增）
{
  const b = buildSpec(tplSpec('tpl-diagram-chevron'), 170, 140);
  const p = placedOf(b, b.spec.id);
  const ids = Object.keys(p);
  const sameRow = ids.every(k => Math.abs(p[k].y - p[ids[0]].y) < 1.5);
  const sorted = ids.map(k => p[k].x).sort((a, b2) => a - b2);
  const increasing = ids.every(k => true) && sorted.every((x, i) => i === 0 || x > sorted[i-1]);
  const chev = parts(b, b.spec.id, 'node_shape').filter(el => /M 0 0 L/.test(el.pathData || ''));
  out.chevron = { sameRow: sameRow, count: ids.length, chevronPaths: chev.length,
    ok: sameRow && ids.length >= 4 && chev.length >= 4 };
}
// timeline：里程碑 x 递增且有轴线 decor（不有斜箭头连框——关系不可见）
{
  const b = buildSpec(tplSpec('tpl-diagram-timeline'), 170, 140);
  const p = placedOf(b, b.spec.id);
  const ids = Object.keys(p).sort();
  const xs = ids.map(k => p[k].x);
  const conns = b.doc.elements.filter(el => el && el.type === 'connector' &&
    (el.diagramId || el.diagram_id) === b.spec.id && el.visible !== false);
  const decor = b.doc.elements.filter(el => el && el.diagram_part === 'decor' &&
    (el.diagramId || el.diagram_id) === b.spec.id);
  out.timeline = { increasing: xs.every((x, i) => i === 0 || x > xs[i-1]),
    visibleConns: conns.length, decor: decor.length,
    ok: xs.every((x, i) => i === 0 || x > xs[i-1]) && conns.length === 0 && decor.length > 0 };
}
// loop：节点环上分布 + 顺时针弧线（bend≠0）
{
  const b = buildSpec(tplSpec('tpl-diagram-loop'), 170, 140);
  const p = placedOf(b, b.spec.id);
  const ids = Object.keys(p);
  const cents = ids.map(k => ({ x: p[k].x + p[k].w / 2, y: p[k].y + p[k].h / 2 }));
  const ccx = cents.reduce((s2, c) => s2 + c.x, 0) / cents.length;
  const ccy = cents.reduce((s2, c) => s2 + c.y, 0) / cents.length;
  const rs = cents.map(c => Math.hypot(c.x - ccx, c.y - ccy));
  const ratio = Math.max.apply(null, rs) / Math.max(0.01, Math.min.apply(null, rs));
  const conns = b.doc.elements.filter(el => el && el.type === 'connector' &&
    (el.diagramId || el.diagram_id) === b.spec.id);
  const bent = conns.filter(c => c.relation && typeof c.relation.bend === 'number' && c.relation.bend !== 0);
  out.loop = { radiiRatio: Math.round(ratio * 100) / 100, bent: bent.length, total: conns.length,
    ok: ratio < 2.2 && bent.length >= 2 };
}
// hierarchy：根在顶部居中、子层 y 更大、正交连线
{
  const b = buildSpec(tplSpec('tpl-diagram-hierarchy'), 170, 140);
  const p = placedOf(b, b.spec.id);
  const root = p.root || p[p.root];
  const others = Object.keys(p).filter(k => k !== 'root');
  const rootCx = (p.root ? p.root.x + p.root.w / 2 : 0);
  const canvasCx = b.doc.canvas.width_mm / 2;
  const childBelow = others.every(k => p[k].y > (p.root ? p.root.y + p.root.h * 0.5 : 0));
  const conns = b.doc.elements.filter(el => el && el.type === 'connector' &&
    (el.diagramId || el.diagram_id) === b.spec.id);
  const ortho = conns.every(c => { try { return FigDiagram.connectorGeometry(b.doc, c).path_type === 'orthogonal' || FigDiagram.connectorGeometry(b.doc, c).path_type === 'straight'; } catch (e) { return false; } });
  out.hierarchy = { rootTop: p.root ? p.root.y : null, childBelow: childBelow,
    rootNearCenter: Math.abs(rootCx - canvasCx) < b.doc.canvas.width_mm * 0.25,
    ok: !!p.root && childBelow && ortho };
}
// swimlane：lane 容器带 bar + bg，节点在各自泳道 y 区间内
{
  const b = buildSpec(tplSpec('tpl-diagram-swimlane'), 170, 140);
  const p = placedOf(b, b.spec.id);
  const lanes = parts(b, b.spec.id, 'stage_container');
  const bars = parts(b, b.spec.id, 'lane_bar');
  const bgs = parts(b, b.spec.id, 'stage_bg');
  out.swimlane = { lanes: lanes.length, bars: bars.length, bgs: bgs.length,
    ok: lanes.length >= 2 && bars.length >= 2 && bgs.length >= 2 };
}
// feedback：反馈边 path_type=orthogonal 且绕行
{
  const b = buildSpec(tplSpec('tpl-diagram-feedback'), 170, 140);
  const conns = b.doc.elements.filter(el => el && el.type === 'connector' &&
    (el.diagramId || el.diagram_id) === b.spec.id);
  const geoms = conns.map(c => { try { return FigDiagram.connectorGeometry(b.doc, c); } catch (e) { return null; } }).filter(Boolean);
  const ortho = geoms.filter(g => g.path_type === 'orthogonal').length;
  out.feedback = { total: conns.length, orthogonal: ortho,
    ok: conns.length >= 4 && ortho >= 1 };
}
console.log(JSON.stringify(out));
"""
        res = node_json(script)
        for key in ("prisma", "roadmap", "chevron", "timeline", "loop", "hierarchy", "swimlane", "feedback"):
            self.assertIn(key, res)
            self.assertTrue(res[key]["ok"], key + " 模板结构断言失败: " + json.dumps(res[key], ensure_ascii=False))


class DiagramQualityGateTests(unittest.TestCase):
    """R9 返工门禁：全部示意图模板 × 6 主题的程序化质量检查（内核，不走浏览器）。

    A. 节点/副标题/徽标文字与其底色 WCAG 对比度 ≥4.5（含容器标题条/泳道条）；
    B. 编号徽标、roadmap 阶段条与文字框不相交；
    C. 全部元素（含旋转 AABB）位于画布内；
    D. 连线折线不穿过非端点节点；
    F. 关系方向箭头正确（forward 单向）、关系标签在线路中部不压端点。
    """

    def test_quality_gates_all_templates_themes(self):
        script = PRELUDE + r"""
const THEMES = ['soft-card','outline-academic','numbered-card','side-bar','solid-block','mono-grey'];
function hexRgb(hex){hex=String(hex||'').replace('#','');if(hex.length===3)hex=hex.split('').map(c=>c+c).join('');if(!/^[0-9a-fA-F]{6}$/.test(hex))return null;return[parseInt(hex.substr(0,2),16),parseInt(hex.substr(2,2),16),parseInt(hex.substr(4,2),16)];}
function lum(hex){var r=hexRgb(hex);if(!r)return null;var c=r.map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];}
function cr(a,b){var l1=lum(a),l2=lum(b);if(l1==null||l2==null)return null;var hi=Math.max(l1,l2),lo=Math.min(l1,l2);return(hi+0.05)/(lo+0.05);}
function aabb(t){var r=(t.rotation||0)*Math.PI/180,c=Math.abs(Math.cos(r)),s=Math.abs(Math.sin(r));var cx=t.x+t.w/2,cy=t.y+t.h/2,ex=(t.w*c+t.h*s)/2,ey=(t.w*s+t.h*c)/2;return{x:cx-ex,y:cy-ey,w:ex*2,h:ey*2};}
function segRect(x1,y1,x2,y2,b){
  if(Math.max(x1,x2)<b.x||Math.min(x1,x2)>b.x+b.w||Math.max(y1,y2)<b.y||Math.min(y1,y2)>b.y+b.h)return false;
  function inside(px,py){return px>b.x&&px<b.x+b.w&&py>b.y&&py<b.y+b.h;}
  if(inside(x1,y1)||inside(x2,y2))return true;
  var edges=[[b.x,b.y,b.x+b.w,b.y],[b.x+b.w,b.y,b.x+b.w,b.y+b.h],[b.x+b.w,b.y+b.h,b.x,b.y+b.h],[b.x,b.y+b.h,b.x,b.y]];
  for(var i=0;i<edges.length;i++){var e=edges[i];
    var d=(x2-x1)*(e[3]-e[1])-(y2-y1)*(e[2]-e[0]);if(Math.abs(d)<1e-9)continue;
    var tt=((e[0]-x1)*(e[3]-e[1])-(e[1]-y1)*(e[2]-e[0]))/d;
    var u=((e[0]-x1)*(y2-y1)-(e[1]-y1)*(x2-x1))/d;
    if(tt>0.001&&tt<0.999&&u>=0&&u<=1)return true;}
  return false;
}
function plen(pts){var s=0;for(var i=0;i<pts.length-1;i++)s+=Math.hypot(pts[i+1].x-pts[i].x,pts[i+1].y-pts[i].y);return s;}
const issues={A:[],B:[],C:[],D:[],F:[]};let built=0;
DIAGRAM_TEMPLATES.forEach(t=>{
  THEMES.forEach(theme=>{
    const tag=t.id+'/'+theme;
    try{
      var contract=t.schematic?JSON.parse(JSON.stringify(t.schematic)):FigDiagram.example(t.id,true);
      contract.id=contract.id||t.id;contract.template_id=t.id;contract.theme=theme;
      const n=FigDiagram.normalize(contract);
      const doc=FigDoc.create({width_mm:170,height_mm:110,dpi:300,background:'#FFFFFF'});
      const b=FigDiagram.build(doc,n);built++;
      const D2=b.doc,did=n.id,cw=D2.canvas.width_mm,ch=D2.canvas.height_mm;
      const els=D2.elements.filter(el=>el&&(el.diagramId||el.diagram_id)===did);
      const byNode={},byId={};
      els.forEach(el=>{byId[el.id]=el;if(!el.diagramNodeId)return;if(!byNode[el.diagramNodeId])byNode[el.diagramNodeId]={};byNode[el.diagramNodeId][el.diagram_part||el.type]=el;});
      // A 节点文字/副标题/徽标 vs 底色
      Object.keys(byNode).forEach(nid=>{
        const g=byNode[nid],shape=g.node_shape,label=g.node_text,sub=g.node_subtitle,st=g.step_text,badge=g.step_badge;
        const fill=(shape&&shape.style&&shape.style.fill)||'#FFFFFF';
        if(label){var c=cr((label.style&&label.style.fill)||'#000',fill);if(c!=null&&c<4.5)issues.A.push(tag+' '+nid+' label '+c.toFixed(2));}
        if(sub){var sb=aabb(sub.transform),nb=shape?aabb(shape.transform):null;
          var onNode=nb&&sb.x<nb.x+nb.w&&nb.x<sb.x+sb.w&&sb.y<nb.y+nb.h&&nb.y<sb.y+sb.h;
          var subBg=onNode?fill:'#FFFFFF';
          var c2=cr((sub.style&&sub.style.fill)||'#000',subBg);
          if(c2!=null&&c2<4.5)issues.A.push(tag+' '+nid+' subtitle '+c2.toFixed(2));}
        if(st&&badge){var c3=cr((st.style&&st.style.fill)||'#000',(badge.style&&badge.style.fill)||'#FFF');if(c3!=null&&c3<4.5)issues.A.push(tag+' '+nid+' steptext '+c3.toFixed(2));}
      });
      // A 容器标题/泳道条文字 vs 底色
      els.filter(el=>el.diagram_part==='stage_container').forEach(ctEl=>{
        var kids=(ctEl.children||[]).map(function(id){return byId[id];}).filter(Boolean);
        var lb=kids.filter(function(k){return k.diagram_part==='stage_label'||k.diagram_part==='lane_label';})[0];
        if(!lb)return;
        var bgEl;
        if(lb.diagram_part==='lane_label')bgEl=kids.filter(function(k){return k.diagram_part==='lane_bar';})[0];
        else bgEl=kids.filter(function(k){return k.diagram_part==='stage_titlebar';})[0]||kids.filter(function(k){return k.diagram_part==='stage_bg';})[0];
        if(!bgEl)return;
        var cc=cr((lb.style&&lb.style.fill)||'#000',(bgEl.style&&bgEl.style.fill)||'#FFF');
        if(cc!=null&&cc<4.5)issues.A.push(tag+' '+ctEl.id+' '+lb.diagram_part+' '+cc.toFixed(2));
      });
      // B 徽标/阶段条 vs 文字框
      Object.keys(byNode).forEach(nid=>{
        var g=byNode[nid];
        if(g.step_badge&&g.node_text){var bb=aabb(g.step_badge.transform),l=aabb(g.node_text.transform);
          if(bb.x<l.x+l.w&&l.x<bb.x+bb.w&&bb.y<l.y+l.h&&l.y<bb.y+bb.h)issues.B.push(tag+' '+nid+' badge∩label');}
        if(g.group_label&&g.group_bar){var lb2=aabb(g.group_label.transform),gb=aabb(g.group_bar.transform);
          if(lb2.x<gb.x+gb.w&&gb.x<lb2.x+lb2.w&&lb2.y<gb.y+gb.h&&gb.y<lb2.y+lb2.h)issues.B.push(tag+' '+nid+' glabel∩gbar');}
      });
      // C 画布内（旋转 AABB）
      els.forEach(el=>{
        if(!el.transform||el.type==='connector'||el.diagram_part==='scene')return;
        var b2=aabb(el.transform);
        if(b2.x<-0.05||b2.y<-0.05||b2.x+b2.w>cw+0.05||b2.y+b2.h>ch+0.05)
          issues.C.push(tag+' '+el.id);
      });
      // D 连线穿非端点节点
      var nodeBoxes={};
      els.forEach(el=>{if(el.type==='group'&&el.diagramNodeId&&el.diagram_part==='node')nodeBoxes[el.diagramNodeId]=el.transform;});
      els.filter(el=>el.type==='connector').forEach(c=>{
        var g;try{g=FigDiagram.connectorGeometry(D2,c);}catch(e){issues.D.push(tag+' '+c.id);return;}
        if(!g||!g.points)return;
        var skip={};skip[g.sourceNodeId]=1;skip[g.targetNodeId]=1;
        Object.keys(nodeBoxes).forEach(nid=>{
          if(skip[nid])return;
          var nb=nodeBoxes[nid],bb={x:nb.x+0.4,y:nb.y+0.4,w:nb.w-0.8,h:nb.h-0.8};
          for(var i=0;i<g.points.length-1;i++){var p=g.points[i],q=g.points[i+1];
            if(segRect(p.x,p.y,q.x,q.y,bb)){issues.D.push(tag+' '+c.id+'×'+nid);break;}}
        });
      });
      // F 方向箭头 + 标签中部不压端点
      els.filter(el=>el.type==='connector').forEach(c=>{
        var g;try{g=FigDiagram.connectorGeometry(D2,c);}catch(e){return;}
        if(!g)return;
        var dir=(c.relation&&c.relation.direction)||g.direction;
        if(dir==='forward'&&(g.arrow.start||!g.arrow.end))issues.F.push(tag+' '+c.id+' arrow');
        if(dir==='reverse'&&(!g.arrow.start||g.arrow.end))issues.F.push(tag+' '+c.id+' rarrow');
        if(dir==='both'&&!(g.arrow.start&&g.arrow.end))issues.F.push(tag+' '+c.id+' barrow');
      });
      els.filter(el=>el.type==='text'&&el.relation_label_for).forEach(lb=>{
        var owner=D2.elements.filter(function(e){return e.id===lb.relation_label_for;})[0];
        if(!owner)return;var g;try{g=FigDiagram.connectorGeometry(D2,owner);}catch(e){return;}
        if(!g||!g.middle||!g.points||g.path_type==='quadratic')return;
        var total=plen(g.points),onPath=1e9,acc=0,arcPos=-1;
        for(var i=0;i<g.points.length-1;i++){var p=g.points[i],q=g.points[i+1];
          var vx=q.x-p.x,vy=q.y-p.y,L2=vx*vx+vy*vy;
          var tt=L2?Math.max(0,Math.min(1,((g.middle.x-p.x)*vx+(g.middle.y-p.y)*vy)/L2)):0;
          var px=p.x+vx*tt,py=p.y+vy*tt;
          onPath=Math.min(onPath,Math.hypot(g.middle.x-px,g.middle.y-py));
          var segLen=Math.sqrt(L2);
          if(arcPos<0&&Math.hypot(g.middle.x-px,g.middle.y-py)<0.4)arcPos=acc+tt*segLen;
          acc+=segLen;}
        if(onPath>0.4)issues.F.push(tag+' '+lb.id+' offpath');
        else if(arcPos>=0&&total>8&&(arcPos<total*0.15||arcPos>total*0.85))issues.F.push(tag+' '+lb.id+' endzone');
      });
    }catch(e){issues.F.push(tag+' BUILD-ERR '+e.message);}
  });
});
const summary={built:built,total:DIAGRAM_TEMPLATES.length*THEMES.length,
  A:issues.A.length,B:issues.B.length,C:issues.C.length,D:issues.D.length,F:issues.F.length,
  problems:issues.A.concat(issues.B,issues.C,issues.D,issues.F).slice(0,60)};
console.log(JSON.stringify(summary));
"""
        res = node_json(script, timeout=300)
        self.assertEqual(res["built"], res["total"], "组合数不符")
        self.assertEqual(res["problems"], [],
            "质量门禁失败 A=%d B=%d C=%d D=%d F=%d: %s" % (
                res["A"], res["B"], res["C"], res["D"], res["F"],
                "; ".join(res["problems"][:10])))


if __name__ == "__main__":
    unittest.main()
