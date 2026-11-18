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
  GET  /shared/presets/* shared/presets 下的 JSON（供前端直接 fetch）
  GET  /api/health       {ok, viewer, version, has_doc}   （mcp_server 探测用）
  GET  /api/status       {ok, version, port, python, pillow, doc, presets, ...}
  GET  /api/presets      {ok, journals, templates, palettes, styles}（shared/presets 原样）
  GET  /api/prefs        {ok, prefs:{default_style_id, custom_styles}}（用户风格偏好）
  POST /api/prefs        {patch:{...}} 部分更新偏好（未知键拒绝；原子写 prefs.json）
  GET  /api/current      当前文档（含 history）：{ok, exists, doc, save_token}；
                         尚无文档时 200 + {ok:true, exists:false, doc:null,
                         save_token:null}（空态是正常响应，不是错误）
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

  GET/POST /api/doc      GET 同 /api/current（含 exists 空态字段）；
                         POST 兼容显式整文档推送，
                         携带 base_token 时也执行条件保存
  GET  /api/tabs         {ok, active_id, tabs:[{id,title,elements,updated}]}
  POST /api/tabs/new     {doc, base_token} 新建标签页并切为活动
                         （空服务器 base_token:null；409 同 /api/current）
  POST /api/tabs/switch  {to_id, base_token} 切换活动标签页
  POST /api/tabs/close   {id, base_token} 关闭标签页（归档到 tabs/closed/，
                         不删除；活动标签先切邻居；最后一个不可关）
  GET  /api/tabs/closed  {ok, closed:[{file,id,title,elements,closed_at}]}，
  GET  /api/tabs/doc?id=<tabId>  {ok, doc} 只读返回指定标签页文档
                                  （活动标签=当前文档；id 须在标签表内）
                         最新在前，最多 50 条；file 仅为归档 basename
  POST /api/tabs/restore {file, base_token} 把归档移回 tabs/<id>.figureproj.json
                         并激活；该 id 已是打开标签时等价于切换（归档保留）
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
PRESET_FILES = ("journals.json", "templates.json", "palettes.json", "styles.json",
                "diagram_themes.json")

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

# R5：用户偏好（默认风格/我的风格）存数据目录根的 prefs.json，与工程同级。
if FIGPATHS is not None:
    PREFS_PATH = FIGPATHS.data_dir() / "prefs.json"
else:  # pragma: no cover
    PREFS_PATH = PROJECT_DIR.parent / "prefs.json"

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

# 转发上限覆盖工作台可配置的最长请求时间；较短的等待时间由前端控制。
AI_CHAT_TIMEOUT_SECONDS = 600
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

_STATE_LOCK = threading.RLock()
_STATE = {"doc": None, "project_path": None, "save_token": None}

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


def _current_save_token():
    """当前文档的缓存 save_token。

    _STATE["doc"] 只允许整体替换赋值（不存在原地修改），每次赋值处同步更新
    _STATE["save_token"]，因此这里始终与当前文档一致，避免每个请求对整份
    文档重新序列化 + SHA256。兼容测试/外部直接重置为旧式两键
    {"doc","project_path"} 字典的情况：缺缓存时现算并回填。"""
    with _STATE_LOCK:
        token = _STATE.get("save_token")
        doc = _STATE.get("doc")
        if token is None and doc is not None:
            token = _save_token(doc)
            _STATE["save_token"] = token
        return token


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


def _save_current(doc, base_token=_EXPLICIT_REPLACE, preserve_tabs=False):
    """校验、按条件比较并原子落盘，在锁内最后发布本次文档。

    preserve_tabs=True 仅用于 /api/doc 显式整体替换：推送 id 与当前 id 不同时
    先保留旧活动标签（见 _tabs_preserve_on_replace_locked）。标签页内部切换
    与前端条件保存不传该标志，维持原有原位替换语义。"""
    _validate_or_raise(doc)
    if base_token is not _EXPLICIT_REPLACE:
        _validate_base_token(base_token)
    save_token = _save_token(doc)
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    with _STATE_LOCK:
        if base_token is not _EXPLICIT_REPLACE:
            current_token = _current_save_token()
            if base_token != current_token:
                raise SaveConflict(current_token)
        elif preserve_tabs:
            _tabs_preserve_on_replace_locked(doc)
        path = DOCIO.save_project(doc, str(CURRENT_PROJECT_PATH))
        _STATE["doc"] = doc
        _STATE["save_token"] = save_token
        _STATE["project_path"] = path
    return path, save_token


# ---- 多画布标签页（tabs）----
# PROJECT_DIR/tabs/index.json  {order:[doc_id], active:doc_id}
# PROJECT_DIR/tabs/<doc_id>.figureproj.json  各标签页最近一次保存副本
# PROJECT_DIR/tabs/closed/<id>-<ts>.figureproj.json  关闭归档（不删除）
TABS_DIR = PROJECT_DIR / "tabs"
TABS_INDEX_PATH = TABS_DIR / "index.json"
TABS_CLOSED_DIR = TABS_DIR / "closed"


def _tabs_normalize(idx):
    """当前文档 id 是活动标签的唯一权威：
    - 当前 id 已在 order 中 → active 强制为它；
    - 当前 id 不在 order 中（MCP /api/doc 推送或前端换 id 保存覆盖了活动标签）
      → 原位替换 active 项的 id，active 设为当前 id。"""
    doc = _STATE.get("doc")
    did = doc.get("id") if isinstance(doc, dict) else None
    if not (isinstance(did, str) and did):
        return idx
    order = [d for d in (idx.get("order") or [])
             if isinstance(d, str) and d]
    if did not in order:
        active = idx.get("active")
        if active in order:
            order[order.index(active)] = did
        else:
            order.append(did)
    idx["order"] = order
    idx["active"] = did
    return idx


def _tabs_index_load():
    """读取标签顺序（已归一化）；index 缺失时由当前文档推导单标签。"""
    try:
        if TABS_INDEX_PATH.is_file():
            data = json.loads(TABS_INDEX_PATH.read_text(encoding="utf-8"))
            order = data.get("order") if isinstance(data, dict) else None
            active = data.get("active") if isinstance(data, dict) else None
            if isinstance(order, list):
                idx = {"order": [str(x) for x in order
                                 if isinstance(x, str) and x],
                       "active": active if isinstance(active, str) else None}
                return _tabs_normalize(idx)
    except Exception:
        pass
    doc = _STATE.get("doc")
    did = doc.get("id") if isinstance(doc, dict) else None
    if isinstance(did, str) and did:
        return {"order": [did], "active": did}
    return {"order": [], "active": None}


def _tabs_index_ensure():
    """返回归一化 index；与磁盘内容不一致（缺失/被替换）时落盘。"""
    idx = _tabs_index_load()
    try:
        raw = json.loads(TABS_INDEX_PATH.read_text(encoding="utf-8")) \
            if TABS_INDEX_PATH.is_file() else None
    except Exception:
        raw = None
    if (not isinstance(raw, dict)
            or raw.get("order") != idx["order"]
            or raw.get("active") != idx["active"]):
        _tabs_index_save(idx)
    return idx


def _tabs_index_save(idx):
    TABS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"order": list(idx.get("order") or []),
               "active": idx.get("active")}
    tmp = TABS_INDEX_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    os.replace(str(tmp), str(TABS_INDEX_PATH))


def _tab_file(doc_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(doc_id))
    return TABS_DIR / (safe + ".figureproj.json")


def _tabs_save_current_locked():
    """把 _STATE 当前文档落到它自己的标签文件（须在 _STATE_LOCK 内调用）。
    写失败抛错——调用方必须中止整个标签操作，不得带病继续。"""
    doc = _STATE.get("doc")
    if not isinstance(doc, dict):
        return
    did = doc.get("id")
    if not isinstance(did, str) or not did or DOCIO is None:
        return
    DOCIO.save_project(doc, str(_tab_file(did)))


def _tabs_write_doc_file(doc, doc_id):
    """把给定文档写到指定标签文件（新建标签用）。"""
    DOCIO.save_project(doc, str(_tab_file(doc_id)))


def _tabs_preserve_on_replace_locked(new_doc):
    """MCP /api/doc 推送不同 id 文档时保留旧活动标签（须在 _STATE_LOCK 内、
    且在 _STATE["doc"] 被替换前调用）：

    1) 旧活动文档先落到自己的标签文件——其最新内容此前只在
       current.figureproj.json，tabs/ 下副本只在切换时更新；
    2) index 中已有同 id → 设为 active；否则追加到 order 末尾并设为 active；
    3) 把推送文档写到它自己的标签文件。

    同 id 推送、空服务器、旧文档无有效 id 时不做任何事（维持原行为）。"""
    old = _STATE.get("doc")
    new_id = new_doc.get("id") if isinstance(new_doc, dict) else None
    if not (isinstance(new_id, str) and new_id):
        return
    old_id = old.get("id") if isinstance(old, dict) else None
    if not (isinstance(old_id, str) and old_id) or old_id == new_id:
        return
    # 全新服务器可能从未初始化过 tabs/（此前只有 /api/doc 推送）：
    # _tabs_save_current_locked/_tabs_write_doc_file 都要求父目录已存在。
    TABS_DIR.mkdir(parents=True, exist_ok=True)
    _tabs_save_current_locked()
    idx = _tabs_index_ensure()
    order = list(idx.get("order") or [])
    if new_id not in order:
        order.append(new_id)
        idx["order"] = order
    idx["active"] = new_id
    _tabs_index_save(idx)
    _tabs_write_doc_file(new_doc, new_id)


def _tabs_entry(doc_id, doc=None):
    """{id,title,elements,updated}；doc 缺省时尝试读标签文件。"""
    if doc is None:
        try:
            if _tab_file(doc_id).is_file():
                doc = DOCIO.load_project(str(_tab_file(doc_id))).get("doc")
        except Exception:
            doc = None
    if not isinstance(doc, dict):
        return {"id": doc_id, "title": "", "elements": 0, "updated": None}
    els = doc.get("elements")
    updated = None
    try:
        updated = datetime.fromtimestamp(
            _tab_file(doc_id).stat().st_mtime, tz=timezone.utc).isoformat()
    except Exception:
        pass
    return {"id": doc_id,
            "title": str(doc.get("title") or ""),
            "elements": len(els) if isinstance(els, list) else 0,
            "updated": updated}


def _tabs_list():
    idx = _tabs_index_load()
    cur = _get_current_doc()
    cur_id = cur.get("id") if isinstance(cur, dict) else None
    return idx, [_tabs_entry(d, cur if d == cur_id else None)
                for d in idx["order"]]


def _tabs_check_token(base_token):
    """base_token 必须等于当前文档 save_token（同 /api/current 语义）。
    空服务器（无当前文档）时 base_token 必须为 null。"""
    _validate_base_token(base_token)
    current = _current_save_token()
    if base_token != current:
        raise SaveConflict(current)


_CLOSED_TS_RE = re.compile(r"-(\d{8}T\d{6}Z)\.figureproj\.json$")


def _tabs_closed_list():
    """已关闭标签归档列表：最新在前，最多 50 条。
    file 只回 basename；closed_at 优先取文件名中的归档时间戳，
    解析失败退回文件 mtime。读不出的文件仍列出（id 尽力从文件名推断），
    还原时会再次加载校验。"""
    out = []
    try:
        files = sorted(TABS_CLOSED_DIR.glob("*.figureproj.json"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
    except Exception:
        return out
    for p in files[:50]:
        entry = {"file": p.name, "id": None, "title": "",
                 "elements": 0, "closed_at": None}
        mm = _CLOSED_TS_RE.search(p.name)
        if mm:
            try:
                entry["closed_at"] = datetime.strptime(
                    mm.group(1), "%Y%m%dT%H%M%SZ").replace(
                    tzinfo=timezone.utc).isoformat()
            except Exception:
                pass
        if entry["closed_at"] is None:
            try:
                entry["closed_at"] = datetime.fromtimestamp(
                    p.stat().st_mtime, tz=timezone.utc).isoformat()
            except Exception:
                pass
        stem = p.name[:-len(".figureproj.json")]
        if mm:
            stem = p.name[:mm.start()]
        if DOCIO is None:
            entry["id"] = stem or None
            out.append(entry)
            continue
        try:
            doc = DOCIO.load_project(str(p)).get("doc")
        except Exception:
            doc = None
        if isinstance(doc, dict):
            entry["id"] = doc.get("id")
            entry["title"] = str(doc.get("title") or "")
            els = doc.get("elements")
            entry["elements"] = len(els) if isinstance(els, list) else 0
        else:
            entry["id"] = stem or None
        out.append(entry)
    return out


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

    # ---- 统一请求守卫 -------------------------------------------------------
    # loopback 绑定只挡外部机器；本机任意网页仍可向 127.0.0.1 发请求
    # （浏览器把它当成同源无关的跨域 POST，text/plain 也能到达）。这里在
    # 请求入口统一收口：
    #   - 所有请求：Host 必须是 127.0.0.1:<port> / localhost:<port> / [::1]:<port>
    #     （防 DNS 重绑定把域名解析到 loopback 后携带自有 Host/Origin 通过检查）；
    #   - 所有 POST：带 Origin 头时必须是 http://<上述三个 loopback>:<port>，
    #     "null" 与其他值一律 403；不带 Origin 的 Python/MCP 推送与测试客户端放行；
    #   - 所有 POST：Content-Type 主类型必须是 application/json，否则 415；
    #     /api/import-spreadsheet 除外（保留路由内检查 -> 400）。
    # 各路由原有的 loopback client_address 检查保留不动。

    def _guard_request(self):
        # 端口取实际绑定地址而非 SERVER_PORT 全局：测试/内嵌方可能直接用
        # ThreadingHTTPServer(("127.0.0.1", 0), ViewerHandler) 起临时实例，
        # 不经过 serve()，SERVER_PORT["value"] 会停留在默认值。
        try:
            port = int(self.server.server_address[1])
        except Exception:
            port = SERVER_PORT["value"]
        host = (self.headers.get("Host") or "").strip()
        allowed_hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port,
                         "[::1]:%d" % port}
        if host not in allowed_hosts:
            self._send_json({"ok": False, "error": "非法 Host：%s" % host}, 403)
            return False
        if self.command == "POST":
            origin = self.headers.get("Origin")
            if origin is not None:
                allowed_origins = {"http://127.0.0.1:%d" % port,
                                   "http://localhost:%d" % port,
                                   "http://[::1]:%d" % port}
                if origin not in allowed_origins:
                    self._send_json(
                        {"ok": False, "error": "非法 Origin：%s" % origin}, 403)
                    return False
            # /api/import-spreadsheet 保留路由内自带的 Content-Type 检查
            # （ValueError -> 400），不在此统一拦截为 415。
            path = urllib.parse.urlparse(self.path).path
            if path != "/api/import-spreadsheet":
                content_type = (self.headers.get("Content-Type") or "") \
                    .split(";", 1)[0].strip().lower()
                if content_type != "application/json":
                    self._send_json(
                        {"ok": False,
                         "error": "Content-Type 必须是 application/json"}, 415)
                    return False
        return True

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
            if not self._guard_request():
                return
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
                # 空工程是正常状态：200 + exists:false，前端据此新建空文档，
                # 不再把「暂无文档」当作 404 错误上报到控制台。
                self._send_json({
                    "ok": True,
                    "exists": False,
                    "doc": None,
                    "save_token": None,
                })
            else:
                self._send_json({
                    "ok": True, "exists": True, "doc": doc,
                    "save_token": _current_save_token(),
                })
        elif path == "/api/tabs":
            idx, entries = _tabs_list()
            self._send_json({
                "ok": True,
                "active_id": idx.get("active"),
                "tabs": entries,
            })
        elif path == "/api/tabs/closed":
            self._send_json({
                "ok": True,
                "closed": _tabs_closed_list(),
            })
        elif path == "/api/tabs/doc":
            self._handle_tab_doc()
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
        elif path == "/api/prefs":
            self._handle_prefs_get()
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

    # ---- R5：用户风格偏好（prefs.json，原子写） -----------------------------

    _PREFS_KEYS = ("default_style_id", "custom_styles")
    _CS_TOKEN_KEYS = {"id", "name", "tags", "description", "refs",
                      "font", "palette", "plot", "markers", "dashes",
                      "legend", "grid", "background"}
    _CS_MARKERS = {"none", "circle", "square", "triangle", "diamond"}
    _CS_DASHES = {"solid", "dash", "dot", "dashdot"}
    _CS_LEGEND_POS = {"none", "right", "top", "bottom",
                      "inside-tr", "inside-tl", "inside-br", "inside-bl",
                      "inside-best"}
    _CS_PLOT_KEYS = {"frame", "tickDirection", "axisWidthPt", "tickLengthPt",
                     "markerSizePt", "lineWidthPt", "markerFill", "markerCycle",
                     "dashCycle", "background", "gridColor"}

    @staticmethod
    def _prefs_hex(v):
        return isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{3,8}", v) is not None

    def _validate_style_tokens(self, st, where):
        """与 lib/ops.js validateChartStyleTokens 同构的服务端校验。"""
        if not isinstance(st, dict):
            raise ValueError(where + " 必须是风格 token 对象")
        for k in st:
            if k not in self._CS_TOKEN_KEYS:
                raise ValueError(where + " 不允许的键: " + str(k))
        sid = st.get("id")
        if sid is not None and (not isinstance(sid, str)
                                or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", sid)):
            raise ValueError(where + ".id 必须是小写字母/数字/连字符字符串")
        name = st.get("name")
        if name is not None and (not isinstance(name, str) or len(name) > 40):
            raise ValueError(where + ".name 必须是不超过 40 字的字符串")
        tags = st.get("tags")
        if tags is not None and (not isinstance(tags, list) or len(tags) > 12
                                 or any(not isinstance(t, str) or len(t) > 20 for t in tags)):
            raise ValueError(where + ".tags 必须是不超过 12 个短字符串的数组")
        font = st.get("font")
        if font is not None:
            if not isinstance(font, dict):
                raise ValueError(where + ".font 必须是对象或 null")
            for k in font:
                if k not in ("family", "basePt", "tickPt", "titleWeight", "tickWeight"):
                    raise ValueError(where + ".font 不允许的键: " + str(k))
            if font.get("family") is not None and (not isinstance(font["family"], str)
                                                   or len(font["family"]) > 80):
                raise ValueError(where + ".font.family 必须是不超过 80 字的字符串")
            for k in ("basePt", "tickPt"):
                v = font.get(k)
                if v is not None and (not isinstance(v, (int, float))
                                      or isinstance(v, bool) or not 1 <= v <= 200):
                    raise ValueError(where + ".font." + k + " 必须是 1–200 的数字")
            for k in ("titleWeight", "tickWeight"):
                v = font.get(k)
                if v is not None and v not in ("normal", "bold"):
                    raise ValueError(where + ".font." + k + " 必须是 normal/bold")
        if st.get("palette") is not None and (not isinstance(st["palette"], str)
                                              or not st["palette"]):
            raise ValueError(where + ".palette 必须是非空字符串或 null")
        plot = st.get("plot")
        if plot is not None:
            if not isinstance(plot, dict):
                raise ValueError(where + ".plot 必须是对象或 null")
            for k in plot:
                if k not in self._CS_PLOT_KEYS:
                    raise ValueError(where + ".plot 不允许的键: " + str(k))
            if plot.get("frame") is not None and plot["frame"] not in ("open", "box"):
                raise ValueError(where + ".plot.frame 必须是 open/box")
            if plot.get("tickDirection") is not None and plot["tickDirection"] not in ("in", "out"):
                raise ValueError(where + ".plot.tickDirection 必须是 in/out")
            for k, lo, hi in (("axisWidthPt", 0, 5), ("tickLengthPt", 0, 20),
                              ("markerSizePt", 0.5, 40), ("lineWidthPt", 0.1, 20)):
                v = plot.get(k)
                if v is not None and (not isinstance(v, (int, float))
                                      or isinstance(v, bool) or not lo <= v <= hi):
                    raise ValueError(where + ".plot." + k + " 必须是 %s–%s 的数字" % (lo, hi))
            if plot.get("markerFill") is not None and plot["markerFill"] not in ("solid", "hollow"):
                raise ValueError(where + ".plot.markerFill 必须是 solid/hollow")
            for k in ("markerCycle", "dashCycle"):
                v = plot.get(k)
                if v is not None:
                    allowed = self._CS_MARKERS if k == "markerCycle" else self._CS_DASHES
                    if (not isinstance(v, list) or not 1 <= len(v) <= 12
                            or any(x not in allowed for x in v)):
                        raise ValueError(where + ".plot." + k + " 元素非法")
            for k in ("background", "gridColor"):
                v = plot.get(k)
                if v is not None and not self._prefs_hex(v):
                    raise ValueError(where + ".plot." + k + " 必须是 #hex 颜色或 null")
        markers = st.get("markers")
        if markers is not None:
            if not isinstance(markers, dict):
                raise ValueError(where + ".markers 必须是对象或 null")
            for k in markers:
                if k not in ("cycle", "fill"):
                    raise ValueError(where + ".markers 不允许的键: " + str(k))
            cyc = markers.get("cycle")
            if cyc is not None and (not isinstance(cyc, list) or not 1 <= len(cyc) <= 12
                                    or any(x not in self._CS_MARKERS for x in cyc)):
                raise ValueError(where + ".markers.cycle 元素非法")
            if markers.get("fill") is not None and markers["fill"] not in ("solid", "hollow"):
                raise ValueError(where + ".markers.fill 必须是 solid/hollow")
        dashes = st.get("dashes")
        if dashes is not None and (not isinstance(dashes, list) or not 1 <= len(dashes) <= 12
                                   or any(x not in self._CS_DASHES for x in dashes)):
            raise ValueError(where + ".dashes 元素非法")
        legend = st.get("legend")
        if legend is not None:
            if not isinstance(legend, dict):
                raise ValueError(where + ".legend 必须是对象或 null")
            for k in legend:
                if k not in ("position", "frame"):
                    raise ValueError(where + ".legend 不允许的键: " + str(k))
            if legend.get("position") is not None and legend["position"] not in self._CS_LEGEND_POS:
                raise ValueError(where + ".legend.position 非法")
            if legend.get("frame") is not None and not isinstance(legend["frame"], bool):
                raise ValueError(where + ".legend.frame 必须是 true/false")
        grid = st.get("grid")
        if grid is not None:
            if not isinstance(grid, dict):
                raise ValueError(where + ".grid 必须是对象或 null")
            for k in grid:
                if k not in ("show", "color"):
                    raise ValueError(where + ".grid 不允许的键: " + str(k))
            if grid.get("show") is not None and not isinstance(grid["show"], bool):
                raise ValueError(where + ".grid.show 必须是 true/false")
            if grid.get("color") is not None and not self._prefs_hex(grid["color"]):
                raise ValueError(where + ".grid.color 必须是 #hex 颜色")
        if st.get("background") is not None and not self._prefs_hex(st["background"]):
            raise ValueError(where + ".background 必须是 #hex 颜色或 null")

    def _read_prefs(self):
        out = {"default_style_id": None, "custom_styles": []}
        try:
            data = json.loads(PREFS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return out
        if not isinstance(data, dict):
            return out
        if isinstance(data.get("default_style_id"), str):
            out["default_style_id"] = data["default_style_id"]
        if isinstance(data.get("custom_styles"), list):
            out["custom_styles"] = [s for s in data["custom_styles"]
                                    if isinstance(s, dict)][:50]
        return out

    def _write_prefs(self, prefs):
        PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = PREFS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(prefs, ensure_ascii=False, indent=1),
                       encoding="utf-8")
        os.replace(tmp, PREFS_PATH)

    def _validate_prefs_patch(self, patch):
        if not isinstance(patch, dict):
            raise ValueError("prefs 补丁必须是对象")
        for k in patch:
            if k not in self._PREFS_KEYS:
                raise ValueError("prefs 不允许的键: " + str(k))
        out = {}
        if "default_style_id" in patch:
            v = patch["default_style_id"]
            if v is not None and (not isinstance(v, str) or not 1 <= len(v) <= 80):
                raise ValueError("default_style_id 必须是非空字符串或 null")
            out["default_style_id"] = v
        if "custom_styles" in patch:
            v = patch["custom_styles"]
            if not isinstance(v, list) or len(v) > 50:
                raise ValueError("custom_styles 必须是不超过 50 项的数组")
            seen = set()
            cleaned = []
            for i, st in enumerate(v):
                self._validate_style_tokens(st, "custom_styles[%d]" % i)
                sid = st.get("id")
                if not isinstance(sid, str) or not re.fullmatch(r"my-[a-z0-9][a-z0-9-]{0,58}", sid):
                    raise ValueError("custom_styles[%d].id 必须是 my- 前缀的 slug" % i)
                if sid in seen:
                    raise ValueError("custom_styles[%d].id 重复: %s" % (i, sid))
                seen.add(sid)
                cleaned.append(json.loads(json.dumps(st, ensure_ascii=False)))
            out["custom_styles"] = cleaned
        return out

    def _handle_prefs_get(self):
        self._send_json({"ok": True, "prefs": self._read_prefs()})

    def _handle_prefs_post(self, body):
        patch = body.get("patch") if isinstance(body, dict) else None
        upd = self._validate_prefs_patch(patch)
        prefs = self._read_prefs()
        prefs.update(upd)
        self._write_prefs(prefs)
        self._send_json({"ok": True, "prefs": prefs})

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
                        _STATE["save_token"] = _save_token(restored)
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
            if not self._guard_request():
                return
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
            elif path == "/api/tabs/new":
                self._handle_tab_new(body)
            elif path == "/api/tabs/switch":
                self._handle_tab_switch(body)
            elif path == "/api/tabs/close":
                self._handle_tab_close(body)
            elif path == "/api/tabs/restore":
                self._handle_tab_restore(body)
            elif path == "/api/export":
                self._handle_export(body)
            elif path == "/api/export-to-dir":
                self._handle_export_to_dir(body)
            elif path == "/api/projects/migrate":
                self._handle_projects_migrate(body)
            elif path == "/api/prefs":
                self._handle_prefs_post(body)
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
        # 该路由不走 do_POST 入口的统一 Content-Type 守卫（守卫对它放行），
        # 这里保留路由自带的检查，错误语义与历史一致（ValueError -> 400）。
        content_type = (self.headers.get("Content-Type") or "") \
            .split(";", 1)[0].strip().lower()
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
        saved_path, save_token = _save_current(
            doc, base_token,
            preserve_tabs=(path == "/api/doc"
                           and base_token is _EXPLICIT_REPLACE))
        self._send_json({
            "ok": True,
            "doc": doc,
            "path": saved_path,
            "save_token": save_token,
            "saved_at": _now_iso(),
            "summary": _doc_summary(doc),
        })

    # ---- 多画布标签页 ----------------------------------------------------

    def _tabs_payload(self):
        idx, entries = _tabs_list()
        doc = _get_current_doc()
        save_token = _current_save_token()
        return {
            "ok": True,
            "doc": doc,
            "save_token": save_token,
            "tabs": entries,
            "active_id": idx.get("active"),
        }

    def _handle_tab_doc(self):
        """GET /api/tabs/doc?id=<tabId>：只读返回指定标签页文档 {ok, doc}。
        活动标签返回当前内存文档；其余标签读 tabs/<id>.figureproj.json。
        id 必须在标签顺序表中（防路径穿越），不允许读 closed/ 归档。"""
        if DOCIO is None:
            self._send_json({"ok": False, "error": "docio 不可用"}, 503)
            return
        q = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(q)
        ids = params.get("id") or []
        tab_id = ids[0] if ids else None
        if not isinstance(tab_id, str) or not tab_id:
            self._send_json({"ok": False, "error": "缺少 id"}, 400)
            return
        cur = _get_current_doc()
        cur_id = cur.get("id") if isinstance(cur, dict) else None
        if tab_id == cur_id:
            self._send_json({"ok": True, "doc": cur})
            return
        idx = _tabs_index_load()
        if tab_id not in (idx.get("order") or []):
            self._send_json({
                "ok": False, "error": "未知画布标签页：%s" % tab_id}, 404)
            return
        tab_path = _tab_file(tab_id)
        if not tab_path.is_file():
            self._send_json({
                "ok": False, "error": "标签页文件不存在：%s" % tab_id}, 404)
            return
        try:
            loaded = DOCIO.load_project(str(tab_path))
        except Exception as exc:
            self._send_json({
                "ok": False, "error": "标签页文件损坏：%s" % exc}, 400)
            return
        doc = loaded.get("doc") if isinstance(loaded, dict) else None
        if not isinstance(doc, dict):
            self._send_json({
                "ok": False, "error": "标签页文件损坏：%s" % tab_id}, 400)
            return
        self._send_json({"ok": True, "doc": doc})

    def _handle_tab_new(self, body):
        if DOCIO is None:
            raise RuntimeError("docio 不可用，无法管理画布标签页")
        doc = body.get("doc") if isinstance(body, dict) else None
        if not isinstance(doc, dict):
            self._send_json({"ok": False, "error": "请求体必须包含 doc 对象"}, 400)
            return
        new_id = doc.get("id")
        if not isinstance(new_id, str) or not new_id:
            self._send_json({"ok": False, "error": "新画布缺少文档 id"}, 400)
            return
        _validate_or_raise(doc)
        # 单临界区：token 校验 + 备份当前标签 + 建新标签 + 切换 current +
        # 更新 index，任何一步失败都不留下半成品状态。
        with _STATE_LOCK:
            _tabs_check_token(body.get("base_token"))
            idx = _tabs_index_ensure()
            if new_id in idx["order"]:
                self._send_json({
                    "ok": False,
                    "error": "画布 id 已存在：%s" % new_id}, 400)
                return
            _tabs_save_current_locked()
            # 先把新 id 写进 order 再切 current：否则归一化会把它当成
            # 「活动标签被替换」而原位覆盖旧 active 项。
            idx["order"].append(new_id)
            idx["active"] = new_id
            _tabs_index_save(idx)
            _save_current(doc, _EXPLICIT_REPLACE)
            _tabs_write_doc_file(doc, new_id)
        self._send_json(self._tabs_payload())

    def _handle_tab_switch(self, body):
        if DOCIO is None:
            raise RuntimeError("docio 不可用，无法管理画布标签页")
        to_id = body.get("to_id") if isinstance(body, dict) else None
        if not isinstance(to_id, str) or not to_id:
            self._send_json({"ok": False, "error": "缺少 to_id"}, 400)
            return
        with _STATE_LOCK:
            _tabs_check_token(body.get("base_token"))
            idx = _tabs_index_ensure()
            if to_id not in idx["order"]:
                self._send_json({
                    "ok": False, "error": "未知画布标签页：%s" % to_id}, 400)
                return
            cur = _STATE.get("doc")
            if isinstance(cur, dict) and cur.get("id") == to_id:
                # 切到自己：无操作，直接回当前状态
                self._send_json(self._tabs_payload())
                return
            # 先把目标标签文件读入并校验，失败时不做任何变更
            tab_path = _tab_file(to_id)
            if not tab_path.is_file():
                self._send_json({
                    "ok": False, "error": "标签页文件不存在：%s" % to_id}, 400)
                return
            loaded = DOCIO.load_project(str(tab_path))
            target = loaded.get("doc")
            if not isinstance(target, dict):
                self._send_json({
                    "ok": False, "error": "标签页文件损坏：%s" % to_id}, 400)
                return
            _tabs_save_current_locked()
            _save_current(target, _EXPLICIT_REPLACE)
            idx = _tabs_index_load()
            idx["active"] = to_id
            _tabs_index_save(idx)
        self._send_json(self._tabs_payload())

    def _handle_tab_close(self, body):
        if DOCIO is None:
            raise RuntimeError("docio 不可用，无法管理画布标签页")
        tab_id = body.get("id") if isinstance(body, dict) else None
        if not isinstance(tab_id, str) or not tab_id:
            self._send_json({"ok": False, "error": "缺少 id"}, 400)
            return
        with _STATE_LOCK:
            _tabs_check_token(body.get("base_token"))
            idx = _tabs_index_ensure()
            order = list(idx["order"])
            if len(order) <= 1:
                self._send_json({
                    "ok": False,
                    "error": "至少需要保留一个画布标签页"}, 400)
                return
            if tab_id not in order:
                self._send_json({
                    "ok": False, "error": "未知画布标签页：%s" % tab_id}, 400)
                return
            was_active = idx.get("active") == tab_id
            neighbour = None
            neighbour_doc = None
            if was_active:
                pos = order.index(tab_id)
                if pos + 1 < len(order):
                    neighbour = order[pos + 1]
                elif pos > 0:
                    neighbour = order[pos - 1]
                # 关活动标签前先把邻居读入并校验：失败则什么都不改
                if neighbour is not None:
                    npath = _tab_file(neighbour)
                    if not npath.is_file():
                        self._send_json({
                            "ok": False,
                            "error": "相邻画布文件缺失，无法切换：%s" % neighbour},
                            400)
                        return
                    try:
                        nloaded = DOCIO.load_project(str(npath))
                    except Exception as exc:
                        self._send_json({
                            "ok": False,
                            "error": "相邻画布文件损坏，无法切换：%s" % exc},
                            400)
                        return
                    neighbour_doc = nloaded.get("doc")
                    if not isinstance(neighbour_doc, dict):
                        self._send_json({
                            "ok": False,
                            "error": "相邻画布文件损坏，无法切换：%s" % neighbour},
                            400)
                        return
            # ---- 以下为变更 ----
            if was_active and neighbour_doc is not None:
                _tabs_save_current_locked()   # 被关标签的最后状态先归档素材
                _save_current(neighbour_doc, _EXPLICIT_REPLACE)
            # 归档被关标签文件（不删除）
            src = _tab_file(tab_id)
            if src.is_file():
                TABS_CLOSED_DIR.mkdir(parents=True, exist_ok=True)
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                os.replace(str(src), str(TABS_CLOSED_DIR /
                                         ("%s-%s.figureproj.json" % (tab_id, stamp))))
            idx = _tabs_index_load()
            idx["order"] = [d for d in idx["order"] if d != tab_id]
            if idx.get("active") == tab_id or was_active:
                idx["active"] = neighbour if neighbour in idx["order"] else (
                    idx["order"][0] if idx["order"] else None)
            _tabs_index_save(idx)
        self._send_json(self._tabs_payload())

    def _handle_tab_restore(self, body):
        """还原 tabs/closed/ 里的归档：移回 tabs/<id>.figureproj.json 并激活。
        归档里的 doc id 已是打开标签时等价于切换（归档保留原位）。
        单临界区内完成 token 校验与全部变更；任何校验失败都不改状态。"""
        if DOCIO is None:
            raise RuntimeError("docio 不可用，无法管理画布标签页")
        file_name = body.get("file") if isinstance(body, dict) else None
        if not isinstance(file_name, str) or not file_name:
            self._send_json({"ok": False, "error": "缺少 file"}, 400)
            return
        # 只允许 closed/ 下的真实文件名，拒绝路径穿越与目录套娃
        if (os.path.basename(file_name) != file_name
                or file_name in (".", "..")
                or not file_name.endswith(".figureproj.json")):
            self._send_json({"ok": False, "error": "非法的归档文件名"}, 400)
            return
        archive = TABS_CLOSED_DIR / file_name
        if not archive.is_file():
            self._send_json({
                "ok": False, "error": "归档文件不存在：%s" % file_name}, 400)
            return
        with _STATE_LOCK:
            _tabs_check_token(body.get("base_token"))
            idx = _tabs_index_ensure()
            # 先读入归档并校验，失败时什么都不改
            try:
                loaded = DOCIO.load_project(str(archive))
            except Exception as exc:
                self._send_json({
                    "ok": False, "error": "归档文件损坏：%s" % exc}, 400)
                return
            doc = loaded.get("doc")
            if not isinstance(doc, dict):
                self._send_json({
                    "ok": False, "error": "归档文件损坏：%s" % file_name}, 400)
                return
            doc_id = doc.get("id")
            if not isinstance(doc_id, str) or not doc_id:
                self._send_json({
                    "ok": False, "error": "归档文档缺少 id"}, 400)
                return
            if doc_id in idx["order"]:
                # 该 id 已是打开的标签：等价于切换到它，归档保留原位
                tab_path = _tab_file(doc_id)
                if not tab_path.is_file():
                    self._send_json({
                        "ok": False,
                        "error": "标签页文件不存在：%s" % doc_id}, 400)
                    return
                try:
                    target = DOCIO.load_project(str(tab_path)).get("doc")
                except Exception as exc:
                    self._send_json({
                        "ok": False, "error": "标签页文件损坏：%s" % exc},
                        400)
                    return
                if not isinstance(target, dict):
                    self._send_json({
                        "ok": False,
                        "error": "标签页文件损坏：%s" % doc_id}, 400)
                    return
                cur = _STATE.get("doc")
                if isinstance(cur, dict) and cur.get("id") == doc_id:
                    self._send_json(self._tabs_payload())
                    return
                _tabs_save_current_locked()
                _save_current(target, _EXPLICIT_REPLACE)
                idx = _tabs_index_load()
                idx["active"] = doc_id
                _tabs_index_save(idx)
            else:
                # 归档移回 tabs/<id>.figureproj.json，成为活动标签。
                # 先把 id 登记进 order 再切 current（同 tabs/new）：否则
                # _tabs_normalize 会把新 current id 当成「活动标签被替换」
                # 原位覆盖掉现有 active 项。
                _tabs_save_current_locked()
                os.replace(str(archive), str(_tab_file(doc_id)))
                idx["order"].append(doc_id)
                idx["active"] = doc_id
                _tabs_index_save(idx)
                _save_current(doc, _EXPLICIT_REPLACE)
        self._send_json(self._tabs_payload())

    def _handle_export(self, body):
        self._export_common(body, to_dir=False)

    def _handle_export_to_dir(self, body):
        """R07/R08：导出直接写入用户数据目录 exports/ 文件夹并返回绝对路径。

        浏览器下载在受限窗口（内嵌浏览器等）可能无法落地；本端点由服务端
        走同一 canonical SVG + figraster 链写盘，任何环境可用。仅 loopback。
        请求体：{doc?, format, dpi?, panel_id?, transparent?, filename?}
        """
        self._export_common(body, to_dir=True)

    def _export_common(self, body, to_dir):
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

        if to_dir:
            # 服务端直接写盘：用户数据目录 exports/（与插件代码分离），
            # 同名文件自动加序号不覆盖；返回绝对路径。
            if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
                self.close_connection = True
                self._send_json({"ok": False, "error": "仅允许本机 loopback 请求"}, 403)
                return
            exports_dir = FIGPATHS.data_dir() / "exports" if FIGPATHS is not None \
                else PLUGIN_DIR / "projects" / "exports"
            exports_dir.mkdir(parents=True, exist_ok=True)
            filename = _suggest_filename(doc, fmt, dpi, size_mm, panel_id)
            raw_name = body.get("filename")
            if isinstance(raw_name, str) and raw_name.strip():
                safe = Path(raw_name.strip()).name  # 去掉任何路径成分
                if safe.lower().endswith("." + ("jpg" if fmt == "jpeg" else fmt)):
                    filename = safe
                else:
                    filename = safe + "." + ("jpg" if fmt == "jpeg" else fmt)
            target = exports_dir / filename
            n = 1
            while target.exists():
                stem = target.stem
                target = exports_dir / ("%s-%d%s" % (stem, n, target.suffix))
                n += 1
            if fmt == "svg":
                target.write_text(svg, encoding="utf-8")
            else:
                FIGRASTER.export_svg(
                    svg, doc, str(target), fmt, dpi=dpi,
                    panel_id=panel_id, transparent=transparent)
            self._send_json({
                "ok": True,
                "path": str(target.resolve()),
                "bytes": target.stat().st_size,
                "format": fmt,
                "dpi": dpi,
                "size_mm": list(size_mm),
            })
            return

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
        _STATE["save_token"] = _save_token(doc)
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
                      "保留原文件，可在工作台「工程」面板或 POST /api/projects/migrate "
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
