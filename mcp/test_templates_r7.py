# -*- coding: utf-8 -*-
"""test_templates_r7.py — R7 表征/统计图模板（内核级 + 一处 UI）。

覆盖 handoff 要求：
  1. presets 加载校验：chart_overrides 非法键/非法枚举/未知 style_id/
     hints 超限/preview 非法 → load 报错；references/bands/significance/
     letters/peak_annotations 等数据标注键 → 直接报错；
  2. 20 个新模板全部 apply_template 成功，chart_overrides 生效
     （legend.position / tick.hidden / componentFill / seriesColors /
     errorStyle / styleRef）；
  3. hints 由 templateFromStats 返回但不写入文档；
  4. 「默认风格先套、模板 overrides 后套」优先级：apply_chart_style
     之后 templateOverrideOps 仍能把 legend.position 改回模板值，
     style_id 模板最终 styleRef 为模板风格；
  5. 向导推荐：XRD/XPS 等 technique 列名命中时新模板进入 recommend 列表；
  6. UI：模板画廊出现「电化学」「统计」筛选；应用模板后 props 显示
     hints 且可关闭（会话内，不写入文档）。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def node_json(script, timeout=90):
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
for (const f of ['figdoc','ops','palette','presets','data','render']) {
  require('./lib/'+f+'.js');
}
const BUNDLE={
  journals: JSON.parse(fs.readFileSync('../presets/journals.json','utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json','utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json','utf8')),
  styles: JSON.parse(fs.readFileSync('../presets/styles.json','utf8'))
};
function loadBundle(b){ FigPresets.load(b || BUNDLE); }
loadBundle();
const NEW_IDS=['tpl-xrd-stack','tpl-xps-fit-filled','tpl-xps-stack','tpl-raman-stack',
 'tpl-ftir-stack','tpl-uvvis-gradient','tpl-pl-gradient','tpl-cv-scanrate',
 'tpl-lsv-multi','tpl-gcd-cycles','tpl-cycling-dual','tpl-rate-capability',
 'tpl-eis-nyquist-fit','tpl-tafel','tpl-bet-isotherm','tpl-tga-dtg',
 'tpl-xanes-stack','tpl-bar-significance','tpl-bar-hatch','tpl-line-band'];
function xrdData(){ const cols=['2θ','Intensity','Sample'],rows=[];
  for(let i=0;i<70;i++){const x=10+i*1.0;
    rows.push([x,+(100+300*Math.exp(-((x-26.6)*(x-26.6))/2)+180*Math.exp(-((x-36.5)*(x-36.5))/3)+
      120*Math.exp(-((x-44.9)*(x-44.9))/2)+Math.sin(i)*8).toFixed(2),['A','B','C'][i%3]]);}
  return {columns:cols,rows:rows}; }
function xpsData(){ const cols=['BE','Intensity','Sample'],rows=[];
  for(let i=0;i<80;i++){const x=850-i*5;
    rows.push([x,+(50+900*Math.exp(-((x-710)*(x-710))/300)+500*Math.exp(-((x-712)*(x-712))/120)+
      Math.sin(i)*4).toFixed(2),['S1','S2'][i%2]]);}
  return {columns:cols,rows:rows}; }
function barData(){ return {columns:['cat','v','grp'],
  rows:[['a',10,'x'],['a',12,'y'],['b',15,'x'],['b',18,'y'],['c',9,'x'],['c',14,'y']]}; }
function scatterData(){ const cols=['cyc','cap','ce'],rows=[];
  for(let i=1;i<=60;i++)rows.push([i,150-i*0.3+Math.sin(i)*2,99+Math.sin(i*0.7)*0.5]);
  return {columns:cols,rows:rows}; }
"""


def run(script):
    return node_json(PRELUDE + script)


