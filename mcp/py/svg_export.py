# -*- coding: utf-8 -*-
"""Sanitized, offline SVG conversion for figraster.export_svg."""

from __future__ import annotations

import base64
import binascii
import io
import math
import os
import re
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET

from PIL import Image, ImageColor

MM_PER_INCH = 25.4
SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
XML_NS = "http://www.w3.org/XML/1998/namespace"

MAX_SVG_BYTES = 96 * 1024 * 1024
MAX_SVG_ELEMENTS = 100000
MAX_EMBEDDED_RESOURCES = 128
MAX_RESOURCE_BYTES = 32 * 1024 * 1024
MAX_TOTAL_RESOURCE_BYTES = 64 * 1024 * 1024
MAX_ASSET_PIXELS = 40000000
MAX_TOTAL_RASTER_PIXELS = 100000000
MAX_OUTPUT_PIXELS = 100000000
MAX_OUTPUT_SIDE = 32768
MAX_PDF_SIDE_PT = 14400.0
MAX_EMBEDDED_SVG_DEPTH = 6

_LENGTH_RE = re.compile(
    r"^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*"
    r"(mm|cm|in|pt|pc|px|q)?$", re.I)
_URL_RE = re.compile(r"url\s*\(\s*(['\"]?)(.*?)\1\s*\)", re.I | re.S)
_SCHEME_RE = re.compile(r"(?:https?|ftp|file|javascript|vbscript)\s*:", re.I)
_DANGEROUS_TAGS = frozenset((
    "script", "handler", "foreignobject", "iframe", "object", "embed",
    "audio", "video", "canvas",
))
_RASTER_FORMATS = frozenset(("PNG", "JPEG", "GIF", "BMP", "WEBP", "TIFF"))
_HREF_ATTRS = ("href", "{%s}href" % XLINK_NS)
_PAINT_ATTRS = frozenset((
    "fill", "stroke", "filter", "clip-path", "mask", "cursor",
    "marker", "marker-start", "marker-mid", "marker-end", "src",
))

ET.register_namespace("", SVG_NS)
ET.register_namespace("xlink", XLINK_NS)


class _Budget:
    def __init__(self):
        self.resources = 0
        self.resource_bytes = 0
        self.raster_pixels = 0

    def add_resource(self, size):
        self.resources += 1
        if self.resources > MAX_EMBEDDED_RESOURCES:
            raise ValueError("内嵌资源数量超过上限 %d" % MAX_EMBEDDED_RESOURCES)
        self.resource_bytes += size
        if self.resource_bytes > MAX_TOTAL_RESOURCE_BYTES:
            raise ValueError("内嵌资源解码后总大小超过上限 %d 字节" % MAX_TOTAL_RESOURCE_BYTES)

    def add_pixels(self, count):
        self.raster_pixels += count
        if self.raster_pixels > MAX_TOTAL_RASTER_PIXELS:
            raise ValueError("资源栅格化总像素超过上限 %d" % MAX_TOTAL_RASTER_PIXELS)


def _require_fitz():
    try:
        import fitz
    except Exception as exc:
        raise RuntimeError(
            "需要可用的 PyMuPDF（fitz）；当前环境不可用，不会回退到旧 Pillow 渲染器"
        ) from exc
    return fitz


def _local_name(name):
    if not isinstance(name, str):
        return ""
    return name.rsplit("}", 1)[-1].lower()


def _finite_number(value, label):
    if isinstance(value, bool):
        raise ValueError(label + " 必须是数值")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(label + " 必须是数值")
    if not math.isfinite(result):
        raise ValueError(label + " 必须是有限数值")
    return result


def _parse_view_box(root):
    raw = root.get("viewBox")
    if raw is None:
        return None
    parts = re.split(r"[\s,]+", raw.strip())
    if len(parts) != 4:
        raise ValueError("SVG 根 viewBox 必须包含四个数值")
    values = [_finite_number(part, "SVG 根 viewBox") for part in parts]
    if values[2] <= 0 or values[3] <= 0:
        raise ValueError("SVG 根 viewBox 宽高必须大于 0")
    return values


