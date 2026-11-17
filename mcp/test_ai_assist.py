"""test_ai_assist.py — H2：实际渲染样式摘要 + 对话修改方案 + apply_template 画布

node 内核直跑；模型请求一律用 global.fetch 桩，绝不请求真实模型。
"""
import json
import os
import subprocess
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

ROWS = [["A", 1, 10.5], ["A", 2, 20.25], ["B", 1, 15.0], ["B", 2, 25.75]]
DATA = {"columns": ["grp", "x", "y"], "rows": ROWS}


def node_json(script, timeout=60):
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    proc = subprocess.run(["node", "-e", script], cwd=str(HERE), capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout,
                          env=env)
    if proc.returncode:
        raise AssertionError((proc.stdout or "") + "\n" + (proc.stderr or ""))
    return json.loads(proc.stdout.strip().splitlines()[-1])


# 预载内核 + 建一个 120x90 文档 + 一个 scatter chart（chart-x1）
PRESETS_LOAD = (
    "const fs=require('fs');\n"
    "FigPresets.load({journals:JSON.parse(fs.readFileSync('../presets/journals.json','utf8')),"
    "templates:JSON.parse(fs.readFileSync('../presets/templates.json','utf8')),"
    "palettes:JSON.parse(fs.readFileSync('../presets/palettes.json','utf8'))});\n"
)

PRELUDE = (
    "require('./lib/figdoc.js');require('./lib/ops.js');require('./lib/ai.js');"
    "require('./lib/presets.js');require('./lib/data.js');require('./lib/palette.js');\n"
    + PRESETS_LOAD +
    "var doc=FigDoc.create({width_mm:120,height_mm:90});\n"
    "var el=FigData.makeChartElement(%s,{chart_type:'scatter',mapping:{x:'x',y:'y',color:'grp'}});\n"
    "el.id='chart-x1';el.name='(a)';el.transform={x:10,y:10,w:100,h:70,rotation:0};\n"
    "doc=FigOps.applyAll(doc,[{op:'add_element',element:el}],{label:'t'}).doc;\n"
    "var chart=FigDoc.get(doc,'chart-x1');\n" % json.dumps(DATA)
)


class DescribeChartStyle(unittest.TestCase):
    def test_defaults_and_overrides(self):
        out = node_json(PRELUDE + """
var d0=FigData.describeChartStyle(chart.chart||chart,{});
chart.chart.presentation={version:1,plot:{frame:'box',axisWidthPt:1.5},series:{}};
chart.chart.presentation.series['color|grp|s:A']={stroke:'#ff0000'};
var d1=FigData.describeChartStyle(chart.chart||chart,{});
console.log(JSON.stringify({d0:d0,d1:d1}));
""")
        d0, d1 = out["d0"], out["d1"]
        self.assertEqual(d0["chartType"], "scatter")
        self.assertEqual(d0["axis"]["widthPt"], 0.75)
        self.assertEqual(d0["axis"]["tickLengthPt"], 3)
        self.assertEqual(d0["axis"]["tickDirection"], "in")
        self.assertEqual(d0["axis"]["frame"], "box")
        self.assertFalse(d0["axis"]["gridlines"])
        self.assertEqual(d0["marks"]["markerSizePt"], 4.5)
        self.assertEqual(d0["font"]["tickPt"]["x"], 7)
        self.assertAlmostEqual(d0["font"]["axisTitlePt"]["x"], 8.05, places=2)
        self.assertEqual(d0["legend"]["position"], "right")
        self.assertTrue(len(d0["series"]) >= 1)
        self.assertEqual(d0["overrides"]["points"], 0)
        # 覆盖生效
        self.assertEqual(d1["axis"]["frame"], "box")
        self.assertEqual(d1["axis"]["widthPt"], 1.5)
        a = [s for s in d1["series"] if s.get("label") == "A"]
        self.assertTrue(a and a[0]["color"].lower() == "#ff0000")

    def test_no_raw_data_leak(self):
        out = node_json(PRELUDE + """
var d=FigData.describeChartStyle(chart.chart||chart,{});
console.log(JSON.stringify({hasSentinel:JSON.stringify(d).indexOf('25.75')>=0||JSON.stringify(d).indexOf('10.5')>=0}));
""")
        self.assertFalse(out["hasSentinel"], "样式摘要不得包含原始数据值")


