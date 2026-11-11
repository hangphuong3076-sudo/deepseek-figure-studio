# docio.py -- document I/O for v3-agent-plugin.
#
# Responsibilities (see ../PLUGIN-API.md):
#   - validate_doc(doc)            structural validation, returns a list of
#                                  Chinese error messages (empty == valid)
#   - load_doc(path)/save_doc()    plain FigureDocument JSON files
#   - save_project()/load_project()  *.figureproj.json project files with the
#                                  exact structure produced by
#                                  shared/lib/storage.js FigStore.projectFromDoc:
#                                  {format, format_version, doc, history, assets}
#                                  (history lives at the top level, doc.history == [])
#                                  meta.history_origin is preserved; legacy docs
#                                  capture their real current content playhead
#   - capture_history_origin()     non-recursive durable forward-replay base
#   - atomic_write()               temp file + os.replace, never a partial file
#   - safe_path()                  path safety validation (Windows aware)
#
# All error messages are in Chinese (project convention). Comments in English.

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

FORMAT = "figure-project"
FORMAT_VERSION = "1.0"
PROJECT_EXT = ".figureproj.json"
SCHEMA_VERSION = "1.0"

# Migration chain, mirrors FigStore.MIGRATIONS in shared/lib/storage.js.
MIGRATIONS = {
    "1.0": lambda project: project,
}

# Allowed element types, figure-document.schema.json $defs.element.type enum.
ELEMENT_TYPES = frozenset({
    "rect", "ellipse", "line", "arrow", "connector", "path", "text",
    "image", "chart", "group", "panel", "connector",
})

# Element id pattern, figure-document.schema.json $defs.element.id.
_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]+$")

# Windows-illegal characters inside a path component (colon is legal only in
# the drive prefix, which is checked separately).
_INVALID_COMPONENT_CHARS = set('<>:"|?*')

# Reserved Windows device names (checked against the component stem).
_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)


def _is_number(value) -> bool:
    # bool is a subclass of int in Python, exclude it explicitly.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_iso_datetime(value) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def _content_rev(doc) -> int:
    """Mirror FigOps.contentRevOf for project persistence."""
    history = doc.get("history") or []
    if not history:
        return 0
    record = history[-1]
    seen = set()
    while isinstance(record, dict) and record.get("kind") == "revert" \
            and record.get("rev") not in seen:
        seen.add(record.get("rev"))
        target = record.get("revert_to") or 0
        next_record = next((item for item in history if item.get("rev") == target), None)
        if next_record is None:
            return target
        record = next_record
    return record.get("rev") or 0 if isinstance(record, dict) else 0


def _checkpoint_copy(value, root=False):
    if isinstance(value, list):
        return [_checkpoint_copy(item) for item in value]
    if not isinstance(value, dict):
        return copy.deepcopy(value)
    blocked = {"history_origin", "__snapshots", "key", "DOM", "saveToken"}
    return {
        key: _checkpoint_copy(item)
        for key, item in value.items()
        if key not in blocked and not (root and key == "history")
    }


def capture_history_origin(doc, content_rev=None) -> dict:
    """Return a doc with one non-recursive, durable history replay base."""
    if not isinstance(doc, dict) or not isinstance(doc.get("elements"), list):
        raise ValueError("capture_history_origin: doc 必须是含 elements 数组的文档对象")
    rev = _content_rev(doc) if content_rev is None else content_rev
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 0:
        raise ValueError("history_origin.rev 必须是非负整数")
    captured = copy.deepcopy(doc)
    meta = captured.setdefault("meta", {})
    meta["history_origin"] = {"rev": rev, "doc": _checkpoint_copy(doc, root=True)}
    return captured


def _initialize_history_origin(doc) -> dict:
    meta = doc.get("meta")
    if isinstance(meta, dict) and meta.get("history_origin") is not None:
        return doc
    # A legacy document can only promise replay forward from its real playhead.
    return capture_history_origin(doc)


# ---------------------------------------------------------------------------
# Path safety
# ---------------------------------------------------------------------------

