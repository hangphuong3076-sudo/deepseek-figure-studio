# -*- coding: utf-8 -*-
"""test_dual_axis_ui.py — R4-HB 双纵轴 Playwright 验收。

覆盖：
  a) 向导：3 数值列 CSV → 多折线图 → 纵轴槽多选两列 → 一列设右轴 →
     创建后画布 SVG 含右轴刻度与「（右轴）」图例；
  b) 属性面板：系列 左轴/右轴 切换 + 右轴标题/范围输入 → 提交生效；
  c) 点选右轴数据点 → 「定位到原始数据」高亮对应行。
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

# 含时间列 + 分组列 → 推荐出「多折线图」；a/b/c 三个数值列做宽表纵轴
CSV_TEXT = "time,grp,a,b,c\n" + "\n".join(
    "2024-01-%02d,%s,%d,%d,%d" % (i, "AB"[(i - 1) % 2],
                                 10 + i * 3, 100 + i * 40, 5 + i * 2)
    for i in range(1, 9)
) + "\n"

# 画布 SVG 中右轴/图例断言（只读 evaluate）。
# 注意：#svg-stage 本身就是根 <svg>，图表片段直接内联，无嵌套 <svg>。
CANVAS_STATE_JS = r"""
() => {
  const stage = document.getElementById('svg-stage');
  const html = stage ? stage.innerHTML : '';
  const chart = (App.doc.elements || []).find(e => e.type === 'chart');
  return {
    y2ticks: (html.match(/axis-tick-y2/g) || []).length,
    suffix: html.indexOf('（右轴）') >= 0,
    y2title: html.indexOf('axis-title-y2') >= 0,
    mapping: chart && chart.chart && chart.chart.mapping,
    axes: chart && chart.chart && chart.chart.axes
  };
}
"""

DOC_CHART_JS = r"""
() => {
  const chart = (App.doc.elements || []).find(e => e.type === 'chart');
  if (!chart) return null;
  return { id: chart.id, mapping: chart.chart.mapping, axes: chart.chart.axes };
}
"""


@unittest.skipUnless(HAS_PLAYWRIGHT,
                     "Python playwright + chromium/Chrome 不可用，跳过")
class DualAxisUiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-hb-data-")
        cls.fixtures = tempfile.mkdtemp(prefix="fig-hb-fix-")
        cls.csv_path = str(Path(cls.fixtures) / "hb-wide.csv")
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

    def open_page(self):
        ctx = self.browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#panel-import button", timeout=20000)
        page.wait_for_timeout(1200)
        return page

    def open_wizard(self, page):
        with page.expect_file_chooser() as fc_info:
            page.locator("#panel-import").get_by_role(
                "button", name="导入数据", exact=True).click()
        fc_info.value.set_files(self.csv_path)
        page.wait_for_selector(".dw-modal", timeout=20000)
        page.wait_for_timeout(400)

    def goto_step(self, page, n):
        page.locator('.dw-steps [data-step-btn="%d"]' % n).click()
        page.wait_for_timeout(300)

    def pick_template(self, page, chart_type):
        """按 chart_type 选模板单选（aria-label='模板 <name>'）。"""
        return page.evaluate(r"""