class PresetValidationTests(unittest.TestCase):
    """chart_overrides/hints/preview/group 加载期校验。"""

    def _load_with(self, extra_tpl):
        script = r"""
(function(){
  const b=JSON.parse(JSON.stringify(BUNDLE));
  b.templates.templates.push(%s);
  try { FigPresets.load(b); console.log(JSON.stringify({ok:true})); }
  catch(e){ console.log(JSON.stringify({ok:false, err:String(e.message||e)})); }
})()
""" % json.dumps(extra_tpl)
        return run(script)

    def test_valid_overrides_load(self):
        r = self._load_with({
            "id": "tpl-ok", "name": "ok", "category": "chart",
            "chart_type": "line", "panels": [1, 1], "default_mapping": {},
            "chart_overrides": {
                "presentation": {"legend": {"position": "inline"},
                    "axes": {"y": {"tick": {"hidden": True}}},
                    "plot": {"seriesColors": {"mode": "gradient",
                        "palette": "viridis",
                        "colorbar": {"show": True, "label": "Score"}}}},
                "axes": {"yMin": 0, "yMax": None},
                "characterization": {"technique": "XRD", "x_reverse": False},
                "style_id": "nature-minimal"},
            "hints": ["提示一"], "preview": "xrd-stack", "group": "stats"})
        self.assertTrue(r["ok"], r)

    def test_unknown_override_key_rejected(self):
        r = self._load_with({
            "id": "tpl-bad1", "name": "b", "category": "chart",
            "chart_type": "bar", "panels": [1, 1], "default_mapping": {},
            "chart_overrides": {"bogus": 1}})
        self.assertFalse(r["ok"])
        self.assertIn("不支持的键", r["err"])

    def test_data_annotation_keys_rejected(self):
        for key in ["references", "bands", "significance", "letters"]:
            r = self._load_with({
                "id": "tpl-bad-" + key, "name": "b", "category": "chart",
                "chart_type": "bar", "panels": [1, 1], "default_mapping": {},
                "chart_overrides": {key: []}})
            self.assertFalse(r["ok"], key)
            self.assertIn("数据标注", r["err"])
        # characterization.peak_annotations 同样禁止（白名单外的键）
        r = self._load_with({
            "id": "tpl-bad-peak", "name": "b", "category": "chart",
            "chart_type": "line", "panels": [1, 1], "default_mapping": {},
            "chart_overrides": {"characterization": {
                "technique": "XRD", "peak_annotations": [{"x": 26.6}]}}})
        self.assertFalse(r["ok"])
        self.assertIn("peak_annotations", r["err"])

    def test_bad_enum_and_style_rejected(self):
        r = self._load_with({
            "id": "tpl-bad2", "name": "b", "category": "chart",
            "chart_type": "line", "panels": [1, 1], "default_mapping": {},
            "chart_overrides": {"presentation": {"legend": {"position": "middle"}}}})
        self.assertFalse(r["ok"])
        self.assertIn("legend.position", r["err"])
        r = self._load_with({
            "id": "tpl-bad3", "name": "b", "category": "chart",
            "chart_type": "line", "panels": [1, 1], "default_mapping": {},
            "chart_overrides": {"style_id": "no-such-style"}})
        self.assertFalse(r["ok"])
        self.assertIn("style_id", r["err"])
        r = self._load_with({
            "id": "tpl-bad4", "name": "b", "category": "chart",
            "chart_type": "line", "panels": [1, 1], "default_mapping": {},
            "chart_overrides": {"axes": {"xMin": "ten"}}})
        self.assertFalse(r["ok"])
        self.assertIn("xMin", r["err"])

    def test_hints_and_preview_rules(self):
        r = self._load_with({
            "id": "tpl-bad5", "name": "b", "category": "chart",
            "chart_type": "line", "panels": [1, 1], "default_mapping": {},
            "hints": ["x" * 61]})
        self.assertFalse(r["ok"])
        self.assertIn("hints", r["err"])
        r = self._load_with({
            "id": "tpl-bad6", "name": "b", "category": "chart",
            "chart_type": "line", "panels": [1, 1], "default_mapping": {},
            "hints": ["1", "2", "3", "4", "5"]})
        self.assertFalse(r["ok"])
        r = self._load_with({
            "id": "tpl-bad7", "name": "b", "category": "chart",
            "chart_type": "line", "panels": [1, 1], "default_mapping": {},
            "preview": "Bad Slug!"})
        self.assertFalse(r["ok"])
        self.assertIn("preview", r["err"])

    def test_shipped_templates_all_valid(self):
        # 正式库 90 个模板全部通过加载校验（load 已在 PRELUDE 执行；R9 +8 示意图）
        r = run("console.log(JSON.stringify({n: FigPresets.templates().length, "
                "newOk: NEW_IDS.every(id=>!!FigPresets.template(id))}));")
        self.assertEqual(r["n"], 90)
        self.assertTrue(r["newOk"])

    def test_all_template_previews(self):
        failures = run(r"""
require('./lib/diagram.js');
require('./viewer_static/app/template-preview.js');
const failures = [];
for (const tpl of FigPresets.templates()) {
  try {
    const svg = TemplatePreview.svg(tpl);
    if (!svg || !svg.startsWith('<svg ') || !svg.endsWith('</svg>')) {
      failures.push([tpl.id, '缺少 SVG 预览']);
    } else if (svg.includes('data-preview-empty="true"')) {
      failures.push([tpl.id, '空白占位预览']);
    }
  } catch (err) {
    failures.push([tpl.id, err.message]);
  }
}
console.log(JSON.stringify(failures));
""")
        self.assertEqual(failures, [])


