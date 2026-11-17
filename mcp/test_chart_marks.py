"""test_chart_marks.py — H1：pt 制渲染默认值 + 单点/柱可点选样式覆盖（内核级）

验证：
1. scatter 每个画出点有唯一 data-point-key（数量=renderableRows.drawn），
   data-row 与源行一致，FigData.pointKey 给出同样的键；
2. 单点覆盖 {fill,sizePt} 只改该点，其余点逐一相同；数据行不变；历史+1；撤销恢复；
3. series.markerSizePt 改全系列；points 覆盖优先于 series；
4. 数据替换后过期 pointKey 不作用于任何点且覆盖保留；值不变仍生效；
5. 校验：非法值/未知键/换行键整批拒绝；键级与块级 null 删除；中文系列键生效；
6. bar/bar_grouped 的 bar|… 键只改那一根柱子；
7. plot：frame=box 多上/右轴线；tickDirection=in 刻度线入内；axisWidthPt 生效；
8. 默认值按 pt：dpi300 散点半径 9.375px，dpi96 为 3px；
9. marker=square/triangle/diamond 产出带 data-* 的非 circle 图元；
10. 误差线：replicates 绝对界 / column 相对偏移 都画在正确数据位置（1a 修复）；
11. 留白：散点点心距边框≥半径；bar 零基线贴底（1b）；
12. 右图例与绘图区间 ≥6pt（1c）；
13. templateFromStats opts.canvas 排版 + axes 默认标签 + cell 高≤宽×0.8。
"""

import json
import os
import re
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
function mkDoc(chartType, mapping, rows, columns, extra) {
  let doc = FigDoc.create({ title: 'marks', width_mm: 120, height_mm: 90 });
  const cols = columns || Object.keys(mapping).map(k => mapping[k]);
  const spec = { chart_type: chartType, mapping: mapping };
  if (extra) Object.assign(spec, extra);
  const el = FigData.makeChartElement({ columns: cols, rows: rows }, spec);
  doc = FigOps.applyAll(doc, [{ op: 'add_element', element: el }], { label: 'init' }).doc;
  return doc;
}
function cid(doc){ return doc.elements.find(e=>e.type==='chart').id; }
function chartOf(doc){ return doc.elements.find(e=>e.type==='chart').chart; }
function svgOf(doc, w, h, dpi){
  return FigData.renderChartSVG(chartOf(doc), { width_mm: w||80, height_mm: h||60, dpi: dpi||300 });
}
function applyPres(doc, pres){
  return FigOps.applyAll(doc, [{ op:'set_chart_properties', targets:[cid(doc)],
    properties:{ presentation: pres } }], { label:'style' });
}
// 统计契约走 set_scientific_contract（makeChartElement 不保留 statistics 字段）
function applyStats(doc, stats){
  const c=cid(doc);
  return FigOps.applyAll(doc, [{ op:'set_scientific_contract',
    contract:{ statistics:{ [c]: stats } } }], { label:'stats' });
}
// 提取所有带 data-point-key 的图元 outerHTML（circle/rect/polygon）
function markEls(svg){
  const out=[];
  const re=/<(circle|rect|polygon|path|polyline)[^>]*data-point-key="[^"]+"[^>]*>/g;
  let m; while((m=re.exec(svg))) out.push(m[0]);
  return out;
}
function keysOf(svg){
  const s=new Set(); const re=/data-point-key="([^"]+)"/g; let m;
  while((m=re.exec(svg))) s.add(m[1]); return [...s];
}
// y 轴刻度：text() 的 y=刻度px+fontSize*0.35（基线），还原真实刻度像素 py
function yTicks(svg){
  const out=[];
  const re=/<text([^>]*data-chart-part="axis-tick-y"[^>]*)>([^<]*)<\/text>/g; let m;
  while((m=re.exec(svg))){
    const attrs=m[1];
    const y=parseFloat((attrs.match(/y="([\d.-]+)"/)||[])[1]);
    const fs=parseFloat((attrs.match(/font-size="([\d.]+)"/)||[])[1])||0;
    const v=parseFloat(m[2]);
    const py=y-fs*0.35; // 还原刻度线像素
    if(isFinite(py)&&isFinite(v)) out.push([py,v]);
  }
  return out;
}
// 由两个刻度反推 pixel->value（ticks 为 [基线py, 刻度值]，文档序=值升序）
function yScaleOf(ticks){
  if(ticks.length<2) return null;
  const [p1,v1]=ticks[0],[p2,v2]=ticks[ticks.length-1];
  const b=(p2-p1)/(v2-v1), a=p1-b*v1; // py = a + b*value
  return function(py){ return (py-a)/b; };
}
// 误差线竖线：竖直 line 段（排除 y 轴=最长、x 刻度=短 tickLen）
function vSegs(svg){
  const out=[];
  [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*>/g)].forEach(m=>{
    const x1=+m[1],y1=+m[2],x2=+m[3],y2=+m[4];
    if(x1===x2){const len=Math.abs(y2-y1); if(len>4) out.push({x:x1,yt:Math.min(y1,y2),yb:Math.max(y1,y2),len});}
  });
  return out;
}
function errBars(svg){
  const vs=vSegs(svg); if(!vs.length) return [];
  const axisLen=Math.max(...vs.map(v=>v.len));
  const axisX=vs.reduce((a,b)=>a.len>b.len?a:b).x;
  return vs.filter(v=>v.x!==axisX && v.len>20 && v.len<axisLen*0.9).sort((a,b)=>a.yt-b.yt);
}
function barTopPx(svg){
  const r=[...svg.matchAll(/<rect[^>]*data-series-key[^>]*>/g)].map(m=>m[0])[0];
  return r?(+((r.match(/y="([\d.]+)"/)||[])[1])):null;
}
// 对一张 bar/bar_grouped 图返回每个误差线的 {hiVal,loVal,midPx} 与柱顶像素
function probeErr(doc){
  const svg=svgOf(doc); const yt=yTicks(svg); const ys=yScaleOf(yt);
  const bars=errBars(svg); const bt=barTopPx(svg);
  return {ys:!!ys, bars:bars.map(function(b){
    return {hiVal:+ys(b.yt).toFixed(2), loVal:+ys(b.yb).toFixed(2),
      midPx:+((b.yt+b.yb)/2).toFixed(2), len:+b.len.toFixed(1)};
  }), barTop:bt, nTicks:yt.length};
}
"""


class MarkKeyTests(unittest.TestCase):
    def test_scatter_point_keys_rows_and_pointKey_export(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10,'A'],[2,20,'A'],[3,15,'B'],[4,25,'B'],[5,'', 'B']];
let doc=mkDoc('scatter',{x:'x',y:'y',color:'g'},rows);
const svg=svgOf(doc);
const drawn=FigData.renderableRows('scatter',chartOf(doc).data.inline,chartOf(doc).mapping).drawn;
const keys=keysOf(svg);
const els=markEls(svg);
const rowAttrs=[...svg.matchAll(/data-row="(\d+)"/g)].map(m=>+m[1]);
const chart=chartOf(doc);
const pk0=FigData.pointKey(chart,0), pk3=FigData.pointKey(chart,3), pkBad=FigData.pointKey(chart,4);
console.log(JSON.stringify({
  nKeys:keys.length, unique:new Set(keys).size===keys.length,
  drawn, nEls:els.length, rowAttrs,
  pk0, pk3, pkBad,
  keyInSvg0: svg.includes('data-point-key="'+pk0+'"'),
  sizePt:(svg.match(/data-size-pt="([\d.]+)"/)||[])[1],
  marker:(svg.match(/data-marker="([^"]+)"/)||[])[1]
}));
""")
        self.assertEqual(out["nKeys"], out["drawn"], "每个画出点一个唯一 data-point-key")
        self.assertTrue(out["unique"], "data-point-key 全部唯一")
        self.assertGreaterEqual(out["nEls"], out["drawn"])
        self.assertIn(0, out["rowAttrs"])
        self.assertIn(3, out["rowAttrs"])
        self.assertIsNone(out["pkBad"], "空 y 行不产生点键")
        self.assertTrue(out["keyInSvg0"], "pointKey 导出与渲染键一致")
        self.assertEqual(out["sizePt"], "4.5")
        self.assertEqual(out["marker"], "circle")


