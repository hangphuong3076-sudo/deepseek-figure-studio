# -*- coding: utf-8 -*-
"""test_jargon_gate_ui.py — G18 界面术语门禁（真实浏览器运行时扫描）。

在隔离实例里导入 sample.csv 建图后，逐个打开右侧全部页签、设置、导出、
历史对比、工程、SVG 导入、Excel 预览、粘贴对话框、导入向导四步、AI 面板，
收集可见文本 + title / placeholder / aria-label（排除折叠 <details> 与
标了 data-tech="1" 的技术细节区），断言不命中禁用术语。

禁用：蛇形/驼峰标识符直出、图表类型枚举直出、「渲染器」「空骨架」
「rev N」、sha256/SHA-256 出现在 title/技术细节之外。
允许：CSV/JSON/SVG/Excel/PNG/PDF/TIFF/DPI/mm/pt、API Key、DSH、期刊规格、
.figureproj.json 等（见 ALLOWED_TERMS）。
"""
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from test_modal_layout import (
    HAS_PLAYWRIGHT, SAMPLE_CSV, _ViewerServer, _launch_chromium,
    _make_xlsx, _playwright_ready,
)

HERE = Path(__file__).resolve().parent

# ---- 允许术语（界面可正常出现，不视为禁用）----
ALLOWED_TERMS = [
    "CSV", "JSON", "SVG", "Excel", "PNG", "PDF", "TIFF", "DPI", "mm", "pt",
    "API Key", "DSH", "期刊", "规格", ".figureproj.json",
    # 科学/统计通用缩写与单位（非内部标识符）
    "SD", "SEM", "p 值", "ROC", "UMAP", "PCA", "PCR", "XRD", "FTIR", "NMR",
    "Raman", "Transmittance", "Absorbance", "n=", "mm、",
]

# ---- 禁用术语：内部字段/操作/存储标识符（snake_case / camelCase）----
BANNED_IDENTIFIERS = [
    "uncertainty_source", "uncertainty_column", "chartType", "chart_type",
    "App.commit", "App_commit", "doc.anchors", "element_id", "elementId",
    "localStorage", "locator", "payload", "canonical", "llm",
    "apply_schematic", "set_scientific_contract", "source_info",
    "value_fingerprint", "content_version", "doc_sha256", "statistics_review",
    "results_question", "figure_claim", "falsifier", "evidence_role",
    "unique_gain", "destination", "decisive_comparison",
    "decisive_comparisons", "hero_panel", "hero_panel_reference",
    "n_definition", "biological_replicates", "technical_replicates",
    "source_data", "unit_x", "unit_y", "p_value", "characterization",
    "fit_source", "fit_model", "x_label", "y_label", "manual_edits",
    "parse_options", "number_format", "schema_version",
    "question_claim_falsifier", "panel_evidence_roles", "statistics_trace",
    "significance_declarations", "physical_size", "NOT_AUDITABLE",
]

# ---- 禁用术语：图表类型枚举直出（应改用中文图型名）----
BANNED_CHART_ENUMS = [
    "bar_grouped", "bar_stacked", "line_multi", "scatter_grouped",
    "stacked_area", "diagram_flow", "diagram_architecture",
    # 单词图表类型（出现在类型语境即违规；用词边界避免误伤）
    "bar", "scatter", "heatmap", "histogram", "box", "violin", "bubble",
    "pie", "donut", "radar", "dotplot", "volcano", "forest", "paired",
    "sankey", "treemap", "network", "umap", "pca", "survival", "venn",
    "taylor", "joyplot", "parallel", "marginal", "roc",
]

# ---- 禁用词（与大小写/语境无关的固定词）----
BANNED_WORDS = ["渲染器", "空骨架"]

# 驼峰标识符：要求 ≥2 个小写字母前缀，避免把 eV/pH 等单位误判为标识符
CAMEL_RE = re.compile(r"\b[a-z]{2,}[A-Z][a-zA-Z0-9]*\b")
REV_RE = re.compile(r"\brev\s*\d+\b", re.IGNORECASE)
SHA_RE = re.compile(r"sha-?256", re.IGNORECASE)
# F5：预览失败等场景下，开发者报错/内部字段名不得直出（原始报错只允许进 data-tech）
DEV_LEAK_RE = re.compile(
    r"FigRender|renderChartSVG|mapping\.|opts\.|MISSING_MATERIALS|chartType")