(ct) => {
  const FP = (typeof FigPresets !== 'undefined') ? FigPresets : window.FigPresets;
  const tpls = (FP && FP.templates()) || [];
  const hit = tpls.find(t => t.chart_type === ct);
  if (!hit) return { err: 'no template ' + ct };
  const radios = [...document.querySelectorAll('.dw-modal input[type=radio]')];
  for (const r of radios) {
    if ((r.getAttribute('aria-label') || '') === '模板 ' + hit.name) {
      r.click();
      return { ok: true, name: hit.name, id: hit.id };
    }
  }
  return { err: 'radio not found for ' + hit.name,
           labels: radios.map(r => r.getAttribute('aria-label')) };
}
""", chart_type)

    def create_chart(self, page):
        btn = page.locator(".ui-modal-footer button").filter(has_text="创建图表")
        box = btn.bounding_box()
        self.assertIsNotNone(box)
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_selector(".dw-modal", state="detached", timeout=20000)
        page.wait_for_timeout(600)

    # ------------------------------------------------------------ tests

    def chip_cols(self, page):
        return page.evaluate("""() =>
          [...document.querySelectorAll('.dw-ycol-chip')]
            .map(c => c.getAttribute('data-col'))""")

    def wizard_dual_y(self, page, chart_type="line_multi"):
        """走向导选模板并凑满 2 个纵轴列，返回 (colL, colR)。"""
        self.goto_step(page, 2)
        info = self.pick_template(page, chart_type)
        self.assertTrue(info.get("ok"), "选模板失败：%s" % info)
        page.wait_for_timeout(400)
        # 纵轴候选列现在是 a/b/c（grp 非数值、time 非数值）
        for col in ("a", "b", "c"):
            if len(self.chip_cols(page)) >= 2:
                break
            if col in self.chip_cols(page):
                continue
            sel = page.locator(".dw-ycol-addsel")
            if not sel.count():
                break
            opts = sel.first.locator("option").evaluate_all(
                "els => els.map(e => e.value)")
            if col not in opts:
                continue
            sel.first.select_option(col)
            page.wait_for_timeout(400)
        cols = self.chip_cols(page)
        self.assertEqual(len(cols), 2, "应凑满 2 个纵轴列：%s" % cols)
        return cols[0], cols[1]

    def test_wizard_wide_y_right_axis_create(self):
        page = self.open_page()
        self.open_wizard(page)
        colL, colR = self.wizard_dual_y(page)

        # 右轴列设为右轴
        page.locator('.dw-ycol-chip[data-col="%s"] select.dw-ycol-axis' % colR).select_option("right")
        page.wait_for_timeout(500)
        self.assertEqual(
            page.locator('.dw-ycol-chip[data-col="%s"]' % colR).get_attribute("data-axis"),
            "right")

        self.create_chart(page)
        st = page.evaluate(CANVAS_STATE_JS)
        self.assertEqual(sorted(st["mapping"]["ys"]), sorted([colL, colR]),
                         "mapping.ys 应为两列")
        self.assertEqual(st["mapping"]["y"], colL)
        self.assertIsNone(st["mapping"].get("group"), "宽表不应有 group")
        self.assertEqual((st["axes"].get("y2") or {}).get("series"), [colR], "右列应在右轴")
        self.assertGreater(st["y2ticks"], 0, "画布应有右轴刻度")
        self.assertTrue(st["suffix"], "图例应有「（右轴）」")
        page.close()

    def test_props_axis_toggle_and_range(self):
        page = self.open_page()
        self.open_wizard(page)
        colL, colR = self.wizard_dual_y(page)
        self.create_chart(page)

        # 选中图表元素 → 属性面板出现系列纵轴控件
        cid = page.evaluate(DOC_CHART_JS)["id"]
        page.evaluate("(id)=>{ if(App.select) App.select([id]); }", cid)
        page.wait_for_timeout(600)
        n = page.evaluate("""() => {
          const sels = [...document.querySelectorAll('select')].filter(s =>
            (s.getAttribute('aria-label') || '').indexOf('系列') === 0);
          return sels.length;
        }""")
        self.assertGreaterEqual(n, 2, "属性面板应列出 ≥2 个系列轴选择：%d" % n)

        # 把右列切到右轴
        page.evaluate("""(col) => {
          const sels = [...document.querySelectorAll('select')].filter(s =>
            (s.getAttribute('aria-label') || '').indexOf('系列') === 0);
          const target = sels.find(s =>
            (s.getAttribute('aria-label') || '') === '系列「' + col + '」纵轴');
          if (target) { target.value = 'right'; target.dispatchEvent(new Event('change')); }
          return !!target;
        }""", colR)
        page.wait_for_timeout(700)
        st = page.evaluate(CANVAS_STATE_JS)
        self.assertEqual((st["axes"].get("y2") or {}).get("series"), [colR], "右列应被切到右轴")
        self.assertGreater(st["y2ticks"], 0)

        # 右轴标题 + 范围输入（任一右轴系列存在时显示）
        hasTitleInput = page.evaluate("""() =>
          [...document.querySelectorAll('input')].some(i =>
            i.getAttribute('aria-label') === '右轴标题')""")
        self.assertTrue(hasTitleInput, "应有右轴标题输入")
        page.evaluate("""() => {
          const inp = [...document.querySelectorAll('input')].find(i =>
            i.getAttribute('aria-label') === '右轴标题');
          inp.value = '右轴B';
          inp.dispatchEvent(new Event('change'));
        }""")
        page.wait_for_timeout(700)
        st = page.evaluate(CANVAS_STATE_JS)
        self.assertEqual(st["axes"]["y2"]["label"], "右轴B")
        self.assertIn("axis-title-y2", page.evaluate(
            "document.getElementById('svg-stage').innerHTML"))

        # 切回左轴 → y2 移除
        page.evaluate("""(col) => {
          const sels = [...document.querySelectorAll('select')].filter(s =>
            (s.getAttribute('aria-label') || '').indexOf('系列') === 0);
          const target = sels.find(s =>
            (s.getAttribute('aria-label') || '') === '系列「' + col + '」纵轴');
          if (target) { target.value = 'left'; target.dispatchEvent(new Event('change')); }
        }""", colR)
        page.wait_for_timeout(700)
        st = page.evaluate(CANVAS_STATE_JS)
        self.assertFalse(st["axes"].get("y2"), "全部回左轴后 y2 应移除")
        page.close()

    def test_right_point_locate_source_row(self):
        """点选右轴系列数据点 → 定位到原始数据高亮对应行。"""
        page = self.open_page()
        # 直接种一个双轴图表（比走向导快）：用 FigData+FigOps 在页面内建
        page.evaluate(r"""
