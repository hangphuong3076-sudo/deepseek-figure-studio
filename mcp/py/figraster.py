# -*- coding: utf-8 -*-
"""figraster — shared Python-side raster renderer for figure documents.

Contract (v2-server/SERVER-API.md, section "shared/py/figraster.py"):

    render_to_image(doc, dpi=300) -> PIL.Image.Image
    export(doc, path, fmt, dpi=300) -> str
    export_svg(svg, doc, path, fmt, dpi=300, panel_id=None, transparent=False) -> str
    validate_doc(doc) -> list[str]

export_svg is the unified export path. It sanitizes the supplied kernel
FigRender SVG, normalizes embedded images, then uses PyMuPDF (fitz) for SVG ->
vector PDF -> PNG/JPEG/TIFF. Embedded GIF/BMP/WebP images use their first frame;
embedded SVG images are recursively sanitized and rasterized in isolation.
PyMuPDF must be installed; its absence is an explicit error, never a fallback
to the legacy Pillow renderer below. SVG dimensions come from the supplied SVG
root, including a pre-cropped panel. External resources are rejected, no
network or dependency installation is attempted, and transparent=True is PNG
only. The legacy API remains for callers that explicitly request
document-to-image rendering.

Legacy Pillow renderer geometry mirrors shared/lib/render.js exactly:
  - document units are millimetres; render.js uses an SVG user space of mm
    with the y axis pointing down, raster pixels are mm * dpi / 25.4;
  - font sizes and stroke widths: pt -> px is pt * dpi / 72 (identical to
    pt * 25.4 / 72 converted from the mm user space of render.js);
  - transform.rotation is degrees around the bounding-box centre, positive
    being clockwise on screen (SVG convention with y pointing down);
  - render order: asBackground elements first, then z ascending (stable);
  - text layout (baseline offsets, text-anchor, verticalAlign, line breaks)
    and panel labels follow render.js line for line.

Known raster/vector differences (glyph shapes, antialiasing, dash phase) are
meant to be documented in docs/known-issues.md of the repository.
"""

from __future__ import annotations

import base64
import io
import math
import os
import re

from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageFont

MM_PER_INCH = 25.4
PT_TO_MM = 25.4 / 72.0

ELEMENT_TYPES = (
    "rect", "ellipse", "line", "arrow", "connector", "path", "text",
    "image", "chart", "group", "panel",
)
HEAD_ENUM = ("none", "start", "end", "both")
IMAGE_FITS = ("contain", "cover", "stretch")

# chart types the built-in Pillow plotter supports; everything else gets a
# text placeholder box (same wording as the render.js placeholder)
SUPPORTED_CHART_TYPES = (
    "bar", "bar_grouped", "bar_stacked", "line", "line_multi", "scatter",
)

# deterministic default series colours for the built-in chart plotter
SERIES_COLORS = (
    "#1f77b4", "#d62728", "#2ca02c", "#9467bd",
    "#ff7f0e", "#8c564b", "#17becf", "#7f7f7f",
)

_BLACK = (0, 0, 0, 255)


# ---------------------------------------------------------------------------
# small utilities
# ---------------------------------------------------------------------------

def _num(value, default=None):
    """Finite number or default; booleans are rejected."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        f = float(value)
        if math.isfinite(f):
            return f
    return default


def _style_of(el):
    style = el.get("style")
    return style if isinstance(style, dict) else {}


def _parse_color(value):
    """CSS colour string -> (r, g, b, a); None for none/empty."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "" or s.lower() in ("none", "transparent"):
        return None
    try:
        c = ImageColor.getrgb(s)
    except ValueError:
        raise ValueError("figraster：无法解析颜色（" + str(value) + "）")
    if len(c) == 3:
        return (c[0], c[1], c[2], 255)
    return (c[0], c[1], c[2], int(c[3]))


def _rot_point(p, cx, cy, rad):
    """Rotate p around (cx, cy); matches SVG rotate() with y pointing down."""
    dx = p[0] - cx
    dy = p[1] - cy
    cos_a = math.cos(rad)
    sin_a = math.sin(rad)
    return (cx + dx * cos_a - dy * sin_a, cy + dx * sin_a + dy * cos_a)


def _dashed_line(draw, pts, color, width_px, dash_px):
    """Stroke a polyline with an alternating dash pattern (mm converted to px)."""
    if len(pts) < 2 or not dash_px:
        return
    on = True
    idx = 0
    rem = dash_px[0]
    for a, b in zip(pts, pts[1:]):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        if seg <= 1e-9:
            continue
        ux = (b[0] - a[0]) / seg
        uy = (b[1] - a[1]) / seg
        pos = 0.0
        while pos < seg - 1e-9:
            step = min(rem, seg - pos)
            if on and step > 0.05:
                draw.line(
                    [(a[0] + ux * pos, a[1] + uy * pos),
                     (a[0] + ux * (pos + step), a[1] + uy * (pos + step))],
                    fill=color, width=width_px,
                )
            pos += step
            rem -= step
            if rem <= 1e-9:
                idx = (idx + 1) % len(dash_px)
                rem = dash_px[idx]
                on = not on


def _fmt_tick(v):
    """Compact deterministic tick label."""
    if v == int(v) and abs(v) < 1e15:
        return str(int(v))
    return "%g" % v


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


# ---------------------------------------------------------------------------
# fonts
# ---------------------------------------------------------------------------

def _font_dirs():
    dirs = [
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
        "/System/Library/Fonts",
        "/System/Library/Fonts/Supplemental",
        "/usr/share/fonts/truetype",
        "/usr/share/fonts/truetype/dejavu",
        "/usr/local/share/fonts",
        "/usr/share/fonts",
    ]
    seen = set()
    out = []
    for d in dirs:
        if d not in seen and os.path.isdir(d):
            seen.add(d)
            out.append(d)
    return out


_FONT_DIRS = _font_dirs()

# family -> (regular, bold, italic, bold-italic); order matters
_FAMILY_FILES = {
    "arial": ("arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"),
    "helvetica": ("arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf",
                  "LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"),
    "liberation sans": ("LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf",
                        "LiberationSans-Italic.ttf", "LiberationSans-BoldItalic.ttf"),
    "times new roman": ("times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"),
    "times": ("times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"),
    "courier new": ("cour.ttf", "courbd.ttf", "couri.ttf", "courbi.ttf"),
    "simsun": ("simsun.ttc",),
    "microsoft yahei": ("msyh.ttc", "msyhbd.ttc", "msyh.ttf"),
    "微软雅黑": ("msyh.ttc", "msyhbd.ttc", "msyh.ttf"),
    "dejavu sans": ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf",
                    "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf"),
}

# CJK-capable fallbacks, tried before the requested family for CJK text
_CJK_FILES = ("msyh.ttc", "msyhbd.ttc", "msyh.ttf", "simhei.ttf", "simsun.ttc",
              "NotoSansCJK-Regular.ttc", "NotoSansSC-Regular.otf",
              "wqy-microhei.ttc", "PingFang.ttc")


def _has_cjk(text):
    return any(ord(ch) > 0x2E80 for ch in text)


# ---------------------------------------------------------------------------
# renderer
# ---------------------------------------------------------------------------

