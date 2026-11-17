# -*- coding: utf-8 -*-
"""test_modal_layout.py — Ui.modal 对话框布局与键盘行为（Playwright）。

覆盖三种视口（960×600 / 1024×689 / 1280×860）下五类对话框的几何断言
（✕/取消/主按钮中心在视口内、elementFromPoint 命中按钮自身、.ui-modal
背景不透明），以及真实 mouse/keyboard 的行为用例：

  a) 粘贴框聚焦 textarea → 输入 → Esc 弹确认 → 再 Esc 只关确认 →
     点 ✕ 再确认 → 两层都关闭；
  b) 粘贴框 dirty 时点遮罩不关闭，空时点遮罩关闭；
  c) 向导改映射下拉 → Esc 弹「放弃本次导入设置？」→ 取消后向导仍在；
  d) 焦点在模板 radio 上按 Enter 触发「创建图表」（文档 +1 历史）；
  e) 1024×689 下真实鼠标点击「创建图表」成功（本次修复的 P0）。

需要 Python playwright + 可用浏览器（chromium 或系统 Chrome）；不可用时
整体 skip，不判失败。交互一律用 page.mouse / page.keyboard 真实输入；
仅状态断言用只读 evaluate。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent      # mcp/
ROOT = HERE.parent                           # bundle root
VIEWER = HERE / "viewer.py"
SAMPLE_CSV = ROOT / "examples" / "sample.csv"
VIEWPORTS = [(960, 600), (1024, 689), (1280, 860)]


def _launch_chromium(playwright):
    try:
        return playwright.chromium.launch(headless=True)
    except Exception:
        return playwright.chromium.launch(headless=True, channel="chrome")


def _playwright_ready():
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return False
    try:
        with sync_playwright() as pw:
            browser = _launch_chromium(pw)
            browser.close()
        return True
    except Exception:
        return False


HAS_PLAYWRIGHT = _playwright_ready()


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _make_xlsx(path):
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append(["condition", "value_a", "value_b"])
    ws.append(["ctrl", 1.0, 10.1])
    ws.append(["trt", 2.1, 20.3])
    ws.append(["trt", 2.4, 21.0])
    wb.save(str(path))


SVG_FIXTURE = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" '
    'viewBox="0 0 120 90">'
    '<rect x="10" y="10" width="40" height="30" fill="#4f8ef7"/>'
    '<text x="60" y="40" font-size="10">modal-test</text></svg>'
)

# ---- 只读 DOM 断言用 JS（不模拟任何输入） ---------------------------------

MEASURE_JS = r"""
() => {
  const overlays = [...document.querySelectorAll('#modal-root > .ui-modal-overlay')];
  const top = overlays[overlays.length - 1];
  if (!top) return {count: overlays.length, title: '', dialog: null, buttons: []};
  const dlg = top.querySelector('.ui-modal');
  const rec = {count: overlays.length, buttons: []};
  const titleEl = top.querySelector('.ui-modal-title');
  rec.title = titleEl ? (titleEl.textContent || '').trim() : '';
  if (!dlg) return rec;
  const r = dlg.getBoundingClientRect();
  const cs = getComputedStyle(dlg);
  rec.dialog = {w: r.width, h: r.height, top: r.top, left: r.left,
                right: r.right, bottom: r.bottom, bg: cs.backgroundColor};
  const items = [];
  const close = top.querySelector('.ui-modal-close');
  if (close) items.push({kind: 'close', label: '✕', el: close});
  top.querySelectorAll('.ui-modal-footer button').forEach(b => {
    items.push({kind: b.classList.contains('ui-btn-primary') ? 'primary' : 'action',
                label: (b.textContent || '').trim(), el: b});
  });
  rec.buttons = items.map(b => {
    const br = b.el.getBoundingClientRect();
    const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {kind: b.kind, label: b.label, cx: cx, cy: cy,
      inView: cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight,
      hitSelf: !!(hit && (hit === b.el || b.el.contains(hit))),
      hitTag: hit ? hit.tagName : 'null'};
  });
  return rec;
}
"""

OVERLAY_COUNT_JS = (
    "document.querySelectorAll('#modal-root > .ui-modal-overlay').length")

TOP_OVERLAY_TEXT_JS = r"""
() => {
  const ovs = [...document.querySelectorAll('#modal-root > .ui-modal-overlay')];
  const top = ovs[ovs.length - 1];
  return top ? (top.textContent || '') : '';
}
"""

# 顶层 overlay 中按文本找 footer 按钮 / ✕，返回视口坐标（供真实鼠标点击）。
TOP_BUTTON_CENTER_JS = r"""
(spec) => {
  const ovs = [...document.querySelectorAll('#modal-root > .ui-modal-overlay')];
  const ov = ovs[ovs.length - 1];
  if (!ov) return null;
  let el = null;
  if (spec.sel === '.ui-modal-close') {
    el = ov.querySelector('.ui-modal-close');
  } else {
    const btns = [...ov.querySelectorAll('.ui-modal-footer button')];
    el = btns.find(b => (b.textContent || '').trim() === spec.text) ||
         btns.find(b => (b.textContent || '').includes(spec.text || ''));
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {x: r.left + r.width / 2, y: r.top + r.height / 2,
          disabled: !!el.disabled, hidden: !!el.hidden};
}
"""

DOC_STATS_JS = r"""
() => {
  const d = window.App && window.App.doc;
  if (!d) return null;
  return {elements: (d.elements || []).length,
          history: (d.history || []).length,
          types: (d.elements || []).map(e => e && e.type)};
}
"""

ACTIVE_TAG_JS = (
    "document.activeElement ? document.activeElement.tagName : ''")
ACTIVE_ROLE_JS = (
    "document.activeElement ? (document.activeElement.getAttribute('data-role') || '') : ''")

# 导出对话框是自包含 overlay（非 .ui-modal），用 data-export-dialog 定位。
# 断言三段式：panel 在视口内、footer 按钮可见且 elementFromPoint 命中、
# body 可滚动到最后一个控件。
EXPORT_GEOMETRY_JS = r"""
() => {
  const panel = document.querySelector('[data-export-dialog="true"]');
  if (!panel) return {found: false};
  const rec = {found: true, buttons: []};
  const pr = panel.getBoundingClientRect();
  rec.panelInView = pr.top >= -0.5 && pr.bottom <= innerHeight + 0.5 &&
                    pr.left >= -0.5 && pr.right <= innerWidth + 0.5;
  const kids = [...panel.children];
  const body = kids.find(k => k && k.style && k.style.overflowY === 'auto');
  const footer = kids[kids.length - 1];
  rec.structure = kids.map(k => k.tagName);
  rec.hasScrollBody = !!body;
  rec.footerIsLast = !!(footer && footer !== body);
  if (body) {
    rec.bodyOverflow = body.scrollHeight - body.clientHeight;
    body.scrollTop = body.scrollHeight;   // 滚到底
    rec.scrolled = body.scrollTop > 0;
    // 最后一个「可见」直接子元素（progressArea/warnLine 默认 display:none，跳过）
    let lastVis = null;
    for (let i = body.children.length - 1; i >= 0; i--) {
      const ch = body.children[i];
      if (ch && ch.getClientRects && ch.getClientRects().length > 0) {
        lastVis = ch; break;
      }
    }
    if (lastVis) {
      const lr = lastVis.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      rec.lastControlReachable = lr.bottom <= br.bottom + 1 && lr.top >= br.top - 1;
      rec.lastControlText = (lastVis.textContent || '').replace(/\s+/g, ' ').slice(0, 40);
    }
  }
  if (footer) {
    [...footer.querySelectorAll('button')].forEach(b => {
      const br = b.getBoundingClientRect();
      const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      rec.buttons.push({
        label: (b.textContent || '').trim(),
        inView: cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight,
        hitSelf: !!(hit && (hit === b || b.contains(hit))),
        disabled: !!b.disabled
      });
    });
  }
  return rec;
}
"""


class _ViewerServer:
    def __init__(self, data_dir, env_extra=None):
        self.data_dir = data_dir
        self.port = _free_port()
        env = dict(os.environ)
        env["FIGURE_DATA_DIR"] = data_dir
        env.pop("ELECTRON_RUN_AS_NODE", None)
        if env_extra:
            env.update(env_extra)
        self.proc = subprocess.Popen(
            [sys.executable, "-B", str(VIEWER), "--port", str(self.port)],
            cwd=str(HERE), env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.base = "http://127.0.0.1:%d" % self.port

    def wait_ready(self, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    "viewer.py 提前退出 rc=%s" % self.proc.returncode)
            try:
                with urllib.request.urlopen(
                        self.base + "/api/data-dirs", timeout=2) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                if payload.get("ok") and payload.get("data_dir_env_set"):
                    return payload
            except Exception:
                pass
            time.sleep(0.25)
        raise RuntimeError("viewer.py 30s 内未就绪")

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass


@unittest.skipUnless(HAS_PLAYWRIGHT,
                     "Python playwright + chromium/Chrome 不可用，跳过")
class ModalLayoutTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-modal-data-")
        cls.fixtures = tempfile.mkdtemp(prefix="fig-modal-fix-")
        cls.server = _ViewerServer(cls.datadir)
        try:
            cls.server.wait_ready()
        except Exception:
            cls.server.stop()
            shutil.rmtree(cls.datadir, ignore_errors=True)
            shutil.rmtree(cls.fixtures, ignore_errors=True)
            raise
        cls.csv_path = str(SAMPLE_CSV)
        cls.xlsx_path = str(Path(cls.fixtures) / "modal-fixture.xlsx")
        cls.svg_path = str(Path(cls.fixtures) / "modal-fixture.svg")
        try:
            _make_xlsx(cls.xlsx_path)
        except Exception as exc:
            cls.xlsx_path = None
            cls._xlsx_error = exc
        else:
            cls._xlsx_error = None
        Path(cls.svg_path).write_text(SVG_FIXTURE, encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        shutil.rmtree(cls.datadir, ignore_errors=True)
        shutil.rmtree(cls.fixtures, ignore_errors=True)

    # ---------------------------------------------------------- helpers

    def setUp(self):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self.browser = _launch_chromium(self._pw)

    def tearDown(self):
        try:
            self.browser.close()
        finally:
            self._pw.stop()

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

    def overlay_count(self, page):
        return page.evaluate(OVERLAY_COUNT_JS)

    def measure(self, page):
        return page.evaluate(MEASURE_JS)

    def wait_overlays(self, page, count, timeout=15000):
        page.wait_for_function(
            "document.querySelectorAll('#modal-root > .ui-modal-overlay')"
            ".length === %d" % count, timeout=timeout)

    def click_top_button(self, page, spec):
        """真实鼠标点击顶层 overlay 中指定按钮，返回是否点击成功。"""
        center = page.evaluate(TOP_BUTTON_CENTER_JS, spec)
        if not center:
            return False
        page.mouse.click(center["x"], center["y"])
        return True

    # ---- A2：右侧页签在三种视口下文字完整、不引入横向滚动条 ----
    TABS_JS = r"""
() => {
  const tabs = document.getElementById('tabs');
  if (!tabs) return {found: false};
  const btns = [...tabs.querySelectorAll('button')].map(b => ({
    text: (b.textContent || '').trim(),
    sw: b.scrollWidth, cw: b.clientWidth,
    visible: b.getBoundingClientRect().width > 0
  }));
  return {found: true,
          tabsScrollW: tabs.scrollWidth, tabsClientW: tabs.clientWidth,
          buttons: btns};
}
"""

    def test_side_tabs_fully_visible_all_viewports(self):
        """A2：960×600 / 1024×689 / 1280×860 下每个页签 scrollWidth<=clientWidth，
        「实体关系」等标签完整，无横向滚动条。"""
        for vw, vh in VIEWPORTS:
            page = self.open_page(vw, vh)
            try:
                page.wait_for_selector("#tabs button", timeout=10000)
                page.wait_for_timeout(300)
                r = page.evaluate(self.TABS_JS)
                self.assertTrue(r.get("found"), "%dx%d：缺少 #tabs" % (vw, vh))
                self.assertTrue(r["buttons"], "%dx%d：无页签按钮" % (vw, vh))
                for b in r["buttons"]:
                    self.assertLessEqual(
                        b["sw"], b["cw"] + 1,
                        "%dx%d：页签「%s」被裁切 sw=%s cw=%s" %
                        (vw, vh, b["text"], b["sw"], b["cw"]))
                # 「实体关系」页签必须存在且文字完整
                ent = [b for b in r["buttons"] if "实体关系" in b["text"]]
                self.assertTrue(ent, "%dx%d：缺少「实体关系」页签：%r" %
                                (vw, vh, [b["text"] for b in r["buttons"]]))
                self.assertNotIn("实体关\n", ent[0]["text"])
                self.assertEqual(ent[0]["text"].strip(), "实体关系")
                # 不引入横向滚动条
                self.assertLessEqual(r["tabsScrollW"], r["tabsClientW"] + 1,
                                     "%dx%d：#tabs 出现横向滚动" % (vw, vh))
            finally:
                page.context.close()

    def assert_dialog_geometry(self, meas, vw, vh, label):
        self.assertIsNotNone(meas.get("dialog"),
                             "%s：未找到 .ui-modal" % label)
        dlg = meas["dialog"]
        self.assertGreaterEqual(dlg["top"], -0.5,
                                "%s：对话框顶部超出视口 %s" % (label, dlg))
        self.assertLessEqual(dlg["bottom"], vh + 0.5,
                             "%s：对话框底部超出视口 %s" % (label, dlg))
        self.assertGreaterEqual(dlg["left"], -0.5,
                                "%s：对话框左侧超出视口 %s" % (label, dlg))
        self.assertLessEqual(dlg["right"], vw + 0.5,
                             "%s：对话框右侧超出视口 %s" % (label, dlg))
        # 背景必须不透明（rgb() 无 alpha；rgba 末位必须为 1）
        bg = dlg["bg"]
        opaque = bg.startswith("rgb(") or (
            bg.startswith("rgba(") and bg.rstrip(")").split(",")[-1].strip() == "1")
        self.assertTrue(opaque, "%s：.ui-modal 背景非不透明：%s" % (label, bg))
        buttons = meas.get("buttons") or []
        self.assertTrue(buttons, "%s：对话框没有可测按钮" % label)
        for btn in buttons:
            self.assertTrue(btn["inView"],
                            "%s：按钮「%s」中心在视口外 %s"
                            % (label, btn["label"], btn))
            self.assertTrue(btn["hitSelf"],
                            "%s：elementFromPoint 未命中按钮「%s」（%s）"
                            % (label, btn["label"], btn))

    # ------------------------------------------------- dialog openers

    def open_data_wizard(self, page, path=None):
        path = path or self.csv_path
        with page.expect_file_chooser() as fc_info:
            self.import_button(page, "导入数据").click()
        fc_info.value.set_files(path)
        page.wait_for_selector(".ui-modal", timeout=20000)
        self.wait_overlays(page, 1)

    def open_excel_preview(self, page):
        if not self.xlsx_path:
            self.skipTest("openpyxl 不可用，无法生成 xlsx 夹具：%r"
                          % getattr(self, "_xlsx_error", None))
        with page.expect_file_chooser() as fc_info:
            self.import_button(page, "导入数据").click()
        fc_info.value.set_files(self.xlsx_path)
        page.wait_for_selector(".ui-modal", timeout=30000)
        self.wait_overlays(page, 1)

    def open_svg_choice(self, page):
        with page.expect_file_chooser() as fc_info:
            self.import_button(page, "导入 SVG").click()
        fc_info.value.set_files(self.svg_path)
        page.wait_for_selector(".ui-modal", timeout=20000)
        self.wait_overlays(page, 1)

    def open_paste(self, page):
        self.import_button(page, "粘贴数据").click()
        page.wait_for_selector(".ui-modal", timeout=10000)
        self.wait_overlays(page, 1)

    def open_diff(self, page):
        page.locator("#tab-history").click()
        page.wait_for_selector("#panel-history:not(.hidden)", timeout=10000)
        page.get_by_role("button", name="版本对比", exact=True).click()
        page.wait_for_selector(".ui-modal", timeout=10000)
        self.wait_overlays(page, 1)

    def esc_close(self, page):
        page.keyboard.press("Escape")
        self.wait_overlays(page, 0, timeout=10000)

    def wizard_goto_step(self, page, n):
        page.locator('.dw-steps [data-step-btn="%d"]' % n).click()
        page.wait_for_timeout(200)

    def wizard_create_button(self, page):
        return page.locator(".ui-modal-footer button").filter(
            has_text="创建图表")

    # ------------------------------------------------------------ tests

    def test_dialog_layout_all_viewports(self):
        """3 视口 × 5 对话框：几何断言 + 向导真实点击建图。"""
        for vw, vh in VIEWPORTS:
            with self.subTest(viewport="%dx%d" % (vw, vh)):
                page = self.open_page(vw, vh)

                # 1) 数据向导（先建图，顺带给历史对比提供 rev）
                self.open_data_wizard(page)
                meas = self.measure(page)
                self.assertIn("导入数据向导", meas["title"])
                self.assert_dialog_geometry(meas, vw, vh, "数据向导")
                # P0：真实鼠标点击「创建图表」必须成功（第 4 步前它是
                # footer 中的普通按钮，始终可用）
                before = page.evaluate(DOC_STATS_JS)
                center = page.evaluate(
                    """() => {
                      const btns = [...document.querySelectorAll(
                        '.ui-modal-footer button')];
                      const b = btns.find(x => x.textContent.includes('创建图表'));
                      if (!b) return null;
                      const r = b.getBoundingClientRect();
                      return {x: r.left + r.width/2, y: r.top + r.height/2};
                    }""")
                self.assertIsNotNone(center, "向导缺少主按钮")
                self.assertTrue(0 <= center["x"] <= vw and 0 <= center["y"] <= vh,
                                "创建图表按钮中心在视口外：%s" % center)
                page.mouse.click(center["x"], center["y"])
                self.wait_overlays(page, 0, timeout=20000)
                after = page.evaluate(DOC_STATS_JS)
                self.assertIsNotNone(after and after["elements"])
                self.assertGreater(after["elements"], before["elements"],
                                   "真实点击创建图表后元素数未增加")
                self.assertEqual(after["history"], before["history"] + 1,
                                 "创建图表应只新增一条历史")

                # 2) Excel 导入预览
                self.open_excel_preview(page)
                meas = self.measure(page)
                self.assertIn("Excel", meas["title"])
                self.assert_dialog_geometry(meas, vw, vh, "Excel 导入预览")
                page.keyboard.press("Escape")
                self.wait_overlays(page, 0, timeout=10000)

                # 3) SVG 导入选择
                self.open_svg_choice(page)
                meas = self.measure(page)
                self.assertIn("导入 SVG", meas["title"])
                self.assert_dialog_geometry(meas, vw, vh, "SVG 导入选择")
                page.keyboard.press("Escape")
                self.wait_overlays(page, 0, timeout=10000)

                # 4) 粘贴数据（空态，Esc 直接关闭）
                self.open_paste(page)
                meas = self.measure(page)
                self.assert_dialog_geometry(meas, vw, vh, "粘贴数据")
                page.keyboard.press("Escape")
                self.wait_overlays(page, 0, timeout=10000)

                # 5) 历史 / 版本对比
                self.open_diff(page)
                meas = self.measure(page)
                self.assertIn("版本对比", meas["title"])
                self.assert_dialog_geometry(meas, vw, vh, "版本对比")
                page.keyboard.press("Escape")
                self.wait_overlays(page, 0, timeout=10000)
                page.context.close()

    def test_export_dialog_footer_buttons(self):
        """导出对话框三段式：底部 关闭/导出 在各视口可见可点，body 可滚到底。"""
        for vw, vh in VIEWPORTS:
            with self.subTest(viewport="%dx%d" % (vw, vh)):
                page = self.open_page(vw, vh)
                page.click("#btn-export")
                page.wait_for_selector('[data-export-dialog="true"]', timeout=15000)
                page.wait_for_timeout(300)
                meas = page.evaluate(EXPORT_GEOMETRY_JS)
                self.assertTrue(meas.get("found"), "未找到导出对话框")
                self.assertTrue(meas.get("panelInView"),
                                "导出面板应在视口内 %s" % meas.get("panelInView"))
                self.assertTrue(meas.get("hasScrollBody"), "应有可滚动 body")
                self.assertTrue(meas.get("footerIsLast"),
                                "按钮行应为 panel 最后一个子元素")
                labels = [b["label"] for b in meas.get("buttons", [])]
                close_btn = next((b for b in meas["buttons"]
                                  if "关闭" in b["label"]), None)
                export_btn = next((b for b in meas["buttons"]
                                   if "导出" in b["label"]), None)
                self.assertIsNotNone(close_btn, "缺少「关闭」按钮 %s" % labels)
                self.assertIsNotNone(export_btn, "缺少「导出」按钮 %s" % labels)
                for b in (close_btn, export_btn):
                    self.assertTrue(b["inView"],
                                    "按钮「%s」应在视口内 %s" % (b["label"], b))
                    self.assertTrue(b["hitSelf"],
                                    "elementFromPoint 应命中「%s」%s"
                                    % (b["label"], b))
                # 内容溢出时 body 可滚动，且滚到底后最后一个可见控件可达
                if meas.get("bodyOverflow", 0) > 0:
                    self.assertTrue(meas.get("scrolled"),
                                    "body 应可滚动（overflow=%s）"
                                    % meas.get("bodyOverflow"))
                    self.assertTrue(
                        meas.get("lastControlReachable"),
                        "body 滚到底后最后控件「%s」应可达"
                        % meas.get("lastControlText"))
                # Esc 仍可关闭（行为未改）
                page.keyboard.press("Escape")
                page.wait_for_selector('[data-export-dialog="true"]',
                                       state="detached", timeout=10000)
                page.context.close()

    def test_paste_esc_confirm_flow(self):
        """粘贴框：聚焦 textarea → 输入 → Esc 确认 → Esc 只关确认 → ✕ 确认全关。"""
        page = self.open_page(1024, 689)
        self.open_paste(page)

        self.assertEqual(page.evaluate(ACTIVE_ROLE_JS), "paste-data-area",
                         "粘贴框打开后焦点应在 textarea")
        page.keyboard.type("condition,value\nctrl,1\n", delay=15)
        self.assertGreater(
            page.evaluate(
                "document.querySelector('[data-role=paste-data-area]')"
                ".value.length"), 0)

        # Esc → 确认框出现（2 层），文本为「放弃本次粘贴？」
        page.keyboard.press("Escape")
        self.wait_overlays(page, 2)
        self.assertIn("放弃本次粘贴", page.evaluate(TOP_OVERLAY_TEXT_JS))

        # 再 Esc → 只关确认框，粘贴框仍在
        page.keyboard.press("Escape")
        self.wait_overlays(page, 1)
        self.assertIn("粘贴数据建图", page.evaluate(TOP_OVERLAY_TEXT_JS))

        # 点 ✕ → 再次确认 → 点「确定」→ 两层都关闭
        self.assertTrue(self.click_top_button(page, {"sel": ".ui-modal-close"}))
        self.wait_overlays(page, 2)
        self.assertTrue(self.click_top_button(page, {"text": "确定"}))
        self.wait_overlays(page, 0, timeout=10000)

    def test_overlay_click_dirty_and_clean(self):
        """遮罩点击：空粘贴框关闭；dirty 粘贴框不关闭也不弹确认。"""
        page = self.open_page(1024, 689)
        self.open_paste(page)

        # 空 → 点遮罩（左上角 padding 区，不在对话框上）→ 关闭
        page.mouse.click(10, 10)
        self.wait_overlays(page, 0, timeout=10000)

        # dirty → 点遮罩 → 仍打开，且没有确认框（仍是 1 层）
        self.open_paste(page)
        page.keyboard.type("a,b\n1,2", delay=10)
        page.mouse.click(10, 10)
        page.wait_for_timeout(400)
        self.assertEqual(self.overlay_count(page), 1,
                         "dirty 粘贴框点遮罩不应关闭或弹确认")
        self.assertIn("粘贴数据建图", page.evaluate(TOP_OVERLAY_TEXT_JS))

        # 清理：Esc → 确认 → 确定 → 全关
        page.keyboard.press("Escape")
        self.wait_overlays(page, 2)
        self.assertTrue(self.click_top_button(page, {"text": "确定"}))
        self.wait_overlays(page, 0, timeout=10000)

    def test_wizard_dirty_esc_cancel_confirm(self):
        """向导改映射 → Esc → 「放弃本次导入设置？」→ 取消后向导仍在。"""
        page = self.open_page(1024, 689)
        self.open_data_wizard(page)
        self.wizard_goto_step(page, 2)

        # 真实输入改第一个映射下拉：点击展开 → ArrowDown → Enter 提交
        slot_select = page.locator(
            ".ui-modal select[data-wizard-slot]").first
        box = slot_select.bounding_box()
        self.assertIsNotNone(box, "向导缺少映射下拉")
        before_value = slot_select.input_value()
        page.mouse.click(box["x"] + box["width"] / 2,
                         box["y"] + box["height"] / 2)
        page.wait_for_timeout(200)
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        after_value = slot_select.input_value()
        self.assertNotEqual(after_value, before_value,
                            "映射下拉未通过键盘改值（%r → %r）"
                            % (before_value, after_value))

        # Esc → 确认框，文本「放弃本次导入设置？」
        page.keyboard.press("Escape")
        self.wait_overlays(page, 2)
        self.assertIn("放弃本次导入设置", page.evaluate(TOP_OVERLAY_TEXT_JS))

        # 点「取消」→ 确认关、向导仍在
        self.assertTrue(self.click_top_button(page, {"text": "取消"}))
        self.wait_overlays(page, 1)
        self.assertIn("导入数据向导", page.evaluate(TOP_OVERLAY_TEXT_JS))

        # 清理：Esc → 确定 → 全关（discard 路径也顺带覆盖）
        page.keyboard.press("Escape")
        self.wait_overlays(page, 2)
        self.assertTrue(self.click_top_button(page, {"text": "确定"}))
        self.wait_overlays(page, 0, timeout=10000)

    def test_enter_steps_through_to_create(self):
        """纯键盘：打开后连按 Enter 4 次（每步主按钮=下一步，末步=创建）。"""
        page = self.open_page(1024, 689)
        self.open_data_wizard(page)

        before = page.evaluate(DOC_STATS_JS)
        for _ in range(4):
            page.keyboard.press("Enter")
            page.wait_for_timeout(300)
        self.wait_overlays(page, 0, timeout=20000)
        after = page.evaluate(DOC_STATS_JS)
        self.assertIsNotNone(after)
        self.assertGreater(after["elements"], before["elements"],
                           "Enter×4 未触发创建图表")
        self.assertEqual(after["history"], before["history"] + 1,
                         "Enter 创建图表应只新增一条历史")

    def test_real_click_create_button_1024(self):
        """P0 验收：1024×689 下真实鼠标点击「创建图表」成功。"""
        page = self.open_page(1024, 689)
        self.open_data_wizard(page)

        before = page.evaluate(DOC_STATS_JS)
        btn = self.wizard_create_button(page).first
        box = btn.bounding_box()
        self.assertIsNotNone(box, "找不到「创建图表」按钮")
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        self.assertTrue(0 <= cx <= 1024 and 0 <= cy <= 689,
                        "创建图表按钮中心在视口外：(%s,%s)" % (cx, cy))
        page.mouse.click(cx, cy)
        self.wait_overlays(page, 0, timeout=20000)
        after = page.evaluate(DOC_STATS_JS)
        self.assertIsNotNone(after)
        self.assertGreater(after["elements"], before["elements"],
                           "真实点击「创建图表」后元素数未增加")


if __name__ == "__main__":
    unittest.main()