() => {
  const data = { columns: ['x','a','b'], rows: [
    [1,10,100],[2,20,200],[3,15,150],[4,30,300]] };
  const el = FigData.makeChartElement(data, {
    chart_type: 'line_multi', mapping: { x:'x', y:'a', ys:['a','b'] } });
  el.chart.axes.y2 = { series: ['b'], label: '右轴B' };
  el.transform = { x: 20, y: 20, w: 100, h: 70 };
  App.commit([{ op: 'add_element', element: el }], { label: 'hb-seed', source: 'user' });
}
""")
        page.wait_for_timeout(1200)
        # 点右轴系列（b）的一个点：series key = series|b|s:b，找其 marker 的屏幕位置
        pos = page.evaluate(r"""
() => {
  const host = document.querySelector('#svg-stage [data-fig-id]');
  const marks = [...document.querySelectorAll(
    '#svg-stage [data-series-key="series|b|s:b"][data-point-key]')];
  if (!marks.length) return { err: 'no marks', n: 0 };
  const m = marks[marks.length - 1];
  const r = m.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, n: marks.length,
           row: m.getAttribute('data-row') };
}
""")
        self.assertNotIn("err", pos, "应找到右轴系列数据点：%s" % pos)
        page.mouse.click(pos["x"], pos["y"])
        part = None
        for _ in range(10):
            page.wait_for_timeout(200)
            part = page.evaluate(r"""() => {
              const cp = window.App && App.ui ? App.ui.chartPart : null;
              return cp;
            }""")
            if part and part.get("row") is not None:
                break
        self.assertIsNotNone(part and part.get("row"),
                             "点选后 chartPart.row 应存在：%s" % part)
        # 属性面板应出现 chart-mark 区 + 定位按钮
        btn = page.evaluate(r"""