class TemplateApplyTests(unittest.TestCase):
    """20 个新模板 apply_template 成功 + overrides 生效 + hints/优先级。"""

    def _apply(self, tpl_id, data):
        return run(r"""
(function(){
  let doc=FigDoc.create({title:'t',width_mm:120,height_mm:90});
  const res=FigOps.applyAll(doc,[{op:'apply_template',template_id:%s,
    data:%s,options:{}}],{label:'t'});
  const charts=res.doc.elements.filter(e=>e.type==='chart');
  const c=charts[0]&&charts[0].chart||{};
  const p=c.presentation||{};
  console.log(JSON.stringify({applied:!!res.applied!==false, nCharts:charts.length,
    legend:(p.legend&&p.legend.position)||(c.legend||null),
    yTickHidden:!!(p.axes&&p.axes.y&&p.axes.y.tick&&p.axes.y.tick.hidden===true),
    componentFill:!!(p.plot&&p.plot.componentFill===true),
    errorStyle:(p.plot&&p.plot.errorStyle)||null,
    scMode:(p.plot&&p.plot.seriesColors&&p.plot.seriesColors.mode)||null,
    scColorbar:!!(p.plot&&p.plot.seriesColors&&p.plot.seriesColors.colorbar&&
      p.plot.seriesColors.colorbar.show===true),
    styleRef:(c.styleRef&&c.styleRef.id)||null,
    charOffset:!!(c.characterization&&typeof c.characterization.offset_each_series==='number'&&
      c.characterization.offset_each_series>0),
    charReverse:(c.characterization&&c.characterization.x_reverse===true),
    xScaleLog:(c.axes&&c.axes.yScale)||null,
    equalAspect:!!(c.characterization&&c.characterization.equal_aspect===true),
    docHasHints:JSON.stringify(res.doc).indexOf('下一步')>=0}));
})()
""" % (json.dumps(tpl_id), data))

    def test_unequal_layouts_apply(self):
        layouts = run(r"""
const result = {};
for (const id of ['tpl-composite-top-large', 'tpl-composite-left-wide']) {
  const {doc} = FigOps.applyAll(FigDoc.create(), [{op:'apply_template', template_id:id}]);
  const panel = doc.elements.find(el => el.type === 'panel');
  const rects = panel.children.map(cid => doc.elements.find(el => el.id === cid).transform);
  result[id] = {rects, areas: panel.panelLayout.areas};
}
console.log(JSON.stringify(result));
""")
        top, left, right = layouts["tpl-composite-top-large"]["rects"]
        self.assertEqual(len(layouts["tpl-composite-top-large"]["areas"]), 3)
        self.assertGreater(top["w"], left["w"])
        self.assertGreater(top["h"], left["h"])
        self.assertLess(top["y"] + top["h"], left["y"])
        self.assertEqual(left["y"], right["y"])
        self.assertEqual(left["w"], right["w"])
        left, right = layouts["tpl-composite-left-wide"]["rects"]
        self.assertEqual(len(layouts["tpl-composite-left-wide"]["areas"]), 2)
        self.assertLess(left["x"] + left["w"], right["x"])
        self.assertGreater(left["w"], right["w"])
        self.assertEqual(left["h"], right["h"])

    def test_all_20_apply(self):
        cases = {
            "tpl-xrd-stack": ("xrdData()", {"legend": "inline",
                "yTickHidden": True, "charOffset": True}),
            "tpl-xps-fit-filled": ("xpsData()", {"componentFill": True,
                "yTickHidden": True}),
            "tpl-xps-stack": ("xpsData()", {"legend": "inline",
                "charOffset": True, "charReverse": True}),
            "tpl-raman-stack": ("xrdData()", {"legend": "inline",
                "charOffset": True}),
            "tpl-ftir-stack": ("xrdData()", {"legend": "inline",
                "charReverse": True}),
            "tpl-uvvis-gradient": ("xrdData()", {"scMode": "gradient",
                "scColorbar": True}),
            "tpl-pl-gradient": ("xrdData()", {"scMode": "gradient",
                "scColorbar": True}),
            "tpl-cv-scanrate": ("xrdData()", {"scMode": "gradient",
                "scColorbar": True}),
            "tpl-lsv-multi": ("xrdData()", {"legend": "inline"}),
            "tpl-gcd-cycles": ("xrdData()", {"scMode": "gradient",
                "scColorbar": True}),
            "tpl-cycling-dual": ("scatterData()", {}),
            "tpl-rate-capability": ("scatterData()", {}),
            "tpl-eis-nyquist-fit": ("scatterData()", {"equalAspect": True}),
            "tpl-tafel": ("xrdData()", {}),
            "tpl-bet-isotherm": ("xrdData()", {"legend": "inline"}),
            "tpl-tga-dtg": ("xrdData()", {}),
            "tpl-xanes-stack": ("xrdData()", {"legend": "inline",
                "charOffset": True}),
            "tpl-bar-significance": ("barData()", {}),
            "tpl-bar-hatch": ("barData()", {"styleRef": "mono-print"}),
            "tpl-line-band": ("xrdData()", {"errorStyle": "band"}),
        }
        for tpl_id, (data_fn, expect) in cases.items():
            r = self._apply(tpl_id, data_fn)
            self.assertGreaterEqual(r["nCharts"], 1, tpl_id)
            self.assertFalse(r["docHasHints"], tpl_id + " hints 不应写入文档")
            for k, v in expect.items():
                self.assertEqual(r[k], v, "%s %s: %r != %r" % (tpl_id, k, r[k], v))

    def test_hints_returned_not_in_doc(self):
        r = run(r"""
(function(){
  const built=FigPresets.templateFromStats('tpl-xrd-stack', xrdData(), {});
  const tpl=FigPresets.template('tpl-xrd-stack');
  let doc=FigDoc.create({title:'t',width_mm:120,height_mm:90});
  const res=FigOps.applyAll(doc,[{op:'apply_template',template_id:'tpl-xrd-stack',
    data:xrdData(),options:{}}],{label:'t'});
  console.log(JSON.stringify({builtHints:built.hints, tplHints:tpl.hints,
    docJson:JSON.stringify(res.doc), metaTpl:res.doc.meta&&res.doc.meta.template_id}));
})()
""")
        self.assertEqual(len(r["builtHints"]), 2)
        self.assertEqual(r["builtHints"], r["tplHints"])
        for hint in r["tplHints"]:
            self.assertNotIn(hint, r["docJson"])
        self.assertEqual(r["metaTpl"], "tpl-xrd-stack")

    def test_default_style_then_template_overrides(self):
        # 优先级：apply_template(物化含 overrides) → apply_chart_style(默认)
        # → templateOverrideOps → 最终 presentation.legend.position 仍是
        # 模板值 inline；style_id 模板最终 styleRef 为模板风格。
        r = run(r"""
(function(){
  // applyAll 返回新 doc（不原地改），须逐级接力
  let doc=FigDoc.create({title:'t',width_mm:120,height_mm:90});
  doc=FigOps.applyAll(doc,[{op:'apply_template',template_id:'tpl-xrd-stack',
    data:xrdData(),options:{}}],{label:'t'}).doc;
  // 模拟 UI 默认风格（替换式，会重建 legend.position 等风格键）
  doc=FigOps.applyAll(doc,[{op:'apply_chart_style',
    targets:[{kind:'type',type:'chart'}],style_id:'nature-minimal'}],{label:'s'}).doc;
  let c1=doc.elements.filter(e=>e.type==='chart')[0].chart;
  const midLegend=(c1.presentation&&c1.presentation.legend&&
    c1.presentation.legend.position)||null;
  // 模板 overrides 后置 ops
  const ops=FigPresets.templateOverrideOps('tpl-xrd-stack',
    doc.elements.filter(e=>e.type==='chart').map(e=>e.id));
  doc=FigOps.applyAll(doc,ops,{label:'ov'}).doc;
  c1=doc.elements.filter(e=>e.type==='chart')[0].chart;
  const finLegend=(c1.presentation&&c1.presentation.legend&&
    c1.presentation.legend.position)||null;
  const finHidden=!!(c1.presentation.axes&&c1.presentation.axes.y&&
    c1.presentation.axes.y.tick&&c1.presentation.axes.y.tick.hidden===true);
  // style_id 模板：默认风格 → 模板风格最终生效
  let doc2=FigDoc.create({title:'t',width_mm:120,height_mm:90});
  doc2=FigOps.applyAll(doc2,[{op:'apply_template',template_id:'tpl-bar-hatch',
    data:barData(),options:{}}],{label:'t'}).doc;
  doc2=FigOps.applyAll(doc2,[{op:'apply_chart_style',
    targets:[{kind:'type',type:'chart'}],style_id:'nature-minimal'}],{label:'s'}).doc;
  const ops2=FigPresets.templateOverrideOps('tpl-bar-hatch',
    doc2.elements.filter(e=>e.type==='chart').map(e=>e.id));
  doc2=FigOps.applyAll(doc2,ops2,{label:'ov'}).doc;
  const c2=doc2.elements.filter(e=>e.type==='chart')[0].chart;
  console.log(JSON.stringify({opsLen:ops.length, midLegend:midLegend, finLegend:finLegend,
    finHidden:finHidden,
    styleRef:(c2.styleRef&&c2.styleRef.id)||null, ops2Len:ops2.length}));
})()
""")
        # 默认风格 nature-minimal 的 legend.position 非 inline（被替换式重建）
        self.assertEqual(r["opsLen"], 1)
        self.assertEqual(r["finLegend"], "inline")
        self.assertTrue(r["finHidden"])
        self.assertEqual(r["styleRef"], "mono-print")
        self.assertEqual(r["ops2Len"], 1)  # 仅 apply_chart_style(style_id)

    def test_eis_nyquist_fit_equal_aspect_render(self):
        # tpl-eis-nyquist-fit 改 line 后：fit 用户列必须画成曲线，
        # characterization.equal_aspect 必须真实扩域（y 域明显宽于数据）。
        r = run(r"""
(function(){
  const cols=['zr','nzi','fit'],rows=[];
  for(let i=0;i<=60;i++){const t=i/60*Math.PI;
    const zr=10-8*Math.cos(t), nzi=6*Math.sin(t)*(1-0.15*t);
    const fit=6*Math.sin(t*0.98)*(1-0.15*t)+Math.sin(i)*0.05;
    rows.push([+zr.toFixed(3),+nzi.toFixed(3),+fit.toFixed(3)]);}
  let doc=FigDoc.create({title:'t',width_mm:120,height_mm:90});
  doc=FigOps.applyAll(doc,[{op:'apply_template',template_id:'tpl-eis-nyquist-fit',
    data:{columns:cols,rows:rows},
    options:{mapping:{x:'zr',y:'nzi',fit:'fit'}}}],{label:'t'}).doc;
  const el=doc.elements.filter(e=>e.type==='chart')[0];
  const opt={width_mm:100,height_mm:80,dpi:150,fontFamily:'Arial',fontSizePt:7};
  const svg=FigData.renderChartSVG(el.chart,opt);
  const keys=new Set([...svg.matchAll(/data-series-key="([^"]+)"/g)].map(m=>m[1]));
  // 等比断言：x/y 轴「像素/数据单位」必须相等（刻度值跨度不变，
  // 域是被扩的，所以要比刻度间距换算出的比例而不是标签极值）。
  function tickScale(part, posAttr){
    const ts=[...svg.matchAll(new RegExp(
      '<text x="([\\d.]+)" y="([\\d.]+)"[^>]*data-chart-part="'+part+'"[^>]*>([^<]+)</text>','g'))]
      .map(m=>({v:parseFloat(m[3]),p:parseFloat(m[posAttr==='x'?1:2])}))
      .filter(t=>isFinite(t.v)&&isFinite(t.p)).sort((a,b)=>a.v-b.v);
    if(ts.length<2)return null;
    let num=0,den=0;
    for(let i=1;i<ts.length;i++){num+=Math.abs(ts[i].p-ts[i-1].p);den+=Math.abs(ts[i].v-ts[i-1].v);}
    return den?num/den:null;
  }
  const scX=tickScale('axis-tick-x','x'), scY=tickScale('axis-tick-y','y');
  const c2=JSON.parse(JSON.stringify(el.chart));
  // technique='EIS Nyquist' 本身也会触发等比（charEqualAspect 的 technique 规则），
  // 对照组必须同时改 technique 才能真正关闭。
  c2.characterization.equal_aspect=false;
  c2.characterization.technique='Generic';
  const svg2=FigData.renderChartSVG(c2,opt);
  function tickScale2(part,posAttr){
    const ts=[...svg2.matchAll(new RegExp(
      '<text x="([\\d.]+)" y="([\\d.]+)"[^>]*data-chart-part="'+part+'"[^>]*>([^<]+)</text>','g'))]
      .map(m=>({v:parseFloat(m[3]),p:parseFloat(m[posAttr==='x'?1:2])}))
      .filter(t=>isFinite(t.v)&&isFinite(t.p)).sort((a,b)=>a.v-b.v);
    if(ts.length<2)return null;
    let num=0,den=0;
    for(let i=1;i<ts.length;i++){num+=Math.abs(ts[i].p-ts[i-1].p);den+=Math.abs(ts[i].v-ts[i-1].v);}
    return den?num/den:null;
  }
  const scY2=tickScale2('axis-tick-y','y');
  console.log(JSON.stringify({seriesKeys:[...keys],scX:scX,scY:scY,scYNoEq:scY2}));
})()
""")
        keys = r["seriesKeys"]
        self.assertTrue(any(k.startswith("curve|fit") for k in keys),
                        "fit 用户列应画成曲线系列：%s" % keys)
        self.assertGreater(len(keys), 1, "raw + fit 应为两个系列")
        # 等比：x/y 轴 px/单位 相等（容差 2%，刻度取整造成的小偏差）
        self.assertIsNotNone(r["scX"])
        self.assertIsNotNone(r["scY"])
        self.assertAlmostEqual(r["scX"], r["scY"], delta=r["scX"] * 0.02,
                               msg="equal_aspect 应使 x/y 轴比例一致：%s vs %s" %
                               (r["scX"], r["scY"]))
        # 对照：关闭等比后 y 比例应明显不同（证明断言确实在测等比）
        self.assertIsNotNone(r["scYNoEq"])
        self.assertGreater(abs(r["scYNoEq"] - r["scX"]) / r["scX"], 0.05,
                           "关闭 equal_aspect 后轴比例应不同：%s" % r)

    def test_tga_dtg_dual_axis_render(self):
        # tpl-tga-dtg 用普通 line_multi（无 characterization）：
        # 宽表 ys + axes.y2 必须画出右轴刻度与标题，轴标题来自模板覆盖。
        r = run(r"""
(function(){
  const cols=['temp','mass','dtg'],rows=[];
  for(let i=0;i<=100;i++){const t=30+i*8.7;
    const mass=99.5-62/(1+Math.exp(-(t-320)/25))-18/(1+Math.exp(-(t-560)/30));
    const dtg=62*0.06*Math.exp(-((t-320)*(t-320))/800)+18*0.05*Math.exp(-((t-560)*(t-560))/1200);
    rows.push([+t.toFixed(1),+mass.toFixed(3),+dtg.toFixed(4)]);}
  let doc=FigDoc.create({title:'t',width_mm:120,height_mm:90});
  doc=FigOps.applyAll(doc,[{op:'apply_template',template_id:'tpl-tga-dtg',
    data:{columns:cols,rows:rows},
    options:{mapping:{x:'temp',ys:['mass','dtg'],group:null},
      axes:{y2:{series:['dtg'],label:'DTG (%/min)',min:0,max:0.9}}}}],{label:'t'}).doc;
  const el=doc.elements.filter(e=>e.type==='chart')[0];
  const svg=FigData.renderChartSVG(el.chart,
    {width_mm:100,height_mm:80,dpi:150,fontFamily:'Arial',fontSizePt:7});
  const y2l=[...svg.matchAll(/data-chart-part="axis-tick-y2"[^>]*>([^<]+)</g)]
    .map(m=>parseFloat(m[1])).filter(isFinite);
  console.log(JSON.stringify({y2ticks:y2l,
    hasY2Title:/axis-title-y2/.test(svg),
    xLabel:/Temperature \(°C\)/.test(svg), yLabel:/Mass \(%\)/.test(svg),
    isChar:!!(el.chart.characterization)}));
})()
""")
        self.assertFalse(r["isChar"], "tpl-tga-dtg 不应再走表征渲染路径（不支持双轴）")
        self.assertTrue(r["y2ticks"], "应有右轴刻度标签")
        self.assertLessEqual(max(r["y2ticks"]), 1.0,
                             "右轴刻度应是 DTG 量级而非质量分数：%s" % r["y2ticks"])
        self.assertTrue(r["hasY2Title"], "应有右轴标题")
        self.assertTrue(r["xLabel"] and r["yLabel"], "轴标题应来自模板覆盖")

    def test_inline_legend_min_spacing(self):
        # 行内标签防重叠：相邻标签基线间距 ≥ 字高×1.2；被推离曲线末端
        # 足够远时必须画细引线（data-legend-pos="inline" 组内 <line>）。
        r = run(r"""
(function(){
  const cols=['x','y','g'],rows=[];
  // 三系列末端几乎重合（同相位、gi 仅 0.002 差）→ 行内标签被大力推开，
  // 必然产生引线；同时验证间距仍 ≥ 字高×1.2。
  ['A','B','C'].forEach(function(g,gi){
    for(let i=0;i<=20;i++){
      rows.push([i,+(10+gi*0.002+Math.sin(i*0.35)*0.05).toFixed(4),g]);}
  });
  let doc=FigDoc.create({title:'t',width_mm:120,height_mm:90});
  doc=FigOps.applyAll(doc,[{op:'apply_template',template_id:'tpl-line-multi',
    data:{columns:cols,rows:rows},
    options:{mapping:{x:'x',y:'y',group:'g'}}}],{label:'t'}).doc;
  doc=FigOps.applyAll(doc,[{op:'set_chart_properties',
    targets:[{kind:'type',type:'chart'}],
    properties:{presentation:{legend:{position:'inline'}}}}],{label:'l'}).doc;
  const el=doc.elements.filter(e=>e.type==='chart')[0];
  const svg=FigData.renderChartSVG(el.chart,
    {width_mm:100,height_mm:80,dpi:150,fontFamily:'Arial',fontSizePt:7});
  const m=svg.match(/<g data-legend-pos="inline">([\s\S]*?)<\/g>/);
  if(!m){console.log(JSON.stringify({err:'no-inline-group'}));return;}
  const body=m[1];
  const texts=[...body.matchAll(
    /<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*data-chart-part="legend"[^>]*>([^<]+)<\/text>/g)]
    .map(t=>({x:+t[1],y:+t[2],size:+t[3],label:t[4]})).sort((a,b)=>a.y-b.y);
  const lines=(body.match(/<line /g)||[]).length;
  const gaps=[];
  for(let i=1;i<texts.length;i++)gaps.push(+(texts[i].y-texts[i-1].y).toFixed(3));
  const minSize=texts.length?Math.min.apply(null,texts.map(t=>t.size)):0;
  console.log(JSON.stringify({n:texts.length,gaps:gaps,minGap:+(1.2*minSize).toFixed(3),
    lines:lines,labels:texts.map(t=>t.label)}));
})()
""")
        self.assertNotIn("err", r, "应渲染出 inline 图例组：%s" % r)
        self.assertGreaterEqual(r["n"], 2, "应有至少 2 个行内标签：%s" % r)
        for g in r["gaps"]:
            self.assertGreaterEqual(g, r["minGap"] - 0.6,
                "行内标签间距 %.2f < 字高×1.2=%.2f（%s）" % (g, r["minGap"], r))
        self.assertGreaterEqual(r["lines"], 1,
            "末端聚集的标签被推开后应有引线：%s" % r)

    def test_recommend_includes_new_templates(self):
        r = run(r"""
(function(){
  const stX=FigData.columnStats(xrdData());
  const recX=FigPresets.recommend(stX,{n:30}).map(x=>x.template_id);
  const stB=FigData.columnStats(barData());
  const recB=FigPresets.recommend(stB,{n:30}).map(x=>x.template_id);
  const stS=FigData.columnStats(scatterData());
  const recS=FigPresets.recommend(stS,{n:30}).map(x=>x.template_id);
  console.log(JSON.stringify({xrd:recX, bar:recB, scatter:recS}));
})()
""")
        self.assertIn("tpl-xrd-stack", r["xrd"])
        self.assertIn("tpl-bar-significance", r["bar"])
        self.assertIn("tpl-bar-hatch", r["bar"])
        # scatterData 含标准差? 否——line-band 需要 std 角色，跳过；
        # rate-capability/cycling-dual 无 technique 规则不进入推荐（按设计）
        for tid in ["tpl-xrd-stack", "tpl-raman-stack", "tpl-xps-stack",
                    "tpl-ftir-stack", "tpl-uvvis-gradient", "tpl-pl-gradient",
                    "tpl-eis-nyquist-fit", "tpl-cv-scanrate", "tpl-tafel",
                    "tpl-bet-isotherm", "tpl-tga-dtg", "tpl-xanes-stack",
                    "tpl-bar-significance", "tpl-bar-hatch", "tpl-line-band"]:
            self.assertTrue(FigPresets_template_exists(tid), tid)


