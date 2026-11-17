# -*- coding: utf-8 -*-
"""test_store_panel_ui.py — G17 工程面板 open() 竞态修复 Playwright 验收。

根因：Store.attach() 同步赋值 adapter 后才 await adapter.open()；boot 时
Store.mount→refreshList→Store.list→FigStore.listProjects 在 open() 落定前执行，
抛「存储适配器尚未 open()」，且之后无人再刷新。修复后所有存储操作先 await
ready()（=openPromise），attach 在 open 完成后补一次 refreshList。

覆盖（每个用例独立 browser context，IndexedDB/localStorage 按 origin 隔离）：
  a) 页面加载后「工程」列表不含「失败」「open()」，空库显示「暂无已保存的工程」；
  b) 点「保存」后列表出现 1 行；
  c) 顶栏「打开」：空库弹「还没有保存过工程…」toast；有 1 个工程弹「打开工程」
     对话框且「打开」按钮可点。
"""
import shutil
import tempfile
import unittest
from pathlib import Path

from test_modal_layout import (
    HAS_PLAYWRIGHT, SAMPLE_CSV, _ViewerServer, _launch_chromium,
)

HERE = Path(__file__).resolve().parent

LIST_TEXT_JS = "()=>document.querySelector('#store-project-list').textContent"
LIST_SETTLED_JS = (
    "()=>{const e=document.querySelector('#store-project-list');"
    "return !!e && e.textContent.trim().length>0;}")
ROW_COUNT_JS = (
    "()=>document.querySelectorAll('#store-project-list .ui-project-row').length")