class PointOverrideTests(unittest.TestCase):
    def test_single_point_override_isolated_undoable(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10],[2,20],[3,15],[4,25]];
let doc=mkDoc('scatter',{x:'x',y:'y'},rows);
const before=svgOf(doc);
const k=FigData.pointKey(chartOf(doc),1); // row1 -> (2,20)
const h0=doc.history.length;
const res=applyPres(doc,{version:1,points:{[k]:{fill:'#FF0000',sizePt:8}}});
doc=res.doc;
const after=svgOf(doc);
const elAfter=[...after.matchAll(/<(circle|rect|polygon)[^>]*data-point-key="[^"]+"[^>]*>/g)].map(m=>m[0]);
const beforeEls=[...before.matchAll(/<(circle|rect|polygon)[^>]*data-point-key="[^"]+"[^>]*>/g)].map(m=>m[0]);
// 该点变红且半径=8/2*300/72=16.67px(±0.01)
const ptEl=elAfter.find(e=>e.includes('data-point-key="'+k+'"'));
const rMatch=(ptEl.match(/r="([\d.]+)"/)||[])[1];
const isRed=ptEl.includes('fill="#FF0000"');
// 其余点 fill/r 与覆盖前逐一相同（按 data-point-key 对齐）
function byKey(els){const o={};els.forEach(e=>{const kk=(e.match(/data-point-key="([^"]+)"/)||[])[1];o[kk]=e;});return o;}
const bK=byKey(beforeEls), aK=byKey(elAfter);
let othersSame=true, othersDiff=[];
Object.keys(bK).forEach(kk=>{ if(kk===k) return;
  const bn=(bK[kk].match(/r="([\d.]+)"/)||[])[1], an=(aK[kk].match(/r="([\d.]+)"/)||[])[1];
  const bf=(bK[kk].match(/fill="([^"]+)"/)||[])[1], af=(aK[kk].match(/fill="([^"]+)"/)||[])[1];
  if(bn!==an||bf!==af){othersSame=false;othersDiff.push(kk);} });
const rowsSame=JSON.stringify(chartOf(doc).data.inline.rows)===JSON.stringify(rows);
const hDelta=doc.history.length-h0;
doc=FigOps.undo(doc); const undoSvg=svgOf(doc);
const stillRed=undoSvg.includes('#FF0000');
console.log(JSON.stringify({isRed,r:+rMatch,rExp:8/2*300/72,othersSame,othersDiff,
  rowsSame,hDelta,stillRed}));
""")
        self.assertTrue(out["isRed"], "目标点 fill 变红")
        self.assertAlmostEqual(out["r"], out["rExp"], delta=0.01, msg="半径=8/2×dpi/72")
        self.assertTrue(out["othersSame"], "其余点 fill/半径不变: %s" % out["othersDiff"])
        self.assertTrue(out["rowsSame"], "数据行深比较不变")
        self.assertEqual(out["hDelta"], 1, "恰好一笔历史")
        self.assertFalse(out["stillRed"], "撤销后恢复")

    def test_series_markerSize_and_point_priority(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10],[2,20],[3,15]];
let doc=mkDoc('line',{x:'x',y:'y'},rows);
const sk='series|y|s:y';
// series.markerSizePt 改全系列
doc=applyPres(doc,{version:1,series:{[sk]:{markerSizePt:9}}}).doc;
let svg=svgOf(doc);
const rs=[...svg.matchAll(/data-size-pt="([\d.]+)"/g)].map(m=>+m[1]);
const allNine=rs.length>0&&rs.every(v=>v===9);
// 同一点再加 points 覆盖 → 以点为准
const k=FigData.pointKey(chartOf(doc),0);
doc=applyPres(doc,{version:1,points:{[k]:{sizePt:3}}}).doc;
svg=svgOf(doc);
const ptEl=[...svg.matchAll(/<[^>]*data-point-key="[^"]+"[^>]*>/g)].map(m=>m[0]).find(e=>e.includes('data-point-key="'+k+'"'));
const ptSize=(ptEl.match(/data-size-pt="([\d.]+)"/)||[])[1];
const otherEl=[...svg.matchAll(/<[^>]*data-series-key="[^"]+"[^>]*>/g)].map(m=>m[0])
  .filter(e=>e.includes('data-point-key')&&!e.includes('data-point-key="'+k+'"'));
const otherSize=(otherEl[0].match(/data-size-pt="([\d.]+)"/)||[])[1];
console.log(JSON.stringify({allNine,n:rs.length,ptSize,otherSize}));
""")
        self.assertTrue(out["allNine"], "series.markerSizePt 使全系列 sizePt=9")
        self.assertEqual(out["ptSize"], "3", "points 覆盖优先于 series")
        self.assertEqual(out["otherSize"], "9", "其余点仍用 series 值")


class StaleKeyTests(unittest.TestCase):
    def test_replaced_data_stales_point_override_but_keeps_it(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10],[2,20],[3,15]];
let doc=mkDoc('scatter',{x:'x',y:'y'},rows);
const k=FigData.pointKey(chartOf(doc),0);
doc=applyPres(doc,{version:1,points:{[k]:{fill:'#FF0000'}}}).doc;
const cidv=cid(doc);
// set_chart_data 改掉 row0 的 x/y → 该行键不再匹配
doc=FigOps.applyAll(doc,[{op:'set_chart_data',targets:[cidv],approved:true,
  data:{columns:['x','y'],rows:[[9,99],[2,20],[3,15]],source_ref:'r2.csv',version:'v2'},
  source_ref:'r2.csv',version:'v2'}],{label:'replace'}).doc;
let svg=svgOf(doc);
const redAfterReplace=svg.includes('#FF0000');
const kept=!!(chartOf(doc).presentation&&chartOf(doc).presentation.points&&chartOf(doc).presentation.points[k]);
// 再替换回相同行值（行0 恢复 1,10）→ 覆盖重新生效
doc=FigOps.applyAll(doc,[{op:'set_chart_data',targets:[cidv],approved:true,
  data:{columns:['x','y'],rows:[[1,10],[2,20],[3,15]],source_ref:'r3.csv',version:'v3'},
  source_ref:'r3.csv',version:'v3'}],{label:'restore'}).doc;
svg=svgOf(doc);
const redAfterRestore=svg.includes('#FF0000');
console.log(JSON.stringify({redAfterReplace,kept,redAfterRestore}));
""")
        self.assertFalse(out["redAfterReplace"], "数据改动后旧键不作用于任何点")
        self.assertTrue(out["kept"], "覆盖仍保留在文档")
        self.assertTrue(out["redAfterRestore"], "行值恢复后覆盖重新生效")


class ValidationTests(unittest.TestCase):
    def test_invalid_rejected_null_deletes_chinese_key_ok(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10,'A'],[2,20,'A']];
let doc=mkDoc('line_multi',{x:'x',y:'y',group:'g'},rows);
const c=cid(doc);
function val(pres){ return FigOps.validateAll([{op:'set_chart_properties',targets:[c],
  properties:{presentation:pres}}],doc); }
const badFill=val({version:1,points:{'pt|0|x':{fill:'red'}}});
const badSize=val({version:1,points:{'pt|0|x':{sizePt:99}}});
const badPKey=val({version:1,points:{'pt|0|x':{bogus:1}}});
const badPlotKey=val({version:1,plot:{bogus:1}});
const badNl=val({version:1,series:{'k|with\nbad':{stroke:'#123456'}}});
const badMarker=val({version:1,points:{'pt|0|x':{marker:'star'}}});
// 中文系列键 stroke 覆盖应被接受并渲染生效
doc=applyPres(doc,{version:1,series:{'group|g|s:A':{stroke:'#FF0000'}}}).doc;
const svg=svgOf(doc);
// 先建 plot+points 再整块 null 删除
doc=applyPres(doc,{version:1,plot:{frame:'box'},points:{'pt|0|x':{fill:'#00FF00'}}}).doc;
let ch=chartOf(doc);
const hadPlot=!!(ch.presentation&&ch.presentation.plot), hadPts=!!(ch.presentation&&ch.presentation.points);
doc=applyPres(doc,{version:1,plot:null,points:null}).doc;
ch=chartOf(doc);
console.log(JSON.stringify({
  badFill:!badFill.ok,badSize:!badSize.ok,badPKey:!badPKey.ok,badPlotKey:!badPlotKey.ok,
  badNl:!badNl.ok,badMarker:!badMarker.ok,
  chineseStroke:svg.includes('#FF0000')&&svg.includes('data-series-key="group|g|s:A"'),
  hadPlot,hadPts,plotGone:!(ch.presentation&&ch.presentation.plot),ptsGone:!(ch.presentation&&ch.presentation.points)
}));
""")
        for k in ["badFill", "badSize", "badPKey", "badPlotKey", "badNl", "badMarker"]:
            self.assertTrue(out[k], k + " 应整批拒绝")
        self.assertTrue(out["chineseStroke"], "中文系列键 stroke 覆盖被接受并渲染生效")
        self.assertTrue(out["hadPlot"] and out["hadPts"])
        self.assertTrue(out["plotGone"] and out["ptsGone"], "plot:null/points:null 删除整块")

    def test_key_level_null_and_bar_keys(self):
        out = node_json(PRELUDE + r"""
const rows=[['A',1],['A',2],['B',3],['B',4]];
let doc=mkDoc('bar',{x:'c',y:'v'},rows);
const c=cid(doc);
// bar|A 只改 A 柱
doc=applyPres(doc,{version:1,points:{'bar|A':{fill:'#FF0000'}}}).doc;
let svg=svgOf(doc);
const aEl=[...svg.matchAll(/<rect[^>]*data-point-key="bar\|A"[^>]*>/g)].map(m=>m[0])[0];
const bEl=[...svg.matchAll(/<rect[^>]*data-point-key="bar\|B"[^>]*>/g)].map(m=>m[0])[0];
const aRed=aEl&&aEl.includes('#FF0000'), bNotRed=bEl&&!bEl.includes('#FF0000');
const aRows=(aEl.match(/data-row="([^"]+)"/)||[])[1];
// 键级 null 删除单项
doc=applyPres(doc,{version:1,points:{'bar|A':null}}).doc;
svg=svgOf(doc);
const aGone=!svg.includes('#FF0000');
// bar_grouped
let doc2=mkDoc('bar_grouped',{x:'c',y:'v',group:'g'},
  [['A',1,'p'],['A',2,'q'],['B',3,'p'],['B',4,'q']],['c','v','g']);
doc2=applyPres(doc2,{version:1,points:{'bar|A|p':{fill:'#0000FF'}}}).doc;
const svg2=svgOf(doc2);
const ap=[...svg2.matchAll(/<rect[^>]*data-point-key="bar\|A\|p"[^>]*>/g)].map(m=>m[0])[0];
const aq=[...svg2.matchAll(/<rect[^>]*data-point-key="bar\|A\|q"[^>]*>/g)].map(m=>m[0])[0];
console.log(JSON.stringify({aRed,bNotRed,aRows,aGone,
  apBlue:ap&&ap.includes('#0000FF'),aqNotBlue:aq&&!aq.includes('#0000FF')}));
""")
        self.assertTrue(out["aRed"], "bar|A 柱变红")
        self.assertTrue(out["bNotRed"], "bar|B 柱不受影响")
        self.assertEqual(out["aRows"], "0,1")
        self.assertTrue(out["aGone"], "键级 null 删除单项")
        self.assertTrue(out["apBlue"] and out["aqNotBlue"], "bar_grouped bar|类别|组 只改那一根")


class PlotTests(unittest.TestCase):
    def test_plot_frame_tickdir_axiswidth(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10],[2,20],[3,15],[4,25]];
let doc=mkDoc('scatter',{x:'x',y:'y'},rows);
const c=cid(doc);
// frame=box vs open 轴线数
function axisLines(svg){ return (svg.match(/<line/g)||[]).length; }
doc=applyPres(doc,{version:1,plot:{frame:'box'}}).doc;
const boxSvg=svgOf(doc);
doc=applyPres(doc,{version:1,plot:{frame:'open'}}).doc;
const openSvg=svgOf(doc);
// tickDirection=in：x 刻度线应向绘图区内（y2<y1 方向朝上）
doc=applyPres(doc,{version:1,plot:{tickDirection:'in',frame:'open'}}).doc;
const inSvg=svgOf(doc);
// axisWidthPt=1.5 → stroke-width=1.5*300/72=6.25
const aw=(1.5*300/72).toFixed(2);
doc=applyPres(doc,{version:1,plot:{axisWidthPt:1.5}}).doc;
const awSvg=svgOf(doc);
console.log(JSON.stringify({
  boxMore:axisLines(boxSvg)>axisLines(openSvg),
  boxLines:axisLines(boxSvg),openLines:axisLines(openSvg),
  awExpected:aw, hasAxisW:awSvg.includes('stroke-width="'+aw+'"')||awSvg.includes('stroke-width="6.25"'),
  // in 方向：x 刻度短竖线应整体位于底轴上方（绘图区内侧）
  inTickInward:(function(){
    const ls=[...inSvg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*>/g)]
      .map(m=>({x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4]}));
    // 底轴 y = 最长横线的最大 y
    const hLines=ls.filter(l=>l.y1===l.y2&&Math.abs(l.x2-l.x1)>200);
    if(!hLines.length) return false;
    const yb=Math.max(...hLines.map(l=>Math.max(l.y1,l.y2)));
    // x 刻度：竖直短线（len≈tickLen），tickDirection=in → 整体在 yb 上方/贴轴
    const ticks=ls.filter(l=>l.x1===l.x2&&Math.abs(l.y2-l.y1)>3&&Math.abs(l.y2-l.y1)<30);
    const inward=ticks.filter(t=>Math.max(t.y1,t.y2)<=yb+0.6&&Math.min(t.y1,t.y2)<yb-2);
    return inward.length>0;
  })()
}));
""")
        self.assertTrue(out["boxMore"], "frame=box 比 open 多出上、右轴线")
        self.assertTrue(out["hasAxisW"], "axisWidthPt=1.5 → stroke-width=6.25px")
        self.assertTrue(out["inTickInward"], "tickDirection=in 刻度线端点在绘图区内侧")

    def test_pt_defaults_dpi(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10],[2,20],[3,15]];
let doc=mkDoc('scatter',{x:'x',y:'y'},rows);
function radius(svg){ const m=svg.match(/<circle[^>]*r="([\d.]+)"/); return m?+m[1]:null; }
const r300=radius(svgOf(doc,80,60,300));
const r96=radius(svgOf(doc,80,60,96));
console.log(JSON.stringify({r300,r96,r300exp:4.5/2*300/72,r96exp:4.5/2*96/72}));
""")
        self.assertAlmostEqual(out["r300"], out["r300exp"], delta=0.01, msg="dpi300 半径 9.375px")
        self.assertAlmostEqual(out["r96"], out["r96exp"], delta=0.01, msg="dpi96 半径 3px")

    def test_marker_shapes_have_data_attrs(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10],[2,20],[3,15]];