def _length_mm(raw, label):
    if raw is None:
        return None
    match = _LENGTH_RE.fullmatch(str(raw).strip())
    if match is None:
        raise ValueError(label + " 必须是带物理单位的长度或 CSS px 数值，不支持百分比")
    value = _finite_number(match.group(1), label)
    if value <= 0:
        raise ValueError(label + " 必须大于 0")
    unit = (match.group(2) or "px").lower()
    factors = {
        "mm": 1.0,
        "cm": 10.0,
        "q": 0.25,
        "in": 25.4,
        "pt": 25.4 / 72.0,
        "pc": 25.4 / 6.0,
        "px": 25.4 / 96.0,
    }
    return value * factors[unit]


def _root_geometry(root):
    view_box = _parse_view_box(root)
    width_mm = _length_mm(root.get("width"), "SVG 根 width")
    height_mm = _length_mm(root.get("height"), "SVG 根 height")
    if width_mm is None and height_mm is None:
        if view_box is None:
            raise ValueError("SVG 根必须提供 width/height 或 viewBox")
        width_mm = view_box[2] * 25.4 / 96.0
        height_mm = view_box[3] * 25.4 / 96.0
    elif width_mm is None:
        if view_box is None:
            raise ValueError("SVG 根缺少 width")
        width_mm = height_mm * view_box[2] / view_box[3]
    elif height_mm is None:
        if view_box is None:
            raise ValueError("SVG 根缺少 height")
        height_mm = width_mm * view_box[3] / view_box[2]
    if not math.isfinite(width_mm) or not math.isfinite(height_mm) \
            or width_mm <= 0 or height_mm <= 0:
        raise ValueError("SVG 根物理宽高必须是有限正数")
    width_pt = width_mm * 72.0 / MM_PER_INCH
    height_pt = height_mm * 72.0 / MM_PER_INCH
    if width_pt > MAX_PDF_SIDE_PT or height_pt > MAX_PDF_SIDE_PT:
        raise ValueError("SVG 根物理尺寸超过 PDF 单页安全上限")
    return width_mm, height_mm, view_box


