# -*- coding: utf-8 -*-
"""test_tabs_ui.py — 多画布标签页 Playwright 验收（R3 #5）。

每个用例独立 viewer + 临时 FIGURE_DATA_DIR，互不依赖。
覆盖：
  1) 空画布导入无「放置到」选项；有内容画布导入默认「新建画布标签页（推荐）」；
     新标签成为活动、图表一笔历史；切回原标签图表完好、撤销栈互相独立；
  2) 关闭标签 → 文件归档 tabs/closed/；刷新页面标签与活动位恢复；
  3) 待执行 AI 方案在切换时作废（本地说明含「作废」）；
  4) 工具栏「新建」打开空标签页（无破坏性确认）。

需要 Python playwright + 可用浏览器；不可用时整体 skip。
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from test_modal_layout import (
    HAS_PLAYWRIGHT, SAMPLE_CSV, _ViewerServer, _launch_chromium,
)

HERE = Path(__file__).resolve().parent

DOC_ID_JS = "() => App.doc && App.doc.id"
DOC_STATE_JS = r"""
() => {
  const d = App.doc || {};
  return { id: d.id, n: (d.elements || []).length,
           hist: (d.history || []).length,
           title: d.title || '' };
}
"""
HIST_JS = "() => (App.doc.history || []).length"
TABS_STATE_JS = r"""
async () => {
  const j = await (await fetch('/api/tabs', {cache: 'no-store'})).json();
  return { active: j.active_id,
           ids: (j.tabs || []).map(t => t.id),
           titles: (j.tabs || []).map(t => t.title || '') };
}
"""
TAB_COUNT_JS = "() => document.querySelectorAll('#tab-bar .tab-wrap').length"
ACTIVE_TAB_LABEL_JS = ("() => { const n = document.querySelector("
                       "'#tab-bar .tab-wrap.active .tab-label');"
                       " return n ? n.textContent : null; }")
PLACE_RADIOS_JS = ("() => [...document.querySelectorAll("
                   "'input[name=\"wizard-place\"]')].map(r => ({"
                   "checked: r.checked}))")
CHAT_TEXTS_JS = ("() => (window.AiPanel && AiPanel.chatMessages ? "
                 "AiPanel.chatMessages() : []).map(m => m.text || '')")
PENDING_WORK_JS = ("() => !!(window.AiPanel && AiPanel.hasPendingWork && "
                   "AiPanel.hasPendingWork())")
ADD_RECT_JS = r"""
() => {
  const id = 'tb-rect-' + Date.now();
  App.commit([{ op: 'add_element', element: {
    id: id, type: 'rect', name: 'r',
    transform: { x: 10, y: 10, w: 20, h: 15, rotation: 0 },
    style: { fill: '#ddeeff', stroke: '#3366cc', strokeWidthPt: 0.75 } } }],
    { label: 'add-rect', source: 'user' });
  return id;
}
"""
SET_PENDING_JS = r"""
(id) => {
  AiPanel.__setPendingForTest([{ op: 'move', targets: [id], dx: 1, dy: 1 }]);
  return AiPanel.hasPendingWork();
}
"""
FLUSH_JS = "() => (window.ViewerBoot && ViewerBoot.flush ? ViewerBoot.flush() : Promise.resolve())"
SELECTION_JS = "() => (App.selection ? App.selection() : [])"
SELECT_JS = "(id) => { if (App.select) App.select([id]); }"


@unittest.skipUnless(HAS_PLAYWRIGHT,
                     "Python playwright + chromium/Chrome 不可用，跳过")
class TabsUITest(unittest.TestCase):
    """每个用例独立数据目录与 viewer 进程。"""

    def setUp(self):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        self.datadir = tempfile.mkdtemp(prefix="fig-tabsui-data-")
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

    # ---------------------------------------------------------- helpers

    def open_page(self, vw=1440, vh=900):
        ctx = self.browser.new_context(viewport={"width": vw, "height": vh})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#panel-import button", timeout=20000)
        page.wait_for_selector("#tab-new", timeout=15000)
        page.wait_for_timeout(400)
        return page

    def open_wizard(self, page):
        with page.expect_file_chooser() as fc_info:
            page.locator("#panel-import").get_by_role(
                "button", name="导入数据", exact=True).click()
        fc_info.value.set_files(str(SAMPLE_CSV))
        page.wait_for_selector(".dw-modal", timeout=20000)
        page.wait_for_timeout(300)

    def goto_step(self, page, n):
        page.locator('.dw-steps [data-step-btn="%d"]' % n).click()
        page.wait_for_timeout(300)

    def create_via_footer(self, page):
        btn = page.locator(".ui-modal-footer button").filter(
            has_text="创建图表")
        box = btn.bounding_box()
        self.assertIsNotNone(box, "footer 缺少「创建图表」")
        page.mouse.click(box["x"] + box["width"] / 2,
                         box["y"] + box["height"] / 2)

    def wait_doc_id(self, page, want, timeout=15000):
        page.wait_for_function(
            "() => App.doc && App.doc.id === %s" % json.dumps(want),
            timeout=timeout)

    # ---------------------------------------------------------- 用例

    def test_import_defaults_to_new_tab_and_independent_undo(self):
        page = self.open_page()
        try:
            # ---- 第一次导入：空画布 → 无「放置到」选项，进当前标签 ----
            self.open_wizard(page)
            self.goto_step(page, 3)
            self.assertEqual(
                page.evaluate(PLACE_RADIOS_JS), [],
                "空画布不应出现放置位置选项")
            self.goto_step(page, 4)
            self.create_via_footer(page)
            page.wait_for_function(
                "() => !document.querySelector('.dw-modal')",
                timeout=20000)
            # autosave 800ms 防抖 + tabs 刷新重试：等首个标签出现
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            id1 = page.evaluate(DOC_ID_JS)
            self.assertTrue(id1)
            n1 = page.evaluate(DOC_STATE_JS)
            self.assertGreaterEqual(n1["n"], 1, "首个标签应有导入的图表")
            self.assertEqual(page.evaluate(TAB_COUNT_JS), 1)

            # ---- 第二次导入：有内容 → 默认「新建画布标签页（推荐）」----
            self.open_wizard(page)
            self.goto_step(page, 3)
            radios = page.evaluate(PLACE_RADIOS_JS)
            self.assertEqual(len(radios), 2, "应有两个放置位置选项")
            self.assertTrue(radios[0]["checked"],
                            "默认应选中「新建画布标签页（推荐）」")
            self.assertFalse(radios[1]["checked"])
            self.goto_step(page, 4)
            self.create_via_footer(page)
            page.wait_for_function(
                "() => !document.querySelector('.dw-modal')",
                timeout=20000)
            # 新标签成为活动：等第二个 tab-wrap 出现且 doc id 变化
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 2", timeout=15000)
            page.wait_for_function(
                "() => App.doc && App.doc.id !== %s" % json.dumps(id1),
                timeout=15000)
            id2 = page.evaluate(DOC_ID_JS)
            st2 = page.evaluate(DOC_STATE_JS)
            self.assertNotEqual(id2, id1)
            self.assertGreaterEqual(st2["n"], 1, "新标签应有导入的图表")
            self.assertEqual(st2["hist"], 1,
                             "新标签图表应为恰好一笔历史")
            tabs = page.evaluate(TABS_STATE_JS)
            self.assertEqual(tabs["active"], id2)
            self.assertEqual(sorted(tabs["ids"]), sorted([id1, id2]))
            # 新标签标题 = 导入文件名去扩展名（sample.csv → sample）
            tidx = tabs["ids"].index(id2)
            self.assertEqual(tabs["titles"][tidx], "sample",
                             "新标签标题应为文件名去扩展名")

            # ---- 切回第一个标签：原图完好 ----
            page.locator("#tab-bar .tab-wrap .tab-item").first.click()
            self.wait_doc_id(page, id1)
            st1 = page.evaluate(DOC_STATE_JS)
            self.assertGreaterEqual(st1["n"], 1)
            self.assertEqual(st1["hist"], 1)

            # ---- 撤销栈独立：tab1 加一个矩形（hist=2）→ tab2 仍 hist=1 ----
            page.evaluate(ADD_RECT_JS)
            page.wait_for_function("() => (App.doc.history || []).length === 2",
                                   timeout=10000)
            page.locator("#tab-bar .tab-wrap .tab-item").nth(1).click()
            self.wait_doc_id(page, id2)
            self.assertEqual(page.evaluate(HIST_JS), 1,
                             "tab2 历史不应被 tab1 的提交影响")
            page.locator("#tab-bar .tab-wrap .tab-item").first.click()
            self.wait_doc_id(page, id1)
            self.assertEqual(page.evaluate(HIST_JS), 2,
                             "tab1 自己的历史应保留")
        finally:
            page.context.close()

    def test_close_tab_archives_and_reload_restores(self):
        page = self.open_page()
        try:
            # 先造一个已保存标签（空服务器初始 tabs 为空）
            page.evaluate(ADD_RECT_JS)
            page.evaluate(FLUSH_JS)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            page.wait_for_timeout(300)
            # 再开第二个空标签
            page.locator("#tab-new").click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 2", timeout=15000)
            page.wait_for_timeout(500)
            tabs_before = page.evaluate(TABS_STATE_JS)
            self.assertEqual(len(tabs_before["ids"]), 2)
            id_active = tabs_before["active"]
            id_other = [i for i in tabs_before["ids"]
                        if i != id_active][0]

            # 关闭非活动标签
            # 找到非活动 wrap（带 .active 类的是活动标签）并点它的 ×
            non_active = page.locator(
                "#tab-bar .tab-wrap:not(.active) .tab-close")
            non_active.click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            page.wait_for_timeout(400)

            # 归档文件落盘
            closed_dir = Path(self.datadir) / "projects" / "tabs" / "closed"
            archived = list(closed_dir.glob(id_other + "-*.figureproj.json"))
            self.assertTrue(archived,
                            "关闭的标签应归档到 tabs/closed/")
            # /api/tabs 不再列出它
            tabs_after = page.evaluate(TABS_STATE_JS)
            self.assertNotIn(id_other, tabs_after["ids"])
            self.assertEqual(tabs_after["active"], id_active)

            # ---- reload：标签与活动位恢复 ----
            page.evaluate(FLUSH_JS)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#panel-import button", timeout=20000)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            page.wait_for_timeout(400)
            tabs_reload = page.evaluate(TABS_STATE_JS)
            self.assertEqual(tabs_reload["ids"], [id_active])
            self.assertEqual(tabs_reload["active"], id_active)
            self.assertEqual(page.evaluate(DOC_ID_JS), id_active)
        finally:
            page.context.close()

    def test_pending_ai_plan_voided_on_switch(self):
        page = self.open_page()
        try:
            # 先造一个已保存标签（空服务器初始 tabs 为空）
            page.evaluate(ADD_RECT_JS)
            page.evaluate(FLUSH_JS)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            page.wait_for_timeout(300)
            page.locator("#tab-new").click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 2", timeout=15000)
            page.wait_for_timeout(500)
            id1 = page.evaluate(DOC_ID_JS)  # 新标签是活动的；先切回第一个
            page.locator("#tab-bar .tab-wrap .tab-item").first.click()
            page.wait_for_function(
                "() => App.doc && App.doc.id !== %s" % json.dumps(id1),
                timeout=15000)
            first_id = page.evaluate(DOC_ID_JS)
            second_id = id1
            rect_id = page.evaluate(ADD_RECT_JS)
            page.wait_for_timeout(300)

            # 在第一个标签注入待执行方案（move 作用于真实元素）
            self.assertTrue(page.evaluate(SET_PENDING_JS, rect_id))
            self.assertTrue(page.evaluate(PENDING_WORK_JS))

            # 切到第二个标签 → 方案作废
            page.locator("#tab-bar .tab-wrap .tab-item").nth(1).click()
            self.wait_doc_id(page, second_id)
            page.wait_for_timeout(400)
            self.assertFalse(page.evaluate(PENDING_WORK_JS),
                             "切换后待执行方案应被作废")
            texts = page.evaluate(CHAT_TEXTS_JS)
            joined = "\n".join(texts)
            self.assertIn("作废", joined,
                          "应有本地说明「上一份未执行的方案已作废」")
            self.assertIn("已切换到画布", joined)
        finally:
            page.context.close()

    def test_close_inactive_keeps_selection_and_pending(self):
        """关非活动标签：不切画布 → 选择与待执行 AI 方案必须保留。"""
        page = self.open_page()
        try:
            rect_id = page.evaluate(ADD_RECT_JS)
            page.evaluate(FLUSH_JS)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            id1 = page.evaluate(DOC_ID_JS)
            page.wait_for_timeout(300)
            # 开第二个空标签（活动），再切回第一个
            page.locator("#tab-new").click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 2", timeout=15000)
            page.wait_for_timeout(400)
            page.locator("#tab-bar .tab-wrap .tab-item").first.click()
            self.wait_doc_id(page, id1)
            page.wait_for_timeout(300)
            # 切回之后再选中元素 + 注入待执行方案（切换本身会清空两者）
            page.evaluate(SELECT_JS, rect_id)
            page.wait_for_timeout(200)
            self.assertTrue(page.evaluate(SET_PENDING_JS, rect_id))
            # 关闭非活动标签（第二个 wrap 的 ×）
            page.locator(
                "#tab-bar .tab-wrap:not(.active) .tab-close").click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            page.wait_for_timeout(400)
            # 画布未变：doc id、选择、待执行方案全部保留
            self.assertEqual(page.evaluate(DOC_ID_JS), id1)
            self.assertIn(rect_id, page.evaluate(SELECTION_JS),
                          "关非活动标签不应清掉选择")
            self.assertTrue(page.evaluate(PENDING_WORK_JS),
                            "关非活动标签不应作废待执行方案")
            texts = page.evaluate(CHAT_TEXTS_JS)
            self.assertFalse(any("作废" in (m or "") for m in texts),
                             "不应出现方案作废说明")
        finally:
            page.context.close()

    def test_empty_tab_titles_numbered(self):
        """空标签按最小未用序号命名：画布 1 / 画布 2。"""
        page = self.open_page()
        try:
            page.evaluate(ADD_RECT_JS)
            page.evaluate(FLUSH_JS)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            page.locator("#tab-new").click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 2", timeout=15000)
            page.wait_for_timeout(300)
            page.locator("#tab-new").click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 3", timeout=15000)
            page.wait_for_timeout(400)
            tabs = page.evaluate(TABS_STATE_JS)
            self.assertCountEqual(
                tabs["titles"], ["未命名图", "画布 1", "画布 2"],
                "空标签应按最小未用序号命名：%r" % tabs["titles"])
        finally:
            page.context.close()

    def test_new_button_opens_empty_tab(self):
        page = self.open_page()
        try:
            # 当前标签放一个元素，证明「新建」不替换它
            page.evaluate(ADD_RECT_JS)
            page.evaluate(FLUSH_JS)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            before = page.evaluate(DOC_STATE_JS)
            self.assertEqual(before["n"], 1)
            id1 = before["id"]

            page.locator("#btn-new").click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 2", timeout=15000)
            page.wait_for_function(
                "() => App.doc && App.doc.elements.length === 0",
                timeout=15000)
            page.wait_for_timeout(400)
            after = page.evaluate(DOC_STATE_JS)
            self.assertNotEqual(after["id"], id1)
            self.assertEqual(after["n"], 0, "新标签应为空画布")
            self.assertEqual(after["hist"], 0)
            # 无破坏性确认框残留
            self.assertEqual(
                page.evaluate(
                    "() => document.querySelectorAll("
                    "'#modal-root > .ui-modal-overlay').length"), 0)
            # 切回 → 原元素还在
            page.locator("#tab-bar .tab-wrap .tab-item").first.click()
            self.wait_doc_id(page, id1)
            self.assertEqual(page.evaluate(DOC_STATE_JS)["n"], 1)
        finally:
            page.context.close()

    def test_rename_tab_doubleclick_persist_and_undo(self):
        """双击标签 → 内联输入 → Enter 提交 set_doc_title；
        刷新后标题仍在；Esc 取消；Ctrl+Z 恢复原标题。"""
        page = self.open_page()
        try:
            page.evaluate(ADD_RECT_JS)
            page.evaluate(FLUSH_JS)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            old_title = page.evaluate(DOC_STATE_JS)["title"]
            # 双击活动标签 → 出现内联输入框
            page.locator("#tab-bar .tab-item").first.dblclick()
            inp = page.locator("#tab-bar .tab-rename")
            inp.wait_for(state="visible", timeout=5000)
            inp.fill("我的画布")
            inp.press("Enter")
            page.wait_for_timeout(500)
            self.assertEqual(page.evaluate(DOC_STATE_JS)["title"], "我的画布")
            self.assertEqual(page.evaluate(ACTIVE_TAB_LABEL_JS), "我的画布")
            self.assertFalse(page.locator("#tab-bar .tab-rename").count(),
                             "提交后输入框应关闭")
            # 落盘后刷新 → 标题持久
            page.evaluate(FLUSH_JS)
            page.wait_for_timeout(600)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#tab-new", timeout=15000)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            self.assertEqual(page.evaluate(DOC_STATE_JS)["title"], "我的画布")
            # Esc 取消：双击 → 输入 → Escape → 标题不变
            page.locator("#tab-bar .tab-item").first.dblclick()
            inp2 = page.locator("#tab-bar .tab-rename")
            inp2.wait_for(state="visible", timeout=5000)
            inp2.fill("不应生效")
            inp2.press("Escape")
            page.wait_for_timeout(400)
            self.assertEqual(page.evaluate(DOC_STATE_JS)["title"], "我的画布")
            self.assertFalse(page.locator("#tab-bar .tab-rename").count())
            # Ctrl+Z → 撤销最近一笔（set_doc_title 改名）→ 恢复原标题
            page.keyboard.press("Control+z")
            page.wait_for_timeout(500)
            self.assertEqual(page.evaluate(DOC_STATE_JS)["title"], old_title,
                             "Ctrl+Z 应撤销 set_doc_title")
        finally:
            page.context.close()

    def test_closed_popup_restore(self):
        """关闭非活动标签 → 「已关闭」弹出列表 → 点击还原 → 内容完好。"""
        page = self.open_page()
        try:
            page.evaluate(ADD_RECT_JS)
            page.evaluate(FLUSH_JS)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            id1 = page.evaluate(DOC_ID_JS)
            # 第二个标签里放一个矩形（还原后要能验内容）
            page.locator("#tab-new").click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 2", timeout=15000)
            page.wait_for_timeout(400)
            id2 = page.evaluate(DOC_ID_JS)
            page.evaluate(ADD_RECT_JS)
            page.evaluate(FLUSH_JS)
            page.wait_for_timeout(400)
            # 切回第一个标签
            page.locator("#tab-bar .tab-wrap .tab-item").first.click()
            self.wait_doc_id(page, id1)
            page.wait_for_timeout(300)
            # 关闭非活动标签（第二个 wrap 的 ×）
            page.locator(
                "#tab-bar .tab-wrap:not(.active) .tab-close").click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            page.wait_for_timeout(500)
            # 「已关闭」按钮应可用（refreshClosed 已填充列表）
            page.wait_for_function(
                "() => { const b = document.getElementById('tab-closed');"
                " return b && !b.disabled; }", timeout=10000)
            page.locator("#tab-closed").click()
            page.wait_for_selector(".tab-closed-pop .tab-closed-item",
                                   timeout=10000)
            # 弹出项显示标题与元素数
            item_text = page.locator(
                ".tab-closed-pop .tab-closed-item").first.text_content()
            self.assertIn("1 个元素", item_text or "")
            # 点击还原 → 第二个标签回到活动，内容完好
            page.locator(".tab-closed-pop .tab-closed-item").first.click()
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 2", timeout=15000)
            self.wait_doc_id(page, id2)
            page.wait_for_timeout(400)
            st = page.evaluate(DOC_STATE_JS)
            self.assertGreaterEqual(st["n"], 1, "还原的标签应保留矩形元素")
            # 弹出层已关闭；closed 列表空 → 按钮重新禁用
            self.assertFalse(page.locator(".tab-closed-pop").count())
            page.wait_for_function(
                "() => { const b = document.getElementById('tab-closed');"
                " return b && b.disabled; }", timeout=10000)
        finally:
            page.context.close()

    # R4-HB2 复审：导入新标签时图表必须落在新画布内（画布尺寸来自
    # effectiveCanvas，与排版所用画布一致；回归防「按旧画布排版」）。
    SEED_BIG_CANVAS_JS = r"""
    () => {
      App.commit([
        { op: 'set_canvas',
          canvas: { width_mm: 210, height_mm: 297 } },
        { op: 'add_element', element: {
          id: 'seed-rect-' + Date.now(), type: 'rect', name: 'r',
          transform: { x: 10, y: 10, w: 20, h: 15, rotation: 0 },
          style: { fill: '#ddeeff', stroke: '#3366cc',
                   strokeWidthPt: 0.75 } } }
      ], { label: 'seed-big-canvas', source: 'user' });
      return App.doc.canvas;
    }
    """
    CHART_BOUNDS_JS = r"""
    () => {
      const cv = (App.doc && App.doc.canvas) || {};
      const charts = (App.doc.elements || []).filter(e => e.type === 'chart');
      return {
        canvas: { w: cv.width_mm, h: cv.height_mm },
        charts: charts.map(e => {
          const t = e.transform || {};
          return { id: e.id, x: t.x, y: t.y, w: t.w, h: t.h };
        })
      };
    }
    """

    def _assert_charts_inside_canvas(self, page, tag):
        st = page.evaluate(self.CHART_BOUNDS_JS)
        cw, ch = st["canvas"]["w"], st["canvas"]["h"]
        self.assertTrue(st["charts"], "%s 应有图表元素" % tag)
        for c in st["charts"]:
            eps = 0.5
            self.assertGreaterEqual(c["x"], -eps,
                                    "%s 图表 x 越界：%s canvas=%sx%s"
                                    % (tag, c, cw, ch))
            self.assertGreaterEqual(c["y"], -eps,
                                    "%s 图表 y 越界：%s canvas=%sx%s"
                                    % (tag, c, cw, ch))
            self.assertLessEqual(c["x"] + c["w"], cw + eps,
                                 "%s 图表右缘超出画布：%s canvas=%sx%s"
                                 % (tag, c, cw, ch))
            self.assertLessEqual(c["y"] + c["h"], ch + eps,
                                 "%s 图表下缘超出画布：%s canvas=%sx%s"
                                 % (tag, c, cw, ch))
        return st

    def test_import_new_tab_chart_within_canvas(self):
        """源标签 210×297 → 导入默认新标签：图表须完整落在新画布内；
        「放到当前画布」同样校验。"""
        page = self.open_page()
        try:
            page.evaluate(self.SEED_BIG_CANVAS_JS)
            page.wait_for_function(
                "() => App.doc && App.doc.canvas &&"
                " App.doc.canvas.width_mm === 210 &&"
                " App.doc.canvas.height_mm === 297",
                timeout=10000)
            cv = page.evaluate("() => App.doc.canvas")
            self.assertEqual((cv.get("width_mm"), cv.get("height_mm")),
                             (210, 297), "种子画布应为 210×297：%s" % cv)
            page.evaluate(FLUSH_JS)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            id1 = page.evaluate(DOC_ID_JS)

            # ---- 导入 → 默认新建标签 ----
            self.open_wizard(page)
            self.goto_step(page, 3)
            radios = page.evaluate(PLACE_RADIOS_JS)
            self.assertEqual(len(radios), 2, "非空画布应有放置选项")
            self.assertTrue(radios[0]["checked"], "默认应为新建标签")
            self.goto_step(page, 4)
            self.create_via_footer(page)
            page.wait_for_function(
                "() => !document.querySelector('.dw-modal')",
                timeout=20000)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 2", timeout=15000)
            page.wait_for_function(
                "() => App.doc && App.doc.id !== %s" % json.dumps(id1),
                timeout=15000)
            page.wait_for_timeout(500)
            st = self._assert_charts_inside_canvas(page, "new-tab")
            # keep 画布选择：新标签继承源画布尺寸（effectiveCanvas）
            self.assertEqual(
                (st["canvas"]["w"], st["canvas"]["h"]), (210, 297),
                "新标签画布应继承 effectiveCanvas：%s" % st["canvas"])

            # ---- 再导入一次 → 选「放到当前画布」----
            id2 = page.evaluate(DOC_ID_JS)
            self.open_wizard(page)
            self.goto_step(page, 3)
            page.evaluate("""() => {
              const rs = [...document.querySelectorAll(
                'input[name="wizard-place"]')];
              if (rs[1]) { rs[1].click(); }
            }""")
            page.wait_for_timeout(300)
            self.goto_step(page, 4)
            self.create_via_footer(page)
            page.wait_for_function(
                "() => !document.querySelector('.dw-modal')",
                timeout=20000)
            page.wait_for_timeout(800)
            # 仍在同一文档（放到当前画布），现在应有 2 张图
            self.assertEqual(page.evaluate(DOC_ID_JS), id2,
                             "「放到当前画布」不应切换文档")
            st2 = page.evaluate(self.CHART_BOUNDS_JS)
            self.assertEqual(len(st2["charts"]), 2,
                             "当前画布应累积两张图：%s" % st2)
            self._assert_charts_inside_canvas(page, "current-canvas")
        finally:
            page.context.close()

    # R4-HB2：标签栏必须是舞台上方的整宽横条（不是舞台左侧的竖直居中块）
    TABBAR_GEOM_JS = r"""
    () => {
      const tb = document.getElementById('tab-bar');
      const st = document.getElementById('stage');
      const cm = document.getElementById('canvas-main');
      if (!tb || !st || !cm) return { err: 'missing nodes' };
      const r = el => { const b = el.getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom,
                 w: b.width, h: b.height }; };
      const badge = id => {
        const el = document.getElementById(id);
        if (!el) return null;
        return { rect: r(el), host: el.parentElement && el.parentElement.id };
      };
      return {
        tabs: r(tb), stage: r(st), main: r(cm),
        nTabs: document.querySelectorAll('#tab-bar .tab-wrap').length,
        sizeBadge: badge('editor-size-badge'),
        zoomBadge: badge('editor-zoom-badge')
      };
    }
    """

    def test_tabbar_top_strip_layout_and_badges(self):
        """3+ 标签：tab-bar 位于 stage 正上方、宽度与 stage 一致（±2px），
        尺寸/缩放角标仍落在舞台可视角内。"""
        page = self.open_page(1440, 900)
        try:
            # 先让 boot 文档落盘成为第一个标签（空文档不自动保存）
            page.evaluate(ADD_RECT_JS)
            page.evaluate(FLUSH_JS)
            page.wait_for_function(
                "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                ".length === 1", timeout=15000)
            # 再开两个空标签 → 共 3 个
            for want in (2, 3):
                page.locator("#tab-new").click()
                page.wait_for_function(
                    "() => document.querySelectorAll('#tab-bar .tab-wrap')"
                    ".length === %d" % want, timeout=15000)
                page.wait_for_timeout(300)
            g = page.evaluate(self.TABBAR_GEOM_JS)
            self.assertNotIn("err", g, g)
            self.assertGreaterEqual(g["nTabs"], 3, "应有 ≥3 个标签")
            tb, st = g["tabs"], g["stage"]
            # 标签栏在舞台上方：tab-bar 底边 ≤ stage 顶边（允许 1px 误差）
            self.assertLess(tb["t"], st["t"],
                            "tab-bar 应在 stage 上方：%s vs %s" % (tb, st))
            self.assertLessEqual(tb["b"], st["t"] + 1.0,
                                 "tab-bar 底边不应压进 stage：%s vs %s"
                                 % (tb, st))
            # 整宽：与 stage 左右对齐（±2px）
            self.assertAlmostEqual(tb["l"], st["l"], delta=2.0,
                                   msg="tab-bar 左缘应对齐 stage：%s" % tb)
            self.assertAlmostEqual(tb["r"], st["r"], delta=2.0,
                                   msg="tab-bar 右缘应对齐 stage：%s" % tb)
            self.assertAlmostEqual(tb["w"], st["w"], delta=2.0,
                                   msg="tab-bar 宽度应≈stage 宽度")
            # 角标宿主是 canvas-main（stage 新父容器），且落在舞台可视角内
            for key in ("sizeBadge", "zoomBadge"):
                badge = g[key]
                self.assertIsNotNone(badge, "%s 应存在" % key)
                self.assertEqual(badge["host"], "canvas-main",
                                 "%s 宿主应为 canvas-main：%s" % (key, badge))
                br = badge["rect"]
                tol = 2.0
                self.assertGreaterEqual(br["l"], st["l"] - tol,
                                        "%s 左越界：%s vs %s" % (key, br, st))
                self.assertLessEqual(br["r"], st["r"] + tol,
                                     "%s 右越界：%s vs %s" % (key, br, st))
                self.assertGreaterEqual(br["t"], st["t"] - tol,
                                        "%s 上越界（压到标签栏?）：%s vs %s"
                                        % (key, br, st))
                self.assertLessEqual(br["b"], st["b"] + tol,
                                     "%s 下越界：%s vs %s" % (key, br, st))
        finally:
            page.context.close()


if __name__ == "__main__":
    unittest.main()