let doc=mkDoc('scatter',{x:'x',y:'y'},rows);
const k=FigData.pointKey(chartOf(doc),0);
const res={};
['square','triangle','diamond'].forEach(function(mk){
  let d=applyPres(doc,{version:1,points:{[k]:{marker:mk}}}).doc;
  const svg=svgOf(d);
  const el=[...svg.matchAll(/<(circle|rect|polygon)[^>]*data-point-key="[^"]+"[^>]*>/g)]
    .map(x=>x[0]).find(e=>e.includes('data-point-key="'+k+'"'));
  res[mk]={tag:(el.match(/^<([a-z]+)/)||[])[1],
    hasKey:el.includes('data-point-key'),hasRow:el.includes('data-row'),
    hasSize:el.includes('data-size-pt'),hasMarker:el.includes('data-marker="'+mk+'"')};
});
console.log(JSON.stringify(res));
""")
        for mk in ["square", "triangle", "diamond"]:
            self.assertNotEqual(out[mk]["tag"], "circle", mk + " 应产出非 circle 图元")
            for f in ["hasKey", "hasRow", "hasSize", "hasMarker"]:
                self.assertTrue(out[mk][f], mk + " 缺 " + f)


class CharacterizationWidthTests(unittest.TestCase):
    """表征曲线线宽：默认 charLineWidthPt，plot.lineWidthPt 显式设置时优先。"""

    def _char_doc(self):
        return node_json(PRELUDE + r"""
let doc=FigDoc.create({title:'char',width_mm:120,height_mm:90});
const rows=[]; for(let i=0;i<20;i++) rows.push([1000-i*8, 50+i*3, 48+i*3.1]);
const el=FigData.makeChartElement({columns:['be','int','fitcol'],rows},
  {chart_type:'line',mapping:{x:'be',y:'int'}});
doc=FigOps.applyAll(doc,[{op:'add_element',element:el}],{label:'c'}).doc;
const c=cid(doc);
doc=FigOps.applyAll(doc,[{op:'set_chart_properties',targets:[c],properties:{
  characterization:{technique:'XPS',curves:[{role:'fit',column:'fitcol',label:'fit'}]}
}}],{label:'char'}).doc;
function rawW(svg){
  // R6-A：曲线按段数学裁剪后，越界段输出 <path>，完整段仍输出 <polyline>
  const tag=[...svg.matchAll(/<(?:polyline|path)[^>]*>/g)].map(m=>m[0])
    .find(t=>t.includes('data-series-key="raw|'));
  if(!tag) return null;
  const m=tag.match(/stroke-width="([\d.]+)"/); return m?+m[1]:null;
}
const d0=doc, svg0=svgOf(d0,80,60,300);
const wDef=rawW(svg0);
const d1=applyPres(doc,{version:1,plot:{lineWidthPt:0.8}}).doc;
const wSet=rawW(svgOf(d1,80,60,300));
console.log(JSON.stringify({wDef,wSet,u:300/72}));
""")

    def test_char_line_width_default_and_plot_override(self):
        out = self._char_doc()
        self.assertIsNotNone(out["wDef"], "未找到 raw 曲线")
        self.assertAlmostEqual(out["wDef"], 1.5 * out["u"], delta=0.02,
                               msg="默认应为 charLineWidthPt=1.5pt")
        self.assertAlmostEqual(out["wSet"], 0.8 * out["u"], delta=0.02,
                               msg="plot.lineWidthPt=0.8 应覆盖默认")


class ErrorBarTests(unittest.TestCase):
    """1a：replicates 绝对界 vs column 相对偏移 都应画在正确数据位置。"""

    def _bar(self, rows, cols, mapping, stats):
        return node_json(PRELUDE + r"""
let doc=mkDoc('bar',%s,%s,%s);
doc=applyStats(doc,%s).doc;
console.log(JSON.stringify(probeErr(doc)));
""" % (json.dumps(mapping), json.dumps(rows), json.dumps(cols), json.dumps(stats)))

    def _assert_bounds_20_24(self, out, tag):
        bars = out["bars"]
        self.assertTrue(out["ys"], tag + " 需能反推 y 比例尺")
        self.assertEqual(len(bars), 1, tag + " 应有 1 条误差线: %s" % bars)
        b = bars[0]
        self.assertAlmostEqual(b["hiVal"], 24, delta=0.6, msg=tag + " 上端=24")
        self.assertAlmostEqual(b["loVal"], 20, delta=0.6, msg=tag + " 下端=20")
        self.assertAlmostEqual((b["hiVal"] + b["loVal"]) / 2, 22, delta=0.6,
                               msg=tag + " 中点=均值22")
        self.assertAlmostEqual(b["midPx"], out["barTop"], delta=0.5,
                               msg=tag + " 中点像素=柱顶")

    def test_replicates_sd_absolute_bounds(self):
        # 三次重复 y=[20,22,24] 同类别 → mean22 sd2 → bounds 20..24（绝对值，非 2×mean）
        out = self._bar([["A", 20], ["A", 22], ["A", 24]], ["c", "v"],
                        {"x": "c", "y": "v"},
                        {"uncertainty_source": "replicates", "spread": "SD"})
        self._assert_bounds_20_24(out, "replicates/SD")

    def test_replicates_range_same_bounds(self):
        out = self._bar([["A", 20], ["A", 22], ["A", 24]], ["c", "v"],
                        {"x": "c", "y": "v"},
                        {"uncertainty_source": "replicates", "spread": "range"})
        self._assert_bounds_20_24(out, "replicates/range")

    def test_column_source_same_bounds(self):
        # column：误差列 e=2 → 相对偏移 ±2 → bounds 22±2 = 20..24
        out = self._bar([["A", 20, 2], ["A", 22, 2], ["A", 24, 2]], ["c", "v", "e"],
                        {"x": "c", "y": "v", "error": "e"},
                        {"uncertainty_source": "column", "spread": "SD",
                         "uncertainty_column": "e"})
        self._assert_bounds_20_24(out, "column")

    def test_bar_grouped_one_group(self):
        # bar_grouped：仅 (A,p) 单元格有 3 次重复 → 验证该组误差线位置
        out = node_json(PRELUDE + r"""
const rows=[['A',20,'p'],['A',22,'p'],['A',24,'p'],['A',10,'q'],['B',30,'p'],['B',32,'q']];
let doc=mkDoc('bar_grouped',{x:'c',y:'v',group:'g'},rows,null);
doc=applyStats(doc,{uncertainty_source:'replicates',spread:'SD'}).doc;
console.log(JSON.stringify(probeErr(doc)));
""")
        bars = out["bars"]
        self.assertTrue(out["ys"])
        # 只有 (A,p) 有重复 → 应恰好 1 条误差线，跨度 20..24
        self.assertEqual(len(bars), 1, "bar_grouped 仅重复单元格应有 1 条误差线: %s" % bars)
        self.assertAlmostEqual(bars[0]["hiVal"], 24, delta=0.6)
        self.assertAlmostEqual(bars[0]["loVal"], 20, delta=0.6)


class PaddingLegendTests(unittest.TestCase):
    def test_scatter_points_inside_frame_bar_zero_baseline(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10],[2,20],[3,15],[4,30]];
let doc=mkDoc('scatter',{x:'x',y:'y'},rows);
const svg=svgOf(doc,80,60,300);
const lines=[...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*>/g)].map(m=>({x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4]}));
// 只取带 data-point-key 的圆点（排除图例标记）
const circles=[...svg.matchAll(/<circle[^>]*>/g)].map(m=>m[0])
  .filter(e=>e.includes('data-point-key'))
  .map(e=>({cx:+(e.match(/cx="([\d.]+)"/)||[])[1],cy:+(e.match(/cy="([\d.]+)"/)||[])[1],r:+(e.match(/r="([\d.]+)"/)||[])[1]}));
// 绘图区四边：最长竖线=y轴(上下边)，最长横线=x轴/网格(左右边+底边y)
const vLines=lines.filter(l=>l.x1===l.x2&&Math.abs(l.y2-l.y1)>4);
const hLines=lines.filter(l=>l.y1===l.y2&&Math.abs(l.x2-l.x1)>4);
const yAxis=vLines.reduce((a,b)=>Math.abs(b.y2-b.y1)>Math.abs(a.y2-a.y1)?b:a,{x1:0,y1:0,x2:0,y2:0});
const xAxis=hLines.reduce((a,b)=>Math.abs(b.x2-b.x1)>Math.abs(a.x2-a.x1)?b:a,{x1:0,y1:0,x2:0,y2:0});
const x0=Math.min(xAxis.x1,xAxis.x2), x1=Math.max(xAxis.x1,xAxis.x2);
const y0=Math.min(yAxis.y1,yAxis.y2), y1=Math.max(yAxis.y1,yAxis.y2);
// 每个点心距边框≥半径
let minMargin=Infinity, worst=null;
circles.forEach(c=>{
  const m=Math.min(c.cx-x0, x1-c.cx, c.cy-y0, y1-c.cy) - c.r;
  if(m<minMargin){minMargin=m;worst=c;}
});
// bar 零基线贴底：bar rect 底边应≈ x 轴 y
let docB=mkDoc('bar',{x:'c',y:'v'},[['A',5],['B',8]],['c','v']);
const bsvg=svgOf(docB,80,60,300);
const brect=[...bsvg.matchAll(/<rect[^>]*data-series-key[^>]*>/g)].map(m=>m[0])[0];
const bLines=[...bsvg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*>/g)].map(m=>({x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4]}));
const bhAxis=bLines.filter(l=>l.y1===l.y2&&Math.abs(l.x2-l.x1)>50);
const axisY=Math.max(...bhAxis.map(l=>Math.max(l.y1,l.y2)));
const bTop=+(brect.match(/y="([\d.]+)"/)||[])[1];
const bH=+(brect.match(/height="([\d.]+)"/)||[])[1];
const barBottom=bTop+bH;
console.log(JSON.stringify({minMargin:+minMargin.toFixed(2),worst,
  barBottom,axisY,barBottomGap:+(axisY-barBottom).toFixed(2)}));
""")
        self.assertGreaterEqual(out["minMargin"], -0.01, "散点点心距绘图区边框≥半径")
        # 零基线端不留白：柱底应贴 x 轴（gap≈0）
        self.assertLessEqual(abs(out["barBottomGap"]), 1.0, "bar 零基线贴底")

    def test_legend_right_gap_6pt(self):
        out = node_json(PRELUDE + r"""
const rows=[[1,10,'A'],[2,20,'A'],[3,15,'B']];
let doc=mkDoc('line_multi',{x:'x',y:'y',group:'g'},rows);
const svg=svgOf(doc,80,60,300);
const u=300/72;
// 绘图区右边缘：网格线/水平轴线的最大 x
const lines=[...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*>/g)].map(m=>({x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4]}));
const hAxis=lines.filter(l=>l.y1===l.y2&&Math.abs(l.x2-l.x1)>50);
const plotRight=Math.max(...hAxis.map(l=>Math.max(l.x1,l.x2)));
// 图例最左元素：legend 文本或色块的最小 x。legend 文本在 data-chart-part="legend"
const legTexts=[...svg.matchAll(/<text[^>]*data-chart-part="legend"[^>]*x="([\d.]+)"/g)].map(m=>+m[1]);
// 色块：legend 文字左侧的 line/rect/polygon——用 legend 文本 x 减去间隙估算左缘太繁，
// 直接找 legend 文字左侧最近的图元 x 最小值
const legEls=[...svg.matchAll(/<(line|rect|circle|polygon)[^>]*>/g)].map(m=>m[0])
  .filter(e=>{const x=+(e.match(/x1?="([\d.]+)"/)||e.match(/x="([\d.]+)"/)||[])[1];return isFinite(x)&&x>=plotRight;});
const legMinX=legTexts.length?Math.min(...legTexts):null;
// 用 legend 文本 x 近似（色块在其左 legendGapPt≈4pt）；更稳：找所有 x>=plotRight 的图元
const allRightEls=[...svg.matchAll(/<(line|rect|circle|polygon|path)[^>]*>/g)].map(m=>{
  const e=m[0];
  // 竖直线段是坐标轴 spine/误差棒，永不属于图例（R4 frame=box 右 spine
  // 正好落在 plotRight 上，会被误当成最左图例元素）
  if(e.indexOf('<line')===0){
    const lx1=+(e.match(/x1="([\d.]+)"/)||[])[1], lx2=+(e.match(/x2="([\d.]+)"/)||[])[1];
    if(isFinite(lx1)&&isFinite(lx2)&&Math.abs(lx1-lx2)<0.01) return null;
  }
  const x=+(e.match(/x1="([\d.]+)"/)||e.match(/x="([\d.]+)"/)||e.match(/cx="([\d.]+)"/)||[])[1];
  const y=+(e.match(/y1="([\d.]+)"/)||e.match(/y="([\d.]+)"/)||e.match(/cy="([\d.]+)"/)||[])[1];
return {x,y,e};}).filter(o=>o&&isFinite(o.x)&&o.x>=plotRight-0.01&&isFinite(o.y));
const leftmost=allRightEls.length?Math.min(...allRightEls.map(o=>o.x)):null;
console.log(JSON.stringify({plotRight,leftmost,gapPt:leftmost?(leftmost-plotRight)/u:null,needPt:6}));
""")
        gap = out["gapPt"]
        self.assertIsNotNone(gap, "应能定位右图例")
        self.assertGreaterEqual(gap, 6 - 0.01, "右图例与绘图区间≥6pt")


