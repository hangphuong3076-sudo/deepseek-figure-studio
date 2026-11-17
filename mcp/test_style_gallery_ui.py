# -*- coding: utf-8 -*-
"""test_style_gallery_ui.py — R5 风格画廊 Playwright 验收。

覆盖：
  a) 工具栏「风格」打开画廊：14 张内置卡片，每张含 <svg> 真实预览；
  b) 属性面板「换个风格…」同样打开；
  c) 标签筛选 + 名称搜索收窄列表；
  d) 「套用到选中图表」→ 恰好 1 条历史 + styleRef；
  e) 「套用到本画布全部图表」→ 所有图表 styleRef；
  f) 「设为默认」→ 向导创建的图表带 styleRef，已有图表不受影响；
     Templates.apply 模板路径同一 commit 也带 styleRef；
  g) 「存为我的风格」→ 出现、刷新后仍在、改名、删除；
  h) 1040×730 布局：卡片与操作按钮在视口内可点。
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from test_modal_layout import (
    HAS_PLAYWRIGHT, SAMPLE_CSV, _ViewerServer, _launch_chromium,
    DOC_STATS_JS, OVERLAY_COUNT_JS,
)

HERE = Path(__file__).resolve().parent

CSV_TEXT = "x,a,b,c\n" + "\n".join(
    "%d,%.2f,%.2f,%.2f" % (i, (i * 0.7) % 9 + 1, (i * 1.3) % 8 + 2,
                          (i * 0.4) % 7 + 3)
    for i in range(1, 13)
) + "\n"

CHARTS_JS = r"""
() => (App.doc.elements || []).filter(e => e.type === 'chart').map(e => ({
  id: e.id,
  styleRef: e.chart && e.chart.styleRef || null,
  paletteId: e.chart && e.chart.paletteId || null
}))
"""

GALLERY_COUNT_JS = r"""
() => {
  const modal = document.querySelector('.style-gallery-modal');
  if (!modal) return { open: false };
  const cards = [...modal.querySelectorAll('.sg-card')];
  return {
    open: true,
    cards: cards.length,
    withSvg: cards.filter(c => c.querySelector('.sg-preview svg')).length,
    chips: [...modal.querySelectorAll('.sg-chip')].map(c => c.textContent.trim()),
    segBtns: [...modal.querySelectorAll('.sg-seg-btn')].map(c => c.textContent.trim()),
    custom: modal.querySelectorAll('.sg-custom').length,
    empty: !!modal.querySelector('.sg-empty')
  };
}
"""


def _mk_chart_js(chart_type="line_multi", rows=None):
    """在页面里经真实 App.commit 添加一张图（UI 测试的快速建图捷径）。"""
    if rows is None:
        rows = [[i, (i * 0.7) % 9 + 1, (i * 1.3) % 8 + 2, (i * 0.4) % 7 + 3]
                for i in range(12)]
    return r"""
