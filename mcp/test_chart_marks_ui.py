# -*- coding: utf-8 -*-
"""test_chart_marks_ui.py — 图内点选编辑（H1）Playwright 验收。

覆盖：
  1) 真实鼠标点散点 → App.ui.chartPart.part==='point'、pointKey 与节点一致、
     节点带 data-part-selected、属性面板出现「选中的数据点」且颜色/大小初值
     等于节点实际渲染值；
  2) 颜色改 #ff0000 → 仅该点 fill 变红、其余逐一不变、历史 +1、Ctrl+Z 恢复；
  3) 大小改 9 → 该点半径 = 9/2×dpi/72（按画布 dpi，误差 0.05px）；
  4) 范围切「同系列全部」→ 同 series-key 的点全变色、其他系列不变；
  5) 「恢复默认」→ 该点 fill 回到系列色；
  6) bar 图点柱 → part==='bar'，改色只变那一根；
  7) 回归：点图例文字 → 旧系列部件小节；点 x 轴刻度文字 → 「X 轴刻度文字」
     小节，改字号后刻度 font-size 变化；
  8) 「图表外观」边框改「四边方框」→ 轴线 2→4 条；勾网格线 → 出现网格线；
  9) 向导把 examples/sample.csv 按推荐创建 → chart 宽 ≥ 画布 80%、含映射
     列名的轴标题文字；
 10) 悬停散点 → computed stroke 非 none、cursor 为 pointer。

需要 Python playwright + 可用浏览器；不可用时整体 skip。交互一律用
page.mouse / page.keyboard 真实输入，仅状态断言用只读 evaluate。
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from test_modal_layout import (
    HAS_PLAYWRIGHT, SAMPLE_CSV, _ViewerServer, _launch_chromium,
    DOC_STATS_JS,
)

HERE = Path(__file__).resolve().parent

# 在页面内追加一个散点图（3 组 × 5 点，color 分组），返回 chart 元素 id。
ADD_SCATTER_JS = r"""
() => {
  const rows = [];
  ['A','B','C'].forEach(function (g, gi) {
    for (let i = 0; i < 5; i++) rows.push([g, i * 2 + 1, gi * 10 + i * 1.5 + (i % 2)]);
  });
  const data = { columns: ['grp', 'x', 'y'], rows: rows };
  const el = FigData.makeChartElement(data,
    { chart_type: 'scatter', mapping: { x: 'x', y: 'y', color: 'grp' } });
  el.transform = { x: 5, y: 5, w: 110, h: 80, rotation: 0 };
  el.name = 'marks-scatter';
  const cid = el.id;
  App.commit([{ op: 'add_element', element: el }], { label: 'mk-scatter', source: 'user' });
  return cid;
}
"""

ADD_BAR_JS = r"""
() => {
  const data = { columns: ['cat', 'val'], rows: [['A', 10], ['B', 20], ['C', 15]] };
  const el = FigData.makeChartElement(data,
    { chart_type: 'bar', mapping: { x: 'cat', y: 'val' } });
  el.transform = { x: 5, y: 5, w: 110, h: 80, rotation: 0 };
  el.name = 'marks-bar';
  const cid = el.id;
  App.commit([{ op: 'add_element', element: el }], { label: 'mk-bar', source: 'user' });
  return cid;
}
"""

# 当前 chartPart 引用（只读）。
CHART_PART_JS = (
    "window.App && window.App.ui ? JSON.parse(JSON.stringify("
    "window.App.ui.chartPart || null)) : null")

# 所有数据点/柱子标记的 key→属性快照（只读）。
MARK_SNAPSHOT_JS = r"""
() => {
  const out = {};
  document.querySelectorAll('#svg-stage [data-point-key]').forEach(n => {
    out[n.getAttribute('data-point-key')] = {
      fill: n.getAttribute('fill'),
      r: n.getAttribute('r'),
      series: n.getAttribute('data-series-key'),
      sizePt: n.getAttribute('data-size-pt'),
      marker: n.getAttribute('data-marker'),
      opacity: n.getAttribute('fill-opacity'),
      selected: n.getAttribute('data-part-selected')
    };
  });
  return out;
}
"""

# 取第 idx 个标记的屏幕中心坐标（真实鼠标点击用）。
MARK_CENTER_JS = r"""
(idx) => {
  const ns = [...document.querySelectorAll('#svg-stage [data-point-key]')];
  if (idx >= ns.length) return null;
  const n = ns[idx];
  const r = n.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2,
           key: n.getAttribute('data-point-key') };
}
"""

# 某个 data-chart-part 文字部件的屏幕中心（图例/轴标题/刻度点击用）。
PART_TEXT_CENTER_JS = r"""
(part) => {
  const n = [...document.querySelectorAll('#svg-stage text[data-chart-part]')]
    .find(t => t.getAttribute('data-chart-part') === part);
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
"""

# 属性面板「选中的数据点/柱子」小节是否可见 + 颜色/大小初值。
MARK_PANEL_JS = r"""
() => {
  const sec = document.querySelector('[data-props-section="chart-mark"]');
  const title = [...document.querySelectorAll('*')].find(n =>
    n.children.length === 0 && /选中的(数据点|柱子)/.test(n.textContent || ''));
  const titleVisible = !!(title && title.offsetParent !== null);
  const wrapVisible = !!(sec && sec.offsetParent !== null);
  const colorInp = sec ? sec.querySelector('input[type=color]') : null;
  const numInps = sec ? [...sec.querySelectorAll('input[type=number]')] : [];
  return { section: !!sec, wrapVisible, titleVisible,
           color: colorInp ? colorInp.value : null,
           numbers: numInps.map(i => i.value) };
}
"""

# 图表外观小节是否可见。
LOOK_PANEL_JS = r"""
() => {
  const sec = document.querySelector('[data-props-section="chart-look"]');
  const title = [...document.querySelectorAll('*')].find(n =>
    n.children.length === 0 && (n.textContent || '').trim() === '图表外观');
  return { section: !!sec,
           visible: !!(sec && sec.offsetParent !== null),
           titleVisible: !!(title && title.offsetParent !== null) };
}
"""

# 部件小节当前部件名（partWrap 首个说明行，如「X 轴刻度文字（…）」）。
PART_TITLE_JS = r"""
() => {
  const wrap = document.querySelector('[data-props-section="chart-part"]');
  if (!wrap || wrap.offsetParent === null) return null;
  const first = wrap.firstElementChild;
  return first ? (first.textContent || '').trim() : null;
}
"""

# 轴线（frame 的上下左右轴）数量：stroke 为轴色且贴绘图区边的线段。
AXIS_LINES_JS = r"""
(chartId) => {
  const host = [...document.querySelectorAll('#svg-stage [data-fig-id]')]
    .find(g => g.getAttribute('data-fig-id') === chartId);
  if (!host) return null;
  return [...host.querySelectorAll('line')].map(l => ({
    x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'),
    x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2'),
    stroke: l.getAttribute('stroke'), sw: l.getAttribute('stroke-width')
  }));
}
"""

GRID_LINES_JS = r"""
(chartId) => {
  const host = [...document.querySelectorAll('#svg-stage [data-fig-id]')]
    .find(g => g.getAttribute('data-fig-id') === chartId);
  if (!host) return null;
  return [...host.querySelectorAll('line')].filter(l => {
    const s = l.getAttribute('stroke') || '';
    return /E0E0E0|e0e0e0|grid/i.test(s) ||
           (l.getAttribute('stroke-dasharray') || '').length > 0 &&
           /E0E0E0|e0e0e0/i.test(s);
  }).length;
}
"""

# 本类共享同一临时工程目录，前序用例提交的图表会留在文档里；
# 断言「恰好 N 张图」的用例先重置为空文档，保证计数确定。
RESET_DOC_JS = r"""
async () => {
  const dpi = (window.Settings && Settings.defaultDpi) ? Settings.defaultDpi() : 300;
  const doc = FigDoc.create({ width_mm: 120, height_mm: 90, dpi: dpi,
    background: '#FFFFFF', title: '', app: 'FigStudio Web v1', app_version: '1.0' });
  if (App.publishDoc) await App.publishDoc(doc, { reason: 'test-new' });
  else App.setDoc(doc, { reason: 'test-new' });
  if (App.clearSelection) App.clearSelection();
  return App.doc.elements.length;
}
"""


@unittest.skipUnless(HAS_PLAYWRIGHT,
                     "Python playwright + chromium/Chrome 不可用，跳过")
class ChartMarksUITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-marksui-data-")
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

    # ---------------------------------------------------------- helpers

    def open_page(self, vw=1280, vh=860):
        ctx = self.browser.new_context(viewport={"width": vw, "height": vh})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#panel-import button", timeout=20000)
        page.wait_for_timeout(1200)
        # 本类共享同一临时工程目录，App.commit 会自动保存工程；
        # 每个用例加载后先重置为空文档，避免前序用例的图表污染点选。
        page.evaluate(RESET_DOC_JS)
        page.wait_for_timeout(300)
        return page

    def add_scatter(self, page):
        cid = page.evaluate(ADD_SCATTER_JS)
        page.wait_for_selector("#svg-stage [data-point-key]", timeout=15000)
        page.wait_for_timeout(300)
        return cid

    def click_mark(self, page, idx):
        box = page.evaluate(MARK_CENTER_JS, idx)
        self.assertIsNotNone(box, "第 %d 个标记不存在" % idx)
        page.mouse.click(box["x"], box["y"])
        page.wait_for_timeout(250)
        return box["key"]

    def chart_part(self, page):
        return page.evaluate(CHART_PART_JS)

    def mark_snapshot(self, page):
        return page.evaluate(MARK_SNAPSHOT_JS)

    def set_mark_color(self, page, hexv):
        inp = page.locator(
            '[data-props-section="chart-mark"] input[type=color]')
        self.assertTrue(inp.count(), "缺少点选颜色输入")
        inp.evaluate(
            "(el,v)=>{el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}))}",
            hexv)
        page.wait_for_timeout(300)

    def set_mark_number(self, page, aria, value):
        inp = page.locator(
            '[data-props-section="chart-mark"] input[aria-label="%s"]' % aria)
        self.assertTrue(inp.count(), "缺少点选数值输入 aria=%s" % aria)
        inp.evaluate(
            "(el,v)=>{el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}))}",
            value)
        page.wait_for_timeout(300)

    # ------------------------------------------------------------ tests

    def test_point_select_and_panel(self):
        page = self.open_page()
        cid = self.add_scatter(page)
        key = self.click_mark(page, 0)
        cp = self.chart_part(page)
        self.assertIsNotNone(cp, "点击散点未设置 chartPart")
        self.assertEqual(cp["part"], "point")
        self.assertEqual(cp["chartId"], cid)
        self.assertEqual(cp["pointKey"], key)
        self.assertTrue(cp.get("seriesKey"), "缺少 seriesKey")
        snap = self.mark_snapshot(page)
        self.assertEqual(snap[key]["selected"], "1",
                         "选中节点未带 data-part-selected")
        panel = page.evaluate(MARK_PANEL_JS)
        self.assertTrue(panel["wrapVisible"], "未显示「选中的数据点」小节")
        self.assertTrue(panel["titleVisible"], "缺少小节标题")
        # 颜色初值 = 节点实际 fill
        node_fill = snap[key]["fill"]
        if node_fill and node_fill.startswith("#"):
            self.assertEqual(panel["color"].lower(), node_fill.lower(),
                             "颜色初值与节点 fill 不一致")
        self.assertIsNotNone(panel["color"])
        page.context.close()

    def test_point_color_change_undo(self):
        page = self.open_page()
        self.add_scatter(page)
        key = self.click_mark(page, 0)
        before = self.mark_snapshot(page)
        hist0 = page.evaluate(DOC_STATS_JS)["history"]
        self.set_mark_color(page, "#ff0000")
        after = self.mark_snapshot(page)
        # 仅该点 fill 变红，其余逐一不变
        for k, v in after.items():
            if k == key:
                self.assertIn("ff0000", (v["fill"] or "").lower(),
                              "目标点 fill 未变红: %r" % v["fill"])
            else:
                self.assertEqual(v["fill"], before[k]["fill"],
                                 "非目标点 fill 被改: %s" % k)
                self.assertEqual(v["r"], before[k]["r"],
                                 "非目标点半径被改: %s" % k)
        hist1 = page.evaluate(DOC_STATS_JS)["history"]
        self.assertEqual(hist1, hist0 + 1, "颜色修改未记一笔历史")
        # Ctrl+Z（焦点在画布）恢复
        page.evaluate("if(document.activeElement)document.activeElement.blur()")
        page.keyboard.press("Control+z")
        page.wait_for_timeout(400)
        restored = self.mark_snapshot(page)
        self.assertEqual(restored[key]["fill"], before[key]["fill"],
                         "Ctrl+Z 后目标点 fill 未恢复")
        page.context.close()

    def test_point_size_change(self):
        page = self.open_page()
        self.add_scatter(page)
        key = self.click_mark(page, 0)
        before = self.mark_snapshot(page)
        self.set_mark_number(page, "大小", "9")
        after = self.mark_snapshot(page)
        # 半径 = sizePt/2 × canvas.dpi/72（渲染 dpi 取自 doc.canvas.dpi）
        dpi = page.evaluate(
            "window.App && window.App.doc && window.App.doc.canvas"
            " ? (window.App.doc.canvas.dpi || 300) : 300")
        tgt = after[key]
        self.assertIsNotNone(tgt, "改大小后目标点消失")
        self.assertEqual(tgt["sizePt"], "9", "data-size-pt 未更新为 9")
        exp_r = 9 / 2 * dpi / 72
        got_r = float(tgt["r"])
        self.assertAlmostEqual(got_r, exp_r, delta=0.05,
                               msg="半径 %s != 期望 %s (dpi=%s)" % (got_r, exp_r, dpi))
        # 其余点半径不变
        for k, v in after.items():
            if k != key:
                self.assertEqual(v["r"], before[k]["r"], "非目标点半径被改: %s" % k)
        page.context.close()

    def test_series_scope_color(self):
        page = self.open_page()
        self.add_scatter(page)
        key = self.click_mark(page, 0)
        series = self.mark_snapshot(page)[key]["series"]
        # 切到「同系列全部」
        page.locator(
            '[data-props-section="chart-mark"] input[type=radio][value=series]'
        ).check()
        page.wait_for_timeout(300)
        before = self.mark_snapshot(page)
        self.set_mark_color(page, "#0000ff")
        after = self.mark_snapshot(page)
        same = [k for k, v in after.items() if v["series"] == series]
        other = [k for k, v in after.items() if v["series"] != series]
        self.assertGreater(len(same), 1, "同系列应有多个点")
        for k in same:
            self.assertIn("0000ff", (after[k]["fill"] or "").lower(),
                          "同系列点 %s 未变蓝" % k)
        for k in other:
            self.assertEqual(after[k]["fill"], before[k]["fill"],
                             "其他系列点 %s 被改" % k)
        page.context.close()

    def test_point_reset_default(self):
        page = self.open_page()
        self.add_scatter(page)
        key = self.click_mark(page, 0)
        before = self.mark_snapshot(page)
        self.set_mark_color(page, "#ff0000")
        mid = self.mark_snapshot(page)
        self.assertIn("ff0000", (mid[key]["fill"] or "").lower())
        # 「恢复默认」
        page.locator(
            '[data-props-section="chart-mark"] button', has_text="恢复默认"
        ).first.click()
        page.wait_for_timeout(300)
        after = self.mark_snapshot(page)
        self.assertEqual(after[key]["fill"], before[key]["fill"],
                         "恢复默认后 fill 未回到原值")
        page.context.close()

    def test_bar_select_and_color(self):
        page = self.open_page()
        cid = page.evaluate(ADD_BAR_JS)
        page.wait_for_selector("#svg-stage [data-point-key]", timeout=15000)
        page.wait_for_timeout(300)
        key = self.click_mark(page, 0)
        cp = self.chart_part(page)
        self.assertIsNotNone(cp)
        self.assertEqual(cp["part"], "bar")
        self.assertTrue(key.startswith("bar|"), "柱子键应以 bar| 开头: %s" % key)
        before = self.mark_snapshot(page)
        self.set_mark_color(page, "#00ff00")
        after = self.mark_snapshot(page)
        self.assertIn("00ff00", (after[key]["fill"] or "").lower(),
                      "目标柱 fill 未变绿")
        for k, v in after.items():
            if k != key:
                self.assertEqual(v["fill"], before[k]["fill"],
                                 "非目标柱 fill 被改: %s" % k)
        page.context.close()

    def test_legend_and_axis_tick_regression(self):
        page = self.open_page()
        cid = self.add_scatter(page)
        # 共享服务端文档会让 boot 时 Editor.fit 按上一用例的文档定缩放；
        # 重置后重新 fit，保证图例/刻度文字坐标不落在分栏条上（测试隔离）。
        page.evaluate("() => { if (window.Editor && Editor.fit) Editor.fit(); }")
        page.wait_for_timeout(300)
        # 图例文字 → 旧系列部件小节（回归）
        legend = page.evaluate(PART_TEXT_CENTER_JS, "legend")
        if legend:
            page.mouse.click(legend["x"], legend["y"])
            page.wait_for_timeout(300)
            cp = self.chart_part(page)
            self.assertIsNotNone(cp)
            self.assertNotEqual(cp.get("part"), "point",
                                "点图例不应进入 point 模式")
            title = page.evaluate(PART_TITLE_JS)
            self.assertIsNotNone(title, "部件小节标题缺失")
        # x 轴刻度文字 → 「X 轴刻度文字」小节
        tick = page.evaluate(PART_TEXT_CENTER_JS, "axis-tick-x")
        self.assertIsNotNone(tick, "缺少 axis-tick-x 文字")
        page.mouse.click(tick["x"], tick["y"])
        page.wait_for_timeout(300)
        cp = self.chart_part(page)
        self.assertIsNotNone(cp)
        self.assertEqual(cp.get("part"), "axis-tick-x")
        title = page.evaluate(PART_TITLE_JS)
        self.assertIn("刻度", title or "", "应进入刻度文字小节，实际: %r" % title)
        # 改字号 → 刻度 font-size 变化
        before_fs = page.evaluate(r"""
          () => {
            const host=[...document.querySelectorAll('#svg-stage [data-fig-id]')]
              .find(g=>g.getAttribute('data-fig-id')===%s);
            if(!host) return null;
            const t=[...host.querySelectorAll('text[data-chart-part="axis-tick-x"]')][0];
            return t?getComputedStyle(t).fontSize:null;
          }
        """ % json.dumps(cid))
        fsInp = page.locator(
            '[data-props-section="chart-part"] input[aria-label="字号"]')
        self.assertTrue(fsInp.count(), "缺少字号输入")
        fsInp.evaluate(
            "(el)=>{el.value='14';el.dispatchEvent(new Event('change',{bubbles:true}))}")
        # 部件小节的「应用」按钮（作用域限定在 chart-part 内，避免误点其他应用钮）
        page.locator('[data-props-section="chart-part"] button',
                     has_text="应用").first.click()
        page.wait_for_timeout(400)
        after_fs = page.evaluate(r"""
          () => {
            const host=[...document.querySelectorAll('#svg-stage [data-fig-id]')]
              .find(g=>g.getAttribute('data-fig-id')===%s);
            if(!host) return null;
            const t=[...host.querySelectorAll('text[data-chart-part="axis-tick-x"]')][0];
            return t?getComputedStyle(t).fontSize:null;
          }
        """ % json.dumps(cid))
        self.assertIsNotNone(after_fs)
        self.assertNotEqual(before_fs, after_fs,
                            "刻度字号未变化: %s -> %s" % (before_fs, after_fs))
        page.context.close()

    def test_chart_look_box_and_grid(self):
        page = self.open_page()
        cid = self.add_scatter(page)
        # 选中 chart 元素（点空白触发整图选中，chartPart 清空）
        page.evaluate(
            "window.App.select && window.App.select([%s])" % json.dumps(cid))
        page.wait_for_timeout(300)
        look = page.evaluate(LOOK_PANEL_JS)
        self.assertTrue(look["visible"], "未显示「图表外观」小节")
        # 边框改「四边方框」
        frameSel = page.locator(
            '[data-props-section="chart-look"] select[aria-label="边框样式"]')
        self.assertTrue(frameSel.count(), "缺少边框选择")
        frameSel.select_option("box")
        page.wait_for_timeout(400)
        lines = page.evaluate(AXIS_LINES_JS, cid) or []
        # 轴线：左右轴为竖线（x1==x2），上下轴为横线（y1==y2），且较长
        vlines = [l for l in lines if abs(l["x1"] - l["x2"]) < 0.01 and
                  abs(l["y1"] - l["y2"]) > 5]
        hlines = [l for l in lines if abs(l["y1"] - l["y2"]) < 0.01 and
                  abs(l["x1"] - l["x2"]) > 5]
        self.assertGreaterEqual(len(vlines), 2, "竖轴线不足 2 条: %s" % vlines)
        self.assertGreaterEqual(len(hlines), 2, "横轴线不足 2 条: %s" % hlines)
        # 勾网格线
        grid = page.locator(
            '[data-props-section="chart-look"] input[aria-label="网格线"]')
        self.assertTrue(grid.count(), "缺少网格线勾选")
        grid.check()
        page.wait_for_timeout(400)
        # 网格线出现：浅色虚线/细线
        has_grid = page.evaluate(r"""
          (chartId) => {
            const host=[...document.querySelectorAll('#svg-stage [data-fig-id]')]
              .find(g=>g.getAttribute('data-fig-id')===chartId);
            if(!host) return false;
            return [...host.querySelectorAll('line')].some(l=>{
              const s=(l.getAttribute('stroke')||'').toLowerCase();
              return s.includes('e0e0e0');
            });
          }
        """, cid)
        self.assertTrue(has_grid, "勾选网格线后未出现网格线")
        page.context.close()

    def test_wizard_create_chart_labels(self):
        page = self.open_page()
        # 打开导入向导 → sample.csv → 按推荐直接创建
        with page.expect_file_chooser() as fc_info:
            page.locator("#panel-import").get_by_role(
                "button", name="导入数据", exact=True).click()
        fc_info.value.set_files(str(SAMPLE_CSV))
        page.wait_for_selector(".dw-modal", timeout=20000)
        page.wait_for_timeout(400)
        btn = page.locator(".ui-modal-footer button").filter(
            has_text="创建图表")
        box = btn.bounding_box()
        self.assertIsNotNone(box, "缺少「创建图表」")
        page.mouse.click(box["x"] + box["width"] / 2,
                         box["y"] + box["height"] / 2)
        page.wait_for_timeout(1200)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        info = page.evaluate(r"""
          () => {
            const doc = window.App && window.App.doc;
            const ch = doc && (doc.elements||[]).find(e=>e.type==='chart');
            if(!ch) return null;
            const cv = doc.canvas||{};
            const host=[...document.querySelectorAll('#svg-stage [data-fig-id]')]
              .find(g=>g.getAttribute('data-fig-id')===ch.id);
            const texts = host ? [...host.querySelectorAll('text')]
              .map(t=>(t.textContent||'').trim()).filter(Boolean) : [];
            return { chartW: ch.transform && ch.transform.w,
                     canvasW: cv.width_mm,
                     map: ch.chart && ch.chart.mapping,
                     texts: texts };
          }
        """)
        self.assertIsNotNone(info, "向导未创建 chart")
        self.assertGreaterEqual(info["chartW"], info["canvasW"] * 0.8 - 0.01,
                                "chart 宽 %s < 画布 80%% (%s)" % (
                                    info["chartW"], info["canvasW"]))
        mapx = (info["map"] or {}).get("x")
        mapy = (info["map"] or {}).get("y")
        self.assertTrue(mapx and mapy, "缺少 x/y 映射")
        joined = " ".join(info["texts"])
        self.assertIn(mapx, joined, "图内缺 x 轴标题文字 %r" % mapx)
        self.assertIn(mapy, joined, "图内缺 y 轴标题文字 %r" % mapy)
        page.context.close()

    def test_hover_cursor_and_stroke(self):
        page = self.open_page()
        self.add_scatter(page)
        box = page.evaluate(MARK_CENTER_JS, 0)
        self.assertIsNotNone(box)
        page.mouse.move(box["x"], box["y"])
        page.wait_for_timeout(250)
        info = page.evaluate(r"""
          (pt) => {
            const n=document.elementFromPoint(pt.x, pt.y);
            if(!n) return null;
            // 向上找带 data-point-key 的标记
            let m=n;
            while(m && !(m.getAttribute && m.getAttribute('data-point-key'))) m=m.parentNode;
            if(!m) return null;
            const cs=getComputedStyle(m);
            return { cursor: cs.cursor, stroke: cs.stroke,
                     sw: cs.strokeWidth, tag: m.tagName };
          }
        """, box)
        self.assertIsNotNone(info, "悬停点未命中标记")
        self.assertEqual(info["cursor"], "pointer",
                         "悬停 cursor 应为 pointer: %s" % info["cursor"])
        self.assertNotEqual(info["stroke"], "none",
                            "悬停 stroke 不应为 none")
        page.context.close()

    # ------------------------------------------------ G21 复用数据 ----

    CHARTS_FULL_JS = r"""
() => {
  const d = window.App && window.App.doc;
  return ((d && d.elements) || []).filter(e => e && e.type === 'chart').map(c => ({
    id: c.id, el: JSON.parse(JSON.stringify(c)),
    inline: (c.chart && c.chart.data && c.chart.data.inline) ? {
      columns: c.chart.data.inline.columns.slice(),
      rows: c.chart.data.inline.rows
    } : null,
    source_info: (c.chart && c.chart.data) ? (c.chart.data.source_info || null) : null
  }));
}
"""
    HISTORY_LABELS_JS = ("() => (((window.App && window.App.doc && "
                         "window.App.doc.history) || []).map(h => h.label || ''))")
    HISTORY_NOTES_JS = ("() => (((window.App && window.App.doc && "
                        "window.App.doc.history) || []).map(h => {"
                        "var o=(h.ops||[]).filter(x=>x.op==='note').map(x=>x.note);"
                        "return o.join('|');}))")
    WIZ_TITLE_JS = ("() => { const m = document.querySelector('.dw-modal');"
                    " return m ? (m.querySelector('.ui-modal-title') ? "
                    "m.querySelector('.ui-modal-title').textContent : m.textContent) : null; }")

    def _import_sample_chart(self, page):
        """导入 sample.csv 并按推荐创建，返回 chart id。"""
        with page.expect_file_chooser() as fc_info:
            page.locator("#panel-import").get_by_role(
                "button", name="导入数据", exact=True).click()
        fc_info.value.set_files(str(SAMPLE_CSV))
        page.wait_for_selector(".dw-modal", timeout=20000)
        page.locator("[data-wizard-quick]").click()
        page.wait_for_selector(".dw-modal", state="detached", timeout=20000)
        page.wait_for_timeout(400)
        charts = page.evaluate(self.CHARTS_FULL_JS)
        self.assertTrue(charts, "应创建 chart")
        return charts[0]["id"]

    def test_19_reuse_chart_data_new_chart(self):
        """19：建图→选中→「用这份数据再建一张图」→ 向导标题正确、无「读取方式」、
        双击不编辑 → 换图型创建 → 两图 source_info/inline 深相等、原图不变、
        历史 +1 且 label 以「用已有数据新建图表」开头。"""
        page = self.open_page(1280, 860)
        cid = self._import_sample_chart(page)
        charts0 = page.evaluate(self.CHARTS_FULL_JS)
        self.assertEqual(len(charts0), 1)
        orig_el = charts0[0]["el"]
        orig_si = charts0[0]["source_info"]
        self.assertIsNotNone(orig_si, "导入图应有 source_info")
        # 选中该图表 → 属性面板出现「图表数据」分区与复用按钮
        page.evaluate("(id)=>{ if(App.select) App.select([id]); }", cid)
        page.wait_for_timeout(400)
        btn = page.locator('[data-props-reuse-data]')
        self.assertTrue(btn.count(), "缺少「用这份数据再建一张图」按钮")
        h0 = len(page.evaluate(self.HISTORY_LABELS_JS))
        btn.click()
        page.wait_for_selector(".dw-modal", timeout=20000)
        page.wait_for_timeout(400)
        title = page.evaluate(self.WIZ_TITLE_JS) or ""
        self.assertIn("用已有数据新建图表", title, "向导标题应为复用标题：%r" % title)
        # 无「读取方式」行
        self.assertEqual(page.locator("[data-wizard-parse]").count(), 0,
                         "复用模式不应有「读取方式」行")
        # 双击单元格不进入编辑（无 .dw-cell-input、无 tabindex 格）
        cell = page.locator('td[data-cell-row="0"]').first
        if cell.count():
            cell.dblclick()
            page.wait_for_timeout(300)
            self.assertEqual(page.locator(".dw-cell-input").count(), 0,
                             "复用模式双击不应进入编辑")
        # 选另一种图型：模板单选在第 2 步，先切过去再点第 2 个模板
        page.locator('.dw-steps [data-step-btn="2"]').click()
        page.wait_for_timeout(400)
        radios = page.locator('input[name="wizard-template"]')
        self.assertGreater(radios.count(), 1, "应有多个模板可选")
        radios.nth(1).check()
        page.wait_for_timeout(500)
        # R3 标签页：画布非空时默认「新建画布标签页」；本用例要两图同画布，
        # 显式选「放到当前画布」
        page.locator('.dw-steps [data-step-btn="3"]').click()
        page.wait_for_timeout(300)
        page.locator('input[name="wizard-place"]').nth(1).check()
        page.wait_for_timeout(200)
        # 到第 4 步创建
        page.locator('.dw-steps [data-step-btn="4"]').click()
        page.wait_for_timeout(300)
        cbtn = page.locator(".ui-modal-footer button").filter(has_text="创建图表")
        box = cbtn.bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2,
                         box["y"] + box["height"] / 2)
        page.wait_for_selector(".dw-modal", state="detached", timeout=20000)
        page.wait_for_timeout(400)
        charts1 = page.evaluate(self.CHARTS_FULL_JS)
        self.assertEqual(len(charts1), 2, "应有两张图表")
        # 两者 source_info / inline 深相等
        self.assertEqual(charts1[0]["source_info"], charts1[1]["source_info"])
        self.assertEqual(charts1[0]["inline"], charts1[1]["inline"])
        # 原图表元素深相等（未被改动）
        self.assertEqual(charts1[0]["el"], orig_el,
                         "原图表元素不应被修改")
        # 历史 +1 且 label 以「用已有数据新建图表」开头
        labels = page.evaluate(self.HISTORY_LABELS_JS)
        self.assertEqual(len(labels), h0 + 1, "必须恰好一条新历史")
        self.assertTrue(labels[-1].startswith("用已有数据新建图表"),
                        "历史 label 应以「用已有数据新建图表」开头：%r" % labels[-1])
        page.context.close()

    def test_19b_reuse_chart_without_source_info(self):
        """19b：原图表无 source_info → 再建图后新图也无 source_info；
        历史 note 以「用图表 」开头。"""
        page = self.open_page(1280, 860)
        # 直接 commit 一张带 inline 数据、无 source_info 的图表
        cid = page.evaluate(r"""
() => {
  const data = { columns: ['cat','val'], rows: [['A',10],['B',20],['C',15]] };
  const el = FigData.makeChartElement(data,
    { chart_type: 'bar', mapping: { x: 'cat', y: 'val' } });
  el.transform = { x: 5, y: 5, w: 110, h: 80, rotation: 0 };
  el.name = 'no-source-chart';
  const cid = el.id;
  App.commit([{ op: 'add_element', element: el }], { label: 'mk-nosrc', source: 'user' });
  return cid;
}
""")
        page.wait_for_timeout(300)
        page.evaluate("(id)=>{ if(App.select) App.select([id]); }", cid)
        page.wait_for_timeout(400)
        btn = page.locator('[data-props-reuse-data]')
        self.assertTrue(btn.count(), "无 source_info 的图表也应有复用按钮")
        btn.click()
        page.wait_for_selector(".dw-modal", timeout=20000)
        page.wait_for_timeout(400)
        # R3 标签页：默认新建标签页；本用例断言同画布两图，选「放到当前画布」
        page.locator('.dw-steps [data-step-btn="3"]').click()
        page.wait_for_timeout(300)
        page.locator('input[name="wizard-place"]').nth(1).check()
        page.wait_for_timeout(200)
        page.locator('.dw-steps [data-step-btn="4"]').click()
        page.wait_for_timeout(300)
        cbtn = page.locator(".ui-modal-footer button").filter(has_text="创建图表")
        box = cbtn.bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2,
                         box["y"] + box["height"] / 2)
        page.wait_for_selector(".dw-modal", state="detached", timeout=20000)
        page.wait_for_timeout(400)
        charts = page.evaluate(self.CHARTS_FULL_JS)
        self.assertEqual(len(charts), 2)
        # 新图（第 2 张）也不应有 source_info
        self.assertIsNone(charts[1]["source_info"],
                          "无 source_info 的图表复用后新图也不应有 source_info")
        # 历史 note 以「用图表 」开头
        notes = page.evaluate(self.HISTORY_NOTES_JS)
        joined = "\n".join(notes)
        self.assertIn("用图表 ", joined,
                      "历史 note 应含「用图表 」前缀：%r" % joined[-300:])
        page.context.close()


if __name__ == "__main__":
    unittest.main()