() => {
  const sec = document.querySelector('[data-props-section="chart-mark"]');
  if (!sec) return null;
  const b = [...sec.querySelectorAll('button')].find(x =>
    (x.textContent || '').indexOf('定位到原始数据') >= 0);
  if (!b || b.offsetParent === null) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
""")
        self.assertIsNotNone(btn, "点选后应出现「定位到原始数据」")
        page.mouse.click(btn["x"], btn["y"])
        page.wait_for_selector(".ui-modal.dt-modal", timeout=8000)
        page.wait_for_timeout(400)
        dt = page.evaluate(r"""
() => {
  const modal = document.querySelector('.ui-modal.dt-modal');
  if (!modal) return { open: false };
  const hits = [...modal.querySelectorAll('tr.dt-hit')].map(tr => ({
    idx: tr.getAttribute('data-row-idx'),
    focus: tr.classList.contains('dt-focus') }));
  return { open: true, hits: hits };
}
""")
        self.assertTrue(dt.get("open"), "应打开数据表弹窗")
        self.assertTrue(dt["hits"], "应有高亮行")
        # 点的是最后一个 mark（row=3，即原始数据第 4 行）
        self.assertEqual(dt["hits"][0]["idx"], "3",
                         "高亮行应对应被点的数据行：%s" % dt)
        page.close()

    # R4-HB2：右轴标题/刻度标签/右图例两两不重叠且在图表框内（getBBox）
    COLLIDE_JS = r"""
    (chartType) => {
      const g = [...document.querySelectorAll('#svg-stage g[data-chart-type]')]
        .filter(n => n.getAttribute('data-chart-type') === chartType).pop();
      if (!g) return { err: 'no chart g ' + chartType };
      const parts = {};
      // getBBox 不含元素自身 transform：右轴标题 rotate(-90 rx ry)，
      // 需把未旋转 bbox 四角绕 (rx,ry) 旋转后取外接矩形。
      function boxOf(el) {
        const b = el.getBBox();
        const tr = el.getAttribute('transform') || '';
        const m = tr.match(/rotate\(\s*(-?[\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)\s*\)/);
        if (!m) return { x: b.x, y: b.y, w: b.width, h: b.height };
        const ang = parseFloat(m[1]) * Math.PI / 180;
        const cx = parseFloat(m[2]), cy = parseFloat(m[3]);
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const cs4 = [[b.x, b.y], [b.x + b.width, b.y],
                     [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
          .map(p => {
            const dx = p[0] - cx, dy = p[1] - cy;
            return [cx + dx * cs - dy * sn, cy + dx * sn + dy * cs];
          });
        const xs = cs4.map(p => p[0]), ys = cs4.map(p => p[1]);
        const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
        const y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      [['legend', 'legend'], ['tick', 'axis-tick-y2'],
       ['title', 'axis-title-y2']].forEach(function (pair) {
        parts[pair[0]] = [...g.querySelectorAll(
          '[data-chart-part="' + pair[1] + '"]')].map(el => {
          const b = boxOf(el);
          return { x: b.x, y: b.y, w: b.w, h: b.h,
                   t: (el.textContent || '').slice(0, 20) };
        });
      });
      // 图表框 = 元素 transform(w,h mm) × canvas.dpi → 内部 px 坐标
      const el = (App.doc.elements || []).find(e => e.type === 'chart' &&
        e.chart && e.chart.chartType === chartType);
      const dpi = (App.doc.canvas && App.doc.canvas.dpi) || 300;
      const W = el && el.transform ? el.transform.w * dpi / 25.4 : 0;
      const H = el && el.transform ? el.transform.h * dpi / 25.4 : 0;
      return { parts: parts, W: W, H: H };
    }
    """

    @staticmethod
    def _overlap(a, b, eps=0.5):
        return (a["x"] < b["x"] + b["w"] - eps and
                b["x"] < a["x"] + a["w"] - eps and
                a["y"] < b["y"] + b["h"] - eps and
                b["y"] < a["y"] + a["h"] - eps)

    def _check_no_collision(self, page, chart_type):
        out = page.evaluate(self.COLLIDE_JS, chart_type)
        self.assertNotIn("err", out, out)
        parts = out["parts"]
        self.assertTrue(parts["tick"], "%s 应有右轴刻度标签" % chart_type)
        self.assertTrue(parts["title"], "%s 应有右轴标题" % chart_type)
        self.assertTrue(parts["legend"], "%s 应有图例文本" % chart_type)
        groups = {"legend": parts["legend"], "tick": parts["tick"],
                  "title": parts["title"]}
        # 组间两两不重叠
        keys = list(groups)
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                for a in groups[keys[i]]:
                    for b in groups[keys[j]]:
                        self.assertFalse(
                            self._overlap(a, b),
                            "%s %s「%s」与 %s「%s」重叠：%s vs %s" % (
                                chart_type, keys[i], a["t"], keys[j], b["t"],
                                a, b))
        # 全部在图表框 [0,W]x[0,H] 内（1px 容差）
        for name, boxes in groups.items():
            for b in boxes:
                self.assertGreaterEqual(b["x"], -1.0,
                                        "%s %s 越出左界：%s" % (chart_type, name, b))
                self.assertGreaterEqual(b["y"], -1.0,
                                        "%s %s 越出上界：%s" % (chart_type, name, b))
                self.assertLessEqual(b["x"] + b["w"], out["W"] + 1.0,
                                     "%s %s 越出右界：%s (W=%s)" % (
                                         chart_type, name, b, out["W"]))
                self.assertLessEqual(b["y"] + b["h"], out["H"] + 1.0,
                                     "%s %s 越出下界：%s (H=%s)" % (
                                         chart_type, name, b, out["H"]))

    def test_dual_axis_right_side_no_collision(self):
        """双轴 line_multi + scatter：右图例/右刻度/右轴标题互不重叠。"""
        page = self.open_page()
        page.evaluate(r"""
() => {
  const specs = [
    { ct: 'line_multi', data: { columns: ['x','a','b','c'], rows: [
      [1,10,100,5],[2,20,200,15],[3,15,150,10],[4,30,300,20]] },
      mapping: { x:'x', y:'a', ys:['a','b','c'] } },
    { ct: 'scatter', data: { columns: ['x','a','b'], rows: [
      [1,10,100],[2,20,200],[3,15,150],[4,30,300],[2.5,25,175]] },
      mapping: { x:'x', y:'a', ys:['a','b'] } }
  ];
  specs.forEach(function (s, i) {
    const el = FigData.makeChartElement(s.data, {
      chart_type: s.ct, mapping: s.mapping });
    el.chart.axes.y2 = { series: s.ct === 'line_multi' ? ['c'] : ['b'],
                         label: '右轴标题' + s.ct };
    el.chart.legend = 'right';
    el.transform = { x: 10 + i * 5, y: 10, w: 90, h: 65 };
    App.commit([{ op: 'add_element', element: el }],
               { label: 'hb2-seed-' + s.ct, source: 'user' });
  });
}
""")
        page.wait_for_timeout(1500)
        self._check_no_collision(page, "line_multi")
        self._check_no_collision(page, "scatter")
        page.close()


if __name__ == "__main__":
    unittest.main()
