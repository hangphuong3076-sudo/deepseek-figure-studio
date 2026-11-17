# -*- coding: utf-8 -*-
"""test_chart_style.py — R5 风格库/风格画廊（内核级）

覆盖：
1. 渲染器 token：legend.frame 细框、inside-tr 图例位于绘图区内
   （与 right 对比 x 坐标更靠左）、hollow 标记 fill=none、
   markerCycle/dashCycle 按系列序号生效、plot.background 背景矩形、
   axisWidthPt:0 / tickLengthPt:0 去掉轴线/刻度线、字体 family+weight 进 SVG；
2. apply_chart_style op：校验（未知 style_id / style_id+style 同给 /
   都不给 / 非法 token）、应用+撤销、系列级覆盖重置、逐点 points 保留、
   styleRef 记录、保留数据/映射/轴标签/y2；
3. 替换式语义：acs-bold → nature-minimal 的渲染与直接套 nature-minimal
   完全一致（A→B 等价）；内联部分 token 缺省键回渲染默认而非残留旧值；
4. apply_template 整体替换元素后，{kind:"type"} 默认风格只命中新图表。
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
const fs=require('fs');
for (const f of ['figdoc','ops','palette','presets','data','render']) {
  require('./lib/'+f+'.js');
}
FigPresets.load({
  journals: JSON.parse(fs.readFileSync('../presets/journals.json','utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json','utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json','utf8')),
  styles: JSON.parse(fs.readFileSync('../presets/styles.json','utf8'))
});
function mkDoc(chartType, rows) {
  let doc = FigDoc.create({title:'t',width_mm:120,height_mm:90});
  const el = FigData.makeChartElement(
    {columns:['x','a','b','c'], rows:rows},
    {chart_type:chartType, mapping:{x:'x',y:'a',ys:['a','b','c']}});
  return FigOps.applyAll(doc,[{op:'add_element',element:el}],{label:'i'}).doc;
}
function mkCustom(chartType, columns, rows, mapping) {
  let doc = FigDoc.create({title:'t',width_mm:120,height_mm:90});
  const el = FigData.makeChartElement(
    {columns:columns, rows:rows},
    {chart_type:chartType, mapping:mapping});
  return FigOps.applyAll(doc,[{op:'add_element',element:el}],{label:'i'}).doc;
}
function legendPosOf(svg){
  const m = svg.match(/data-legend-pos="([^"]+)"/);
  return m ? m[1] : null;
}
function LINE_ROWS(n){const r=[];for(let i=0;i<n;i++)r.push([i,Math.sin(i/5)*2+10,i*0.5+20,50-i*0.3]);return r;}
function SCATTER_ROWS(n){const r=[];for(let i=0;i<n;i++)r.push([i*1.7+3,10+((i*37)%23),20+((i*11)%17),15+((i*7)%13)]);return r;}
function svgOf(el, w, h){
  return FigData.renderChartSVG(el.chart, {
    width_mm:w||80, height_mm:h||60, dpi:150,
    fontFamily:el.style&&el.style.fontFamily, fontSizePt:el.style&&el.style.fontSizePt});
}
// 宽表多系列（ys=a,b,c）第 1 列的稳定系列键：series|a|s:a
const SER_KEY_A = 'series|a|s:a';
function pointKeyOf(el, rowIdx){ return FigData.pointKey(el.chart, rowIdx); }
"""


def run(script):
    return node_json(PRELUDE + script)


