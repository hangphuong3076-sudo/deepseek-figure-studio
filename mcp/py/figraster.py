# -*- coding: utf-8 -*-
"""figraster — FigureDocument 校验与 canonical SVG 导出入口。

Contract:

    export_svg(svg, doc, path, fmt, dpi=300, panel_id=None, transparent=False) -> str
    validate_doc(doc) -> list[str]

export_svg 是唯一导出路径：入参 svg 必须是内核 FigRender.toSVG 生成的
canonical SVG；本模块先做 validate_doc 结构校验，再委托 py/svg_export.py
（PyMuPDF/fitz）完成 SVG → 矢量 PDF → PNG/JPEG/TIFF。PyMuPDF 缺失是显式
错误，绝不回退到任何本地光栅化实现。

历史说明：本模块曾内置一套 Pillow 文档渲染器（render_to_image/export），
已删除——它与 render.js 的几何只有近似一致，且正式导出链路从不使用它；
唯一的直接调用方（几何测试）已改走 canonical SVG + export_svg。
"""

import math

ELEMENT_TYPES = (
    "rect", "ellipse", "line", "arrow", "connector", "path", "text",
    "image", "chart", "group", "panel",
)


def _num(value, default=None):
    """Finite number or default; booleans are rejected."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        f = float(value)
        if math.isfinite(f):
            return f
    return default


# ---------------------------------------------------------------------------
# structural validation (Chinese error list, empty list = valid)
# ---------------------------------------------------------------------------

def validate_doc(doc):
    """Light structural validation matching the hard failures of render.js."""
    if not isinstance(doc, dict):
        return ["doc 必须是文档对象"]
    errors = []

    canvas = doc.get("canvas")
    if not isinstance(canvas, dict):
        errors.append("doc.canvas 缺失或不是对象")
    else:
        w = _num(canvas.get("width_mm"))
        if w is None or w <= 0:
            errors.append("canvas.width_mm 必须是正数")
        h = _num(canvas.get("height_mm"))
        if h is None or h <= 0:
            errors.append("canvas.height_mm 必须是正数")
        if canvas.get("dpi") is not None:
            d = _num(canvas.get("dpi"))
            if d is None or d <= 0:
                errors.append("canvas.dpi 必须是正数")

    elements = doc.get("elements")
    if not isinstance(elements, list):
        errors.append("doc.elements 必须是数组")
    else:
        for i, el in enumerate(elements):
            where = "elements[%d]" % i
            if not isinstance(el, dict):
                errors.append(where + " 必须是对象")
                continue
            eid = el.get("id")
            if not isinstance(eid, str) or eid == "":
                errors.append(where + " 缺少合法的 id")
                eid = where
            t = el.get("transform")
            if not isinstance(t, dict):
                errors.append("元素 " + eid + " 缺少 transform")
            else:
                for key in ("x", "y", "w", "h"):
                    if _num(t.get(key)) is None:
                        errors.append("元素 " + eid + " 的 transform." + key + " 必须是数值")
                if t.get("rotation") is not None and _num(t.get("rotation")) is None:
                    errors.append("元素 " + eid + " 的 transform.rotation 必须是数值")
            if el.get("type") not in ELEMENT_TYPES:
                errors.append("元素 " + eid + " 的 type 非法（" + str(el.get("type")) + "）")
            style = el.get("style")
            if style is not None and not isinstance(style, dict):
                errors.append("元素 " + eid + " 的 style 必须是对象")
                continue
            if isinstance(style, dict):
                if style.get("fontSizePt") is not None:
                    fs = _num(style.get("fontSizePt"))
                    if fs is None or fs <= 0:
                        errors.append("元素 " + eid + " 的 style.fontSizePt 必须是正数")
                if style.get("lineHeight") is not None:
                    lh = _num(style.get("lineHeight"))
                    if lh is None or lh <= 0:
                        errors.append("元素 " + eid + " 的 style.lineHeight 必须是正数")
                if style.get("strokeWidthPt") is not None:
                    sw = _num(style.get("strokeWidthPt"))
                    if sw is None or sw < 0:
                        errors.append("元素 " + eid + " 的 style.strokeWidthPt 必须是非负数")
                if style.get("opacity") is not None and _num(style.get("opacity")) is None:
                    errors.append("元素 " + eid + " 的 style.opacity 必须是数值")
    return errors


def export_svg(svg, doc, path, fmt, dpi=300, panel_id=None, transparent=False):
    """Export a canonical SVG with optional pre-cropped panel and PNG alpha."""
    errors = validate_doc(doc)
    if errors:
        raise ValueError("figraster.export_svg：文档校验失败：" + "；".join(errors))
    try:
        from .svg_export import export_svg as convert
    except ImportError:
        from svg_export import export_svg as convert
    return convert(svg, doc, path, fmt, dpi=dpi,
                   panel_id=panel_id, transparent=transparent)


__all__ = ["export_svg", "validate_doc"]