def _parse_svg(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    elif isinstance(data, (bytes, bytearray)):
        data = bytes(data)
    else:
        raise TypeError("svg 必须是字符串或字节")
    if not data.strip():
        raise ValueError("svg 不能为空")
    if len(data) > MAX_SVG_BYTES:
        raise ValueError("SVG 字节大小超过上限 %d" % MAX_SVG_BYTES)
    if re.search(br"<!\s*(?:doctype|entity)", data, re.I):
        raise ValueError("SVG 不允许 DOCTYPE 或 ENTITY，已阻止外部实体风险")
    if re.search(br"<\?\s*xml-stylesheet", data, re.I):
        raise ValueError("SVG 不允许 xml-stylesheet 外部样式处理指令")
    try:
        root = ET.fromstring(data)
    except (ET.ParseError, ValueError) as exc:
        raise ValueError("SVG XML 解析失败：" + str(exc)) from exc
    if _local_name(root.tag) != "svg":
        raise ValueError("根节点必须是 SVG svg 元素")
    if root.tag.startswith("}") is False and "}" in root.tag:
        namespace = root.tag[1:].split("}", 1)[0]
        if namespace != SVG_NS:
            raise ValueError("SVG 根节点命名空间非法")
    if sum(1 for _node in root.iter()) > MAX_SVG_ELEMENTS:
        raise ValueError("SVG 元素数量超过上限 %d" % MAX_SVG_ELEMENTS)
    return root


def _validate_css(value):
    if "url" in value.lower() or "@" in value:
        if "@import" in value.lower() or "expression" in value.lower() \
                or "-moz-binding" in value.lower() or "behavior:" in value.lower():
            raise ValueError("SVG style 包含不允许的外部样式或可执行 CSS")
        matches = list(_URL_RE.finditer(value))
        if "url" in value.lower() and not matches and "url" in value.lower():
            raise ValueError("SVG style 含无法安全解析的 url()")
        for match in matches:
            reference = match.group(2).strip()
            if not reference.startswith("#") or any(ch in reference for ch in "<>\"'"):
                raise ValueError("SVG style/url 仅允许本地 #id 引用，禁止外部资源")
    if _SCHEME_RE.search(value):
        raise ValueError("SVG style 包含外部 URL 或危险协议，已拒绝")


def _validate_attribute(element, name, value):
    local = _local_name(name)
    if local.startswith("on"):
        raise ValueError("SVG 不允许 on* 事件处理器")
    if name == "{%s}base" % XML_NS and value.strip():
        raise ValueError("SVG 不允许 xml:base 改变资源解析位置")
    if local == "style":
        _validate_css(value)
    if local in _PAINT_ATTRS:
        if local == "src" and value.strip():
            raise ValueError("SVG 不允许 src 外部资源属性")
        _validate_css(value)
        if _SCHEME_RE.search(value) or re.match(r"^\s*//", value):
            raise ValueError("SVG paint/filter/url 包含外部或危险 URI，已拒绝")


def _validate_tree(root):
    for element in root.iter():
        tag = _local_name(element.tag)
        if tag in _DANGEROUS_TAGS:
            raise ValueError("SVG 不允许可执行或外部内容元素 <%s>" % tag)
        if tag == "style" and element.text:
            _validate_css(element.text)
        for name, value in element.attrib.items():
            _validate_attribute(element, name, value)
        kind = element.get("data-relation-kind")
        if kind is not None:
            direction = element.get("data-relation-direction")
            if direction == "backwards":
                direction = "reverse"
            direction = direction or ("none" if kind in ("include", "associate") else "forward")
            if kind not in ("activate", "inhibit", "include", "associate", "sequence"):
                raise ValueError("SVG connector 的 relation kind 非法：" + kind)
            if direction not in ("forward", "reverse", "both", "none") or \
                    (kind in ("include", "associate") and direction != "none") or \
                    (kind not in ("include", "associate") and direction == "none"):
                raise ValueError("SVG connector 的 direction 与 kind 冲突")
            if not element.get("data-source-id") or not element.get("data-target-id"):
                raise ValueError("SVG connector 必须保留 data-source-id / data-target-id")
        if tag not in ("image", "feimage"):
            for name in _HREF_ATTRS:
                value = element.get(name)
                if value and not value.strip().startswith("#"):
                    raise ValueError("SVG <%s> 的 href 仅允许本地 #id 引用" % tag)


def _decode_data_url(value):
    header, separator, payload = value.partition(",")
    if not separator or not header.lower().startswith("data:"):
        raise ValueError("内嵌 SVG/image 资源不是有效 data URL")
    if len(payload) > MAX_RESOURCE_BYTES * 3 + 1024:
        raise ValueError("内嵌资源 data URL 超过编码大小上限")
    parts = header[5:].split(";")
    media_type = parts[0].strip().lower()
    is_base64 = any(part.strip().lower() == "base64" for part in parts[1:])
    try:
        raw = urllib.parse.unquote_to_bytes(payload)
        if is_base64:
            data = base64.b64decode(raw, validate=True)
        else:
            data = raw
    except (ValueError, binascii.Error, UnicodeError) as exc:
        raise ValueError("内嵌资源 data URL 解码失败") from exc
    if not data:
        raise ValueError("内嵌资源 data URL 内容为空")
    if len(data) > MAX_RESOURCE_BYTES:
        raise ValueError("单个内嵌资源超过 %d 字节上限" % MAX_RESOURCE_BYTES)
    return data, media_type


def _sniff_format(data, media_type):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "raster"
    if data.startswith(b"\xff\xd8\xff"):
        return "raster"
    if data.startswith((b"GIF87a", b"GIF89a", b"BM")):
        return "raster"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "raster"
    if data.startswith((b"II*\x00", b"MM\x00*")):
        return "raster"
    prefix = data[:4096].lstrip(b"\xef\xbb\xbf \t\r\n")
    if media_type in ("image/svg+xml", "text/svg") or prefix.startswith(b"<"):
        return "svg"
    raise ValueError("无法按 data URL MIME/文件 magic 识别内嵌资源类型")


def _raster_to_png(data, budget):
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in _RASTER_FORMATS:
                raise ValueError("不支持的栅格资源格式 " + str(source.format))
            width, height = source.size
            if width <= 0 or height <= 0 or width * height > MAX_ASSET_PIXELS:
                raise ValueError("栅格资源尺寸为空或像素超过上限 %d" % MAX_ASSET_PIXELS)
            budget.add_pixels(width * height)
            source.seek(0)
            source.load()
            image = source.convert("RGBA")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("内嵌栅格资源解码失败：" + str(exc)) from exc
    try:
        output = io.BytesIO()
        image.save(output, "PNG")
        return output.getvalue()
    finally:
        image.close()


def _pixel_size(width_mm, height_mm, dpi, budget=None):
    exact_w = width_mm * dpi / MM_PER_INCH
    exact_h = height_mm * dpi / MM_PER_INCH
    width = max(1, int(math.ceil(exact_w - 1e-12)))
    height = max(1, int(math.ceil(exact_h - 1e-12)))
    if width > MAX_OUTPUT_SIDE or height > MAX_OUTPUT_SIDE \
            or width * height > MAX_OUTPUT_PIXELS:
        raise ValueError("导出像素尺寸超过安全上限（单边 %d，总像素 %d）" % (
            MAX_OUTPUT_SIDE, MAX_OUTPUT_PIXELS))
    if budget is not None:
        budget.add_pixels(width * height)
    return width, height


def _open_pdf(svg_data, width_mm, height_mm, fitz):
    expected_width = width_mm * 72.0 / MM_PER_INCH
    expected_height = height_mm * 72.0 / MM_PER_INCH
    svg_document = fitz.open(stream=svg_data, filetype="svg")
    try:
        pdf_data = svg_document.convert_to_pdf()
    finally:
        svg_document.close()
    source = fitz.open(stream=pdf_data, filetype="pdf")
    if source.page_count != 1:
        source.close()
        raise ValueError("SVG 转换结果不是单页 PDF")
    page = source[0]
    mismatch = max(abs(page.rect.width - expected_width),
                   abs(page.rect.height - expected_height))
    if mismatch > 0.01:
        if expected_width < 1.0 or expected_height < 1.0:
            actual = (page.rect.width, page.rect.height)
            source.close()
            raise ValueError(
                "MuPDF 将小于 1pt 的页面强制改为最小页面，物理尺寸不符："
                "期望 %.6gpt x %.6gpt，实际 %.6gpt x %.6gpt；已拒绝可能的空白导出" %
                (expected_width, expected_height, actual[0], actual[1]))
        exact = fitz.open()
        try:
            exact_page = exact.new_page(width=expected_width, height=expected_height)
            exact_page.show_pdf_page(exact_page.rect, source, 0, keep_proportion=False)
        except Exception:
            exact.close()
            source.close()
            raise
        source.close()
        return exact
    return source


def _premultiplied_image(pix):
    """MuPDF RGBA samples are premultiplied; Pillow's RGBa mode preserves that."""
    if pix.n != 4:
        raise ValueError("MuPDF 返回栅格通道异常：期望 4 通道 RGBA，实际 %d" % pix.n)
    return Image.frombytes("RGBa", (pix.width, pix.height), pix.samples)


def _pdf_to_rgba(pdf_document, width_mm, height_mm, dpi, fitz):
    width, height = _pixel_size(width_mm, height_mm, dpi)
    page = pdf_document[0]
    scale = dpi / 72.0
    origin = page.rect.top_left
    clip = fitz.Rect(origin.x, origin.y,
                     origin.x + width / scale, origin.y + height / scale)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip,
                          colorspace=fitz.csRGB, alpha=True, annots=False)
    if pix.width != width or pix.height != height:
        raise ValueError("MuPDF 返回栅格尺寸异常：期望 %dx%d RGBA，实际 %dx%d" % (
            width, height, pix.width, pix.height))
    with _premultiplied_image(pix) as premultiplied:
        return premultiplied.convert("RGBA")