def safe_path(path, base_dir=None, must_exist=False, allowed_ext=None) -> str:
    """Validate and normalize a filesystem path; return the absolute path string.

    path:        non-empty string, no NUL bytes, Windows-safe components.
    base_dir:    optional base directory; the resolved path must stay inside it.
    must_exist:  when True, raise FileNotFoundError unless the path is a file.
    allowed_ext: iterable of allowed filename endings, e.g. (".json",)
                 or (".figureproj.json",); matched case-insensitively against
                 the full filename (Path.suffix alone cannot match
                 ".figureproj.json" because it only keeps the last suffix).
    """
    if not isinstance(path, str) or not path.strip():
        raise ValueError("路径必须是非空字符串")
    if "\x00" in path:
        raise ValueError("路径包含非法字符 NUL")

    p = Path(os.path.abspath(os.path.expanduser(path)))

    for i, part in enumerate(p.parts):
        # Skip the Windows drive prefix (e.g. "E:\"), colon is legal there.
        if i == 0 and re.fullmatch(r"[A-Za-z]:\\?", part):
            continue
        for ch in _INVALID_COMPONENT_CHARS:
            if ch in part:
                raise ValueError(f"路径组件 {part!r} 含 Windows 非法字符 {ch!r}")
        name = part
        if name.endswith(" ") or name.endswith("."):
            raise ValueError(f"路径组件 {part!r} 不能以空格或点结尾")
        stem = name.split(".")[0].upper()
        if stem in _RESERVED_NAMES:
            raise ValueError(f"路径组件 {part!r} 是 Windows 保留设备名，不允许使用")

    if base_dir is not None:
        base = Path(os.path.realpath(os.path.abspath(str(base_dir))))
        real = Path(os.path.realpath(str(p)))
        if not real.is_relative_to(base):
            raise ValueError(f"路径越界：{real} 不在允许的基目录 {base} 内")

    if must_exist and not p.is_file():
        raise FileNotFoundError(f"文件不存在：{p}")

    if allowed_ext is not None:
        exts = [str(e).lower() for e in allowed_ext]
        if not any(str(p).lower().endswith(e) for e in exts):
            pretty = " / ".join(allowed_ext)
            raise ValueError(f"文件扩展名必须是 {pretty} 之一，实际为 {p.name!r}")

    return str(p)


# ---------------------------------------------------------------------------
# Atomic write
# ---------------------------------------------------------------------------

def atomic_write(path, data, encoding: str = "utf-8") -> str:
    """Write str or bytes to path atomically: temp file in the same directory,
    fsync, then os.replace. Returns the absolute path written."""
    p = Path(safe_path(path))
    if p.is_dir():
        raise IsADirectoryError(f"目标路径是目录，无法写入文件：{p}")
    parent = p.parent
    if not parent.is_dir():
        raise FileNotFoundError(f"父目录不存在，请先创建目录：{parent}")

    payload = data if isinstance(data, (bytes, bytearray)) else str(data).encode(encoding)

    fd, tmp_name = tempfile.mkstemp(dir=str(parent), prefix=p.name + ".", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, str(p))
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return str(p)


def _read_json(path: str):
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            return json.load(fh)
    except json.JSONDecodeError as exc:
        raise ValueError(f"文件不是有效的 JSON（{exc.msg}，第 {exc.lineno} 行）") from exc
    except UnicodeDecodeError as exc:
        raise ValueError(f"文件不是 UTF-8 编码，无法读取：{path}") from exc


# ---------------------------------------------------------------------------
# validate_doc
# ---------------------------------------------------------------------------