@unittest.skipUnless(HAS_PLAYWRIGHT, "Python playwright + chromium 不可用，跳过")
class StorePanelUiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-store-data-")
        cls.server = _ViewerServer(cls.datadir)
        try:
            cls.server.wait_ready()
        except Exception:
            cls.server.stop(); shutil.rmtree(cls.datadir, ignore_errors=True); raise

    @classmethod
    def tearDownClass(cls):
        cls.server.stop(); shutil.rmtree(cls.datadir, ignore_errors=True)

    def setUp(self):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self.browser = _launch_chromium(self._pw)

    def tearDown(self):
        try: self.browser.close()
        finally: self._pw.stop()

    def open_page(self, vw=1280, vh=860):
        ctx = self.browser.new_context(viewport={"width": vw, "height": vh})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#tab-store", timeout=20000)
        page.wait_for_timeout(600)
        return ctx, page

    def open_store_tab(self, page):
        page.click("#tab-store")
        page.wait_for_selector("#panel-store:not(.hidden)", timeout=10000)

    def wait_list_settled(self, page, timeout=15000):
        page.wait_for_function(LIST_SETTLED_JS, timeout=timeout)
        page.wait_for_timeout(300)

    def click_panel_button(self, page, label):
        return page.locator("#panel-store button").filter(
            has_text=label).first.click()

    # ------------------------------------------------------------- a
    def test_list_no_open_error_empty(self):
        ctx, page = self.open_page()
        self.open_store_tab(page)
        self.wait_list_settled(page)
        text = page.evaluate(LIST_TEXT_JS)
        self.assertNotIn("失败", text, "列表不应报读取失败：%r" % text)
        self.assertNotIn("open()", text, "列表不应残留 open() 错误：%r" % text)
        self.assertNotIn("尚未", text, "列表不应残留「尚未」错误：%r" % text)
        self.assertIn("暂无已保存的工程", text, "空库应显示空态：%r" % text)
        ctx.close()

    # ------------------------------------------------------------- b
    def test_save_adds_row(self):
        ctx, page = self.open_page()
        self.open_store_tab(page)
        self.wait_list_settled(page)
        self.assertEqual(page.evaluate(ROW_COUNT_JS), 0)
        self.click_panel_button(page, "保存")
        page.wait_for_function("%s>0" % ROW_COUNT_JS, timeout=15000)
        self.assertEqual(page.evaluate(ROW_COUNT_JS), 1, "保存后应有 1 行工程")
        ctx.close()

    # ------------------------------------------------------------- c
    def test_open_empty_toast_then_dialog(self):
        ctx, page = self.open_page()
        self.open_store_tab(page)
        self.wait_list_settled(page)
        self.assertEqual(page.evaluate(ROW_COUNT_JS), 0, "前置：库应为空")

        # 空库点顶栏「打开」→ toast 提示先保存/可导入
        page.click("#btn-open")
        page.wait_for_selector(".ui-toast", timeout=10000)
        toast_text = page.inner_text("#toast-root")
        self.assertIn("还没有保存过工程", toast_text,
                      "空库打开应提示先保存：%r" % toast_text)
        self.assertIn("导入工程文件", toast_text)

        # 保存 1 个工程 → 再点「打开」→「打开工程」对话框且按钮可点
        self.click_panel_button(page, "保存")
        page.wait_for_function("%s>0" % ROW_COUNT_JS, timeout=15000)
        page.click("#btn-open")
        page.wait_for_selector(".ui-modal", timeout=10000)
        title = page.inner_text(".ui-modal-title")
        self.assertIn("打开工程", title)
        open_btn = page.locator(".ui-modal button").filter(
            has_text="打开").first
        self.assertTrue(open_btn.count() >= 1, "对话框应有「打开」按钮")
        self.assertFalse(open_btn.is_disabled(), "「打开」按钮应可点")
        box = open_btn.bounding_box()
        self.assertTrue(box and box["width"] > 0 and box["height"] > 0)
        ctx.close()

    # ------------------------------------------------------------- d
    def test_legacy_migration_prompt_and_copy(self):
        """旧版工程待迁移：工程面板给出提示与复制按钮，POST body overwrite:false。

        /api/data-dirs 与 /api/projects/migrate 均用 page.route 拦截 mock，
        绝不触达真实 mcp/projects 目录或真实迁移逻辑。
        """
        import json as _json
        migrate_body = {}

        def _dirs(route):
            route.fulfill(status=200, content_type="application/json", body=_json.dumps({
                "ok": True,
                "data_dir": "X:/figdata",
                "data_dir_env": "FIGURE_DATA_DIR",
                "data_dir_env_set": True,
                "current_project_exists": False,
                "legacy_project_dir": "X:/plugin/mcp/projects",
                "legacy_pending_migration": [
                    {"name": "old-a.figureproj.json", "source": "s", "target": "t",
                     "target_exists": False, "conflict": False},
                ],
            }, ensure_ascii=False))

        def _migrate(route):
            try:
                migrate_body["data"] = _json.loads(route.request.post_data or "{}")
            except Exception:
                migrate_body["data"] = None
            route.fulfill(status=200, content_type="application/json", body=_json.dumps({
                "ok": True, "overwrite": False,
                "copied": 1, "skipped_identical": 1,
                "conflicts": [{"name": "dup.figureproj.json"}], "invalid": [],
                "plan": [],
            }, ensure_ascii=False))

        # Store.mount 在页面 boot 时即拉取 /api/data-dirs，路由须先于 goto 注册
        ctx = self.browser.new_context(viewport={"width": 1280, "height": 860})
        page = ctx.new_page()
        page.route("**/api/data-dirs", _dirs)
        page.route("**/api/projects/migrate", _migrate)
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#tab-store", timeout=20000)
        page.wait_for_timeout(600)
        self.open_store_tab(page)

        panel = page.locator("#panel-store")
        panel.get_by_text("发现 1 个旧版工程", exact=False).wait_for(timeout=10000)
        self.assertIn("原文件会保留", panel.inner_text())
        btn = panel.get_by_role("button", name="复制旧工程到当前目录")
        self.assertEqual(btn.count(), 1, "应有且仅有一个迁移按钮")
        btn.click()
        panel.get_by_text("已复制 1 个", exact=False).wait_for(timeout=10000)
        result_text = panel.inner_text()
        self.assertIn("相同已跳过 1 个", result_text)
        self.assertIn("同名冲突未覆盖 1 个", result_text)
        self.assertIn("dup.figureproj.json", result_text)
        self.assertIn("无效 0 个", result_text)
        self.assertEqual(migrate_body.get("data"), {"overwrite": False},
                         "迁移请求必须显式 overwrite:false（不覆盖冲突）")
        ctx.close()


if __name__ == "__main__":
    unittest.main()