_MIN_EMBEDDED_SAMPLES = 16


def _embedded_svg_to_png(svg_data, width_mm, height_mm, dpi, budget, fitz):
    width, height = _pixel_size(width_mm, height_mm, dpi, budget)
    pdf_document = _open_pdf(svg_data, width_mm, height_mm, fitz)
    try:
        page = pdf_document[0]
        base_scale = dpi / 72.0
        exact_width = page.rect.width * base_scale
        exact_height = page.rect.height * base_scale
        factor = max(1, int(math.ceil(
            _MIN_EMBEDDED_SAMPLES / max(1e-12, min(exact_width, exact_height)))))
        sample_width = max(1, int(math.ceil(exact_width * factor - 1e-12)))
        sample_height = max(1, int(math.ceil(exact_height * factor - 1e-12)))
        if sample_width > MAX_OUTPUT_SIDE or sample_height > MAX_OUTPUT_SIDE \
                or sample_width * sample_height > MAX_OUTPUT_PIXELS:
            raise ValueError("嵌套 SVG 内部采样尺寸超过安全上限")
        budget.add_pixels(sample_width * sample_height)
        sample_matrix = fitz.Matrix(sample_width / page.rect.width,
                                    sample_height / page.rect.height)
        pix = page.get_pixmap(matrix=sample_matrix,
                              colorspace=fitz.csRGB, alpha=True, annots=False)
        with _premultiplied_image(pix) as sampled:
            if sampled.size == (width, height):
                image = sampled.convert("RGBA")
            else:
                with sampled.resize((width, height), Image.LANCZOS) as resized:
                    image = resized.convert("RGBA")
    finally:
        pdf_document.close()
    try:
        output = io.BytesIO()
        image.save(output, "PNG", dpi=(dpi, dpi))
        return output.getvalue()
    finally:
        image.close()


