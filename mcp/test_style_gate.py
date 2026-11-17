# -*- coding: utf-8 -*-
"""test_style_gate.py — Ui.* 类名与 app.css 选择器的覆盖闸门（无需浏览器）。

历史回归：ui.js 动态生成 .ui-modal-* / .ui-btn-* / .ui-toast-* 类名，
而 styles/app.css 一度只有旧的 .modal* 规则，导致所有 Ui.modal 对话框
无定位、无背景、按钮不可点。本测试从 app/*.js 源码提取这些类名字面量
（含 "ui-btn-" + variant、"ui-toast-" + type 的拼接结果），断言每个类
在 app.css 中都有选择器规则，防止再次漂移。
"""
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP_JS_DIR = HERE / "viewer_static" / "app"
APP_CSS = HERE / "viewer_static" / "styles" / "app.css"

# ui-modal / ui-btn / ui-btn-* / ui-toast / ui-toast-* 字面量。
_LITERAL_RE = re.compile(r"ui-(?:modal|btn|toast)[a-z-]*")

# data-wizard.js 的 dw-* 布局/组件类字面量（G07 重做向导后同样入闸）。
_DW_LITERAL_RE = re.compile(r"dw-[a-z][a-z-]*")

# ui.js 中 "ui-btn-" + variant / "ui-toast-" + type 的运行时拼接结果。
_VARIANT_EXPANSIONS = {
    "ui-btn": ["ui-btn-primary", "ui-btn-ghost", "ui-btn-danger"],
    "ui-toast": ["ui-toast-info", "ui-toast-error", "ui-toast-success"],
}

# 豁免清单：确实只使用默认样式、不需要专属 CSS 规则的类。
# 每条注明理由；新增豁免必须同步说明，否则应补样式。
_EXEMPT = {
    # toast 容器基样式由 `#toast-root > *` 统一提供（深色底、圆角、阴影），
    # "ui-toast" 本身不额外需要规则。
    "ui-toast": "由 #toast-root > * 统一提供基样式",
    # info 级 toast 使用默认深色样式，是有意保留的默认外观。
    "ui-toast-info": "info 级使用默认深色样式（有意为之）",
    # 仅作为 300ms 移除动画的标记类，无独立视觉样式。
    "ui-toast-out": "仅为淡出标记类，无视觉样式",
    # science.js/store.js 中包裹按钮行的普通容器 div（非 modal/btn 组件
    # 本体），历史既有用法即无专属样式，按钮自身携带样式。
    "ui-btn-row": "按钮行容器类，非组件类名，历史既有用法无专属样式",
}


def collect_ui_classes():
    """从 app/*.js 提取 ui-modal*/ui-btn*/ui-toast*/dw-* 类名字面量并展开变体。"""
    classes = set()
    for js in sorted(APP_JS_DIR.glob("*.js")):
        text = js.read_text(encoding="utf-8")
        for match in _LITERAL_RE.finditer(text):
            token = match.group(0).rstrip("-")
            if token:
                classes.add(token)
        for match in _DW_LITERAL_RE.finditer(text):
            classes.add(match.group(0).rstrip("-"))
    for base, variants in _VARIANT_EXPANSIONS.items():
        if base in classes:
            classes.update(variants)
    return classes


def css_has_selector(css, cls):
    """app.css 中是否存在以该类名结尾的选择器（不被更长类名误命中）。"""
    return re.search(r"\." + re.escape(cls) + r"(?![\w-])", css) is not None


class StyleGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.css = APP_CSS.read_text(encoding="utf-8")
        cls.classes = collect_ui_classes()

    def test_exemptions_are_honest(self):
        # 豁免项必须真实出现在源码类名集合中，防止豁免名单腐化。
        missing = sorted(set(_EXEMPT) - self.classes)
        self.assertFalse(missing, "豁免类未在 JS 中出现：" + ", ".join(missing))

    def test_every_ui_class_has_css_rule(self):
        missing = []
        for cls in sorted(self.classes):
            if cls in _EXEMPT:
                continue
            if not css_has_selector(self.css, cls):
                missing.append(cls)
        self.assertFalse(
            missing,
            "app.css 缺少选择器规则的类：" + ", ".join(missing))

    def test_modal_core_classes_present(self):
        # 核心对话框结构必须有样式（回归锁：历史上整体缺失）。
        for cls in ("ui-modal", "ui-modal-overlay", "ui-modal-title",
                    "ui-modal-close", "ui-modal-body", "ui-modal-footer"):
            self.assertIn(cls, self.classes)
            self.assertTrue(css_has_selector(self.css, cls),
                            "缺少 ." + cls + " 样式")


if __name__ == "__main__":
    unittest.main()