class TemplateCanvasTests(unittest.TestCase):
    def test_templateFromStats_canvas_layout(self):
        out = node_json(PRELUDE + r"""
const data={columns:['x','y','g'],rows:[[1,10,'A'],[2,20,'A'],[3,15,'B'],[4,25,'B']]};
const map={x:'x',y:'y'};
function summarize(b){
  const ch=b.elements.find(e=>e.type==='chart'), pa=b.elements.find(e=>e.type==='panel'),
        ti=b.elements.find(e=>e.type==='text');
  return {chartW:ch.transform.w, chartH:ch.transform.h,
    panel:{x:pa.transform.x,y:pa.transform.y,w:pa.transform.w,h:pa.transform.h},
    titlePt:ti?ti.style.fontSizePt:null,
    xLabel:ch.chart.axes&&ch.chart.axes.xLabel, yLabel:ch.chart.axes&&ch.chart.axes.yLabel,
    chartX:ch.transform.x, chartY:ch.transform.y};
}
const b120=FigPresets.templateFromStats('tpl-scatter',data,{canvas:{width_mm:120,height_mm:90},title:'t',mapping:map});
const bTall=FigPresets.templateFromStats('tpl-scatter',data,{canvas:{width_mm:89,height_mm:170},mapping:map});
const bDef=FigPresets.templateFromStats('tpl-scatter',data,{title:'t',mapping:map}); // 不传 canvas
const bColor=FigPresets.templateFromStats('tpl-scatter',data,{canvas:{width_mm:120,height_mm:90},mapping:{x:'x',y:'y',color:'g'}});
console.log(JSON.stringify({
  s120:summarize(b120), sTall:summarize(bTall), sDef:summarize(bDef),
  colorOk:!!bColor
}));
""")
        s120 = out["s120"]
        # 全部元素在画布内（120×90）
        self.assertLessEqual(s120["chartX"] + s120["chartW"], 120 + 0.01)
        self.assertLessEqual(s120["chartY"] + s120["chartH"], 90 + 0.01)
        self.assertGreaterEqual(s120["chartW"], 100, "chart 宽≥100mm")
        self.assertEqual(s120["titlePt"], 9, "标题 fontSizePt=9")
        self.assertEqual(s120["xLabel"], "x")
        self.assertEqual(s120["yLabel"], "y")
        sTall = out["sTall"]
        self.assertLessEqual(sTall["chartH"], sTall["chartW"] * 0.8 + 0.01,
                             "89×170 时 chart 高≤宽×0.8")
        # 不传 canvas：panel/chart transform 与改动前一致（89×170 期刊默认）
        sDef = out["sDef"]
        self.assertEqual(sDef["panel"], {"x": 4, "y": 16, "w": 81, "h": 150},
                         "不传 canvas 时 panel 几何与改动前一致")
        self.assertTrue(out["colorOk"], "tpl-scatter 传 mapping.color 不报错")


if __name__ == "__main__":
    unittest.main()
