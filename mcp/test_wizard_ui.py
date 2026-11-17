# -*- coding: utf-8 -*-
"""test_wizard_ui.py — 数据导入向导（4 步）Playwright 验收。

覆盖：
  a) 三种视口 × 四步：步骤条 / footer 按钮 / 右侧预览区都在视口内，
     按钮中心 elementFromPoint 命中自身；
  b) 真实拖放：把列标签拖到 y 槽位 → 映射改变、预览 SVG 改变；
  c) 「按推荐直接创建」一键建图；
  d) 同一文件二次导入 → 记忆提示「已沿用上次」+ 映射沿用；
  e) G02 键盘穿透：对话框打开时 Delete / Ctrl+Z 不作用到画布，
     关闭后 Ctrl+Z 撤销恢复；
  f) Excel（xlsx）导入：预览对话框 → 继续 → 新向导 → 创建成功。

需要 Python playwright + 可用浏览器；不可用时整体 skip。交互一律用
page.mouse / page.keyboard 真实输入，仅状态断言用只读 evaluate。
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from test_modal_layout import (
    HAS_PLAYWRIGHT, SAMPLE_CSV, VIEWPORTS, _ViewerServer, _launch_chromium,
    _make_xlsx, _playwright_ready, DOC_STATS_JS, OVERLAY_COUNT_JS,
    TOP_OVERLAY_TEXT_JS,
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# 「没有弹出文件选择框」受限环境提示是否出现在 #toast-root 中
FILE_NOTICE_JS = (
    "[...document.querySelectorAll('#toast-root > *')]"
    ".some(n => (n.textContent || '').includes('没有弹出文件选择框'))")

WIZARD_GEOM_JS = r"""
() => {
  const dlg = document.querySelector('.dw-modal');
  const r = dlg ? dlg.getBoundingClientRect() : null;
  const steps = document.querySelector('.dw-steps');
  const sr = steps ? steps.getBoundingClientRect() : null;
  const side = document.querySelector('.dw-side');
  const pr = side ? side.getBoundingClientRect() : null;
  const cur = document.querySelector('.dw-stepbtn-on');
  const stepTxt = cur ? (cur.textContent || '').trim() : '';
  const btns = [...document.querySelectorAll('.ui-modal-footer button')]
    .filter(b => !b.hidden).map(b => {
      const br = b.getBoundingClientRect();
      const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {label: (b.textContent || '').trim(),
              inView: cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight,
              hitSelf: !!(hit && (hit === b || b.contains(hit))),
              disabled: !!b.disabled};
    });
  return {dialog: r ? {top: r.top, bottom: r.bottom, left: r.left, right: r.right} : null,
          steps: sr ? {top: sr.top, bottom: sr.bottom} : null,
          side: pr ? {top: pr.top, bottom: pr.bottom, left: pr.left, right: pr.right} : null,
          stepTxt: stepTxt, vw: innerWidth, vh: innerHeight, buttons: btns};
}
"""


def _rect_in_view(rect, vw, vh, label, test):
    test.assertIsNotNone(rect, label + "：缺少元素")
    test.assertGreaterEqual(rect["top"], -0.5, "%s：顶部超出视口 %s" % (label, rect))
    test.assertLessEqual(rect["bottom"], vh + 0.5, "%s：底部超出视口 %s" % (label, rect))
    if "left" in rect:
        test.assertGreaterEqual(rect["left"], -0.5, "%s：左侧超出 %s" % (label, rect))
        test.assertLessEqual(rect["right"], vw + 0.5, "%s：右侧超出 %s" % (label, rect))


@unittest.skipUnless(HAS_PLAYWRIGHT,
                     "Python playwright + chromium/Chrome 不可用，跳过")
class WizardUITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-wizui-data-")
        cls.fixtures = tempfile.mkdtemp(prefix="fig-wizui-fix-")
        cls.server = _ViewerServer(cls.datadir)
        try:
            cls.server.wait_ready()
        except Exception:
            cls.server.stop()
            shutil.rmtree(cls.datadir, ignore_errors=True)
            shutil.rmtree(cls.fixtures, ignore_errors=True)
            raise
        cls.csv_path = str(SAMPLE_CSV)
        cls.xlsx_path = str(Path(cls.fixtures) / "wizui-fixture.xlsx")
        try:
            _make_xlsx(cls.xlsx_path)
        except Exception as exc:
            cls.xlsx_path = None
            cls._xlsx_error = exc

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

    def open_page(self, vw, vh):
        ctx = self.browser.new_context(viewport={"width": vw, "height": vh})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#panel-import button", timeout=20000)
        page.wait_for_timeout(1200)
        return page

    def import_button(self, page, name):
        return page.locator("#panel-import").get_by_role(
            "button", name=name, exact=True)

    def wait_overlays(self, page, count, timeout=15000):
        page.wait_for_function(
            "document.querySelectorAll('#modal-root > .ui-modal-overlay')"
            ".length === %d" % count, timeout=timeout)

    def open_wizard(self, page, path=None):
        path = path or self.csv_path
        with page.expect_file_chooser() as fc_info:
            self.import_button(page, "导入数据").click()
        fc_info.value.set_files(path)
        page.wait_for_selector(".dw-modal", timeout=20000)
        self.wait_overlays(page, 1)

    def goto_step(self, page, n):
        page.locator('.dw-steps [data-step-btn="%d"]' % n).click()
        page.wait_for_timeout(250)

    def stats(self, page):
        return page.evaluate(DOC_STATS_JS)

    def create_via_footer(self, page):
        btn = page.locator(".ui-modal-footer button").filter(
            has_text="创建图表")
        box = btn.bounding_box()
        self.assertIsNotNone(box, "footer 缺少「创建图表」")
        page.mouse.click(box["x"] + box["width"] / 2,
                         box["y"] + box["height"] / 2)

    # ------------------------------------------------------------ tests

    STEPBTN_MEASURE_JS = r"""