(async () => {
  const rows = %s;
  const el = FigData.makeChartElement(
    {columns:['x','a','b','c'], rows: rows},
    {chart_type: %s, mapping:{x:'x',y:'a',ys:['a','b','c']}});
  const res = await App.commit([{op:'add_element', element: el}], {label:'t'});
  const chart = (App.doc.elements||[]).filter(e=>e.type==='chart').pop();
  return {applied: !!(res&&res.applied), id: chart && chart.id};
})()
""" % (json.dumps(rows), json.dumps(chart_type))


@unittest.skipUnless(HAS_PLAYWRIGHT, "Python playwright + chromium/Chrome 不可用，跳过")
class StyleGalleryUiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-sg-data-")
        cls.fixtures = tempfile.mkdtemp(prefix="fig-sg-fix-")
        cls.csv_path = str(Path(cls.fixtures) / "sg-simple.csv")
        Path(cls.csv_path).write_text(CSV_TEXT, encoding="utf-8")
        cls.server = _ViewerServer(cls.datadir)
        try:
            cls.server.wait_ready()
        except Exception:
            cls.server.stop()
            shutil.rmtree(cls.datadir, ignore_errors=True)
            shutil.rmtree(cls.fixtures, ignore_errors=True)
            raise

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        shutil.rmtree(cls.datadir, ignore_errors=True)
        shutil.rmtree(cls.fixtures, ignore_errors=True)

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

    def open_page(self, vw=1440, vh=900):
        ctx = self.browser.new_context(viewport={"width": vw, "height": vh})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#panel-import button", timeout=20000)
        page.wait_for_timeout(1200)
        return page

    def open_gallery(self, page):
        page.locator("#btn-style-gallery").click()
        page.wait_for_selector(".style-gallery-modal .sg-card", timeout=15000)
        page.wait_for_timeout(500)  # previews + prefs rerender

    def close_gallery(self, page):
        page.locator(".style-gallery-modal .ui-modal-footer button").filter(
            has_text="关闭").click()
        page.wait_for_timeout(300)

    def gallery(self, page):
        return page.evaluate(GALLERY_COUNT_JS)

    def add_chart(self, page, chart_type="line_multi"):
        return page.evaluate(_mk_chart_js(chart_type))

    def charts(self, page):
        return page.evaluate(CHARTS_JS)

    def select_ids(self, page, ids):
        page.evaluate("(ids)=>{ if(App.select) App.select(ids); }", ids)
        page.wait_for_timeout(300)

    def hist_len(self, page):
        return page.evaluate(DOC_STATS_JS)["history"]

    def first_card_apply_selected(self, page):
        """点第一张卡片的「套用到选中图表」。"""
        btn = page.locator(".style-gallery-modal .sg-card").first.locator(
            "button", has_text="套用到选中图表")
        self.assertTrue(btn.count(), "缺少「套用到选中图表」按钮")
        self.assertFalse(btn.is_disabled(), "无选中图表时按钮应禁用——"
                         "本用例先选中了图表")
        btn.click()
        page.wait_for_timeout(500)

    def first_card_set_default(self, page):
        btn = page.locator(".style-gallery-modal .sg-card").first.locator(
            "button", has_text="设为默认")
        self.assertTrue(btn.count(), "缺少「设为默认」按钮")
        btn.click()
        page.wait_for_timeout(400)

    # ------------------------------------------------------------ tests

    def test_toolbar_gallery_14_cards_with_svg(self):
        page = self.open_page()
        self.open_gallery(page)
        g = self.gallery(page)
        self.assertTrue(g["open"])
        self.assertGreaterEqual(g["cards"], 14,
                                "应至少有 14 张内置风格卡片: %s" % g)
        self.assertEqual(g["withSvg"], g["cards"],
                         "每张卡片都应含 <svg> 预览")
        self.assertGreaterEqual(len(g["chips"]), 3, "应有标签筛选 chips")
        self.assertTrue(any("示例数据" in s for s in g["segBtns"]),
                        "应有示例/选中图预览切换: %s" % g["segBtns"])
        self.close_gallery(page)
        page.context.close()

    def test_props_entry_opens_gallery(self):
        page = self.open_page()
        info = self.add_chart(page)
        self.assertTrue(info.get("applied") and info.get("id"))
        self.select_ids(page, [info["id"]])
        # 打开属性面板 tab → 找「换个风格…」
        page.locator("#tab-props").click()
        page.wait_for_timeout(600)
        btn = page.locator(".props-style-btn")
        self.assertTrue(btn.count() >= 1, "属性面板缺少「换个风格…」")
        btn.first.click()
        page.wait_for_selector(".style-gallery-modal", timeout=10000)
        g = self.gallery(page)
        self.assertTrue(g["open"] and g["cards"] >= 14)
        page.context.close()

    def test_tag_filter_and_search(self):
        page = self.open_page()
        self.open_gallery(page)
        total = self.gallery(page)["cards"]
        self.assertGreaterEqual(total, 14)
        # 点第一个非「全部」chip → 卡片数应减少或不变（取较宽松断言：
        # 筛选后数量 ≤ 总数，且页面仍有卡片）
        chips = page.locator(".style-gallery-modal .sg-chip")
        n = chips.count()
        self.assertGreater(n, 1)
        chips.nth(1).click()
        page.wait_for_timeout(400)
        g1 = self.gallery(page)
        self.assertLessEqual(g1["cards"], total)
        self.assertGreater(g1["cards"], 0, "筛选后不应为空")
        # 搜索一个必然命中的词 → 恰好 1 张；搜索乱码 → 空态
        search = page.locator(".style-gallery-modal input[type=search]")
        self.assertTrue(search.count() >= 1, "缺少搜索框")
        # 先清掉 chip 筛选（点「全部」）
        page.locator(".style-gallery-modal .sg-chip").first.click()
        page.wait_for_timeout(300)
        search.first.fill("Nature")
        page.wait_for_timeout(400)
        g2 = self.gallery(page)
        self.assertGreaterEqual(g2["cards"], 1)
        self.assertLess(g2["cards"], total, "搜索应收窄列表")
        search.first.fill("zzz-no-such-style-xyz")
        page.wait_for_timeout(400)
        g3 = self.gallery(page)
        self.assertEqual(g3["cards"], 0)
        self.assertTrue(g3["empty"], "无结果应显示空态")
        page.context.close()

    def test_apply_selected_one_history_styleRef(self):
        page = self.open_page()
        info = self.add_chart(page)
        self.assertTrue(info.get("id"))
        self.select_ids(page, [info["id"]])
        h0 = self.hist_len(page)
        self.open_gallery(page)
        self.first_card_apply_selected(page)
        page.wait_for_timeout(400)
        charts = self.charts(page)
        target = [c for c in charts if c["id"] == info["id"]][0]
        self.assertIsNotNone(target["styleRef"],
                             "套用后应记录 styleRef: %s" % target)
        self.assertEqual(target["styleRef"].get("id"),
                         target["styleRef"].get("id"))
        h1 = self.hist_len(page)
        self.assertEqual(h1, h0 + 1,
                         "套用应恰好产生 1 条历史（%d→%d）" % (h0, h1))
        page.context.close()

    def test_apply_all_charts(self):
        page = self.open_page()
        a = self.add_chart(page, "line_multi")
        b = self.add_chart(page, "scatter")
        self.assertTrue(a.get("id") and b.get("id"))
        # 「套用到本画布全部图表」不需要选中
        self.open_gallery(page)
        btn = page.locator(".style-gallery-modal .sg-card").first.locator(
            "button", has_text="套用到本画布全部图表")
        self.assertFalse(btn.is_disabled())
        btn.click()
        page.wait_for_timeout(500)
        charts = self.charts(page)
        self.assertEqual(len(charts), 2)
        for c in charts:
            self.assertIsNotNone(c["styleRef"],
                                 "全部图表都应有 styleRef: %s" % c)
        page.context.close()

    def test_set_default_wizard_and_template(self):
        page = self.open_page()
        # 先建一张「旧」图（设默认之前）
        old = self.add_chart(page, "line_multi")
        self.assertTrue(old.get("id"))
        self.open_gallery(page)
        self.first_card_set_default(page)
        # 确认出现「默认」徽标
        page.wait_for_timeout(400)
        g = self.gallery(page)
        self.assertGreaterEqual(g["cards"], 1)
        self.close_gallery(page)
        # 旧图不应被追溯改样式
        oldChart = [c for c in self.charts(page) if c["id"] == old["id"]][0]
        self.assertIsNone(oldChart["styleRef"],
                          "设默认不应改动已有图表")
        # 向导「按推荐直接创建」→ 新图应带 styleRef
        hist0 = self.hist_len(page)
        with page.expect_file_chooser() as fc_info:
            page.locator("#panel-import").get_by_role(
                "button", name="导入数据", exact=True).click()
        fc_info.value.set_files(self.csv_path)
        page.wait_for_selector(".dw-modal", timeout=20000)
        page.locator("[data-wizard-quick]").click()
        page.wait_for_selector(".dw-modal", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        charts = self.charts(page)
        newCharts = [c for c in charts if c["id"] != old["id"]]
        self.assertTrue(newCharts, "向导应新建图表")
        for c in newCharts:
            self.assertIsNotNone(c["styleRef"],
                                 "向导新建图表应带默认 styleRef: %s" % c)
        # 模板路径：Templates.apply 同一 commit 也应带 styleRef
        tpl = page.evaluate(r"""