def _png_data_url(data):
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


def _prepare_embedded_svg(data, dpi, depth, budget, fitz):
    root = _parse_svg(data)
    width_mm, height_mm, view_box = _root_geometry(root)
    normalized = _normalize_tree(root, doc=None, view_box=view_box,
                                 transparent=False, dpi=dpi, depth=depth,
                                 budget=budget, fitz=fitz)
    return _embedded_svg_to_png(normalized, width_mm, height_mm, dpi, budget, fitz)


def _normalize_image_reference(value, dpi, depth, budget, fitz):
    data, media_type = _decode_data_url(value.strip())
    budget.add_resource(len(data))
    kind = _sniff_format(data, media_type)
    if kind == "svg":
        if depth >= MAX_EMBEDDED_SVG_DEPTH:
            raise ValueError("嵌套 SVG 递归深度超过上限 %d" % MAX_EMBEDDED_SVG_DEPTH)
        png = _prepare_embedded_svg(data, dpi, depth + 1, budget, fitz)
    else:
        png = _raster_to_png(data, budget)
    return _png_data_url(png)


def _normalize_tree(root, doc, view_box, transparent, dpi, depth, budget, fitz):
    _validate_tree(root)
    for element in root.iter():
        if _local_name(element.tag) not in ("image", "feimage"):
            continue
        normalized_references = {}
        for name in _HREF_ATTRS:
            value = element.get(name)
            if not value:
                continue
            if not value.strip().lower().startswith("data:"):
                raise ValueError("SVG image 仅允许内嵌 data URL，禁止远程、文件及相对路径引用")
            if value not in normalized_references:
                normalized_references[value] = _normalize_image_reference(
                    value, dpi, depth, budget, fitz)
            element.set(name, normalized_references[value])
    if transparent:
        _remove_canvas_background(root, doc, view_box)
    return ET.tostring(root, encoding="utf-8", xml_declaration=False,
                       short_empty_elements=True)


def _color_key(value):
    try:
        rgba = ImageColor.getrgb(str(value).strip())
    except (ValueError, TypeError):
        return None
    return tuple(rgba)


def _number_attr(element, name):
    default = 0.0 if name in ("x", "y") else None
    raw = element.get(name)
    if raw is None and default is not None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _same_box(element, box, tolerance=1e-5):
    values = [_number_attr(element, name) for name in ("x", "y", "width", "height")]
    if any(value is None for value in values):
        return False
    return all(abs(value - target) <= tolerance * max(1.0, abs(target))
               for value, target in zip(values, box))


def _is_canvas_background(element, doc, view_box):
    if _local_name(element.tag) != "rect" or element.get("data-fig-id"):
        return False
    if element.get("data-canvas-background", "").lower() == "true":
        return True
    if set(element.attrib) - {"x", "y", "width", "height", "fill"}:
        return False
    if not isinstance(doc, dict):
        return False
    canvas = doc.get("canvas")
    if not isinstance(canvas, dict):
        return False
    background = canvas.get("background")
    if not isinstance(background, str) or background.strip().lower() in ("", "none", "transparent"):
        return False
    if _color_key(element.get("fill")) != _color_key(background):
        return False
    boxes = []
    if view_box is not None:
        boxes.append(tuple(view_box))
    try:
        boxes.append((0.0, 0.0, float(canvas["width_mm"]), float(canvas["height_mm"])))
    except (KeyError, TypeError, ValueError):
        pass
    return any(_same_box(element, box) for box in boxes)