def validate_doc(doc) -> list:
    """Validate a FigureDocument against figure-document.schema.json (light,
    structural checks) plus referential integrity. Returns a list of Chinese
    error messages; an empty list means the document is valid."""
    errors = []
    if not isinstance(doc, dict):
        return [f"doc 必须是 JSON 对象，实际为 {type(doc).__name__}"]

    if "schema_version" not in doc:
        errors.append('缺少 schema_version 字段（必须为 "1.0"）')
    elif doc["schema_version"] != SCHEMA_VERSION:
        errors.append(f'schema_version 必须为 "{SCHEMA_VERSION}"，实际为 {doc["schema_version"]!r}')

    if not isinstance(doc.get("id"), str) or not doc["id"]:
        errors.append("缺少 id 字段，或 id 不是非空字符串（工程持久化依赖 doc.id）")

    title = doc.get("title")
    if title is not None and not isinstance(title, str):
        errors.append(f"title 必须是字符串，实际为 {title!r}")

    # --- canvas ------------------------------------------------------------
    canvas = doc.get("canvas")
    if not isinstance(canvas, dict):
        errors.append("缺少 canvas 对象")
    else:
        for key in ("width_mm", "height_mm", "dpi", "background"):
            if key not in canvas:
                errors.append(f"canvas 缺少必填字段 {key}")
        for key in ("width_mm", "height_mm", "dpi"):
            value = canvas.get(key)
            if value is not None and not _is_number(value):
                errors.append(f"canvas.{key} 必须是数字，实际为 {value!r}")
            elif _is_number(value) and value <= 0:
                errors.append(f"canvas.{key} 必须大于 0，实际为 {value!r}")
        if "background" in canvas and not isinstance(canvas["background"], str):
            errors.append(f"canvas.background 必须是字符串（CSS 颜色），实际为 {canvas['background']!r}")

    # --- elements ------------------------------------------------------------
    elements = doc.get("elements")
    ids = {}
    if not isinstance(elements, list):
        errors.append("缺少 elements 数组")
    else:
        for i, el in enumerate(elements):
            where = f"elements[{i}]"
            if not isinstance(el, dict):
                errors.append(f"{where} 必须是对象")
                continue
            el_id = el.get("id")
            if not isinstance(el_id, str) or not el_id:
                errors.append(f"{where} 缺少 id，或 id 不是非空字符串")
            elif not _ID_PATTERN.match(el_id):
                errors.append(f"{where}.id {el_id!r} 不符合规则 ^[A-Za-z0-9_.:-]+$")
            else:
                if el_id in ids:
                    errors.append(f"{where}.id {el_id!r} 与 elements[{ids[el_id]}].id 重复")
                else:
                    ids[el_id] = i
            el_type = el.get("type")
            if el_type not in ELEMENT_TYPES:
                errors.append(f"{where}.type 必须是 {sorted(ELEMENT_TYPES)} 之一，实际为 {el_type!r}")
            transform = el.get("transform")
            if not isinstance(transform, dict):
                errors.append(f"{where} 缺少 transform 对象")
            else:
                for key in ("x", "y", "w", "h"):
                    value = transform.get(key)
                    if value is None:
                        errors.append(f"{where}.transform 缺少 {key}")
                    elif not _is_number(value):
                        errors.append(f"{where}.transform.{key} 必须是数字，实际为 {value!r}")
            style = el.get("style")
            if style is not None and not isinstance(style, dict):
                errors.append(f"{where}.style 必须是对象")
            if el_type in ("group", "panel"):
                children = el.get("children")
                if children is not None and not isinstance(children, list):
                    errors.append(f"{where}.children 必须是字符串数组")

        # Referential integrity (parent_id / children).
        for i, el in enumerate(elements):
            if not isinstance(el, dict):
                continue
            parent_id = el.get("parent_id")
            if parent_id is not None:
                if not isinstance(parent_id, str):
                    errors.append(f"elements[{i}].parent_id 必须是字符串或 null，实际为 {parent_id!r}")
                elif parent_id not in ids:
                    errors.append(f"elements[{i}].parent_id {parent_id!r} 指向不存在的元素")
            children = el.get("children")
            if isinstance(children, list):
                for j, child_id in enumerate(children):
                    if not isinstance(child_id, str) or child_id not in ids:
                        errors.append(f"elements[{i}].children[{j}] {child_id!r} 指向不存在的元素")

        for i, el in enumerate(elements):
            if not isinstance(el, dict) or el.get("type") != "connector":
                continue
            relation = el.get("relation")
            if not isinstance(relation, dict):
                errors.append(f"elements[{i}] connector 缺少 relation 对象")
                continue
            kind = relation.get("kind")
            direction = relation.get("direction")
            if direction is None:
                direction = "none" if kind in ("include", "associate") else "forward"
            if direction == "backwards":
                direction = "reverse"
            if kind not in ("activate", "inhibit", "include", "associate", "sequence"):
                errors.append(f"elements[{i}].relation.kind 非法：{kind!r}")
            if direction not in ("forward", "reverse", "both", "none") or \
                    (kind in ("include", "associate") and direction != "none") or \
                    (kind not in ("include", "associate") and direction == "none"):
                errors.append(f"elements[{i}] connector direction={direction!r} 与 kind={kind!r} 冲突")
            diagram_id = el.get("diagramId") or el.get("diagram_id")
            for endpoint in ("source", "target"):
                ref = relation.get(endpoint)
                if not isinstance(ref, str) or not ref:
                    errors.append(f"elements[{i}].relation.{endpoint} 必须是非空节点 id")
                    continue
                direct = isinstance(elements[ids[ref]], dict) and elements[ids[ref]].get("type") != "connector" \
                    if ref in ids else False
                semantic = any(
                    isinstance(node, dict) and node.get("type") == "group"
                    and node.get("diagramNodeId") == ref
                    and (node.get("diagramId") or node.get("diagram_id")) == diagram_id
                    for node in elements
                )
                if not direct and not semantic:
                    errors.append(
                        f"elements[{i}].relation.{endpoint}={ref!r} 引用不存在或重复/跨示意图的节点")

        # Mutual consistency between parent_id and the parent's children list
        # (same invariant FigDoc.validate enforces in shared/lib/figdoc.js).
        for i, el in enumerate(elements):
            if not isinstance(el, dict):
                continue
            el_id = el.get("id")
            parent_id = el.get("parent_id")
            if isinstance(parent_id, str) and parent_id in ids:
                parent = elements[ids[parent_id]]
                if isinstance(parent, dict):
                    ptype = parent.get("type")
                    if ptype not in ("group", "panel"):
                        errors.append(
                            f"elements[{i}].parent_id {parent_id!r} 指向的元素类型为 {ptype!r}，必须是 group 或 panel")
                    else:
                        children = parent.get("children")
                        if not (isinstance(children, list) and el_id in children):
                            errors.append(
                                f"elements[{i}]（id={el_id!r}）的 parent_id 与父元素 {parent_id!r} 的 children 不一致")
            if isinstance(el.get("type"), str) and el["type"] in ("group", "panel"):
                children = el.get("children")
                if isinstance(children, list):
                    for child_id in children:
                        if isinstance(child_id, str) and child_id in ids:
                            child = elements[ids[child_id]]
                            if isinstance(child, dict) and child.get("parent_id") != el_id:
                                errors.append(
                                    f"子元素 {child_id!r} 的 parent_id 与父元素 {el_id!r} 的 children 不一致")

    # --- anchors -------------------------------------------------------------
    anchors = doc.get("anchors")
    if not isinstance(anchors, list):
        errors.append("缺少 anchors 数组")
    else:
        for i, anchor in enumerate(anchors):
            where = f"anchors[{i}]"
            if not isinstance(anchor, dict):
                errors.append(f"{where} 必须是对象")
                continue
            for key in ("id", "label"):
                value = anchor.get(key)
                if not isinstance(value, str) or not value:
                    errors.append(f"{where} 缺少 {key}，或不是非空字符串")
            for box_key, low, high in (("bbox_norm", 0, 1), ("bbox_mm", 0, None)):
                box = anchor.get(box_key)
                if not isinstance(box, dict):
                    errors.append(f"{where} 缺少 {box_key} 对象")
                    continue
                for key in ("x", "y", "w", "h"):
                    value = box.get(key)
                    if value is None:
                        errors.append(f"{where}.{box_key} 缺少 {key}")
                    elif not _is_number(value):
                        errors.append(f"{where}.{box_key}.{key} 必须是数字，实际为 {value!r}")
                    elif value < low or (high is not None and value > high):
                        errors.append(
                            f"{where}.{box_key}.{key} 必须在 [{low}, {high}] 内，实际为 {value!r}")
            element_ids = anchor.get("element_ids")
            if element_ids is not None:
                if not isinstance(element_ids, list):
                    errors.append(f"{where}.element_ids 必须是字符串数组")
                else:
                    for j, ref in enumerate(element_ids):
                        if not isinstance(ref, str) or ref not in ids:
                            errors.append(f"{where}.element_ids[{j}] {ref!r} 指向不存在的元素")

    # --- panels (optional flat index) ---------------------------------------
    panels = doc.get("panels")
    if panels is not None:
        if not isinstance(panels, list):
            errors.append("panels 必须是数组")
        else:
            for i, panel in enumerate(panels):
                if not isinstance(panel, dict):
                    errors.append(f"panels[{i}] 必须是对象")
                    continue
                if not isinstance(panel.get("id"), str) or not panel["id"]:
                    errors.append(f"panels[{i}] 缺少 id，或不是非空字符串")
                ref = panel.get("element_id")
                if not isinstance(ref, str) or ref not in ids:
                    errors.append(f"panels[{i}].element_id {ref!r} 指向不存在的元素")

    # --- meta ---------------------------------------------------------------
    meta = doc.get("meta")
    if not isinstance(meta, dict):
        errors.append("缺少 meta 对象")
    else:
        for key in ("created", "updated"):
            if key not in meta:
                errors.append(f"meta 缺少必填字段 {key}")
            elif not _is_iso_datetime(meta[key]):
                errors.append(f"meta.{key} 必须是 ISO 8601 时间字符串，实际为 {meta[key]!r}")

    # --- history (optional inside the doc; required at project top level) ---
    history = doc.get("history")
    if history is not None:
        if not isinstance(history, list):
            errors.append("history 必须是数组")
        else:
            for i, entry in enumerate(history):
                where = f"history[{i}]"
                if not isinstance(entry, dict):
                    errors.append(f"{where} 必须是对象")
                    continue
                rev = entry.get("rev")
                if not isinstance(rev, int) or isinstance(rev, bool):
                    errors.append(f"{where} 缺少 rev，或 rev 不是整数，实际为 {rev!r}")
                if not _is_iso_datetime(entry.get("ts")):
                    errors.append(f"{where}.ts 必须是 ISO 8601 时间字符串，实际为 {entry.get('ts')!r}")
                if not isinstance(entry.get("label"), str):
                    errors.append(f"{where}.label 必须是字符串，实际为 {entry.get('label')!r}")

    return errors


