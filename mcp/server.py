# -*- coding: utf-8 -*-
"""mcp_server.py — v3-agent-plugin 的 MCP stdio 服务。

协议：stdio 逐行 JSON-RPC 2.0（MCP 兼容）。
  - initialize      -> protocolVersion / capabilities.tools / serverInfo
  - tools/list      -> 由 tools_spec.py（单一来源）生成
  - tools/call      -> 按工具名分发，返回 content:[{type:"text",text:"<JSON>"}]，顶层含 ok
  - 错误码：-32700 解析错误 / -32601 未知方法 / -32602 参数错误 / -32603 内部错误
  - 通知（无 id 的消息）一律不回包。

职责三分法（PLUGIN-API.md）：
  1) 图形语义 -> Node 桥 bridge.js（shared/lib 内核，白名单 fn）
  2) 网络调用 -> Python urllib 直连 DeepSeek（key 不进 Node、不写日志）
  3) 文件/导出 -> py/docio.py + 内核 SVG 经 py/figraster.py 统一转换

健壮性约定：
  - 任何工具异常都转成 ok:false + 中文 error，绝不抛出未捕获异常导致进程退出。
  - bridge.js 子进程崩溃自动重启一次，第二次失败返回可读中文排查提示。
"""

import argparse
import base64
import collections
import hashlib
import json
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent

# 自包含预设目录解析（插件副本补丁，原版只有最后一级回退）：
#   1) 本目录 presets/          —— MCP 独立安装形态（presets 与 server.py 同目录）
#   2) 上一级 presets/          —— bundle 完整插件包形态（presets 在插件根）
#   3) ../shared/presets        —— 与框架仓库同置时的原始布局（兼容回退）
_PRESETS_CANDIDATES = (
    PLUGIN_DIR / "presets",
    PLUGIN_DIR.parent / "presets",
    PLUGIN_DIR.parent / "shared" / "presets",
)
SHARED_PRESETS_DIR = next(
    (d for d in _PRESETS_CANDIDATES if d.is_dir()),
    PLUGIN_DIR.parent / "shared" / "presets",
)
PY_DIR = PLUGIN_DIR / "py"

sys.path.insert(0, str(PLUGIN_DIR))
sys.path.insert(0, str(PY_DIR))

import tools_spec  # noqa: E402  (工具清单单一来源)

# ---------------------------------------------------------------------------
# 全局状态
# ---------------------------------------------------------------------------

SERVER_INFO = {"name": "figure-plugin", "title": "科研绘图 MCP 插件 (v3)", "version": "1.0"}
PROTOCOL_VERSION_DEFAULT = "2024-11-05"

API_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEFAULT_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-flash")

_VIEWER_PORT_DEFAULT = 8770
_KEY_FROM_FILE = {"value": None}

_VIEWER_STATE = {"doc": None, "lock": threading.Lock()}

_BRIDGE = None
_BRIDGE_LOCK = threading.Lock()

# 容错加载 py/ 下的并行任务产物；缺失不致命（相关工具报中文错误）
DOCIO = None
FIGRASTER = None
try:
    import docio as DOCIO  # noqa: E402
except Exception:  # pragma: no cover
    DOCIO = None
try:
    import figraster as FIGRASTER  # noqa: E402
except Exception:  # pragma: no cover
    FIGRASTER = None
try:
    import spreadsheet as SPREADSHEET  # noqa: E402
except Exception:  # pragma: no cover
    SPREADSHEET = None

SPREADSHEET_EXTENSIONS = frozenset((".xlsx", ".xlsm", ".xls"))
SPREADSHEET_MIME_TYPES = frozenset((
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.ms-excel",
    "application/octet-stream",
))
MAX_SPREADSHEET_BYTES = 20 * 1024 * 1024


def _log(msg):
    """日志只写 stderr；严禁输出 API key。"""
    sys.stderr.write("[mcp_server] %s\n" % msg)
    sys.stderr.flush()


