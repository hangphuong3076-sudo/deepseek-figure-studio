"""test_ai_capabilities.py — R01/A01：AI 操作能力与运行时校验一致

验证（node 内核直跑，不请求模型；真实账号调用另行记录）：
1. OP_SPECS 与 OP_TYPES 一致：描述里没有运行时不存在的操作，运行时操作都有描述；
2. describeCapabilities 的枚举与 validate 实际行为一致：
   axes.xScale=log 合法 / log10 非法；characterization.x_scale=log10 合法 / log 非法；
3. buildEditMessages 含图表结构摘要（chartType/mapping/axes/characterization/列名+缺失数），
   且不含原始数据行；
4. 合法图表属性操作真实生效且原始行不变；非法字段（properties.mapping）整批拒绝；
5. FigOps 未加载时 ai.js 静态回退文本覆盖 set_chart_properties 与两种对数写法。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

TABLE = {
    "columns": ["binding_energy", "intensity", "sample"],
    "rows": [
        [293.2, 1520.0, "S1"],
        [285.1, 980.5, "S1"],
        [532.4, 2210.75, "S2"],
        [285.1, 1120.0, "S2"],
    ],
}

ROW_SENTINEL = "2210.75"  # 数据行里的独特值，不得进入提示词


def node_json(script, timeout=60):
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    proc = subprocess.run(["node", "-e", script], cwd=str(HERE), capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout,
                          env=env)
    if proc.returncode:
        raise AssertionError((proc.stdout or "") + "\n" + (proc.stderr or ""))
    return json.loads(proc.stdout.strip().splitlines()[-1])


def make_chart_doc_script():
    return (
        "require('./lib/figdoc.js');require('./lib/ops.js');require('./lib/ai.js');\n"
        "var doc=FigDoc.create({width_mm:120,height_mm:90});\n"
        "var chart={id:'chart-x1',type:'chart',name:'(a)',z:1,"
        "transform:{x:10,y:10,w:80,h:60,rotation:0},style:{},\n"
        "chart:{chartType:'line',data:{inline:%s},\n"
        "mapping:{x:'binding_energy',y:'intensity',group:'sample'},axes:{},legend:'right'}};\n"
        "doc=FigOps.applyAll(doc,[{op:'add_element',element:chart}],{label:'t'}).doc;\n"
        % json.dumps(TABLE)
    )


class OpSpecConsistency(unittest.TestCase):
    def test_specs_cover_and_match_op_types(self):
        out = node_json(
            "require('./lib/figdoc.js');require('./lib/ops.js');\n"
            "var specs=Object.keys(FigOps.OP_SPECS).sort();\n"
            "var ops=FigOps.OP_TYPES.slice().sort();\n"
            "console.log(JSON.stringify({specs:specs,ops:ops,"
            "phantom:specs.filter(function(o){return ops.indexOf(o)<0;}),"
            "missing:ops.filter(function(o){return specs.indexOf(o)<0;})}));"
        )
        self.assertEqual(out["phantom"], [], "描述里有运行时不存在的操作")
        self.assertEqual(out["missing"], [], "运行时操作缺少描述")

    def test_enums_match_runtime_validation(self):
        out = node_json(
            "require('./lib/figdoc.js');require('./lib/ops.js');\n"
            + make_chart_doc_script() +
            "var chart=FigDoc.get(doc,'chart-x1');\n"
            "function v(props){return FigOps.validate({op:'set_chart_properties',"
            "targets:['chart-x1'],properties:props},doc);}\n"
            "console.log(JSON.stringify({"
            "axesLog:v({axes:{xScale:'log'}}).ok,"
            "axesLog10:v({axes:{xScale:'log10'}}).ok,"
            "charLog10:v({characterization:{x_scale:'log10'}}).ok,"
            "charLog:v({characterization:{x_scale:'log'}}).ok,"
            "mappingKey:v({mapping:{x:'sample'}}).ok,"
            "specAxesScale:FigOps.OP_SPECS.set_chart_properties.enums['axes.xScale/yScale'],"
            "specCharScale:FigOps.OP_SPECS.set_chart_properties.enums['characterization.x_scale']}));"
        )
        self.assertTrue(out["axesLog"])
        self.assertFalse(out["axesLog10"])
        self.assertTrue(out["charLog10"])
        self.assertFalse(out["charLog"])
        self.assertFalse(out["mappingKey"], "set_chart_properties 不得接受 mapping")
        self.assertEqual(out["specAxesScale"], ["linear", "log"])
        self.assertEqual(out["specCharScale"], ["linear", "log10"])

    def test_describe_capabilities_scope(self):
        out = node_json(
            "require('./lib/figdoc.js');require('./lib/ops.js');\n"
            + make_chart_doc_script() +
            "var withChart=FigOps.describeCapabilities({doc:doc,selection:['chart-x1']});\n"
            "var withText=FigOps.describeCapabilities({doc:doc,selection:[]});\n"
            "function opOf(list,name){for(var i=0;i<list.ops.length;i++)"
            "if(list.ops[i].op===name)return list.ops[i];return null;}\n"
            "console.log(JSON.stringify({"
            "chartIds:withChart.chartIds,"
            "cpAppliesInChart:opOf(withChart,'set_chart_properties').applies,"
            "cpAppliesNoSel:opOf(withText,'set_chart_properties').applies,"
            "scdReason:opOf(withChart,'set_chart_data').reason}));"
        )
        self.assertEqual(out["chartIds"], ["chart-x1"])
        self.assertTrue(out["cpAppliesInChart"])
        self.assertTrue(out["cpAppliesNoSel"], "文档含 chart 时全文档范围仍可用")


class PromptChartContext(unittest.TestCase):
    def test_build_edit_messages_chart_context_without_rows(self):
        out = node_json(
            "require('./lib/figdoc.js');require('./lib/ops.js');require('./lib/ai.js');\n"
            + make_chart_doc_script() +
            "var msgs=FigAI.buildEditMessages({doc:doc,instruction:'把x轴改成log',"
            "selection:['chart-x1']});\n"
            "console.log(JSON.stringify({system:msgs[0].content}));"
        )
        system = out["system"]
        for needle in ("chart-x1", "line", "binding_energy", "intensity",
                       "mapping", "legend", "set_chart_properties"):
            self.assertIn(needle, system, "提示词缺少 %s" % needle)
        self.assertNotIn(ROW_SENTINEL, system, "原始数据行值不得进入提示词")
        self.assertIn("log10", system, "表征参数 log10 写法必须在提示词中说明")
        self.assertIn("linear|log", system, "axes 对数写法必须与表征写法区分")

    def test_fallback_help_mentions_chart_ops_without_ops_js(self):
        # 只加载 ai.js（无 FigOps），验证静态回退文本完整性
        out = node_json(
            "require('./lib/ai.js');\n"
            "var msgs=FigAI.buildEditMessages({doc:{elements:[],anchors:[],"
            "canvas:{width_mm:120,height_mm:90}},instruction:'测试'});\n"
            "console.log(JSON.stringify({system:msgs[0].content}));"
        )
        system = out["system"]
        for needle in ("set_chart_properties", "set_scientific_contract",
                       "layout_schematic", "x_scale（linear|log10"):
            self.assertIn(needle, system)


class ChartOpsApplyReal(unittest.TestCase):
    def test_legal_ops_apply_and_rows_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            out_path = Path(td) / "out.json"
            out = node_json(
                "require('./lib/figdoc.js');require('./lib/ops.js');\n"
                + make_chart_doc_script() +
                "var ops=[\n"
                " {op:'set_chart_properties',targets:['chart-x1'],"
                "properties:{axes:{xLabel:'Binding energy (eV)',yLabel:'Intensity (a.u.)'}}},\n"
                " {op:'set_chart_properties',targets:['chart-x1'],"
                "properties:{characterization:{technique:'XPS',x_reverse:true,"
                "x_scale:'log10',normalize:'max_to_unity'}}}\n"
                "];\n"
                "var v=FigOps.validateAll(ops,doc);\n"
                "if(!v.ok)throw new Error('validate: '+v.errors.join(';'));\n"
                "var applied=FigOps.applyAll(doc,ops,{label:'A01'});\n"
                "var chart=FigDoc.get(applied.doc,'chart-x1');\n"
                "console.log(JSON.stringify({changed:applied.changed,applied:applied.applied,"
                "xLabel:chart.chart.axes.xLabel,x_reverse:chart.chart.characterization.x_reverse,"
                "x_scale:chart.chart.characterization.x_scale,"
                "normalize:chart.chart.characterization.normalize,"
                "rows:chart.chart.data.inline.rows,"
                "historyLen:applied.doc.history.length}));"
            )
            self.assertTrue(out["changed"])
            self.assertEqual(out["applied"], 2)
            self.assertEqual(out["xLabel"], "Binding energy (eV)")
            self.assertTrue(out["x_reverse"])
            self.assertEqual(out["x_scale"], "log10")
            self.assertEqual(out["normalize"], "max_to_unity")
            self.assertEqual(out["rows"], TABLE["rows"], "原始数据行不得被属性操作改变")
            self.assertEqual(out["historyLen"], 2, "一次 applyAll 一条历史")

    def test_illegal_field_rejects_whole_batch(self):
        out = node_json(
            "require('./lib/figdoc.js');require('./lib/ops.js');\n"
            + make_chart_doc_script() +
            "var ops=[\n"
            " {op:'set_chart_properties',targets:['chart-x1'],properties:{axes:{xLabel:'X'}}},\n"
            " {op:'set_chart_properties',targets:['chart-x1'],properties:{mapping:{x:'sample'}}}\n"
            "];\n"
            "var v=FigOps.validateAll(ops,doc);\n"
            "console.log(JSON.stringify({ok:v.ok,errors:v.errors}));"
        )
        self.assertFalse(out["ok"])
        self.assertTrue(any("mapping" in e for e in out["errors"]))
        self.assertTrue(any("不允许的键" in e for e in out["errors"]))


if __name__ == "__main__":
    unittest.main()
