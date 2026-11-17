# -*- coding: utf-8 -*-
"""test_canvas_interactions_ui.py — 画布交互手感（H4 / G10–G15）Playwright 验收。

覆盖（全部用真实 page.mouse / page.keyboard；状态断言只读 evaluate）：
  1) Space+左键平移：scrollLeft/Top 反向跟随、文档/选中/历史不变；
  2) 中键拖动平移：同上；
  3) Shift+1 = fit()；纸面外双击 = fit()；
  4) 悬停高亮 .fig-hover-box（包围盒一致、移开消失、选中后无框+move 光标）；
  5) 手柄/旋转手柄光标映射；
  6) Alt+拖动复制：元素+1、历史+1、原件不动、副本=原位+位移且被选中、Ctrl+Z 还原、
     Alt 单击不产生变化；
  7) 等距吸附：延续/居中两种 20mm 标注、12.5mm 标注、落点坐标；
  8) Alt 悬停测距 .fig-measure；
  9) 拖入文件（合成 DataTransfer/File 事件）：CSV→数据向导含文件名、SVG→导入对话框、
     .xyz→不支持 toast 且文档不变、对话框打开时拒绝导入；
 10) 回归：普通拖动移动+1 历史、空白框选、Ctrl+滚轮缩放、AI 输入框空格仍是文本。

需要 Python playwright + 可用浏览器；不可用时整体 skip。
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

# ---- 只读/写入辅助 JS -------------------------------------------------------

ADD_RECT_JS = r"""
([idx, x, y, w, h]) => {
  const id = 'rc-' + idx;
  const el = { id: id, type: 'rect', name: 'rect-' + idx,
    transform: { x: x, y: y, w: w, h: h, rotation: 0 },
    style: { fill: '#ddeeff', stroke: '#3366cc', strokeWidthPt: 0.75 } };
  App.commit([{ op: 'add_element', element: el }], { label: 'add-rect', source: 'user' });
  return id;
}
"""

# 元素包围盒中心（mm）
EL_CENTER_MM_JS = r"""
(id) => {
  const b = FigDoc.bbox(App.doc, id, { recursive: true });
  return { x: b.x + Math.abs(b.w) / 2, y: b.y + Math.abs(b.h) / 2 };
}
"""

# mm 点 -> 屏幕像素（经 App.stage.mmToScreen，已含滚动/缩放）
MM_TO_SCREEN_JS = r"""
(pt) => {
  const s = App.stage.mmToScreen({ x_mm: pt.x, y_mm: pt.y });
  return { x: s.x, y: s.y };
}
"""

EL_TRANSFORM_JS = r"""
(id) => {
  const el = FigDoc.get(App.doc, id);
  if (!el || !el.transform) return null;
  const t = el.transform;
  return { x: t.x, y: t.y, w: t.w, h: t.h, rotation: t.rotation || 0 };
}
"""

DOC_JS = r"""
() => {
  const d = App.doc;
  const sel = (App.selection && App.selection()) || [];
  return { n: d.elements.length, hist: d.history.length,
           zoom: App.ui.zoom, snap: App.ui.snap, sel: sel.slice(),
           els: d.elements.map(e => ({ id: e.id,
             x: e.transform && e.transform.x, y: e.transform && e.transform.y,
             w: e.transform && e.transform.w, h: e.transform && e.transform.h })) };
}
"""

SCROLL_JS = r"""
() => {
  const st = document.getElementById('stage');
  return { L: st.scrollLeft, T: st.scrollTop,
           sw: st.scrollWidth, cw: st.clientWidth,
           sh: st.scrollHeight, ch: st.clientHeight };
}
"""

CURSOR_JS = "() => getComputedStyle(document.getElementById('stage')).cursor"
OVERLAY_JS = "(sel) => document.querySelectorAll('#overlay-layer ' + sel).length"
HOVER_BOX_JS = r"""
() => {
  const n = document.querySelector('#overlay-layer .fig-hover-box');
  if (!n) return null;
  return { x: +n.getAttribute('x'), y: +n.getAttribute('y'),
           w: +n.getAttribute('width'), h: +n.getAttribute('height'),
           sw: n.getAttribute('stroke-width'), so: n.getAttribute('stroke-opacity') };
}
"""
GAP_TEXTS_JS = ("() => [...document.querySelectorAll('#overlay-layer .fig-gap-label')]"
                ".map(n => n.textContent)")
MEASURE_TEXTS_JS = ("() => [...document.querySelectorAll('#overlay-layer .fig-measure')]"
                    ".map(n => n.textContent)")
DROP_HINT_JS = ("() => { const n = document.querySelector('.drop-hint');"
                " return n ? (n.textContent || '') : null; }")
TOAST_TEXT_JS = ("() => [...document.querySelectorAll('.ui-toast')]"
                 ".map(n => n.textContent || '').join('|')")
MODAL_COUNT_JS = ("document.querySelectorAll('#modal-root > .ui-modal-overlay').length")
MODAL_TEXT_JS = r"""
() => {
  const ovs = [...document.querySelectorAll('#modal-root > .ui-modal-overlay')];
  const top = ovs[ovs.length - 1];
  return top ? (top.textContent || '') : '';
}
"""
SEL_JS = "() => ((App.selection && App.selection()) || []).slice()"
HISTORY_JS = "() => (App.doc.history || []).length"
SET_SNAP_JS = "(v) => { App.ui.snap = !!v; }"
SET_ZOOM_JS = "(z) => { Editor.setZoom(z); }"
FIT_ZOOM_JS = "() => { Editor.fit(); return App.ui.zoom; }"

# 各用例必须从空文档开始：viewer-boot 会从 /api/current 载入服务端持久化的
# current.figureproj.json（_ViewerServer 的 FIGURE_DATA_DIR 全类共享），
# App.commit 又会自动回写，因此必须显式发布一份空文档，否则元素跨用例泄漏。
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

# 合成拖入事件（DataTransfer + File），见报告「合成事件」说明。
DROP_JS = r"""
(spec) => {
  const dt = new DataTransfer();
  const f = new File([spec.content], spec.name, { type: spec.type });
  dt.items.add(f);
  const mk = (t) => new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt });
  window.dispatchEvent(mk('dragenter'));
  window.dispatchEvent(mk('dragover'));
  if (!spec.drop) return 'hint-only';
  window.dispatchEvent(mk('drop'));
  return 'dropped';
}
"""

SVG_FIXTURE = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" '
    'viewBox="0 0 120 90"><rect x="10" y="10" width="40" height="30" fill="#4f8ef7"/>'
    '<text x="60" y="40" font-size="10">drop-svg</text></svg>')


@unittest.skipUnless(HAS_PLAYWRIGHT,
                     "Python playwright + chromium/Chrome 不可用，跳过")
class CanvasInteractionsUITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.datadir = tempfile.mkdtemp(prefix="fig-canvasui-data-")
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
        page.wait_for_selector("#ai-chat-input", timeout=20000)
        page.wait_for_timeout(900)
        # 清掉服务端持久化载入的旧文档，保证每个用例从空文档开始。
        n = page.evaluate(RESET_DOC_JS)
        self.assertEqual(n, 0, "重置后文档应为空，实际 %d 个元素" % n)
        page.wait_for_timeout(250)
        return page

    def add_rect(self, page, idx, x, y, w, h):
        return page.evaluate(ADD_RECT_JS, [idx, x, y, w, h])

    def center_mm(self, page, eid):
        return page.evaluate(EL_CENTER_MM_JS, eid)

    def center_screen(self, page, eid):
        c = self.center_mm(page, eid)
        return page.evaluate(MM_TO_SCREEN_JS, c)

    def mm_screen(self, page, x, y):
        return page.evaluate(MM_TO_SCREEN_JS, {"x": x, "y": y})

    def doc(self, page):
        return page.evaluate(DOC_JS)

    def transform(self, page, eid):
        return page.evaluate(EL_TRANSFORM_JS, eid)

    def scroll(self, page):
        return page.evaluate(SCROLL_JS)

    def cursor(self, page):
        return page.evaluate(CURSOR_JS)

    def overlay_count(self, page, sel):
        return page.evaluate(OVERLAY_JS, sel)

    def _poll(self, page, js, timeout=1500):
        """Poll a page.evaluate JS until truthy or timeout (rAF-async overlays)."""
        import time
        deadline = time.time() + timeout / 1000.0
        val = page.evaluate(js)
        while not val and time.time() < deadline:
            page.wait_for_timeout(80)
            val = page.evaluate(js)
        return val

    def gap_texts(self, page):
        return self._poll(page, GAP_TEXTS_JS) or []

    def measure_texts(self, page):
        return self._poll(page, MEASURE_TEXTS_JS) or []


    def set_snap(self, page, on):
        page.evaluate(SET_SNAP_JS, on)

    def set_zoom(self, page, z):
        page.evaluate(SET_ZOOM_JS, z)
        page.wait_for_timeout(250)

    def click_el(self, page, eid):
        s = self.center_screen(page, eid)
        page.mouse.click(s["x"], s["y"])
        page.wait_for_timeout(250)

    def hover_mm(self, page, x, y):
        s = self.mm_screen(page, x, y)
        page.mouse.move(s["x"], s["y"])
        page.wait_for_timeout(220)

    def drag_el_to(self, page, eid, tx, ty, up=True, steps=6):
        """Grab element center, move pointer so element center lands at mm(tx,ty).
        Returns after mouse.down + moves; caller inspects overlay then mouse.up()."""
        c = self.center_mm(page, eid)
        s0 = page.evaluate(MM_TO_SCREEN_JS, c)
        s1 = self.mm_screen(page, tx, ty)
        page.mouse.move(s0["x"], s0["y"])
        page.mouse.down()
        page.wait_for_timeout(60)
        for i in range(1, steps + 1):
            f = i / steps
            page.mouse.move(s0["x"] + (s1["x"] - s0["x"]) * f,
                            s0["y"] + (s1["y"] - s0["y"]) * f)
            page.wait_for_timeout(30)
        if up:
            page.mouse.up()
            page.wait_for_timeout(350)

    # ------------------------------------------------------------ tests

    def test_space_pan(self):
        page = self.open_page()
        self.add_rect(page, 1, 30, 30, 20, 20)
        self.set_zoom(page, 10)  # svg 1200x900 > stage → 可滚动
        sc0 = self.scroll(page)
        self.assertGreater(sc0["sw"], sc0["cw"], "画布未产生横向滚动范围")
        self.assertGreater(sc0["sh"], sc0["ch"], "画布未产生纵向滚动范围")
        before = self.doc(page)
        # 空格按下 → grab
        page.keyboard.down("Space")
        page.wait_for_timeout(120)
        self.assertEqual(self.cursor(page), "grab", "Space 待命光标应为 grab")
        # 在画布中央按下左键拖 (-80,-50) → scroll (+80,+50)
        cx, cy = 640, 430
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx - 80, cy - 50, steps=4)
        page.wait_for_timeout(120)
        sc1 = self.scroll(page)
        self.assertAlmostEqual(sc1["L"] - sc0["L"], 80, delta=2,
                               msg="scrollLeft 未随拖动反向变化")
        self.assertAlmostEqual(sc1["T"] - sc0["T"], 50, delta=2,
                               msg="scrollTop 未随拖动反向变化")
        page.mouse.up()
        page.wait_for_timeout(150)
        after = self.doc(page)
        self.assertEqual(after["hist"], before["hist"], "平移不应产生历史")
        self.assertEqual(after["sel"], before["sel"], "平移不应改变选中")
        self.assertEqual(after["els"], before["els"], "平移不应移动元素")
        # 松开 Space → 光标恢复（非 grab）
        page.keyboard.up("Space")
        page.wait_for_timeout(120)
        self.assertNotEqual(self.cursor(page), "grab", "松开 Space 后光标未恢复")
        page.context.close()

    # ---- A1：Space 与按钮焦点冲突 ----
    SNAP_PRESSED_JS = ("() => { const b = document.getElementById('toggle-snap');"
                       " return b ? b.getAttribute('aria-pressed') : null; }")
    ACTIVE_TAG_JS = ("() => document.activeElement ? "
                     "document.activeElement.tagName : ''")
    SPACE_ARMED_JS = "() => (window.Editor && Editor.spaceArmed ? Editor.spaceArmed() : null)"

    def test_a1a_space_pan_after_mouse_click_snap(self):
        """A1(a)：鼠标点过「吸附」后按 Space 拖动 → 平移生效，且不重复触发按钮。"""
        page = self.open_page(1280, 860)
        page.evaluate(RESET_DOC_JS)
        self.add_rect(page, 1, 30, 30, 20, 20)
        self.set_zoom(page, 10)
        # 鼠标真实点击「吸附」开关一次，记录 aria-pressed
        snap = page.locator("#toggle-snap")
        box = snap.bounding_box()
        self.assertIsNotNone(box, "缺少 #toggle-snap")
        page.mouse.click(box["x"] + box["width"] / 2,
                         box["y"] + box["height"] / 2)
        page.wait_for_timeout(200)
        pressed0 = page.evaluate(self.SNAP_PRESSED_JS)
        self.assertIsNotNone(pressed0)
        # 焦点应在按钮上（鼠标点击留下的焦点）
        self.assertEqual(page.evaluate(self.ACTIVE_TAG_JS), "BUTTON",
                         "点击后焦点应在按钮上")
        sc0 = self.scroll(page)
        self.assertGreater(sc0["sw"], sc0["cw"], "画布未产生横向滚动范围")
        # 按住 Space 拖动 → scrollLeft/Top 变化
        page.keyboard.down("Space")
        page.wait_for_timeout(120)
        self.assertTrue(page.evaluate(self.SPACE_ARMED_JS),
                        "Space 应武装平移（鼠标焦点按钮已 blur）")
        cx, cy = 640, 430
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx - 80, cy - 50, steps=4)
        page.wait_for_timeout(120)
        sc1 = self.scroll(page)
        self.assertNotEqual(sc1["L"], sc0["L"], "scrollLeft 应变化")
        self.assertNotEqual(sc1["T"], sc0["T"], "scrollTop 应变化")
        page.mouse.up()
        page.keyboard.up("Space")
        page.wait_for_timeout(200)
        # 松开 Space 后「吸附」aria-pressed 不变（未被 keyup 重复触发）
        self.assertEqual(page.evaluate(self.SNAP_PRESSED_JS), pressed0,
                         "Space 松开不应再次触发「吸附」按钮")
        page.context.close()

    def test_a1b_space_activates_keyboard_focused_button(self):
        """A1(b)：Tab 聚焦工具栏开关后按 Space → 按钮被激活（状态翻转），
        不武装平移。"""
        page = self.open_page(1280, 860)
        page.evaluate(RESET_DOC_JS)
        # Tab 移动焦点直到落在 #toggle-snap（:focus-visible）
        snap = page.locator("#toggle-snap")
        focused = False
        for _ in range(30):
            page.keyboard.press("Tab")
            page.wait_for_timeout(60)
            if page.evaluate(
                    "document.activeElement && "
                    "document.activeElement.id === 'toggle-snap'"):
                focused = True
                break
        self.assertTrue(focused, "Tab 应能聚焦到 #toggle-snap")
        pressed0 = page.evaluate(self.SNAP_PRESSED_JS)
        # 按 Space → 键盘激活按钮（翻转），不武装平移
        page.keyboard.down("Space")
        page.wait_for_timeout(80)
        self.assertFalse(page.evaluate(self.SPACE_ARMED_JS),
                         "键盘焦点按钮上按 Space 不应武装平移")
        page.keyboard.up("Space")
        page.wait_for_timeout(200)
        pressed1 = page.evaluate(self.SNAP_PRESSED_JS)
        self.assertNotEqual(pressed1, pressed0,
                            "Space 应激活并翻转「吸附」状态：%s→%s" % (pressed0, pressed1))
        page.context.close()

    def test_middle_button_pan(self):
        page = self.open_page()
        self.add_rect(page, 1, 30, 30, 20, 20)
        self.set_zoom(page, 10)
        sc0 = self.scroll(page)
        before = self.doc(page)
        cx, cy = 640, 430
        page.mouse.move(cx, cy)
        page.mouse.down(button="middle")
        page.mouse.move(cx - 60, cy - 40, steps=4)
        page.wait_for_timeout(120)
        sc1 = self.scroll(page)
        self.assertAlmostEqual(sc1["L"] - sc0["L"], 60, delta=2)
        self.assertAlmostEqual(sc1["T"] - sc0["T"], 40, delta=2)
        page.mouse.up()
        page.wait_for_timeout(150)
        after = self.doc(page)
        self.assertEqual(after["hist"], before["hist"])
        self.assertEqual(after["els"], before["els"])
        page.context.close()

    def test_fit_shortcuts(self):
        page = self.open_page()
        # Ctrl+滚轮放大
        z0 = page.evaluate("App.ui.zoom")
        page.keyboard.down("Control")
        page.mouse.move(640, 430)
        page.mouse.wheel(0, -400)
        page.keyboard.up("Control")
        page.wait_for_timeout(300)
        z1 = page.evaluate("App.ui.zoom")
        self.assertGreater(z1, z0, "Ctrl+滚轮未放大")
        # Shift+1 → fit
        page.keyboard.down("Shift")
        page.keyboard.press("1")
        page.keyboard.up("Shift")
        page.wait_for_timeout(300)
        z_shift = page.evaluate("App.ui.zoom")
        z_fit = page.evaluate(FIT_ZOOM_JS)
        page.wait_for_timeout(200)
        self.assertAlmostEqual(z_shift, z_fit, places=5,
                               msg="Shift+1 未等于 fit() 缩放")
        self.assertNotAlmostEqual(z_shift, z1, places=5,
                                  msg="Shift+1 后缩放未回到 fit 值")
        # 缩小后在纸面外空白处双击 → fit
        page.evaluate("Editor.setZoom(1.2)")
        page.wait_for_timeout(250)
        # 找纸面（svg）之外、仍在 stage 内的空白点
        blank = page.evaluate(r"""
          () => {
            const st = document.getElementById('stage');
            const svg = document.getElementById('svg-stage');
            const sr = st.getBoundingClientRect(), vr = svg.getBoundingClientRect();
            // 右下角 stage 内但 svg 之外
            const x = Math.min(sr.right - 12, vr.right + 30);
            const y = Math.min(sr.bottom - 12, vr.bottom + 30);
            if (x > vr.left && x < vr.right && y > vr.top && y < vr.bottom) return null;
            if (x < sr.left || x > sr.right || y < sr.top || y > sr.bottom) return null;
            return { x: x, y: y };
          }
        """)
        self.assertIsNotNone(blank, "找不到纸面外空白点（svg 应小于 stage）")
        z_before = page.evaluate("App.ui.zoom")
        page.mouse.dblclick(blank["x"], blank["y"])
        page.wait_for_timeout(350)
        z_dbl = page.evaluate("App.ui.zoom")
        z_fit2 = page.evaluate(FIT_ZOOM_JS)
        self.assertAlmostEqual(z_dbl, z_fit2, places=5,
                               msg="纸面外双击未触发 fit")
        self.assertNotAlmostEqual(z_dbl, z_before, places=5)
        page.context.close()

    def test_hover_outline(self):
        page = self.open_page()
        eid = self.add_rect(page, 1, 30, 30, 20, 20)
        page.wait_for_timeout(250)
        # 未选中悬停 → .fig-hover-box 包围盒 = 元素 bbox
        self.hover_mm(page, 40, 40)
        box = self._poll(page, HOVER_BOX_JS)
        self.assertIsNotNone(box, "悬停未选中元素未出现 .fig-hover-box")
        b = page.evaluate(EL_TRANSFORM_JS, eid)
        self.assertAlmostEqual(box["x"], b["x"], delta=0.05)
        self.assertAlmostEqual(box["y"], b["y"], delta=0.05)
        self.assertAlmostEqual(box["w"], b["w"], delta=0.05)
        self.assertAlmostEqual(box["h"], b["h"], delta=0.05)
        self.assertEqual(box["so"], "0.55")
        # 移开 → 消失
        page.mouse.move(5, 5)
        gone = self._poll(page, "() => document.querySelectorAll('#overlay-layer .fig-hover-box').length === 0")
        self.assertTrue(gone, "移开后 hover 框未消失")
        # 选中后悬停 → 无框且光标 move
        self.click_el(page, eid)
        self.hover_mm(page, 40, 40)
        self.assertEqual(self.overlay_count(page, ".fig-hover-box"), 0,
                         "选中元素不应再出现 hover 框")
        self.assertEqual(self.cursor(page), "move", "悬停选中元素光标应为 move")
        page.context.close()

    def test_handle_cursors(self):
        page = self.open_page()
        eid = self.add_rect(page, 1, 30, 30, 30, 30)  # 大一点，手柄分散
        self.click_el(page, eid)
        page.wait_for_timeout(300)
        handles = page.evaluate(r"""
          () => {
            const hs = [...document.querySelectorAll('#overlay-layer .fig-handle')];
            const rot = document.querySelector('#overlay-layer .fig-rotate-handle');
            const c = (n) => { const r = n.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
            return { handles: hs.map(c), rotate: rot ? c(rot) : null };
          }
        """)
        self.assertEqual(len(handles["handles"]), 8, "应有 8 个缩放手柄")
        self.assertIsNotNone(handles["rotate"], "缺少旋转手柄")
        # HANDLE_KEYS = nw,n,ne,e,se,s,sw,w → DOM 顺序一致
        expect = ["nwse-resize", "ns-resize", "nesw-resize", "ew-resize",
                  "nwse-resize", "ns-resize", "nesw-resize", "ew-resize"]
        for i, pt in enumerate(handles["handles"]):
            page.mouse.move(pt["x"], pt["y"])
            page.wait_for_timeout(140)
            cur = self.cursor(page)
            self.assertEqual(cur, expect[i],
                             "手柄 %d 光标应为 %s，实际 %s" % (i, expect[i], cur))
        page.mouse.move(handles["rotate"]["x"], handles["rotate"]["y"])
        page.wait_for_timeout(140)
        self.assertEqual(self.cursor(page), "grab", "旋转手柄光标应为 grab")
        page.context.close()

    def test_alt_drag_duplicate(self):
        page = self.open_page()
        self.set_snap(page, False)
        eid = self.add_rect(page, 1, 30, 30, 20, 20)
        self.click_el(page, eid)
        orig = self.transform(page, eid)
        hist0 = page.evaluate(HISTORY_JS)
        n0 = self.doc(page)["n"]
        # Alt+拖动 (+15,+10) mm
        page.keyboard.down("Alt")
        c = self.center_mm(page, eid)
        s0 = page.evaluate(MM_TO_SCREEN_JS, c)
        s1 = self.mm_screen(page, c["x"] + 15, c["y"] + 10)
        page.mouse.move(s0["x"], s0["y"])
        page.mouse.down()
        page.wait_for_timeout(80)
        for i in range(1, 6):
            f = i / 5
            page.mouse.move(s0["x"] + (s1["x"] - s0["x"]) * f,
                            s0["y"] + (s1["y"] - s0["y"]) * f)
            page.wait_for_timeout(40)
        page.mouse.up()
        page.keyboard.up("Alt")
        page.wait_for_timeout(400)
        d = self.doc(page)
        self.assertEqual(d["n"], n0 + 1, "Alt 拖动后元素数应 +1")
        self.assertEqual(d["hist"], hist0 + 1, "Alt 拖动应记 1 条历史")
        self.assertEqual(self.transform(page, eid), orig, "原对象 transform 被改")
        sel = page.evaluate(SEL_JS)
        self.assertEqual(len(sel), 1, "副本应被选中")
        dup = self.transform(page, sel[0])
        self.assertIsNotNone(dup)
        self.assertAlmostEqual(dup["x"], orig["x"] + 15, delta=0.2,
                               msg="副本 x 未位于 原位+15")
        self.assertAlmostEqual(dup["y"], orig["y"] + 10, delta=0.2,
                               msg="副本 y 未位于 原位+10")
        # Ctrl+Z → 副本消失
        page.evaluate("if(document.activeElement)document.activeElement.blur()")
        page.keyboard.press("Control+z")
        page.wait_for_timeout(400)
        self.assertEqual(self.doc(page)["n"], n0, "Ctrl+Z 后副本未移除")
        # Alt+单击不拖动 → 无变化
        hist1 = page.evaluate(HISTORY_JS)
        n1 = self.doc(page)["n"]
        page.keyboard.down("Alt")
        s = self.center_screen(page, eid)
        page.mouse.click(s["x"], s["y"])
        page.keyboard.up("Alt")
        page.wait_for_timeout(300)
        self.assertEqual(self.doc(page)["n"], n1, "Alt 单击不应新增元素")
        self.assertEqual(page.evaluate(HISTORY_JS), hist1, "Alt 单击不应记历史")
        page.context.close()

    def _gap_setup(self, page):
        """A(10,10,20x20) B(50,10,20x20) C(95,10,20x20)，snap 开、zoom=3。"""
        self.set_snap(page, True)
        self.set_zoom(page, 3)
        self.add_rect(page, 1, 10, 10, 20, 20)   # A
        self.add_rect(page, 2, 50, 10, 20, 20)   # B
        self.add_rect(page, 3, 95, 10, 20, 20)   # C
        page.wait_for_timeout(200)

    def test_equal_gap_snap_continue(self):
        page = self.open_page()
        self._gap_setup(page)
        # 拖 C 中心到 (99,20)：C.x 95→89，等距吸附到 90（与 AB 间距同为 20）
        self.drag_el_to(page, "rc-3", 99, 20, up=False)
        labels = self.gap_texts(page)
        self.assertEqual(len(labels), 2, "拖动中应有 2 个间距标注: %r" % labels)
        self.assertTrue(all(t == "20 mm" for t in labels),
                        "间距标注应为 20 mm: %r" % labels)
        page.mouse.up()
        page.wait_for_timeout(350)
        tx = self.transform(page, "rc-3")
        self.assertAlmostEqual(tx["x"], 90, delta=0.01,
                               msg="C.x 应吸附到 90，实际 %s" % tx["x"])
        page.context.close()

    def test_equal_gap_snap_center(self):
        page = self.open_page()
        self.set_snap(page, True)
        self.set_zoom(page, 3)
        self.add_rect(page, 1, 10, 10, 20, 20)    # A -> [10,30]
        self.add_rect(page, 2, 90, 10, 20, 20)    # C -> [90,110]
        self.add_rect(page, 3, 55, 40, 20, 20)    # B 起始 (55,40)
        page.wait_for_timeout(200)
        # 拖 B 中心到 (61.5,20.5)：B.x→51.5，居中吸附到 50（两侧间距均 20）
        self.drag_el_to(page, "rc-3", 61.5, 20.5, up=False)
        labels = self.gap_texts(page)
        self.assertEqual(len(labels), 2, "居中拖动应有 2 个间距标注: %r" % labels)
        self.assertTrue(all(t == "20 mm" for t in labels),
                        "居中间距标注应为 20 mm: %r" % labels)
        page.mouse.up()
        page.wait_for_timeout(350)
        tx = self.transform(page, "rc-3")
        self.assertAlmostEqual(tx["x"], 50, delta=0.01,
                               msg="B.x 应居中吸附到 50，实际 %s" % tx["x"])
        page.context.close()

    def test_equal_gap_snap_12_5(self):
        page = self.open_page()
        self.set_snap(page, True)
        self.set_zoom(page, 3)
        self.add_rect(page, 1, 10, 10, 20, 20)     # A -> [10,30]
        self.add_rect(page, 2, 42.5, 10, 20, 20)   # B -> [42.5,62.5]，间距 12.5
        self.add_rect(page, 3, 100, 10, 20, 20)    # C 起始
        page.wait_for_timeout(200)
        # 拖 C 中心到 (84,20)：C.x→74，延续右侧吸附到 75（间距 12.5）
        self.drag_el_to(page, "rc-3", 84, 20, up=False)
        labels = self.gap_texts(page)
        self.assertEqual(len(labels), 2, "应有 2 个间距标注: %r" % labels)
        self.assertTrue(all(t == "12.5 mm" for t in labels),
                        "间距标注应为 12.5 mm: %r" % labels)
        page.mouse.up()
        page.wait_for_timeout(350)
        tx = self.transform(page, "rc-3")
        self.assertAlmostEqual(tx["x"], 75, delta=0.01,
                               msg="C.x 应吸附到 75，实际 %s" % tx["x"])
        page.context.close()

    def test_alt_measure(self):
        page = self.open_page()
        a = self.add_rect(page, 1, 10, 10, 20, 20)   # A -> [10,30]
        b = self.add_rect(page, 2, 50, 10, 20, 20)   # B -> [50,70]，间距 20
        page.wait_for_timeout(250)
        self.click_el(page, a)          # 选中 A
        page.keyboard.down("Alt")
        self.hover_mm(page, 60, 20)     # 悬停 B（不点击）
        texts = self.measure_texts(page)
        self.assertTrue(any("20 mm" in t for t in texts),
                        "Alt 测距应显示 20 mm: %r" % texts)
        page.keyboard.up("Alt")
        page.wait_for_timeout(200)
        self.assertEqual(self.overlay_count(page, ".fig-measure"), 0,
                         "松开 Alt 后测距未清除")
        page.context.close()

    def _drop(self, page, spec):
        return page.evaluate(DROP_JS, spec)

    def test_drop_csv_opens_wizard(self):
        page = self.open_page()
        n0 = self.doc(page)["n"]
        self._drop(page, {"name": "drop.csv", "type": "text/csv",
                          "content": "cond,val_a,val_b\nctrl,1.0,10.1\ntrt,2.1,20.3\n",
                          "drop": False})
        page.wait_for_timeout(150)
        self.assertIsNotNone(page.evaluate(DROP_HINT_JS), "拖入期间未显示 .drop-hint")
        self._drop(page, {"name": "drop.csv", "type": "text/csv",
                          "content": "cond,val_a,val_b\nctrl,1.0,10.1\ntrt,2.1,20.3\n",
                          "drop": True})
        page.wait_for_selector(".dw-modal, .ui-modal-overlay", timeout=20000)
        page.wait_for_timeout(500)
        self.assertIsNone(page.evaluate(DROP_HINT_JS), "drop 后 .drop-hint 未移除")
        mtext = page.evaluate(MODAL_TEXT_JS)
        self.assertIn("drop.csv", mtext, "数据向导标题应含 drop.csv: %r" % mtext[:120])
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.context.close()

    def test_drop_svg_opens_import(self):
        page = self.open_page()
        self._drop(page, {"name": "pic.svg", "type": "image/svg+xml",
                          "content": SVG_FIXTURE, "drop": True})
        page.wait_for_selector(".ui-modal-overlay", timeout=20000)
        page.wait_for_timeout(400)
        page.context.close()

    def test_drop_unsupported_and_modal_block(self):
        page = self.open_page()
        n0 = self.doc(page)["n"]
        h0 = page.evaluate(HISTORY_JS)
        # .xyz → 不支持 toast，文档不变
        self._drop(page, {"name": "data.xyz", "type": "application/octet-stream",
                          "content": "1 2 3\n", "drop": True})
        page.wait_for_timeout(400)
        toast = page.evaluate(TOAST_TEXT_JS)
        self.assertIn("不支持的文件类型", toast, "缺少不支持类型 toast: %r" % toast)
        self.assertEqual(self.doc(page)["n"], n0, ".xyz 导入改变了文档")
        self.assertEqual(page.evaluate(HISTORY_JS), h0, ".xyz 导入产生了历史")
        # 对话框打开时 drop → 不导入 + 提示
        page.evaluate(
            "Ui.modal({title:'占位', body: document.createElement('div'),"
            " actions:[{label:'关闭'}]})")
        page.wait_for_timeout(300)
        self.assertGreaterEqual(page.evaluate(MODAL_COUNT_JS), 1, "未能打开对话框")
        self._drop(page, {"name": "drop.csv", "type": "text/csv",
                          "content": "a,b\n1,2\n", "drop": True})
        page.wait_for_timeout(400)
        toast2 = page.evaluate(TOAST_TEXT_JS)
        self.assertTrue(("关闭当前对话框" in toast2) or ("对话框" in toast2),
                        "对话框打开时 drop 应提示: %r" % toast2)
        self.assertEqual(self.doc(page)["n"], n0, "对话框打开时不应导入")
        page.context.close()

    def test_regressions(self):
        page = self.open_page()
        # 普通左键拖动 → 移动 + 1 历史
        eid = self.add_rect(page, 1, 30, 30, 20, 20)
        self.click_el(page, eid)
        h0 = page.evaluate(HISTORY_JS)
        self.drag_el_to(page, eid, 50, 50, up=True)  # 中心→(50,50) ⇒ transform→(40,40)
        self.assertEqual(page.evaluate(HISTORY_JS), h0 + 1, "拖动应记 1 条历史")
        t = self.transform(page, eid)
        self.assertAlmostEqual(t["x"], 40, delta=0.3, msg="元素未移动到目标")
        # 空白处拖动 → 框选
        self.add_rect(page, 2, 70, 60, 15, 15)
        page.evaluate("App.clearSelection && App.clearSelection()")
        # 在画布空白处框选 rc-2
        s = self.mm_screen(page, 66, 56)
        e = self.mm_screen(page, 90, 80)
        page.mouse.move(s["x"], s["y"])
        page.mouse.down()
        page.mouse.move(e["x"], e["y"], steps=4)
        page.mouse.up()
        page.wait_for_timeout(300)
        sel = page.evaluate(SEL_JS)
        self.assertIn("rc-2", sel, "空白框选未选中 rc-2: %r" % sel)
        # Ctrl+滚轮缩放
        z0 = page.evaluate("App.ui.zoom")
        page.keyboard.down("Control")
        page.mouse.move(640, 430)
        page.mouse.wheel(0, -300)
        page.keyboard.up("Control")
        page.wait_for_timeout(300)
        self.assertNotAlmostEqual(page.evaluate("App.ui.zoom"), z0, places=5,
                                  msg="Ctrl+滚轮未缩放")
        # AI 输入框空格仍是文本、不触发平移
        page.locator("#ai-chat-input").click()
        page.keyboard.type("a b")
        page.wait_for_timeout(150)
        val = page.locator("#ai-chat-input").input_value()
        self.assertIn(" ", val, "AI 输入框空格未输入: %r" % val)
        self.assertNotEqual(self.cursor(page), "grab",
                            "输入框内空格不应进入平移待命")
        page.context.close()


if __name__ == "__main__":
    unittest.main()