def _remove_canvas_background(root, doc, view_box):
    for element in list(root):
        tag = _local_name(element.tag)
        if tag in ("defs", "title", "desc", "metadata"):
            continue
        if _is_canvas_background(element, doc, view_box):
            root.remove(element)
        break


def _validate_panel(doc, panel_id):
    if panel_id is None:
        return
    if not isinstance(panel_id, str) or not panel_id:
        raise ValueError("panel_id 必须是非空字符串或 None")
    if not isinstance(doc, dict) or not isinstance(doc.get("elements"), list):
        raise ValueError("panel/chart 导出需要包含 elements 数组的 doc")
    matches = [element for element in doc["elements"]
               if isinstance(element, dict) and element.get("id") == panel_id]
    if not matches:
        raise ValueError("panel_id 不存在：" + panel_id)
    if len(matches) != 1:
        raise ValueError("panel_id 在 doc 中不唯一：" + panel_id)
    if matches[0].get("type") not in ("panel", "chart"):
        raise ValueError("panel_id 指向的元素不是 panel 或 chart：" + panel_id)


def _atomic_write(target, data):
    absolute = os.path.abspath(target)
    parent = os.path.dirname(absolute)
    if parent:
        os.makedirs(parent, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".figraster-", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, absolute)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    return absolute


def export_svg(svg, doc, path, fmt, dpi=300, panel_id=None, transparent=False):
    """Convert a sanitized canonical SVG without network or external file access."""
    try:
        fmt_l = str(fmt).strip().lower()
        if fmt_l == "jpg":
            fmt_l = "jpeg"
        if fmt_l not in ("png", "jpeg", "tiff", "pdf"):
            raise ValueError("不支持的导出格式（%s）" % fmt)
        dpi_value = _finite_number(dpi, "dpi")
        if dpi_value <= 0:
            raise ValueError("dpi 必须是正数")
        if not isinstance(transparent, bool):
            raise TypeError("transparent 必须是布尔值")
        if transparent and fmt_l != "png":
            raise ValueError("transparent=true 仅支持 PNG；%s 不会静默改为 RGBA/RGB" % fmt_l.upper())
        _validate_panel(doc, panel_id)
        fitz = _require_fitz()
        root = _parse_svg(svg)
        width_mm, height_mm, view_box = _root_geometry(root)
        budget = _Budget()
        normalized = _normalize_tree(
            root, doc=doc, view_box=view_box, transparent=transparent,
            dpi=dpi_value, depth=0, budget=budget, fitz=fitz)
        if fmt_l != "pdf":
            _pixel_size(width_mm, height_mm, dpi_value)
        pdf_document = _open_pdf(normalized, width_mm, height_mm, fitz)
        try:
            if fmt_l == "pdf":
                output = pdf_document.tobytes(garbage=4, deflate=True)
                image = None
            else:
                image = _pdf_to_rgba(pdf_document, width_mm, height_mm, dpi_value, fitz)
        finally:
            pdf_document.close()
        if image is not None:
            try:
                buffer = io.BytesIO()
                if fmt_l == "png" and transparent:
                    image.save(buffer, "PNG", dpi=(dpi_value, dpi_value))
                else:
                    white = Image.new("RGBA", image.size, (255, 255, 255, 255))
                    try:
                        opaque = Image.alpha_composite(white, image).convert("RGB")
                    finally:
                        white.close()
                    try:
                        if fmt_l == "png":
                            opaque.save(buffer, "PNG", dpi=(dpi_value, dpi_value))
                        elif fmt_l == "jpeg":
                            opaque.save(buffer, "JPEG", quality=92, dpi=(dpi_value, dpi_value))
                        else:
                            opaque.save(buffer, "TIFF", dpi=(dpi_value, dpi_value))
                    finally:
                        opaque.close()
                output = buffer.getvalue()
            finally:
                image.close()
        return _atomic_write(os.fspath(path), output)
    except TypeError:
        raise
    except Exception as exc:
        message = str(exc)
        prefix = "figraster.export_svg："
        if message.startswith(prefix):
            raise
        raise ValueError(prefix + "SVG 导出失败：" + message) from exc


__all__ = ["export_svg"]