def FigPresets_template_exists(tid):
    r = run("console.log(JSON.stringify({ok: !!FigPresets.template(%s)}));" % json.dumps(tid))
    return r["ok"]


# ---------------------------------------------------------------- UI（Playwright）
try:
    from test_modal_layout import (HAS_PLAYWRIGHT, SAMPLE_CSV,
                                   _ViewerServer, _launch_chromium,
                                   DOC_STATS_JS)
except Exception:
    HAS_PLAYWRIGHT = False


@unittest.skipUnless(HAS_PLAYWRIGHT, "Playwright 不可用，跳过 UI 用例")
class TemplateGalleryUiTests(unittest.TestCase):
    """画廊筛选 + hints 面板显示/关闭。"""

    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-r7-data-")
        cls.server = _ViewerServer(cls.datadir)
        try:
            cls.server.wait_ready()
        except Exception:
            cls.server.stop()
            shutil.rmtree(cls.datadir, ignore_errors=True)
            raise

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        shutil.rmtree(cls.datadir, ignore_errors=True)

    def setUp(self):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self.browser = _launch_chromium(self._pw)

    def tearDown(self):
        try:
            self.browser.close()
        finally:
            self._pw.stop()

    def _open(self, page):
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#panel-import button", timeout=20000)
        page.wait_for_timeout(1200)

    def test_gallery_filters_and_hints(self):
        page = self.browser.new_page(viewport={"width": 1440, "height": 900})
        try:
            self._open(page)
            page.get_by_role("button", name="打开组图", exact=True).click()
            compose = page.locator(".compose-modal")
            compose.get_by_role("button", name="取消").click()
            page.locator("#btn-template-library").click()
            modal = page.locator(".template-library-modal")
            category = modal.locator(".tl-cat")
            topic = modal.locator(".tl-group")
            headings = modal.get_by_role("heading", level=3)
            self.assertEqual(headings.all_text_contents(), ["数据图", "表征图", "机制图", "流程图", "组图"])
            for key, name in [("mechanism", "模型/系统架构图"), ("flow", "PRISMA 文献筛选流程")]:
                category.select_option(key)
                self.assertTrue(modal.locator(".tl-card", has_text=name).is_visible())
                self.assertEqual(headings.count(), 1)
            category.select_option("chart")
            topic.select_option("stats")
            self.assertTrue(modal.locator(".tl-card", has_text="黑白打印柱图").is_visible())
            topic.select_option("electrochem")
            self.assertTrue(modal.locator(".tl-empty").is_visible())
            category.select_option("characterization")
            self.assertTrue(modal.locator(".tl-card", has_text="充放电循环曲线").is_visible())
            self.assertEqual(headings.all_text_contents(), ["表征图"])
            topic.select_option("all")

            # 模板应用需要数据；同时用这一张图验证换色的两种操作。
            page.evaluate("""() => App.commit([{op:'apply_template',template_id:'tpl-line',
                data:{columns:['x','y'],rows:[[1,2],[2,3],[3,5]]}}],{label:'seed'})""")
            recolor = modal.locator(".recolor-section")
            recolor.locator(".recolor-strategy").select_option("byRole")
            recolor.locator(".recolor-palette").select_option("aaas")
            recolor.get_by_role("button", name="换色", exact=True).click()
            page.wait_for_function("App.doc.meta.palette_id === 'aaas'")
            self.assertEqual(page.evaluate("App.doc.history.at(-1).ops[0].recolor_strategy"),
                             "byRole")
            recolor.locator(".palette-card").filter(has_text="NPG").first.click()
            page.wait_for_function("App.doc.meta.palette_id === 'npg'")
            self.assertEqual(recolor.locator(".recolor-palette").input_value(), "npg")
            category.select_option("characterization")
            modal.locator(".tl-card", has_text="XRD 多样品叠放").click()
            modal.get_by_role("button", name="应用此模板").click()
            modal.wait_for(state="detached")
            page.locator("#tab-props").click()
            page.wait_for_timeout(400)
            # 选中图表 → props hints
            page.evaluate(r"""(() => {
              const c=(App.doc.elements||[]).filter(e=>e.type==='chart')[0];
              if(c&&App.select) App.select([c.id]);
            })()""")
            page.wait_for_timeout(800)
            hints = page.locator("[data-template-hints]")
            self.assertTrue(hints.count() >= 1, "props 应显示模板 hints")
            self.assertIn("标准卡", hints.first.inner_text())
            # 关闭 → 消失且历史无新增
            histBefore = page.evaluate("(() => (App.doc.history||[]).length)()")
            hints.first.locator("[data-hint-dismiss]").click()
            page.wait_for_timeout(300)
            self.assertEqual(page.locator("[data-template-hints]").count(), 0,
                             "关闭后 hints 应消失")
            histAfter = page.evaluate("(() => (App.doc.history||[]).length)()")
            self.assertEqual(histBefore, histAfter, "关闭 hints 不应产生历史")
        finally:
            page.close()

    def test_template_library_dialog(self):
        # 模板库大对话框：工具栏入口 → 分类筛选 → 搜索 → 仅显示可用 →
        # 卡片详情 → 应用（恰好一次历史）。
        page = self.browser.new_page(viewport={"width": 1440, "height": 900})
        try:
            self._open(page)
            self.assertEqual(page.locator("#tab-templates, #panel-templates, .tl-open-btn").count(), 0)
            # 先种子一份数据，保证 apply 有映射来源（与既有用例同法）
            page.evaluate(r"""(() => {
              App.commit([{op:'apply_template',template_id:'tpl-line',
                data:{columns:['x','y'],rows:[[1,2],[2,3],[3,5],[4,4],[5,7]]},
                options:{}}],{label:'seed'});
            })()""")
            page.wait_for_timeout(800)
            hist0 = page.evaluate("(() => (App.doc.history||[]).length)()")
            # 工具栏按钮打开大对话框
            page.locator("#btn-template-library").click()
            page.wait_for_selector(".template-library-modal .tl-grid",
                                   timeout=10000)
            modal = page.locator(".template-library-modal")
            self.assertTrue(modal.count() >= 1, "模板库对话框未打开")
            page.wait_for_timeout(2500)  # 分批填充真实渲染缩略图
            cards = modal.locator(".tl-card")
            self.assertGreater(cards.count(), 10, "模板库卡片过少")
            # 真实渲染缩略图已填充（SVG 出现在若干卡片里）
            self.assertGreater(
                modal.locator(".tl-preview svg").count(), 5,
                "缩略图应为真实渲染 SVG")
            # 分类筛选 → 表征
            modal.locator(".tl-cat").select_option("characterization")
            page.wait_for_timeout(700)
            self.assertTrue(
                modal.locator(".tl-card", has_text="XRD 多样品叠放").count() >= 1,
                "表征筛选应含 XRD 多样品叠放")
            # 搜索 → 只剩 BET 等温线
            modal.locator(".tl-search").fill("BET")
            page.wait_for_timeout(600)
            betCards = modal.locator(".tl-card")
            self.assertGreaterEqual(betCards.count(), 1)
            self.assertTrue(
                modal.locator(".tl-card", has_text="BET").count() >= 1,
                "搜索 BET 应命中等温线模板")
            for i in range(betCards.count()):
                self.assertIn("BET", betCards.nth(i).inner_text(),
                              "搜索结果不应混入无关模板")
            # 仅显示可用：R10 补齐 13 个图型渲染器后全部 90 个模板均可应用
            # （full/layout），过滤器当前无可滤项——断言 nOk<=nAll 且开关
            # 本身不报错；若未来新增 unsupported 模板，此处应恢复 nOk<nAll。
            modal.locator(".tl-search").fill("")
            modal.locator(".tl-cat").select_option("all")
            page.wait_for_timeout(600)
            nAll = modal.locator(".tl-card").count()
            modal.locator(".tl-only input[type='checkbox']").check()
            page.wait_for_timeout(600)
            nOk = modal.locator(".tl-card").count()
            self.assertLessEqual(nOk, nAll,
                                 "「仅显示可用」不应出现多于全部的卡片")
            modal.locator(".tl-only input[type='checkbox']").uncheck()
            page.wait_for_timeout(400)
            # 点卡片 → 详情（说明/输入需求/hints）+ 应用按钮
            xrd = modal.locator(".tl-card", has_text="XRD 多样品叠放")
            if xrd.count() == 0:
                # XRD 可能被「仅显示可用」之外的分类筛选挡住：回全部
                modal.locator(".tl-cat").select_option("all")
                modal.locator(".tl-only input[type='checkbox']").uncheck()
                page.wait_for_timeout(600)
                xrd = modal.locator(".tl-card", has_text="XRD 多样品叠放")
            self.assertGreaterEqual(xrd.count(), 1, "找不到 XRD 卡片")
            xrd.first.click()
            page.wait_for_selector(".tl-detail", timeout=5000)
            detailText = modal.locator(".tl-detail").inner_text()
            self.assertIn("能力", detailText)
            self.assertTrue(
                modal.locator(".tl-detail .ui-btn-primary",
                              has_text="应用此模板").count() >= 1,
                "详情应有「应用此模板」按钮")
            # 应用 → 恰好一次历史，对话框关闭
            modal.locator(".tl-detail .ui-btn-primary",
                          has_text="应用此模板").click()
            page.wait_for_timeout(1500)
            hist1 = page.evaluate("(() => (App.doc.history||[]).length)()")
            self.assertEqual(hist1, hist0 + 1,
                             "应用模板应恰好新增 1 条历史")
            self.assertEqual(
                page.locator(".template-library-modal").count(), 0,
                "应用成功后模板库应关闭")
        finally:
            page.close()

    def test_thumbnail_label_geometry(self):
        page = self.browser.new_page(viewport={"width": 1440, "height": 900})
        try:
            self._open(page)
            page.locator("#btn-template-library").click()
            for tid in ["tpl-volcano", "tpl-taylor", "tpl-paired"]:
                svg = page.locator(".tl-preview[data-preview-for='%s'] > svg" % tid)
                svg.wait_for(state="attached")
                issues = svg.evaluate("""svg => {
                  const texts = [...svg.querySelectorAll("text[data-chart-part]")];
                  const issues = [];
                  if (svg.dataset.templateId === "tpl-volcano") {
                    const top = svg.querySelector('[data-chart-part="threshold"]').getBoundingClientRect().top;
                    for (const t of texts.filter(t => t.dataset.chartPart === 'volcano-label')) {
                      if (t.getBoundingClientRect().top < top) issues.push(t.textContent);
                    }
                  } else {
                    texts.forEach((t, i) => {
                      const a = t.getBoundingClientRect();
                      for (const other of texts.slice(i + 1)) {
                        const b = other.getBoundingClientRect();
                        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
                          issues.push([t.textContent, other.textContent]);
                      }
                    });
                  }
                  return issues;
                }""")
                self.assertTrue(svg.locator("text[data-chart-part]").count(), tid)
                self.assertEqual(issues, [], tid)
        finally:
            page.close()

    def test_template_library_small_viewport(self):
        # 1040×730 下对话框仍可打开、网格与工具条可用
        page = self.browser.new_page(viewport={"width": 1040, "height": 730})
        try:
            self._open(page)
            page.locator("#btn-template-library").click()
            page.wait_for_selector(".template-library-modal .tl-grid",
                                   timeout=10000)
            modal = page.locator(".template-library-modal")
            self.assertGreater(modal.locator(".tl-card").count(), 10)
            # 视口内不应出现横向溢出（对话框宽度受 96vw 约束）
            box = modal.bounding_box()
            self.assertIsNotNone(box)
            self.assertLessEqual(box["width"], 1040)
            self.assertGreaterEqual(box["width"], 700,
                                    "对话框不应过窄")
        finally:
            page.close()


if __name__ == "__main__":
    unittest.main()
