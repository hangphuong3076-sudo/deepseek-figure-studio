# -*- coding: utf-8 -*-
"""viewer.py — v3-agent-plugin 人工复核查看器 HTTP 服务（只服务本机 127.0.0.1）。

启动：
    python viewer.py --port 8770          # 默认端口 8770
    python mcp_server.py --viewer --port 8770
  mcp_server.py 的 figure_open_viewer 工具也会以 `python viewer.py --port N`
  拉起本服务，并探测 GET /api/health、POST /api/doc 推送文档。

接口（与 v2-server 的 REST 风格一致，全部返回 {"ok": ...}，错误为中文）：
  GET  /                 返回 viewer_static/index.html
  GET  /app/* /styles/*  viewer_static 下的静态文件
  GET  /lib/*            v3-agent-plugin/lib（shared/lib 逐字节副本，前端内核）
  GET  /shared/presets/* shared/presets 下的三个 JSON（供前端直接 fetch）
  GET  /api/health       {ok, viewer, version, has_doc}   （mcp_server 探测用）
  GET  /api/status       {ok, version, port, python, pillow, doc, presets, ...}
  GET  /api/presets      {ok, journals, templates, palettes}（shared/presets 原样）
  GET  /api/current      当前文档（含 history）：{ok, doc, save_token}；尚无文档时 404
  POST /api/current      {doc, base_token} 条件保存（docio.save_project / atomic_write）；
                         冲突返回 409 + save_conflict + 当前 save_token
  POST /api/export       {doc?, format: png|jpeg|tiff|pdf|svg, dpi?,
                         panel_id?, transparent=false} → 二进制
                         panel_id 可参照一个 type=panel 或 type=chart 元素；未知 id、
                         rect/group 等其他类型、重复 id 或不可见元素精确拒绝，不回退整图。
                         panel 裁剪含 padding；top 标签向上扩 0.6mm+字号，below 标签向下扩
                         1.2×字号。chart 以实际 transform 为 mm 范围修改 canonical SVG 根
                         width/height/viewBox，不改 doc/canvas/data 或几何；画幅外矢量可保留，
                         但最终 PNG/PDF 画幅不含另一 chart。文件名和 MCP px 使用裁后物理范围。
                         transparent=true 仅 PNG 合法，保留显式白色元素。
                         设置 canvas.background 的白色外观在非透明导出中不变。
                         （位图/PDF 由内核 SVG 经 py/figraster.py 转换）
  POST /api/import-spreadsheet {data_base64|content_base64,file_name,sheet?,header_row?}
                         仅限 loopback + application/json；真实解析 xlsx/xlsm/xls，返回
                         data/stats/recommended/sheets/notices/source_info；不写当前工程、
                         不调用模型，工作簿最大 20 MiB

  GET/POST /api/doc      GET 同样返回 save_token；POST 兼容显式整文档推送，
                         携带 base_token 时也执行条件保存
  GET  /api/ai/health    {ok, bridge, chatUrl}：FIGURE_LLM_BRIDGE 是否已注入
  POST /api/ai/chat      原样转发到本机 llm 桥；非 2xx 保持原状态码并规范化
                         错误体为 {"ok": false, "error": ...}（不伪装成 200）
  GET  /api/ai/progress?request_id=…
                         轻量进度查询：phase / 计数 / 简短 error（不含 prompt/key）。
                         合并本服务转发记录（bridge_forward/done/error）与模型桥内
                         真实模型阶段（model_pending→prepare→stream→complete/error）。

工作台右栏下半部分常驻 AI 面板，服务与画布工程共用同一本地服务与文档。

当前文档持久化在 projects/current.figureproj.json（*.figureproj.json 工程格式，
history 保存在工程顶层；读取时经 docio.load_project 还原到 doc.history）。

对外入口：serve(port) 供 mcp_server.py 同进程复用（import viewer 后调用）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import tempfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0"
DEFAULT_PORT = 8770

PLUGIN_DIR = Path(__file__).resolve().parent
STATIC_DIR = PLUGIN_DIR / "viewer_static"
LIB_DIR = PLUGIN_DIR / "lib"
PY_DIR = PLUGIN_DIR / "py"
# 预设目录：自包含优先（mcp/presets → 插件根 presets），最后回退共享目录。
_SHARED_PRESETS_CANDIDATES = [
    PLUGIN_DIR / "presets",
    PLUGIN_DIR.parent / "presets",
    PLUGIN_DIR.parent / "shared" / "presets",
]
SHARED_PRESETS_DIR = next(
    (p for p in _SHARED_PRESETS_CANDIDATES if (p / "journals.json").is_file()),
    _SHARED_PRESETS_CANDIDATES[-1],
)
PRESET_FILES = ("journals.json", "templates.json", "palettes.json")

sys.path.insert(0, str(PY_DIR))

try:
    import figpaths as FIGPATHS  # noqa: E402  (py/figpaths.py，R08 用户数据目录)
except Exception as _exc:  # pragma: no cover
    FIGPATHS = None
    _FIGPATHS_IMPORT_ERROR = _exc

try:
    import docio as DOCIO  # noqa: E402  (py/docio.py，shared/py 语义)
except Exception as _exc:  # pragma: no cover — docio 缺失时给出中文提示
    DOCIO = None
    _DOCIO_IMPORT_ERROR = _exc

try:
    import figraster as FIGRASTER  # noqa: E402  (py/figraster.py，位图/PDF 导出)
except Exception as _exc:  # pragma: no cover
    FIGRASTER = None
    _FIGRASTER_IMPORT_ERROR = _exc

# R08：用户工程与插件代码分离。数据目录解析唯一来源是 py/figpaths.py：
# 显式 FIGURE_DATA_DIR 环境变量优先，否则平台用户数据目录。旧
# mcp/projects 仅探测待迁移清单（启动提示 + /api/data-dirs），不自动迁移。
if FIGPATHS is not None:
    PROJECT_DIR = FIGPATHS.project_dir()
else:  # pragma: no cover — figpaths 缺失时回退旧行为并提示
    PROJECT_DIR = PLUGIN_DIR / "projects"
CURRENT_PROJECT_PATH = PROJECT_DIR / "current.figureproj.json"

# R03 教学示例目录（examples/teaching；只经 /teaching/*.json 白名单提供）
TEACHING_DIR = PLUGIN_DIR.parent / "examples" / "teaching"

from server import MAX_SPREADSHEET_BYTES, BridgeCallError, ToolError, \
    _export_filename, _render_svg, _spreadsheet_preview, \
    _svg_physical_dimensions, _validate_export_panel  # noqa: E402

MAX_SPREADSHEET_JSON_BYTES = 4 * ((MAX_SPREADSHEET_BYTES + 2) // 3) + 65536


class RequestTooLarge(ValueError):
    pass


EXPORT_CONTENT_TYPES = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "tiff": "image/tiff",
    "pdf": "application/pdf",
    "svg": "image/svg+xml; charset=utf-8",
}

# /api/ai/chat 转发本机 llm 桥的超时；内核前端默认 60s 自行中止，取 90s 留余量。
AI_CHAT_TIMEOUT_SECONDS = 90
# /api/ai/progress 反查模型桥进度的超时（轻量状态查询，必须快速返回）。
AI_PROGRESS_TIMEOUT_SECONDS = 2
# 进度任务表上限：只保留最近有限条（FIFO 淘汰），避免长会话无界增长。
AI_PROGRESS_MAX_TASKS = 64

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".md": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
}

_STATE_LOCK = threading.Lock()
_STATE = {"doc": None, "project_path": None}

SERVER_PORT = {"value": DEFAULT_PORT}

# ---------------------------------------------------------------------------
# AI 模型请求进度表（真实阶段，绝不伪造百分比）
#
# 记录字段只有：phase / detail / deltas / chars / error / 时间戳 / request_id。
# 绝不保存 prompt、messages、API key 或任何请求内容——前端凭 request_id 轮询
# GET /api/ai/progress 时只能看到阶段与简短原因。
#
# 阶段来源（按 updated_at 合并，取最新者为准）：
#   bridge_forward  本服务已把 /api/ai/chat 请求转发给模型桥
#   bridge_done     模型桥已返回（HTTP 层完成）
#   bridge_error    转发失败（桥不可达 / 超时 / 桥返回错误，原因原样记录）
#   model_*         桥内记录的真实模型阶段（model_pending / model_prepare /
#                   model_stream / model_complete / model_error），由
#                   GET /progress 反查获得；无桥或桥不支持时只用本表。
# ---------------------------------------------------------------------------
_PROGRESS_LOCK = threading.Lock()
_PROGRESS = {}


def _progress_touch(request_id, phase, detail="", error=None, **fields):
    if not request_id:
        return
    now = _now_iso()
    task = {
        "request_id": request_id,
        "phase": phase,
        "detail": detail or "",
        "deltas": 0,
        "chars": 0,
        "error": error or None,
        "updated_at": now,
    }
    with _PROGRESS_LOCK:
        prev = _PROGRESS.get(request_id)
        if prev:
            task.update({k: v for k, v in prev.items() if k not in task})
            task["deltas"] = prev.get("deltas", 0)
            task["chars"] = prev.get("chars", 0)
            task["started_at"] = prev.get("started_at", now)
        task["started_at"] = task.get("started_at", now)
        for k, v in fields.items():
            if v is not None:
                task[k] = v
        task["updated_at"] = now
        _PROGRESS.pop(request_id, None)
        _PROGRESS[request_id] = task
        while len(_PROGRESS) > AI_PROGRESS_MAX_TASKS:
            _PROGRESS.pop(next(iter(_PROGRESS)), None)


def _progress_local(request_id):
    with _PROGRESS_LOCK:
        task = _PROGRESS.get(request_id)
        return json.loads(json.dumps(task, ensure_ascii=False)) if task else None


def _progress_from_bridge(request_id):
    """反查模型桥 GET /progress（index.js llm 桥）；失败返回 (None, 原因)。"""
    bridge = os.environ.get("FIGURE_LLM_BRIDGE", "").strip()
    if not bridge:
        return None, None
    try:
        url = bridge.rstrip("/") + "/progress?request_id=" + urllib.parse.quote(request_id)
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=AI_PROGRESS_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if isinstance(data, dict) and data.get("ok") and isinstance(data.get("task"), dict):
            return data["task"], None
        reason = None
        if isinstance(data, dict):
            reason = data.get("error")
        return None, (reason if isinstance(reason, str) and reason.strip() else None)
    except Exception as exc:  # noqa: BLE001 — 桥不可达时给出真实原因
        return None, "模型桥进度查询失败：%s" % exc


def _progress_merged(request_id):
    """合并本表与模型桥记录：按 updated_at 取最新，保留 started_at 与桥的失败原因。"""
    local = _progress_local(request_id)
    remote, remote_err = _progress_from_bridge(request_id)
    if local is None and remote is None:
        if remote_err:
            return {"phase": "unknown", "detail": "", "error": remote_err}
        return None
    if remote is None:
        return local
    if local is None:
        return remote
    merged = dict(local)
    merged["started_at"] = min(local.get("started_at") or "", remote.get("started_at") or "") or \
        local.get("started_at")
    if (remote.get("updated_at") or "") >= (local.get("updated_at") or ""):
        merged.update({k: v for k, v in remote.items() if k != "started_at"})
    if not merged.get("error") and local.get("error"):
        merged["error"] = local["error"]
    return merged


# ---------------------------------------------------------------------------
# 当前文档的读取 / 落盘
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_current_from_disk():
    """启动时从 projects/current.figureproj.json 恢复当前文档（如有）。"""
    if DOCIO is None or not CURRENT_PROJECT_PATH.is_file():
        return None
    loaded = DOCIO.load_project(str(CURRENT_PROJECT_PATH))
    doc = loaded.get("doc")
    return doc if isinstance(doc, dict) else None


def _get_current_doc():
    with _STATE_LOCK:
        return _STATE["doc"]


def _validate_or_raise(doc):
    """docio.validate_doc 校验，失败抛 ValueError（中文错误列表拼接）。"""
    if DOCIO is None:
        raise RuntimeError(
            "py/docio.py 不可用（%s），无法校验/保存文档" % _DOCIO_IMPORT_ERROR)
    errors = DOCIO.validate_doc(doc)
    if errors:
        raise ValueError("文档结构校验未通过：\n- " + "\n- ".join(errors))


_EXPLICIT_REPLACE = object()
_TOKEN_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class SaveConflict(Exception):
    """条件保存的 base_token 与锁内当前文档不一致。"""

    def __init__(self, save_token):
        super().__init__("文档已被其他窗口或请求更新，请重新加载后再保存")
        self.save_token = save_token


def _save_token(doc):
    if doc is None:
        return None
    canonical = json.dumps(
        doc, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _validate_base_token(base_token):
    if base_token is not None and (
            not isinstance(base_token, str) or not _TOKEN_PATTERN.fullmatch(base_token)):
        raise ValueError("base_token 必须是 null 或 GET 文档时返回的 save_token")


def _save_current(doc, base_token=_EXPLICIT_REPLACE):
    """校验、按条件比较并原子落盘，在锁内最后发布本次文档。"""
    _validate_or_raise(doc)
    if base_token is not _EXPLICIT_REPLACE:
        _validate_base_token(base_token)
    save_token = _save_token(doc)
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    with _STATE_LOCK:
        if base_token is not _EXPLICIT_REPLACE:
            current_token = _save_token(_STATE["doc"])
            if base_token != current_token:
                raise SaveConflict(current_token)
        path = DOCIO.save_project(doc, str(CURRENT_PROJECT_PATH))
        _STATE["doc"] = doc
        _STATE["project_path"] = path
    return path, save_token


def _doc_summary(doc):
    canvas = doc.get("canvas") or {}
    return {
        "id": doc.get("id"),
        "title": doc.get("title"),
        "width_mm": canvas.get("width_mm"),
        "height_mm": canvas.get("height_mm"),
        "dpi": canvas.get("dpi"),
        "elements": len(doc.get("elements") or []),
        "anchors": len(doc.get("anchors") or []),
        "history": len(doc.get("history") or []),
        "updated": (doc.get("meta") or {}).get("updated"),
    }


def _preset_counts():
    """Preset entry counts: drill into the inner list of
    the {version, disclaimer, fields, presets|templates|palettes} wrappers."""
    counts = {}
    for name in PRESET_FILES:
        key = name.removesuffix(".json")
        counts[key] = None
        p = SHARED_PRESETS_DIR / name
        if p.is_file():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                # journals.json wraps its list under "presets"; the other two
                # use the file's own name as the payload key.
                payload_key = "presets" if key == "journals" else key
                payload = data.get(payload_key) if isinstance(data, dict) else data
                if isinstance(payload, list):
                    counts[key] = len(payload)
                elif isinstance(data, list):
                    counts[key] = len(data)
            except Exception:
                counts[key] = None
    return counts


def _pillow_version():
    try:
        import PIL
        return PIL.__version__
    except Exception:
        return None


# ---------------------------------------------------------------------------
# HTTP 处理器
# ---------------------------------------------------------------------------

class ViewerHandler(BaseHTTPRequestHandler):
    server_version = "FigViewer/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静默：避免污染 MCP stdio 日志
        pass

    # ---- 基础发送工具 -----------------------------------------------------

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, data, ctype, filename=None, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            try:
                filename.encode("ascii")
                ascii_name = filename
            except UnicodeEncodeError:
                ascii_name = "figure." + filename.rsplit(".", 1)[-1]
            self.send_header(
                "Content-Disposition",
                "attachment; filename=\"%s\"; filename*=UTF-8''%s"
                % (ascii_name, urllib.parse.quote(filename)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: Path, as_attachment=False, filename=None):
        data = path.read_bytes()
        ctype = MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")
        if as_attachment:
            self._send_bytes(data, ctype, filename or path.name)
        else:
            self._send_bytes(data, ctype)

    def _read_body(self, max_bytes=None) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise ValueError("Content-Length 必须是非负整数") from exc
        if length < 0:
            raise ValueError("Content-Length 必须是非负整数")
        if max_bytes is not None and length > max_bytes:
            self.close_connection = True
            raise RequestTooLarge("JSON 请求体不得超过 %d 字节" % max_bytes)
        if length == 0:
            return b""
        return self.rfile.read(length)

    def _read_json_body(self, max_bytes=None):
        raw = self._read_body(max_bytes=max_bytes)
        if not raw:
            raise ValueError("请求体为空")
        try:
            return json.loads(raw.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise ValueError("请求体不是 UTF-8 编码：%s" % exc) from exc
        except json.JSONDecodeError as exc:
            raise ValueError("请求体不是有效 JSON：%s" % exc) from exc

    # ---- 静态文件 ----------------------------------------------------------

    @staticmethod
    def _resolve_under(rel_url: str, base: Path):
        """把 URL 路径解析到 base 目录内的已存在文件；越界或不存在返回 None。"""
        rel = urllib.parse.unquote(rel_url).lstrip("/")
        if not rel:
            return None
        target = (base / rel).resolve()
        try:
            target.relative_to(base.resolve())
        except ValueError:
            return None
        return target if target.is_file() else None

    def _serve_static(self, path: str) -> bool:
        if path in ("/", "/index.html"):
            index = STATIC_DIR / "index.html"
            if index.is_file():
                self._send_file(index)
                return True
            self._send_json({"ok": False, "error": "未找到 viewer_static/index.html"},
                            404)
            return True
        target = None
        if path.startswith("/lib/"):
            # viewer_static 没有内核副本；/lib/* 映射到 v3-agent-plugin/lib
            # （shared/lib 的逐字节副本，只读服务，不写回）。
            target = self._resolve_under(path[len("/lib/"):], LIB_DIR)
        elif path.startswith("/teaching/"):
            # R03 教学示例：只服务插件 examples/teaching 下的 .json
            # （index.json 与 *.figureproj.json），无目录列举、无其他扩展名。
            rel = path[len("/teaching/"):]
            if rel.lower().endswith(".json"):
                target = self._resolve_under(rel, TEACHING_DIR)
        elif path.startswith("/shared/presets/"):
            if not path.lower().endswith(".json"):
                target = None
            else:
                target = self._resolve_under(path[len("/shared/presets/"):],
                                             SHARED_PRESETS_DIR)
        else:
            # 其余路径（/app/*、/styles/* 等）限定在 viewer_static 内。
            target = self._resolve_under(path, STATIC_DIR)
        if target is None:
            return False
        self._send_file(target)
        return True

    # ---- GET ---------------------------------------------------------------

    def do_GET(self):
        try:
            path = urllib.parse.urlparse(self.path).path
            if path.startswith("/api/"):
                self._route_api_get(path)
                return
            if not self._serve_static(path):
                self._send_json({"ok": False, "error": "未找到资源：%s" % path}, 404)
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001 — 任何异常都转为 500 JSON
            self._safe_json({"ok": False, "error": "服务内部错误：%s" % exc}, 500)

    def _route_api_get(self, path: str):
        if path == "/api/health":
            doc = _get_current_doc()
            self._send_json({
                "ok": True, "viewer": True, "version": VERSION,
                "has_doc": doc is not None,
            })
        elif path == "/api/status":
            doc = _get_current_doc()
            self._send_json({
                "ok": True,
                "viewer": "v3-agent-plugin",
                "version": VERSION,
                "port": SERVER_PORT["value"],
                "host": "127.0.0.1",
                "python": sys.version.split()[0],
                "pillow": _pillow_version(),
                "docio_available": DOCIO is not None,
                "figraster_available": FIGRASTER is not None,
                "has_doc": doc is not None,
                "doc": _doc_summary(doc) if doc else None,
                "project_path": str(CURRENT_PROJECT_PATH),
                "project_exists": CURRENT_PROJECT_PATH.is_file(),
                "data_dirs": FIGPATHS.status() if FIGPATHS is not None else None,
                "presets": _preset_counts(),
                "static_dir": str(STATIC_DIR),
                "lib_dir": str(LIB_DIR),
            })
        elif path in ("/api/current", "/api/doc"):
            doc = _get_current_doc()
            if doc is None:
                self._send_json({
                    "ok": False,
                    "error": "暂无文档：服务端尚未收到任何文档，"
                             "请通过 figure_open_viewer 传入 doc，"
                             "或在前端编辑后自动回写。",
                }, 404)
            else:
                self._send_json({
                    "ok": True, "doc": doc, "save_token": _save_token(doc),
                })
        elif path == "/api/ai/health":
            bridge = os.environ.get("FIGURE_LLM_BRIDGE", "").strip()
            self._send_json({
                "ok": True,
                "bridge": bool(bridge),
                "chatUrl": "/api/ai/chat",
            })
        elif path == "/api/ai/progress":
            self._handle_ai_progress()
        elif path == "/api/presets":
            self._handle_presets()
        elif path == "/api/data-dirs":
            self._handle_data_dirs()
        else:
            self._send_json({"ok": False, "error": "未知 API 路径：%s" % path}, 404)

    def _handle_presets(self):
        out = {}
        missing = []
        for name in PRESET_FILES:
            p = SHARED_PRESETS_DIR / name
            if not p.is_file():
                missing.append(name)
                continue
            out[name.removesuffix(".json")] = json.loads(
                p.read_text(encoding="utf-8"))
        if missing:
            self._send_json({
                "ok": False,
                "error": "shared/presets 缺少文件：%s（预期目录 %s）"
                         % ("、".join(missing), SHARED_PRESETS_DIR),
            }, 500)
            return
        self._send_json({"ok": True, **out})

    def _handle_data_dirs(self):
        """R08：数据目录与旧工程迁移状态（只读探测，不迁移）。"""
        if FIGPATHS is None:
            self._send_json({
                "ok": False,
                "error": "py/figpaths.py 不可用（%s）" % _FIGPATHS_IMPORT_ERROR,
            }, 500)
            return
        self._send_json({"ok": True, **FIGPATHS.status()})

    def _handle_projects_migrate(self, body):
        """R08：显式复制迁移旧 mcp/projects 工程到用户数据目录。

        请求体：{"overwrite": bool}（默认 false：目标冲突时跳过并返回
        conflicts 清单，不覆盖、不合并；原文件始终保留）。
        """
        if FIGPATHS is None:
            self._send_json({
                "ok": False,
                "error": "py/figpaths.py 不可用（%s）" % _FIGPATHS_IMPORT_ERROR,
            }, 500)
            return
        if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            self.close_connection = True
            self._send_json({"ok": False, "error": "工程迁移仅允许本机 loopback 请求"}, 403)
            return
        if not isinstance(body, dict):
            raise ValueError("迁移请求体必须是 JSON 对象")
        overwrite = body.get("overwrite") is True
        result = FIGPATHS.migrate_legacy(docio=DOCIO, overwrite=overwrite)
        migrated_current = any(
            e.get("name") == FIGPATHS.CURRENT_PROJECT_NAME
            for e in result.get("copied", [])
        )
        if migrated_current:
            restored = _load_current_from_disk()
            if restored is not None:
                with _STATE_LOCK:
                    if _STATE["doc"] is None:
                        _STATE["doc"] = restored
        self._send_json({
            "ok": True,
            "overwrite": overwrite,
            "copied": len(result["copied"]),
            "skipped_identical": len(result["skipped_identical"]),
            "conflicts": result["conflicts"],
            "invalid": result["invalid"],
            "plan": result["plan"],
        })

    # ---- POST --------------------------------------------------------------

    def do_POST(self):
        try:
            path = urllib.parse.urlparse(self.path).path
            # /api/ai/chat 原样透传 body 到本机 llm 桥（无需按文档 JSON 解析）
            if path == "/api/ai/chat":
                self._handle_ai_chat()
                return
            if path == "/api/import-spreadsheet":
                self._handle_import_spreadsheet()
                return
            body = self._read_json_body()
            if path in ("/api/current", "/api/doc"):
                self._handle_save(body, path)
            elif path == "/api/export":
                self._handle_export(body)
            elif path == "/api/projects/migrate":
                self._handle_projects_migrate(body)
            else:
                self._send_json(
                    {"ok": False, "error": "不支持的 POST 路径：%s" % path}, 404)
        except RequestTooLarge as exc:
            self._safe_json({"ok": False, "error": str(exc)}, 413)
        except SaveConflict as exc:
            self._safe_json({
                "ok": False,
                "error": str(exc),
                "save_conflict": True,
                "save_token": exc.save_token,
            }, 409)
        except (ValueError, ToolError, BridgeCallError) as exc:
            self._safe_json({"ok": False, "error": str(exc)}, 400)
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001
            self._safe_json({"ok": False, "error": "服务内部错误：%s" % exc}, 500)

    @staticmethod
    def _extract_doc(body):
        """请求体兼容两种形态：{doc: {...}}（mcp_server 推送形态）或裸 doc 对象。"""
        if isinstance(body, dict) and isinstance(body.get("doc"), dict):
            return body["doc"]
        if isinstance(body, dict) and "canvas" in body:
            return body
        return None

    def _handle_import_spreadsheet(self):
        if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            self.close_connection = True
            self._send_json({"ok": False, "error": "Excel 导入仅允许本机 loopback 请求"}, 403)
            return
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise ValueError("Excel 导入 Content-Type 必须是 application/json")
        body = self._read_json_body(max_bytes=MAX_SPREADSHEET_JSON_BYTES)
        if not isinstance(body, dict):
            raise ValueError("Excel 导入请求体必须是 JSON 对象")
        allowed = {"file_name", "data_base64", "content_base64", "sheet", "header_row"}
        unknown = sorted(set(body) - allowed)
        if unknown:
            raise ValueError("Excel 导入包含不支持的字段：%s" % "、".join(unknown))
        if (body.get("data_base64") is not None and body.get("content_base64") is not None
                and body.get("data_base64") != body.get("content_base64")):
            raise ValueError("data_base64 与 content_base64 不能指向不同内容")
        result = _spreadsheet_preview(
            data_base64=body.get("data_base64") if body.get("data_base64") is not None
            else body.get("content_base64"),
            file_name=body.get("file_name"),
            sheet=body.get("sheet"), header_row=body.get("header_row"))
        self._send_json(result)

    def _handle_save(self, body, path):
        doc = self._extract_doc(body)
        if doc is None:
            self._send_json({
                "ok": False,
                "error": "请求体必须是文档对象或 {\"doc\": 文档对象}",
            }, 400)
            return
        wrapped = isinstance(body, dict) and isinstance(body.get("doc"), dict)
        conditional = wrapped and "base_token" in body
        if path == "/api/current" and not conditional:
            self._send_json({
                "ok": False,
                "error": "工作台保存必须使用 {\"doc\": 文档对象, \"base_token\": ...}；"
                         "空文档初次保存的 base_token 为 null",
            }, 400)
            return
        base_token = body.get("base_token") if conditional else _EXPLICIT_REPLACE
        saved_path, save_token = _save_current(doc, base_token)
        self._send_json({
            "ok": True,
            "doc": doc,
            "path": saved_path,
            "save_token": save_token,
            "saved_at": _now_iso(),
            "summary": _doc_summary(doc),
        })

    def _handle_export(self, body):
        if not isinstance(body, dict):
            raise ValueError("请求体必须是 JSON 对象")
        fmt_raw = body.get("format")
        fmt = str(fmt_raw or "").strip().lower()
        if fmt == "jpg":
            fmt = "jpeg"
        if fmt not in EXPORT_CONTENT_TYPES:
            raise ValueError(
                "不支持的导出格式 %r（支持 png / jpeg / tiff / pdf / svg）" % fmt_raw)

        doc = self._extract_doc(body)
        if doc is None:
            doc = _get_current_doc()
        if doc is None:
            raise ValueError(
                "请求体缺少 doc，且服务端暂无当前文档（请先 POST /api/current）")
        _validate_or_raise(doc)
        panel_id = _validate_export_panel(doc, body.get("panel_id"))
        transparent = body.get("transparent", False)
        if not isinstance(transparent, bool):
            raise ValueError("transparent 必须是布尔值")
        if transparent and fmt != "png":
            raise ValueError("transparent=true 仅支持 PNG，其他格式必须显式拒绝")
        if fmt != "svg" and FIGRASTER is None:
            self._send_json({
                "ok": False,
                "error": "py/figraster.py 不可用（%s），无法导出位图/PDF"
                         % _FIGRASTER_IMPORT_ERROR,
            }, 500)
            return

        canvas = doc.get("canvas") or {}
        dpi_raw = body.get("dpi")
        if dpi_raw in (None, ""):
            dpi_raw = canvas.get("dpi") or 300
        try:
            dpi = float(dpi_raw)
        except (TypeError, ValueError):
            raise ValueError("dpi 必须是数字，实际为 %r" % dpi_raw)
        if not math.isfinite(dpi) or dpi <= 0:
            raise ValueError("dpi 必须是有限正数，实际为 %r" % dpi_raw)

        svg = _render_svg(doc, panel_id=panel_id)
        size_mm = _svg_physical_dimensions(svg)
        if fmt == "svg":
            data = svg.encode("utf-8")
        else:
            with tempfile.TemporaryDirectory(prefix="figviewer_export_") as td:
                out = Path(td) / ("figure." + ("jpg" if fmt == "jpeg" else fmt))
                FIGRASTER.export_svg(
                    svg, doc, str(out), fmt, dpi=dpi,
                    panel_id=panel_id, transparent=transparent)
                data = out.read_bytes()

        filename = _suggest_filename(doc, fmt, dpi, size_mm, panel_id)
        self._send_bytes(data, EXPORT_CONTENT_TYPES[fmt], filename)

    def _handle_ai_progress(self):
        """GET /api/ai/progress?request_id=… —— 轻量进度查询。

        只返回 phase / task id / 阶段计数（deltas、chars）/ 简短 error，
        绝不返回 prompt、messages 或 key。同时合并 viewer.py 自身的转发记录
        与模型桥内（index.js GET /progress）的真实模型阶段。
        """
        q = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(q)
        request_id = (params.get("request_id") or [""])[0].strip()
        if not request_id:
            self._send_json({"ok": False, "error": "缺少 request_id 参数"}, 400)
            return
        task = _progress_merged(request_id)
        if task is None:
            self._send_json({
                "ok": False,
                "request_id": request_id,
                "error": "未找到该 request_id 的进度记录（可能已过期，或请求未携带 request_id）",
            })
            return
        self._send_json({"ok": True, "request_id": request_id, "task": task})

    @staticmethod
    def _extract_request_id(raw: bytes):
        """从 /api/ai/chat 请求体里取出 request_id（只读这一个字段，不记录其余内容）。"""
        try:
            obj = json.loads(raw.decode("utf-8")) if raw else None
        except Exception:  # noqa: BLE001 — 非 JSON 请求体也原样转发
            return None
        if isinstance(obj, dict):
            rid = obj.get("request_id")
            if isinstance(rid, str) and rid.strip():
                return rid.strip()[:128]
        return None

    def _handle_ai_chat(self):
        """把窗口右栏 AI 面板的 /chat 请求转发到本机 llm 桥（DSH ctx.llm）。

        桥地址来自环境变量 FIGURE_LLM_BRIDGE（由 Host 插件 spawn 本服务时注入）。
        无桥时返回 502；桥返回非 2xx 时保持原 HTTP 状态码透传（不偷偷改 200），
        并把错误体规范化为 {"ok": false, "error": ...}，前端据此如实显示
        「DSH 桥未连接 / 模型请求失败」而不是静默当离线。
        """
        bridge = os.environ.get("FIGURE_LLM_BRIDGE", "").strip()
        raw = self._read_body()
        request_id = self._extract_request_id(raw)
        target = bridge.rstrip("/") + "/chat"
        if not bridge:
            if request_id:
                _progress_touch(
                    request_id, "bridge_error", "",
                    error="未配置模型桥（FIGURE_LLM_BRIDGE），未发起模型请求")
            self._send_json({
                "ok": False,
                "error": "未配置模型桥（FIGURE_LLM_BRIDGE）。"
                         "由 DSH 插件启动时会自动复用其 DeepSeek；"
                         "独立启动窗口请在“设置”里填写 API Key。",
            }, 502)
            return
        if request_id:
            _progress_touch(request_id, "bridge_forward", "已转发到模型桥，等待模型响应")
        try:
            req = urllib.request.Request(
                target, data=raw,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=AI_CHAT_TIMEOUT_SECONDS) as resp:
                out = resp.read()
                status = resp.status
            # 2xx 原样透传；非 2xx 规范化错误体后仍以原状态码返回。
            if status < 200 or status >= 300:
                if request_id:
                    norm = json.loads(self._normalize_bridge_error(status, out).decode("utf-8"))
                    _progress_touch(request_id, "bridge_error", "",
                                    error=norm.get("error") or ("HTTP %d" % status))
                self._send_bytes(self._normalize_bridge_error(status, out),
                                 "application/json; charset=utf-8", status=status)
            else:
                if request_id:
                    _progress_touch(request_id, "bridge_done", "模型桥返回完成")
                self._send_bytes(out, "application/json; charset=utf-8", status=status)
        except urllib.error.HTTPError as exc:
            err_body = exc.read()
            if request_id:
                norm = json.loads(self._normalize_bridge_error(exc.code, err_body).decode("utf-8"))
                _progress_touch(request_id, "bridge_error", "",
                                error=norm.get("error") or ("HTTP %d" % exc.code))
            self._send_bytes(self._normalize_bridge_error(exc.code, err_body),
                             "application/json; charset=utf-8", status=exc.code)
        except urllib.error.URLError as exc:
            if self._is_timeout_reason(exc.reason):
                if request_id:
                    _progress_touch(request_id, "bridge_error", "",
                                    error="模型桥请求超时（%d 秒无响应）" % AI_CHAT_TIMEOUT_SECONDS)
                self._send_json({
                    "ok": False,
                    "error": "模型桥请求超时（%d 秒无响应）：%s"
                             % (AI_CHAT_TIMEOUT_SECONDS, exc.reason or exc),
                }, 504)
            else:
                if request_id:
                    _progress_touch(request_id, "bridge_error", "",
                                    error="模型桥不可达：%s" % (exc.reason or exc))
                self._send_json({
                    "ok": False,
                    "error": "模型桥不可达：%s" % (exc.reason or exc),
                }, 502)
        except (socket.timeout, TimeoutError):
            if request_id:
                _progress_touch(request_id, "bridge_error", "",
                                error="模型桥请求超时（%d 秒无响应）" % AI_CHAT_TIMEOUT_SECONDS)
            self._send_json({
                "ok": False,
                "error": "模型桥请求超时（%d 秒无响应）" % AI_CHAT_TIMEOUT_SECONDS,
            }, 504)
        except Exception as exc:  # noqa: BLE001
            if request_id:
                _progress_touch(request_id, "bridge_error", "",
                                error="模型桥请求失败：%s" % exc)
            self._send_json({
                "ok": False,
                "error": "模型桥请求失败：%s" % exc,
            }, 502)

    @staticmethod
    def _is_timeout_reason(reason) -> bool:
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return True
        return "timed out" in str(reason or "").lower()

    def _normalize_bridge_error(self, status: int, raw: bytes) -> bytes:
        """把桥的非 2xx 响应规范化为 {"ok": false, "error": ...}（保持原状态码）。

        桥的错误体可能是 {"error": ...} JSON，也可能是 HTML/纯文本；
        前端内核只按 OpenAI 形状解析，规范化后用户才能看到真实失败原因。
        """
        text = raw.decode("utf-8", errors="replace").strip() if raw else ""
        err_msg = None
        if text:
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    candidate = parsed.get("error") or parsed.get("message")
                    if isinstance(candidate, str) and candidate.strip():
                        err_msg = candidate.strip()
            except json.JSONDecodeError:
                err_msg = None
        if err_msg is None:
            snippet = " ".join(text.split())[:200]
            err_msg = "模型桥返回错误（HTTP %d）：%s" % (status, snippet or "（空响应）")
        return json.dumps({"ok": False, "error": err_msg},
                          ensure_ascii=False).encode("utf-8")

    def _safe_json(self, obj, status):
        """错误兜底：若响应头尚未发出则回 JSON，否则放弃（连接将被关闭）。"""
        try:
            self._send_json(obj, status)
        except Exception:  # noqa: BLE001
            pass


def _suggest_filename(doc, fmt, dpi, size_mm=None, panel_id=None) -> str:
    """Filename mirrors server.py, including the true scope and overridden DPI."""
    ext = "jpg" if fmt == "jpeg" else fmt
    return _export_filename(doc, ext, dpi, size_mm, panel_id)


# ---------------------------------------------------------------------------
# 服务入口
# ---------------------------------------------------------------------------

def _load_initial_state():
    try:
        doc = _load_current_from_disk()
    except Exception as exc:  # noqa: BLE001 — 启动容错：损坏的工程文件不阻止启动
        print("[v3 viewer] 警告：读取 %s 失败：%s" % (CURRENT_PROJECT_PATH, exc),
              file=sys.stderr)
        doc = None
    with _STATE_LOCK:
        _STATE["doc"] = doc
        _STATE["project_path"] = str(CURRENT_PROJECT_PATH)


def serve(port=DEFAULT_PORT, host="127.0.0.1"):
    """启动查看器服务并阻塞运行。

    mcp_server.py 的 --viewer 模式会在守护线程里 import viewer 后调用
    serve(port)，因此本函数必须是阻塞式入口且不在 import 时绑定端口。
    """
    port = int(port)
    SERVER_PORT["value"] = port
    _load_initial_state()
    httpd = ThreadingHTTPServer((host, port), ViewerHandler)
    print("[v3 viewer] 服务已启动：http://%s:%d/  （当前文档：%s）"
          % (host, port,
             "已有" if _get_current_doc() is not None else "暂无，工程文件 " +
             str(CURRENT_PROJECT_PATH)), flush=True)
    # R08：旧插件内工程目录只探测提示，迁移由用户显式发起（UI/HTTP 均可）。
    try:
        if FIGPATHS is not None:
            status = FIGPATHS.status()
            pending = status.get("legacy_pending_migration") or []
            if pending:
                print("[v3 viewer] 检测到旧目录 %s 有 %d 个工程未迁移到 %s；"
                      "保留原文件，可在工作台「历史」页或 POST /api/projects/migrate "
                      "显式复制迁移（不覆盖冲突）。"
                      % (status["legacy_project_dir"], len(pending),
                         status["data_dir"]), flush=True)
    except Exception as exc:  # noqa: BLE001 — 提示失败不阻断启动
        print("[v3 viewer] 旧工程目录探测失败：%s" % exc, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="v3-agent-plugin 人工复核查看器（只服务本机 127.0.0.1）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="监听端口（默认 %d）" % DEFAULT_PORT)
    args = parser.parse_args(argv)
    serve(args.port)


if __name__ == "__main__":
    main()
