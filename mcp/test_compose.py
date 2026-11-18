# -*- coding: utf-8 -*-
"""R8 组图测试：panelLayout.areas 跨格布局、/api/tabs/doc 只读接口、
组图对话框 Playwright 流程（跨标签取图→版式→新标签/当前画布→编辑/解散/放入）。
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
from test_modal_layout import _ViewerServer  # noqa: E402


def node_json(script, timeout=60):
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
FigPresets.load({
  journals: JSON.parse(fs.readFileSync('../presets/journals.json','utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json','utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json','utf8')),
  styles: JSON.parse(fs.readFileSync('../presets/styles.json','utf8'))
});
function mkPanelDoc() {
  // 外层 panel 100×80 @ (10,10)，4 个子 panelRelative 子元素
  let doc = FigDoc.create({title:'t',width_mm:210,height_mm:297});
  const panel = {id:'p1',type:'panel',name:'grid',
    transform:{x:10,y:10,w:100,h:80,rotation:0},style:{},z:1,parent_id:null,
    children:['c1','c2','c3','c4'],
    panelLayout:{cols:2,rows:2,gap_mm:4,padding_mm:0,label:'',labelStyle:{},labelPosition:'top-left'}};
  const kids=['c1','c2','c3','c4'].map((id,i)=>({id,type:'panel',name:id,
    transform:{x:0,y:0,w:0.1,h:0.1,rotation:0},style:{panelRelative:true},
    z:2+i,parent_id:'p1',children:[],
    panelLayout:{cols:1,rows:1,gap_mm:0,padding_mm:0,label:'',labelStyle:{},labelPosition:'top-left'}}));
  return FigOps.applyAll(doc,[
    {op:'add_element',element:panel},
    ...kids.map(k=>({op:'add_element',element:k}))
  ],{label:'i'}).doc;
}
function kidT(doc,id){const el=FigDoc.get(doc,id);return el.transform;}
"""


def run(script):
    return node_json(PRELUDE + script)


