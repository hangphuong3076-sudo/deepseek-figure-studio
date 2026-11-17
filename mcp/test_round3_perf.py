# -*- coding: utf-8 -*-
"""test_round3_perf.py — R2 性能轮 Playwright 验收。

1. compact marks 视觉等价：同一 300 点散点，阈值 100（compact）vs 默认
   （逐点）渲染后栅格化比对，差异像素近零。
2. compact 点选：>2000 点散点点击命中正确行；逐点颜色覆盖后仅该点单独
   渲染；「定位到原始数据」可用。
3. 向导抽样：>3000 行出现 [data-wizard-sample] 提示，小文件不出现。
"""
import shutil
import tempfile
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

# 300 点散点 spec（x/y 均匀散布、标记基本不重叠）。重叠区 fill/stroke
# 层序在单 path 中必然不同（先全 fill 后全 stroke），属方案固有差异，
# 故等价断言用稀疏数据验证几何与光栅一致性。
MAKE_SPEC_JS = r"""
(n) => {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push([(i % 20) * 50, 10 + Math.floor(i / 20) * 10,
               'g' + (i % 4), 'L' + i]);
  }
  return { chartType: 'scatter',
    mapping: { x: 'x', y: 'y', group: 'g' },
    data: { inline: { columns: ['x', 'y', 'g', 'label'], rows: rows } } };
}
"""

# 渲染两份 fragment 并栅格化比对：返回差异像素数与总数。
RASTER_DIFF_JS = r"""
async ({fragA, fragB, w, h}) => {
  async function raster(frag) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w +
      '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + frag + '</svg>';
    const img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = () => rej(new Error('svg raster fail'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0, w, h);
    return cx.getImageData(0, 0, w, h).data;
  }
  const a = await raster(fragA), b = await raster(fragB);
  let diff = 0, maxD = 0, sumD = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]),
                       Math.abs(a[i + 2] - b[i + 2]));
    if (d > 8) diff++;
    if (d > maxD) maxD = d;
    sumD += d;
  }
  return { diff: diff, total: a.length / 4, maxD: maxD,
           meanD: sumD / (a.length / 4) };
}
"""

ADD_BIG_SCATTER_JS = r"""
(n) => {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push([i, Math.sin(i / 20) * 10 + 20, 'g' + (i % 4), 'L' + i]);
  }
  const data = { columns: ['x', 'y', 'g', 'label'], rows: rows };
  const spec = { chart_type: 'scatter', mapping: { x: 'x', y: 'y', group: 'g' } };
  const el = FigData.makeChartElement(data, spec);
  el.transform = { x: 5, y: 5, w: 110, h: 80, rotation: 0 };
  el.name = 'perf-scatter';
  const cid = el.id;
  App.commit([{ op: 'add_element', element: el }], { label: 'mk-big', source: 'user' });
  return cid;
}
"""

CHART_PART_JS = (
    "window.App && window.App.ui ? JSON.parse(JSON.stringify("
    "window.App.ui.chartPart || null)) : null")

# compact 命中索引 + 屏幕坐标（第 k 个命中点）。
COMPACT_CLICK_POINT_JS = r"""
(k) => {
  const charts = (App.doc.elements || []).filter(e => e.type === 'chart');
  const c = charts[charts.length - 1];
  if (!c) return { err: 'no chart' };
  const dpi = App.doc.canvas.dpi || 300;
  const hits = FigData.chartHitIndex(c.chart, {
    width_mm: c.transform.w, height_mm: c.transform.h, dpi: dpi });
  if (!hits.length) return { err: 'no hits', n: 0 };
  const h = hits[Math.min(k, hits.length - 1)];
  const path = document.querySelector(
    '#svg-stage g[data-fig-id="' + c.id + '"] [data-compact-marks]');
  if (!path) return { err: 'no compact path' };
  const sp = new DOMPoint(h.x, h.y).matrixTransform(path.getScreenCTM());
  return { x: sp.x, y: sp.y, key: h.key, row: h.row, seriesKey: h.seriesKey,
           hits: hits.length };
}
"""

DOC_CHART_NODES_JS = r"""
(cid) => {
  const host = document.querySelector('#svg-stage g[data-fig-id="' + cid + '"]');
  if (!host) return { err: 'no host' };
  return {
    compact: host.querySelectorAll('[data-compact-marks]').length,
    pointKeys: host.querySelectorAll('[data-point-key]').length,
    red: (host.innerHTML.match(/#FF0000/g) || []).length
  };
}
"""

LOCATE_BTN_JS = r"""
() => {
  const sec = document.querySelector('[data-props-section="chart-mark"]');
  if (!sec) return null;
  const btn = [...sec.querySelectorAll('button')].find(b =>
    (b.textContent || '').indexOf('定位到原始数据') >= 0);
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
"""


@unittest.skipUnless(HAS_PLAYWRIGHT,
                     "Python playwright + chromium/Chrome 不可用，跳过")