(sel) => {
  const b = document.querySelector(sel);
  if (!b) return null;
  const cs = getComputedStyle(b);
  const parse = s => {
    const m = String(s).match(/[\d.]+/g);
    return m && m.length >= 3 ? m.slice(0, 3).map(Number) : null;
  };
  const lum = rgb => rgb
    ? (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 : null;
  const c = parse(cs.color), bg = parse(cs.backgroundColor);
  const lc = lum(c), lb = lum(bg);
  return {text: (b.textContent || '').trim(),
          cls: b.className,
          color: cs.color, bg: cs.backgroundColor,
          lumDiff: (lc != null && lb != null) ? Math.abs(lc - lb) : null,
          hovered: b.matches(':hover')};
}
"""

    def assert_stepbtn_visible(self, page, label):
        """当前步按钮：文字非空、color≠bg、亮度差≥0.4（悬停/不悬停都查）。"""
        m = page.evaluate(self.STEPBTN_MEASURE_JS, ".dw-stepbtn-on")
        self.assertIsNotNone(m, label + "：缺少 .dw-stepbtn-on")
        self.assertTrue(m["text"], "%s：当前步按钮文字为空 %r" % (label, m))
        self.assertNotEqual(m["color"], m["bg"],
                            "%s：文字色与背景色相同 %s" % (label, m))
        self.assertIsNotNone(m["lumDiff"], label + "：无法解析颜色")
        self.assertGreaterEqual(m["lumDiff"], 0.4,
                                "%s：亮度差不足 0.4（%s）" % (label, m))

    def hover_stepbtn(self, page, on=True):
        if on:
            box = page.locator(".dw-stepbtn-on").bounding_box()
            self.assertIsNotNone(box, "当前步按钮无 bounding box")
            page.mouse.move(box["x"] + box["width"] / 2,
                            box["y"] + box["height"] / 2)
            # 等 :hover 真实生效（固定 sleep 在重排/动画下不可靠）
            try:
                page.wait_for_function(
                    "document.querySelector('.dw-stepbtn-on') && "
                    "document.querySelector('.dw-stepbtn-on')"
                    ".matches(':hover')", timeout=3000)
            except Exception:
                pass  # 由下方 hovered 断言给出可读失败
        else:
            page.mouse.move(4, 4)
            try:
                page.wait_for_function(
                    "!(document.querySelector('.dw-stepbtn-on') && "
                    "document.querySelector('.dw-stepbtn-on')"
                    ".matches(':hover'))", timeout=3000)
            except Exception:
                pass
            page.wait_for_timeout(150)

    def clear_toasts(self, page):
        """移除瞬时 toast：openData 的 6s 延迟提示（ms:9000）会盖住
        步骤条右侧按钮，与本用例断言的样式无关，先清掉再测 :hover。"""
        page.evaluate(
            "document.querySelectorAll('#toast-root > *')"
            ".forEach(n => n.remove())")

    def check_step_arrival(self, page, step, label):
        """到达 step 后：不悬停与悬停两种状态都验证当前步可读性。"""
        self.clear_toasts(page)
        cur = ".dw-stepbtn-on"
        on_step = page.evaluate(
            "document.querySelector('%s') && "
            "document.querySelector('%s').getAttribute('data-step-btn')"
            % (cur, cur))
        self.assertEqual(on_step, str(step),
                         "%s：当前步应为 %d，实际 %r" % (label, step, on_step))
        self.hover_stepbtn(page, on=False)
        self.assert_stepbtn_visible(page, label + " 不悬停")
        self.hover_stepbtn(page, on=True)
        m = page.evaluate(self.STEPBTN_MEASURE_JS, ".dw-stepbtn-on")
        self.assertTrue(m and m["hovered"],
                        label + "：鼠标未悬停在当前步按钮上")
        self.assert_stepbtn_visible(page, label + " 悬停")
        self.hover_stepbtn(page, on=False)

    def test_stepbtn_current_step_visible(self):
        """当前步按钮文字在悬停/不悬停下都可读（三种到达方式 × 三视口）。"""
        for vw, vh in VIEWPORTS:
            with self.subTest(viewport="%dx%d" % (vw, vh)):
                page = self.open_page(vw, vh)
                self.open_wizard(page)

                def reset_to_step1():
                    page.locator('.dw-steps [data-step-btn="1"]').click()
                    page.wait_for_timeout(250)

                # 方式 1：点击步骤条按钮
                for step in (2, 3, 4):
                    page.locator(
                        '.dw-steps [data-step-btn="%d"]' % step).click()
                    page.wait_for_timeout(250)
                    self.check_step_arrival(
                        page, step, "视口%s 步骤条→%d步" % ((vw, vh), step))

                # 方式 2：点击 footer「下一步」
                reset_to_step1()
                for step in (2, 3, 4):
                    btn = page.locator(".ui-modal-footer button").filter(
                        has_text="下一步")
                    box = btn.bounding_box()
                    self.assertIsNotNone(box, "缺少「下一步」")
                    page.mouse.click(box["x"] + box["width"] / 2,
                                     box["y"] + box["height"] / 2)
                    page.wait_for_timeout(250)
                    self.check_step_arrival(
                        page, step, "视口%s 下一步→%d步" % ((vw, vh), step))

                # 方式 3：键盘 Enter（每次到达新步骤后焦点在该步首个控件，
                # 再按 Enter 触发 footer 主按钮=下一步；第 4 步不再按，
                # 避免触发创建）
                reset_to_step1()
                page.wait_for_timeout(200)
                for step in (2, 3, 4):
                    page.keyboard.press("Enter")
                    page.wait_for_timeout(300)
                    self.check_step_arrival(
                        page, step, "视口%s Enter→%d步" % ((vw, vh), step))
                page.context.close()

    def test_step_layout_all_viewports(self):
        """a) 3 视口 × 4 步：步骤条/按钮/预览区在视口内且命中自身。"""
        for vw, vh in VIEWPORTS:
            with self.subTest(viewport="%dx%d" % (vw, vh)):
                page = self.open_page(vw, vh)
                self.open_wizard(page)
                for step in (1, 2, 3, 4):
                    if step > 1:
                        self.goto_step(page, step)
                    geom = page.evaluate(WIZARD_GEOM_JS)
                    label = "视口 %dx%d 第%d步" % (vw, vh, step)
                    _rect_in_view(geom["dialog"], vw, vh, label + " 对话框", self)
                    _rect_in_view(geom["steps"], vw, vh, label + " 步骤条", self)
                    _rect_in_view(geom["side"], vw, vh, label + " 预览区", self)
                    self.assertTrue(geom["buttons"], label + "：footer 无按钮")
                    for btn in geom["buttons"]:
                        self.assertTrue(btn["inView"],
                                        "%s：按钮「%s」中心在视口外" % (label, btn["label"]))
                        self.assertTrue(btn["hitSelf"],
                                        "%s：elementFromPoint 未命中「%s」" % (label, btn["label"]))
                page.context.close()

    def test_drag_column_chip_to_slot(self):
        """b) 真实拖放列标签到 y 槽：映射改变且预览 SVG 改变。"""
        page = self.open_page(1024, 689)
        self.open_wizard(page)
        self.goto_step(page, 2)

        before_svg = page.evaluate(
            "document.querySelector('.dw-preview') ? "
            "document.querySelector('.dw-preview').innerHTML.length : -1")
        # R4-HB：line_multi/scatter 的 y 槽为多列控件（chip），其他模板仍是单选
        wide_y = page.locator(".dw-ycol-wrap").count() >= 1
        if wide_y:
            before_val = page.evaluate(
                "() => [...document.querySelectorAll('.dw-ycol-chip')]"
                ".map(c => c.getAttribute('data-col'))")
        else:
            before_val = page.locator(
                '.dw-slot[data-slot="y"] select[data-wizard-slot]'
            ).input_value()

        chip = page.locator('.dw-chip[data-col="value2"]')
        slot = page.locator('.dw-slot[data-slot="y"]')
        self.assertTrue(chip.count() >= 1, "缺少列标签 value2")
        # HTML5 拖放需要真实鼠标轨迹：按下 → 分段移动 → 松开
        cb = chip.bounding_box()
        sb = slot.bounding_box()
        self.assertIsNotNone(cb and sb)
        sx, sy = cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] / 2
        # R4-HB：y 槽变高后中心贴近视口底部，拖动中易触发自动滚动导致
        # drop 落空；改落在槽位上部（标签行，仍在 box 内）。
        tx, ty = sb["x"] + sb["width"] / 2, sb["y"] + min(28, sb["height"] * 0.3)
        page.mouse.move(sx, sy)
        page.mouse.down()
        for i in range(1, 13):
            page.mouse.move(sx + (tx - sx) * i / 12,
                            sy + (ty - sy) * i / 12)
            page.wait_for_timeout(30)
        page.mouse.up()
        page.wait_for_timeout(600)

        if wide_y:
            after_val = page.evaluate(
                "() => [...document.querySelectorAll('.dw-ycol-chip')]"
                ".map(c => c.getAttribute('data-col'))")
            self.assertIn("value2", after_val,
                          "拖放未把 value2 加入纵轴列（%r）" % (after_val,))
        else:
            after_val = page.locator(
                '.dw-slot[data-slot="y"] select[data-wizard-slot]'
            ).input_value()
            self.assertNotEqual(after_val, before_val,
                                "拖放未改变 y 槽映射（%r → %r）" % (before_val, after_val))
            self.assertEqual(after_val, "value2")
        after_svg = page.evaluate(
            "document.querySelector('.dw-preview').innerHTML.length")
        self.assertNotEqual(after_svg, before_svg,
                            "映射改变后预览 SVG 未变化")
        page.context.close()

    def test_quick_create_button(self):
        """c) 「按推荐直接创建」一键建图成功。"""
        page = self.open_page(1024, 689)
        self.open_wizard(page)
        before = self.stats(page)
        page.locator("[data-wizard-quick]").click()
        self.wait_overlays(page, 0, timeout=20000)
        after = self.stats(page)
        self.assertIsNotNone(after and after["elements"])
        self.assertGreater(after["elements"], before["elements"],
                           "按推荐直接创建后元素数未增加")
        self.assertEqual(after["history"], before["history"] + 1)
        page.context.close()

    def test_memory_second_import(self):
        """d) 同一文件第二次导入：沿用上次映射并显示记忆提示。"""
        page = self.open_page(1024, 689)
        # 第一次：改 y → value2 后创建
        self.open_wizard(page)
        self.goto_step(page, 2)
        # R4-HB：line_multi/scatter 的 y 槽为多列控件——清空 chip 后经
        # 「添加列」选 value2（等价于原单选改映射，group 保留）
        wide_y = page.locator(".dw-ycol-wrap").count() >= 1
        if wide_y:
            for _ in range(6):
                rm = page.locator(".dw-ycol-rm").first
                if not rm.count():
                    break
                rm.click()
                page.wait_for_timeout(250)
            page.locator(".dw-ycol-addsel").select_option("value2")
            page.wait_for_timeout(300)
        else:
            page.locator('.dw-slot[data-slot="y"] select[data-wizard-slot]'
                         ).select_option("value2")
            page.wait_for_timeout(300)
        self.create_via_footer(page)
        self.wait_overlays(page, 0, timeout=20000)

        # 第二次：同一文件 → 记忆提示 + 映射沿用
        self.open_wizard(page)
        mem = page.locator(".dw-mem")
        self.assertTrue(mem.count() >= 1, "第二次导入应显示「已沿用上次」提示")
        self.assertIn("已沿用上次", mem.first.text_content())
        self.goto_step(page, 2)
        if wide_y:
            cols = page.evaluate(
                "() => [...document.querySelectorAll('.dw-ycol-chip')]"
                ".map(c => c.getAttribute('data-col'))")
            self.assertIn("value2", cols, "第二次导入应沿用上次 y 映射：%r" % cols)
        else:
            val = page.locator(
                '.dw-slot[data-slot="y"] select[data-wizard-slot]'
            ).input_value()
            self.assertEqual(val, "value2", "第二次导入应沿用上次 y 映射")
        page.context.close()

    def test_keyboard_shortcut_blocked_while_modal(self):
        """e) G02：对话框打开时 Delete/Ctrl+Z 不穿透到画布。"""
        page = self.open_page(1024, 689)
        # 先建一个图（quickCreate），元素会被选中
        self.open_wizard(page)
        page.locator("[data-wizard-quick]").click()
        self.wait_overlays(page, 0, timeout=20000)
        before = self.stats(page)
        self.assertGreater(before["elements"], 0, "前置建图失败")

        # 打开粘贴对话框（空 → 不脏），焦点放到「取消」按钮上
        self.import_button(page, "粘贴数据").click()
        page.wait_for_selector(".ui-modal", timeout=10000)
        self.wait_overlays(page, 1)
        cancel = page.locator(".ui-modal-footer button").filter(
            has_text="取消")
        if cancel.count() == 0:
            cancel = page.locator(".ui-modal-footer button").first
        cancel.focus()
        page.wait_for_timeout(150)

        stats0 = self.stats(page)
        page.keyboard.press("Delete")
        page.wait_for_timeout(200)
        self.assertEqual(self.stats(page), stats0,
                         "对话框打开时 Delete 穿透到了画布")
        page.keyboard.press("Control+z")
        page.wait_for_timeout(200)
        self.assertEqual(self.stats(page), stats0,
                         "对话框打开时 Ctrl+Z 穿透到了画布")

        # 关闭对话框（空粘贴框 Esc 直接关）→ Ctrl+Z 撤销恢复
        # （undo 以逆操作提交，history 长度 +1 而非 -1，故断元素数减少）
        page.keyboard.press("Escape")
        self.wait_overlays(page, 0, timeout=10000)
        page.keyboard.press("Control+z")
        page.wait_for_timeout(600)
        after = self.stats(page)
        self.assertIsNotNone(after)
        self.assertLess(after["elements"], stats0["elements"],
                        "关闭对话框后 Ctrl+Z 应撤销建图（元素数应减少）")
        page.context.close()

    def test_file_import_no_false_filechooser_toast(self):
        """文件导入成功后，不再误报「没有弹出文件选择框」（6s 定时器）。"""
        page = self.open_page(1024, 689)
        with page.expect_file_chooser() as fc_info:
            self.import_button(page, "导入数据").click()
        fc_info.value.set_files(self.csv_path)
        page.wait_for_selector(".dw-modal", timeout=20000)
        # 6s 定时器从 click 起算；向导打开 + 再等 7s 必然越过提示窗口
        # （提示 ms:9000，若误报则在 6–15s 内可见）。
        page.wait_for_timeout(7000)
        has_notice = page.evaluate(FILE_NOTICE_JS)
        self.assertFalse(has_notice,
                         "成功导入文件后不应出现「没有弹出文件选择框」提示")
        page.context.close()

    def test_filechooser_notice_fires_without_pick(self):
        """对照：点「导入数据」后不选文件，受限环境提示路径仍有效。"""
        page = self.open_page(1024, 689)
        with page.expect_file_chooser() as fc_info:
            self.import_button(page, "导入数据").click()
        # 不调用 set_files：模拟受限环境下文件选择框未产生选择
        page.wait_for_timeout(7000)
        has_notice = page.evaluate(FILE_NOTICE_JS)
        self.assertTrue(has_notice,
                        "未选择文件时应出现「没有弹出文件选择框」提示")
        page.context.close()

    def test_excel_import_creates_chart(self):
        """f) Excel（xlsx）导入：预览 → 继续 → 新向导 → 创建成功。"""
        if not self.xlsx_path:
            self.skipTest("openpyxl 不可用：%r" % getattr(self, "_xlsx_error", None))
        page = self.open_page(1024, 689)
        before = self.stats(page)
        with page.expect_file_chooser() as fc_info:
            self.import_button(page, "导入数据").click()
        fc_info.value.set_files(self.xlsx_path)
        # 第 1 步：Excel 导入预览（工作表/表头）→ 「继续：选择模板」
        page.wait_for_selector(".ui-modal", timeout=30000)
        self.wait_overlays(page, 1)
        cont = page.locator(".ui-modal-footer button").filter(
            has_text="继续")
        box = cont.bounding_box()
        self.assertIsNotNone(box, "Excel 预览缺少「继续：选择模板」")
        page.mouse.click(box["x"] + box["width"] / 2,
                         box["y"] + box["height"] / 2)
        # 第 2 步：进入新数据向导 → 按推荐直接创建
        page.wait_for_selector(".dw-modal", timeout=20000)
        self.wait_overlays(page, 1)
        page.locator("[data-wizard-quick]").click()
        self.wait_overlays(page, 0, timeout=20000)
        after = self.stats(page)
        self.assertIsNotNone(after and after["elements"])
        self.assertGreater(after["elements"], before["elements"],
                           "Excel 导入创建后元素数未增加")
        page.context.close()

    def test_duplicate_x_warning(self):
        """G22：sample.csv 折线折返警示（第1步推荐卡 + 第2步统计区）；
        无重复数据时不显示。"""
        page = self.open_page(1024, 689)
        self.open_wizard(page)  # examples/sample.csv
        # 第 1 步：推荐卡片旁警示含 "20" 与「折返」
        w1 = page.locator('.dw-step[data-step="1"] [data-wizard-dupwarn]')
        page.wait_for_selector(
            '.dw-step[data-step="1"] [data-wizard-dupwarn]', timeout=10000)
        self.assertGreaterEqual(w1.count(), 1, "第1步缺少折返警示")
        t1 = w1.first.inner_text()
        self.assertIn("20", t1, "第1步警示应含 dupX=20：%r" % t1)
        self.assertIn("折返", t1)
        # 第 2 步：统计区警示含 "20" 与 "40"
        self.goto_step(page, 2)
        page.wait_for_selector(
            '.dw-step[data-step="2"] [data-wizard-dupwarn]', timeout=10000)
        t2 = " ".join(page.locator(
            '.dw-step[data-step="2"] [data-wizard-dupwarn]'
        ).all_inner_texts())
        self.assertIn("20", t2, "第2步警示应含 dupX=20：%r" % t2)
        self.assertIn("40", t2, "第2步警示应含 dupPoints=40：%r" % t2)
        page.context.close()

        # 无重复数据（每条线每个 x 一个点）→ 不显示警示
        nodup = tempfile.NamedTemporaryFile(
            "w", suffix=".csv", delete=False, encoding="utf-8")
        try:
            nodup.write("time,value,category\n"
                        "2024-01-01,1,A\n2024-01-02,2,A\n"
                        "2024-01-01,3,B\n2024-01-02,4,B\n")
            nodup.close()
            page2 = self.open_page(1024, 689)
            self.open_wizard(page2, nodup.name)
            page2.wait_for_timeout(600)
            self.assertEqual(
                page2.locator("[data-wizard-dupwarn]").count(), 0,
                "无重复数据不应有折返警示")
            self.goto_step(page2, 2)
            page2.wait_for_timeout(400)
            self.assertEqual(
                page2.locator(
                    '.dw-step[data-step="2"] [data-wizard-dupwarn]').count(), 0,
                "第2步不应有折返警示")
            page2.context.close()
        finally:
            Path(nodup.name).unlink(missing_ok=True)

    # ------------------------------------------------ G19/G20 用例 ----

    CHARTS_JS = r"""