# 收集可见文本 + title/placeholder/aria-label；排除折叠 details 与 data-tech="1"
COLLECT_JS = r"""
(rootSel) => {
  const root = rootSel ? document.querySelector(rootSel) : document.body;
  if (!root) return [];
  const out = [];
  const seen = new Set();
  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('[data-tech="1"]')) return false;
    const d = el.closest('details');
    if (d && !d.open) return false;
    if (el.hidden) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
  }
  function attrs(el) {
    const r = [];
    for (const a of ['title','placeholder','aria-label']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && v.trim()) r.push(a + '=' + v.trim());
    }
    return r;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = walker.nextNode())) {
    if (!visible(n)) continue;
    let directText = '';
    for (const c of n.childNodes) if (c.nodeType === 3) directText += c.textContent;
    directText = directText.trim();
    const tag = n.tagName.toLowerCase();
    const isField = /^(input|textarea|select|button|a|summary|option|label|th|td|h[1-6]|p|span|div|li|dt|dd|legend)$/.test(tag);
    if (directText && isField) {
      const key = tag + '|' + directText.slice(0,80);
      if (!seen.has(key)) { seen.add(key); out.push('TEXT:' + directText.slice(0,300)); }
    }
    const at = attrs(n);
    if (at.length) {
      const key = 'ATTR|' + at.join('|');
      if (!seen.has(key)) { seen.add(key); out.push(key); }
    }
    if (tag === 'input' && (n.type==='text'||n.type==='password'||!n.type) && n.value) {
      const key='VAL|'+n.value.slice(0,80);
      if(!seen.has(key)){seen.add(key);out.push('VAL:'+n.value.slice(0,300));}
    }
  }
  return out;
}
"""


def _violations(items):
    """返回 [(item, reason)]；sha256 只在 title 之外违规。"""
    bad = []
    ident_re = re.compile(
        r"(?<![A-Za-z0-9_])(" + "|".join(
            re.escape(t) for t in sorted(BANNED_IDENTIFIERS, key=len, reverse=True)
        ) + r")(?![A-Za-z0-9_])")
    enum_re = re.compile(
        r"(?<![A-Za-z0-9_])(" + "|".join(
            re.escape(t) for t in sorted(BANNED_CHART_ENUMS, key=len, reverse=True)
        ) + r")(?![A-Za-z0-9_])")
    for it in items:
        is_title_attr = it.startswith("ATTR|") and "title=" in it.split("|")[1] if "|" in it else False
        # sha256：title 属性豁免
        if SHA_RE.search(it) and not (it.startswith("ATTR|") and it.lstrip("ATTR|").startswith("title=")):
            bad.append((it, "sha256"))
            continue
        if REV_RE.search(it):
            bad.append((it, "rev N"))
            continue
        for w in BANNED_WORDS:
            if w in it:
                bad.append((it, w))
                break
        else:
            m = ident_re.search(it)
            if m:
                bad.append((it, "标识符:" + m.group(1)))
                continue
            m = enum_re.search(it)
            if m:
                bad.append((it, "图表枚举:" + m.group(1)))
                continue
            m = CAMEL_RE.search(it)
            if m:
                # 排除允许术语里的 camelCase 误报（目前无）
                bad.append((it, "驼峰:" + m.group(0)))
                continue
    return bad


@unittest.skipUnless(HAS_PLAYWRIGHT and _playwright_ready(),
                     "需要 Python playwright + 可用浏览器")
class JargonGateUITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.datadir = tempfile.mkdtemp(prefix="fig-jargon-data-")
        cls.fixtures = tempfile.mkdtemp(prefix="fig-jargon-fix-")
        cls.server = _ViewerServer(cls.datadir)
        try:
            cls.server.wait_ready()
        except Exception:
            cls.server.stop()
            shutil.rmtree(cls.datadir, ignore_errors=True)
            shutil.rmtree(cls.fixtures, ignore_errors=True)
            raise
        cls.xlsx_path = str(Path(cls.fixtures) / "jargon-fixture.xlsx")
        _make_xlsx(cls.xlsx_path)

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

    def open_page(self):
        ctx = self.browser.new_context(viewport={"width": 1280, "height": 860})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#panel-import button", timeout=20000)
        page.wait_for_timeout(1200)
        return page

    def collect(self, page, sel=None):
        return page.evaluate(COLLECT_JS, sel)

    def close_top_modal(self, page):
        page.keyboard.press("Escape")
        page.wait_for_timeout(350)
        # 若弹出放弃确认，点取消保留现场
        ov = page.locator("#modal-root > .ui-modal-overlay, .ui-modal-overlay")
        if ov.count() > 1:
            for txt in ("取消", "确定", "关闭"):
                b = ov.last.locator(".ui-modal-footer button").filter(has_text=txt)
                if b.count():
                    try:
                        b.first.click()
                    except Exception:
                        pass
                    page.wait_for_timeout(250)
                    break

    def test_all_surfaces_jargon_free(self):
        page = self.open_page()
        all_items = []          # (surface, item)
        def cap(label, sel=None):
            for it in self.collect(page, sel):
                all_items.append((label, it))

        # 初始页（含 AI 面板默认态、import 面板）
        cap("INIT", None)
        cap("AI panel", "#panel-ai")

        # 各页签
        for tab in ["science", "diagram", "anchors", "layers", "props",
                    "templates", "presets", "history", "store"]:
            try:
                page.locator("#tab-" + tab).click()
                page.wait_for_timeout(500)
                cap("TAB " + tab, "#panel-" + tab)
            except Exception:
                pass

        # 导入向导四步（真实文件选择 + 步骤导航）
        try:
            with page.expect_file_chooser() as fc:
                page.locator("#panel-import").get_by_role(
                    "button", name="导入数据", exact=True).click()
            fc.value.set_files(str(SAMPLE_CSV))
            page.wait_for_selector(".dw-modal", timeout=20000)
            page.wait_for_timeout(400)
            for s in (1, 2, 3, 4):
                if s > 1:
                    page.locator('.dw-steps [data-step-btn="%d"]' % s).click()
                    page.wait_for_timeout(400)
                cap("WIZARD step%d" % s, ".dw-modal")
            # 不创建，直接关闭（Escape → 可能弹放弃确认）
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            ov = page.locator(".ui-modal-overlay")
            if ov.count() > 1:
                b = ov.last.locator(".ui-modal-footer button").filter(has_text="放弃")
                if b.count():
                    b.first.click()
                else:
                    b2 = ov.last.locator(".ui-modal-footer button").filter(has_text="取消")
                    if b2.count():
                        b2.first.click()
            page.wait_for_timeout(300)
        except Exception:
            pass

        # 建图（重新走一遍向导到第 4 步点创建）→ 选中图表看属性/模板/历史
        chart_ready = False
        try:
            with page.expect_file_chooser() as fc:
                page.locator("#panel-import").get_by_role(
                    "button", name="导入数据", exact=True).click()
            fc.value.set_files(str(SAMPLE_CSV))
            page.wait_for_selector(".dw-modal", timeout=20000)
            page.wait_for_timeout(400)
            for s in (2, 3, 4):
                page.locator('.dw-steps [data-step-btn="%d"]' % s).click()
                page.wait_for_timeout(350)
            cbtn = page.locator(".ui-modal-footer button").filter(has_text="创建图表")
            if cbtn.count():
                cbtn.first.click()
                page.wait_for_selector(".dw-modal", state="detached", timeout=20000)
                page.wait_for_timeout(500)
                chart_ready = True
        except Exception:
            pass
        if chart_ready:
            page.evaluate(
                "()=>{const c=(App.doc.elements||[]).find(e=>e.type==='chart');"
                "if(c&&App.select)App.select([c.id]);}")
            page.wait_for_timeout(400)
            for tab in ("props", "templates", "history", "science"):
                try:
                    page.locator("#tab-" + tab).click()
                    page.wait_for_timeout(500)
                    cap("TAB " + tab + " (chart)", "#panel-" + tab)
                except Exception:
                    pass

        # 设置对话框
        try:
            page.locator("#btn-settings").click()
            page.wait_for_timeout(700)
            cap("SETTINGS", ".ui-modal")
            self.close_top_modal(page)
        except Exception:
            pass

        # 导出对话框
        try:
            page.locator("#btn-export").click()
            page.wait_for_timeout(700)
            cap("EXPORT", ".ui-modal")
            self.close_top_modal(page)
        except Exception:
            pass

        # 粘贴对话框
        try:
            page.locator("#panel-import").get_by_role(
                "button", name="粘贴数据", exact=True).click()
            page.wait_for_timeout(500)
            cap("PASTE", ".ui-modal")
            self.close_top_modal(page)
        except Exception:
            pass

        # SVG 导入（文件选择 → 可能弹预览对话框）
        try:
            svg = Path(self.fixtures) / "gate.svg"
            svg.write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">'
                '<rect width="50" height="50" fill="red"/></svg>', encoding="utf-8")
            with page.expect_file_chooser() as fc:
                page.locator("#panel-import").get_by_role(
                    "button", name="导入 SVG", exact=True).click()
            fc.value.set_files(str(svg))
            page.wait_for_timeout(1200)
            cap("SVG IMPORT", ".ui-modal")
            self.close_top_modal(page)
        except Exception:
            pass

        # Excel 预览对话框
        try:
            with page.expect_file_chooser() as fc:
                page.locator("#panel-import").get_by_role(
                    "button", name="导入数据", exact=True).click()
            fc.value.set_files(self.xlsx_path)
            page.wait_for_timeout(2200)
            cap("EXCEL PREVIEW", ".ui-modal")
            self.close_top_modal(page)
        except Exception:
            pass

        # 历史对比对话框
        if chart_ready:
            try:
                page.locator("#tab-history").click()
                page.wait_for_timeout(500)
                cmpbtn = page.locator("#panel-history button", has_text="对比")
                if cmpbtn.count():
                    cmpbtn.first.click()
                    page.wait_for_timeout(700)
                    cap("HISTORY COMPARE", ".ui-modal")
                    self.close_top_modal(page)
            except Exception:
                pass

        # 汇总违规
        report = []
        for surface, it in all_items:
            for it_, reason in _violations([it]):
                report.append("[%s] %s  <= %s" % (surface, reason, it_[:160]))
        self.assertEqual(report, [],
                         "界面术语违规 %d 处：\n%s" % (len(report), "\n".join(report[:60])))

    def test_text_columns_wizard_jargon_and_states(self):
        """F5：全是文本列的分号文件（不应用数字写法）——
        向导可见文本无开发者报错/内部字段直出；并断言 F1 提示条、
        F3「按推荐直接创建」disabled→enabled 状态迁移。"""
        page = self.open_page()
        # 分号 + 逗号小数、未应用数字写法 → 三列全是文本
        csv_path = str(Path(self.fixtures) / "alltext.csv")
        Path(csv_path).write_text(
            "组别;数值;对照\nctrl;1,5;10,1\ntrt;2,3;20,4\ntrt2;2,8;21,0\n",
            encoding="utf-8")
        collected = []

        def cap(tag):
            for it in self.collect(page, ".dw-modal"):
                collected.append((tag, it))

        with page.expect_file_chooser() as fc:
            page.locator("#panel-import").get_by_role(
                "button", name="导入数据", exact=True).click()
        fc.value.set_files(csv_path)
        page.wait_for_selector(".dw-modal", timeout=20000)
        page.wait_for_timeout(700)

        # F1 应用前：提示条应存在（numberFormat 仍 plain）
        hint_before = page.locator("[data-wizard-parse-hint]").count()
        # F3 应用前：首个推荐建不出来 → 按钮 disabled
        quick = page.locator("[data-wizard-quick]").first
        disabled_before = quick.count() and quick.evaluate("b => b.disabled")
        cap("before_apply")

        # 应用「逗号是小数点」→ 重新读取
        apply_btn = page.locator("[data-parse-apply]").first
        self.assertTrue(apply_btn.count(), "应有「按…读取」应用按钮")
        apply_btn.click()
        page.wait_for_timeout(900)
        # F1 应用后：提示条消失
        hint_after = page.locator("[data-wizard-parse-hint]").count()
        # F3 应用后：数字列变数值 → 按钮可点
        disabled_after = quick.count() and quick.evaluate("b => b.disabled")
        cap("after_apply")

        # F1/F3 状态断言
        self.assertGreater(hint_before, 0, "应用前应显示读取方式提示条")
        self.assertEqual(hint_after, 0, "应用数字写法后提示条应消失")
        self.assertTrue(disabled_before, "应用前「按推荐直接创建」应 disabled")
        self.assertFalse(disabled_after, "应用后「按推荐直接创建」应可点")

        # 术语断言：既有禁用清单 + 开发者报错不外泄
        report = []
        for surface, it in collected:
            for it_, reason in _violations([it]):
                report.append("[%s] %s  <= %s" % (surface, reason, it_[:160]))
            m = DEV_LEAK_RE.search(it)
            if m:
                report.append("[%s] 开发者泄漏:%s  <= %s" % (surface, m.group(0), it[:160]))
        self.assertEqual(report, [],
                         "文本列向导术语违规 %d 处：\n%s" % (len(report), "\n".join(report[:60])))

        # 收尾：关闭向导
        self.close_top_modal(page)


if __name__ == "__main__":
    unittest.main()