class PanelAreasKernelTest(unittest.TestCase):
    """panelLayout.areas：校验 + 跨格坐标。"""

    def test_areas_span_coordinates(self):
        # 上一大两小：c1 跨整行，c2/c3 第二行，c4 无声明→填空位（无空位则回退）
        out = run(r"""
          const doc = mkPanelDoc();
          const d = FigOps.applyAll(doc,[{op:'panel_layout',targets:['p1'],
            panel:{cols:2,rows:2,gap_mm:4,areas:[{col:0,row:0,colSpan:2,rowSpan:1}]}}],
            {label:'a'}).doc;
          const p = FigDoc.get(d,'p1');
          const lay = p.panelLayout;
          const res = {areas: lay.areas, kids: ['c1','c2','c3','c4'].map(id=>{
            const t = FigDoc.get(d,id).transform; return {x:+t.x.toFixed(4),y:+t.y.toFixed(4),w:+t.w.toFixed(4),h:+t.h.toFixed(4)};})};
          console.log(JSON.stringify(res));
        """)
        kids = out["kids"]
        # 外层 100×80，cols=2 rows=2 gap=4 → cellW=(100-4)/2=48, cellH=(80-4)/2=38
        # c1: colSpan2 → x=0,y=0,w=(96+4)/100=1.0,h=38/80=0.475
        self.assertAlmostEqual(kids[0]["w"], 1.0, places=3)
        self.assertAlmostEqual(kids[0]["h"], 0.475, places=3)
        # c2: (0,1) → x=0, y=(38+4)/80=0.525, w=0.48, h=0.475
        self.assertAlmostEqual(kids[1]["y"], 0.525, places=3)
        self.assertAlmostEqual(kids[1]["w"], 0.48, places=3)
        # c3: (1,1) → x=0.52, w=0.48
        self.assertAlmostEqual(kids[2]["x"], 0.52, places=3)
        # c4: 网格已满 → 回退 (0,0)（重叠兜底，校验层应避免此情形）
        self.assertEqual(out["areas"][0]["colSpan"], 2)

    def test_areas_shorter_than_children(self):
        # areas 只有 1 项，c2/c3/c4 行主序填空位
        out = run(r"""
          const doc = mkPanelDoc();
          const d = FigOps.applyAll(doc,[{op:'panel_layout',targets:['p1'],
            panel:{cols:2,rows:2,gap_mm:4,areas:[{col:0,row:0,colSpan:1,rowSpan:2}]}}],
            {label:'a'}).doc;
          const res = ['c1','c2','c3','c4'].map(id=>{
            const t = FigDoc.get(d,id).transform; return [t.x,t.y];});
          console.log(JSON.stringify(res));
        """)
        # c1 左大 (0,0,1,2)；c2→(1,0)；c3→(1,1)；c4→无空位回退(0,0)
        self.assertAlmostEqual(out[0][0], 0.0, places=3)
        self.assertAlmostEqual(out[1][0], 0.52, places=3)   # c2 右上
        self.assertAlmostEqual(out[2][1], 0.525, places=3)  # c3 右下

    def test_areas_validation_rejects(self):
        cases = [
            ("overlap", [{"col":0,"row":0,"colSpan":2,"rowSpan":1},
                         {"col":1,"row":0,"colSpan":1,"rowSpan":1}]),
            ("oob", [{"col":1,"row":0,"colSpan":2,"rowSpan":1}]),
            ("oob-row", [{"col":0,"row":1,"colSpan":1,"rowSpan":2}]),
            ("float", [{"col":0.5,"row":0,"colSpan":1,"rowSpan":1}]),
            ("zero-span", [{"col":0,"row":0,"colSpan":0,"rowSpan":1}]),
            ("neg", [{"col":-1,"row":0,"colSpan":1,"rowSpan":1}]),
            ("not-array", "x"),
        ]
        for name, areas in cases:
            script = ("const doc=mkPanelDoc();"
                      "const v=FigOps.validateAll([{op:'panel_layout',targets:['p1'],"
                      "panel:{cols:2,rows:2,areas:%s}}],doc);"
                      "console.log(JSON.stringify({ok:v.ok,err:v.errors[0]||null}));"
                      % json.dumps(areas))
            out = run(script)
            self.assertFalse(out["ok"], "%s 应被拒绝: %s" % (name, out))

    def test_areas_valid_passes(self):
        out = run(r"""
          const doc=mkPanelDoc();
          const v=FigOps.validateAll([{op:'panel_layout',targets:['p1'],
            panel:{cols:2,rows:2,areas:[{col:0,row:0,colSpan:2,rowSpan:1}]}}],doc);
          const v2=FigOps.validateAll([{op:'panel_layout',targets:['p1'],
            panel:{cols:2,rows:2,areas:[{col:0,row:0,colSpan:1,rowSpan:1}]}}],doc);
          console.log(JSON.stringify({a:v.ok,b:v2.ok}));
        """)
        self.assertTrue(out["a"] and out["b"], out)

    def test_no_areas_keeps_uniform_grid(self):
        out = run(r"""
          const doc=mkPanelDoc();
          const d=FigOps.applyAll(doc,[{op:'panel_layout',targets:['p1'],
            panel:{cols:2,rows:2,gap_mm:4}}],{label:'a'}).doc;
          const res=['c1','c2','c3','c4'].map(id=>{
            const t=FigDoc.get(d,id).transform;return [t.x,t.y];});
          console.log(JSON.stringify(res));
        """)
        # 无 areas：行主序 c1(0,0) c2(1,0) c3(0,1) c4(1,1)
        self.assertAlmostEqual(out[1][0], 0.52, places=3)
        self.assertAlmostEqual(out[2][1], 0.525, places=3)

    def test_panel_order_reorders_children(self):
        out = run(r"""
          const doc=mkPanelDoc();
          const d=FigOps.applyAll(doc,[{op:'panel_layout',targets:['p1'],
            panel:{order:['c3','c1','c4','c2']}}],{label:'a'}).doc;
          console.log(JSON.stringify({children:FigDoc.get(d,'p1').children,
            layHasOrder:('order' in (FigDoc.get(d,'p1').panelLayout||{}))}));
        """)
        self.assertEqual(out["children"], ["c3", "c1", "c4", "c2"])
        self.assertFalse(out["layHasOrder"], "order 不应写入 panelLayout")


# ----------------------------------------------------------------------
# /api/tabs/doc 只读接口
# ----------------------------------------------------------------------

def _doc(doc_id, title="", elements=None):
    return {
        "id": doc_id, "schema_version": "1.0", "title": title,
        "canvas": {"width_mm": 210, "height_mm": 297, "unit": "mm",
                   "dpi": 300, "background": "#FFFFFF"},
        "elements": elements or [], "anchors": [],
        "meta": {"created": "2026-01-01T00:00:00Z",
                 "updated": "2026-01-01T00:00:00Z"},
        "history": [],
    }