def _save_token(doc):
    if doc is None:
        return None
    canonical = json.dumps(
        doc, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 预设加载（journals / templates / palettes 来自 shared/presets）
# ---------------------------------------------------------------------------

def _load_preset_file(name):
    path = SHARED_PRESETS_DIR / name
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:  # pragma: no cover
        _log("读取预设失败 %s：%s" % (path, e))
        return None


_PRESETS_RAW = {
    "journals": _load_preset_file("journals.json"),
    "templates": _load_preset_file("templates.json"),
    "palettes": _load_preset_file("palettes.json"),
}


def _journal_preset(journal_id):
    raw = _PRESETS_RAW.get("journals")
    if not raw or not journal_id:
        return None
    for item in raw.get("presets", []):
        if item.get("id") == journal_id:
            return item
    return None


def _template_by_chart_type(chart_type):
    raw = _PRESETS_RAW.get("templates")
    if not raw or not chart_type:
        return None
    for item in raw.get("templates", []):
        if item.get("chart_type") == chart_type:
            return item
    return None


_TEMPLATE_CAPABILITY_NOTES = {
    "full": "本地可按有效数据真实生成 SVG；仍须检查数据映射与最终视觉质量。",
    "layout": "仅创建空白复合版式，不会自动填入真实图表；请逐面板添加数据与图形。",
    "unsupported": "仅供示意和预览，当前不能真实生成，禁止通过 MCP/AI 应用。",
}
_RENDER_TYPE_CACHE = {"types": None}
_RENDERER_DEFINITION_RE = re.compile(
    r"^\s*RENDERS\.([A-Za-z_$][\w$]*)\s*=\s*function\s*\(", re.M)


def _fallback_render_chart_types():
    path = PLUGIN_DIR / "lib" / "data.js"
    try:
        with open(path, "r", encoding="utf-8") as f:
            source = f.read()
    except Exception as exc:
        raise ToolError("无法读取当前 FigData 渲染器能力表：%s" % exc) from exc
    types = frozenset(_RENDERER_DEFINITION_RE.findall(source))
    if not types:
        raise ToolError("当前 FigData 未暴露任何 RENDERS 实现，无法判定模板能力")
    return types


def _render_chart_types():
    cached = _RENDER_TYPE_CACHE.get("types")
    if cached is not None:
        return cached
    try:
        result = bcall("data.chart_types")
        if isinstance(result, dict):
            result = result.get("chartTypes", result.get("chart_types"))
        if isinstance(result, (list, tuple, set, frozenset)) and all(
                isinstance(item, str) and item for item in result):
            types = frozenset(result)
            _RENDER_TYPE_CACHE["types"] = types
            return types
    except (BridgeCallError, BridgeError):
        pass

    try:
        result = bcall("data.supports_chart_type", chart_type="__capability_probe__")
        if isinstance(result, dict):
            result = result.get("supported")
        if isinstance(result, bool):
            raw = _PRESETS_RAW.get("templates") or {}
            supported = set()
            for item in raw.get("templates", []):
                chart_type = item.get("chart_type")
                if not isinstance(chart_type, str) or not chart_type:
                    continue
                verdict = bcall("data.supports_chart_type", chart_type=chart_type)
                if isinstance(verdict, dict):
                    verdict = verdict.get("supported")
                if not isinstance(verdict, bool):
                    raise BridgeCallError("supportsChartType 返回格式异常")
                if verdict:
                    supported.add(chart_type)
            types = frozenset(supported)
            _RENDER_TYPE_CACHE["types"] = types
            return types
    except (BridgeCallError, BridgeError):
        pass

    types = _fallback_render_chart_types()
    _RENDER_TYPE_CACHE["types"] = types
    return types


def _template_with_capability(item):
    template = dict(item)
    chart_type = template.get("chart_type")
    if template.get("category") == "diagram":
        try:
            support = bcall("diagram.supports_template", template_id=template.get("id"))
            capability = "full" if support.get("supported") is True else "unsupported"
            template["schematic_mode"] = "raw_parameters_only"
            template["schematic_reason"] = support.get("reason")
        except (BridgeError, BridgeCallError):
            capability = "unsupported"
    elif chart_type is None:
        capability = "layout"
    elif isinstance(chart_type, str) and chart_type in _render_chart_types():
        capability = "full"
    else:
        capability = "unsupported"
    template["capability"] = capability
    template["can_apply"] = capability != "unsupported"
    template["auto_generate"] = capability == "full" and template.get("category") != "diagram"
    template["capability_note"] = (template.get("schematic_reason") or _TEMPLATE_CAPABILITY_NOTES[capability]) \
        if template.get("category") == "diagram" else _TEMPLATE_CAPABILITY_NOTES[capability]
    return template


def _require_template_applicable(template_id):
    raw = _PRESETS_RAW.get("templates") or {}
    item = next((tpl for tpl in raw.get("templates", [])
                 if tpl.get("id") == template_id), None)
    if item is None:
        raise ToolError("未找到模板：%s" % template_id)
    template = _template_with_capability(item)
    if not template["can_apply"]:
        raise ToolError(
            "模板「%s」当前仅支持示意预览，不能真实生成；已禁止应用。"
            "请改用 capability=full 的模板或 capability=layout 的空白版式。"
            % (template.get("name") or template_id))
    return template


def _require_chart_renderable(chart_type):
    if not isinstance(chart_type, str) or not chart_type:
        raise ToolError("图表缺少有效的 chartType，已停止真实渲染")
    if chart_type not in _render_chart_types():
        raise ToolError(
            "chartType=%s 当前本地 FigData 不支持真实 SVG 渲染；"
            "已停止生成占位成功结果。请改用 capability=full 的模板。" % chart_type)


# ---------------------------------------------------------------------------
# Node 桥（bridge.js）
# ---------------------------------------------------------------------------

class ToolError(Exception):
    """工具级业务错误 -> ok:false + 中文 error。"""


class BridgeError(Exception):
    """桥进程级错误（启动失败/崩溃/超时），消息含排查提示。"""


class BridgeCallError(Exception):
    """桥返回 ok:false（业务失败，不需要重启重试）。"""


class Bridge(object):
    """常驻 Node 子进程；stdin 每行一个请求，stdout 每行一个响应。

    崩溃自动重启一次并重试当前调用；第二次失败抛 BridgeError（含排查提示）。
    """

    def __init__(self, plugin_dir):
        self._dir = str(plugin_dir)
        self._proc = None
        self._lock = threading.RLock()
        self._resp_q = queue.Queue()
        self._req_seq = 0
        self._stderr_tail = collections.deque(maxlen=30)
        self._last_start_error = None

    # -- 进程管理 ----------------------------------------------------------

    def _alive(self):
        return self._proc is not None and self._proc.poll() is None

    def _spawn(self):
        try:
            self._proc = subprocess.Popen(
                ["node", "bridge.js"],
                cwd=self._dir,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except OSError as e:
            self._last_start_error = str(e)
            raise BridgeError("无法启动 Node 桥（node bridge.js）：%s" % e)
        threading.Thread(target=self._stdout_loop, daemon=True).start()
        threading.Thread(target=self._stderr_loop, daemon=True).start()

    def _kill(self):
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    if stream:
                        stream.close()
                except Exception:
                    pass
        except Exception:
            pass

    def _restart(self):
        self._kill()
        self._resp_q = queue.Queue()  # 丢弃旧进程的残留响应
        try:
            self._spawn()
            return True
        except BridgeError:
            return False

    def _stdout_loop(self):
        try:
            for line in self._proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    self._stderr_tail.append("stdout 非法 JSON 行: %s" % line[:200])
                    continue
                self._resp_q.put(msg)
        except Exception:
            pass
        finally:
            self._resp_q.put({"__bridge_eof__": True})

    def _stderr_loop(self):
        try:
            for line in self._proc.stderr:
                self._stderr_tail.append(line.rstrip()[:300])
        except Exception:
            pass

    def _stderr_dump(self):
        if not self._stderr_tail:
            return ""
        return "；桥 stderr 末尾记录：%s" % " | ".join(list(self._stderr_tail)[-5:])

    @staticmethod
    def _hint(detail):
        return (
            "%s。Node 桥已自动重启一次仍失败，请排查："
            "1) 运行 `node --version` 确认 Node.js ≥22 已安装且在 PATH 中；"
            "2) 确认本插件目录（mcp/）下的 bridge.js 存在，并手动运行 `node bridge.js` 观察是否报错；"
            "3) 桥依赖本插件目录 mcp/lib/ 下的内核文件（shared/lib 逐字节副本）。"
        ) % detail

    # -- 调用 ---------------------------------------------------------------

    def call(self, fn, args, timeout=60):
        with self._lock:
            last_err = None
            for attempt in (1, 2):  # 崩溃后只自动重启重试一次
                if not self._alive():
                    if not self._restart():
                        raise BridgeError(self._hint(
                            self._last_start_error or "启动失败" + self._stderr_dump()))
                self._req_seq += 1
                rid = self._req_seq
                try:
                    payload = json.dumps(
                        {"id": rid, "fn": fn, "args": args}, ensure_ascii=False)
                    self._proc.stdin.write(payload + "\n")
                    self._proc.stdin.flush()
                except Exception as e:
                    last_err = "向桥写入请求失败（fn=%s）：%s" % (fn, e)
                    self._kill()
                    continue  # 重启后重试
                deadline = time.monotonic() + timeout
                crashed = False
                while True:
                    remain = deadline - time.monotonic()
                    if remain <= 0:
                        last_err = "桥在 %d 秒内未响应（fn=%s）" % (timeout, fn)
                        self._kill()
                        crashed = True
                        break
                    try:
                        msg = self._resp_q.get(timeout=min(remain, 1.0))
                    except queue.Empty:
                        continue
                    if msg.get("__bridge_eof__"):
                        last_err = "Node 桥进程意外退出（fn=%s）" % fn
                        crashed = True
                        break
                    if msg.get("id") != rid:
                        continue  # 上一次超时请求的迟到响应，忽略
                    if msg.get("ok"):
                        return msg.get("result")
                    # 桥业务失败：不重启不重试，原样转成中文错误
                    raise BridgeCallError(str(msg.get("error") or "桥返回未知错误"))
                if not crashed:
                    break
            raise BridgeError(self._hint(last_err or "未知桥错误" + self._stderr_dump()))


def _get_bridge():
    global _BRIDGE
    with _BRIDGE_LOCK:
        if _BRIDGE is None:
            _BRIDGE = Bridge(PLUGIN_DIR)
        return _BRIDGE


def bcall(fn, timeout=60, **kwargs):
    """调用桥。为兼容两种桥实现（整体对象 / 按参数名展开），
    顶层同时携带各命名参数与等价的 opts 对象。"""
    bridge = _get_bridge()
    args = dict(kwargs)
    args["opts"] = dict(kwargs)
    return bridge.call(fn, args, timeout=timeout)


# ---------------------------------------------------------------------------
# doc / 工程文件（优先 docio.py，缺失时内置兜底）
# ---------------------------------------------------------------------------

def _require_doc(a):
    doc = a.get("doc")
    if not isinstance(doc, dict) or "canvas" not in doc or "elements" not in doc:
        raise ToolError("缺少有效的 doc 参数（应为 FigureDocument 对象，含 canvas/elements 字段）")
    return doc


def _as_doc_result(res, fn_name):
    """桥返回值 -> (doc, extra)；兼容 {doc, ...} 与直接返回 doc 两种形状。"""
    if isinstance(res, dict) and "doc" in res:
        extra = {k: v for k, v in res.items() if k != "doc"}
        return res["doc"], extra
    if isinstance(res, dict):
        return res, {"changed": True}
    raise ToolError("桥调用 %s 返回结果格式异常，无法取得文档" % fn_name)


def _validate_doc(doc):
    """结构校验：优先 docio/figraster 的实现，否则内置最小校验。返回中文错误列表。"""
    for mod, names in ((DOCIO, ("validate_doc", "validate")),
                       (FIGRASTER, ("validate_doc",))):
        if mod is None:
            continue
        for name in names:
            fn = getattr(mod, name, None)
            if callable(fn):
                try:
                    return list(fn(doc) or [])
                except TypeError:
                    continue  # 签名不匹配，尝试下一个
                except Exception as e:
                    return ["结构校验失败：%s" % e]
    errors = []
    if not isinstance(doc, dict):
        return ["doc 必须是 JSON 对象"]
    if doc.get("schema_version") != "1.0":
        errors.append("schema_version 必须为 \"1.0\"")
    canvas = doc.get("canvas")
    if not isinstance(canvas, dict):
        errors.append("缺少 canvas 画布对象")
    else:
        for k in ("width_mm", "height_mm", "dpi", "background"):
            if k not in canvas:
                errors.append("canvas 缺少必填字段 %s" % k)
        if not isinstance(canvas.get("width_mm"), (int, float)) or canvas.get("width_mm", 0) <= 0:
            errors.append("canvas.width_mm 必须为正数")
        if not isinstance(canvas.get("height_mm"), (int, float)) or canvas.get("height_mm", 0) <= 0:
            errors.append("canvas.height_mm 必须为正数")
    if not isinstance(doc.get("elements"), list):
        errors.append("elements 必须是数组")
    if not isinstance(doc.get("meta"), dict):
        errors.append("缺少 meta 对象")
    return errors


def _save_project_file(doc, path, assets):
    """保存工程文件；优先 docio.save_project，否则内置实现。"""
    if DOCIO is not None and callable(getattr(DOCIO, "save_project", None)):
        try:
            res = DOCIO.save_project(doc, path, assets)
            return str(res) if res else str(path)
        except TypeError:
            pass  # 签名不匹配 -> 内置兜底
        except Exception as e:
            raise ToolError("保存工程失败：%s" % e)
    doc2 = json.loads(json.dumps(doc, ensure_ascii=False))
    history = doc2.pop("history", [])
    project = {
        "format": "figure-project",
        "format_version": "1.0",
        "doc": doc2,
        "history": history,
        "assets": assets if isinstance(assets, dict) else {},
    }
    p = Path(path)
    if p.parent and str(p.parent):
        try:
            os.makedirs(str(p.parent), exist_ok=True)
        except Exception:
            pass
    with open(str(p), "w", encoding="utf-8") as f:
        json.dump(project, f, ensure_ascii=False, indent=2)
    return str(p)


def _load_project_file(path):
    """读取工程文件；优先 docio.load_project，否则内置实现。"""
    if not os.path.isfile(path):
        raise ToolError("文件不存在：%s" % path)
    if DOCIO is not None and callable(getattr(DOCIO, "load_project", None)):
        try:
            return DOCIO.load_project(path)
        except TypeError:
            pass
        except Exception as e:
            raise ToolError("读取工程失败：%s" % e)
    with open(path, "r", encoding="utf-8") as f:
        obj = json.load(f)
    if isinstance(obj, dict) and obj.get("format") == "figure-project" and isinstance(obj.get("doc"), dict):
        doc = obj["doc"]
        history = obj.get("history", [])
        doc["history"] = history
        return {"doc": doc, "history": history}
    if isinstance(obj, dict) and "canvas" in obj:
        return {"doc": obj, "history": obj.get("history", [])}
    raise ToolError("不是有效的工程文件（*.figureproj.json）：%s" % path)


# ---------------------------------------------------------------------------
# DeepSeek（网络走 Python，key 不进 Node、不写日志、不进返回值）
# ---------------------------------------------------------------------------

def get_api_key():
    if _KEY_FROM_FILE.get("value"):
        return _KEY_FROM_FILE["value"]
    return os.environ.get("DEEPSEEK_API_KEY") or None


MAX_REVIEW_IMAGE_BYTES = 20 * 1024 * 1024


def _validate_review_image(value):
    """Return a canonical PNG/JPEG data URL without accepting remote resources."""
    if not isinstance(value, str):
        raise ToolError("png_base64 必须是 PNG/JPEG 的 Base64 字符串或 data URL")
    value = value.strip()
    if not value:
        raise ToolError("png_base64 不能为空；不传图时请省略该字段")
    if value.lower().startswith(("http://", "https://", "//")):
        raise ToolError("png_base64 不接受远程 URL；请提供 PNG/JPEG Base64 或光栅 data URL")

    declared_mime = None
    payload = value
    if value.lower().startswith("data:"):
        header, separator, payload = value.partition(",")
        header_parts = header.split(";")
        if not separator or len(header_parts) != 2 or header_parts[1].lower() != "base64":
            raise ToolError("png_base64 data URL 格式无效，应为 data:image/png;base64,... 或 JPEG 等价形式")
        declared_mime = header_parts[0][5:].lower()
        if declared_mime not in ("image/png", "image/jpeg", "image/jpg"):
            raise ToolError("png_base64 只接受 PNG/JPEG 光栅 data URL，不支持 SVG 或其他格式")

    if not payload:
        raise ToolError("png_base64 缺少 Base64 图片数据")
    max_base64_chars = 4 * ((MAX_REVIEW_IMAGE_BYTES + 2) // 3)
    if len(payload) > max_base64_chars:
        raise ToolError("png_base64 图片过大：解码后不得超过 %d 字节" % MAX_REVIEW_IMAGE_BYTES)
    try:
        raw = base64.b64decode(payload.encode("ascii"), validate=True)
    except (UnicodeEncodeError, ValueError) as exc:
        raise ToolError("png_base64 不是合法的 Base64 图片数据") from exc
    if len(raw) > MAX_REVIEW_IMAGE_BYTES:
        raise ToolError("png_base64 图片过大：解码后不得超过 %d 字节" % MAX_REVIEW_IMAGE_BYTES)

    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        actual_mime = "image/png"
    elif raw.startswith(b"\xff\xd8\xff"):
        actual_mime = "image/jpeg"
    else:
        raise ToolError("png_base64 不是有效的 PNG/JPEG 光栅图；不支持 SVG 或其他格式")
    declared_mime = "image/jpeg" if declared_mime == "image/jpg" else declared_mime
    if declared_mime is not None and declared_mime != actual_mime:
        raise ToolError("png_base64 data URL 声明的 %s 与实际 %s 图片不一致"
                        % (declared_mime, actual_mime))
    return "data:%s;base64,%s" % (actual_mime, payload)


def _deepseek_chat(messages, timeout=60, image_data_url=None):
    key = get_api_key()
    if not key:
        raise ToolError("未配置 DeepSeek API key（设置环境变量 DEEPSEEK_API_KEY 或 --key-file）")
    if image_data_url is not None:
        messages = list(messages)
        for index in range(len(messages) - 1, -1, -1):
            if messages[index].get("role") == "user":
                last_user = dict(messages[index])
                content = last_user.get("content")
                if isinstance(content, str):
                    parts = [{"type": "text", "text": content}]
                elif isinstance(content, list):
                    parts = list(content)
                else:
                    raise ToolError("附带审阅图片时，最后一个 user content 必须是字符串或内容 parts 数组")
                parts.append({"type": "image_url", "image_url": {"url": image_data_url}})
                last_user["content"] = parts
                messages[index] = last_user
                break
        else:
            raise ToolError("附带审阅图片时 messages 中必须至少有一条 user 消息")
    body = {
        "model": DEFAULT_MODEL,
        "messages": messages,
        "stream": False,
    }
    req = urllib.request.Request(
        API_BASE_URL.rstrip("/") + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def _parse_json_items(text):
    """从模型回复中提取 JSON（容忍 ``` 围栏与前后说明文字）。"""
    if text is None:
        raise ValueError("模型回复为空")
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.S).strip()
    try:
        return json.loads(s)
    except ValueError:
        pass
    for lo, hi in ((s.find("["), s.rfind("]")), (s.find("{"), s.rfind("}"))):
        if lo >= 0 and hi > lo:
            try:
                return json.loads(s[lo:hi + 1])
            except ValueError:
                continue
    raise ValueError("模型回复中未找到合法 JSON")


# ---------------------------------------------------------------------------
# 桥批量应用 EditOp 的公共流程
# ---------------------------------------------------------------------------

def _order_elements_parents_first(elements):
    """容器（group/panel）必须先于其子元素入档，否则 add_element 报父元素不存在。"""
    remaining = list(elements)
    ordered, placed = [], set()
    while remaining:
        progressed = False
        for el in list(remaining):
            pid = el.get("parent_id")
            if pid and pid not in placed:
                continue
            ordered.append(el)
            if el.get("id"):
                placed.add(el["id"])
            remaining.remove(el)
            progressed = True
        if not progressed:  # 悬挂引用：按原顺序兜底
            ordered.extend(remaining)
            break
    return ordered


# ---------------------------------------------------------------------------
# 历史记录与快照
#
# EditOp 的校验、规范化、事务历史和 no-op 语义统一由 FigOps.applyAll 处理；
# Python 只保存跨桥调用无法传输的运行期快照，供同会话回退使用。
# ---------------------------------------------------------------------------

_SNAPSHOT_STORE = collections.OrderedDict()  # (doc_id, rev, history_sha256) -> stripped doc
_SNAP_LOCK = threading.Lock()
MAX_HISTORY = 200  # 与 FigOps.MAX_HISTORY 一致
MAX_SNAPSHOTS = MAX_HISTORY
_SNAPSHOT_OMIT_KEYS = frozenset(("history_origin", "__snapshots", "key", "DOM", "saveToken"))


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()) + \
        time.strftime("%z")[:3] + ":" + time.strftime("%z")[3:]


def _snap_key(doc):
    return str(doc.get("id") or "default")


def _snapshot_copy(value, root=False):
    if isinstance(value, list):
        return [_snapshot_copy(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _snapshot_copy(item)
            for key, item in value.items()
            if key not in _SNAPSHOT_OMIT_KEYS and not (root and key == "history")
        }
    return value


def _snapshot_identity(doc, rev):
    for rec in doc.get("history") or []:
        if isinstance(rec, dict) and rec.get("rev") == rev:
            sha = rec.get("doc_sha256")
            if isinstance(sha, str) and sha:
                return _snap_key(doc), rev, "sha256:" + sha
            return None
    return None


def _snap_get(doc, rev):
    key = _snapshot_identity(doc, rev)
    if key is None:
        return None
    with _SNAP_LOCK:
        snap = _SNAPSHOT_STORE.get(key)
        if snap is None:
            return None
        return json.loads(json.dumps(snap, ensure_ascii=False))


def _snap_put(doc, rev):
    try:
        rev = int(rev)
    except (TypeError, ValueError):
        return
    key = _snapshot_identity(doc, rev)
    if key is None:
        return
    snap = _snapshot_copy(doc, root=True)
    with _SNAP_LOCK:
        if key in _SNAPSHOT_STORE:
            del _SNAPSHOT_STORE[key]
        _SNAPSHOT_STORE[key] = snap
        while len(_SNAPSHOT_STORE) > MAX_SNAPSHOTS:
            _SNAPSHOT_STORE.popitem(last=False)


def _content_rev(doc):
    """镜像内核 contentRevOf：revert 记录只是簿记，播放头指向其 revert_to。"""
    hist = doc.get("history") or []
    if not hist:
        return 0
    rec = hist[-1]
    seen = set()
    while isinstance(rec, dict) and rec.get("kind") == "revert" and rec.get("rev") not in seen:
        seen.add(rec.get("rev"))
        target = rec.get("revert_to") or 0
        nxt = next((r for r in hist if r.get("rev") == target), None)
        if not nxt:
            return target
        rec = nxt
    if isinstance(rec, dict):
        return rec.get("rev") or 0
    return 0


def _last_rev(doc):
    hist = doc.get("history") or []
    if not hist:
        return 0
    return hist[-1].get("rev") or 0



def _fill_sha256(doc, rev):
    """经桥补齐该 rev 的 doc_sha256（失败保持 null，不影响主流程）。"""
    try:
        sha = bcall("doc.sha256", doc=doc)
        if isinstance(sha, str) and sha:
            for rec in doc.get("history", []):
                if rec.get("rev") == rev and not rec.get("doc_sha256"):
                    rec["doc_sha256"] = sha
                    break
    except Exception:
        pass


def _record_history(doc, ops, label, source="ai", checkpoint=False, pre_doc=None):
    """从变更前文档经 FigOps 生成同一事务，避免旁路裁剪与持久基线推进。"""
    if not isinstance(pre_doc, dict):
        raise ToolError("历史事务缺少变更前文档，已停止生成可能无法回放的记录")
    work = json.loads(json.dumps(pre_doc, ensure_ascii=False))
    if not isinstance(work.get("history"), list):
        work["history"] = []
    _snap_put(work, _content_rev(work))
    res = bcall(
        "ops.apply_all", doc=work, ops=ops, label=label, source=source,
        ts=_now_iso(), checkpoint=bool(checkpoint),
    )
    work, extra = _as_doc_result(res, "ops.apply_all")
    applied = extra.get("applied")
    if not isinstance(applied, int) or isinstance(applied, bool) or applied < 0:
        raise ToolError("桥调用 ops.apply_all 返回的 applied 不是非负整数")
    if applied == 0 or extra.get("changed") is False:
        return doc
    rev = _last_rev(work)
    _fill_sha256(work, rev)
    _snap_put(work, rev)
    return work


def _chart_data_replacement_is_noop(doc, op):
    if op.get("approved") is not True or not isinstance(op.get("data"), dict):
        return False
    incoming = op["data"]
    if not isinstance(incoming.get("columns"), list) or not isinstance(incoming.get("rows"), list):
        return False
    targets = op.get("targets")
    if not isinstance(targets, list) or not targets \
            or not all(isinstance(target, str) for target in targets):
        return False
    supplied_source = op.get("source_ref", op.get("sourceRef"))
    if supplied_source is None:
        supplied_source = incoming.get("source_ref", incoming.get("sourceRef"))
    supplied_version = op.get("version", incoming.get("version"))
    if any(key in op or key in incoming for key in ("raw_source_sha256", "source_info")):
        return False
    next_values = {"columns": incoming["columns"], "rows": incoming["rows"]}
    for target in targets:
        element = next((item for item in doc.get("elements") or []
                        if isinstance(item, dict) and item.get("id") == target), None)
        if not isinstance(element, dict) or element.get("type") != "chart":
            return False
        data = (element.get("chart") or {}).get("data")
        if not isinstance(data, dict) or not isinstance(data.get("inline"), dict):
            return False
        inline = data["inline"]
        current_values = {"columns": inline.get("columns"), "rows": inline.get("rows")}
        current_source = data.get("source_ref", data.get("ref"))
        if not _json_deep_equal(current_values, next_values) \
                or not _json_deep_equal(current_source, supplied_source) \
                or not _json_deep_equal(data.get("version"), supplied_version):
            return False
    return True


def _apply_ops_with_history(doc, ops, label, source="ai"):
    """经内核完整校验和 applyAll 应用一批 EditOp，并保存会话快照。"""
    work = json.loads(json.dumps(doc, ensure_ascii=False))
    if not isinstance(work.get("history"), list):
        work["history"] = []
    _snap_put(work, _content_rev(work))
    verdict = bcall("ops.validate_all", doc=work, ops=ops)
    if not isinstance(verdict, dict):
        raise ToolError("桥调用 ops.validate_all 返回结果格式异常")
    if not verdict.get("ok"):
        errs = "；".join(str(x) for x in (verdict.get("errors") or ["未知校验错误"]))
        raise ToolError("EditOp 校验失败，未应用任何变更：%s" % errs)
    effective_ops = [op for op in ops if op.get("op") != "set_chart_data"
                     or not _chart_data_replacement_is_noop(work, op)]
    if not effective_ops:
        return doc, 0
    res = bcall(
        "ops.apply_all", doc=work, ops=effective_ops, label=label, source=source,
        ts=_now_iso(), checkpoint=False,
    )
    work, extra = _as_doc_result(res, "ops.apply_all")
    applied = extra.get("applied")
    if not isinstance(applied, int) or isinstance(applied, bool) or applied < 0:
        raise ToolError("桥调用 ops.apply_all 返回的 applied 不是非负整数")
    if applied == 0 or extra.get("changed") is False:
        return doc, 0
    rev = _last_rev(work)
    _fill_sha256(work, rev)
    _snap_put(work, rev)
    return work, applied


# ---------------------------------------------------------------------------
# 工具实现（名称与 tools_spec.py 一一对应）
# ---------------------------------------------------------------------------

def tool_figure_create(a):
    opts = {}
    for k in ("width_mm", "height_mm", "dpi", "title"):
        if k in a and a[k] is not None:
            opts[k] = a[k]
    doc, _ = _as_doc_result(bcall("doc.create", **opts), "doc.create")
    payload = {"ok": True, "doc": doc}
    if a.get("journal_id"):
        jid = a["journal_id"]
        pre_doc = json.loads(json.dumps(doc, ensure_ascii=False))
        res = bcall("presets.apply_canvas", preset_id=jid, doc=doc)
        doc, extra = _as_doc_result(res, "presets.apply_canvas")
        op = extra.get("op")
        if isinstance(op, dict):
            doc = _record_history(doc, [op], "套用画布预设 %s" % jid, "preset",
                                  pre_doc=pre_doc)
        payload["doc"] = doc
        warnings = extra.get("warnings") or []
        if warnings:
            payload["warnings"] = warnings
    return payload


def tool_figure_templates(a):
    raw = _PRESETS_RAW.get("templates")
    if not raw:
        raise ToolError("无法读取 presets/templates.json（应位于 %s）" % SHARED_PRESETS_DIR)
    include_unsupported = a.get("include_unsupported", False)
    if not isinstance(include_unsupported, bool):
        raise ToolError("include_unsupported 必须是布尔值")
    capability = a.get("capability")
    if capability is not None and capability not in _TEMPLATE_CAPABILITY_NOTES:
        raise ToolError("capability 必须是 full / layout / unsupported")
    items = [_template_with_capability(t) for t in raw.get("templates", [])]
    cat = a.get("category")
    ctype = a.get("chart_type")
    if cat:
        items = [t for t in items if t.get("category") == cat]
    if ctype:
        items = [t for t in items if t.get("chart_type") == ctype]
    if capability:
        items = [t for t in items if t["capability"] == capability]
    elif not include_unsupported:
        items = [t for t in items if t["can_apply"]]
    return {"ok": True, "templates": items}


def tool_figure_journals(a):
    raw = _PRESETS_RAW.get("journals")
    if not raw:
        raise ToolError("无法读取 presets/journals.json（应位于 %s）" % SHARED_PRESETS_DIR)
    items = raw.get("presets", [])
    cat = a.get("category")
    if cat:
        items = [j for j in items if j.get("category") == cat]
    return {"ok": True, "journals": items}


def _resolve_data_path(path):
    path = str(path)
    if os.path.isfile(path):
        return path
    for base in (PLUGIN_DIR, Path.cwd()):
        candidate = base / path
        if candidate.is_file():
            return str(candidate)
    raise ToolError("数据文件不存在：%s" % path)


def _validate_spreadsheet_file_name(file_name):
    if not isinstance(file_name, str) or not file_name.strip():
        raise ToolError("工作簿 file_name 必须是非空文件名")
    file_name = file_name.strip()
    if (len(file_name) > 255 or file_name in (".", "..")
            or "/" in file_name or "\\" in file_name
            or any(ord(char) < 32 for char in file_name)):
        raise ToolError("工作簿 file_name 只能是不含路径与控制字符的文件名")
    if Path(file_name).suffix.lower() not in SPREADSHEET_EXTENSIONS:
        raise ToolError("工作簿仅支持 .xlsx / .xlsm / .xls 文件")
    return file_name


def _validate_spreadsheet_base64(value, field_name="xlsx_base64"):
    if not isinstance(value, str) or not value:
        raise ToolError("%s 必须是非空 Base64 字符串" % field_name)
    payload = value
    if value.lower().startswith("data:"):
        header, separator, payload = value.partition(",")
        parts = header.split(";")
        if not separator or len(parts) != 2 or parts[1].lower() != "base64":
            raise ToolError("%s data URL 格式无效，必须使用 ;base64," % field_name)
        mime = parts[0][5:].lower()
        if mime not in SPREADSHEET_MIME_TYPES:
            raise ToolError("%s data URL 的 MIME 不是受支持的 Excel 工作簿类型" % field_name)
    max_chars = 4 * ((MAX_SPREADSHEET_BYTES + 2) // 3)
    if len(payload) > max_chars:
        raise ToolError("工作簿过大：解码后不得超过 %d 字节" % MAX_SPREADSHEET_BYTES)
    try:
        raw = base64.b64decode(payload.encode("ascii"), validate=True)
    except (UnicodeEncodeError, ValueError) as exc:
        raise ToolError("%s 不是合法的 Base64 工作簿数据" % field_name) from exc
    if not raw:
        raise ToolError("%s 解码后为空" % field_name)
    if len(raw) > MAX_SPREADSHEET_BYTES:
        raise ToolError("工作簿过大：解码后不得超过 %d 字节" % MAX_SPREADSHEET_BYTES)
    return payload


def _sheet_argument(source):
    sheet_name = source.get("sheet_name")
    sheet = source.get("sheet")
    if (sheet_name is not None and sheet is not None
            and sheet_name != sheet):
        raise ToolError("sheet_name 与 sheet 指向不同工作表；请只保留一个选择")
    return sheet_name if sheet_name is not None else sheet


def _open_spreadsheet_source(path=None, data_base64=None, file_name=None,
                             sheet=None, header_row=None):
    if (path is None) == (data_base64 is None):
        raise ToolError("工作簿必须且只能提供 path 或 Base64 内容之一")
    if SPREADSHEET is None or not callable(getattr(SPREADSHEET, "open_spreadsheet", None)):
        raise ToolError("py/spreadsheet.py 不可用，无法导入 Excel 工作簿")
    if path is not None:
        path = _resolve_data_path(path)
        if Path(path).suffix.lower() not in SPREADSHEET_EXTENSIONS:
            raise ToolError("该路径不是受支持的 Excel 工作簿（.xlsx/.xlsm/.xls）")
        try:
            size = os.path.getsize(path)
        except OSError as exc:
            raise ToolError("无法读取工作簿大小：%s" % exc) from exc
        if size <= 0 or size > MAX_SPREADSHEET_BYTES:
            raise ToolError("工作簿必须非空且不得超过 %d 字节" % MAX_SPREADSHEET_BYTES)
        result = SPREADSHEET.open_spreadsheet(
            path=path, sheet=sheet, header_row=header_row)
    else:
        file_name = _validate_spreadsheet_file_name(file_name or "workbook.xlsx")
        payload = _validate_spreadsheet_base64(data_base64)
        result = SPREADSHEET.open_spreadsheet(
            data_base64=payload, file_name=file_name,
            sheet=sheet, header_row=header_row)
    if not isinstance(result, dict):
        raise ToolError("工作簿解析结果格式异常：应为对象")
    data = result.get("data")
    if (not isinstance(data, dict) or not isinstance(data.get("columns"), list)
            or not isinstance(data.get("rows"), list)):
        raise ToolError("工作簿解析结果缺少有效的 data:{columns,rows}")
    for key, expected_type in (("sheets", list), ("notices", list), ("source_info", dict)):
        if not isinstance(result.get(key), expected_type):
            raise ToolError("工作簿解析结果缺少有效的 %s" % key)
    if "sheet_name" not in result or "header_row" not in result:
        raise ToolError("工作簿解析结果缺少 sheet_name/header_row")
    try:
        json.dumps(result, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ToolError("工作簿包含不能安全编码为 JSON 的单元格：%s" % exc) from exc
    return result


def _capability_recommendations(stats, include_unsupported=False):
    if not isinstance(include_unsupported, bool):
        raise ToolError("include_unsupported 必须是布尔值")
    recommended = bcall("presets.recommend", column_stats=stats)
    if isinstance(recommended, dict):
        recommended = recommended.get("recommended", [])
    raw_templates = (_PRESETS_RAW.get("templates") or {}).get("templates", [])
    by_id = {tpl.get("id"): tpl for tpl in raw_templates}
    visible = []
    for rec in recommended if isinstance(recommended, list) else []:
        if not isinstance(rec, dict):
            continue
        item = by_id.get(rec.get("template_id"))
        if item is None:
            continue
        template = _template_with_capability(item)
        if not include_unsupported and not template["can_apply"]:
            continue
        decorated = dict(rec)
        decorated["capability"] = template["capability"]
        decorated["can_apply"] = template["can_apply"]
        decorated["auto_generate"] = template["auto_generate"]
        decorated["capability_note"] = template["capability_note"]
        visible.append(decorated)
    return visible


def _spreadsheet_preview(path=None, data_base64=None, file_name=None,
                         sheet=None, header_row=None, include_unsupported=False):
    workbook = _open_spreadsheet_source(
        path=path, data_base64=data_base64, file_name=file_name,
        sheet=sheet, header_row=header_row)
    data = workbook["data"]
    stats = bcall("data.column_stats", data=data)
    notices = workbook.get("notices") or []
    return {
        "ok": True,
        "data": data,
        "columns": data.get("columns", []),
        "stats": stats,
        "recommended": _capability_recommendations(stats, include_unsupported),
        "sheets": workbook.get("sheets") or [],
        "sheet_name": workbook.get("sheet_name"),
        "header_row": workbook.get("header_row"),
        "notices": notices,
        "warnings": notices,
        "source_info": workbook.get("source_info") or {},
    }


def _json_deep_equal(left, right):
    if isinstance(left, (int, float)) and not isinstance(left, bool) \
            and isinstance(right, (int, float)) and not isinstance(right, bool):
        return left == right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _json_deep_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            _json_deep_equal(left[key], right[key]) for key in left)
    return type(left) is type(right) and left == right


def _table_value_sha256(data):
    values = {"columns": data.get("columns"), "rows": data.get("rows")}
    canonical = json.dumps(values, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _text_source_info(data, kind, raw, path=None):
    is_file = path is not None
    source = {
        "kind": kind,
        "format": kind,
        "locator": str(Path(path).resolve()) if is_file else "provided_%s_text" % kind,
        "locator_kind": "local_path" if is_file else "provided_text_not_a_file",
        "file_name": Path(path).name if is_file else None,
        "input_mode": "local_file_bytes" if is_file else "provided_text_utf8_bytes",
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
        "version": None,
        "content_version": None,
        "verification_status": "input_bytes_hashed_unverified_origin",
        "source_identity": "provided_%s_input_not_publication_verification" % kind,
        "read_only": True,
        "value_fingerprint": {
            "algorithm": "canonical_columns_rows_json_sha256",
            "sha256": _table_value_sha256(data),
            "columns": list(data.get("columns") or []),
            "row_count": len(data.get("rows") or []),
        },
    }
    source["content_version"] = "sha256:" + source["sha256"]
    return source


def _workbook_source_info(workbook, path=None, data_base64=None):
    source = json.loads(json.dumps(workbook.get("source_info") or {}, ensure_ascii=False))
    source.update({
        "kind": "workbook",
        "locator": str(Path(path).resolve()) if path is not None else source.get("file_name"),
        "locator_kind": "local_path" if path is not None else "provided_base64_bytes",
        "input_mode": "local_file_bytes" if path is not None else "provided_base64_bytes",
        "source_identity": "provided_workbook_not_publication_verification",
        "verification_status": "input_bytes_hashed_unverified_origin",
        "value_fingerprint": {
            "algorithm": "canonical_columns_rows_json_sha256",
            "sha256": _table_value_sha256(workbook["data"]),
            "columns": list(workbook["data"].get("columns") or []),
            "row_count": len(workbook["data"].get("rows") or []),
        },
    })
    source.setdefault("version", None)
    source["content_version"] = "sha256:" + source["sha256"]
    return source


def _parse_data_source_with_info(source, where="data"):
    """Parse one explicit source without changing its table shape or rows."""
    if not isinstance(source, dict):
        raise ToolError("%s 必须是对象（csv/json/inline/path/xlsx_base64 五选一）" % where)
    present = [key for key in ("csv", "json", "inline", "path", "xlsx_base64")
               if source.get(key) is not None]
    if len(present) > 1:
        raise ToolError("%s 同时提供多个数据源（%s）；必须且只能选择一个"
                        % (where, "、".join(present)))
    if "csv" in source and source["csv"] is not None:
        text = str(source["csv"])
        data = bcall("data.parse_csv", text=text)
        return data, _text_source_info(data, "csv", text.encode("utf-8"))
    if "json" in source and source["json"] is not None:
        text = str(source["json"])
        data = bcall("data.parse_json", text=text)
        return data, _text_source_info(data, "json", text.encode("utf-8"))
    if "inline" in source and source["inline"] is not None:
        inline = source["inline"]
        if not isinstance(inline, dict) or "columns" not in inline or "rows" not in inline:
            raise ToolError("inline 数据必须是 {columns:[...], rows:[[...]]} 结构")
        info = inline.get("source_info")
        if isinstance(info, dict):
            info = json.loads(json.dumps(info, ensure_ascii=False, allow_nan=False))
        else:
            info = {
                "kind": "inline",
                "locator": inline.get("source_ref") or inline.get("ref"),
                "version": inline.get("version"),
                "verification_status": "inline_values_unverified",
                "source_identity": "provided_inline_values_not_file_verification",
            }
        info["value_fingerprint"] = {
            "algorithm": "canonical_columns_rows_json_sha256",
            "sha256": _table_value_sha256(inline),
            "columns": list(inline.get("columns") or []),
            "row_count": len(inline.get("rows") or []),
        }
        return inline, info
    if present and present[0] == "path" \
            and Path(str(source["path"])).suffix.lower() not in SPREADSHEET_EXTENSIONS:
        path = _resolve_data_path(source["path"])
        if Path(path).suffix.lower() not in (".csv", ".json", ".tsv"):
            raise ToolError("文本数据路径只允许显式 .csv/.json/.tsv 文件；不按路径引用读取其他文件")
        with open(path, "rb") as stream:
            raw = stream.read()
        text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
        kind = "json" if path.lower().endswith(".json") else "csv"
        data = bcall("data.parse_csv", text=text) if kind == "csv" \
            else bcall("data.parse_json", text=text)
        return data, _text_source_info(data, kind, raw, path=path)
    if present and present[0] in ("path", "xlsx_base64"):
        workbook = _open_spreadsheet_source(
            path=source.get("path"), data_base64=source.get("xlsx_base64"),
            file_name=source.get("file_name"), sheet=_sheet_argument(source),
            header_row=source.get("header_row"))
        return workbook["data"], _workbook_source_info(
            workbook, path=source.get("path"), data_base64=source.get("xlsx_base64"))
    raise ToolError("%s 必须提供 csv、json、inline、path 或 xlsx_base64 之一" % where)


def _parse_data_source(source, where="data"):
    return _parse_data_source_with_info(source, where)[0]


def _attach_source_to_elements(elements, source_info):
    if not isinstance(source_info, dict):
        return
    for element in elements:
        if not isinstance(element, dict) or element.get("type") != "chart":
            continue
        chart = element.get("chart")
        if not isinstance(chart, dict) or not isinstance(chart.get("data"), dict):
            continue
        stored = json.loads(json.dumps(source_info, ensure_ascii=False, allow_nan=False))
        chart["data"]["source_info"] = stored
        if stored.get("locator"):
            chart["data"]["source_ref"] = stored["locator"]
            chart["data"]["ref"] = stored["locator"]
        if stored.get("version") is not None:
            chart["data"]["version"] = str(stored["version"])


def _doc_with_source_metadata(doc, source_info):
    if not isinstance(source_info, dict):
        return doc
    work = json.loads(json.dumps(doc, ensure_ascii=False, allow_nan=False))
    metadata = work.setdefault("meta", {})
    sources = metadata.get("data_sources")
    if not isinstance(sources, list):
        sources = []
    sources.append(json.loads(json.dumps(source_info, ensure_ascii=False)))
    metadata["data_sources"] = sources
    metadata["source_info"] = json.loads(json.dumps(source_info, ensure_ascii=False))
    return work


def tool_figure_open_data(a):
    present = [key for key in ("csv", "json", "path", "xlsx_base64")
               if a.get(key) is not None]
    if len(present) > 1:
        raise ToolError("同时提供多个数据源（%s）；必须且只能选择 csv/json/path/xlsx_base64 之一"
                        % "、".join(present))
    if a.get("xlsx_base64") is not None:
        return _spreadsheet_preview(
            data_base64=a.get("xlsx_base64"), file_name=a.get("file_name"),
            sheet=_sheet_argument(a), header_row=a.get("header_row"),
            include_unsupported=a.get("include_unsupported", False))
    if a.get("csv") is not None:
        text, kind = str(a["csv"]), "csv"
    elif a.get("json") is not None:
        text, kind = str(a["json"]), "json"
    elif a.get("path"):
        path = _resolve_data_path(a["path"])
        if Path(path).suffix.lower() in SPREADSHEET_EXTENSIONS:
            return _spreadsheet_preview(
                path=path, sheet=_sheet_argument(a), header_row=a.get("header_row"),
                include_unsupported=a.get("include_unsupported", False))
        if Path(path).suffix.lower() not in (".csv", ".json", ".tsv"):
            raise ToolError("文本数据路径只允许显式 .csv/.json/.tsv 文件；不按路径引用读取其他文件")
        with open(path, "r", encoding="utf-8-sig") as f:
            text = f.read()
        kind = "json" if path.lower().endswith(".json") else "csv"
    else:
        raise ToolError("必须提供 csv、json、path 或 xlsx_base64 之一")
    parsed = bcall("data.parse_csv", text=text) if kind == "csv" else bcall("data.parse_json", text=text)
    stats = bcall("data.column_stats", data=parsed)
    return {"ok": True, "columns": parsed.get("columns", []), "stats": stats,
            "recommended": _capability_recommendations(
                stats, a.get("include_unsupported", False))}


def _chart_slot_binding(doc, elements, args):
    scene_id = args.get("scene_id")
    node_id = args.get("node_id")
    for name, value in (("scene_id", scene_id), ("node_id", node_id)):
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ToolError("%s 必须是非空字符串" % name)
    slots = bcall("diagram.chart_slots", doc=doc, scene_id=scene_id)
    if not isinstance(slots, list):
        raise ToolError("chart slot 查询返回格式异常，未修改文档")
    candidates = [slot for slot in slots if node_id is None or slot.get("node_id") == node_id]
    if not candidates:
        if scene_id is not None or node_id is not None:
            available = ["%s/%s" % (slot.get("scene_id"), slot.get("node_id")) for slot in slots]
            raise ToolError("CHART_SLOT_NOT_FOUND: 找不到 scene_id=%r node_id=%r；已声明 slot=%s"
                            % (scene_id, node_id, available))
        return elements, None, None
    if len(candidates) != 1:
        choices = [{"scene_id": slot.get("scene_id"), "node_id": slot.get("node_id")}
                   for slot in candidates]
        raise ToolError("CHART_SLOT_AMBIGUOUS: 多个显式数据 slot；必须同时提供 scene_id 与 node_id；可选=%s"
                        % json.dumps(choices, ensure_ascii=False))
    slot = candidates[0]
    if args.get("transform") is not None:
        raise ToolError("CHART_SLOT_TRANSFORM_CONFLICT: 绑定 slot 时使用其真实 bbox，请省略 transform")
    charts = [el for el in elements if isinstance(el, dict) and el.get("type") == "chart"]
    if len(charts) != 1:
        raise ToolError("CHART_SLOT_SINGLE_CHART_REQUIRED: 一个 slot 只接受模板/生成链产生的单个 chart；"
                        "只提取真实 chart，不提交其默认大 panel、标题或多面板覆盖")
    chart = charts[0].get("chart")
    if not isinstance(chart, dict) or not chart.get("chartType"):
        raise ToolError("CHART_SLOT_DATA_REQUIRED: 空白复合 layout 不能冒充已填数据 slot，请提供有真实 chartType 的数据图")
    generated_ids = slot.get("generated_chart_ids") or []
    if len(generated_ids) > 1:
        raise ToolError("CHART_SLOT_CONFLICT: 同 slot 存在多个 plugin-owned chart，未删除任何用户内容：%s"
                        % generated_ids)
    old_id = generated_ids[0] if generated_ids else None
    stable_id = old_id or "diagram-%s:slot:%s:chart" % (slot["scene_id"], slot["node_id"])
    occupied = {el.get("id") for el in doc.get("elements") or [] if isinstance(el, dict)}
    if stable_id in occupied and stable_id != old_id:
        raise ToolError("ELEMENT_ID_CONFLICT: slot 稳定 chart id 已被其他内容占用：%s" % stable_id)
    bound = charts[0]
    bound["id"] = stable_id
    bound["parent_id"] = slot["parent_id"]
    bound["transform"] = json.loads(json.dumps(slot["transform"]))
    bound["z"] = max([el.get("z", 0) for el in doc.get("elements") or []
                      if isinstance(el, dict) and isinstance(el.get("z", 0), (int, float))] or [0]) + 1
    bound["diagram_id"] = slot["scene_id"]
    bound["diagramId"] = slot["scene_id"]
    bound["diagramNodeId"] = slot["node_id"]
    bound["diagram_part"] = "slot_chart"
    bound["diagram_slot_id"] = slot["node_id"]
    bound["slot_generated_chart"] = True
    bound["semantic_node"] = {"id": slot["node_id"]}
    bound["source_claim"] = "user_provided_unverified"
    bound["intentional_overlap"] = {"element_id": slot["slot_element_id"], "declared": True,
                                   "reason": "chart contained by explicit declared data slot"}
    binding = {"scene_id": slot["scene_id"], "node_id": slot["node_id"],
               "slot_element_id": slot["slot_element_id"], "chart_element_id": stable_id,
               "coordinate_space": "element-mm", "transform": bound["transform"],
               "replaces_owned_chart_id": old_id, "user_content_preserved": True}
    return [bound], ({"delete_chart_id": old_id} if old_id else {}), binding


def _layout_audit_result(doc):
    result = bcall("diagram.audit", doc=doc)
    if not isinstance(result, dict) or not isinstance(result.get("warnings"), list):
        raise ToolError("diagram.audit 返回格式异常")
    return result


def tool_figure_create_chart(a):
    doc = _require_doc(a)
    parsed, source_info = _parse_data_source_with_info(a.get("data"))
    parsed_before = json.loads(json.dumps(parsed, ensure_ascii=False, allow_nan=False))
    stats = bcall("data.column_stats", data=parsed)
    warnings = []
    chart_type = a.get("chart_type")
    mapping = None
    if not chart_type:
        infer = bcall("data.infer_chart_type", column_stats=stats)
        chart_type = infer.get("chart_type")
        mapping = infer.get("mapping")
        for r in infer.get("reasons", []):
            warnings.append("自动推断图表类型为 %s：%s" % (chart_type, r))
        if not chart_type:
            raise ToolError("无法从数据推断图表类型，请显式指定 chart_type")
    template_id = a.get("template_id")
    if not template_id:
        tpl = _template_by_chart_type(chart_type)
        template_id = tpl.get("id") if tpl else None
    if template_id:
        template = _require_template_applicable(template_id)
        if template["capability"] == "layout":
            warnings.append(_TEMPLATE_CAPABILITY_NOTES["layout"])
        built = bcall("presets.template_from_stats", template_id=template_id, data=parsed,
                      journal_id=a.get("journal_id"), palette_id=a.get("palette_id"))
        if isinstance(built, dict) and "elements" in built:
            elements = built["elements"]
            warnings.extend(built.get("warnings") or [])
        else:
            elements = [built]
    else:
        _require_chart_renderable(chart_type)
        element = bcall("data.make_chart_element", data=parsed, chart_type=chart_type, mapping=mapping,
                        journal_id=a.get("journal_id"), palette_id=a.get("palette_id"),
                        transform=a.get("transform"))
        elements = [element]
    if not isinstance(elements, list) or not elements:
        raise ToolError("模板/图表元素生成失败，未得到任何元素")
    if not _json_deep_equal(parsed, parsed_before):
        raise ToolError("数据导入过程中 columns/rows 被意外修改，已停止建图")
    _attach_source_to_elements(elements, source_info)
    doc = _doc_with_source_metadata(doc, source_info)
    elements, replacement, binding = _chart_slot_binding(doc, elements, a)
    ops = []
    if replacement and replacement.get("delete_chart_id"):
        ops.append({"op": "delete", "targets": [replacement["delete_chart_id"]]})
    ops.extend({"op": "add_element", "element": el}
               for el in _order_elements_parents_first(elements) if isinstance(el, dict))
    doc, _applied = _apply_ops_with_history(
        doc, ops, "绑定数据 slot（%s）" % chart_type if binding else "创建图表（%s）" % chart_type, "template")
    layout_audit = _layout_audit_result(doc)
    warnings.extend(layout_audit["warnings"])
    payload = {"ok": True, "doc": doc, "warnings": warnings, "source_info": source_info,
               "capability": template["capability"] if template_id else "full",
               "layout_audit": layout_audit, "slot_binding": binding,
               "status": "partial_layout_review" if layout_audit["warnings"] else "ready_for_human_review"}
    if template_id:
        payload["template_id"] = template_id
    return payload


def tool_figure_apply_edits(a):
    doc = _require_doc(a)
    ops = a.get("ops")
    if not isinstance(ops, list) or not ops:
        raise ToolError("ops 必须是非空的 EditOp 数组")
    for i, op in enumerate(ops):
        if not isinstance(op, dict) or "op" not in op:
            return {"ok": False,
                    "error": "第 %d 条不是有效 EditOp（缺少 op 字段），未做任何修改" % (i + 1),
                    "errors": ["第 %d 条不是有效 EditOp（缺少 op 字段）" % (i + 1)], "doc": doc}
    layout_warnings = []
    # 内核 validateAll 按操作顺序模拟父子链；非法批次保留原始 ops[i] 索引，
    # applyAll 对有效批次统一规范化并只生成一条事务历史。
    try:
        for op in ops:
            if op.get("op") == "apply_template":
                template = _require_template_applicable(op.get("template_id"))
                note = _TEMPLATE_CAPABILITY_NOTES[template["capability"]]
                if note not in layout_warnings:
                    layout_warnings.append(note)
        doc, applied = _apply_ops_with_history(doc, ops, "AI 编辑（%d 条）" % len(ops), "ai")
    except ToolError as e:
        msg = "%s；整批未应用（不部分应用）" % e
        return {"ok": False, "error": msg, "errors": [msg], "doc": doc}
    return {"ok": True, "doc": doc, "applied": applied, "errors": [],
            "warnings": layout_warnings}


def tool_figure_apply_journal(a):
    doc = _require_doc(a)
    jid = a.get("journal_id")
    if not jid:
        raise ToolError("缺少 journal_id")
    if _journal_preset(jid) is None:
        raise ToolError("未找到期刊预设：%s（可用 id 见 figure_journals）" % jid)
    pre_doc = json.loads(json.dumps(doc, ensure_ascii=False))
    res = bcall("presets.apply_canvas", preset_id=jid, doc=doc)
    doc, extra = _as_doc_result(res, "presets.apply_canvas")
    op = extra.get("op")
    if isinstance(op, dict):
        doc = _record_history(doc, [op], "套用期刊预设 %s" % jid, "preset",
                              pre_doc=pre_doc)
    return {"ok": True, "doc": doc, "warnings": extra.get("warnings") or []}


def tool_figure_recolor(a):
    doc = _require_doc(a)
    pid = a.get("palette_id")
    if not pid:
        raise ToolError("缺少 palette_id")
    op = {"op": "recolor", "palette_id": pid,
          "recolor_strategy": a.get("strategy") or "byHue"}
    doc, _ = _apply_ops_with_history(doc, [op], "重新配色 → %s" % pid, "user")
    return {"ok": True, "doc": doc}


def _fresh_anchor_id(doc):
    """生成文档内不重复的锚点 id（anchor-xxxxxx）。"""
    existing = set()
    if isinstance(doc, dict):
        existing = {anc.get("id") for anc in doc.get("anchors", []) if isinstance(anc, dict)}
    for _ in range(100):
        cand = "anchor-%s" % os.urandom(3).hex()
        if cand not in existing:
            return cand
    return "anchor-%d" % int(time.time() * 1000)


def tool_figure_add_anchor(a):
    doc = _require_doc(a)
    label = a.get("label")
    if not label:
        raise ToolError("缺少 label（锚点标签，如 (a)、主标题）")
    anchor = {"label": label, "id": _fresh_anchor_id(doc)}
    if a.get("bbox_mm") is not None:
        anchor["bbox_mm"] = a["bbox_mm"]
    elif a.get("bbox_norm") is not None:
        anchor["bbox_norm"] = a["bbox_norm"]
    else:
        raise ToolError("必须提供 bbox_norm 或 bbox_mm 之一")
    if a.get("note") is not None:
        anchor["note"] = a["note"]
    if a.get("element_ids") is not None:
        anchor["element_ids"] = a["element_ids"]
    old_ids = {anc.get("id") for anc in doc.get("anchors", []) if isinstance(anc, dict)}
    op = {"op": "add_anchor", "anchor": anchor}
    doc, _ = _apply_ops_with_history(doc, [op], "添加锚点 %s" % label, "user")
    new_anchor = None
    for anc in doc.get("anchors", []):
        if isinstance(anc, dict) and anc.get("id") not in old_ids:
            new_anchor = anc
            break
    if new_anchor is None:
        for anc in reversed(doc.get("anchors", [])):
            if isinstance(anc, dict) and anc.get("label") == label:
                new_anchor = anc
                break
    return {"ok": True, "doc": doc, "anchor": new_anchor}


def tool_figure_anchors(a):
    doc = _require_doc(a)
    out = []
    for anc in doc.get("anchors", []):
        if not isinstance(anc, dict):
            continue
        out.append({
            "id": anc.get("id"),
            "label": anc.get("label"),
            "bbox_mm": anc.get("bbox_mm"),
            "note": anc.get("note"),
            "element_ids": anc.get("element_ids") or [],
        })
    return {"ok": True, "anchors": out}


def tool_figure_place(a):
    doc = _require_doc(a)
    target = a.get("target")
    if not target:
        raise ToolError("缺少 target（元素 id 或 @锚点id）")
    if a.get("x_mm") is None or a.get("y_mm") is None:
        raise ToolError("缺少 x_mm / y_mm（绝对坐标，单位 mm）")
    ops = [{"op": "move", "targets": [target], "x": a["x_mm"], "y": a["y_mm"]}]
    if a.get("w_mm") is not None or a.get("h_mm") is not None:
        resize = {"op": "resize", "targets": [target]}
        if a.get("w_mm") is not None:
            resize["w"] = a["w_mm"]
        if a.get("h_mm") is not None:
            resize["h"] = a["h_mm"]
        ops.append(resize)
    doc, _ = _apply_ops_with_history(doc, ops, "放置 %s" % target, "user")
    return {"ok": True, "doc": doc}


def tool_figure_panel_layout(a):
    doc = _require_doc(a)
    panel_id = a.get("panel_id")
    if not panel_id:
        raise ToolError("缺少 panel_id")
    cols, rows = a.get("cols"), a.get("rows")
    if not isinstance(cols, int) or cols < 1 or not isinstance(rows, int) or rows < 1:
        raise ToolError("cols / rows 必须是 ≥1 的整数")
    panel = {"cols": cols, "rows": rows, "gap_mm": a.get("gap_mm", 2)}
    labels = a.get("labels")
    if isinstance(labels, str):
        panel["label"] = labels
    elif isinstance(labels, list):
        panel["labels"] = labels
    op = {"op": "panel_layout", "targets": [panel_id], "panel": panel}
    doc, _ = _apply_ops_with_history(doc, [op], "面板布局 %d×%d" % (cols, rows), "user")
    return {"ok": True, "doc": doc}


def tool_figure_check(a):
    doc = _require_doc(a)
    res = bcall("presets.check", doc=doc)
    layout_audit = _layout_audit_result(doc)
    warnings = (res.get("warnings") or []) if isinstance(res, dict) else []
    warnings = list(warnings) + layout_audit["warnings"]
    return {"ok": bool(res.get("ok", True)) if isinstance(res, dict) else True,
            "warnings": warnings, "layout_audit": layout_audit,
            "human_visual_review": "not_performed"}


def _validate_export_panel(doc, panel_id):
    if panel_id is None:
        return None
    if not isinstance(panel_id, str) or not panel_id.strip():
        raise ValueError("panel_id 必须是非空的 panel 或 chart 元素 id")
    matches = [el for el in doc.get("elements") or []
               if isinstance(el, dict) and el.get("id") == panel_id]
    if not matches:
        raise ValueError("找不到要单独导出的 panel 或 chart：%s" % panel_id)
    if len(matches) != 1:
        raise ValueError("panel_id 在 doc 中不唯一：%s" % panel_id)
    element = matches[0]
    if element.get("type") not in ("panel", "chart"):
        raise ValueError("panel_id 必须指向 type=panel 或 type=chart 的元素，实际为 %s：%s"
                         % (element.get("type"), panel_id))
    if element.get("visible") is False:
        name = "panel" if element.get("type") == "panel" else "chart 子图"
        raise ValueError("选中的%s不可见，无法单独导出：%s" % (name, panel_id))
    return panel_id


def _export_scope_element(doc, panel_id):
    if panel_id is None:
        return None
    return next(el for el in doc.get("elements") or []
                if isinstance(el, dict) and el.get("id") == panel_id)


def _charts_for_render(doc, panel_id=None):
    elements = [el for el in doc.get("elements") or []
                if isinstance(el, dict) and el.get("type") == "chart"]
    if panel_id is None:
        return elements
    scope = _export_scope_element(doc, panel_id)
    if scope.get("type") == "chart":
        return [scope]
    descendants = set()

    def collect(element):
        if not isinstance(element, dict):
            return
        for child_id in element.get("children") or []:
            if child_id not in descendants:
                descendants.add(child_id)
                collect(next((el for el in doc.get("elements") or []
                              if isinstance(el, dict) and el.get("id") == child_id), None))

    collect(scope)
    return [el for el in elements if el.get("id") in descendants]


def _is_empty_layout_chart(chart):
    if not isinstance(chart, dict) or chart.get("chartType") is not None:
        return False
    mapping = chart.get("mapping") if isinstance(chart.get("mapping"), dict) else {}
    if any(value not in (None, "") for value in mapping.values()):
        return False
    data = chart.get("data") if isinstance(chart.get("data"), dict) else {}
    inline = data.get("inline") if isinstance(data.get("inline"), dict) else None
    return inline is None or not isinstance(inline.get("rows"), list) or not inline["rows"]


def _chart_scope_box(doc, chart):
    transform = chart.get("transform") or {}
    try:
        box = {name: float(transform[name]) for name in ("x", "y", "w", "h")}
    except (KeyError, TypeError, ValueError) as exc:
        raise ToolError("chart 子图缺少有效 transform，无法单独导出：%s"
                        % chart.get("id")) from exc
    if not all(math.isfinite(value) for value in box.values()) \
            or box["w"] <= 0 or box["h"] <= 0:
        raise ToolError("chart 子图导出范围必须是有限正数：%s" % chart.get("id"))
    style = chart.get("style") if isinstance(chart.get("style"), dict) else {}
    parent = next((el for el in doc.get("elements") or []
                   if isinstance(el, dict) and el.get("id") == chart.get("parent_id")), None)
    if style.get("panelRelative") is True and parent is not None \
            and parent.get("type") == "panel":
        parent_box = parent.get("transform") or {}
        layout = parent.get("panelLayout") or {}
        try:
            padding = float(layout.get("padding_mm", 0))
            px = float(parent_box["x"])
            py = float(parent_box["y"])
            pw = float(parent_box["w"])
            ph = float(parent_box["h"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ToolError("chart 子图的父 panel 几何非法，无法单独导出：%s"
                            % chart.get("id")) from exc
        if not math.isfinite(padding) or padding < 0:
            padding = 0.0
        inner_w = max(0.0, pw - 2 * padding)
        inner_h = max(0.0, ph - 2 * padding)
        box = {"x": px + padding + box["x"] * inner_w,
               "y": py + padding + box["y"] * inner_h,
               "w": box["w"] * inner_w, "h": box["h"] * inner_h}
    for name, value in list(box.items()):
        rounded = math.floor(value * 1000 + 0.5) / 1000
        box[name] = 0.0 if rounded == 0 else rounded
    if box["w"] <= 0 or box["h"] <= 0:
        raise ToolError("chart 子图导出范围舍入后无效：%s" % chart.get("id"))
    return box


def _svg_scope_number(value):
    if value == int(value):
        return str(int(value))
    return ("%.3f" % value).rstrip("0").rstrip(".")


def _crop_chart_svg(svg, doc, chart_id):
    chart = _export_scope_element(doc, chart_id)
    box = _chart_scope_box(doc, chart)
    try:
        root = ET.fromstring(svg)
    except (ET.ParseError, TypeError, ValueError) as exc:
        raise ToolError("chart 子图 SVG 裁剪失败：%s" % exc) from exc
    width = _svg_scope_number(box["w"])
    height = _svg_scope_number(box["h"])
    root.set("width", width + "mm")
    root.set("height", height + "mm")
    root.set("viewBox", " ".join(_svg_scope_number(box[name])
                                 for name in ("x", "y", "w", "h")))
    background = doc.get("canvas", {}).get("background")
    if isinstance(background, str) and background not in ("", "none"):
        for child in root:
            if child.tag.rsplit("}", 1)[-1].lower() != "rect" \
                    or set(child.attrib) != {"x", "y", "width", "height", "fill"} \
                    or child.get("fill") != background:
                continue
            child.set("x", _svg_scope_number(box["x"]))
            child.set("y", _svg_scope_number(box["y"]))
            child.set("width", width)
            child.set("height", height)
            break
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
    return ET.tostring(root, encoding="unicode", short_empty_elements=True)


def _render_svg(doc, panel_id=None):
    try:
        panel_id = _validate_export_panel(doc, panel_id)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    scope = _export_scope_element(doc, panel_id)
    charts = _charts_for_render(doc, panel_id)
    empty_layout_charts = []
    for element in charts:
        chart = element.get("chart")
        if _is_empty_layout_chart(chart):
            empty_layout_charts.append(element)
            continue
        if not isinstance(chart, dict):
            raise ToolError("图表元素 %s 缺少 chart 对象，已停止真实渲染"
                            % element.get("id"))
        _require_chart_renderable(chart.get("chartType"))
    opts = {"doc": doc, "scale": 1}
    if scope is not None and scope.get("type") == "panel":
        opts["panel_id"] = panel_id
    svg = bcall("render.to_svg", **opts)
    if isinstance(svg, dict):
        svg = svg.get("svg") or svg.get("result")
    if not isinstance(svg, str) or "<svg" not in svg:
        raise ToolError("渲染结果异常：未得到有效的 SVG 字符串")
    if ('data-render="unsupported-preview"' in svg
            or "data-render='unsupported-preview'" in svg):
        raise ToolError("不支持真实生成的 unsupported-preview 只能用于界面示意，"
                        "已停止 render/export，禁止作为成功结果返回或写盘")
    if "需 v2" in svg or 'data-render="placeholder"' in svg:
        if empty_layout_charts and len(empty_layout_charts) == len(charts):
            svg = svg.replace("该图表类型需 v2 服务端渲染", "空版式（未填图）")
        else:
            raise ToolError(
                "一个或多个图表的数据、映射或 chartType 无法被当前 FigData 真实绘制；"
                "已停止 render/export，不会把“需 v2”占位图冒充成功结果。")
    if scope is not None and scope.get("type") == "chart":
        svg = _crop_chart_svg(svg, doc, panel_id)
    return svg


_SVG_LENGTH = re.compile(
    r"^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*"
    r"(mm|cm|in|pt|pc|px)?\s*$")


def _svg_physical_dimensions(svg):
    """Return physical millimetres from the rendered root, never from doc.canvas."""
    try:
        root = ET.fromstring(svg)
    except (ET.ParseError, TypeError, ValueError) as exc:
        raise ToolError("渲染结果不是可解析的 SVG：%s" % exc) from exc
    if not isinstance(root.tag, str) or root.tag.rsplit("}", 1)[-1].lower() != "svg":
        raise ToolError("渲染结果异常：XML root 不是 svg")
    dimensions = []
    for name in ("width", "height"):
        raw = root.get(name)
        if raw is None:
            raw = root.get(name + "_mm")
            if raw is not None:
                raw = str(raw) + "mm"
        match = _SVG_LENGTH.fullmatch(str(raw or ""))
        if match is None:
            raise ToolError("SVG root 的 %s 缺少有效的物理尺寸" % name)
        value = float(match.group(1))
        unit = match.group(2) or "mm"
        factor = {"mm": 1.0, "cm": 10.0, "in": 25.4,
                  "pt": 25.4 / 72.0, "pc": 25.4 / 6.0,
                  "px": 25.4 / 96.0}[unit]
        value *= factor
        if not math.isfinite(value) or value <= 0:
            raise ToolError("SVG root 的 %s 必须是有限正数物理尺寸" % name)
        dimensions.append(value)
    return tuple(dimensions)


def tool_figure_render(a):
    doc = _require_doc(a)
    fmt = a.get("format", "svg")
    if fmt != "svg":
        raise ToolError("figure_render 目前仅支持 format=svg，位图/PDF 请用 figure_export")
    return {"ok": True, "svg": _render_svg(doc)}


def _export_filename(doc, ext, dpi, size_mm=None, panel_id=None):
    title = doc.get("title") or doc.get("id") or "figure"
    safe = re.sub(r'[\\/:*?"<>|\s]+', "_", str(title)).strip("._") or "figure"
    if panel_id is not None:
        scope_id = re.sub(r'[\\/:*?"<>|\s]+', "_", str(panel_id)).strip("._") or "scope"
        scope = _export_scope_element(doc, panel_id)
        kind = scope.get("type") if isinstance(scope, dict) else "panel"
        safe += "_" + kind + "-" + scope_id
    if size_mm is None:
        canvas = doc.get("canvas", {})
        size_mm = (canvas.get("width_mm", 0), canvas.get("height_mm", 0))
    return "%s_%gx%gmm_%gdpi.%s" % (safe, size_mm[0], size_mm[1], dpi, ext)


def _suggest_out_path(doc, ext, dpi=None, size_mm=None, panel_id=None):
    if dpi is None:
        dpi = doc.get("canvas", {}).get("dpi", 300)
    return os.path.join(os.getcwd(), _export_filename(doc, ext, dpi, size_mm, panel_id))


def tool_figure_export(a):
    doc = _require_doc(a)
    fmt = str(a.get("format") or "").lower()
    if fmt not in ("png", "jpeg", "tiff", "pdf", "svg"):
        raise ToolError("format 必须是 png/jpeg/tiff/pdf/svg 之一")
    transparent = a.get("transparent", False)
    if not isinstance(transparent, bool):
        raise ToolError("transparent 必须是布尔值")
    if transparent and fmt != "png":
        raise ToolError("transparent=true 仅支持 PNG；%s 请显式设置 transparent=false 或省略" % fmt)
    errors = _validate_doc(doc)
    if errors:
        raise ToolError("文档结构校验未通过，已停止导出：" + "；".join(errors))
    canvas = doc.get("canvas", {})
    dpi_raw = a.get("dpi")
    if dpi_raw in (None, ""):
        dpi_raw = canvas.get("dpi") or 300
    try:
        dpi = float(dpi_raw)
    except (TypeError, ValueError):
        raise ToolError("dpi 必须是数字，实际为 %r" % dpi_raw)
    if not math.isfinite(dpi) or dpi <= 0:
        raise ToolError("dpi 必须大于 0，实际为 %r" % dpi_raw)
    try:
        panel_id = _validate_export_panel(doc, a.get("panel_id"))
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    svg = _render_svg(doc, panel_id=panel_id)
    size_mm = _svg_physical_dimensions(svg)
    supplied_path = a.get("out_path")
    out_path = supplied_path or _suggest_out_path(
        doc, fmt if fmt != "jpeg" else "jpg", dpi=dpi,
        size_mm=size_mm, panel_id=panel_id)
    if fmt == "svg":
        p = Path(out_path)
        if p.parent and str(p.parent):
            os.makedirs(str(p.parent), exist_ok=True)
        with open(str(p), "w", encoding="utf-8") as f:
            f.write(svg)
    else:
        if FIGRASTER is None or not callable(getattr(FIGRASTER, "export_svg", None)):
            raise ToolError("未找到 py/figraster.py（或其缺少 export_svg 函数），无法导出 %s。"
                            "请确认 v3-agent-plugin/py/figraster.py 存在。" % fmt)
        try:
            written = FIGRASTER.export_svg(
                svg, doc, str(out_path), fmt, dpi=dpi,
                panel_id=panel_id, transparent=transparent)
        except Exception as e:
            raise ToolError("导出 %s 失败：%s" % (fmt, e))
        out_path = str(written) if written else str(out_path)
    if not os.path.isfile(out_path):
        raise ToolError("导出后未找到文件：%s" % out_path)
    n_bytes = os.path.getsize(out_path)
    px_w = int(math.ceil(size_mm[0] * float(dpi) / 25.4))
    px_h = int(math.ceil(size_mm[1] * float(dpi) / 25.4))
    return {"ok": True, "path": os.path.abspath(out_path), "bytes": n_bytes,
            "px": {"width": px_w, "height": px_h}}


def tool_figure_review(a):
    doc = _require_doc(a)
    journal_preset = _journal_preset(a.get("journal_id")) if a.get("journal_id") else None
    if a.get("journal_id") and journal_preset is None:
        raise ToolError("未找到期刊预设：%s（可用 id 见 figure_journals）" % a.get("journal_id"))
    build_messages_only = a.get("build_messages_only") is True
    img = a.get("png_base64")
    if build_messages_only and img is not None:
        raise ToolError("build_messages_only=true 是 DSH host 的纯文本结构化审阅模式，"
                        "不能与 png_base64 同时使用")
    image_data_url = _validate_review_image(img) if img is not None else None
    # build_messages_only 与 model_response 同为 host 内部字段，不进公开 input_schema。
    if build_messages_only:
        check = bcall("presets.check", doc=doc)
        messages = bcall("ai.build_review_messages", doc=doc, image_data_url=None,
                         journal_preset=journal_preset, check_result=check)
        if not isinstance(messages, list) or not messages:
            raise ToolError("ai.build_review_messages 未返回非空 messages 数组")
        for index, message in enumerate(messages):
            if not isinstance(message, dict) or not isinstance(message.get("role"), str) \
                    or not isinstance(message.get("content"), str):
                raise ToolError("审阅 messages[%d] 必须包含字符串 role/content" % index)
        return {"ok": True, "messages": messages}
    # DSH host 侧已用 ctx.llm（harness 自带的 DeepSeek 连接）拿到模型响应，
    # 这里只负责把响应解析成结构化 items，不再需要插件自己持有 API key。
    model_response = a.get("model_response")
    if isinstance(model_response, str) and model_response.strip():
        items = _parse_json_items(model_response)
        if isinstance(items, dict):
            items = items.get("items", [])
        if not isinstance(items, list):
            raise ToolError("模型审阅结果不是数组（model_response 无法解析为 items）")
        return {"ok": True, "items": items, "mode": "model", "via": "harness"}
    if get_api_key():
        try:
            check = bcall("presets.check", doc=doc)
            messages = bcall("ai.build_review_messages", doc=doc, image_data_url=image_data_url,
                             journal_preset=journal_preset, check_result=check)
            content = _deepseek_chat(messages, image_data_url=image_data_url)
            items = _parse_json_items(content)
            if isinstance(items, dict):
                items = items.get("items", [])
            if not isinstance(items, list):
                raise ValueError("模型审阅结果不是数组")
            return {"ok": True, "items": items, "mode": "model"}
        except Exception as e:
            # 不打印 key；只记录失败原因后回退
            _log("figure_review 模型审阅失败，回退离线模式：%s: %s" % (e.__class__.__name__, e))
    res = bcall("ai.fallback_review", doc=doc, journal_preset=journal_preset)
    if isinstance(res, list):
        items, explanation = res, None
    elif isinstance(res, dict):
        items = res.get("items", res.get("result", []))
        explanation = res.get("explanation")
    else:
        items, explanation = [], None
    if not isinstance(items, list):
        items = []
    payload = {"ok": True, "items": items, "mode": "fallback"}
    if explanation:
        payload["explanation"] = explanation
    return payload


def tool_figure_history(a):
    doc = _require_doc(a)
    history = doc.get("history")
    if not isinstance(history, list):
        history = []
    return {"ok": True, "history": history}


def tool_figure_revert(a):
    doc = _require_doc(a)
    rev = a.get("rev")
    if not isinstance(rev, int) or rev < 0:
        raise ToolError("rev 必须是非负整数（目标版本号，见 figure_history）")
    work = json.loads(json.dumps(doc, ensure_ascii=False))
    if not isinstance(work.get("history"), list):
        work["history"] = []
    cur = _last_rev(work)
    if rev > cur:
        raise ToolError("目标版本不存在：%d（当前最新版本为 %d）" % (rev, cur))

    # 缓存命中是以目标 rev 的持久化历史哈希为身份，而不是 doc.id/rev。
    # 将精确内容作为该 rev 的 origin 交给 FigOps，历史追加、上限裁剪与
    # 裁剪时的 origin 推进仍由内核统一完成，不在 Python 逆向推算。
    meta = work.get("meta") if isinstance(work.get("meta"), dict) else {}
    original_origin = meta.get("history_origin")
    if isinstance(original_origin, dict):
        original_origin = json.loads(json.dumps(original_origin, ensure_ascii=False))
    snap = _snap_get(work, rev)
    replay_doc = work
    injected_origin = None
    if snap is not None:
        replay_doc = json.loads(json.dumps(work, ensure_ascii=False))
        replay_doc.setdefault("meta", {})["history_origin"] = {
            "rev": rev, "doc": snap,
        }
        injected_origin = replay_doc["meta"]["history_origin"]
    may_prune = len(work["history"]) >= MAX_HISTORY and any(
        not rec.get("checkpoint") for rec in work["history"] if isinstance(rec, dict))
    try:
        res = bcall("ops.revert", doc=replay_doc, rev=rev)
        content, _ = _as_doc_result(res, "ops.revert")
    except BridgeCallError as exc:
        origin = original_origin if isinstance(original_origin, dict) else {}
        origin_rev = origin.get("rev")
        if snap is None and isinstance(origin_rev, int) and rev < origin_rev:
            raise ToolError(
                "无法回到版本 %d：该旧工程只从 rev %d 建立了恢复检查点，"
                "且没有按目标 rev 历史哈希匹配的会话快照；更早的日志缺少"
                "可精确回放的基线。当前文档未改变；检查点及其后的版本仍可恢复。"
                % (rev, origin_rev)) from exc
        raise ToolError(
            "无法回到版本 %d：恢复检查点或历史重放失败：%s。"
            "当前文档未改变，请先导出工程备份并检查历史记录。"
            % (rev, str(exc))) from exc

    # 未发生裁剪时保留原工程的持久化基线，避免仅为使用会话缓存而缩窄
    # 跨进程可恢复范围。若内核已推进 origin，则绝不回滚其安全基线。
    if (injected_origin is not None and original_origin is not None and not may_prune
            and isinstance(original_origin.get("rev"), int)
            and original_origin["rev"] <= rev
            and isinstance(content.get("meta"), dict)
            and content["meta"].get("history_origin") == injected_origin):
        content["meta"]["history_origin"] = original_origin
    new_rev = _last_rev(content)
    _fill_sha256(content, new_rev)
    _snap_put(content, new_rev)
    return {"ok": True, "doc": content}


def tool_figure_save_project(a):
    doc = _require_doc(a)
    path = a.get("path")
    if not path:
        raise ToolError("缺少 path（工程文件保存路径）")
    written = _save_project_file(doc, str(path), a.get("assets") or {})
    return {"ok": True, "path": os.path.abspath(written)}


def tool_figure_load_project(a):
    path = a.get("path")
    if not path:
        raise ToolError("缺少 path（工程文件路径）")
    loaded = _load_project_file(str(path))
    doc = loaded.get("doc")
    history = loaded.get("history", doc.get("history", []) if isinstance(doc, dict) else [])
    if not isinstance(doc, dict) or "canvas" not in doc:
        raise ToolError("工程文件内容异常：未找到有效文档")
    return {"ok": True, "doc": doc, "history": history if isinstance(history, list) else []}


def tool_figure_open_viewer(a):
    port = _VIEWER_PORT["value"]
    url = "http://127.0.0.1:%d/" % port
    if not _probe_viewer(port):
        viewer_py = PLUGIN_DIR / "viewer.py"
        if viewer_py.is_file():
            cmd = [sys.executable, str(viewer_py), "--port", str(port)]
        else:
            cmd = [sys.executable, str(Path(__file__).resolve()), "--viewer", "--port", str(port)]
        flags = 0x00000008 | 0x08000000 if os.name == "nt" else 0  # DETACHED_PROCESS | CREATE_NO_WINDOW
        try:
            subprocess.Popen(cmd, cwd=str(PLUGIN_DIR), stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, creationflags=flags)
        except Exception as e:
            raise ToolError("查看器进程启动失败：%s。请手动运行 python mcp_server.py --viewer --port %d 查看输出。" % (e, port))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if _probe_viewer(port):
                break
            time.sleep(0.3)
        else:
            raise ToolError("查看器未能在 10 秒内就绪（端口 %d）。请手动运行 python mcp_server.py --viewer --port %d 检查。" % (port, port))
    if a.get("doc") is not None:
        _push_doc_to_viewer(port, a["doc"])
    return {"ok": True, "url": url}


# ---------------------------------------------------------------------------
# 科学论证合同（figure_scientific_contract / figure_scientific_audit）
#
# 真实统计数据唯一来源是各 chart 元素的 chart.statistics；合同的 statistics
# 映射仅是提交/展示载体，桥端 FigOps.set_scientific_contract 应用时逐条写入
# 对应 chart 并不在 meta 留镜像。查询响应里的 statistics 同样由 chart 派生。
# ---------------------------------------------------------------------------

_CONTRACT_EMPTY = {
    "schema_version": 1,
    "results_question": None,
    "figure_claim": None,
    "falsifier": None,
    "archetype": None,
    "hero_panel": None,
    "panels": [],
    "statistics": {},
}


def _derive_contract_view(doc):
    """合同查询视图：空轮廓为默认（结构一致），statistics 由 chart 派生。"""
    meta = doc.get("meta") or {}
    stored = meta.get("scientific_contract")
    view = dict(_CONTRACT_EMPTY)
    view["statistics"] = {}
    if isinstance(stored, dict):
        for k in ("schema_version", "results_question", "figure_claim", "falsifier",
                  "archetype", "hero_panel", "panels"):
            if k in stored:
                view[k] = stored[k]
    for el in doc.get("elements") or []:
        if not isinstance(el, dict) or el.get("type") != "chart":
            continue
        chart = el.get("chart") or {}
        stats = chart.get("statistics")
        if isinstance(stats, dict) and stats:
            view["statistics"][el.get("id")] = stats
    return view


def _chart_statistics_map(doc):
    out = {}
    for el in doc.get("elements") or []:
        if not isinstance(el, dict) or el.get("type") != "chart":
            continue
        stats = (el.get("chart") or {}).get("statistics")
        if isinstance(stats, dict) and stats:
            out[el.get("id")] = stats
    return out


def tool_figure_scientific_contract(a):
    doc = _require_doc(a)
    contract = a.get("contract")
    if not isinstance(contract, dict) or not contract:
        # 只读查询：不写历史、不修改 doc
        return {
            "ok": True,
            "contract": _derive_contract_view(doc),
            "statistics": _chart_statistics_map(doc),
            "doc": doc,
        }
    source = a.get("source") if a.get("source") in ("user", "ai") else "user"
    # 应用经桥 FigOps.set_scientific_contract（校验 + 撤销语义在内核内）；
    # 变更前文档先留底，供 _record_history 记 base_rev 会话快照（可 revert）
    pre_doc = json.loads(json.dumps(doc, ensure_ascii=False))
    res = bcall("science.apply_contract", doc=doc, input=contract)
    doc2, extra = _as_doc_result(res, "science.apply_contract")
    warnings = extra.get("warnings") or []
    # server 记一条 set_scientific_contract 历史，保证任何修改可 trace
    op = {"op": "set_scientific_contract", "contract": contract}
    doc2 = _record_history(doc2, [op], "更新科学论证合同", source, pre_doc=pre_doc)
    return {
        "ok": True,
        "doc": doc2,
        "contract": _derive_contract_view(doc2),
        "warnings": warnings,
    }


def tool_figure_scientific_audit(a):
    doc = _require_doc(a)
    res = bcall("science.audit", doc=doc)
    if not isinstance(res, dict):
        raise ToolError("桥调用 science.audit 返回结果格式异常")
    payload = {
        "ok": bool(res.get("ok")),
        "scientific_ready": bool(res.get("scientific_ready")),
        "coverage": res.get("coverage") or {},
        "warnings": res.get("warnings") or [],
    }
    if res.get("checks") is not None:
        payload["checks"] = res.get("checks")
    return payload


def tool_figure_schematic(a):
    contract = a.get("contract")
    if not isinstance(contract, dict):
        raise ToolError("contract 必须是包含显式 nodes/relations/sources 的对象；不会从名称臆造科学内容")
    preview = a.get("preview", False)
    if not isinstance(preview, bool):
        raise ToolError("preview 必须是布尔值")
    if a.get("doc") is not None:
        doc = _require_doc(a)
    else:
        doc, _ = _as_doc_result(bcall("doc.create"), "doc.create")
    built = bcall("diagram.build", doc=doc, spec=contract)
    if not isinstance(built, dict) or not isinstance(built.get("doc"), dict):
        raise ToolError("实体关系构建器返回格式异常，未提交修改")
    contract_id = built["doc"].get("meta", {}).get("diagrams", {})
    contract_id = next(iter(contract_id), contract.get("id") or "schematic")
    op = {"op": "apply_schematic", "contract": contract}
    committed, applied = _apply_ops_with_history(
        doc, [op], "实体—关系示意图（用户显式合同）", a.get("source") or "user")
    if not applied:
        committed = built["doc"]
    diagram_meta = committed.get("meta", {}).get("diagrams", {}).get(contract_id) or {}
    review_meta = diagram_meta.get("scientific_review") or {}
    result = {
        "ok": True, "doc": committed, "applied": applied,
        "warnings": built.get("warnings") or [],
        "diagram": diagram_meta or None,
        "status": "ready_for_structural_export",
        "scientific_validation": "not_performed",
        "human_review": review_meta.get("user_review_record"),
    }
    if preview:
        result["svg"] = _render_svg(committed)
    return result


def _diagram_lineage(doc):
    diagrams = []
    metadata = doc.get("meta") if isinstance(doc.get("meta"), dict) else {}
    raw = metadata.get("diagrams") if isinstance(metadata.get("diagrams"), dict) else {}
    by_id = {key: [] for key in raw}
    for element in doc.get("elements") or []:
        if not isinstance(element, dict):
            continue
        diagram_id = element.get("diagram_id") or element.get("diagramId")
        if diagram_id not in by_id:
            continue
        by_id[diagram_id].append({
            "element_id": element.get("id"), "type": element.get("type"),
            "parent_id": element.get("parent_id"),
            "node_id": element.get("diagramNodeId"),
            "semantic_relation": element.get("semantic_relation"),
            "connector_relation": element.get("relation"),
            "evidence": element.get("evidence") or element.get("source_refs") or [],
            "source_claim": element.get("source_claim") or "user_provided_unverified",
        })
    for diagram_id, meta in raw.items():
        diagrams.append({
            "id": diagram_id,
            "metadata": meta,
            "element_lookup": by_id.get(diagram_id) or [],
            "sources": meta.get("sources") or [],
            "warnings": meta.get("warnings") or [],
            "status": "provided_unverified" if meta.get("sources") else "partial_missing_sources",
            "human_review": None,
        })
    return diagrams


def _compare_imported_chart_values(doc, report):
    for record in report.get("charts") or []:
        if not isinstance(record, dict):
            continue
        element = next((item for item in doc.get("elements") or []
                        if isinstance(item, dict) and item.get("type") == "chart"
                        and item.get("id") == record.get("element_id")), None)
        data = ((element or {}).get("chart") or {}).get("data") or {}
        inline = data.get("inline") if isinstance(data.get("inline"), dict) else None
        source_info = data.get("source_info") if isinstance(data.get("source_info"), dict) else {}
        expected = source_info.get("value_fingerprint")
        comparison = {"status": "not_recorded", "value_matches_import": None,
                      "current_value_sha256": None, "imported_value_sha256": None,
                      "basis": "canonical columns/rows values, not source location"}
        if inline is not None:
            comparison["current_value_sha256"] = _table_value_sha256(inline)
        if isinstance(expected, dict) and isinstance(expected.get("sha256"), str) \
                and re.fullmatch(r"[0-9a-fA-F]{64}", expected["sha256"]) and inline is not None:
            imported_hash = expected["sha256"].lower()
            comparison["imported_value_sha256"] = imported_hash
            matches = comparison["current_value_sha256"] == imported_hash \
                and _json_deep_equal(inline.get("columns"), expected.get("columns")) \
                and len(inline.get("rows") or []) == expected.get("row_count")
            comparison.update({
                "status": "match" if matches else "mismatch",
                "value_matches_import": matches,
            })
            if not matches:
                issue = {
                    "code": "IMPORTED_VALUES_CHANGED",
                    "message": "chart 当前 columns/rows 与导入时值指纹不符；source locator 相同也不能替代值比较",
                    "element_id": record.get("element_id"), "severity": "error",
                    "current_value_sha256": comparison["current_value_sha256"],
                    "imported_value_sha256": imported_hash,
                }
                record.setdefault("issues", []).append(dict(issue))
                report.setdefault("issues", []).append(issue)
        record["value_comparison"] = comparison
        if isinstance(record.get("source"), dict):
            record["source"]["value_comparison"] = dict(comparison)
    issues = report.get("issues") or []
    report["issue_count"] = len(issues)
    report["error_count"] = sum(1 for issue in issues
                                if isinstance(issue, dict) and issue.get("severity") == "error")
    report["warning_count"] = report["issue_count"] - report["error_count"]


def tool_figure_lineage(a):
    doc = _require_doc(a)
    report = bcall("lineage.audit", doc=doc)
    if not isinstance(report, dict):
        raise ToolError("lineage.audit 返回结构异常")
    report = dict(report)
    _compare_imported_chart_values(doc, report)
    diagrams = _diagram_lineage(doc)
    report["schema_version"] = "figure-lineage/1.0"
    report["scope"] = "structured_figure"
    report["diagrams"] = diagrams
    report["history"] = [
        {key: item.get(key) for key in ("rev", "ts", "label", "source", "base_rev", "doc_sha256")}
        for item in doc.get("history") or [] if isinstance(item, dict)
    ]
    report["status"] = "issues_found" if report.get("error_count") else (
        "partial_missing_sources" if any(d["status"].startswith("partial") for d in diagrams)
        or report.get("issues") else "provided_unverified")
    report["complete"] = False
    report["scientific_validation"] = "not_performed"
    report["human_visual_review"] = None
    report["limitations"] = list(report.get("limitations") or []) + [
        "实体的 locator、字段映射、行号和版本仅支持复核，不证明来源真实性或科学结论。",
        "本地 audit、SVG 文本和导出解码结果不是逐面板真实人类科学/视觉复核。",
    ]
    if a.get("lookup") is not None:
        if not isinstance(a["lookup"], dict):
            raise ToolError("lookup 必须是 {element_id?,source_row?} 对象；source_row 从 0 开始")
        report["lookup"] = bcall("lineage.lookup", doc=doc, query=a["lookup"])
    else:
        report["lookup"] = {"status": "not_requested"}
    return {"ok": True, **report}


_SECRET_KEY = re.compile(r"(?:api[_-]?key|authorization|access[_-]?token|secret)", re.I)
_BUNDLE_EXTENSIONS = {"svg": "svg", "png": "png", "pdf": "pdf", "tiff": "tiff", "tif": "tiff", "project": "figureproj.json"}


def _redact_secrets(value):
    if isinstance(value, list):
        return [_redact_secrets(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if _SECRET_KEY.search(str(key)) else _redact_secrets(item)
            for key, item in value.items()
        }
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    raise ToolError("output_contract 必须是可以 JSON 编码的公开字段；不支持二进制、函数或对象")


def _bundle_directory(value):
    if not isinstance(value, str) or not value.strip():
        raise ToolError("output_directory 必须是非空的真实输出目录，不能省略或自动写到工程目录")
    if "\x00" in value:
        raise ToolError("output_directory 含非法 NUL")
    path = Path(value).expanduser().resolve()
    if path.exists() and not path.is_dir():
        raise ToolError("actual output_directory 已存在但不是目录：%s" % path)
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ToolError("无法创建 actual output_directory：%s" % exc) from exc
    return str(path)


def _bundle_sources(raw):
    records, warnings, hashed_paths = [], [], {}
    if raw is None or raw == []:
        warnings.append("SOURCE_MISSING: 未给出论文或原始数据 input_source；不声称读过原文或验证内容。")
        return records, [{"code": "SOURCE_MISSING", "message": warnings[-1]}]
    items = raw if isinstance(raw, list) else [raw]
    for index, item in enumerate(items):
        if isinstance(item, str):
            item = {"path": item}
        if not isinstance(item, dict):
            raise ToolError("input_source[%d] 必须是路径或对象" % index)
        record = _redact_secrets(item)
        path = item.get("path")
        record.update({"input_index": index, "status": "missing", "actual_sha256": None,
                       "content_copied": False, "fetch_status": "not_attempted_local_only",
                       "hash_match": None})
        if not isinstance(path, str) or not path.strip():
            record["status"] = "locator_only_unverified"
            record["error"] = "未见本地 source 文件，未执行 fetch"
            records.append(record)
            continue
        candidate = Path(path).expanduser()
        record["path"] = str(candidate)
        try:
            resolved = str(candidate.resolve())
            if resolved in hashed_paths:
                actual_hash, size = hashed_paths[resolved]
            else:
                with candidate.open("rb") as stream:
                    digest = hashlib.sha256()
                    size = 0
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        digest.update(chunk)
                actual_hash = digest.hexdigest()
                hashed_paths[resolved] = (actual_hash, size)
            record.update({"path": resolved, "status": "available_unverified",
                           "actual_sha256": actual_hash, "bytes": size})
            declared = item.get("sha256")
            if declared is not None:
                normalized = declared.strip().lower() if isinstance(declared, str) else ""
                normalized = normalized[7:] if normalized.startswith("sha256:") else normalized
                record["declared_sha256"] = normalized or None
                record["hash_match"] = bool(normalized) and normalized == actual_hash
                if not record["hash_match"]:
                    record["status"] = "hash_mismatch"
                    record["uncertainty"] = "调用方声明 hash 缺失、格式非法或与实际文件不一致；不标成 verified"
        except FileNotFoundError:
            record["error"] = "文件不存在，未执行 fetch"
        except OSError as exc:
            record["error"] = "文件不可读：%s" % exc
        records.append(record)
    for record in records:
        if record["status"] != "available_unverified":
            warnings.append("来源 %s 状态为 %s；保留缺口不补造材料。" %
                            (record.get("path") or record.get("locator") or record["input_index"], record["status"]))
    return records, [{"code": "SOURCE_INCOMPLETE", "message": message} for message in warnings]


def _bundle_export_requests(contract):
    raw = contract.get("export_formats")
    if raw is None:
        raw = contract.get("formats", contract.get("exports", contract.get("artifacts")))
    if raw is None:
        raw = contract.get("previews", contract.get("deliverables", ["svg", "png", "pdf", "tiff"]))
    if isinstance(raw, (str, dict)):
        raw = [raw]
    if not isinstance(raw, list):
        raise ToolError("output_contract 的 formats/export_formats/exports/artifacts 必须是字符串、对象或数组")
    requests, disabled = [], []
    names = set()
    for item in raw:
        if isinstance(item, str):
            item = {"format": item}
        if not isinstance(item, dict):
            raise ToolError("导出请求必须是格式字符串或对象")
        entry = dict(item)
        extension = entry.get("format", entry.get("ext", entry.get("extension")))
        supplied_name = entry.get("filename", entry.get("file_name", entry.get("name")))
        if extension is None:
            if not isinstance(supplied_name, str):
                raise ToolError("导出请求需要 format/extension/ext，或带扩展名的 filename")
            extension = Path(supplied_name).suffix
        extension = str(extension).lower().lstrip(".")
        canonical = _BUNDLE_EXTENSIONS.get(extension, extension)
        if canonical == "jpg":
            canonical = "jpeg"
        if canonical in ("figureproj.json", "lineage", "result", "manifest", "unknown"):
            continue
        filename = supplied_name if supplied_name is not None else "figure." + canonical
        request_error = None
        if not isinstance(filename, str) or not filename.strip() or filename in (".", "..") \
                or filename != Path(filename).name or Path(filename).is_absolute() \
                or any(char in filename for char in ("/", "\\", ":", "\x00")) \
                or any(ord(char) < 32 for char in filename):
            request_error = "导出 filename 必须是目标目录内的单个文件名，不得含路径或控制字符"
            filename = "blocked." + (canonical if re.fullmatch(r"[a-z0-9]+", canonical) else "unknown")
        elif filename.lower() in ("result.json", "manifest.json", "lineage.json",
                                  "figure.figureproj.json"):
            request_error = "导出 filename 与交付包保留文件冲突：%s" % filename
        elif Path(filename).suffix and _BUNDLE_EXTENSIONS.get(
                Path(filename).suffix.lower().lstrip("."), Path(filename).suffix.lower().lstrip(".")) != canonical \
                and not (canonical == "jpeg" and Path(filename).suffix.lower() == ".jpg"):
            request_error = "导出 filename 扩展名与实际请求格式 %s 不符" % canonical
        base, suffix = Path(filename).stem, Path(filename).suffix
        unique = filename
        sequence = 2
        while unique in names:
            unique = "%s-%d%s" % (base, sequence, suffix)
            sequence += 1
        names.add(unique)
        requests.append({"format": canonical, "dpi": entry.get("dpi"), "filename": unique,
                         "request_error": request_error, "contract": entry})
    if not requests and not disabled:
        requests.append({"format": "svg", "dpi": None, "filename": "figure.svg", "contract": {}})
    return requests


def _bundle_output_path(output_dir, filename):
    output_root = Path(output_dir).resolve()
    candidate = (output_root / filename).resolve()
    try:
        contained = candidate.parent == output_root and os.path.commonpath(
            [str(output_root), str(candidate)]) == str(output_root)
    except ValueError:
        contained = False
    if not contained:
        raise ToolError("导出路径越出 actual output_directory，已拒绝")
    return candidate


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_bundle_json(path, result):
    text = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if DOCIO is not None and callable(getattr(DOCIO, "atomic_write", None)):
        DOCIO.atomic_write(str(path), text)
    else:
        with open(path, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
    return str(path)


def _verify_bundle_artifact(path, format_name, dpi, size_mm):
    from PIL import Image
    if format_name == "svg":
        root = ET.parse(path).getroot()
        if root.tag.rsplit("}", 1)[-1].lower() != "svg":
            raise ToolError("SVG 实际解码失败")
        return {"decoded": True, "format": "svg", "mime_type": "image/svg+xml",
                "text_elements": len(root.findall(".//{http://www.w3.org/2000/svg}text"))}
    if format_name in ("png", "jpeg", "tiff"):
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            actual_format = str(image.format or "").lower()
            if actual_format != format_name:
                raise ToolError("扩展名 %s 与实际解码格式 %s 不符" % (format_name, image.format))
            if image.width <= 0 or image.height <= 0:
                raise ToolError("位图实际尺寸无效")
            actual_dpi = image.info.get("dpi")
            if actual_dpi is None and format_name == "tiff":
                actual_dpi = (image.tag_v2.get(282), image.tag_v2.get(296))
            if not actual_dpi or len(actual_dpi) < 2:
                raise ToolError("位图缺少实际 DPI 元数据")
            decoded_dpi = [float(value) for value in actual_dpi[:2]]
            if not all(math.isfinite(value) and value > 0 for value in decoded_dpi):
                raise ToolError("位图实际 DPI 必须是有限正数")
            if dpi is not None and any(abs(value - float(dpi)) > 0.05 for value in decoded_dpi):
                raise ToolError("位图实际 DPI %r 与请求 %r 不符" % (decoded_dpi, dpi))
            mime_type = {"png": "image/png", "jpeg": "image/jpeg",
                         "tiff": "image/tiff"}[actual_format]
            return {"decoded": True, "format": actual_format, "mime_type": mime_type,
                    "px": [image.width, image.height], "dpi": decoded_dpi, "mode": image.mode}
    import fitz
    if format_name != "pdf":
        raise ToolError("没有 %s 格式的真实解码器，不能标记导出成功" % format_name)
    with fitz.open(path) as pdf:
        if pdf.page_count < 1:
            raise ToolError("PDF 没有页面")
        boxes = [list(page.rect) for page in pdf]
        texts = [page.get_text().strip() for page in pdf]
        if not any(texts):
            raise ToolError("PDF 没有可独立提取的文本")
        expected = [round(size_mm[0] * 72 / 25.4, 1), round(size_mm[1] * 72 / 25.4, 1)]
        actual_page = [round(boxes[0][2] - boxes[0][0], 1), round(boxes[0][3] - boxes[0][1], 1)]
        if any(abs(a - b) > 0.2 for a, b in zip(actual_page, expected)):
            raise ToolError("PDF 实际 MediaBox %r 与 SVG 尺寸 %r 不符" % (actual_page, expected))
        return {"decoded": True, "format": "pdf", "mime_type": "application/pdf",
                "pages": pdf.page_count, "media_box": boxes[0], "text_available": True}


def _verify_bundle_json_artifact(path, kind):
    def invalid_constant(value):
        raise ValueError("非法 JSON 数字：" + value)
    with open(path, "r", encoding="utf-8") as stream:
        decoded = json.load(stream, parse_constant=invalid_constant)
    if not isinstance(decoded, dict):
        raise ToolError("%s 实际 JSON root 不是对象" % kind)
    if kind == "figureproj.json":
        if decoded.get("format") != "figure-project" \
                or not isinstance(decoded.get("doc"), dict) \
                or not isinstance(decoded.get("assets"), dict):
            raise ToolError("可编辑工程实际 JSON 结构不符")
    elif decoded.get("schema_version") != "figure-lineage/1.0" \
            or not isinstance(decoded.get("charts"), list):
        raise ToolError("lineage 实际 JSON 结构不符")
    return {"decoded": True, "format": kind, "mime_type": "application/json"}


def tool_figure_export_bundle(a):
    output_dir = Path(_bundle_directory(a.get("output_directory")))
    doc = _require_doc(a)
    contract = a.get("output_contract", {})
    if not isinstance(contract, dict):
        raise ToolError("output_contract 必须是对象；所有原始字段会在公开字段范围内保留")
    if not isinstance(a.get("input_source", []), (str, dict, list)):
        raise ToolError("input_source 必须是路径、对象或数组")
    requests = _bundle_export_requests(contract)
    sources, source_warnings = _bundle_sources(a.get("input_source"))
    result = _redact_secrets(contract)
    native_uncertainty = result.get("uncertainty")
    if native_uncertainty is not None and not isinstance(native_uncertainty, (list, str, dict)):
        raise ToolError("output_contract.uncertainty 必须是列表、字符串、对象或 null")
    if native_uncertainty is not None and not isinstance(native_uncertainty, list):
        result["audit_uncertainty"] = []
    elif isinstance(native_uncertainty, list):
        result["audit_uncertainty"] = native_uncertainty
    else:
        result["uncertainty"] = []
        result["audit_uncertainty"] = result["uncertainty"]

    def add_uncertainty(message):
        result["audit_uncertainty"].append(message)

    result.update({
        "case_id": _redact_secrets(a.get("case_id", result.get("case_id"))),
        "version": "1.0", "bundle_schema_version": "1.0",
        "status": "partial", "source": sources, "sources": sources,
        "changes": [], "checks": [], "artifacts": [], "errors": [],
        "output_directory": str(output_dir),
        "human_review": _redact_secrets(a.get("human_review")) if a.get("human_review") is not None else None,
        "ui_native_result_status": _redact_secrets(
            a.get("ui_native_result_status", "not_observed")),
        "model": {"id": a.get("model_id") if isinstance(a.get("model_id"), str) and a.get("model_id") else None,
                  "config": _redact_secrets(a.get("model_config")) if isinstance(a.get("model_config"), dict) else None},
        "limitations": ["不读取论文正文或执行来源中的代码；input_source 只核对文件存在性和 SHA-256，不默认复制原文。",
                        "可编辑 SVG 与导出解码检查不证明科学正确性或真实人类视觉复核。"],
    })
    if not result["human_review"]:
        add_uncertainty("未提供真实人类科学/视觉复核记录；不得将自动检查视为验收。")
    for source_warning in source_warnings:
        add_uncertainty(source_warning["message"])
    result["checks"].append({"name": "source_file_presence_and_hash", "status": "partial" if source_warnings else "files_available_unverified"})
    result_path = _bundle_output_path(output_dir, "result.json")
    manifest_path = _bundle_output_path(output_dir, "manifest.json")
    lineage_path = _bundle_output_path(output_dir, "lineage.json")
    project_path = _bundle_output_path(output_dir, "figure.figureproj.json")

    def persist():
        _write_bundle_json(result_path, result)
        _write_bundle_json(manifest_path, {key: value for key, value in result.items()
                                         if key not in ("output_contract", "artifacts")} |
                                         {"artifacts": result["artifacts"]})

    for warning in source_warnings:
        result["checks"].append(warning | {"status": "partial"})
    persist()
    fatal = None
    try:
        errors = _validate_doc(doc)
        if errors:
            raise ToolError("文档结构校验失败：" + "；".join(errors))
        _save_project_file(doc, str(project_path), {})
        result["artifacts"].append({"name": project_path.name, "role": "editable_project",
                                     "format": "figureproj.json", "path": str(project_path),
                                     "decoded": _verify_bundle_json_artifact(project_path, "figureproj.json"),
                                     "sha256": _sha256_file(project_path),
                                     "status": "decoded_not_visually_reviewed"})
        lineage = tool_figure_lineage({"doc": doc})
        _write_bundle_json(lineage_path, lineage)
        result["artifacts"].append({"name": lineage_path.name, "role": "lineage",
                                     "format": "json", "path": str(lineage_path),
                                     "decoded": _verify_bundle_json_artifact(lineage_path, "lineage.json"),
                                     "sha256": _sha256_file(lineage_path), "status": lineage["status"]})
        result["changes"] = [{
            "rev": record.get("rev"), "ts": record.get("ts"), "label": record.get("label"),
            "source": record.get("source"), "base_rev": record.get("base_rev"),
            "ops": record.get("ops") or [], "doc_sha256": record.get("doc_sha256"),
        } for record in doc.get("history") or [] if isinstance(record, dict)]
        result["checks"].append({"name": "editable_project_and_lineage", "status": "written_not_scientific_validation"})
        svg = _render_svg(doc)
        size_mm = _svg_physical_dimensions(svg)
        for request in requests:
            fmt = request["format"]
            dpi = request.get("dpi")
            try:
                if request.get("request_error"):
                    raise ToolError(request["request_error"])
                if fmt not in ("svg", "png", "jpeg", "tiff", "pdf"):
                    raise ToolError("扩展名 .%s 不在真实 svg/png/jpeg/tiff/pdf 导出链内" % fmt)
                if dpi is not None and (isinstance(dpi, bool) or not isinstance(dpi, (int, float))
                                        or not math.isfinite(dpi) or dpi <= 0):
                    raise ToolError("dpi 必须是有限正数，不能是 NaN/Infinity")
                if fmt == "svg" and dpi not in (None, ""):
                    raise ToolError("SVG 无位图 DPI；请删除 dpi 或请求位图格式")
                out_path = _bundle_output_path(output_dir, request["filename"])
                exported = tool_figure_export({"doc": doc, "format": fmt, "out_path": str(out_path),
                                               **({"dpi": dpi} if dpi is not None else {})})
                actual_path = Path(exported.get("path")).resolve()
                if actual_path != out_path:
                    raise ToolError("导出器返回了与批准目标不同的路径，已拒绝列入交付包")
                checked = _verify_bundle_artifact(
                    actual_path, fmt, dpi if dpi is not None else doc["canvas"]["dpi"], size_mm)
                actual_hash = _sha256_file(actual_path)
                declared_hash = request["contract"].get(
                    "expected_sha256", request["contract"].get("sha256"))
                if declared_hash is not None:
                    normalized = declared_hash.strip().lower() if isinstance(declared_hash, str) else ""
                    normalized = normalized[7:] if normalized.startswith("sha256:") else normalized
                    if normalized != actual_hash:
                        raise ToolError("导出 artifact 的实际 SHA-256 与声明值不符；不标成 verified")
                result["artifacts"].append({"name": actual_path.name, "role": "export",
                                             "format": fmt, "path": str(actual_path),
                                             "sha256": actual_hash, "bytes": actual_path.stat().st_size,
                                             "requested_dpi": dpi, "decoded": checked,
                                             "hash_match": True if declared_hash is not None else None,
                                             "status": "decoded_not_visually_reviewed"})
            except Exception as exc:
                safe_error = re.sub(
                    r"(?i)(api[_-]?key|authorization|access[_-]?token|secret)[=: ]+\S+",
                    r"\1=[REDACTED]", str(exc))
                result["errors"].append({"format": fmt, "error": safe_error})
                add_uncertainty("格式 %s 未完成：%s" % (fmt, safe_error))
            persist()
    except Exception as exc:
        fatal = re.sub(r"(?i)(api[_-]?key|authorization|access[_-]?token|secret)[=: ]+\S+",
                       r"\1=[REDACTED]", str(exc))
        result["errors"].append({"fatal": fatal})
        add_uncertainty("真实渲染或保存未完成：" + fatal)
    lineage_incomplete = isinstance(locals().get("lineage"), dict) \
        and bool(lineage.get("error_count"))
    result["checks"].append({
        "name": "canonical_render_and_export_decoder",
        "status": "failed" if fatal or result["errors"] else "decoded_not_human_review"})
    result["status"] = "partial" if fatal or result["errors"] or source_warnings \
        or lineage_incomplete else "ready_for_review"
    if DOCIO is None:
        result["checks"].append({"name": "atomic_result_write", "status": "unavailable_direct_file_write"})
    persist()
    return {"ok": True, **result, "result_path": str(result_path), "manifest_path": str(manifest_path)}


HANDLERS = {
    "figure_schematic": tool_figure_schematic,
    "figure_lineage": tool_figure_lineage,
    "figure_export_bundle": tool_figure_export_bundle,
    "figure_create": tool_figure_create,
    "figure_templates": tool_figure_templates,
    "figure_journals": tool_figure_journals,
    "figure_open_data": tool_figure_open_data,
    "figure_create_chart": tool_figure_create_chart,
    "figure_apply_edits": tool_figure_apply_edits,
    "figure_apply_journal": tool_figure_apply_journal,
    "figure_recolor": tool_figure_recolor,
    "figure_add_anchor": tool_figure_add_anchor,
    "figure_anchors": tool_figure_anchors,
    "figure_place": tool_figure_place,
    "figure_panel_layout": tool_figure_panel_layout,
    "figure_check": tool_figure_check,
    "figure_render": tool_figure_render,
    "figure_export": tool_figure_export,
    "figure_review": tool_figure_review,
    "figure_history": tool_figure_history,
    "figure_revert": tool_figure_revert,
    "figure_save_project": tool_figure_save_project,
    "figure_load_project": tool_figure_load_project,
    "figure_open_viewer": tool_figure_open_viewer,
    "figure_scientific_contract": tool_figure_scientific_contract,
    "figure_scientific_audit": tool_figure_scientific_audit,
}


# ---------------------------------------------------------------------------
# 查看器（--viewer 同进程起 HTTP；figure_open_viewer 复用/拉起）
# ---------------------------------------------------------------------------

_VIEWER_PORT = {"value": _VIEWER_PORT_DEFAULT}

_FALLBACK_VIEWER_HTML = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>图表查看器 (v3)</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#f5f5f5}
#meta{color:#555;font-size:13px;margin-bottom:8px}#stage{background:#fff;padding:8px;box-shadow:0 1px 4px rgba(0,0,0,.15)}
svg{max-width:100%;height:auto}</style></head>
<body><h3>图表查看器 (v3 内置精简版)</h3><div id="meta">等待文档…</div><div id="stage"></div>
<script>
async function load(){try{
 const r=await fetch('/api/doc');const j=await r.json();
 if(!j.ok||!j.doc){document.getElementById('meta').textContent='暂无文档：请通过 figure_open_viewer 传入 doc';return;}
 const d=j.doc;const c=d.canvas||{};
 document.getElementById('meta').textContent=(d.title||'未命名')+' — '+c.width_mm+'x'+c.height_mm+'mm @'+(c.dpi||300)+'dpi，元素 '+(d.elements||[]).length+' 个，锚点 '+(d.anchors||[]).length+' 个，历史 '+(d.history||[]).length+' 条';
 document.getElementById('stage').innerHTML=await (await fetch('/api/svg')).text();
}catch(e){document.getElementById('meta').textContent='加载失败：'+e}}
load();setInterval(load,4000);
</script></body></html>
"""


class _ViewerHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静默，避免污染 stderr
        pass

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            with _VIEWER_STATE["lock"]:
                has = _VIEWER_STATE["doc"] is not None
            self._send_json({"ok": True, "viewer": True, "version": SERVER_INFO["version"], "has_doc": has})
        elif path == "/api/doc":
            with _VIEWER_STATE["lock"]:
                doc = _VIEWER_STATE["doc"]
            if doc is None:
                self._send_json({"ok": False, "error": "暂无文档，请先通过 figure_open_viewer 传入 doc"}, 404)
            else:
                self._send_json({
                    "ok": True, "doc": doc, "save_token": _save_token(doc),
                })
        elif path == "/api/svg":
            with _VIEWER_STATE["lock"]:
                doc = _VIEWER_STATE["doc"]
            if doc is None:
                self._send_json({"ok": False, "error": "暂无文档"}, 404)
                return
            try:
                svg = bcall("render.to_svg", doc=doc, scale=1)
                if isinstance(svg, dict):
                    svg = svg.get("svg") or svg.get("result")
                body = str(svg).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self._send_json({"ok": False, "error": "渲染失败：%s" % e}, 500)
        elif path in ("/", "/index.html"):
            body = _FALLBACK_VIEWER_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._serve_static(path)

    def _serve_static(self, path):
        static_dir = (PLUGIN_DIR / "viewer_static").resolve()
        rel = path.lstrip("/")
        target = (static_dir / rel).resolve()
        if not str(target).startswith(str(static_dir)) or not target.is_file():
            self._send_json({"ok": False, "error": "未找到资源：%s" % path}, 404)
            return
        ctype = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                 "css": "text/css; charset=utf-8", "svg": "image/svg+xml"}.get(
                     target.suffix.lstrip("."), "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path != "/api/doc":
            self._send_json({"ok": False, "error": "不支持的 POST 路径：%s" % path}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            obj = json.loads(self.rfile.read(length).decode("utf-8"))
            doc = obj.get("doc") if isinstance(obj, dict) and "doc" in obj else obj
            if not isinstance(doc, dict) or "canvas" not in doc:
                raise ValueError("doc 结构无效")
            conditional = isinstance(obj, dict) and isinstance(obj.get("doc"), dict) \
                and "base_token" in obj
            with _VIEWER_STATE["lock"]:
                current_token = _save_token(_VIEWER_STATE["doc"])
                conflict = conditional and obj.get("base_token") != current_token
                if not conflict:
                    _VIEWER_STATE["doc"] = doc
            if conflict:
                self._send_json({
                    "ok": False, "error": "文档已更新，请重新加载后再保存",
                    "save_conflict": True, "save_token": current_token,
                }, 409)
            else:
                self._send_json({"ok": True, "doc": doc, "save_token": _save_token(doc)})
        except Exception as e:
            self._send_json({"ok": False, "error": "写入文档失败：%s" % e}, 400)


def _start_viewer_server(port):
    """优先复用 viewer.py 的服务入口，否则使用内置精简查看器。"""
    def worker():
        try:
            import viewer  # noqa: F401 — 并行任务的查看器实现
            for name in ("serve", "run", "main"):
                fn = getattr(viewer, name, None)
                if callable(fn):
                    fn(port)
                    return
            _log("viewer.py 未暴露 serve/run/main 入口，改用内置查看器")
        except Exception as e:
            _log("viewer.py 不可用，改用内置查看器：%s" % e)
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), _ViewerHandler)
            server.serve_forever()
        except Exception as e:
            _log("内置查看器启动失败（端口 %d）：%s" % (port, e))
    threading.Thread(target=worker, daemon=True).start()


def _probe_viewer(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % port, timeout=0.6) as resp:
            return resp.status == 200
    except Exception:
        return False


def _push_doc_to_viewer(port, doc):
    """把 doc 推给查看器；失败仅记录 stderr，不影响返回值。"""
    try:
        body = json.dumps({"doc": doc}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request("http://127.0.0.1:%d/api/doc" % port, data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=3)
    except Exception as e:
        _log("推送文档到查看器失败（不影响调用结果）：%s" % e)


# ---------------------------------------------------------------------------
# MCP JSON-RPC 2.0 协议层
# ---------------------------------------------------------------------------

class JsonRpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _write_line(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(data + b"\n")
    sys.stdout.buffer.flush()


def _result(mid, result):
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def _error(mid, code, message):
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def _run_tool(name, arguments):
    """工具分发：任何异常 -> ok:false + 中文 error，绝不外抛。"""
    try:
        payload = HANDLERS[name](arguments)
        if not isinstance(payload, dict):
            payload = {"ok": True, "result": payload}
        payload.setdefault("ok", True)
        return payload
    except ToolError as e:
        return {"ok": False, "error": str(e)}
    except BridgeCallError as e:
        return {"ok": False, "error": "桥调用失败：%s" % e}
    except BridgeError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": "工具 %s 执行异常：%s: %s" % (name, e.__class__.__name__, e)}


def _handle_tools_call(params):
    if not isinstance(params, dict):
        raise JsonRpcError(-32602, "tools/call 的 params 必须是对象")
    name = params.get("name")
    if not isinstance(name, str) or not name:
        raise JsonRpcError(-32602, "tools/call 缺少工具名 name")
    if tools_spec.get_tool(name) is None:
        raise JsonRpcError(-32602, "未知工具：%s（可用工具见 tools/list）" % name)
    arguments = params.get("arguments")
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        raise JsonRpcError(-32602, "tools/call 的 arguments 必须是对象")
    required = tools_spec.get_tool(name)["input_schema"].get("required") or []
    missing = [k for k in required if k not in arguments]
    if missing:
        raise JsonRpcError(-32602, "工具 %s 缺少必填参数：%s" % (name, "、".join(missing)))
    payload = _run_tool(name, arguments)
    return {
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
        "isError": payload.get("ok") is False,
    }


def _handle(req):
    if not isinstance(req, dict):
        return _error(None, -32602, "请求必须是 JSON 对象")
    mid = req.get("id")
    method = req.get("method")
    if method is None:
        if mid is not None:
            return _error(mid, -32602, "请求缺少 method 字段")
        return None  # 无法识别的通知，忽略
    if mid is None:
        return None  # 通知（如 notifications/initialized）：不回包
    params = req.get("params")
    try:
        if method == "initialize":
            p = params if isinstance(params, dict) else {}
            result = {
                "protocolVersion": p.get("protocolVersion") or PROTOCOL_VERSION_DEFAULT,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
            }
        elif method == "tools/list":
            result = {"tools": tools_spec.mcp_tools()}
        elif method == "tools/call":
            result = _handle_tools_call(params)
        elif method == "ping":
            result = {}
        elif method == "shutdown":
            result = {}
        else:
            return _error(mid, -32601, "未知方法：%s" % method)
    except JsonRpcError as e:
        return _error(mid, e.code, e.message)
    except Exception as e:  # 协议层兜底
        return _error(mid, -32603, "内部错误：%s: %s" % (e.__class__.__name__, e))
    return _result(mid, result)


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def _load_key_file(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            key = f.read().strip()
        if key:
            _KEY_FROM_FILE["value"] = key
            _log("已从 %s 加载 API key（长度 %d，内容不记录）" % (path, len(key)))
    except Exception as e:
        _log("读取 --key-file 失败：%s" % e)


def main(argv=None):
    parser = argparse.ArgumentParser(description="科研绘图 MCP 插件（v3）— stdio JSON-RPC 2.0")
    parser.add_argument("--viewer", action="store_true", help="同进程启动人工复核查看器 HTTP 服务")
    parser.add_argument("--port", type=int, default=_VIEWER_PORT_DEFAULT, help="查看器端口（默认 8770）")
    parser.add_argument("--key-file", dest="key_file", default=None,
                        help="DeepSeek API key 文件路径（优先于环境变量 DEEPSEEK_API_KEY）")
    args = parser.parse_args(argv)

    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    _VIEWER_PORT["value"] = args.port
    if args.key_file:
        _load_key_file(args.key_file)

    if DOCIO is None:
        _log("提示：py/docio.py 尚未就绪，工程文件读写将使用内置兜底实现")
    if FIGRASTER is None:
        _log("提示：py/figraster.py 尚未就绪，位图/PDF 导出将返回中文错误")

    if args.viewer:
        _start_viewer_server(args.port)
        _log("查看器已随服务启动：http://127.0.0.1:%d/" % args.port)

    _log("MCP stdio 服务就绪（protocolVersion=%s，工具 %d 个）"
         % (PROTOCOL_VERSION_DEFAULT, len(tools_spec.TOOLS)))

    for raw in sys.stdin.buffer:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line.decode("utf-8"))
        except Exception as e:
            _write_line(_error(None, -32700, "请求不是合法 JSON：%s" % e))
            continue
        resp = _handle(req)
        if resp is not None:
            _write_line(resp)
    _log("stdin 已关闭，服务退出")


if __name__ == "__main__":
    main()