# ---------------------------------------------------------------------------
# doc files (plain FigureDocument JSON)
# ---------------------------------------------------------------------------

def load_doc(path) -> dict:
    """Load and validate a FigureDocument JSON file; raise on invalid content."""
    p = safe_path(path, must_exist=True, allowed_ext=(".json",))
    doc = _initialize_history_origin(_read_json(str(p)))
    errors = validate_doc(doc)
    if errors:
        raise ValueError("加载文档失败，结构校验未通过：\n- " + "\n- ".join(errors))
    return doc


def save_doc(doc, path) -> str:
    """Validate doc then write it as pretty UTF-8 JSON. Returns the path written."""
    stored = _initialize_history_origin(doc)
    errors = validate_doc(stored)
    if errors:
        raise ValueError("保存文档失败，结构校验未通过：\n- " + "\n- ".join(errors))
    p = safe_path(path, allowed_ext=(".json",))
    text = json.dumps(stored, ensure_ascii=False, indent=2) + "\n"
    return atomic_write(str(p), text)


# ---------------------------------------------------------------------------
# project files (*.figureproj.json)
# ---------------------------------------------------------------------------

def project_from_doc(doc, assets=None) -> dict:
    """Mirror of FigStore.projectFromDoc (shared/lib/storage.js).

    Returns {format, format_version, doc, history, assets}; history is moved
    from doc.history to the project top level and doc.history is emptied in
    the stored copy. Unlike the JS version this does NOT mutate the caller's
    doc (a deep copy is stored), so the on-disk structure is identical.
    """
    if not isinstance(doc, dict):
        raise ValueError("project_from_doc: doc 必须是文档对象")
    if assets is not None and not isinstance(assets, dict):
        raise ValueError("project_from_doc: assets 必须是对象")

    stored = _initialize_history_origin(copy.deepcopy(doc))
    history = stored.get("history")
    if not isinstance(history, list):
        history = []
    stored["history"] = []
    return {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "doc": stored,
        "history": history,
        "assets": {} if assets is None else assets,
    }