class BuildAssistMessages(unittest.TestCase):
    def test_prompt_and_context(self):
        out = node_json(PRELUDE + """
var msgs=FigAI.buildAssistMessages({doc:doc,instruction:'把点改蓝',anchors:[],selection:[],
  history:[{role:'user',content:'hi'},{role:'assistant',content:'hello'}],
  chartPart:{chartId:'chart-x1',part:'point',pointKey:'pt|0|abc',seriesKey:'k1'},
  checks:[{code:'X',message:'m',element_id:'chart-x1'}],journalProfile:{name:'P',width_mm:89}});
var sys=msgs[0].content;
console.log(JSON.stringify({n:msgs.length,
hasPrompt:sys.indexOf('科研绘图编辑器里的助手')>=0,
hasStyle:sys.indexOf('当前实际渲染样式')>=0,
hasTickDir:sys.indexOf('"tickDirection":"in"')>=0,
hasPart:sys.indexOf('pt|0|abc')>=0,
hasCheck:sys.indexOf('[X] m（chart-x1）')>=0,
noData:sys.indexOf('25.75')<0&&sys.indexOf('10.5')<0,
hasHist:msgs.some(function(m){return m.content==='hello';}),
lastUser:msgs[msgs.length-1].content}));
""")
        self.assertGreaterEqual(out["n"], 3)
        for k in ("hasPrompt", "hasStyle", "hasTickDir", "hasPart", "hasCheck", "noData", "hasHist"):
            self.assertTrue(out[k], k)
        self.assertEqual(out["lastUser"], "把点改蓝")


class RequestAssist(unittest.TestCase):
    def _run(self, responses, configure=True):
        # responses: list of {status, json} or raw text; returns {calls, result|error}
        setup = PRELUDE
        if configure:
            setup += "FigAI.config({apiKey:'k',baseUrl:'http://x'});\n"
        setup += "var __calls=[];var __responses=%s;\n" % json.dumps(responses)
        setup += """
global.fetch=function(url,opts){__calls.push({url:url,body:opts&&opts.body?JSON.parse(opts.body):null});
  var r=__responses[__calls.length-1]||__responses[__responses.length-1];
  if(r.status&&r.status>=400)return Promise.resolve({ok:false,status:r.status,text:function(){return Promise.resolve(r.body||'err');},json:function(){return Promise.resolve({});}});
  var content=(typeof r==='string')?r:(typeof r.json==='string'?r.json:JSON.stringify(r.json));
  return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({choices:[{message:{content:content}}]});},text:function(){return Promise.resolve(content);}});};
"""
        setup += """
(async function(){
try{
var r=await FigAI.requestAssist({doc:doc,instruction:'改',anchors:[],selection:[],history:[]});
console.log(JSON.stringify({ok:true,calls:__calls.length,result:r}));
}catch(e){console.log(JSON.stringify({ok:false,calls:__calls.length,error:String(e&&e.message||e),name:e&&e.name}));}
})();
"""
        return node_json(setup)

    def test_valid_single_op(self):
        good = {"reply": "建议把网格线打开", "ops": [
            {"op": "set_chart_properties", "targets": ["chart-x1"],
             "properties": {"axes": {"gridlines": True}}}]}
        out = self._run([{"status": 200, "json": good}])
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["calls"], 1)
        self.assertEqual(len(out["result"]["ops"]), 1)
        self.assertEqual(out["result"]["mode"], "model")
        self.assertNotIn("repaired", out["result"])

    def test_repair_then_valid(self):
        bad = {"reply": "r", "ops": [{"op": "no_such_op", "targets": ["chart-x1"]}]}
        good = {"reply": "r2", "ops": [
            {"op": "set_chart_properties", "targets": ["chart-x1"],
             "properties": {"axes": {"gridlines": True}}}]}
        out = self._run([{"status": 200, "json": bad}, {"status": 200, "json": good}])
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["calls"], 2)
        self.assertTrue(out["result"].get("repaired"))
        self.assertEqual(len(out["result"]["ops"]), 1)

    def test_invalid_twice(self):
        bad = {"reply": "保留这句", "ops": [{"op": "bogus", "targets": ["chart-x1"]}]}
        out = self._run([{"status": 200, "json": bad}, {"status": 200, "json": bad}])
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["calls"], 2)
        self.assertEqual(out["result"]["ops"], [])
        self.assertTrue(out["result"].get("ops_error"))
        self.assertEqual(out["result"]["reply"], "保留这句")

    def test_plain_text(self):
        out = self._run([{"status": 200, "json": "这是一段纯文本回答"}])
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["result"]["reply"], "这是一段纯文本回答")
        self.assertEqual(out["result"]["ops"], [])

    def test_no_key_no_fetch(self):
        out = self._run([{"status": 200, "json": {"reply": "x", "ops": []}}], configure=False)
        self.assertFalse(out["ok"])
        self.assertEqual(out["calls"], 0)
        self.assertEqual(out.get("name"), "AIError")

    def test_http_500_throws(self):
        out = self._run([{"status": 500, "body": "boom"}])
        self.assertFalse(out["ok"])
        self.assertEqual(out["calls"], 1)