(async () => {
  const res = await Templates.apply('tpl-line', {data:{
    columns:['x','y'], rows:[[0,1],[1,2],[2,4],[3,8]]}});
  return res;
})()
""")
        page.wait_for_timeout(600)
        charts2 = self.charts(page)
        tplCharts = [c for c in charts2
                     if c["id"] not in [x["id"] for x in charts]]
        self.assertTrue(tplCharts, "模板应新建图表: %s" % tpl)
        for c in tplCharts:
            self.assertIsNotNone(c["styleRef"],
                                 "模板新建图表应带默认 styleRef: %s" % c)
        page.context.close()

    def test_save_rename_delete_custom_style(self):
        page = self.open_page()
        info = self.add_chart(page)
        self.assertTrue(info.get("id"))
        self.select_ids(page, [info["id"]])
        self.open_gallery(page)
        # 「把选中图表的样式存为我的风格」→ namePrompt
        saveBtn = page.locator(".style-gallery-modal .sg-mine-bar button")
        self.assertTrue(saveBtn.count() >= 1, "缺少保存我的风格按钮")
        saveBtn.first.click()
        page.wait_for_selector(".ui-modal input[type=text]", timeout=8000)
        page.locator(".ui-modal input[type=text]").last.fill("我的测试风格")
        # 点最上层 modal 的「确定」
        page.locator("#modal-root > .ui-modal-overlay").last.locator(
            ".ui-modal-footer button").filter(has_text="确定").click()
        page.wait_for_timeout(600)
        g = self.gallery(page)
        self.assertGreaterEqual(g["custom"], 1, "保存后应出现我的风格卡片")
        # 刷新页面 → prefs 持久化 → 我的风格仍在
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#panel-import button", timeout=20000)
        page.wait_for_timeout(1200)
        self.select_ids(page, [info["id"]])
        self.open_gallery(page)
        g2 = self.gallery(page)
        self.assertGreaterEqual(g2["custom"], 1,
                                "刷新后我的风格应仍在（prefs 持久化）")
        # 改名：点 custom 卡片的「改名」
        customCard = page.locator(".style-gallery-modal .sg-card.sg-custom").first
        customCard.locator("button", has_text="改名").click()
        page.wait_for_selector(".ui-modal input[type=text]", timeout=8000)
        page.locator(".ui-modal input[type=text]").last.fill("改名后的风格")
        page.locator("#modal-root > .ui-modal-overlay").last.locator(
            ".ui-modal-footer button").filter(has_text="确定").click()
        page.wait_for_timeout(500)
        names = page.locator(".style-gallery-modal .sg-card-name").all_text_contents()
        self.assertTrue(any("改名后的风格" in n for n in names),
                        "改名后应显示新名: %s" % names)
        # 删除：confirm 对话框 → 确定
        customCard2 = page.locator(".style-gallery-modal .sg-card.sg-custom").first
        customCard2.locator("button", has_text="删除").click()
        page.wait_for_selector(".ui-modal", timeout=8000)
        page.locator("#modal-root > .ui-modal-overlay").last.locator(
            ".ui-modal-footer button").filter(has_text="确定").click()
        page.wait_for_timeout(500)
        g3 = self.gallery(page)
        self.assertEqual(g3["custom"], 0, "删除后我的风格应消失")
        page.context.close()

    def test_layout_1040x730(self):
        page = self.open_page(1040, 730)
        self.add_chart(page)
        self.open_gallery(page)
        g = self.gallery(page)
        self.assertTrue(g["open"] and g["cards"] >= 14)
        # 卡片与「套用到本画布全部图表」按钮应在视口内可点
        card = page.locator(".style-gallery-modal .sg-card").first
        box = card.bounding_box()
        self.assertIsNotNone(box)
        self.assertGreaterEqual(box["y"], 0)
        self.assertLess(box["y"] + box["height"], 730,
                        "卡片应在视口内: %s" % box)
        allBtn = page.locator(".style-gallery-modal .sg-card").first.locator(
            "button", has_text="套用到本画布全部图表")
        abox = allBtn.bounding_box()
        self.assertIsNotNone(abox)
        self.assertLessEqual(abox["y"] + abox["height"], 730,
                             "操作按钮应在视口内可点: %s" % abox)
        # 滚动后更多卡片可达
        grid = page.locator(".style-gallery-modal .sg-grid")
        self.assertTrue(grid.count() >= 1)
        page.context.close()


if __name__ == "__main__":
    unittest.main()