() => {
  const d = window.App && window.App.doc;
  const charts = ((d && d.elements) || []).filter(e => e && e.type === 'chart');
  return charts.map(c => ({
    id: c.id, name: c.name || null,
    inline: (c.chart && c.chart.data && c.chart.data.inline) ? {
      columns: c.chart.data.inline.columns.slice(),
      rows: c.chart.data.inline.rows
    } : null,
    source_info: (c.chart && c.chart.data) ? (c.chart.data.source_info || null) : null,
    bbox: {x: c.x_mm, y: c.y_mm, w: c.width_mm, h: c.height_mm}
  }));
}
"""
    HISTORY_JS = ("() => (((window.App && window.App.doc && "
                  "window.App.doc.history) || []).map(h => h.label || ''))")
    WIZ_JS = ("() => { const w = window.__lastDataWizard; return w ? {"
              "data: w.data(), edits: w.edits(), "
              "parse: w.parseState ? w.parseState() : null} : null; }")

    def _write_csv(self, name, text):
        p = Path(self.fixtures) / name
        p.write_text(text, encoding="utf-8")
        return str(p)

    def _cell(self, page, row, col):
        return page.locator(
            'td[data-cell-row="%d"][data-cell-col="%s"]' % (row, col))

    def _edit_cell(self, page, row, col, text, commit="enter"):
        cell = self._cell(page, row, col)
        cell.dblclick()
        page.wait_for_selector(".dw-cell-input", timeout=5000)
        if text is not None:
            page.keyboard.type(text)
        if commit == "enter":
            page.keyboard.press("Enter")
        else:
            page.keyboard.press("Escape")
        page.wait_for_timeout(400)

    def test_11_cell_edit_marks(self):
        """11：双击数值格改值 → Enter：新值显示、dw-cell-edited、title 含原值、
        「已修改 1 个单元格」、仍在第 1 步、对话框未关；另一格 Esc 取消。"""
        csv = self._write_csv("edit1.csv", "grp,val\nA,1.5\nB,2.5\nC,3.5\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector('td[data-cell-row="0"]', timeout=10000)
        # 原值 1.5
        self.assertEqual(self._cell(page, 0, "val").inner_text().strip(), "1.5")
        self._edit_cell(page, 0, "val", "9.5", "enter")
        cell = self._cell(page, 0, "val")
        self.assertIn("9.5", cell.inner_text())
        self.assertIn("dw-cell-edited", cell.get_attribute("class") or "")
        self.assertIn("1.5", cell.get_attribute("title") or "")
        page.wait_for_selector("[data-wizard-edits-count]", timeout=5000)
        self.assertIn("已修改 1 个单元格",
                      page.locator("[data-wizard-edits-count]").inner_text())
        # 仍在第 1 步、对话框未关
        self.assertEqual(page.locator(".dw-stepbtn-on").get_attribute("data-step-btn"), "1")
        self.assertTrue(page.locator(".dw-modal").count() >= 1)
        # handle.edits() 一致
        wiz = page.evaluate(self.WIZ_JS)
        self.assertEqual(len(wiz["edits"]), 1)
        self.assertEqual(wiz["edits"][0]["to"], 9.5)
        # 另一格进入编辑后 Esc：值不变、对话框仍在
        self._edit_cell(page, 1, "val", "8.8", "escape")
        self.assertEqual(self._cell(page, 1, "val").inner_text().strip(), "2.5")
        self.assertTrue(page.locator(".dw-modal").count() >= 1)
        self.assertEqual(len(page.evaluate(self.WIZ_JS)["edits"]), 1)
        page.context.close()

    def test_11b_edit_updates_preview_and_stats(self):
        """11b：改一格后预览 SVG 变化，且第 4 步行统计基于新数据。"""
        csv = self._write_csv("editb.csv", "grp,val\nA,1.5\nB,2.5\nC,3.5\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector('td[data-cell-row="0"]', timeout=10000)
        before_svg = page.evaluate(
            "document.querySelector('[data-wizard-preview]') ? "
            "document.querySelector('[data-wizard-preview]').innerHTML : ''")
        # 把 val 列一个数值改成缺失（NA）→ 该行应被排除，统计变化
        self._edit_cell(page, 0, "val", "NA", "enter")
        page.wait_for_timeout(500)
        after_svg = page.evaluate(
            "document.querySelector('[data-wizard-preview]') ? "
            "document.querySelector('[data-wizard-preview]').innerHTML : ''")
        self.assertNotEqual(before_svg, after_svg, "改单元格后预览 SVG 应变化")
        self.goto_step(page, 4)
        page.wait_for_timeout(400)
        summary = page.locator('[data-wizard-confirm]').inner_text()
        # 3 行中 1 行缺失 → 预计画出 2 行（bar 按分类聚合，缺失行排除）
        self.assertTrue(("2 行" in summary) or ("排除" in summary),
                        "第4步统计应基于新数据：%r" % summary[:200])
        page.context.close()

    def test_11c_scroll_and_focus_preserved(self):
        """11c：>60 行 CSV，展开更多后改靠下的格子，滚动位置与焦点保留。"""
        rows = "".join("g%d,%d\n" % (i, i + 0.5) for i in range(120))
        csv = self._write_csv("editc.csv", "grp,val\n" + rows)
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector("[data-wizard-showmore]", timeout=10000)
        page.locator("[data-wizard-showmore]").click()
        page.wait_for_timeout(400)
        # 滚动表格到下方
        page.evaluate(
            "var w=document.querySelector('.dw-table-wrap');"
            "if(w){w.scrollTop=w.scrollHeight;}")
        page.wait_for_timeout(200)
        # 改第 80 行（0 基）的 val；scroll_into_view 会合法改变滚动，
        # 因此在编辑提交前（格子已定位）重新采样「重建前」的滚动位置。
        cell = self._cell(page, 80, "val")
        cell.scroll_into_view_if_needed()
        page.wait_for_timeout(200)
        st_before = page.evaluate(
            "var w=document.querySelector('.dw-table-wrap');"
            "w ? w.scrollTop : -1")
        cell.dblclick()
        page.wait_for_selector(".dw-cell-input", timeout=5000)
        page.keyboard.type("777")
        page.keyboard.press("Enter")
        page.wait_for_timeout(500)
        st_after = page.evaluate(
            "var w=document.querySelector('.dw-table-wrap');"
            "w ? w.scrollTop : -1")
        self.assertLessEqual(abs(st_after - st_before), 2,
                             "重建后 scrollTop 应保留：before=%s after=%s" % (st_before, st_after))
        # 焦点回到该格
        focused = page.evaluate(
            "document.activeElement && document.activeElement.getAttribute"
            " ? document.activeElement.getAttribute('data-cell-row') : null")
        self.assertEqual(focused, "80", "焦点应回到刚编辑的格子")
        page.context.close()

    def test_12_create_after_edit_provenance(self):
        """12：编辑后创建 → inline 为新值；sha256 同原文件；manual_edits 正确；
        指纹关系正确；历史恰好一条；撤销后图表消失。"""
        csv = self._write_csv("edit2.csv", "grp,val\nA,1.5\nB,2.5\nC,3.5\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector('td[data-cell-row="0"]', timeout=10000)
        self._edit_cell(page, 0, "val", "9.5", "enter")
        h0 = len(page.evaluate(self.HISTORY_JS))
        self.goto_step(page, 4)
        self.create_via_footer(page)
        self.wait_overlays(page, 0, timeout=20000)
        charts = page.evaluate(self.CHARTS_JS)
        self.assertEqual(len(charts), 1)
        ch = charts[0]
        # inline 含新值 9.5
        self.assertIn(9.5, [r[1] for r in ch["inline"]["rows"]])
        si = ch["source_info"] or {}
        self.assertTrue(si.get("sha256"), "source_info.sha256 应存在")
        me = si.get("manual_edits") or {}
        self.assertEqual(me.get("count"), 1)
        cell0 = (me.get("cells") or [{}])[0]
        self.assertEqual(cell0.get("row"), 0)
        self.assertEqual(cell0.get("column"), "val")
        self.assertEqual(cell0.get("from"), 1.5)
        self.assertEqual(cell0.get("to"), 9.5)
        self.assertTrue((si.get("value_fingerprint") or {}).get("sha256"))
        self.assertTrue((me.get("parsed_value_fingerprint") or {}).get("sha256"))
        hist = page.evaluate(self.HISTORY_JS)
        self.assertEqual(len(hist), h0 + 1, "必须恰好一条新历史")
        # 第二次导入同文件不改 → parsed_value_fingerprint 应等于其 value_fingerprint
        self.open_wizard(page, csv)
        page.wait_for_selector('td[data-cell-row="0"]', timeout=10000)
        # R3 标签页：画布非空时默认「新建画布标签页」；本用例断言同画布
        # 两张图，显式选「放到当前画布」再创建
        self.goto_step(page, 3)
        page.locator('input[name="wizard-place"]').nth(1).check()
        page.wait_for_timeout(200)
        self.goto_step(page, 4)
        self.create_via_footer(page)
        self.wait_overlays(page, 0, timeout=20000)
        charts2 = page.evaluate(self.CHARTS_JS)
        self.assertEqual(len(charts2), 2)
        si2 = charts2[1]["source_info"] or {}
        self.assertEqual(si2.get("sha256"), si.get("sha256"),
                         "同一文件 sha256 应相同")
        self.assertNotIn("manual_edits", si2, "无修改导入不应有 manual_edits")
        self.assertEqual(
            (me.get("parsed_value_fingerprint") or {}).get("sha256"),
            (si2.get("value_fingerprint") or {}).get("sha256"),
            "parsed_value_fingerprint 应等于未修改导入的 value_fingerprint")
        self.assertNotEqual(
            (si.get("value_fingerprint") or {}).get("sha256"),
            (si2.get("value_fingerprint") or {}).get("sha256"),
            "修改后 value_fingerprint 应不同")
        page.context.close()

    def test_13_revert_clears_edits(self):
        """13：改回原值 → 修改清单为空；「全部还原」同理。"""
        csv = self._write_csv("edit3.csv", "grp,val\nA,1.5\nB,2.5\nC,3.5\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector('td[data-cell-row="0"]', timeout=10000)
        self._edit_cell(page, 0, "val", "9.5", "enter")
        self.assertEqual(len(page.evaluate(self.WIZ_JS)["edits"]), 1)
        # 改回原值 1.5
        self._edit_cell(page, 0, "val", "1.5", "enter")
        page.wait_for_timeout(300)
        self.assertEqual(len(page.evaluate(self.WIZ_JS)["edits"]), 0,
                         "改回原值后修改记录应移除")
        self.assertEqual(page.locator("[data-wizard-edits-count]").count(), 0)
        # 再改一格后用「全部还原」
        self._edit_cell(page, 1, "val", "8.8", "enter")
        self.assertEqual(len(page.evaluate(self.WIZ_JS)["edits"]), 1)
        page.locator("[data-wizard-revert-all]").click()
        page.wait_for_timeout(400)
        self.assertEqual(len(page.evaluate(self.WIZ_JS)["edits"]), 0)
        page.context.close()

    def test_14_kind_flip_on_edit(self):
        """14：数值列混一个 "abc" → 徽标「文本」；改成数字后徽标「数值」，
        且 handle.data() 与徽标一致。"""
        csv = self._write_csv("edit4.csv", "name,val\nA,1\nB,abc\nC,3\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector('td[data-cell-row="1"]', timeout=10000)
        # val 列徽标应为「文本」
        badge = page.locator(
            '.dw-table th[data-col], th:has-text("val") .dw-badge-num, '
            'th:has-text("val") .dw-badge-text')
        # 更直接：找 val 列头的徽标文字
        th = page.locator(".dw-table thead th").filter(has_text="val")
        self.assertIn("文本", th.inner_text(), "含 abc 的列应为「文本」")
        # 把 B 行 val 的 abc 改成 5
        self._edit_cell(page, 1, "val", "5", "enter")
        page.wait_for_timeout(400)
        th2 = page.locator(".dw-table thead th").filter(has_text="val")
        self.assertIn("数值", th2.inner_text(), "改成数字后应为「数值」")
        wiz = page.evaluate(self.WIZ_JS)
        # handle.data() 中该格为数字 5
        d = wiz["data"]
        self.assertEqual(d["rows"][1][1], 5)
        page.context.close()

    def test_15_no_edit_no_provenance_keys(self):
        """15：不做任何修改导入 → source_info 不含 manual_edits / parse_options。"""
        csv = self._write_csv("noedit.csv", "grp,val\nA,1.5\nB,2.5\nC,3.5\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector('td[data-cell-row="0"]', timeout=10000)
        page.locator("[data-wizard-quick]").click()
        self.wait_overlays(page, 0, timeout=20000)
        charts = page.evaluate(self.CHARTS_JS)
        self.assertEqual(len(charts), 1)
        si = charts[0]["source_info"] or {}
        self.assertNotIn("manual_edits", si)
        self.assertNotIn("parse_options", si)
        page.context.close()

    def test_16_decimal_comma_parse_options(self):
        """16：分号+小数逗号 → 提示条、y 徽标「文本」；点应用 → y「数值」、
        数字写法=逗号是小数点；创建后 inline 数值、parse_options 正确、sha256 原样。"""
        csv = self._write_csv("dec.csv", "x;y\n1;3,14\n2;2,5\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector("[data-wizard-parse-hint]", timeout=10000)
        hint = page.locator("[data-wizard-parse-hint]").inner_text()
        self.assertIn("逗号作小数点", hint)
        # y 徽标初始「文本」
        thy = page.locator(".dw-table thead th").filter(has_text="y")
        self.assertIn("文本", thy.inner_text())
        # 点「按「逗号是小数点」读取」
        page.locator('[data-parse-apply="comma_decimal"]').click()
        page.wait_for_timeout(600)
        thy2 = page.locator(".dw-table thead th").filter(has_text="y")
        self.assertIn("数值", thy2.inner_text(), "应用后 y 应为「数值」")
        wiz = page.evaluate(self.WIZ_JS)
        self.assertEqual(wiz["parse"]["numberFormat"], "comma_decimal")
        # 创建
        self.goto_step(page, 4)
        self.create_via_footer(page)
        self.wait_overlays(page, 0, timeout=20000)
        charts = page.evaluate(self.CHARTS_JS)
        self.assertEqual(len(charts), 1)
        inline = charts[0]["inline"]
        # y 列（第 2 列）应为数值
        self.assertIsInstance(inline["rows"][0][1], (int, float))
        self.assertAlmostEqual(inline["rows"][0][1], 3.14)
        si = charts[0]["source_info"] or {}
        self.assertEqual(si.get("parse_options"),
                         {"delimiter": ";", "number_format": "comma_decimal"})
        self.assertTrue(si.get("sha256"), "sha256 应为原始字节哈希")
        self.assertNotIn("manual_edits", si)
        page.context.close()

    def test_16b_unchanged_edit_in_decimal_mode(self):
        """16b：逗号是小数点模式下，双击数值格不改直接 Enter → 无修改、仍「数值」。"""
        csv = self._write_csv("dec2.csv", "x;y\n1;3,14\n2;2,5\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector('[data-parse-apply="comma_decimal"]', timeout=10000)
        page.locator('[data-parse-apply="comma_decimal"]').click()
        page.wait_for_timeout(600)
        # 此时 y 列已是数值；双击 y 第 0 行（显示 3.14）不改直接 Enter
        self._edit_cell(page, 0, "y", None, "enter")
        page.wait_for_timeout(400)
        self.assertEqual(len(page.evaluate(self.WIZ_JS)["edits"]), 0,
                         "未改动提交不应产生修改记录")
        thy = page.locator(".dw-table thead th").filter(has_text="y")
        self.assertIn("数值", thy.inner_text())
        page.context.close()

    def test_17_parse_change_confirm_cancel(self):
        """17：有 1 处修改时改数字写法 → 确认框；取消后修改仍在、下拉恢复。"""
        csv = self._write_csv("dec3.csv", "x;y\n1;3,14\n2;2,5\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        page.wait_for_selector('td[data-cell-row="0"]', timeout=10000)
        # 先改单元格（x 列第 0 行：1 → 7）
        self._edit_cell(page, 0, "x", "7", "enter")
        self.assertEqual(len(page.evaluate(self.WIZ_JS)["edits"]), 1)
        # 改数字写法下拉 → 有修改 → 应弹确认框（第二个 overlay）
        page.locator('[data-parse-numberformat]').select_option("comma_decimal")
        page.wait_for_timeout(400)
        self.wait_overlays(page, 2, timeout=5000)
        # 点取消（确认框在最上层 overlay）
        cancel = page.locator(".ui-modal-overlay").last.locator(
            ".ui-modal-footer button").filter(has_text="取消")
        box = cancel.bounding_box()
        self.assertIsNotNone(box, "确认框缺少「取消」")
        page.mouse.click(box["x"] + box["width"] / 2,
                         box["y"] + box["height"] / 2)
        page.wait_for_timeout(500)
        self.wait_overlays(page, 1, timeout=5000)
        # 修改仍在、下拉恢复 plain
        self.assertEqual(len(page.evaluate(self.WIZ_JS)["edits"]), 1,
                         "取消后修改应保留")
        self.assertEqual(page.evaluate(self.WIZ_JS)["parse"]["numberFormat"],
                         "plain", "取消后下拉应恢复原值")
        page.context.close()

    def test_18_no_parse_row_for_excel_and_json(self):
        """18：Excel 与 JSON 导入没有「读取方式」行。"""
        # JSON：粘贴/文件导入 .json → parseJSON，无 parse 接缝
        js = self._write_csv("t.json",
            '{"columns":["x","y"],"rows":[[1,2],[3,4]]}')
        page = self.open_page(1024, 689)
        self.open_wizard(page, js)
        page.wait_for_timeout(600)
        self.assertEqual(page.locator("[data-wizard-parse]").count(), 0,
                         "JSON 导入不应有「读取方式」行")
        page.context.close()
        # Excel
        if self.xlsx_path:
            page2 = self.open_page(1024, 689)
            with page2.expect_file_chooser() as fc_info:
                self.import_button(page2, "导入数据").click()
            fc_info.value.set_files(self.xlsx_path)
            page2.wait_for_selector(".ui-modal", timeout=30000)
            cont = page2.locator(".ui-modal-footer button").filter(has_text="继续")
            box = cont.bounding_box()
            page2.mouse.click(box["x"] + box["width"] / 2,
                              box["y"] + box["height"] / 2)
            page2.wait_for_selector(".dw-modal", timeout=20000)
            page2.wait_for_timeout(500)
            self.assertEqual(page2.locator("[data-wizard-parse]").count(), 0,
                             "Excel 导入不应有「读取方式」行")
            page2.context.close()

    def test_20_modal_keys_title_input_scope(self):
        """20：收窄 data-modal-keys——标题框内 Enter 触发主按钮（下一步），
        改过标题后标题框内 Esc 出「放弃本次导入设置？」确认；
        单元格编辑 input 自带 data-modal-keys=own，Enter/Esc 仍自理（test_11 覆盖）。"""
        csv = self._write_csv("keys1.csv", "x,y\n1,2\n3,4\n")
        page = self.open_page(1024, 689)
        self.open_wizard(page, csv)
        # (a) 第 3 步标题输入框聚焦后按 Enter → 触发当前主按钮进入第 4 步
        self.goto_step(page, 3)
        title = page.locator('.dw-title')
        title.click()
        page.wait_for_timeout(200)
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        self.assertEqual(
            page.locator(".dw-stepbtn-on").get_attribute("data-step-btn"), "4",
            "标题框内 Enter 应触发主按钮进入第 4 步")
        # (b) 回第 3 步改标题 → 焦点仍在标题框按 Esc → dirty 确认框
        self.goto_step(page, 3)
        title = page.locator('.dw-title')
        title.click()
        page.keyboard.type("新标题")
        page.wait_for_timeout(200)
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        self.wait_overlays(page, 2, timeout=5000)
        self.assertIn("放弃本次导入设置",
                      page.evaluate(TOP_OVERLAY_TEXT_JS))
        page.context.close()


if __name__ == "__main__":
    unittest.main()