def _rect(rid, x=5):
    return {"id": rid, "type": "rect", "name": rid,
            "transform": {"x": x, "y": 5, "w": 20, "h": 15, "rotation": 0},
            "style": {"fill": "#ddeeff", "stroke": "#3366cc"}}


def _post(base, path, payload):
    import urllib.request, urllib.error
    req = urllib.request.Request(
        base + path, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"ok": False, "error": "http %s" % e.code}


def _get(base, path):
    import urllib.request, urllib.error
    try:
        with urllib.request.urlopen(base + path, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"ok": False, "error": "http %s" % e.code}


class TabsDocApiTest(unittest.TestCase):
    def setUp(self):
        self.datadir = tempfile.mkdtemp(prefix="fig-tabsdoc-")
        self.server = _ViewerServer(self.datadir)
        self.server.wait_ready()
        self.base = self.server.base

    def tearDown(self):
        try:
            self.server.stop()
        finally:
            shutil.rmtree(self.datadir, ignore_errors=True)

    def _save(self, doc, token):
        return _post(self.base, "/api/current", {"doc": doc, "base_token": token})

    def test_tabs_doc_endpoint(self):
        st, res = self._save(_doc("doc-a", "A", [_rect("ra")]), None)
        self.assertEqual(st, 200, res)
        tok = res["save_token"]
        st, res = _post(self.base, "/api/tabs/new",
                        {"doc": _doc("doc-b", "B", [_rect("rb")]), "base_token": tok})
        self.assertEqual(st, 200, res)
        tok_b = res["save_token"]
        # 活动标签（doc-b）→ 当前文档
        st, j = _get(self.base, "/api/tabs/doc?id=doc-b")
        self.assertEqual(st, 200)
        self.assertTrue(j["ok"])
        self.assertEqual(j["doc"]["id"], "doc-b")
        self.assertEqual([e["id"] for e in j["doc"]["elements"]], ["rb"])
        # 非活动标签（doc-a）→ 读标签文件
        st, j = _get(self.base, "/api/tabs/doc?id=doc-a")
        self.assertEqual(st, 200)
        self.assertEqual(j["doc"]["id"], "doc-a")
        self.assertEqual([e["id"] for e in j["doc"]["elements"]], ["ra"])
        # 未知 id → 404；路径穿越样式 id → 404（不在 order 内）
        st, j = _get(self.base, "/api/tabs/doc?id=nope")
        self.assertEqual(st, 404)
        st, j = _get(self.base, "/api/tabs/doc?id=..%2F..%2Fetc")
        self.assertIn(st, (400, 404))
        # 缺 id → 400
        st, j = _get(self.base, "/api/tabs/doc")
        self.assertEqual(st, 400)
        # 只读：GET 不改 active
        st, j = _get(self.base, "/api/tabs")
        self.assertEqual(j["active_id"], "doc-b")


# ----------------------------------------------------------------------
# Playwright：组图对话框端到端
# ----------------------------------------------------------------------

try:
    from test_modal_layout import HAS_PLAYWRIGHT, _launch_chromium
except Exception:
    HAS_PLAYWRIGHT = False
    _launch_chromium = None

CHART_JS = r"""
(a) => {
  const [type, x, y, w, h, name] = a;
  const id = 'ch-' + name;
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push([i, 10 + i * 0.7 + (i % 3), 20 - i * 0.4]);
  App.commit([{ op: 'add_element', element: {
    id: id, type: 'chart', name: name,
    transform: { x: x, y: y, w: w, h: h, rotation: 0 },
    style: { fontSizePt: 8 },
    chart: { chartType: type,
      data: { inline: { columns: ['x', 'a', 'b'], rows: rows } },
      mapping: { x: 'x', y: 'a' },
      axes: { xLabel: 'x', yLabel: 'y', xScale: 'linear', yScale: 'linear', gridlines: false },
      legend: 'right' } } }], { label: 'add-' + name, source: 'user' });
  return id;
}
"""

HIST_JS = "() => (App.doc.history || []).length"
DOC_EL_COUNT_JS = "() => (App.doc.elements || []).length"