class _Renderer:
    def __init__(self, doc, dpi):
        errors = validate_doc(doc)
        if errors:
            raise ValueError("figraster：文档校验失败：" + "；".join(errors))
        self.doc = doc
        self.dpi = float(dpi)
        self.k = self.dpi / MM_PER_INCH  # px per mm
        canvas = doc["canvas"]
        self.width_mm = float(canvas["width_mm"])
        self.height_mm = float(canvas["height_mm"])
        # pixel size = ceil(mm * dpi / 25.4), matching FigExport.pixelSize
        self.px_w = max(1, int(math.ceil(self.width_mm * self.k - 1e-9)))
        self.px_h = max(1, int(math.ceil(self.height_mm * self.k - 1e-9)))

        bg_raw = canvas.get("background")
        bg = None
        if isinstance(bg_raw, str) and bg_raw.strip() not in ("", "none"):
            bg = _parse_color(bg_raw)
        if bg is None:
            bg = (255, 255, 255, 255)
        self.img = Image.new("RGBA", (self.px_w, self.px_h), bg)
        self.draw = ImageDraw.Draw(self.img, "RGBA")

        self.font_cache = {}
        elements = [e for e in (doc.get("elements") or []) if isinstance(e, dict)]
        self.byId = {}
        for el in elements:
            eid = el.get("id")
            if isinstance(eid, str) and eid != "" and eid not in self.byId:
                self.byId[eid] = el

        def order_key(el):
            return (0 if el.get("asBackground") is True else 1,
                    _num(el.get("z"), 0.0) or 0.0)

        self.sorted = sorted(elements, key=order_key)

    # -- top level traversal ------------------------------------------------

    def top_level(self):
        out = []
        for el in self.sorted:
            pid = el.get("parent_id")
            if not pid or pid not in self.byId or self.byId[pid] is el:
                out.append(el)
        return out

    def children_of(self, el):
        """render.js childrenOf: listed ids first, then dangling parent refs."""
        kids = []
        listed = set()
        children = el.get("children")
        if isinstance(children, list):
            for cid in children:
                if isinstance(cid, str) and cid in self.byId and cid not in listed:
                    listed.add(cid)
                    kids.append(self.byId[cid])
        for e in self.sorted:
            eid = e.get("id")
            if e.get("parent_id") == el.get("id") and eid not in listed:
                kids.append(e)
        return kids

    def run(self):
        for el in self.top_level():
            if el.get("visible") is False:
                continue
            self.render_element(el, None, None, self.img, self.draw)
        return self.img.convert("RGB")

    # -- geometry ------------------------------------------------------------

    def resolve_box(self, el, parent):
        """Element box in mm, resolving style.panelRelative against a panel."""
        t = el["transform"]
        x = _num(t.get("x"), 0.0)
        y = _num(t.get("y"), 0.0)
        w = _num(t.get("w"), 0.0)
        h = _num(t.get("h"), 0.0)
        rot = _num(t.get("rotation"), 0.0)
        if rot is None:
            rot = 0.0
        style = _style_of(el)
        if style.get("panelRelative") is True and \
                isinstance(parent, dict) and parent.get("type") == "panel":
            lay = parent.get("panelLayout")
            lay = lay if isinstance(lay, dict) else {}
            pad = _num(lay.get("padding_mm"), 0.0)
            if pad is None or pad < 0:
                pad = 0.0
            pt = parent["transform"]
            px = _num(pt.get("x"), 0.0)
            py = _num(pt.get("y"), 0.0)
            pw = _num(pt.get("w"), 0.0)
            ph = _num(pt.get("h"), 0.0)
            ix = px + pad
            iy = py + pad
            iw = max(0.0, pw - 2 * pad)
            ih = max(0.0, ph - 2 * pad)
            x = ix + x * iw
            y = iy + y * ih
            w = w * iw
            h = h * ih
        return {"x": x, "y": y, "w": w, "h": h, "rotation": rot}

    def _px(self, mm):
        return mm * self.k

    def _px_box(self, t):
        return (t["x"] * self.k, t["y"] * self.k,
                max(0.0, t["w"]) * self.k, max(0.0, t["h"]) * self.k)

    def _rot_center_px(self, t):
        return ((t["x"] + t["w"] / 2.0) * self.k, (t["y"] + t["h"] / 2.0) * self.k)

    def _rotated_pts(self, pts, t):
        rot = t["rotation"]
        if not rot:
            return pts
        cx, cy = self._rot_center_px(t)
        rad = math.radians(rot)
        return [_rot_point(p, cx, cy, rad) for p in pts]

    # -- style helpers --------------------------------------------------------

    @staticmethod
    def _opacity(style):
        op = _num(style.get("opacity"), 1.0)
        if op is None:
            raise ValueError("figraster：style.opacity 必须是数值")
        return min(1.0, max(0.0, op))

    @staticmethod
    def _fill_of(style, default):
        # key absent -> SVG default (usually black), None/'' -> no fill
        if "fill" not in style:
            return default
        return _parse_color(style.get("fill"))

    @staticmethod
    def _stroke_of(style, default):
        if "stroke" not in style:
            return default
        return _parse_color(style.get("stroke"))

    def _stroke_width_px(self, el, style):
        sw = _num(style.get("strokeWidthPt"), 0.75)
        if sw is None or sw < 0:
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的 style.strokeWidthPt 必须是非负数")
        return int(round(sw * self.dpi / 72.0))

    @staticmethod
    def _dash_px(style, k):
        d = style.get("dash")
        if not isinstance(d, str) or not d.strip():
            return None
        vals = []
        for part in re.split(r"[\s,]+", d.strip()):
            v = _num(part)
            if v is None or v < 0:
                return None
            vals.append(v * k)
        if not vals or all(v == 0 for v in vals):
            return None
        if len(vals) % 2:
            vals = vals + vals
        return vals

    def _arrow_head(self, el):
        style = _style_of(el)
        raw = style.get("arrowHead")
        if raw is None:
            raw = "end" if el.get("type") == "arrow" else "none"
        if raw not in HEAD_ENUM:
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的 style.arrowHead 非法（" + str(raw) + "）")
        return raw

    # -- element dispatch -----------------------------------------------------

    def render_element(self, el, parent, inherited, img, draw):
        t = self.resolve_box(el, parent)
        style_own = _style_of(el)
        eff = dict(inherited) if inherited else {}
        eff.update(style_own)
        if el.get("type") in ("group", "panel"):
            self._render_container(el, t, eff, style_own, img, draw)
            return
        op = self._opacity(style_own)
        rot = t["rotation"]
        # shapes rotate themselves via the SVG matrix; text/image need a
        # layer rotation; chart elements ignore rotation (render.js parity)
        rotatable = el.get("type") in ("text", "image")
        if (rot != 0 and rotatable) or op < 1:
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer, "RGBA")
            self._draw_leaf(el, t, eff, ld, layer)
            if op < 1:
                self._scale_alpha(layer, op)
            if rot != 0 and rotatable:
                # Pillow rotates counter-clockwise; SVG rotate() with y down
                # is clockwise on screen, hence the negated angle
                layer = layer.rotate(-rot, resample=Image.BICUBIC,
                                     center=self._rot_center_px(t))
            img.alpha_composite(layer)
        else:
            self._draw_leaf(el, t, eff, draw, img)

    @staticmethod
    def _scale_alpha(layer, op):
        alpha = layer.getchannel("A").point(lambda v: int(round(v * op)))
        layer.putalpha(alpha)

    @staticmethod
    def _inheritable(eff):
        # SVG-inheritable paint properties that render.js puts on <g>
        return {key: eff[key] for key in ("fill", "stroke", "strokeWidthPt", "dash")
                if key in eff}

    def _render_container(self, el, t, eff, style_own, img, draw):
        is_panel = el.get("type") == "panel"
        clip = is_panel and el.get("clip") is True
        op = self._opacity(style_own)
        rot = t["rotation"]
        kids = [k for k in self.children_of(el) if k.get("visible") is not False]
        child_inh = self._inheritable(eff)
        if rot == 0 and op >= 1 and not clip:
            for kid in kids:
                self.render_element(kid, el, child_inh, img, draw)
            if is_panel:
                self._draw_panel_label(draw, el, t)
            return
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer, "RGBA")
        for kid in kids:
            self.render_element(kid, el, child_inh, layer, ld)
        if clip:
            mask = Image.new("L", img.size, 0)
            md = ImageDraw.Draw(mask)
            x, y, w, h = self._px_box(t)
            pts = self._rotated_pts([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], t)
            md.polygon(pts, fill=255)
            layer.putalpha(ImageChops.multiply(layer.getchannel("A"), mask))
        if op < 1:
            self._scale_alpha(layer, op)
        if rot != 0:
            layer = layer.rotate(-rot, resample=Image.BICUBIC,
                                 center=self._rot_center_px(t))
        img.alpha_composite(layer)
        if is_panel:
            # panel label is neither clipped nor rotated (render.js parity)
            self._draw_panel_label(draw, el, t)

    def _draw_leaf(self, el, t, style, draw, img):
        etype = el.get("type")
        if etype == "text" and isinstance(el.get("relation_label_for"), str):
            owner = self.byId.get(el["relation_label_for"])
            if isinstance(owner, dict) and owner.get("type") == "connector":
                middle = self._connector_geometry(owner)["middle"]
                t = {"x": middle[0] - 10.0, "y": middle[1] - 2.5,
                     "w": 20.0, "h": 5.0, "rotation": 0.0}
        if etype == "rect":
            self._draw_rect(el, t, style, draw)
        elif etype == "ellipse":
            self._draw_ellipse(el, t, style, draw)
        elif etype in ("line", "arrow"):
            self._draw_line(el, t, style, draw)
        elif etype == "connector":
            self._draw_connector(el, style, draw)
        elif etype == "path":
            self._draw_path(el, t, style, draw)
        elif etype == "text":
            self._draw_text(el, t, style, draw)
        elif etype == "image":
            self._draw_image(el, t, style, draw, img)
        elif etype == "chart":
            self._draw_chart(el, t, draw, img)
        else:
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的 type 非法（" + str(etype) + "）")

    # -- shapes ---------------------------------------------------------------

    def _draw_rect(self, el, t, style, draw):
        x, y, w, h = self._px_box(t)
        if w <= 0 or h <= 0:
            return
        fill = self._fill_of(style, _BLACK)
        stroke = self._stroke_of(style, None)
        sw = self._stroke_width_px(el, style)
        dash = self._dash_px(style, self.k)
        rad_mm = _num(style.get("cornerRadiusMm"), 0.0)
        if rad_mm is None or rad_mm < 0:
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的 style.cornerRadiusMm 非法")
        rad = max(0.0, min(rad_mm * self.k, w / 2.0, h / 2.0))
        rot = t["rotation"]
        box = [x, y, x + w, y + h]
        if rot == 0 and rad > 0:
            if fill:
                draw.rounded_rectangle(box, radius=rad, fill=fill)
            if stroke and sw > 0 and not dash:
                draw.rounded_rectangle(box, radius=rad, outline=stroke, width=sw)
            if stroke and sw > 0 and dash:
                _dashed_line(draw, self._rounded_pts(x, y, w, h, rad),
                             stroke, sw, dash)
            return
        pts = self._rotated_pts([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], t)
        if fill:
            draw.polygon(pts, fill=fill)
        if stroke and sw > 0:
            if dash:
                _dashed_line(draw, pts + [pts[0]], stroke, sw, dash)
            else:
                draw.line(pts + [pts[0]], fill=stroke, width=sw, joint="curve")

    @staticmethod
    def _rounded_pts(x, y, w, h, rad, seg=8):
        """Sample points along a rounded-rectangle perimeter (for dashes)."""
        def arc(cx, cy, a0, a1):
            return [(cx + rad * math.cos(a0 + (a1 - a0) * i / seg),
                     cy + rad * math.sin(a0 + (a1 - a0) * i / seg))
                    for i in range(seg + 1)]
        pts = []
        pts += arc(x + rad, y + rad, math.pi, 1.5 * math.pi)
        pts += arc(x + w - rad, y + rad, 1.5 * math.pi, 2.0 * math.pi)
        pts += arc(x + w - rad, y + h - rad, 0.0, 0.5 * math.pi)
        pts += arc(x + rad, y + h - rad, 0.5 * math.pi, math.pi)
        pts.append(pts[0])
        return pts

    def _draw_ellipse(self, el, t, style, draw):
        x, y, w, h = self._px_box(t)
        if w <= 0 or h <= 0:
            return
        fill = self._fill_of(style, _BLACK)
        stroke = self._stroke_of(style, None)
        sw = self._stroke_width_px(el, style)
        dash = self._dash_px(style, self.k)
        cx = x + w / 2.0
        cy = y + h / 2.0
        n = 180
        pts = [(cx + (w / 2.0) * math.cos(2 * math.pi * i / n),
                cy + (h / 2.0) * math.sin(2 * math.pi * i / n))
               for i in range(n)]
        pts = self._rotated_pts(pts, t)
        if fill:
            draw.polygon(pts, fill=fill)
        if stroke and sw > 0:
            if dash:
                _dashed_line(draw, pts + [pts[0]], stroke, sw, dash)
            else:
                draw.line(pts + [pts[0]], fill=stroke, width=sw, joint="curve")

    def _draw_line(self, el, t, style, draw):
        p1 = (t["x"] * self.k, t["y"] * self.k)
        p2 = ((t["x"] + t["w"]) * self.k, (t["y"] + t["h"]) * self.k)
        p1, p2 = self._rotated_pts([p1, p2], t)
        stroke = self._stroke_of(style, _BLACK)
        if not stroke:
            return  # SVG stroke="none": nothing visible, no arrowhead either
        sw = self._stroke_width_px(el, style)
        dash = self._dash_px(style, self.k)
        if sw > 0:
            if dash:
                _dashed_line(draw, [p1, p2], stroke, sw, dash)
            else:
                draw.line([p1, p2], fill=stroke, width=sw)
        head = self._arrow_head(el)
        if head in ("end", "both"):
            draw.polygon(self._head_pts(p2, p1), fill=stroke)
        if head in ("start", "both"):
            draw.polygon(self._head_pts(p1, p2), fill=stroke)

    def _head_pts(self, tip, other):
        """Arrowhead triangle matching render.js markers (3mm, refX 9.5/0.5)."""
        dx = tip[0] - other[0]
        dy = tip[1] - other[1]
        length = math.hypot(dx, dy)
        if length <= 1e-9:
            return [tip, tip, tip]
        ux = dx / length
        uy = dy / length
        nx = -uy
        ny = ux
        back = 2.85 * self.k   # marker base sits 2.85mm before the tip
        half = 1.5 * self.k    # half width of the 3mm head
        over = 0.15 * self.k   # tip reaches 0.15mm past the endpoint
        return [
            (tip[0] - back * ux - half * nx, tip[1] - back * uy - half * ny),
            (tip[0] + over * ux, tip[1] + over * uy),
            (tip[0] - back * ux + half * nx, tip[1] - back * uy + half * ny),
        ]

    def _connector_node(self, el, ref):
        if not isinstance(ref, str) or not ref:
            raise ValueError("connector " + str(el.get("id")) + " 的节点引用必须是非空 id")
        direct = self.byId.get(ref)
        if isinstance(direct, dict) and direct.get("type") != "connector":
            return direct
        diagram_id = el.get("diagramId") or el.get("diagram_id")
        matches = [node for node in self.doc.get("elements", [])
                   if isinstance(node, dict) and node.get("type") == "group"
                   and node.get("diagramNodeId") == ref
                   and (node.get("diagramId") or node.get("diagram_id")) == diagram_id]
        if len(matches) != 1:
            raise ValueError("connector 节点引用无效、重复或跨示意图：" + str(ref))
        return matches[0]

    def _connector_node_box(self, node):
        parent = self.byId.get(node.get("parent_id"))
        box = self.resolve_box(node, parent)
        points = [(box["x"], box["y"]), (box["x"] + box["w"], box["y"]),
                  (box["x"] + box["w"], box["y"] + box["h"]), (box["x"], box["y"] + box["h"])]
        if box.get("rotation"):
            cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
            rad = math.radians(box["rotation"])
            points = [_rot_point(point, cx, cy, rad) for point in points]
        seen = {node.get("id")}
        current = node
        while current.get("parent_id"):
            if current.get("id") in seen and len(seen) > 64:
                raise ValueError("connector 节点父级引用循环或超过 64 层")
            current = self.byId.get(current.get("parent_id"))
            if current is None:
                break
            seen.add(current.get("id"))
            frame = self.resolve_box(current, self.byId.get(current.get("parent_id")))
            if frame.get("rotation"):
                cx, cy = frame["x"] + frame["w"] / 2, frame["y"] + frame["h"] / 2
                rad = math.radians(frame["rotation"])
                points = [_rot_point(point, cx, cy, rad) for point in points]
        xs, ys = [point[0] for point in points], [point[1] for point in points]
        return {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}

    @staticmethod
    def _contact(box, target):
        cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
        dx, dy = target[0] - cx, target[1] - cy
        if not dx and not dy:
            return (cx, cy)
        sx = (box["w"] / 2) / abs(dx) if dx else math.inf
        sy = (box["h"] / 2) / abs(dy) if dy else math.inf
        scale = min(sx, sy)
        return (cx + dx * scale, cy + dy * scale)

    def _connector_geometry(self, el):
        relation = el.get("relation")
        if not isinstance(relation, dict):
            raise ValueError("connector 缺少 relation：" + str(el.get("id")))
        kind = relation.get("kind")
        if kind not in ("activate", "inhibit", "include", "associate", "sequence"):
            raise ValueError("connector relation.kind 非法：" + str(kind))
        direction = relation.get("direction")
        if direction == "backwards":
            direction = "reverse"
        if direction is None:
            direction = "none" if kind in ("include", "associate") else "forward"
        if direction not in ("forward", "reverse", "both", "none") or \
                (kind in ("include", "associate") and direction != "none") or \
                (kind not in ("include", "associate") and direction == "none"):
            raise ValueError("connector direction 与 kind 冲突：" + str(el.get("id")))
        source_box = self._connector_node_box(self._connector_node(el, relation.get("source")))
        target_box = self._connector_node_box(self._connector_node(el, relation.get("target")))
        target_center = (target_box["x"] + target_box["w"] / 2, target_box["y"] + target_box["h"] / 2)
        source_center = (source_box["x"] + source_box["w"] / 2, source_box["y"] + source_box["h"] / 2)
        start, end = self._contact(source_box, target_center), self._contact(target_box, source_center)
        dx, dy = end[0] - start[0], end[1] - start[1]
        length = math.hypot(dx, dy) or 1.0
        bend = _num(relation.get("bend"), 0.0)
        middle = ((start[0] + end[0]) / 2 - dy / length * bend,
                  (start[1] + end[1]) / 2 + dx / length * bend)
        return {"kind": kind, "direction": direction, "start": start, "end": end,
                "middle": middle, "source_box": source_box, "target_box": target_box}

    def _draw_connector(self, el, style, draw):
        geometry = self._connector_geometry(el)
        kind, direction = geometry["kind"], geometry["direction"]
        stroke = self._stroke_of(style, _BLACK)
        if not stroke:
            return
        sw = self._stroke_width_px(el, style)
        start = (geometry["start"][0] * self.k, geometry["start"][1] * self.k)
        middle = (geometry["middle"][0] * self.k, geometry["middle"][1] * self.k)
        end = (geometry["end"][0] * self.k, geometry["end"][1] * self.k)
        if kind == "include":
            box = geometry["target_box"]
            draw.rectangle([(box["x"] - 2) * self.k, (box["y"] - 2) * self.k,
                            (box["x"] + box["w"] + 2) * self.k,
                            (box["y"] + box["h"] + 2) * self.k], outline=stroke, width=sw)
            return
        points = [start, middle, end] if _num(el["relation"].get("bend"), 0.0) else [start, end]
        dash = self._dash_px(style, self.k)
        if dash:
            _dashed_line(draw, points, stroke, sw, dash)
        else:
            draw.line(points, fill=stroke, width=sw, joint="curve")
        arrow_points = []
        if kind not in ("associate", "include"):
            if direction in ("forward", "both"):
                arrow_points.append((end, points[-2]))
            if direction in ("reverse", "both"):
                arrow_points.append((start, points[1] if len(points) > 1 else end))
        for tip, toward in arrow_points:
            if kind == "inhibit":
                dx, dy = tip[0] - toward[0], tip[1] - toward[1]
                length = math.hypot(dx, dy) or 1.0
                ox, oy = dy / length * 2 * self.k, -dx / length * 2 * self.k
                draw.line([(tip[0] - ox, tip[1] - oy), (tip[0] + ox, tip[1] + oy)],
                          fill=stroke, width=max(sw, 1))
            else:
                draw.polygon(self._head_pts(tip, toward), fill=stroke)

    # -- path (linear subset M/L/H/V/Z, otherwise the bbox frame) -------------

    _PATH_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
    _PATH_TOKEN = re.compile(r"[A-Za-z]|" + _PATH_NUM)

    @classmethod
    def _parse_linear_path(cls, d):
        """Parse SVG path data; returns [[(x, y), ...], ...] for the linear
        command subset, or None when non-linear commands are present."""
        tokens = cls._PATH_TOKEN.findall(d)
        i = 0
        n = len(tokens)
        cmd = None
        cur = (0.0, 0.0)
        sub_start = (0.0, 0.0)
        cur_pts = []
        paths = []

        def flush():
            nonlocal cur_pts
            if len(cur_pts) >= 2:
                paths.append(cur_pts)
            cur_pts = []

        while i < n:
            tok = tokens[i]
            if tok.isalpha():
                c = tok
                if c not in "MmLlHhVvZz":
                    return None  # curves / arcs -> caller draws the bbox frame
                i += 1
                cmd = c
            else:
                if cmd is None:
                    return None
                c = cmd
            if c in "Zz":
                if cur_pts:
                    cur_pts.append(sub_start)
                flush()
                cur = sub_start
                cmd = None
                continue
            need = 2 if c in "MmLl" else 1
            if i + need > n:
                return None
            args = [_num(tokens[i + j]) for j in range(need)]
            if any(a is None for a in args):
                return None
            i += need
            rel = c.islower()
            if c in "Mm":
                flush()
                cur = (cur[0] + args[0], cur[1] + args[1]) if rel else (args[0], args[1])
                sub_start = cur
                cur_pts = [cur]
                # implicit repeats after M/m are lineto (SVG spec)
                cmd = "l" if rel else "L"
            elif c in "Ll":
                cur = (cur[0] + args[0], cur[1] + args[1]) if rel else (args[0], args[1])
                cur_pts.append(cur)
            elif c in "Hh":
                x = cur[0] + args[0] if rel else args[0]
                cur = (x, cur[1])
                cur_pts.append(cur)
            elif c in "Vv":
                y = cur[1] + args[0] if rel else args[0]
                cur = (cur[0], y)
                cur_pts.append(cur)
        flush()
        return paths

    def _draw_path(self, el, t, style, draw):
        d = el.get("pathData")
        if not isinstance(d, str) or d == "":
            return
        fill = self._fill_of(style, None)
        stroke = self._stroke_of(style, _BLACK)
        sw = self._stroke_width_px(el, style)
        dash = self._dash_px(style, self.k)
        subpaths = self._parse_linear_path(d)
        if subpaths is None:
            # non-linear path data: draw the bounding-box frame (contract)
            x, y, w, h = self._px_box(t)
            pts = self._rotated_pts([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], t)
            if fill:
                draw.polygon(pts, fill=fill)
            if stroke and sw > 0:
                if dash:
                    _dashed_line(draw, pts + [pts[0]], stroke, sw, dash)
                else:
                    draw.line(pts + [pts[0]], fill=stroke, width=sw, joint="curve")
            return
        ox = t["x"] * self.k
        oy = t["y"] * self.k
        world = [self._rotated_pts([(px + ox, py + oy) for px, py in sp], t)
                 for sp in subpaths]
        if fill:
            for sp in world:
                if sp[0] == sp[-1]:  # fill closed subpaths only
                    draw.polygon(sp, fill=fill)
        if stroke and sw > 0:
            for sp in world:
                closed = sp[0] == sp[-1]
                if dash:
                    _dashed_line(draw, sp + ([sp[0]] if closed else []),
                                 stroke, sw, dash)
                else:
                    draw.line(sp, fill=stroke, width=sw, joint="curve")
        head = style.get("arrowHead")
        if head is not None and stroke:
            if head not in HEAD_ENUM:
                raise ValueError("figraster：元素 " + str(el.get("id")) +
                                 " 的 style.arrowHead 非法（" + str(head) + "）")
            first = world[0]
            last = world[-1]
            if head in ("end", "both") and len(last) >= 2:
                draw.polygon(self._head_pts(last[-1], last[-2]), fill=stroke)
            if head in ("start", "both") and len(first) >= 2:
                draw.polygon(self._head_pts(first[0], first[1]), fill=stroke)

    # -- text -----------------------------------------------------------------

    def _text_anchor(self, el, style):
        anchor = style.get("textAnchor")
        if anchor is not None:
            if anchor not in ("start", "middle", "end"):
                raise ValueError("figraster：元素 " + str(el.get("id")) +
                                 " 的 style.textAnchor 非法（" + str(anchor) + "）")
            return anchor
        align = style.get("textAlign", "left")
        return "middle" if align == "center" else ("end" if align == "right" else "start")

    def _font_px(self, px, family="Arial", bold=False, italic=False, text=""):
        px = max(1, int(round(px)))
        fam = str(family or "Arial").strip().lower()
        cjk = _has_cjk(text)
        key = (px, fam, bold, italic, cjk)
        cached = self.font_cache.get(key)
        if cached is not None:
            return cached
        candidates = []
        if cjk:
            cjk_files = list(_CJK_FILES)
            if bold:
                cjk_files.sort(key=lambda f: 0 if "bd" in f or "bold" in f.lower() else 1)
            candidates += cjk_files
        files = _FAMILY_FILES.get(fam)
        if files:
            idx = (1 if bold else 0) + (2 if italic else 0)
            order = [idx, 3, 1, 2, 0] if bold or italic else [0]
            candidates += [files[j] for j in order if j < len(files)]
        if not cjk:
            # generic last resorts for unknown families
            candidates += ["arial.ttf", "arialbd.ttf",
                           "DejaVuSans.ttf", "DejaVuSans-Bold.ttf"]
        for fname in candidates:
            for d in _FONT_DIRS:
                path = os.path.join(d, fname)
                if os.path.isfile(path):
                    try:
                        font = ImageFont.truetype(path, px)
                        self.font_cache[key] = font
                        return font
                    except Exception:
                        continue
        # matplotlib ships DejaVu Sans; use it before falling back to default
        try:
            import matplotlib  # noqa: deferred heavy import
            fdir = os.path.join(os.path.dirname(matplotlib.__file__),
                                "mpl-data", "fonts", "ttf")
            fname = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
            path = os.path.join(fdir, fname)
            if os.path.isfile(path):
                font = ImageFont.truetype(path, px)
                self.font_cache[key] = font
                return font
        except Exception:
            pass
        font = ImageFont.load_default(px)
        self.font_cache[key] = font
        return font

    def _draw_text(self, el, t, style, draw):
        raw = el.get("text")
        text = "" if raw is None else str(raw)
        lines = re.split(r"\r\n|\n|\r", text) if text else [""]
        fs_pt = _num(style.get("fontSizePt"), 7.0)
        if fs_pt is None or fs_pt <= 0:
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的 style.fontSizePt 必须是正数")
        fs_px = fs_pt * self.dpi / 72.0
        lh = _num(style.get("lineHeight"), 1.2)
        if lh is None or lh <= 0:
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的 style.lineHeight 必须是正数")
        lh_px = fs_px * lh
        anchor = self._text_anchor(el, style)
        x_px = t["x"] * self.k
        if anchor == "middle":
            x_px = (t["x"] + t["w"] / 2.0) * self.k
        elif anchor == "end":
            x_px = (t["x"] + t["w"]) * self.k
        va = style.get("verticalAlign", "top")
        n = len(lines)
        # baseline offsets follow render.js renderText exactly (fs in px here)
        if va == "middle":
            bl0 = (t["y"] + t["h"] / 2.0) * self.k - ((n - 1) * lh_px) / 2.0 + fs_px * 0.3
        elif va == "bottom":
            bl0 = (t["y"] + t["h"]) * self.k - (n - 1) * lh_px - fs_px * 0.3
        else:
            bl0 = t["y"] * self.k + fs_px * 0.8
        fill = self._fill_of(style, _BLACK)
        if not fill:
            return  # fill="none": invisible text, like SVG
        font = self._font_px(fs_px, style.get("fontFamily", "Arial"),
                             style.get("fontWeight") == "bold",
                             style.get("fontStyle") == "italic", text)
        pil_anchor = {"start": "ls", "middle": "ms", "end": "rs"}[anchor]
        for i, line in enumerate(lines):
            draw.text((x_px, bl0 + i * lh_px), line, font=font,
                      fill=fill, anchor=pil_anchor)

    # -- image ----------------------------------------------------------------

    def _load_image(self, el):
        src = el.get("src")
        if not isinstance(src, str) or src == "":
            return None
        if src.startswith("data:"):
            header, sep, payload = src.partition(",")
            if not sep or ";base64" not in header.lower():
                raise ValueError("figraster：元素 " + str(el.get("id")) +
                                 " 的图片 src 仅支持 base64 data URL 或文件路径")
            try:
                data = base64.b64decode(payload)
                bio = io.BytesIO(data)
                im = Image.open(bio)
                im.load()
            except Exception:
                raise ValueError("figraster：元素 " + str(el.get("id")) +
                                 " 的 data URL 图片解码失败")
            return im
        if not os.path.exists(src):
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的图片文件不存在（" + src + "）")
        try:
            im = Image.open(src)
            im.load()
        except Exception:
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的图片解码失败（" + src + "）")
        return im

    def _draw_image(self, el, t, style, draw, img):
        src_img = self._load_image(el)
        if src_img is None:
            return  # render.js emits an <image> without href: nothing visible
        fit = style.get("imageFit", "contain")
        if fit not in IMAGE_FITS:
            fit = "contain"  # render.js treats unknown values as contain
        x, y, bw, bh = self._px_box(t)
        if bw <= 0 or bh <= 0:
            return
        iw, ih = src_img.size
        src_img = src_img.convert("RGBA")
        if fit == "stretch":
            resized = src_img.resize((max(1, int(round(bw))), max(1, int(round(bh)))),
                                     Image.BICUBIC)
            off = (0.0, 0.0)
        elif fit == "cover":
            s = max(bw / iw, bh / ih)
            size = (max(1, int(round(iw * s))), max(1, int(round(ih * s))))
            resized = src_img.resize(size, Image.BICUBIC)
            left = max(0, int((size[0] - bw) / 2))
            top = max(0, int((size[1] - bh) / 2))
            resized = resized.crop((left, top, min(size[0], left + int(round(bw))),
                                    min(size[1], top + int(round(bh)))))
            off = (0.0, 0.0)
        else:  # contain
            s = min(bw / iw, bh / ih)
            size = (max(1, int(round(iw * s))), max(1, int(round(ih * s))))
            resized = src_img.resize(size, Image.BICUBIC)
            off = ((bw - size[0]) / 2.0, (bh - size[1]) / 2.0)
        img.alpha_composite(resized, (int(round(x + off[0])), int(round(y + off[1]))))

    # -- chart ----------------------------------------------------------------

    def _draw_chart(self, el, t, draw, img):
        chart = el.get("chart")
        if not isinstance(chart, dict) or chart.get("chartType") not in SUPPORTED_CHART_TYPES:
            self._draw_chart_placeholder(draw, t, "该图表类型需 v2 服务端渲染")
            return
        if not self._draw_chart_plot(draw, img, t, chart):
            self._draw_chart_placeholder(draw, t, "图表数据为空")

    def _draw_chart_placeholder(self, draw, t, message):
        # matches the render.js deterministic placeholder box
        x, y, w, h = self._px_box(t)
        if w <= 0 or h <= 0:
            return
        draw.rectangle([x, y, x + w, y + h], fill=(255, 255, 255, 255))
        dash = [1.0 * self.k, 1.0 * self.k]
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
        _dashed_line(draw, pts, (153, 153, 153, 255),
                     max(1, int(round(0.3 * self.k))), dash)
        font = self._font_px(2.2 * self.k, "Arial", False, False, message)
        draw.text(((t["x"] + t["w"] / 2.0) * self.k, (t["y"] + t["h"] / 2.0) * self.k),
                  message, font=font, fill=(102, 102, 102, 255), anchor="ms")

    @staticmethod
    def _series_color(i):
        return _parse_color(SERIES_COLORS[i % len(SERIES_COLORS)])

    def _chart_bar_data(self, pts, ctype, has_groups):
        cats = []
        cat_idx = {}
        groups = []
        gidx = {}
        table = {}
        for p in pts:
            c = str(p["x"]) if p["x"] is not None else ""
            if c not in cat_idx:
                cat_idx[c] = len(cats)
                cats.append(c)
            g = ""
            if has_groups:
                g = str(p["g"]) if p["g"] is not None else ""
                if g not in gidx:
                    gidx[g] = len(groups)
                    groups.append(g)
            table.setdefault((c, g), []).append(p["y"])
        values = {}
        for (c, g), ys in table.items():
            values[(c, g)] = sum(ys) / len(ys)
        if ctype == "bar" or not groups:
            merged = {}
            for (c, _g), ys in table.items():
                merged.setdefault(c, []).extend(ys)
            groups = []
            values = {(c, ""): sum(ys) / len(ys) for c, ys in merged.items()}
        return {"cats": cats, "groups": groups, "values": values,
                "stacked": ctype == "bar_stacked"}

    def _chart_point_data(self, pts, has_groups):
        series_names = []
        series = {}
        for p in pts:
            name = str(p["g"]) if has_groups and p["g"] is not None else None
            if name not in series:
                series[name] = []
                series_names.append(name)
            series[name].append(p)
        xs = []
        xset = set()
        for p in pts:
            key = str(p["x"]) if p["x"] is not None else ""
            if key not in xset:
                xset.add(key)
                xs.append((key, p["x"]))
        x_numeric = all(_num(raw) is not None for _k, raw in xs)
        if x_numeric:
            xs.sort(key=lambda kv: _num(kv[1]))
        return {"names": series_names, "series": series, "xs": xs,
                "x_numeric": x_numeric}

    def _draw_chart_plot(self, draw, img, t, chart):
        data = chart.get("data")
        inline = data.get("inline") if isinstance(data, dict) else None
        columns = inline.get("columns") if isinstance(inline, dict) else None
        rows = inline.get("rows") if isinstance(inline, dict) else None
        if not isinstance(columns, list) or not isinstance(rows, list) or not rows:
            return False
        mapping = chart.get("mapping") if isinstance(chart.get("mapping"), dict) else {}
        axes = chart.get("axes") if isinstance(chart.get("axes"), dict) else {}

        def col_of(name):
            if isinstance(name, str):
                try:
                    return columns.index(name)
                except ValueError:
                    return None
            return None

        xi = col_of(mapping.get("x"))
        yi = col_of(mapping.get("y"))
        gi = col_of(mapping.get("group"))
        ei = col_of(mapping.get("error"))
        if yi is None:
            return False
        pts = []
        for row in rows:
            if not isinstance(row, list):
                continue

            def cell(idx):
                return row[idx] if idx is not None and 0 <= idx < len(row) else None

            yv = _num(cell(yi))
            if yv is None:
                continue
            pts.append({"x": cell(xi), "y": yv, "g": cell(gi),
                        "e": _num(cell(ei)) if ei is not None else None})
        if not pts:
            return False

        bx, by, bw, bh = self._px_box(t)
        if bw < 24 or bh < 18:
            return True  # nothing meaningful drawable at this size
        ctype = chart.get("chartType")
        title = axes.get("title")
        xlabel = axes.get("xLabel")
        ylabel = axes.get("yLabel")
        show_values = chart.get("showValues") is True
        legend_mode = chart.get("legend", "right")

        has_groups = gi is not None and any(p["g"] is not None for p in pts)
        if ctype in ("bar", "bar_grouped", "bar_stacked"):
            bars = self._chart_bar_data(pts, ctype, has_groups)
            series_names = bars["groups"]
            all_vals = list(bars["values"].values())
        else:
            bars = None
            points = self._chart_point_data(pts, has_groups)
            series_names = [nm for nm in points["names"] if nm is not None]
            all_vals = [p["y"] for p in pts]

        # layout margins (mm, converted to px, clamped to the box)
        m_top = 6.0 if title else 3.0
        m_left = 13.0 if ylabel else 7.0
        m_bottom = 12.0 if (xlabel or bars is not None) else 9.0
        m_right = 4.0
        if len(series_names) > 1 and legend_mode == "right":
            m_right += 18.0

        def mm(v):
            return v * self.k

        x0 = bx + min(mm(m_left), bw * 0.45)
        y0 = by + min(mm(m_top), bh * 0.4)
        x1 = bx + bw - min(mm(m_right), bw * 0.45)
        y1 = by + bh - min(mm(m_bottom), bh * 0.4)
        if x1 - x0 < 10 or y1 - y0 < 10:
            x0, x1 = bx + bw * 0.10, bx + bw * 0.92
            y0, y1 = by + bh * 0.10, by + bh * 0.90
        pw = x1 - x0
        ph = y1 - y0

        # value range
        use_err = ei is not None and ctype in ("bar", "bar_grouped", "line",
                                               "line_multi", "scatter")
        if bars is not None:
            if bars["stacked"]:
                totals = {}
                for (c, g), v in bars["values"].items():
                    totals[c] = totals.get(c, 0.0) + v
                vals = list(totals.values())
            else:
                vals = all_vals
            ymin = min(0.0, min(vals))
            ymax = max(0.0, max(vals))
        else:
            ymin = min(all_vals)
            ymax = max(all_vals)
            if use_err:
                for p in pts:
                    if p["e"] is not None:
                        ymin = min(ymin, p["y"] - p["e"])
                        ymax = max(ymax, p["y"] + p["e"])
            if ymin == ymax:
                ymin -= 1.0
                ymax += 1.0
            pad = (ymax - ymin) * 0.08
            ymin -= pad
            ymax += pad
        if ymin == ymax:
            ymin -= 1.0
            ymax += 1.0

        def y_px(v):
            return y1 - (v - ymin) / (ymax - ymin) * ph

        axis_color = _BLACK
        sw_axis = max(1, int(round(0.75 * self.dpi / 72.0)))
        tick_font = self._font_px(6.0 * self.dpi / 72.0, "Arial")
        label_font = self._font_px(7.0 * self.dpi / 72.0, "Arial")
        title_font = self._font_px(8.0 * self.dpi / 72.0, "Arial", bold=True)

        # gridlines behind the data
        if axes.get("gridlines") is True:
            for i in range(5):
                v = ymin + (ymax - ymin) * i / 4.0
                yy = y_px(v)
                draw.line([(x0, yy), (x1, yy)], fill=(221, 221, 221, 255),
                          width=max(1, int(round(0.3 * self.k))))

        # series drawing
        if bars is not None:
            cats = bars["cats"]
            groups = bars["groups"]
            ncat = max(1, len(cats))
            slot = pw / ncat
            ngrp = max(1, len(groups) if bars["stacked"] is False and groups else 1)
            bar_w = slot * 0.7 / ngrp
            for ci, cat in enumerate(cats):
                cx = x0 + (ci + 0.5) * slot
                if bars["stacked"]:
                    bottom = 0.0
                    for gi_, g in enumerate(groups):
                        v = bars["values"].get((cat, g))
                        if v is None:
                            continue
                        top = bottom + v
                        xa = cx - slot * 0.35
                        self._chart_bar(draw, xa, y_px(bottom), y_px(top),
                                        bar_w, self._series_color(gi_))
                        if show_values:
                            draw.text((cx, y_px(top) - 1.0 * self.k), _fmt_tick(v),
                                      font=tick_font, fill=(68, 68, 68, 255),
                                      anchor="ms")
                        bottom = top
                else:
                    for gi_, g in enumerate(groups):
                        v = bars["values"].get((cat, g))
                        if v is None:
                            continue
                        xa = cx - slot * 0.35 + gi_ * bar_w
                        self._chart_bar(draw, xa, y_px(0.0), y_px(v), bar_w,
                                        self._series_color(gi_))
                        if use_err:
                            e_vals = self._err_for(bars, pts, cat, g, ei)
                            if e_vals is not None:
                                self._err_bar(draw, xa + bar_w / 2.0,
                                              y_px(v + e_vals), y_px(v - e_vals))
                        if show_values:
                            draw.text((xa + bar_w / 2.0, y_px(v) - 1.0 * self.k),
                                      _fmt_tick(v), font=tick_font,
                                      fill=(68, 68, 68, 255), anchor="ms")
        else:
            xvals = [raw for _k, raw in points["xs"]]
            if points["x_numeric"]:
                xv = [_num(v) for v in xvals]
                xmin, xmax = min(xv), max(xv)
                if xmin == xmax:
                    xmin -= 1.0
                    xmax += 1.0
                pad = (xmax - xmin) * 0.05
                xmin -= pad
                xmax += pad

                def x_px(raw):
                    return x0 + (_num(raw) - xmin) / (xmax - xmin) * pw
                x_ticks = [xmin + (xmax - xmin) * i / 4.0 for i in range(5)]
            else:
                nx = max(1, len(points["xs"]))

                def x_px(raw):
                    key = str(raw) if raw is not None else ""
                    for i, (k2, _r) in enumerate(points["xs"]):
                        if k2 == key:
                            return x0 + (i + 0.5) * pw / nx
                    return x0 + pw / 2.0
                x_ticks = None
            for si, name in enumerate(points["names"]):
                color = self._series_color(si)
                rows_ = points["series"][name]
                if ctype in ("line", "line_multi"):
                    seg = []
                    for p in rows_:
                        seg.append((x_px(p["x"]), y_px(p["y"])))
                    lw = max(1, int(round(1.2 * self.dpi / 72.0)))
                    draw.line(seg, fill=color, width=lw, joint="curve")
                    r = max(2, int(round(0.9 * self.k)))
                    for px, py in seg:
                        draw.ellipse([px - r, py - r, px + r, py + r], fill=color)
                    if use_err:
                        for p in rows_:
                            if p["e"] is not None:
                                self._err_bar(draw, x_px(p["x"]),
                                              y_px(p["y"] + p["e"]),
                                              y_px(p["y"] - p["e"]))
                else:  # scatter
                    r = max(2, int(round(1.0 * self.k)))
                    for p in rows_:
                        px, py = x_px(p["x"]), y_px(p["y"])
                        draw.ellipse([px - r, py - r, px + r, py + r], fill=color)
                        if use_err and p["e"] is not None:
                            self._err_bar(draw, px, y_px(p["y"] + p["e"]),
                                          y_px(p["y"] - p["e"]))

        # axes frame
        draw.line([(x0, y1), (x1, y1)], fill=axis_color, width=sw_axis)
        draw.line([(x0, y0), (x0, y1)], fill=axis_color, width=sw_axis)

        # y ticks + labels
        for i in range(5):
            v = ymin + (ymax - ymin) * i / 4.0
            yy = y_px(v)
            draw.line([(x0 - 2, yy), (x0, yy)], fill=axis_color, width=sw_axis)
            draw.text((x0 - 1.2 * self.k, yy), _fmt_tick(v), font=tick_font,
                      fill=(0, 0, 0, 255), anchor="rs")

        # x ticks + labels
        if bars is not None:
            cats = bars["cats"]
            ncat = max(1, len(cats))
            slot = pw / ncat
            step = max(1, int(math.ceil(14.0 / max(slot, 1e-6))))
            for ci, cat in enumerate(cats):
                if ci % step:
                    continue
                cx = x0 + (ci + 0.5) * slot
                draw.line([(cx, y1), (cx, y1 + 2)], fill=axis_color, width=sw_axis)
                draw.text((cx, y1 + 1.2 * self.k), cat, font=tick_font,
                          fill=(0, 0, 0, 255), anchor="ma")
        elif points["x_numeric"]:
            for v in x_ticks:
                xx = x0 + (v - xmin) / (xmax - xmin) * pw
                draw.line([(xx, y1), (xx, y1 + 2)], fill=axis_color, width=sw_axis)
                draw.text((xx, y1 + 1.2 * self.k), _fmt_tick(v), font=tick_font,
                          fill=(0, 0, 0, 255), anchor="ma")
        else:
            nx = max(1, len(points["xs"]))
            slot = pw / nx
            step = max(1, int(math.ceil(14.0 / max(slot, 1e-6))))
            for i, (key, _raw) in enumerate(points["xs"]):
                if i % step:
                    continue
                cx = x0 + (i + 0.5) * slot
                draw.line([(cx, y1), (cx, y1 + 2)], fill=axis_color, width=sw_axis)
                draw.text((cx, y1 + 1.2 * self.k), key, font=tick_font,
                          fill=(0, 0, 0, 255), anchor="ma")

        # axis labels / title
        if title:
            draw.text((bx + bw / 2.0, by + 2.2 * self.k), str(title),
                      font=title_font, fill=(0, 0, 0, 255), anchor="mm")
        if xlabel:
            draw.text(((x0 + x1) / 2.0, y1 + 7.5 * self.k), str(xlabel),
                      font=label_font, fill=(0, 0, 0, 255), anchor="mm")
        if ylabel:
            self._rotated_label(img, (bx + 4.0 * self.k, (y0 + y1) / 2.0),
                                str(ylabel), label_font)

        # legend (right side, vertical list)
        if len(series_names) > 1 and legend_mode == "right":
            lx = x1 + 3.0 * self.k
            ly = y0
            for si, name in enumerate(series_names):
                color = self._series_color(si)
                draw.rectangle([lx, ly + si * 5.0 * self.k,
                                lx + 3.0 * self.k, ly + si * 5.0 * self.k + 3.0 * self.k],
                               fill=color)
                draw.text((lx + 4.0 * self.k, ly + si * 5.0 * self.k + 1.5 * self.k),
                          name, font=tick_font, fill=(0, 0, 0, 255), anchor="lm")
        return True

    @staticmethod
    def _err_for(bars, pts, cat, g, ei):
        if ei is None:
            return None
        vals = [p["e"] for p in pts
                if p["e"] is not None and str(p["x"]) == cat and str(p["g"]) == g]
        if not vals:
            return None
        return sum(vals) / len(vals)

    def _chart_bar(self, draw, x_left, y_top_px, y_bottom_px, width_px, color):
        top = min(y_top_px, y_bottom_px)
        bottom = max(y_top_px, y_bottom_px)
        if bottom - top < 0.5:
            bottom = top + 0.5
        draw.rectangle([x_left, top, x_left + width_px, bottom], fill=color)

    def _err_bar(self, draw, cx, y_hi, y_lo):
        cap = 1.2 * self.k
        draw.line([(cx, y_hi), (cx, y_lo)], fill=_BLACK, width=1)
        draw.line([(cx - cap, y_hi), (cx + cap, y_hi)], fill=_BLACK, width=1)
        draw.line([(cx - cap, y_lo), (cx + cap, y_lo)], fill=_BLACK, width=1)

    def _rotated_label(self, img, center, text, font):
        """Draw vertically rotated (90° CCW) axis label text."""
        w = int(font.getlength(text)) + 8
        h = int(font.size * 1.4) + 8
        layer = Image.new("RGBA", (max(1, w), max(1, h)), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer, "RGBA")
        ld.text((w / 2.0, h / 2.0), text, font=font, fill=(0, 0, 0, 255), anchor="mm")
        layer = layer.rotate(90, expand=True, resample=Image.BICUBIC)
        img.alpha_composite(layer, (int(center[0] - layer.width / 2.0),
                                    int(center[1] - layer.height / 2.0)))

    # -- panel label ------------------------------------------------------------

    def _draw_panel_label(self, draw, el, t):
        lay = el.get("panelLayout")
        lay = lay if isinstance(lay, dict) else {}
        label = lay.get("label")
        if not isinstance(label, str) or label == "":
            return
        ls = lay.get("labelStyle")
        ls = ls if isinstance(ls, dict) else {}
        fs_pt = _num(ls.get("fontSizePt"), 8.0)
        if fs_pt is None or fs_pt <= 0:
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的 labelStyle.fontSizePt 非法")
        fs_px = fs_pt * self.dpi / 72.0
        pos = lay.get("labelPosition")
        if pos is None:
            pos = "top-left"
        fs_mm = fs_pt * PT_TO_MM
        if pos == "top-right":
            x_mm, y_mm, anchor = t["x"] + t["w"], t["y"] - 0.6, "rs"
        elif pos == "below":
            x_mm, y_mm, anchor = t["x"], t["y"] + t["h"] + fs_mm, "ls"
        elif pos == "top-left":
            x_mm, y_mm, anchor = t["x"], t["y"] - 0.6, "ls"
        else:
            raise ValueError("figraster：元素 " + str(el.get("id")) +
                             " 的 panelLayout.labelPosition 非法（" + str(pos) + "）")
        fill = _parse_color(ls.get("fill"))
        if fill is None:
            fill = _BLACK
        font = self._font_px(fs_px, ls.get("fontFamily", "Arial"),
                             ls.get("fontWeight", "bold") == "bold", False, label)
        draw.text((x_mm * self.k, y_mm * self.k), label, font=font,
                  fill=fill, anchor={"ls": "ls", "rs": "rs"}[anchor])


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------