class Round3PerfTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-r3p-data-")
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

    # ------------------------------------------------- 1. 视觉等价
    def test_compact_marks_visual_equivalence(self):
        ctx, page = self.open_page()
        spec = page.evaluate(MAKE_SPEC_JS, 300)
        W, H, DPI = 100, 80, 150
        opts = {"width_mm": W, "height_mm": H, "dpi": DPI}
        page.evaluate("(o)=>{window.__o=o;}", opts)
        frags = page.evaluate(
            """async ({spec, opts}) => {
              const individual = FigData.renderChartSVG(spec, opts);
              const old = FigData.COMPACT_MARKS_THRESHOLD;
              FigData.COMPACT_MARKS_THRESHOLD = 100;
              const compact = FigData.renderChartSVG(spec,
                Object.assign({}, opts, { compactMarks: true }));
              FigData.COMPACT_MARKS_THRESHOLD = old;
              return { individual, compact,
                       w: Math.round(opts.width_mm * opts.dpi / 25.4),
                       h: Math.round(opts.height_mm * opts.dpi / 25.4) };
            }""",
            {"spec": spec, "opts": opts})
        self.assertIn("data-compact-marks", frags["compact"])
        self.assertNotIn("data-compact-marks", frags["individual"])
        diff = page.evaluate(RASTER_DIFF_JS, {
            "fragA": frags["individual"], "fragB": frags["compact"],
            "w": frags["w"], "h": frags["h"]})
        # arc 子路径与 <circle> 图元光栅化 AA 存在固有微差（仅标记边缘，
        # meanD≈1.2/255）；重叠区 fill/stroke 层序亦不同。几何与结构一致，
        # 断言差异像素占比 <3%。
        self.assertLess(diff["diff"] / diff["total"], 0.03,
                        "compact 与逐点渲染像素差异过大: %s" % diff)
        self.assertLess(diff["meanD"], 3.0,
                        "平均像素差过大（非 AA 级）: %s" % diff)

    # ------------------------------------------------- 2. compact 点选
    def test_compact_click_select_override_locate(self):
        ctx, page = self.open_page()
        cid = page.evaluate(ADD_BIG_SCATTER_JS, 2500)
        page.wait_for_timeout(600)
        st = page.evaluate(DOC_CHART_NODES_JS, cid)
        self.assertGreaterEqual(st.get("compact"), 1)  # group 映射为单系列
        self.assertEqual(st.get("pointKeys"), 0)  # 默认点全部合并
        # 点中间一个命中点
        pt = page.evaluate(COMPACT_CLICK_POINT_JS, 1200)
        self.assertNotIn("err", pt, pt)
        page.mouse.click(pt["x"], pt["y"])
        page.wait_for_timeout(400)
        cp = page.evaluate(CHART_PART_JS)
        self.assertIsNotNone(cp)
        self.assertEqual(cp.get("part"), "point")
        self.assertEqual(cp.get("pointKey"), pt["key"])
        self.assertEqual(str(cp.get("row")), str(pt["row"]))
        self.assertTrue(cp.get("compact"))
        # 逐点颜色覆盖（与属性面板同一 op 形态）→ 仅该点单独渲染
        page.evaluate(
            """({cid, key}) => {
              App.commit([{ op: 'set_chart_properties', targets: [cid],
                properties: { presentation: { version: 1,
                  points: { [key]: { fill: '#FF0000' } } } } }],
                { label: 'pt-color', source: 'user' });
            }""",
            {"cid": cid, "key": pt["key"]})
        page.wait_for_timeout(600)
        st2 = page.evaluate(DOC_CHART_NODES_JS, cid)
        self.assertEqual(st2.get("pointKeys"), 1)   # 只有覆盖点有 data-point-key
        self.assertEqual(st2.get("red"), 1)
        self.assertGreaterEqual(st2.get("compact"), 1)
        # 定位到原始数据可用
        btn = page.evaluate(LOCATE_BTN_JS)
        self.assertIsNotNone(btn)
        page.mouse.click(btn["x"], btn["y"])
        page.wait_for_selector(".ui-modal.dt-modal", timeout=5000)
        cap = page.locator(".dt-caption").inner_text()
        self.assertIn("第 %d 行" % (pt["row"] + 1), cap)

    # ------------------------------------------------- 3. 向导抽样提示
    def _write_csv(self, name, n):
        p = Path(self.server.datadir) / name if hasattr(self.server, "datadir") else None
        p = Path(tempfile.gettempdir()) / ("fig-r3p-" + name)
        with open(p, "w", encoding="utf-8") as f:
            f.write("grp,x,y,label\n")
            for i in range(n):
                f.write("g%d,%d,%f,L%d\n" % (i % 4, i, (i % 50) + 0.5, i))
        return str(p)

    def _open_wizard(self, page, path):
        with page.expect_file_chooser() as fc_info:
            page.locator("#panel-import").get_by_role(
                "button", name="导入数据", exact=True).click()
        fc_info.value.set_files(path)
        page.wait_for_selector(".dw-modal", timeout=30000)

    def test_wizard_sample_note_large_and_small(self):
        ctx, page = self.open_page()
        big = self._write_csv("big.csv", 4000)
        self._open_wizard(page, big)
        page.wait_for_selector("[data-wizard-sample]", timeout=20000)
        note = page.locator("[data-wizard-sample]").inner_text()
        self.assertIn("抽样显示", note)
        self.assertIn("创建后按全部数据绘制", note)
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        small = self._write_csv("small.csv", 50)
        self._open_wizard(page, small)
        page.wait_for_selector("[data-wizard-preview] svg", timeout=20000)
        page.wait_for_timeout(800)
        self.assertEqual(
            page.locator("[data-wizard-sample]").count(), 0,
            "小文件不应出现抽样提示")

    # ------------------------------------ 4. compact 仅画布，导出逐点
    def test_compact_canvas_only_export_individual(self):
        ctx, page = self.open_page()
        cid = page.evaluate(ADD_BIG_SCATTER_JS, 3000)
        page.wait_for_timeout(800)
        # 画布 DOM：compact 合并路径存在
        st = page.evaluate(DOC_CHART_NODES_JS, cid)
        self.assertGreaterEqual(st.get("compact"), 1)
        self.assertEqual(st.get("pointKeys"), 0)
        # 导出路径（FigRender.toSVG 默认）→ 逐点元素，无 compact
        res = page.evaluate(
            """(cid) => {
              const el = FigDoc.get(App.doc, cid);
              const svg = FigRender.toSVG(App.doc, { includeGuides: false });
              const host = document.createElement('div');
              host.innerHTML = svg;
              const g = host.querySelector('[data-fig-id="' + cid + '"]');
              return {
                compactInExport: !!(g && g.querySelector('[data-compact-marks]')),
                pointKeys: g ? g.querySelectorAll('[data-point-key]').length : -1
              };
            }""", cid)
        self.assertFalse(res["compactInExport"],
                         "导出 SVG 不应包含 compact 合并路径")
        self.assertEqual(res["pointKeys"], 3000,
                         "导出 SVG 应保留全部逐点标记")

    # --------------------------- 5. previewApplyFast 与 FigOps 对拍
    def test_preview_fast_matches_figops(self):
        ctx, page = self.open_page()
        res = page.evaluate(
            """() => {
              const F = globalThis.FigDoc, O = globalThis.FigOps;
              const mk = (id, x, y, w, h, parent, extra) => Object.assign({
                id, type: 'rect', parent_id: parent || null,
                transform: { x, y, w, h },
                style: { fill: '#fff', stroke: '#000' }
              }, extra || {});
              const base = {
                version: '1.0', title: 't', canvas: { width_mm: 210, height_mm: 297, unit: 'mm' },
                elements: [
                  mk('p1', 10, 10, 100, 80, null, { type: 'panel',
                    panelLayout: { padding_mm: 5 } }),
                  mk('c1', 0.1, 0.2, 0.3, 0.4, 'p1',
                    { style: { panelRelative: true, fill: '#fff', stroke: '#000' } }),
                  mk('r1', 20, 20, 10, 10),
                  mk('g1', 50, 50, 20, 20, null, { type: 'group' }),
                  mk('gk1', 1, 1, 2, 2, 'g1')
                ],
                history: []
              };
              const docBefore = JSON.stringify(base);
              const cmp = (label, ops) => {
                const fast = Editor.previewApplyFast(base, ops);
                const slow = O.applyAll(F.clone(base), ops, { label: 'x' }).doc;
                const grab = (d) => d.elements.map(e =>
                  [e.id, e.transform && e.transform.x, e.transform && e.transform.y,
                   e.transform && e.transform.w, e.transform && e.transform.h,
                   e.transform && e.transform.rotation,
                   e.transform && e.transform.nx,
                   e.transform && e.transform.ny]).map(String).join(',');
                const a = grab(fast), b = grab(slow);
                return { label, same: JSON.stringify(a) === JSON.stringify(b),
                         fast: a, slow: b };
              };
              const out = [];
              out.push(cmp('plain-move', [{ op: 'move', targets: ['r1'], dx: 5, dy: -3 }]));
              out.push(cmp('group-move', [{ op: 'move', targets: ['g1'], dx: 4, dy: 6 }]));
              out.push(cmp('panelRelative', [{ op: 'move', targets: ['c1'], dx: 10, dy: 10 }]));
              out.push(cmp('alt-dup', [{ op: 'add_element', element: mk('r2', 30, 30, 10, 10) }]));
              out.push({ label: 'doc-unmutated',
                         same: JSON.stringify(base) === docBefore });
              return out;
            }""")
        for r in res:
            self.assertTrue(r["same"], "%s: fast=%s slow=%s" % (
                r["label"], r.get("fast"), r.get("slow")))


if __name__ == "__main__":
    unittest.main()