class ApplyTemplateCanvas(unittest.TestCase):
    def test_canvas_default_and_explicit(self):
        out = node_json(
            "require('./lib/figdoc.js');require('./lib/ops.js');require('./lib/presets.js');require('./lib/data.js');require('./lib/palette.js');\n"
            + PRESETS_LOAD +
            "var data=%s;\n" % json.dumps(DATA) +
            "var doc=FigDoc.create({width_mm:120,height_mm:90});\n"
            "doc=FigOps.applyAll(doc,[{op:'apply_template',template_id:'tpl-scatter',data:data}],{label:'t'}).doc;\n"
            "var chartEl=doc.elements.filter(function(e){return e&&e.type==='chart';})[0];\n"
            "var tr=chartEl.transform;\n"
            "var inside=tr.x>=0&&tr.y>=0&&(tr.x+tr.w)<=120.001&&(tr.y+tr.h)<=90.001;\n"
            "// 显式 canvas 优先\n"
            "var doc2=FigDoc.create({width_mm:120,height_mm:90});\n"
            "doc2=FigOps.applyAll(doc2,[{op:'apply_template',template_id:'tpl-scatter',data:data,"
            "options:{canvas:{width_mm:200,height_mm:150}}}],{label:'t'}).doc;\n"
            "var tr2=doc2.elements.filter(function(e){return e&&e.type==='chart';})[0].transform;\n"
            "console.log(JSON.stringify({inside:inside,w:tr.w,tr2:tr2,canvas:doc.canvas}));\n"
        )
        self.assertTrue(out["inside"], "chart 应完整落在 120x90 画布内: %s" % out)
        self.assertGreaterEqual(out["w"], 100, "chart 宽应≥100mm")
        # 显式 options.canvas=200x150 → 图表应更宽（按 200 排版）
        self.assertGreater(out["tr2"]["w"], out["w"], "显式 canvas 应生效")

    def test_idempotent_replay(self):
        out = node_json(
            "require('./lib/figdoc.js');require('./lib/ops.js');require('./lib/presets.js');require('./lib/data.js');require('./lib/palette.js');\n"
            + PRESETS_LOAD +
            "var data=%s;\n" % json.dumps(DATA) +
            "var doc=FigDoc.create({width_mm:120,height_mm:90});\n"
            "var op={op:'apply_template',template_id:'tpl-scatter',data:data};\n"
            "doc=FigOps.applyAll(doc,[op],{label:'t'}).doc;\n"
            "var e1=JSON.stringify(doc.elements);\n"
            "// 对同一物化 op 重放（模拟历史恢复）\n"
            "var docB=FigDoc.create({width_mm:120,height_mm:90});\n"
            "docB=FigOps.applyAll(docB,[JSON.parse(JSON.stringify(op))],{label:'t'}).doc;\n"
            "console.log(JSON.stringify({same:JSON.stringify(docB.elements)===e1}));\n"
        )
        self.assertTrue(out["same"], "同一已物化 op 重放应得到相同元素")


if __name__ == "__main__":
    unittest.main()