def render_to_image(doc, dpi=300):
    """Render a figure document to a white-background RGB PIL image.

    Pixel size is ceil(canvas.width_mm * dpi / 25.4) x ceil(...height...),
    matching FigExport.pixelSize in shared/lib/export.js.
    """
    d = _num(dpi, 300.0)
    if d is None or d <= 0:
        raise ValueError("figraster：dpi 必须是正数")
    return _Renderer(doc, d).run()


def export(doc, path, fmt, dpi=300):
    """Render doc and write it to path; returns the absolute path written.

    fmt: png | jpeg (jpg alias) | tiff | pdf.
    - TIFF carries XResolution/YResolution (282/283) and ResolutionUnit=296.
    - JPEG quality is 92.
    - PDF is a single page whose MediaBox equals the canvas mm converted to pt.
    """
    fmt_l = str(fmt).strip().lower()
    if fmt_l == "jpg":
        fmt_l = "jpeg"
    if fmt_l not in ("png", "jpeg", "tiff", "pdf"):
        raise ValueError("figraster：不支持的导出格式（" + str(fmt) + "）")
    d = _num(dpi, 300.0)
    if d is None or d <= 0:
        raise ValueError("figraster：dpi 必须是正数")
    img = render_to_image(doc, d)
    target = os.fspath(path)
    parent = os.path.dirname(os.path.abspath(target))
    if parent:
        os.makedirs(parent, exist_ok=True)
    if fmt_l == "png":
        img.save(target, "PNG", dpi=(d, d))
    elif fmt_l == "jpeg":
        img.convert("RGB").save(target, "JPEG", quality=92, dpi=(d, d))
    elif fmt_l == "tiff":
        img.save(target, "TIFF", dpi=(d, d))
    else:
        # exact MediaBox: px * 72 / resolution == canvas mm -> pt
        w_mm = float(doc["canvas"]["width_mm"])
        resolution = img.width * MM_PER_INCH / w_mm
        img.save(target, "PDF", resolution=resolution)
    return os.path.abspath(target)


def _require_fitz():
    try:
        import fitz
    except Exception as exc:
        raise RuntimeError(
            "figraster.export_svg：需要可用的 PyMuPDF（fitz）；"
            "当前环境不可用，不会回退到旧 Pillow 渲染器") from exc
    return fitz


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


__all__ = ["render_to_image", "export", "export_svg", "validate_doc"]
