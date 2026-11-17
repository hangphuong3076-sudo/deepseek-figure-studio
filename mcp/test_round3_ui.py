# -*- coding: utf-8 -*-
"""test_round3_ui.py — R1 轮 Playwright 验收（A3 拆分 / B 锚点 / D 数据表）。

A3: 页面加载后 route abort **/app/svg-import.js，拆分散点/柱状/折线图仍成功
    （svg-import.js 已静态加载，不依赖点击时网络请求），Ctrl+Z 一步还原。
B : 画布建锚点 → 离线兜底「[1] 颜色改为 #2F6FED」→ 同意并修改 → 锚点与
    chip 清除；Ctrl+Z 锚点与颜色同恢复；「不改」路径锚点保留。
D : 点选散点/柱子 → 属性面板「定位到原始数据」→ 只读虚拟化表格高亮来源行；
    5 万行图表打开目标行可见 < 1s。
"""
import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path

from test_modal_layout import (
    HAS_PLAYWRIGHT, SAMPLE_CSV, _ViewerServer, _launch_chromium,
)

HERE = Path(__file__).resolve().parent

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

ADD_CHART_JS = r"""
(kind) => {
  let data, spec;
  if (kind === 'scatter') {
    const rows = [];
    ['A','B','C'].forEach(function (g, gi) {
      for (let i = 0; i < 5; i++) rows.push([g, i * 2 + 1, gi * 10 + i * 1.5 + (i % 2)]);
    });
    data = { columns: ['grp', 'x', 'y'], rows: rows };
    spec = { chart_type: 'scatter', mapping: { x: 'x', y: 'y', color: 'grp' } };
  } else if (kind === 'bar') {
    data = { columns: ['cat', 'val'],
             rows: [['A', 10], ['A', 12], ['B', 20], ['C', 15]] };
    spec = { chart_type: 'bar', mapping: { x: 'cat', y: 'val' } };
  } else {
    data = { columns: ['x', 'y'],
             rows: [[1, 2], [2, 4], [3, 5], [4, 4], [5, 7]] };
    spec = { chart_type: 'line', mapping: { x: 'x', y: 'y' } };
  }
  const el = FigData.makeChartElement(data, spec);
  el.transform = { x: 5, y: 5, w: 110, h: 80, rotation: 0 };
  el.name = 'r3-' + kind;
  const cid = el.id;
  App.commit([{ op: 'add_element', element: el }], { label: 'mk-' + kind, source: 'user' });
  return cid;
}
"""

CHART_PART_JS = (
    "window.App && window.App.ui ? JSON.parse(JSON.stringify("
    "window.App.ui.chartPart || null)) : null")

MARK_CENTER_JS = r"""
(idx) => {
  const ns = [...document.querySelectorAll('#svg-stage [data-point-key]')];
  if (idx >= ns.length) return null;
  const n = ns[idx];
  const r = n.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
"""

# 拆分后文档状态：{groups, deleted} —— group.source_element_id 命中即拆分成功。
SPLIT_STATE_JS = r"""
(cid) => {
  const doc = App.doc;
  const chart = (doc.elements || []).find(e => e.id === cid);
  const groups = (doc.elements || []).filter(e => e.type === 'group' &&
    e.source_element_id === cid);
  const kids = groups.length ? (groups[0].children || []).length : 0;
  return { chartPresent: !!chart, groups: groups.length, children: kids,
           total: doc.elements.length };
}
"""

# 锚点 + chip 状态（只读）。
ANCHOR_STATE_JS = r"""
() => {
  const doc = App.doc || {};
  const chips = [...document.querySelectorAll('#ai-ref-chips *')]
    .map(n => (n.textContent || '').trim()).filter(Boolean);
  return { anchors: (doc.anchors || []).map(a => ({ id: a.id, label: a.label })),
           chips: chips,
           refs: (window.AiPanel && AiPanel.anchorRefs) ? AiPanel.anchorRefs() : [] };
}
"""