def doc_from_project(project) -> dict:
    """Mirror of FigStore.docFromProject: doc copy with the top-level history
    restored onto doc.history so undo/redo keeps working after reload."""
    if not isinstance(project, dict):
        raise ValueError("doc_from_project: project 必须是工程对象")
    stored = project.get("doc")
    if not isinstance(stored, dict):
        raise ValueError("doc_from_project: project.doc 必须是文档对象")
    doc = copy.deepcopy(stored)
    history = project.get("history")
    if isinstance(history, list):
        doc["history"] = copy.deepcopy(history)
    return _initialize_history_origin(doc)


def _migrate_project(project):
    """Check format/format_version and run the migration chain."""
    if not isinstance(project, dict):
        raise ValueError("不是有效的 figure-project 工程文件")
    if project.get("format") != FORMAT:
        raise ValueError(
            f"不是有效的 figure-project 工程文件（format={project.get('format')!r}，"
            f'应为 "{FORMAT}"）')
    version = project.get("format_version")
    if not isinstance(version, str) or not version:
        raise ValueError("工程文件缺少 format_version 字段")
    if version not in MIGRATIONS:
        raise ValueError(f"不支持的项目格式版本 \"{version}\"")
    return MIGRATIONS[version](project)


def save_project(doc, path, assets=None) -> str:
    """Validate doc and write a *.figureproj.json project file atomically.
    Returns the path written."""
    errors = validate_doc(doc)
    if errors:
        raise ValueError("保存工程失败，文档结构校验未通过：\n- " + "\n- ".join(errors))
    p = safe_path(path, allowed_ext=(PROJECT_EXT,))
    project = project_from_doc(doc, assets)
    text = json.dumps(project, ensure_ascii=False, indent=2) + "\n"
    return atomic_write(str(p), text)