class RendererTokenTest(unittest.TestCase):
    """渲染器 token 级验证。"""

    def test_legend_frame_rect(self):
        # origin-classic: legend.position=inside-tr + frame=true → 白底细框
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(12));
          const id = doc.elements[0].id;
          const d = FigOps.applyAll(doc,[{op:'apply_chart_style',
            targets:[id], style_id:'origin-classic'}],{label:'s'}).doc;
          const svg = svgOf(d.elements[0]);
          console.log(JSON.stringify({hasFrameRect: /<rect[^>]*fill="#FFFFFF"[^>]*stroke="#000000"/.test(svg)
            || /<rect[^>]*stroke="#000000"[^>]*fill="#FFFFFF"/.test(svg),
            whiteFillRects:(svg.match(/fill="#FFFFFF"/g)||[]).length,
            legend:(svg.match(/data-chart-part="legend"/g)||[]).length>0}));
        """)
        self.assertTrue(out["hasFrameRect"],
                        "legend.frame 应产生白底细框矩形: %s" % out)
        self.assertTrue(out["legend"], "应有图例元素")

    def test_inside_tr_legend_inside_plot(self):
        # inside-tr 图例应位于绘图区内：图例文字 x 应小于绘图区右缘
        # （右缘=框线最右竖线）；且 inside 不挤占绘图区（右缘宽于 right 位置）
        script = r"""
          function legendMaxX(svg){
            let mx=0;
            const re=/x="([\d.]+)"[^>]*data-chart-part="legend"/g;
            let m; while((m=re.exec(svg))){const v=parseFloat(m[1]); if(v>mx)mx=v;}
            return mx;
          }
          function plotRightX(svg){
            // 绘图区右缘：x1==x2 的竖线中最大 x（框线右脊）
            let mx=0;
            const re=/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g;
            let m; while((m=re.exec(svg))){
              if (Math.abs(parseFloat(m[1])-parseFloat(m[3]))<0.01){
                const v=parseFloat(m[1]); if(v>mx)mx=v;
              }
            }
            return mx;
          }
          function posSvg(pos){
            const doc = mkDoc('line_multi', LINE_ROWS(12));
            const id = doc.elements[0].id;
            const d = FigOps.applyAll(doc,[{op:'set_chart_properties',
              targets:[id],
              properties:{presentation:{legend:{position:pos}}}}],{label:'p'}).doc;
            return svgOf(d.elements[0]);
          }
          const insideSvg = posSvg('inside-tr');
          const rightSvg = posSvg('right');
          console.log(JSON.stringify({
            insideLegendX: legendMaxX(insideSvg),
            insidePlotRight: plotRightX(insideSvg),
            rightLegendX: legendMaxX(rightSvg),
            rightPlotRight: plotRightX(rightSvg),
            hasLegend: insideSvg.indexOf('data-chart-part="legend"')>=0}));
        """
        out = run(script)
        self.assertTrue(out["hasLegend"])
        self.assertGreater(out["insideLegendX"], 0)
        self.assertGreater(out["insidePlotRight"], 0)
        self.assertGreater(out["rightLegendX"], 0)
        self.assertGreater(out["rightPlotRight"], 0)
        # inside-tr：图例文字起点 < 绘图区右缘（文字向右延伸，短标签仍在框内）
        self.assertLess(out["insideLegendX"], out["insidePlotRight"],
                        "inside-tr 图例应位于绘图区内")
        # right：图例在绘图区右侧（文字 x > 绘图区右缘）
        self.assertGreater(out["rightLegendX"], out["rightPlotRight"],
                           "right 图例应在绘图区外右侧")
        # inside 不挤占绘图区：inside-tr 绘图区右缘应宽于 right 位置
        self.assertGreater(out["insidePlotRight"], out["rightPlotRight"] + 30,
                           "inside 图例不应挤占绘图区宽度")

    def test_inside_best_bar_avoids_tall_right_bars(self):
        # inside-best：最高柱在右 → 图例不得落在右上/右下内角
        out = run(r"""
          const cats=['A','B','C','D','E'], vs=[5,6,8,22,28], rows=[];
          for (let c=0;c<cats.length;c++) rows.push([cats[c],vs[c],'G']);
          const doc = mkCustom('bar_grouped', ['cat','v','grp'], rows,
            {x:'cat',y:'v',group:'grp'});
          const id = doc.elements[0].id;
          const d = FigOps.applyAll(doc,[{op:'set_chart_properties',
            targets:[id],
            properties:{presentation:{legend:{position:'inside-best'}}}}],{label:'p'}).doc;
          const svg = svgOf(d.elements[0]);
          console.log(JSON.stringify({pos: legendPosOf(svg),
            hasLegend: svg.indexOf('data-legend-pos=')>=0}));
        """)
        self.assertTrue(out["hasLegend"], "应有图例")
        self.assertIn(out["pos"], ["inside-tl", "inside-bl"],
                      "最高柱在右时图例应避开右角，实际：%s" % out["pos"])

    def test_inside_best_line_bottom_left_empty(self):
        # inside-best：数据占满其余三角、唯独左下为空 → inside-bl（或 right）
        out = run(r"""
          const rows=[];
          for (let x=0;x<12;x++) rows.push([x, x<6?30:5, 30, x<6?22:5]);
          const doc = mkDoc('line_multi', rows);
          const id = doc.elements[0].id;
          const d = FigOps.applyAll(doc,[{op:'set_chart_properties',
            targets:[id],
            properties:{presentation:{legend:{position:'inside-best'}}}}],{label:'p'}).doc;
          const svg = svgOf(d.elements[0]);
          console.log(JSON.stringify({pos: legendPosOf(svg)}));
        """)
        self.assertIn(out["pos"], ["inside-bl", "right"],
                      "左下为空时图例应在 inside-bl 或退到 right，实际：%s" % out["pos"])

    def test_hollow_markers(self):
        # mono-print markers.fill=hollow → 散点 fill="none"
        out = run(r"""
          const doc = mkDoc('scatter', SCATTER_ROWS(20));
          const id = doc.elements[0].id;
          const d = FigOps.applyAll(doc,[{op:'apply_chart_style',
            targets:[id], style_id:'mono-print'}],{label:'s'}).doc;
          const svg = svgOf(d.elements[0]);
          console.log(JSON.stringify({noneFills:(svg.match(/fill="none"/g)||[]).length,
            coloredStrokes:(svg.match(/stroke="#/g)||[]).length>0}));
        """)
        self.assertGreater(out["noneFills"], 5, "hollow 标记应大量 fill=none")
        self.assertTrue(out["coloredStrokes"])

    def test_marker_and_dash_cycles(self):
        # 内联风格 markerCycle + dashCycle 按系列序号循环
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(12));
          const id = doc.elements[0].id;
          const tokens = {
            markers:{fill:'solid', cycle:['circle','square','triangle']},
            dashes:['dash','dot','dashdot']
          };
          const d = FigOps.applyAll(doc,[{op:'apply_chart_style',
            targets:[id], style:tokens}],{label:'s'}).doc;
          const svg = svgOf(d.elements[0]);
          console.log(JSON.stringify({markers:(svg.match(/data-marker="[a-z]+"/g)||[]),
            dasharrays:(svg.match(/stroke-dasharray="[^"]+"/g)||[])}));
        """)
        self.assertTrue(any('square' in m for m in out["markers"]),
                        "markerCycle 应让第 2 系列用 square: %s" % out["markers"][:6])
        self.assertTrue(any('triangle' in m for m in out["markers"]),
                        "markerCycle 应让第 3 系列用 triangle")
        self.assertTrue(len(set(out["dasharrays"])) >= 2,
                        "dashCycle 应产生多种虚线: %s" % out["dasharrays"][:6])

    def test_background_rect(self):
        # ggplot-grey background #EBEBEB → 绘图区背景矩形
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(12));
          const id = doc.elements[0].id;
          const d = FigOps.applyAll(doc,[{op:'apply_chart_style',
            targets:[id], style_id:'ggplot-grey'}],{label:'s'}).doc;
          const svg = svgOf(d.elements[0]);
          console.log(JSON.stringify({hasBg: svg.indexOf('fill="#EBEBEB"')>=0}));
        """)
        self.assertTrue(out["hasBg"], "plot.background 应渲染背景矩形")

    def test_axis_width_zero_and_tick_length_zero(self):
        # 散点图 + axisWidthPt:0 + tickLengthPt:0 + 无网格 → 无 <line> 轴/刻度线
        script = r"""
          function countLines(svg){return (svg.match(/<line[ >]/g)||[]).length;}
          const tokens = {plot:{axisWidthPt:0, tickLengthPt:0}, grid:{show:false}};
          const doc = mkDoc('scatter', SCATTER_ROWS(15));
          const id = doc.elements[0].id;
          const styled = FigOps.applyAll(doc,[{op:'apply_chart_style',
            targets:[id], style:tokens}],{label:'s'}).doc;
          const svgStyled = svgOf(styled.elements[0]);
          const doc2 = mkDoc('scatter', SCATTER_ROWS(15));
          const svgPlain = svgOf(doc2.elements[0]);
          console.log(JSON.stringify({styledLines: countLines(svgStyled), plainLines: countLines(svgPlain)}));
        """
        out = run(script)
        self.assertEqual(out["styledLines"], 0,
                         "axisWidthPt:0 + tickLengthPt:0 + 无网格 → 不应有轴/刻度线")
        self.assertGreater(out["plainLines"], 0, "默认渲染应有轴线/刻度线")

    def test_font_family_and_weights(self):
        # serif-bold: Times New Roman + 粗体 → SVG font-family / font-weight
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(10));
          const id = doc.elements[0].id;
          const d = FigOps.applyAll(doc,[{op:'apply_chart_style',
            targets:[id], style_id:'serif-bold'}],{label:'s'}).doc;
          const svg = svgOf(d.elements[0]);
          console.log(JSON.stringify({family: /font-family="[^"]*Times New Roman/.test(svg),
            boldWeight: /font-weight="bold"/.test(svg)}));
        """)
        self.assertTrue(out["family"], "serif-bold 应用 Times New Roman")
        self.assertTrue(out["boldWeight"], "serif-bold 标题应 bold")

    def test_hollow_fill_not_on_bars(self):
        # markerFill=hollow 只作用于点标记：柱状图柱体不得 fill="none"
        out = run(r"""
          const cats=['A','B','C','D'], rows=[];
          for (let c=0;c<cats.length;c++) for (let g=0;g<3;g++)
            rows.push([cats[c],10+c*4+g*2+(c*g)%3,['甲','乙','丙'][g]]);
          const doc = mkCustom('bar_grouped', ['cat','v','grp'], rows,
            {x:'cat',y:'v',group:'grp'});
          const id = doc.elements[0].id;
          const d = FigOps.applyAll(doc,[{op:'apply_chart_style',
            targets:[id], style_id:'mono-print'}],{label:'s'}).doc;
          const svg = svgOf(d.elements[0]);
          console.log(JSON.stringify({
            hollowRects: (svg.match(/<rect[^>]*fill="none"/g)||[]).length,
            coloredRects: (svg.match(/<rect[^>]*fill="#/g)||[]).length,
            styleRef: d.elements[0].chart.styleRef && d.elements[0].chart.styleRef.id}));
        """)
        self.assertEqual(out["hollowRects"], 0,
                         "hollow 不应作用于柱体（mono-print bars）")
        self.assertGreater(out["coloredRects"], 0, "柱体应有调色板填充色")
        self.assertEqual(out["styleRef"], "mono-print")

    def test_marker_cycle_reaches_scatter(self):
        # markerCycle 应用到散点：宽表 ys / 颜色分组 / 单系列三种形态
        out = run(r"""
          function markersOf(svg){
            return [...new Set((svg.match(/data-marker="([a-z]+)"/g)||[])
              .map(function(m){return m.replace(/data-marker="|"/g,'');}))];
          }
          // 宽表 ys → 3 系列
          const sr=[];
          for (let i=0;i<30;i++) sr.push([i*1.7+3,10+((i*37)%23),
            20+((i*11)%17),15+((i*7)%13)]);
          const dWide = mkDoc('scatter', sr);
          const w = FigOps.applyAll(dWide,[{op:'apply_chart_style',
            targets:[dWide.elements[0].id], style_id:'mono-print'}],{label:'s'}).doc;
          const wideMarkers = markersOf(svgOf(w.elements[0]));
          // 颜色分组：columns x,y,g；grp 3 值
          const rows2=[];
          const gs=['P','Q','R'];
          for (let i=0;i<30;i++) rows2.push([i*1.3+2, 10+((i*17)%19), gs[i%3]]);
          const dGrp = mkCustom('scatter', ['x','y','g'], rows2,
            {x:'x',y:'y',color:'g'});
          const g2 = FigOps.applyAll(dGrp,[{op:'apply_chart_style',
            targets:[dGrp.elements[0].id], style_id:'mono-print'}],{label:'s'}).doc;
          const grpMarkers = markersOf(svgOf(g2.elements[0]));
          // 单系列散点
          const rows3=[];
          for (let i=0;i<25;i++) rows3.push([i*1.1+1, 12+((i*13)%15)]);
          const dSingle = mkCustom('scatter', ['x','y'], rows3, {x:'x',y:'y'});
          const s3 = FigOps.applyAll(dSingle,[{op:'apply_chart_style',
            targets:[dSingle.elements[0].id], style_id:'mono-print'}],{label:'s'}).doc;
          const singleMarkers = markersOf(svgOf(s3.elements[0]));
          console.log(JSON.stringify({wideMarkers:wideMarkers,
            grpMarkers:grpMarkers, singleMarkers:singleMarkers}));
        """)
        for key in ("wideMarkers", "grpMarkers"):
            self.assertGreaterEqual(len(out[key]), 3,
                "%s 应有 ≥3 种标记（markerCycle），实际 %s" % (key, out[key]))
            self.assertIn("square", out[key])
            self.assertIn("triangle", out[key])
        self.assertEqual(out["singleMarkers"], ["circle"],
                         "单系列散点应取 markerCycle[0]=circle")

    def test_dash_cycle_scaled_per_series(self):
        # dashCycle：按系列序号产生不同 stroke-dasharray，且按 dpi 缩放
        # （pt 制 → px；不得再是原始 "4 2" 小数值实线观感）
        out = run(r"""
          function dashInfo(svg){
            return (svg.match(/stroke-dasharray="([^"]+)"/g)||[])
              .map(function(m){return m.replace(/stroke-dasharray="|"/g,'');});
          }
          // 宽表 line_multi
          const dWide = mkDoc('line_multi', LINE_ROWS(12));
          const w = FigOps.applyAll(dWide,[{op:'apply_chart_style',
            targets:[dWide.elements[0].id], style_id:'mono-print'}],{label:'s'}).doc;
          const wideDashes = dashInfo(svgOf(w.elements[0], 120, 90));
          // 分组 line_multi（非宽表）
          const rows=[]; const gs=['P','Q','R'];
          for (let x=0;x<12;x++) for (let g=0;g<3;g++)
            rows.push([x, 10+((x*7+g*13)%20), gs[g]]);
          const dGrp = mkCustom('line_multi', ['x','y','g'], rows,
            {x:'x',y:'y',group:'g'});
          const g2 = FigOps.applyAll(dGrp,[{op:'apply_chart_style',
            targets:[dGrp.elements[0].id], style_id:'mono-print'}],{label:'s'}).doc;
          const grpDashes = dashInfo(svgOf(g2.elements[0], 120, 90));
          // svgOf 默认 dpi=150 → u=150/72≈2.083；"4 2"pt → "8.33 4.17"
          console.log(JSON.stringify({wideDashes:wideDashes, grpDashes:grpDashes}));
        """)
        for key in ("wideDashes", "grpDashes"):
            uniq = set(out[key])
            self.assertGreaterEqual(len(uniq), 2,
                "%s 应有 ≥2 种虚线（dash/dot），实际 %s" % (key, out[key]))
            # dpi=150 → u≈2.083：dash "4 2"pt→8.33，dot "1.2 1.8"pt→2.5。
            # 原始未缩放值为 4 / 1.2 —— 用 min>2 排除原始 dot、max>6 排除原始 dash。
            firsts = [float(d.split()[0]) for d in uniq]
            self.assertGreater(min(firsts), 2.0,
                "%s 虚线首段应为缩放后值（>2px），实际 %s" % (key, out[key]))
            self.assertGreater(max(firsts), 6.0,
                "%s 虚线首段应为缩放后值（>6px），实际 %s" % (key, out[key]))


class OpsTest(unittest.TestCase):
    """apply_chart_style op 行为。"""

    def test_validate_unknown_style_id(self):
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(5));
          const id = doc.elements[0].id;
          const errs = FigOps.validateAll([{op:'apply_chart_style',
            targets:[id], style_id:'no-such-style'}], doc);
          console.log(JSON.stringify({errs: errs.errors}));
        """)
        self.assertTrue(out["errs"], "未知 style_id 应被拒绝")

    def test_validate_both_style_id_and_style(self):
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(5));
          const id = doc.elements[0].id;
          const errs = FigOps.validateAll([{op:'apply_chart_style',
            targets:[id], style_id:'acs-bold',
            style:{font:{family:'Arial'}}}], doc);
          console.log(JSON.stringify({errs: errs.errors}));
        """)
        self.assertTrue(out["errs"], "style_id 与 style 同给应被拒绝")

    def test_validate_neither(self):
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(5));
          const id = doc.elements[0].id;
          const errs = FigOps.validateAll([{op:'apply_chart_style',
            targets:[id]}], doc);
          console.log(JSON.stringify({errs: errs.errors}));
        """)
        self.assertTrue(out["errs"], "都不给应被拒绝")

    def test_validate_bad_tokens(self):
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(5));
          const id = doc.elements[0].id;
          const cases = [
            {plot:{axisWidthPt:-1}},
            {plot:{frame:'yes'}},
            {markers:{fill:'half'}},
            {legend:{position:'middle'}},
            {font:{basePt:'big'}},
            {palette:'no-such-palette'}
          ];
          const results = cases.map(function(t){
            return FigOps.validateAll([{op:'apply_chart_style',
              targets:[id], style:t}], doc).errors.length;
          });
          console.log(JSON.stringify({results: results}));
        """)
        self.assertTrue(all(r > 0 for r in out["results"]),
                        "非法 token 应全部被拒绝: %s" % out["results"])

    def test_apply_undo_styleRef(self):
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(10));
          const id = doc.elements[0].id;
          const applied = FigOps.applyAll(doc,[{op:'apply_chart_style',
            targets:[id], style_id:'acs-bold'}],{label:'s'});
          const el = applied.doc.elements[0];
          const snap = {palette: el.chart.paletteId,
            ref: el.chart.styleRef, pres: el.chart.presentation};
          const undone = FigOps.undo(applied.doc);
          const elU = undone.elements[0];
          console.log(JSON.stringify({applied: applied.applied !== false,
            palette: snap.palette, ref: snap.ref,
            hasStyleRef: !!(snap.ref && snap.ref.id==='acs-bold'),
            undonePalette: elU.chart.paletteId,
            undoneRef: elU.chart.styleRef || null,
            undonePres: elU.chart.presentation || null}));
        """)
        self.assertTrue(out["applied"])
        self.assertTrue(out["hasStyleRef"])
        self.assertIsNotNone(out["palette"])
        self.assertIsNone(out["undoneRef"], "撤销后 styleRef 应消失")
        self.assertIsNone(out["undonePalette"], "撤销后 paletteId 应恢复")

    def test_series_reset_points_kept(self):
        out = run(r"""
          const doc = mkDoc('scatter', SCATTER_ROWS(8));
          const id = doc.elements[0].id;
          const pk = pointKeyOf(doc.elements[0], 0);
          const key = SER_KEY_A;
          const d1 = FigOps.applyAll(doc,[
            {op:'set_chart_properties', targets:[id],
             properties:{presentation:{series:{[key]:{stroke:'#FF0000',
               opacity:0.5, strokeWidthPt:3, marker:'square'}}}}},
            {op:'set_chart_properties', targets:[id],
             properties:{presentation:{points:{[pk]:{fill:'#00FF00'}}}}}
          ],{label:'p'}).doc;
          const d2 = FigOps.applyAll(d1,[{op:'apply_chart_style',
            targets:[id], style_id:'prism-stat'}],{label:'s'}).doc;
          const el2 = d2.elements[0];
          const sv = (el2.chart.presentation.series||{})[key]||{};
          const pv = (el2.chart.presentation.points||{})[pk];
          console.log(JSON.stringify({stroke: sv.stroke, width: sv.strokeWidthPt, marker: sv.marker,
            opacity: sv.opacity, pointFill: pv && pv.fill, pk: pk}));
        """)
        self.assertIsNone(out.get("stroke"), "系列 stroke 应被风格重置")
        self.assertIsNone(out.get("width"), "系列 strokeWidthPt 应被重置")
        self.assertIsNone(out.get("marker"), "系列 marker 应被重置")
        self.assertAlmostEqual(out["opacity"], 0.5, places=3,
                               msg="系列 opacity 应保留")
        self.assertEqual(out["pointFill"], "#00FF00", "逐点覆盖应保留")

    def test_preserves_data_mapping_labels_y2(self):
        out = run(r"""
          const doc = mkDoc('line_multi', LINE_ROWS(6));
          const id = doc.elements[0].id;
          const d1 = FigOps.applyAll(doc,[
            {op:'set_chart_properties', targets:[id],
             properties:{axes:{xLabel:'时间 / s', y2:{series:['c'],label:'右轴'}}}}
          ],{label:'a'}).doc;
          const el1 = d1.elements[0];
          const rowsBefore = JSON.stringify(el1.chart.data.inline.rows);
          const mapBefore = JSON.stringify(el1.chart.mapping);
          const d2 = FigOps.applyAll(d1,[{op:'apply_chart_style',
            targets:[id], style_id:'vivid-contrast'}],{label:'s'}).doc;
          const el = d2.elements[0];
          console.log(JSON.stringify({rowsSame: JSON.stringify(el.chart.data.inline.rows)===rowsBefore,
            mapSame: JSON.stringify(el.chart.mapping)===mapBefore,
            y2: el.chart.axes && el.chart.axes.y2,
            xLabel: el.chart.axes && el.chart.axes.xLabel}));
        """)
        self.assertTrue(out["rowsSame"], "数据行不应改变")
        self.assertTrue(out["mapSame"], "mapping 不应改变")
        self.assertIsNotNone(out["y2"], "y2 配置应保留")
        self.assertEqual(out["xLabel"], "时间 / s", "轴标签文本应保留")

    def test_a_to_b_equivalence(self):
        # acs-bold → nature-minimal ≡ 直接 nature-minimal（SVG 完全一致）
        script = r"""
          function applySeq(styleIds){
            const doc = mkDoc('line_multi', LINE_ROWS(15));
            const id = doc.elements[0].id;
            let d = doc;
            styleIds.forEach(function(s){
              d = FigOps.applyAll(d,[{op:'apply_chart_style',
                targets:[id], style_id:s}],{label:'s'}).doc;
            });
            return svgOf(d.elements[0]);
          }
          const ab = applySeq(['acs-bold','nature-minimal']);
          const b  = applySeq(['nature-minimal']);
          const acs = applySeq(['acs-bold']);
          console.log(JSON.stringify({abEqB: ab===b, differsFromAcs: acs!==b}));
        """
        out = run(script)
        self.assertTrue(out["abEqB"],
                        "acs-bold→nature-minimal 应与直接 nature-minimal 渲染一致")
        self.assertTrue(out["differsFromAcs"], "两风格渲染应不同")

    def test_inline_partial_falls_back_to_defaults(self):
        # 内联部分 token：未提供的键应回渲染默认，不残留上一个风格
        script = r"""
          const doc = mkDoc('line_multi', LINE_ROWS(10));
          const id = doc.elements[0].id;
          const d1 = FigOps.applyAll(doc,[{op:'apply_chart_style',
            targets:[id], style_id:'acs-bold'}],{label:'a'}).doc;
          const d2 = FigOps.applyAll(d1,[{op:'apply_chart_style',
            targets:[id], style:{palette:'tab10'}}],{label:'b'}).doc;
          const el = d2.elements[0];
          const pres = el.chart.presentation || {};
          const plot = pres.plot||{};
          const leg = pres.legend||{};
          const axesPres = pres.axes||{};
          console.log(JSON.stringify({palette: el.chart.paletteId,
            plotKeys: Object.keys(plot),
            legendKeys: Object.keys(leg),
            axesKeys: Object.keys(axesPres),
            hasFontWeight: JSON.stringify(axesPres).indexOf('fontWeight')>=0,
            refId: el.chart.styleRef && el.chart.styleRef.id,
            fontFamily: el.style.fontFamily,
            fontSizePt: el.style.fontSizePt}));
        """
        out = run(script)
        self.assertEqual(out["palette"], "tab10")
        self.assertEqual(out["plotKeys"], [],
                         "内联风格未提供 plot → 应回默认: %s" % out["plotKeys"])
        self.assertEqual(out["legendKeys"], [],
                         "内联风格未提供 legend → 应回默认")
        self.assertEqual(out["axesKeys"], [],
                         "未提供 font → 轴排版应回默认")
        self.assertFalse(out["hasFontWeight"],
                         "未提供 font → 字重应回默认")
        self.assertIsNone(out.get("fontFamily"), "未提供 font.family → 应删除旧值")
        self.assertIsNone(out.get("fontSizePt"), "未提供 font.basePt → 应删除旧值")
        self.assertEqual(out["refId"], "custom")

    def test_apply_template_default_style_targets_only_new(self):
        # 文档已有图表 → apply_template（整体替换元素）→
        # {kind:"type",type:"chart"} 默认风格只命中新图表（旧图已被替换）
        script = r"""
          const doc = mkDoc('scatter', SCATTER_ROWS(8));
          const oldId = doc.elements[0].id;
          const ops = [
            {op:'apply_template', template_id:'tpl-line',
             data:{columns:['x','y'],rows:[[0,1],[1,2],[2,4],[3,8]]}},
            {op:'apply_chart_style', targets:[{kind:'type',type:'chart'}],
             style_id:'seaborn-whitegrid'}
          ];
          const vres = FigOps.validateAll(ops, doc);
          const errs = vres.errors;
          const res = FigOps.applyAll(doc, ops, {label:'tpl'});
          const charts = res.doc.elements.filter(e=>e.type==='chart');
          const styled = charts.filter(e=>e.chart && e.chart.styleRef);
          console.log(JSON.stringify({errs: errs,
            oldGone: !res.doc.elements.some(e=>e.id===oldId),
            totalCharts: charts.length,
            styledCharts: styled.length,
            styledIds: styled.map(function(e){return e.id;})}));
        """
        out = run(script)
        self.assertFalse(out["errs"], "校验不应报错: %s" % out["errs"])
        self.assertTrue(out["oldGone"], "apply_template 应整体替换元素")
        self.assertGreater(out["totalCharts"], 0, "模板应产生图表")
        self.assertEqual(out["styledCharts"], out["totalCharts"],
                         "所有图表都应带 styleRef（它们都是新建的）")


if __name__ == "__main__":
    unittest.main()