# 属性面板里「定位到原始数据」按钮。
LOCATE_BTN_JS = r"""
() => {
  const sec = document.querySelector('[data-props-section="chart-mark"]');
  if (!sec) return null;
  const btn = [...sec.querySelectorAll('button')].find(b =>
    (b.textContent || '').indexOf('定位到原始数据') >= 0);
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2,
           visible: btn.offsetParent !== null };
}
"""

# 数据表弹窗状态（只读）。
DT_STATE_JS = r"""
() => {
  const modal = document.querySelector('.ui-modal.dt-modal');
  if (!modal) return { open: false };
  const caption = modal.querySelector('.dt-caption');
  const hits = [...modal.querySelectorAll('tr.dt-hit')].map(tr => {
    const idx = tr.getAttribute('data-row-idx');
    return { idx: idx, focus: tr.classList.contains('dt-focus'),
             cells: [...tr.querySelectorAll('td')].map(td => td.textContent.trim()) };
  });
  const sum = modal.querySelector('.dt-sum');
  const meta = modal.querySelector('.dt-meta');
  const roles = [...modal.querySelectorAll('.dt-role')].map(n => n.textContent);
  return { open: true,
           caption: caption ? caption.textContent : '',
           hits: hits, sum: sum ? sum.textContent : null,
           meta: meta ? meta.textContent : '',
           roles: roles,
           rowCount: modal.querySelectorAll('tbody tr.dt-row').length };
}
"""

ADD_RECT_JS = r"""
() => {
  const el = { id: FigDoc.uid('rect'), type: 'rect', name: 'r3-rect',
    parent_id: null,
    transform: { x: 10, y: 10, w: 30, h: 20, rotation: 0 },
    style: { fill: '#3C5488', stroke: '#000000', strokeWidthPt: 0.75 } };
  App.commit([{ op: 'add_element', element: el }], { label: 'mk-rect', source: 'user' });
  return el.id;
}
"""

RECT_FILL_JS = r"""
(rid) => {
  const el = (App.doc.elements || []).find(e => e.id === rid);
  return el && el.style ? el.style.fill : null;
}
"""


@unittest.skipUnless(HAS_PLAYWRIGHT,
                     "Python playwright + chromium/Chrome 不可用，跳过")