def load_project(path) -> dict:
    """Load a *.figureproj.json project file. Returns
    {format, format_version, doc, history, assets} where doc carries the
    restored history (FigStore.docFromProject semantics)."""
    p = safe_path(path, must_exist=True, allowed_ext=(PROJECT_EXT,))
    project = _migrate_project(_read_json(str(p)))
    stored = project.get("doc")
    if not isinstance(stored, dict):
        raise ValueError("工程文件缺少 doc 字段")
    errors = validate_doc(stored)
    if errors:
        raise ValueError("工程文件内的 doc 校验未通过：\n- " + "\n- ".join(errors))
    history = project.get("history")
    if not isinstance(history, list):
        history = []
    assets = project.get("assets")
    if not isinstance(assets, dict):
        assets = {}
    return {
        "format": project.get("format"),
        "format_version": project.get("format_version"),
        "doc": doc_from_project(project),
        "history": copy.deepcopy(history),
        "assets": assets,
    }


__all__ = [
    "FORMAT",
    "FORMAT_VERSION",
    "MIGRATIONS",
    "PROJECT_EXT",
    "SCHEMA_VERSION",
    "ELEMENT_TYPES",
    "atomic_write",
    "capture_history_origin",
    "doc_from_project",
    "load_doc",
    "load_project",
    "project_from_doc",
    "safe_path",
    "save_doc",
    "save_project",
    "validate_doc",
]