@unittest.skipUnless(HAS_PLAYWRIGHT, "playwright 不可用，跳过")
class ComposeUITest(unittest.TestCase):
    def setUp(self):
        self.datadir = tempfile.mkdtemp(prefix="fig-compose-")
        self.server = _ViewerServer(self.datadir)
        try:
            self.server.wait_ready()
        except Exception:
            self.server.stop()
            shutil.rmtree(self.datadir, ignore_errors=True)
            raise
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self.browser = _launch_chromium(self._pw)

    def tearDown(self):
        try:
            self.browser.close()
        finally:
            self._pw.stop()
        self.server.stop()
        shutil.rmtree(self.datadir, ignore_errors=True)

    def open_page(self):
        ctx = self.browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#panel-import button", timeout=20000)
        page.wait_for_timeout(600)
        return page

    def add_chart(self, page, ctype, name, x=10, y=10, w=50, h=35):
        return page.evaluate(CHART_JS, [ctype, x, y, w, h, name])

    def open_compose(self, page, ids):
        page.evaluate(
            "(ids) => { if (App.select) App.select(ids); Compose.open({ids: ids}); }",
            ids)
        page.wait_for_selector(".compose-modal", timeout=10000)
        # 等来源列表加载完（预选项出现在已选顺序里）
        page.wait_for_selector(".cp-order-item", timeout=10000)
        page.wait_for_timeout(300)

    def pick_source(self, page, tab_text, name_text):
        """勾选来源列表中指定项。"""
        item = page.locator(".cp-src-item", has_text=name_text).filter(
            has_text=tab_text).first
        item.locator("input[type=checkbox]").check()
        page.wait_for_timeout(200)

    def set_field_select(self, page, label, value):
        page.locator(".cp-field", has_text=label).locator("select").select_option(value)
        page.wait_for_timeout(200)

    def test_compose_cross_tab_new_tab(self):
        page = self.open_page()
        try:
            # 当前标签：2 张图
            c1 = self.add_chart(page, "line", "curA", 10, 10)
            c2 = self.add_chart(page, "scatter", "curB", 70, 10)
            page.wait_for_timeout(300)
            # 建第二个标签并放 1 张图（走 Tabs.newTab：flush+adopt）
            page.evaluate(
                "async () => {"
                " const doc = {id:'doc-t2',schema_version:'1.0',title:'数据标签',"
                "canvas:{width_mm:210,height_mm:297,dpi:300,background:'#FFFFFF'},"
                "elements:[],anchors:[],panels:[],history:[],"
                "meta:{created:'2026-01-01',updated:'2026-01-01'}};"
                " await Tabs.newTab(doc); }")
            page.wait_for_timeout(800)
            self.add_chart(page, "bar", "tabC", 10, 10)
            page.wait_for_timeout(300)
            tabs = page.evaluate(
                "async () => await (await fetch('/api/tabs',{cache:'no-store'})).json()")
            tab_ids = [t["id"] for t in tabs["tabs"]]
            other_id = [t for t in tab_ids if t != tabs["active_id"]][0]
            other_title = [t for t in tabs["tabs"] if t["id"] == other_id][0]["title"]

            # 回到第一个标签
            page.evaluate("async (id) => { await Tabs.switchTab(id); }", other_id)
            page.wait_for_timeout(800)

            # 打开组图对话框：勾选 curA、curB（当前标签）+ tabC（另一标签）
            self.open_compose(page, [c1, c2])
            # 等跨标签来源加载完成再勾选
            page.wait_for_selector(
                ".cp-src-item:has-text(\"tabC\")", timeout=10000)
            self.pick_source(page, "数据标签", "tabC")
            self.set_field_select(page, "版式", "top2")     # 上一大两小
            self.set_field_select(page, "格式", "(a)")      # (a)(b)(c)
            self.set_field_select(page, "放到", "newtab")
            page.locator(".ui-modal-footer button", has_text="生成组图").click()
            # 等新标签成为活动
            page.wait_for_function(
                "() => App.doc && App.doc.elements && App.doc.elements.some("
                "e => e.type==='panel' && e.panelLayout && e.panelLayout.areas)",
                timeout=15000)
            page.wait_for_timeout(500)

            # R8b：新标签画布收紧到组图内容+边距（旧行为保留 210×297 → 下方大片空白）
            cvsize = page.evaluate("() => ({w: App.doc.canvas.width_mm, h: App.doc.canvas.height_mm})")
            self.assertLess(cvsize["h"], 200,
                            "新标签画布高度应收紧到组图内容: %s" % cvsize)
            self.assertLess(cvsize["w"], 160,
                            "新标签画布宽度应收紧到组图内容: %s" % cvsize)
            self.assertGreater(cvsize["h"], 30)
            # 校验结构：外层 panel + 3 个子 panel，字母 (a)(b)(c)
            res = page.evaluate(r"""() => {
              const d = App.doc;
              const outer = d.elements.find(e => e.type==='panel' &&
                e.panelLayout && e.panelLayout.areas);
              if (!outer) return {err:'no outer'};
              const kids = (outer.children||[]).map(cid => {
                const c = d.elements.find(e=>e.id===cid);
                return c ? {label:c.panelLayout&&c.panelLayout.label,
                  pos:c.panelLayout&&c.panelLayout.labelPosition,
                  pt:c.panelLayout&&c.panelLayout.labelStyle&&c.panelLayout.labelStyle.fontSizePt,
                  kids:(c.children||[]).length} : null;
              });
              const charts = d.elements.filter(e=>e.type==='chart');
              return {outerId:outer.id, cols:outer.panelLayout.cols,
                rows:outer.panelLayout.rows, areas:outer.panelLayout.areas,
                kids:kids, chartCount:charts.length,
                fonts:charts.map(c=>c.style&&c.style.fontSizePt),
                presFonts:charts.map(c=>c.chart&&c.chart.presentation&&
                  c.chart.presentation.axes&&c.chart.presentation.axes.y&&
                  c.chart.presentation.axes.y.tick&&
                  c.chart.presentation.axes.y.tick.fontSizePt)};
            }""")
            self.assertNotIn("err", res, res)
            labels = [k["label"] for k in res["kids"]]
            self.assertEqual(labels, ["(a)", "(b)", "(c)"], res)
            # 跨格：areas 含 colSpan=2
            self.assertTrue(any(a["colSpan"] == 2 for a in res["areas"]), res)
            # 统一字号：style.fontSizePt 一致（期刊基准或 8）
            self.assertTrue(all(f == res["fonts"][0] for f in res["fonts"]), res)
            # 来源标签未变：doc-t2 仍保留 tabC（跨标签是复制不是移动）
            src_doc = page.evaluate(
                "async () => await (await fetch('/api/tabs/doc?id=doc-t2',"
                "{cache:'no-store'})).json()")
            self.assertTrue(src_doc["ok"], src_doc)
            names = [e.get("name") for e in src_doc["doc"]["elements"]]
            self.assertIn("tabC", names, "来源标签应保留原图: %s" % names)
        finally:
            page.context.close()

    def test_compose_current_canvas_undo_and_edit(self):
        page = self.open_page()
        try:
            c1 = self.add_chart(page, "line", "uA", 10, 10)
            c2 = self.add_chart(page, "scatter", "uB", 70, 10)
            page.wait_for_timeout(300)
            n0 = page.evaluate(DOC_EL_COUNT_JS)
            h0 = page.evaluate(HIST_JS)
            self.open_compose(page, [c1, c2])
            self.set_field_select(page, "版式", "2x2")
            self.set_field_select(page, "放到", "current")
            page.locator(".ui-modal-footer button", has_text="生成组图").click()
            page.wait_for_function(
                "() => App.doc.elements.some(e => e.type==='panel' && "
                "e.panelLayout && e.panelLayout.areas === undefined && "
                "(e.children||[]).length >= 2)", timeout=15000)
            page.wait_for_timeout(400)
            h1 = page.evaluate(HIST_JS)
            self.assertEqual(h1, h0 + 1, "当前画布组图应为一次提交")
            n1 = page.evaluate(DOC_EL_COUNT_JS)
            # 一次撤销还原
            page.locator("#btn-undo").click()
            page.wait_for_timeout(600)
            h2 = page.evaluate(HIST_JS)
            n2 = page.evaluate(DOC_EL_COUNT_JS)
            self.assertEqual(n2, n0, "撤销后元素数应还原")
            # 重新组图用于编辑/解散测试
            self.open_compose(page, [c1, c2])
            self.set_field_select(page, "版式", "1xn")
            self.set_field_select(page, "放到", "current")
            page.locator(".ui-modal-footer button", has_text="生成组图").click()
            page.wait_for_function(
                "() => App.doc.elements.some(e => e.type==='panel' && "
                "e.panelLayout && e.panelLayout.cols === 2)", timeout=15000)
            page.wait_for_timeout(400)
            outer = page.evaluate(
                "() => App.doc.elements.find(e => e.type==='panel' && "
                "e.panelLayout && (e.children||[]).length >= 2).id")
            # 选中外层 → props 出现 编辑组图排版
            page.evaluate("(id) => App.select && App.select([id])", outer)
            page.wait_for_timeout(400)
            edit_btn = page.locator("#panel-props button", has_text="编辑组图排版")
            self.assertTrue(edit_btn.count() > 0, "props 缺少编辑组图排版")
            edit_btn.first.click()
            page.wait_for_selector(".compose-modal", timeout=10000)
            page.locator(".cp-field", has_text="间距").locator("input").fill("6")
            hh = page.evaluate(HIST_JS)
            page.locator(".ui-modal-footer button", has_text="应用").click()
            page.wait_for_timeout(600)
            h3 = page.evaluate(HIST_JS)
            self.assertEqual(h3, hh + 1, "排版修改应为一次提交")
            gap = page.evaluate(
                "(id) => { const e = App.doc.elements.find(x=>x.id===%s);"
                " return e.panelLayout.gap_mm; }" % json.dumps(outer))
            self.assertAlmostEqual(gap, 6.0, places=2)
            # 解散：props 按钮或编辑对话框内
            page.evaluate("(id) => App.select && App.select([id])", outer)
            page.wait_for_timeout(300)
            dis = page.locator("#panel-props button", has_text="解散组图")
            self.assertTrue(dis.count() > 0)
            hd = page.evaluate(HIST_JS)
            dis.first.click()
            page.wait_for_timeout(600)
            h4 = page.evaluate(HIST_JS)
            self.assertEqual(h4, h3 + 1, "解散应为一次提交")
            left = page.evaluate(
                "() => App.doc.elements.filter(e=>e.type==='panel').length")
            self.assertEqual(left, 0, "解散后不应残留 panel")
        finally:
            page.context.close()

    def test_compose_current_canvas_overflow_prompt(self):
        """R8b：组图超出当前画布时弹「画布适配组图」；选 fit 扩画布一次提交。"""
        page = self.open_page()
        try:
            c1 = self.add_chart(page, "line", "ovA", 10, 10)
            c2 = self.add_chart(page, "scatter", "ovB", 90, 10)
            page.wait_for_timeout(300)
            # 缩小画布使 1×N 组图必然超界
            page.evaluate(
                "() => App.commit([{op:'set_canvas',canvas:{width_mm:80,"
                "height_mm:60}}],{label:'small',source:'user'})")
            page.wait_for_timeout(400)
            self.open_compose(page, [c1, c2])
            self.set_field_select(page, "版式", "1xn")
            self.set_field_select(page, "宽度", "double")
            self.set_field_select(page, "放到", "current")
            hh = page.evaluate(HIST_JS)
            page.locator(".ui-modal-footer button", has_text="生成组图").click()
            # 应弹出画布适配询问（按钮文本全局唯一）
            fit_btn = page.locator("button", has_text="画布适配组图")
            fit_btn.wait_for(timeout=8000)
            self.assertTrue(fit_btn.count() > 0, "缺少「画布适配组图」选项")
            fit_btn.first.click()
            page.wait_for_function(
                "() => App.doc.elements.some(e => e.type==='panel' && "
                "e.panelLayout && (e.children||[]).length >= 2)", timeout=15000)
            page.wait_for_timeout(400)
            cv = page.evaluate(
                "() => ({w: App.doc.canvas.width_mm, h: App.doc.canvas.height_mm})")
            self.assertGreater(cv["w"], 80, "画布适配后宽度应增长: %s" % cv)
            h1 = page.evaluate(HIST_JS)
            self.assertEqual(h1, hh + 1, "画布适配组图应为一次提交")
        finally:
            page.context.close()

    def test_draw_svg_in_right_slot_and_reopen(self):
        page = self.open_page()
        page.locator("#btn-compose").click()
        page.get_by_role("button", name="先建空版式").click()
        slots = page.locator('#stage [data-render="empty-layout"] rect')
        slots.nth(1).click(position={"x": 8, "y": 8})
        page.get_by_role("button", name="新建子图画布").click()
        page.wait_for_function("() => App.doc.meta.compose_target")
        source = page.evaluate("""async () => {
          const elements = SvgImport.convert('<svg xmlns="http://www.w3.org/2000/svg">' +
            '<g><g><path d="M0 0L12 10" stroke="blue"/></g></g></svg>').elements;
          await App.commit(elements.map(element => ({op:'add_element', element})));
          return App.doc.id;
        }""")
        page.get_by_role("button", name="放回组图").click()
        page.wait_for_function("() => !App.doc.meta.compose_target && App.doc.elements.some(e=>e.type==='path')")
        self.assertTrue(page.evaluate("async () => (await ViewerBoot.flush()).ok"))
        page.reload()
        page.wait_for_function("() => window.App?.doc?.elements.some(e=>e.type==='path')")
        result = page.evaluate("""() => {
          const d=App.doc, path=d.elements.find(e=>e.type==='path');
          const cell=FigDoc.ancestors(d,path.id).find(e=>e.type==='panel');
          return [FigDoc.validate(d).ok, cell.panelLayout.label,
            d.elements.filter(e=>Compose.isEmptyCell(e)).map(e=>e.name)];
        }""")
        self.assertEqual(result, [True, "b", ["子图 a"]])
        self.assertTrue(page.evaluate("async id => !!(await Tabs.switchTab(id))", source))
        self.assertTrue(page.evaluate("() => App.doc.elements.some(e=>e.type==='path')"))

    def test_place_into_empty_cell(self):
        page = self.open_page()
        try:
            # 建一个真实图表 + 一个空版式 chart 格（在 panel 内）
            real = self.add_chart(page, "line", "real1", 10, 10)
            page.evaluate(r"""() => {
              const panel = {id:'cell-panel',type:'panel',name:'layout',
                transform:{x:80,y:10,w:100,h:60,rotation:0},style:{},z:5,parent_id:null,
                children:['empty-cell'],
                panelLayout:{cols:1,rows:1,gap_mm:0,padding_mm:1,label:'',labelStyle:{},labelPosition:'top-left'}};
              const cell = {id:'empty-cell',type:'chart',name:'空格',
                transform:{x:0,y:0,w:1,h:1,rotation:0},
                style:{panelRelative:true},z:6,parent_id:'cell-panel',
                chart:{chartType:'line',data:{inline:{columns:['x','y'],rows:[]}},
                  mapping:{x:'x',y:'y'},axes:{},legend:'right'}};
              App.commit([
                {op:'add_element',element:panel},
                {op:'add_element',element:cell}],{label:'mk-cell',source:'user'});
            }""")
            page.wait_for_timeout(400)
            page.evaluate("(id) => App.select && App.select([id])", "empty-cell")
            page.wait_for_timeout(400)
            btn = page.locator("#panel-props button", has_text="放入图表")
            self.assertTrue(btn.count() > 0, "空格缺少放入图表入口")
            btn.first.click()
            page.wait_for_selector(".compose-modal", timeout=10000)
            page.wait_for_timeout(600)
            # 选择 real1（当前画布）
            page.locator(".ui-modal-footer button", has_text="放入").click()
            # 上面等待已含 modal；这里确认来源列表渲染
            page.wait_for_selector(".cp-src-item", timeout=10000)
            page.locator(".cp-src-item", has_text="real1").locator(
                "input[type=checkbox]").check()
            page.locator(".ui-modal-footer button", has_text="放入").click()
            page.wait_for_timeout(700)
            res = page.evaluate(r"""() => {
              const d = App.doc;
              const cell = d.elements.find(e=>e.id==='empty-cell');
              const kids = d.elements.filter(e=>e.parent_id==='cell-panel');
              return {placeholderGone: !cell,
                kidCount: kids.length,
                hasData: kids.some(k => k.chart && k.chart.data &&
                  k.chart.data.inline && k.chart.data.inline.rows &&
                  k.chart.data.inline.rows.length > 0),
                rel: kids[0] && kids[0].style && kids[0].style.panelRelative};
            }""")
            self.assertTrue(res["placeholderGone"], res)
            self.assertEqual(res["kidCount"], 1, res)
            self.assertTrue(res["hasData"], "放入的图表应带数据")
            self.assertTrue(res["rel"], "应保持 panelRelative 填充格子")
        finally:
            page.context.close()


if __name__ == "__main__":
    unittest.main()