class Round3UiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-r3-data-")
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

    def open_page(self):
        ctx = self.browser.new_context(viewport={"width": 1280, "height": 860})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#svg-stage", timeout=20000)
        page.wait_for_timeout(400)
        page.evaluate(RESET_DOC_JS)
        page.wait_for_timeout(200)
        return ctx, page

    def hist_len(self, page):
        return page.evaluate(
            "(App.doc.history||[]).length")

    def undo(self, page):
        page.evaluate("App.focusCanvas && App.focusCanvas()")
        page.mouse.click(300, 200)
        page.keyboard.press("Control+z")
        page.wait_for_timeout(400)

    # ------------------------------------------------------------- A3
    def test_a3_split_without_svg_import_network(self):
        ctx, page = self.open_page()
        # 页面已加载完毕后再拦截：若拆分仍依赖点击时拉取该脚本必然失败
        page.route("**/app/svg-import.js", lambda r: r.abort())
        for kind in ("scatter", "bar", "line"):
            cid = page.evaluate(ADD_CHART_JS, kind)
            page.evaluate("(id)=>App.select && App.select([id])", cid)
            page.wait_for_timeout(300)
            page.click("#btn-explode-chart")
            page.wait_for_selector(".ui-modal", timeout=5000)
            page.locator(".ui-modal .ui-btn-primary").click()
            page.wait_for_function(
                """(cid)=>{const doc=App.doc;const g=(doc.elements||[])
                  .find(e=>e.type==='group'&&e.source_element_id===cid);
                  return !!g && (g.children||[]).length>0;}""",
                arg=cid, timeout=10000)
            st = page.evaluate(SPLIT_STATE_JS, cid)
            self.assertFalse(st["chartPresent"], kind + " 原图表应已删除")
            self.assertGreater(st["children"], 0, kind + " 拆分子元素应 >0")
            self.undo(page)
            st2 = page.evaluate(SPLIT_STATE_JS, cid)
            self.assertTrue(st2["chartPresent"],
                            kind + " Ctrl+Z 应一步还原原图表")
            self.assertEqual(st2["groups"], 0)
        ctx.close()

    # ------------------------------------------------------------- B
    def test_b_anchor_cleared_on_apply_and_restored_on_undo(self):
        ctx, page = self.open_page()
        rid = page.evaluate(ADD_RECT_JS)
        # 选中矩形 → 走真实面板路径建锚点（自动产生 [1] chip）
        page.evaluate("(id)=>App.select && App.select([id])", rid)
        page.wait_for_timeout(200)
        page.evaluate("Anchors.addFromSelection('r3锚')")
        page.wait_for_function(
            "window.AiPanel && AiPanel.anchorRefs().length === 1",
            timeout=8000)
        st0 = page.evaluate(ANCHOR_STATE_JS)
        self.assertEqual(len(st0["anchors"]), 1)
        self.assertEqual(len(st0["refs"]), 1)
        aid = st0["anchors"][0]["id"]

        # 先验证「不改」路径：锚点与 chip 保留
        page.fill("#ai-chat-input", "[1] 颜色改为 #2F6FED")
        page.click("#ai-send-btn")
        page.wait_for_selector(".ui-modal, [data-plan-card], .ai-plan", timeout=15000)
        page.wait_for_timeout(500)
        discard = page.get_by_role("button", name="不改")
        if discard.count():
            discard.first.click()
            page.wait_for_timeout(400)
        st_keep = page.evaluate(ANCHOR_STATE_JS)
        self.assertEqual(len(st_keep["anchors"]), 1, "放弃方案后锚点应保留")
        self.assertEqual(len(st_keep["refs"]), 1, "放弃方案后 chip 应保留")

        # 再发一次 → 同意并修改
        page.fill("#ai-chat-input", "[1] 颜色改为 #2F6FED")
        page.click("#ai-send-btn")
        page.wait_for_function(
            "[...document.querySelectorAll('button')].some(b=>"
            "/同意并修改/.test(b.textContent||''))",
            timeout=15000)
        page.get_by_role("button", name="同意并修改").first.click()
        page.wait_for_function(
            """(aid)=>{const d=App.doc||{};return !(d.anchors||[])
              .some(a=>a.id===aid);}""",
            arg=aid, timeout=8000)
        st1 = page.evaluate(ANCHOR_STATE_JS)
        self.assertEqual(st1["anchors"], [], "应用后锚点应从 doc 移除")
        self.assertEqual(st1["refs"], [], "应用后 chip 应清空")
        self.assertIn("#2f6fed", (page.evaluate(RECT_FILL_JS, rid) or "").lower())
        # 撤销：锚点与颜色同恢复（同一历史事务）
        self.undo(page)
        st2 = page.evaluate(ANCHOR_STATE_JS)
        self.assertEqual(len(st2["anchors"]), 1, "Ctrl+Z 应恢复锚点")
        self.assertEqual(st2["anchors"][0]["id"], aid)
        self.assertNotIn("#2f6fed",
                         (page.evaluate(RECT_FILL_JS, rid) or "").lower(),
                         "Ctrl+Z 应恢复修改前颜色")
        ctx.close()

    # ------------------------------------------------------------- D1
    def _open_mark(self, page, kind="scatter", idx=0):
        cid = page.evaluate(ADD_CHART_JS, kind)
        c = page.evaluate(MARK_CENTER_JS, idx)
        self.assertIsNotNone(c, "找不到可点的数据标记")
        page.mouse.click(c["x"], c["y"])
        page.wait_for_timeout(400)
        part = page.evaluate(CHART_PART_JS)
        self.assertIsNotNone(part and part.get("row"), "chartPart.row 应存在")
        return cid, part

    def test_d_scatter_point_locates_source_row(self):
        ctx, page = self.open_page()
        cid, part = self._open_mark(page, "scatter", 0)
        row_idx = int(str(part["row"]).split(",")[0])
        # 期望行的 x/y 值（inline.rows[row_idx]，列 x=1, y=2）
        expect = page.evaluate(
            """(a)=>{const el=(App.doc.elements||[]).find(e=>e.id===a.cid);
              const d=el.chart.data.inline;const cols=d.columns;
              const row=d.rows[a.ri];return {x:String(row[cols.indexOf('x')]),
              y:String(row[cols.indexOf('y')])};}""",
            {"cid": cid, "ri": row_idx})
        btn = page.evaluate(LOCATE_BTN_JS)
        self.assertIsNotNone(btn and btn.get("visible"), "应有「定位到原始数据」按钮")
        page.mouse.click(btn["x"], btn["y"])
        page.wait_for_selector(".ui-modal.dt-modal", timeout=8000)
        page.wait_for_timeout(300)
        st = page.evaluate(DT_STATE_JS)
        self.assertTrue(st["open"])
        self.assertIn("数据第 " + str(row_idx + 1) + " 行", st["caption"])
        focus = [h for h in st["hits"] if h["focus"]]
        self.assertEqual(len(focus), 1, "应有且仅有一行高亮聚焦")
        cells = focus[0]["cells"]
        self.assertIn(expect["x"], cells)
        self.assertIn(expect["y"], cells)
        self.assertTrue(any("横轴" in r for r in st["roles"]),
                        "表头应标注映射角色：%r" % st["roles"])
        # 关闭不产生历史
        h0 = self.hist_len(page)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        self.assertEqual(self.hist_len(page), h0, "查看数据表不应产生历史")
        ctx.close()

    def test_d_bar_shows_source_row_count(self):
        ctx, page = self.open_page()
        cid, part = self._open_mark(page, "bar", 0)
        rows_attr = str(part["row"])
        k = len([s for s in rows_attr.split(",") if s.strip()])
        btn = page.evaluate(LOCATE_BTN_JS)
        page.mouse.click(btn["x"], btn["y"])
        page.wait_for_selector(".ui-modal.dt-modal", timeout=8000)
        page.wait_for_timeout(300)
        st = page.evaluate(DT_STATE_JS)
        self.assertTrue(st["open"])
        self.assertIn("由 " + str(k) + " 行数据汇总", st["sum"] or "")
        self.assertEqual(len(st["hits"]), k, "高亮行数应等于汇总行数")
        # 「下一行」循环切换聚焦
        page.get_by_role("button", name="下一行").click()
        page.wait_for_timeout(200)
        st2 = page.evaluate(DT_STATE_JS)
        self.assertIn("第 2/", st2["caption"])
        ctx.close()

    def test_d_50k_rows_opens_fast(self):
        ctx, page = self.open_page()
        cid = page.evaluate(r"""
          () => {
            const rows = [];
            for (let i = 0; i < 50000; i++) {
              rows.push(['g' + (i % 50), i, i * 1.5]);
            }
            const data = { columns: ['grp', 'x', 'y'], rows: rows };
            const el = FigData.makeChartElement(data,
              { chart_type: 'bar', mapping: { x: 'grp', y: 'y', color: 'grp' } });
            el.transform = { x: 5, y: 5, w: 110, h: 80, rotation: 0 };
            el.name = 'r3-big';
            const cid = el.id;
            App.commit([{ op: 'add_element', element: el }],
              { label: 'mk-big', source: 'user' });
            return cid;
          }
        """)
        page.wait_for_timeout(800)
        # 点第一根柱子
        c = page.evaluate(MARK_CENTER_JS, 0)
        self.assertIsNotNone(c)
        page.mouse.click(c["x"], c["y"])
        page.wait_for_timeout(400)
        btn = page.evaluate(LOCATE_BTN_JS)
        self.assertIsNotNone(btn)
        t0 = time.time()
        page.mouse.click(btn["x"], btn["y"])
        page.wait_for_selector(".ui-modal.dt-modal tr.dt-focus", timeout=5000)
        elapsed_ms = (time.time() - t0) * 1000
        st = page.evaluate(DT_STATE_JS)
        self.assertTrue(st["open"])
        self.assertGreater(len(st["hits"]), 0)
        self.assertLess(elapsed_ms, 1000,
                        "5 万行数据表应在 1s 内出现目标行（实测 %.0fms）" % elapsed_ms)
        print("\n[D-50k] 数据表目标行可见耗时 %.0f ms" % elapsed_ms)
        ctx.close()


if __name__ == "__main__":
    unittest.main()
