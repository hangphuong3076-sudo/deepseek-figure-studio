# -*- coding: utf-8 -*-
"""selftest.py — figure-drawing 插件包端到端自测。

真实拉起同目录的 server.py（stdio JSON-RPC 2.0），按技能文档的七步工作流：
initialize -> tools/list -> figure_create(nature-single) -> figure_open_data
-> figure_create_chart(推荐模板 + npg) -> figure_add_anchor -> figure_apply_edits
-> figure_check -> figure_render(svg) -> figure_export(tiff/png)，
后用 PyMuPDF 复核 PDF 矢量几何和统一栅格链、Pillow 复核位图编码尺寸/DPI。
覆盖科学合同、表征、模板、历史以及 XPS 的 PNG/JPEG/TIFF/PDF 导出。
历史覆盖纯内存 origin、真实 DOM 分支缩略图代次与缓存隔离、服务端同 ID 文档分叉、
201 条裁剪及序列化重放、save/open 幂等和 revert 有界性，以及新进程无 cache 的模板恢复。

运行需要 Node.js 与 Python 的 PyMuPDF、Pillow、openpyxl；xlrd 供旧 xls 导入。
工作簿自测使用真实 openpyxl 字节、真实 MCP、随机端口 HTTP 和最小 DOM 级 UI 函数；
UI 断言不是完整 WebView 像素级 GUI 自动化。
scope/安全探针使用独立 MCP 进程与本机随机端口，不读取正式 current.figureproj.json。
XPS 双区域探针分别导出两个真实 chart id，核对 MCP/HTTP 的物理尺寸、scoped 文件名、
透明 PNG 曲线、PDF 文本隔离及相对整 panel 对应 frame 的像素；这不是 raw SVG token 判定，
也不是完整 WebView 像素级 GUI 自动化，更不表示 GUI 的单选子图导出已完成验证。
强制离线：清空 DEEPSEEK_API_KEY。全部产物写入隔离临时目录并在结束后删除；--out 仅指定临时目录的已存在父目录。
退出码：0 = 全部 PASS；1 = 存在 FAIL。

运行：python -B mcp/selftest.py
"""

import argparse
import base64
import collections
import io
import json
import math
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from http.server import ThreadingHTTPServer
from pathlib import Path

MCP_DIR = Path(__file__).resolve().parent          # mcp/
PLUGIN_ROOT = MCP_DIR.parent                        # 插件根目录
SAMPLE_CSV = PLUGIN_ROOT / "examples" / "sample.csv"
JOURNAL_ID = "nature-single"                        # 89 x 170 mm @ 300 dpi
EXPECTED_TOOLS = 26

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

RESULTS = []


def record(name, passed, detail=""):
    RESULTS.append((name, bool(passed)))
    tag = "PASS" if passed else "FAIL"
    line = "[%s] %s" % (tag, name)
    if detail:
        line += " | " + str(detail)
    print(line, flush=True)


def clip(text, n=180):
    text = str(text).replace("\n", " ")
    return text if len(text) <= n else text[:n] + "...(截断)"


class JsonRpcEOF(Exception):
    pass


class MCPClient:
    """最小 stdio JSON-RPC 2.0 客户端。"""

    def __init__(self):
        self.proc = None
        self._q = None
        self._req_id = 0
        self._stderr_tail = []

    def start(self, cwd=None):
        env = dict(os.environ)
        env.pop("DEEPSEEK_API_KEY", None)  # 强制离线：审阅走 fallback
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        self.proc = subprocess.Popen(
            [sys.executable, "-B", str(MCP_DIR / "server.py")],
            cwd=str(cwd or MCP_DIR), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            errors="replace", bufsize=1)
        self._q = queue.Queue()
        self._stderr_tail = collections.deque(maxlen=40)
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self):
        try:
            for line in self.proc.stdout:
                self._q.put(line)
        except Exception:
            pass
        self._q.put(None)  # EOF 哨兵

    def _pump_stderr(self):
        try:
            for line in self.proc.stderr:
                self._stderr_tail.append(line.rstrip()[:300])
        except Exception:
            pass

    def request(self, method, params=None, timeout=120):
        self._req_id += 1
        rid = self._req_id
        req = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            req["params"] = params
        self.proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise TimeoutError("%s 在 %.0f 秒内无响应" % (method, timeout))
            try:
                line = self._q.get(timeout=min(remain, 1.0))
            except queue.Empty:
                continue
            if line is None:
                raise JsonRpcEOF("服务器 stdout 已关闭（exit=%s）；stderr 末尾: %s" % (
                    self.proc.poll(),
                    " | ".join(list(self._stderr_tail)[-5:]) or "(空)"))
            obj = json.loads(line)
            if obj.get("id") != rid:
                continue  # 早前超时请求的迟到响应
            return obj

    def call_tool(self, name, arguments, timeout=180):
        obj = self.request("tools/call", {"name": name, "arguments": arguments},
                           timeout=timeout)
        if "error" in obj:
            raise AssertionError("%s JSON-RPC 层错误: %s" % (name, obj["error"]))
        payload = json.loads(obj["result"]["content"][0]["text"])
        print("  -> %s: %s" % (name, clip(json.dumps(
            {k: v for k, v in payload.items() if k != "doc"}, ensure_ascii=False), 200)),
            flush=True)
        return payload

    def raw_line(self, text, timeout=30):
        """发送一行原始文本（可为非法 JSON），返回下一条原始响应对象。"""
        self.proc.stdin.write(text + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise TimeoutError("原始请求在 %.0f 秒内无响应" % timeout)
            try:
                line = self._q.get(timeout=min(remain, 1.0))
            except queue.Empty:
                continue
            if line is None:
                raise JsonRpcEOF("服务器 stdout 已关闭（exit=%s）" % self.proc.poll())
            return json.loads(line)

    def stop(self):
        try:
            if self.proc:
                try:
                    self.proc.stdin.close()
                except Exception:
                    pass
                try:
                    self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        except Exception:
            pass


def history_origin_memory_probe():
    """Pure kernel/JSON checks; no files, DOM, model calls or server cache."""
    script = r"""
const assert = require('assert');
require('./lib/figdoc.js');
require('./lib/ops.js');
require('./lib/storage.js');
let base = FigDoc.create({title: 'origin-memory'});
base.key = 'excluded';
base.DOM = {host: 'excluded'};
base.saveToken = 'excluded';
base.meta.key = 'excluded';
base.meta.saveToken = 'excluded';
base.meta.recovery_marker = 'preserved';
let changed = FigOps.applyAll(base, [{op: 'add_element', element: {
  type: 'text', text: 'real-content', transform: {x: 2, y: 3, w: 30, h: 8}
}}], {ts: '2026-01-01T00:00:00.000Z'}).doc;
assert.strictEqual(changed.meta.history_origin.rev, 0);
assert.strictEqual(changed.history[0].base_rev, 0);
assert.strictEqual(changed.meta.history_origin.doc.elements.length, 0);
assert.strictEqual(changed.meta.history_origin.doc.meta.recovery_marker, 'preserved');
assert.strictEqual('history' in changed.meta.history_origin.doc, false);
assert.strictEqual('history_origin' in changed.meta.history_origin.doc.meta, false);
for (const key of ['key', 'DOM', 'saveToken']) {
  assert.strictEqual(key in changed.meta.history_origin.doc, false);
  assert.strictEqual(key in changed.meta.history_origin.doc.meta, false);
}
assert.strictEqual(FigDoc.validate(changed).ok, true);
const id = changed.elements[0].id;
let doc = JSON.parse(JSON.stringify(changed));
let back = FigOps.revertTo(doc, 0);
assert.strictEqual(back.elements.length, 0);
let forward = FigOps.revertTo(JSON.parse(JSON.stringify(back)), 1);
assert.deepStrictEqual(forward.elements.map(el => el.id), [id]);
assert.strictEqual(forward.meta.history_origin.rev, 0);
let once = FigOps.captureHistoryOrigin(forward);
let twice = FigOps.captureHistoryOrigin(once);
assert.strictEqual(JSON.stringify(once), JSON.stringify(twice));
let persisted = JSON.stringify(forward);
for (let i = 0; i < 3; i++) {
  let project = FigStore.projectFromDoc(JSON.parse(persisted), {});
  doc = FigStore.docFromProject(project);
  assert.strictEqual(JSON.stringify(doc), persisted);
  persisted = JSON.stringify(doc);
}
let legacy = JSON.parse(persisted);
delete legacy.meta.history_origin;
let loadedLegacy = FigStore.docFromProject(FigStore.projectFromDoc(legacy, {}));
assert.strictEqual(loadedLegacy.meta.history_origin.rev, 1);
let error = '';
try { FigOps.revertTo(loadedLegacy, 0); } catch (err) { error = err.message; }
assert.strictEqual(error.includes('older cache'), true);
assert.strictEqual(error.includes('history_origin'), true);
console.log('origin rev 0→1, ids stable, legacy pre-origin rejected, JSON bounded');
"""
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    try:
        proc = subprocess.run(["node", "-e", script], cwd=str(MCP_DIR), env=env,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=45)
    except Exception as exc:
        return False, "%s: %s" % (exc.__class__.__name__, exc)
    if proc.returncode != 0:
        return False, clip(proc.stderr or proc.stdout)
    return True, clip(proc.stdout)


def history_ui_regression_probe():
    """Execute the real history UI against DOM nodes and controllable image jobs."""
    script = r"""
const assert = require('assert');
require('./lib/figdoc.js');
require('./lib/ops.js');
require('./lib/storage.js');
require('./viewer_static/app/state.js');

class DOMNode {
  constructor(tag, connected) {
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.eventListeners = {};
    this._text = '';
    this._connected = connected === true;
    this.title = '';
    this.value = '';
  }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected : this._connected; }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = value == null ? '' : String(value);
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener(name, handler) {
    (this.eventListeners[name] || (this.eventListeners[name] = [])).push(handler);
  }
  focus() {}
}
const documentRoot = new DOMNode('root', true);
global.document = { createElement: tag => new DOMNode(tag) };
global.Ui = { confirm: async () => true };
require('./viewer_static/app/history.js');

const results = [];
let releaseB;
const waitingB = new Promise(resolve => { releaseB = resolve; });
let rejectBad;
const waitingBad = new Promise((resolve, reject) => { rejectBad = reject; });
let failJob = false;
const thumbnailCalls = [];
FigStore.thumbnail = function(doc) {
  const text = doc.elements.length ? doc.elements[0].text : 'empty';
  thumbnailCalls.push(text);
  if (text === 'B') return waitingB.then(() => 'thumb:B');
  if (failJob && text === 'C') return waitingBad;
  return Promise.resolve('thumb:' + text);
};
async function flush() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
async function waitFor(predicate) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await flush(); }
  assert.ok(predicate(), '等待异步历史 UI 完成超时');
}
async function test(name, fn) {
  try { await fn(); results.push({name, ok: true, detail: 'PASS'}); }
  catch (err) { results.push({name, ok: false, detail: err && err.stack ? err.stack : String(err)}); }
}
function all(node, className, out) {
  out = out || [];
  if (node.className === className) out.push(node);
  for (const child of node.children) all(child, className, out);
  return out;
}
function rowFor(panel, rev) {
  return all(panel, 'history-row').find(row =>
    all(row, 'history-rev').some(label => label.textContent === '#' + rev));
}
function imageURL(panel, rev) {
  const row = rowFor(panel, rev);
  const box = row && all(row, 'history-thumb')[0];
  const img = box && box.children.find(child => child.tagName === 'IMG');
  return img ? img.src : null;
}
function textOf(doc) { return doc.elements.length ? doc.elements[0].text : ''; }

(async () => {
  await test('真实 DOM A+B→restore1→A+C 分支缩略图不串旧 rev2', async () => {
    const panel = new DOMNode('section');
    documentRoot.appendChild(panel);
    App.setDoc(FigDoc.create({title: 'history-DOM'}), {reason: 'boot'});
    await App.commit([{op: 'add_element', element: {
      type: 'text', text: 'A', transform: {x: 1, y: 1, w: 30, h: 8}
    }}], {label: 'A'});
    await App.commit([{op: 'set_text', targets: [App.doc.elements[0].id], text: 'B'}], {label: 'B'});
    const oldHash = App.doc.history[1].doc_sha256;
    assert.ok(oldHash, 'rev2/B 必须有内容哈希');
    History.mount(panel);
    await waitFor(() => thumbnailCalls.includes('B'));

    assert.strictEqual(await History.restore(1), true);
    assert.strictEqual(textOf(App.doc), 'A');
    await App.commit([{op: 'set_text', targets: [App.doc.elements[0].id], text: 'C'}], {label: 'C'});
    assert.deepStrictEqual(App.doc.history.map(r => r.rev), [1, 2]);
    assert.notStrictEqual(App.doc.history[1].doc_sha256, oldHash);
    assert.strictEqual(textOf(App.doc), 'C');

    releaseB();
    await waitFor(() => imageURL(panel, 2) === 'thumb:C');
    assert.notStrictEqual(imageURL(panel, 2), 'thumb:B');
    assert.strictEqual(imageURL(panel, 1), 'thumb:A');
    assert.ok(rowFor(panel, 2).textContent.includes('C'));
    assert.ok(!rowFor(panel, 2).textContent.includes('B'));
    panel.parentNode.removeChild(panel);
  });

  await test('无 doc_sha256 的缩略图不进入长期缓存', async () => {
    const panel = new DOMNode('section');
    documentRoot.appendChild(panel);
    const doc = FigDoc.clone(App.doc);
    doc.history[1].doc_sha256 = null;
    App.setDoc(doc, {reason: 'no-hash'});
    History.mount(panel);
    await waitFor(() => thumbnailCalls.filter(text => text === 'C').length >= 2);
    const before = thumbnailCalls.filter(text => text === 'C').length;
    App.emit('history:changed', {doc: App.doc, reason: 'repeat-render'});
    await waitFor(() => thumbnailCalls.filter(text => text === 'C').length > before);
    assert.strictEqual(imageURL(panel, 2), 'thumb:C');
    panel.parentNode.removeChild(panel);
  });

  await test('旧图片失败任务不把新同 rev 文档写成文字回退', async () => {
    const panel = new DOMNode('section');
    documentRoot.appendChild(panel);
    const bad = FigDoc.clone(App.doc);
    bad.history = [bad.history[1]];
    bad.history[0].doc_sha256 = null;
    failJob = true;
    App.setDoc(bad, {reason: 'old-failing-generation'});
    History.mount(panel);
    await flush();
    const good = FigDoc.clone(bad);
    good.history[0].thumbnail_ref = 'thumb:replacement';
    App.setDoc(good, {reason: 'replacement-generation'});
    rejectBad(new Error('旧图片解码失败'));
    failJob = false;
    await waitFor(() => imageURL(panel, 2) === 'thumb:replacement');
    assert.strictEqual(imageURL(panel, 2), 'thumb:replacement');
    panel.parentNode.removeChild(panel);
  });
  console.log('__RESULTS__' + JSON.stringify(results));
})().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
"""
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    try:
        proc = subprocess.run(["node", "-e", script], cwd=str(MCP_DIR), env=env,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60)
    except Exception as exc:
        return [("历史 UI DOM 回归探针", False, "%s: %s" % (exc.__class__.__name__, exc))]
    marker = "__RESULTS__"
    line = next((item for item in proc.stdout.splitlines() if item.startswith(marker)), None)
    if proc.returncode != 0 or line is None:
        return [("历史 UI DOM 回归探针", False, clip(proc.stderr or proc.stdout))]
    try:
        results = json.loads(line[len(marker):])
        return [(item["name"], bool(item["ok"]), clip(item.get("detail", "")))
                for item in results]
    except Exception as exc:
        return [("历史 UI DOM 回归探针结果解析", False, str(exc))]


def server_history_regression_probe(client, out_dir):
    """Exercise persistence/replay boundaries through real MCP public tools."""
    results = []
    state = {}

    def capture(name, fn):
        try:
            passed, detail = fn()
            results.append((name, bool(passed), detail))
        except Exception as exc:
            results.append((name, False, "%s: %s" % (exc.__class__.__name__, exc)))

    def same_id_cache_isolation():
        primary = client.call_tool("figure_create", {
            "title": "缓存原分支", "width_mm": 90, "height_mm": 50})["doc"]
        branch_a = client.call_tool("figure_apply_edits", {
            "doc": primary,
            "ops": [{"op": "add_element", "element": {
                "type": "text", "text": "CACHE-A",
                "transform": {"x": 2, "y": 2, "w": 35, "h": 8}}}],
        })
        assert branch_a.get("ok") is True

        unrelated = MCPClient()
        try:
            unrelated.start()
            replacement = unrelated.call_tool("figure_create", {
                "title": "同 ID 不同文档", "width_mm": 90, "height_mm": 50})["doc"]
            replacement["id"] = primary["id"]
            branch_b = unrelated.call_tool("figure_apply_edits", {
                "doc": replacement,
                "ops": [{"op": "add_element", "element": {
                    "type": "text", "text": "CACHE-B",
                    "transform": {"x": 2, "y": 2, "w": 35, "h": 8}}}],
            })
        finally:
            unrelated.stop()
        assert branch_b.get("ok") is True
        recovered = client.call_tool("figure_revert", {
            "doc": branch_b["doc"], "rev": branch_b["doc"]["history"][-1]["rev"]})
        texts = [e.get("text") for e in (recovered.get("doc") or {}).get("elements") or []
                 if e.get("type") == "text"]
        alive = "result" in client.request("ping")
        return (recovered.get("ok") is True and texts == ["CACHE-B"]
                and "CACHE-A" not in texts and alive), "恢复 texts=%r，ping=%r" % (texts, alive)

    capture("真实服务端同 doc.id 不同文档不得命中旧 rev 快照，且可安全继续服务",
            same_id_cache_isolation)

    def public_history_prune():
        current = client.call_tool("figure_create", {
            "title": "201 条历史上限", "width_mm": 90, "height_mm": 50})["doc"]
        for index in range(201):
            payload = client.call_tool("figure_apply_edits", {
                "doc": current,
                "ops": [{"op": "note", "note": "bounded-%03d" % (index + 1)}],
            })
            assert payload.get("ok") is True, payload.get("error")
            current = payload["doc"]
        state["pruned"] = current
        history = current.get("history") or []
        origin = (current.get("meta") or {}).get("history_origin") or {}
        provenance = (origin.get("doc") or {}).get("meta", {}).get("provenance") or []
        return (len(history) == 200 and history[0].get("rev") == 2
                and history[-1].get("rev") == 201 and origin.get("rev") == 1
                and len(provenance) == 1,
            "history=%d rev=%s..%s origin.rev=%r" % (
                len(history), history[0].get("rev"), history[-1].get("rev"), origin.get("rev")))

    capture("201 次 public 编辑后历史=200，origin 随裁剪推进到真实 rev1",
            public_history_prune)

    def repeated_save_open():
        current = state["pruned"]
        path = out_dir / "history-bounded-save-open.figureproj.json"
        state["bounded_path"] = path
        expected_history = None
        expected_origin = None
        checkpoint_counts = []
        for _ in range(3):
            saved = client.call_tool("figure_save_project", {"doc": current, "path": str(path)})
            assert saved.get("ok") is True
            project = json.loads(path.read_text(encoding="utf-8"))
            history = project.get("history") or []
            origin = project["doc"]["meta"]["history_origin"]
            checkpoints = sum(1 for rec in history if rec.get("checkpoint"))
            checkpoint_counts.append(checkpoints)
            if expected_history is None:
                expected_history = history
                expected_origin = origin
            assert history == expected_history, "save/open 新增了持久历史或永久检查点"
            assert origin == expected_origin, "save/open 改写了持久化回放 origin"
            loaded = client.call_tool("figure_load_project", {"path": str(path)})
            assert loaded.get("ok") is True
            current = loaded["doc"]
            assert current.get("history") == expected_history
        return (len(expected_history) == 200 and checkpoint_counts == [0, 0, 0]
                and len(current["history"]) == 200,
            "三轮 save/open：history=200，checkpoint=%r" % checkpoint_counts)

    capture("反复 figure_save_project/load_project 不新增 permanent checkpoint 或历史",
            repeated_save_open)

    def serialize_replay_after_prune():
        target = state["pruned"]["history"][0]["rev"]
        fresh = MCPClient()
        try:
            fresh.start()
            loaded = fresh.call_tool("figure_load_project", {
                "path": str(state["bounded_path"])})["doc"]
            serialized = json.dumps(loaded, ensure_ascii=False)
            replayed = fresh.call_tool("figure_revert", {"doc": loaded, "rev": target})
            doc = replayed.get("doc") or {}
            notes = (doc.get("meta") or {}).get("provenance") or []
            return (replayed.get("ok") is True and target == 2 and len(notes) == 2
                    and "__snapshots" not in serialized
                    and len((doc.get("meta") or {}).get("history_origin", {})
                            .get("doc", {}).get("history", [])) == 0,
                "fresh process rev%s provenance=%d，%s" % (
                    target, len(notes), replayed.get("error") or "replay ok"))
        finally:
            fresh.stop()

    capture("201 裁剪工程 JSON 序列化/新进程载入后可从持久 origin 精确 replay",
            serialize_replay_after_prune)

    def revert_history_bounded():
        fresh = MCPClient()
        try:
            fresh.start()
            current = fresh.call_tool("figure_load_project", {
                "path": str(state["bounded_path"])})["doc"]
            target = current["history"][-1]["rev"]
            lengths = []
            for _ in range(3):
                reverted = fresh.call_tool("figure_revert", {"doc": current, "rev": target})
                assert reverted.get("ok") is True, reverted.get("error")
                current = reverted["doc"]
                lengths.append(len(current.get("history") or []))
            checkpoints = sum(1 for rec in current["history"] if rec.get("checkpoint"))
            return (lengths == [200, 200, 200] and checkpoints == 0
                    and len(json.dumps(current, ensure_ascii=False)) < 2000000,
                "三次 revert history=%r checkpoint=%d" % (lengths, checkpoints))
        finally:
            fresh.stop()

    capture("连续 public figure_revert 同样受 200 上限与 JSON 有界性约束",
            revert_history_bounded)
    return results


def canvas_regression_probe():
    """Drive the real settings UI, App.commit and a temporary project store."""
    script = r"""
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./lib/figdoc.js');
require('./lib/ops.js');
require('./lib/storage.js');

class DOMNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.eventListeners = {};
    this.style = {};
    this.className = '';
    this._text = '';
    this.value = '';
    this.checked = false;
  }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = value == null ? '' : String(value);
  }
  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (['type', 'min', 'max', 'step'].includes(name)) this[name] = String(value);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  addEventListener(name, handler) {
    (this.eventListeners[name] || (this.eventListeners[name] = [])).push(handler);
  }
  click() {
    for (const handler of this.eventListeners.click || []) handler({ target: this });
  }
}

global.document = {
  createElement: tag => new DOMNode(tag),
  createTextNode: text => {
    const node = new DOMNode('#text');
    node.textContent = text;
    return node;
  }
};
const localValues = new Map();
global.localStorage = {
  getItem: key => localValues.has(key) ? localValues.get(key) : null,
  setItem: (key, value) => localValues.set(key, String(value)),
  removeItem: key => localValues.delete(key)
};
global.Ui = { toast: function () {} };
require('./viewer_static/app/store.js');
const nativeDateNow = Date.now;
try {
  Date.now = () => 0;
  require('./viewer_static/app/state.js');
} finally {
  Date.now = nativeDateNow;
}
const nativeFetch = global.fetch;
global.fetch = undefined;
require('./viewer_static/app/settings.js');

const results = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figure-canvas-regression-'));
const projectPath = path.join(tempDir, 'commit-project.json');
const realCommit = App.commit.bind(App);
let commitCalls = 0;
let lastCommit = null;
let lastOps = null;
let lastResult = null;
App.commit = function (ops, opts) {
  commitCalls += 1;
  lastOps = JSON.parse(JSON.stringify(ops));
  lastCommit = realCommit(ops, opts).then(result => {
    lastResult = result;
    return result;
  });
  return lastCommit;
};

function walk(node, out) {
  out = out || [];
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}
function makeElement(id, type, x, y, w, h, extra) {
  return Object.assign({
    id: id, type: type, z: 0, parent_id: null,
    transform: { x: x, y: y, w: w, h: h }, style: {}
  }, extra || {});
}
function makeDoc(elements) {
  const doc = FigDoc.create({ width_mm: 100, height_mm: 80, dpi: 600 });
  doc.meta.base_font_pt = 8;
  doc.elements = elements;
  return doc;
}
function getEl(doc, id) {
  return doc.elements.find(el => el.id === id);
}
function groupDoc(childrenFirst) {
  const group = makeElement('group', 'group', 10, 20, 40, 30,
    { children: ['child'] });
  const child = makeElement('child', 'text', 30, 35, 10, 10, {
    parent_id: 'group', text: 'child', style: { fontSizePt: 7, fill: '#123456' }
  });
  return makeDoc(childrenFirst ? [child, group] : [group, child]);
}
function panelDoc() {
  const panel = makeElement('panel', 'panel', 10, 20, 40, 30, {
    children: ['normalized', 'nested-panel'], panelLayout: { padding_mm: 2, gap_mm: 3 }
  });
  const normalized = makeElement('normalized', 'text', 0.25, 0.5, 0.2, 0.1, {
    parent_id: 'panel', text: 'normalized',
    style: { panelRelative: true, fontSizePt: 9 }
  });
  const nested = makeElement('nested-panel', 'panel', 24, 28, 20, 12, {
    parent_id: 'panel', children: ['nested-normalized', 'absolute-child'],
    panelLayout: { padding_mm: 1, gap_mm: 2 }
  });
  const nestedNorm = makeElement('nested-normalized', 'rect', 0.1, 0.2, 0.3, 0.4, {
    parent_id: 'nested-panel', style: { panelRelative: true, fill: '#ABCDEF' }
  });
  const absolute = makeElement('absolute-child', 'text', 30, 32, 5, 3, {
    parent_id: 'nested-panel', text: 'absolute', style: { fontSizePt: 6 }
  });
  return makeDoc([nestedNorm, absolute, nested, normalized, panel]);
}
function chartDoc() {
  const text = makeElement('single', 'text', 5, 6, 20, 3, {
    text: 'single', style: { fontSizePt: 8.5, fontFamily: 'Arial' }
  });
  const chart = makeElement('chart', 'chart', 30, 10, 30, 20, {
    style: { fill: '#FFFFFF' },
    chart: {
      chartType: 'line', mapping: { x: 'A', y: 'B' },
      axes: { xLabel: 'A', yLabel: 'B', xScale: 'linear', yScale: 'linear' },
      data: { inline: { columns: ['A', 'B'], rows: [[1, 2], [3, 4]] } }
    }
  });
  const doc = makeDoc([text, chart]);
  doc.anchors = [{
    id: 'anchor', label: 'a', bbox_mm: { x: 5, y: 6, w: 20, h: 3 },
    bbox_norm: { x: 0.05, y: 0.075, w: 0.2, h: 0.0375 }, element_ids: ['single']
  }];
  return doc;
}
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true, detail: 'PASS' });
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.stack ? err.stack : String(err) });
  }
}
function mountSettings() {
  const root = new DOMNode('section');
  Settings.mount(root);
  const nodes = walk(root);
  const numberInputs = nodes.filter(node => node.tagName === 'INPUT' && node.type === 'number');
  const dimensions = numberInputs.filter(node => node.min === '1');
  const checkboxes = nodes.filter(node => node.tagName === 'INPUT' && node.type === 'checkbox');
  const apply = nodes.find(node => node.tagName === 'BUTTON' && node.textContent === '应用画布尺寸');
  assert.strictEqual(dimensions.length, 2);
  assert.ok(apply);
  assert.strictEqual(checkboxes.length, 2);
  return { width: dimensions[0], height: dimensions[1], fit: checkboxes[1], apply };
}
async function applyCanvas(doc, width, height, fit) {
  App.setDoc(doc, { reason: 'canvas-regression' });
  const controls = mountSettings();
  controls.width.value = String(width);
  controls.height.value = String(height);
  controls.fit.checked = fit === true;
  const before = commitCalls;
  controls.apply.click();
  assert.strictEqual(commitCalls, before + 1, '有效画布输入必须调用真实 App.commit');
  assert.ok(lastCommit);
  await lastCommit;
  assert.ok(lastResult && lastResult.applied > 0);
  return { doc: App.doc, ops: lastOps, result: lastResult };
}
function moves(ops) {
  return ops.filter(op => op.op === 'move');
}
function assertSize(doc, width, height, dpi) {
  assert.strictEqual(doc.canvas.width_mm, width);
  assert.strictEqual(doc.canvas.height_mm, height);
  assert.strictEqual(doc.canvas.dpi, dpi);
  assert.strictEqual(doc.meta.base_font_pt, 8);
}

(async () => {
  try {
    assert.strictEqual(await Store.attach(), 'localstorage');
    FigStore.use({
      name: 'canvas-temp-file',
      open: async () => 'temp-file',
      saveProject: async project => {
        fs.writeFileSync(projectPath, JSON.stringify(project), 'utf8');
        return project;
      },
      loadProject: async () => JSON.parse(fs.readFileSync(projectPath, 'utf8')),
      listProjects: async () => [],
      deleteProject: async () => false
    });

    await test('画布放大2倍：children 先于 group，父→子单目标绝对值覆盖且 App.commit 已保存', async () => {
      const original = groupDoc(true);
      const scaled = await applyCanvas(original, 200, 160, true);
      const doc = scaled.doc;
      assertSize(doc, 200, 160, 600);
      assert.deepStrictEqual(getEl(doc, 'group').transform,
        { x: 20, y: 40, w: 80, h: 60 });
      assert.deepStrictEqual(getEl(doc, 'child').transform,
        { x: 60, y: 70, w: 20, h: 20 });
      assert.deepStrictEqual(moves(scaled.ops).map(op => op.targets[0]), ['group', 'child']);
      assert.deepStrictEqual(moves(scaled.ops)[1],
        { op: 'move', targets: ['child'], x: 60, y: 70 });
      assert.strictEqual(getEl(doc, 'child').style.fontSizePt, 7);
      assert.deepStrictEqual(original.elements, groupDoc(true).elements);
      assert.ok(fs.existsSync(projectPath), 'App.commit 自动快照必须调用真实文件适配器');
      const saved = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
      assertSize(saved.doc, 200, 160, 600);
      assert.deepStrictEqual(getEl(saved.doc, 'child').transform,
        { x: 60, y: 70, w: 20, h: 20 });
      assert.strictEqual(getEl(saved.doc, 'child').style.fontSizePt, 7);
      assert.strictEqual(getEl(saved.doc, 'group').transform.x, 20);
    });

    await test('画布放大2倍：group 先于 children 仍只缩放一次且保持字号', async () => {
      const scaled = await applyCanvas(groupDoc(false), 200, 160, true);
      assert.deepStrictEqual(getEl(scaled.doc, 'group').transform,
        { x: 20, y: 40, w: 80, h: 60 });
      assert.deepStrictEqual(getEl(scaled.doc, 'child').transform,
        { x: 60, y: 70, w: 20, h: 20 });
      assert.deepStrictEqual(moves(scaled.ops).map(op => op.targets[0]), ['group', 'child']);
      assert.deepStrictEqual(getEl(scaled.doc, 'child').style,
        { fontSizePt: 7, fill: '#123456' });
      assert.strictEqual(FigDoc.validate(scaled.doc).ok, true);
    });

    await test('panel 与 nested panel 放大2倍：归一化局部几何不变，绝对后代达到初始目标的2倍', async () => {
      const initial = panelDoc();
      const scaled = await applyCanvas(initial, 200, 160, true);
      const doc = scaled.doc;
      assert.deepStrictEqual(getEl(doc, 'panel').transform,
        { x: 20, y: 40, w: 80, h: 60 });
      assert.deepStrictEqual(getEl(doc, 'nested-panel').transform,
        { x: 48, y: 56, w: 40, h: 24 });
      assert.deepStrictEqual(getEl(doc, 'absolute-child').transform,
        { x: 60, y: 64, w: 10, h: 6 });
      for (const id of ['normalized', 'nested-normalized']) {
        assert.deepStrictEqual(getEl(doc, id).transform, getEl(initial, id).transform);
        assert.deepStrictEqual(getEl(doc, id).style, getEl(initial, id).style);
        assert.strictEqual(scaled.ops.some(op => op.targets && op.targets.includes(id)), false);
      }
      assert.deepStrictEqual(getEl(doc, 'panel').panelLayout, getEl(initial, 'panel').panelLayout);
      assert.deepStrictEqual(getEl(doc, 'nested-panel').panelLayout,
        getEl(initial, 'nested-panel').panelLayout);
      assert.deepStrictEqual(moves(scaled.ops).map(op => op.targets[0]),
        ['panel', 'nested-panel', 'absolute-child']);
    });

    await test('手动逐级 move panel 保留嵌套归一化坐标，绝对后代随父级位移', async () => {
      const scaled = (await applyCanvas(panelDoc(), 200, 160, true)).doc;
      const moved = FigOps.applyAll(scaled, [{
        op: 'move', targets: ['panel'], x: 25, y: null
      }], { source: 'user' }).doc;
      assert.deepStrictEqual(getEl(moved, 'normalized').transform,
        getEl(scaled, 'normalized').transform);
      assert.deepStrictEqual(getEl(moved, 'nested-normalized').transform,
        getEl(scaled, 'nested-normalized').transform);
      assert.strictEqual(getEl(moved, 'nested-panel').transform.x, 53);
      assert.strictEqual(getEl(moved, 'absolute-child').transform.x, 65);
      const nestedMoved = FigOps.applyAll(moved, [{
        op: 'move', targets: ['nested-panel'], x: 60, y: 60
      }], { source: 'user' }).doc;
      assert.deepStrictEqual(getEl(nestedMoved, 'normalized').transform,
        getEl(moved, 'normalized').transform);
      assert.deepStrictEqual(getEl(nestedMoved, 'nested-normalized').transform,
        getEl(moved, 'nested-normalized').transform);
      assert.deepStrictEqual(getEl(nestedMoved, 'absolute-child').transform,
        { x: 72, y: 68, w: 10, h: 6 });
    });

    await test('single element 放大2倍仅改画布和几何，字体/DPI/旋转及源文档不被改', async () => {
      const initial = chartDoc();
      initial.elements = initial.elements.filter(el => el.id === 'single');
      initial.anchors = [];
      getEl(initial, 'single').transform.rotation = 17;
      const scaled = await applyCanvas(initial, 200, 160, true);
      assert.deepStrictEqual(getEl(scaled.doc, 'single').transform,
        { x: 10, y: 12, w: 40, h: 6, rotation: 17 });
      assert.deepStrictEqual(getEl(scaled.doc, 'single').style,
        { fontSizePt: 8.5, fontFamily: 'Arial' });
      assertSize(scaled.doc, 200, 160, 600);
      assert.deepStrictEqual(getEl(initial, 'single').transform,
        { x: 5, y: 6, w: 20, h: 3, rotation: 17 });
      assert.strictEqual(scaled.ops.some(op => op.op === 'set_style'), false);
    });

    await test('图表放大2倍不改数据列/行/映射/字号，锚点 mm 坐标缩放但 norm 不变', async () => {
      const initial = chartDoc();
      const scaled = await applyCanvas(initial, 200, 160, true);
      assert.deepStrictEqual(getEl(scaled.doc, 'chart').chart, getEl(initial, 'chart').chart);
      assert.deepStrictEqual(getEl(scaled.doc, 'chart').transform,
        { x: 60, y: 20, w: 60, h: 40 });
      assert.deepStrictEqual(getEl(scaled.doc, 'single').style, getEl(initial, 'single').style);
      assert.deepStrictEqual(scaled.doc.anchors[0].bbox_mm, { x: 10, y: 12, w: 40, h: 6 });
      assert.deepStrictEqual(scaled.doc.anchors[0].bbox_norm, initial.anchors[0].bbox_norm);
      assert.strictEqual(scaled.ops.some(op => op.op === 'set_style'), false);
      assertSize(scaled.doc, 200, 160, 600);
    });

    await test('手工勾选“不缩放内容”只提交 set_canvas，元素/锚点/数据/DPI 原样保留', async () => {
      const initial = chartDoc();
      const scaled = await applyCanvas(initial, 200, 160, false);
      assertSize(scaled.doc, 200, 160, 600);
      assert.deepStrictEqual(scaled.doc.elements, initial.elements);
      assert.deepStrictEqual(scaled.doc.anchors, initial.anchors);
      assert.deepStrictEqual(scaled.ops, [{
        op: 'set_canvas', canvas: { width_mm: 200, height_mm: 160 }
      }]);
    });

    await test('非法画布输入全部拒绝，不调用 App.commit、不修改当前文档', async () => {
      const initial = chartDoc();
      App.setDoc(initial, { reason: 'invalid-canvas-regression' });
      const published = App.doc;
      const controls = mountSettings();
      for (const bad of ['', '0', '-1', 'NaN', 'Infinity', '1001', '1e309', 'abc']) {
        controls.width.value = bad;
        controls.height.value = '80';
        controls.fit.checked = true;
        const before = commitCalls;
        controls.apply.click();
        await Promise.resolve();
        assert.strictEqual(commitCalls, before, '非法宽度被提交：' + bad);
        assert.strictEqual(App.doc, published);
      }
      controls.width.value = '200';
      for (const bad of ['', '0', '-1', 'NaN', 'Infinity', '1001', 'abc']) {
        controls.height.value = bad;
        const before = commitCalls;
        controls.apply.click();
        await Promise.resolve();
        assert.strictEqual(commitCalls, before, '非法高度被提交：' + bad);
        assert.strictEqual(App.doc, published);
      }
      assert.strictEqual(fs.existsSync(projectPath), true);
    });
  } catch (err) {
    results.push({ name: '画布回归环境初始化', ok: false,
      detail: err && err.stack ? err.stack : String(err) });
  } finally {
    if (nativeFetch === undefined) delete global.fetch;
    else global.fetch = nativeFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    assert.strictEqual(fs.existsSync(tempDir), false, '临时工程目录必须清理');
  }
  console.log('__RESULTS__' + JSON.stringify(results));
})().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
"""
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    try:
        proc = subprocess.run(["node", "-e", script], cwd=str(MCP_DIR), env=env,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=90)
    except Exception as exc:
        return [("画布等比变换回归探针", False, "%s: %s" % (exc.__class__.__name__, exc))]
    marker = "__RESULTS__"
    line = next((item for item in proc.stdout.splitlines() if item.startswith(marker)), None)
    if proc.returncode != 0 or line is None:
        return [("画布等比变换回归探针", False, clip(proc.stderr or proc.stdout))]
    try:
        results = json.loads(line[len(marker):])
        return [(item["name"], bool(item["ok"]), clip(item.get("detail", "")))
                for item in results]
    except Exception as exc:
        return [("画布等比变换回归结果解析", False, str(exc))]


def ai_ui_regression_probe():
    """Real AI IIFE/App/FigOps with in-memory DOM; model responses are mocked, never network."""
    script = r"""
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const sources = [
  'lib/figdoc.js', 'lib/ops.js', 'viewer_static/app/state.js', 'viewer_static/app/ai.js'
];
class DOMNode {
  constructor(tag, connected) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.eventListeners = {};
    this.className = '';
    this._text = '';
    this._connected = connected === true;
    this.value = '';
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.title = '';
    this.classList = { add: () => {}, remove: () => {} };
  }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected : this._connected; }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = value == null ? '' : String(value);
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'type') this.type = String(value);
  }
  addEventListener(name, handler) {
    (this.eventListeners[name] || (this.eventListeners[name] = [])).push(handler);
  }
  dispatchEvent() {}
  click() {
    if (this.disabled) return undefined;
    let result;
    for (const handler of (this.eventListeners.click || []).slice()) result = handler({ target: this });
    return result;
  }
}
function walk(node, out) {
  out = out || [];
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}
function freshHarness() {
  const root = new DOMNode('section', true);
  const head = new DOMNode('head', true);
  const document = {
    head,
    createElement: tag => new DOMNode(tag),
    createTextNode: text => { const node = new DOMNode('#text'); node.textContent = text; return node; },
    getElementById: id => walk(head).concat(walk(root)).find(node => node.id === id) || null
  };
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document, location: { pathname: '/' },
    crypto: require('crypto').webcrypto, TextEncoder, Uint8Array,
    setTimeout, clearTimeout, setInterval, clearInterval,
    CustomEvent: function CustomEvent(name, opts) { this.type = name; this.detail = opts && opts.detail; },
    Promise, Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of sources) vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const c = context;
  c.Ui = { toast: () => {} };
  c.Settings = { bridgeMode: () => false, lastModelCall: () => null };
  c.FigAI = {
    enabled: () => false,
    explainError: err => err && err.message ? err.message : String(err),
    requestOps: async () => ({ ops: [], explanation: '', mode: 'fallback' }),
    requestReview: async () => ({ items: [], mode: 'fallback' })
  };
  const doc = c.FigDoc.create({ title: 'AI isolated regression' });
  for (let i = 1; i <= 3; i++) {
    doc.elements.push({
      id: 'text-' + i, type: 'text', name: '文字' + i, text: 'T' + i,
      transform: { x: 5 + i * 10, y: 5, w: 20, h: 5 }, style: { fontSizePt: 8 }
    });
  }
  doc.anchors = [
    { id: 'anchor-1', label: '1', bbox_mm: { x: 6, y: 5, w: 20, h: 5 },
      bbox_norm: null, element_ids: ['text-1'] },
    { id: 'anchor-2', label: '2', bbox_mm: { x: 16, y: 5, w: 20, h: 5 },
      bbox_norm: null, element_ids: ['text-2'] }
  ];
  c.App.setDoc(doc, { reason: 'test-init' });
  c.AiPanel.mount(root);
  return { c, root };
}
function nodes(h) { return walk(h.root); }
function input(h) { return nodes(h).find(n => n.id === 'ai-chat-input'); }
function reviewButton(h) { return nodes(h).find(n => n.attributes['data-review-action'] === 'apply'); }
function segmentsText(h) {
  const el = nodes(h).find(n => n.attributes['data-pending-segments'] === 'true');
  return el ? el.textContent : '';
}
function styleOp(value) { return { op: 'set_style', targets: ['text-1'], style: { fontSizePt: value } }; }
function reviewItem(value) {
  return { severity: 'medium', target: 'text-1', issue: 'mock 意见', suggestion: 'mock 修复', op: styleOp(value) };
}
function gateCommit(h) {
  const original = h.c.App.commit;
  h.commitCalls = 0;
  h.gateReady = false;
  h.c.App.commit = function(ops, opts) {
    h.commitCalls++;
    return new Promise((resolve, reject) => {
      h.gateReady = true;
      h.releaseCommit = () => Promise.resolve(original.call(h.c.App, ops, opts)).then(resolve, reject);
    });
  };
}
async function flush() { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
async function waitFor(predicate) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await flush(); }
  assert.ok(predicate(), '等待内存异步任务超时');
}
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true, detail: 'PASS（mock model，非 network）' }); }
  catch (err) { results.push({ name, ok: false, detail: err && err.stack ? err.stack : String(err) }); }
}
(async () => {
  await test('AI pending 并发 Apply 共享 Promise 且 5 条操作仅提交一次', async () => {
    const h = freshHarness();
    const ops = [9, 10, 11, 12, 13].map(styleOp);
    h.c.FigAI.requestOps = async () => ({ ops, explanation: 'mock', mode: 'model' });
    await h.c.AiPanel.ask('并发应用');
    gateCommit(h);
    const first = h.c.AiPanel.applyPending();
    const second = h.c.AiPanel.applyPending();
    assert.strictEqual(first, second);
    assert.strictEqual(h.c.AiPanel.hasPendingWork(), true);
    await waitFor(() => h.gateReady);
    assert.strictEqual(h.commitCalls, 1);
    h.releaseCommit();
    const applied = await first;
    assert.strictEqual(applied.applied, 5);
    assert.strictEqual(h.c.App.doc.history[h.c.App.doc.history.length - 1].ops.length, 5);
    assert.strictEqual(h.commitCalls, 1);
  });

  await test('AI 单条 review 双调用互斥且提交完成按 identity 移除', async () => {
    const h = freshHarness();
    h.c.FigAI.requestReview = async () => ({ items: [reviewItem(11)], mode: 'fallback' });
    await h.c.AiPanel.review();
    const oldButton = reviewButton(h);
    assert.ok(oldButton);
    gateCommit(h);
    const first = oldButton.click();
    const second = oldButton.click();
    assert.strictEqual(first, second);
    await waitFor(() => h.gateReady);
    h.releaseCommit();
    await first;
    assert.strictEqual(h.commitCalls, 1);
    assert.strictEqual(reviewButton(h), undefined);
    assert.strictEqual(h.c.App.doc.elements[0].style.fontSizePt, 11);
  });

  await test('AI review 生成后 document change：旧按钮拒绝应用且 UI 禁用', async () => {
    const h = freshHarness();
    h.c.FigAI.requestReview = async () => ({ items: [reviewItem(12)], mode: 'fallback' });
    await h.c.AiPanel.review();
    const oldButton = reviewButton(h);
    await h.c.App.commit([styleOp(10)], { source: 'user', label: 'external edit' });
    assert.strictEqual(reviewButton(h).disabled, true);
    await assert.rejects(Promise.resolve(oldButton.click()), /过期/);
    assert.strictEqual(h.c.App.doc.elements[0].style.fontSizePt, 10);
    assert.ok(nodes(h).some(n => n.attributes['data-review-stale'] === 'true'));
  });

  await test('AI review 模型返回前改稿：结果绑定 base epoch 并禁用而非应用', async () => {
    const h = freshHarness();
    let finishReview;
    h.c.FigAI.requestReview = () => new Promise(resolve => { finishReview = resolve; });
    const pending = h.c.AiPanel.review();
    await waitFor(() => !!finishReview);
    await h.c.App.commit([styleOp(9)], { source: 'user', label: 'undo/restore-equivalent docchange' });
    finishReview({ items: [reviewItem(14)], mode: 'fallback' });
    await pending;
    assert.strictEqual(reviewButton(h).disabled, true);
    assert.strictEqual(h.c.App.doc.elements[0].style.fontSizePt, 9);
  });

  await test('AI 多编号 model+fallback 为 mixed，逐段错误与消息 1/2 事实一致', async () => {
    const h = freshHarness();
    const requests = [];
    h.c.FigAI.enabled = () => true;
    h.c.FigAI.requestOps = async payload => {
      requests.push(payload.instruction);
      if (requests.length === 1) return { ops: [styleOp(9)], explanation: '模型段', mode: 'model' };
      const record = { at: Date.now(), ok: false, source: 'direct', message: 'mock 第二组失败' };
      h.c.Settings.lastModelCall = () => record;
      return { ops: [{ op: 'set_style', targets: ['text-2'], style: { fontWeight: 'bold' } }],
        explanation: '离线段', mode: 'fallback' };
    };
    const result = await h.c.AiPanel.ask('把1的字号改为2磅；把2加粗');
    assert.strictEqual(result.mode, 'mixed');
    assert.strictEqual(result.segments[0].mode, 'model');
    assert.strictEqual(result.segments[1].mode, 'fallback');
    assert.ok(result.segments[1].error.includes('mock 第二组失败'));
    assert.ok(segmentsText(h).includes('第 1/2 组：模型'));
    assert.ok(segmentsText(h).includes('第 2/2 组：离线规则；错误：mock 第二组失败'));
    const message = h.c.AiPanel.chatMessages().filter(m => m.kind === 'edit').slice(-1)[0].text;
    assert.ok(message.includes('模型 1/2 组'));
    assert.ok(message.includes('离线规则 1/2 组'));
    assert.ok(message.includes('mock 第二组失败'));
    assert.strictEqual(message.includes('模型生成了 2 条'), false);
  });

  await test('AI anchor rename 精确改写 autoMarker，delete/tombstone 不复活旧引用', async () => {
    const h = freshHarness();
    input(h).value = '加粗';
    assert.strictEqual(h.c.AiPanel.appendAnchorRef(h.c.App.doc.anchors[0]), true);
    assert.strictEqual(input(h).value, '加粗 [1]');
    await h.c.App.commit([{ op: 'update_anchor', anchor: { id: 'anchor-1', label: '2' } }],
      { source: 'user', label: 'rename anchor' });
    assert.strictEqual(input(h).value, '加粗 [2]');
    assert.strictEqual(h.c.AiPanel.anchorRefs()[0].label, '2');
    let routed = '';
    h.c.FigAI.requestOps = async payload => {
      routed = payload.instruction;
      return { ops: [], explanation: '', mode: 'fallback' };
    };
    await h.c.AiPanel.ask(input(h).value);
    assert.ok(routed.includes('@anchor-1'));
    assert.strictEqual(routed.includes('[1]'), false);
    input(h).value = '再改';
    h.c.AiPanel.clearAnchorRefs();
    h.c.AiPanel.appendAnchorRef(h.c.App.doc.anchors.find(a => a.id === 'anchor-1'));
    await h.c.App.commit([{ op: 'remove_anchor', anchor: { id: 'anchor-1' } }],
      { source: 'user', label: 'delete anchor' });
    assert.strictEqual(h.c.AiPanel.anchorRefs().length, 0);
    assert.strictEqual(input(h).value.includes('[2]'), false);
    const restored = h.c.FigDoc.clone(h.c.App.doc);
    restored.anchors.push({ id: 'anchor-1', label: '2', bbox_mm: { x: 6, y: 5, w: 20, h: 5 },
      bbox_norm: null, element_ids: ['text-1'] });
    h.c.App.setDoc(restored, { reason: 'undo' });
    const deletedAnchor = restored.anchors.find(a => a.id === 'anchor-1');
    assert.strictEqual(h.c.AiPanel.appendAnchorRef(deletedAnchor), false);
  });

  await test('AI 裸数字“把1的字号改为2磅”只路由 target 1，literal 2 原样保留', async () => {
    const h = freshHarness();
    let routed = '';
    h.c.FigAI.requestOps = async payload => {
      routed = payload.instruction;
      return { ops: [], explanation: '', mode: 'fallback' };
    };
    await h.c.AiPanel.ask('把1的字号改为2磅');
    assert.strictEqual(routed, '把@anchor-1的字号改为2磅');
    assert.strictEqual(routed.includes('@anchor-2'), false);
  });

  await test('AI 纯离线 review 不调用 toRasterBlob 且 imageDataUrl=null', async () => {
    const h = freshHarness();
    let rasterCalls = 0;
    let request = null;
    h.c.FigExport = { toRasterBlob: async () => { rasterCalls++; throw new Error('offline raster forbidden'); } };
    h.c.FigAI.requestReview = async opts => {
      request = opts;
      return { items: [], mode: 'fallback' };
    };
    const result = await h.c.AiPanel.review();
    assert.strictEqual(result.mode, 'fallback');
    assert.strictEqual(rasterCalls, 0);
    assert.strictEqual(request.imageDataUrl, null);
  });
  console.log('__RESULTS__' + JSON.stringify(results));
})().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
"""
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    try:
        proc = subprocess.run(["node", "-e", script], cwd=str(MCP_DIR), env=env,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=90)
    except Exception as exc:
        return [("AI 内存 IIFE 回归探针", False, "%s: %s" % (exc.__class__.__name__, exc))]
    marker = "__RESULTS__"
    line = next((item for item in proc.stdout.splitlines() if item.startswith(marker)), None)
    if proc.returncode != 0 or line is None:
        return [("AI 内存 IIFE 回归探针", False, clip(proc.stderr or proc.stdout))]
    try:
        results = json.loads(line[len(marker):])
        return [(item["name"], bool(item["ok"]), clip(item.get("detail", "")))
                for item in results]
    except Exception as exc:
        return [("AI 内存 IIFE 回归结果解析", False, str(exc))]


def stage5_node_browser_regression_probe():
    """Real FigRender/FigData plus the browser ChartRender adapter, in memory."""
    script = r"""
const assert = require('assert');
const fs = require('fs');
require('./lib/figdoc.js');
require('./lib/diagram.js');
require('./lib/palette.js');
require('./lib/presets.js');
require('./lib/data.js');
require('./lib/render.js');
require('./viewer_static/app/chart-render.js');
const presetDir = '../presets';
FigPresets.load({
  journals: JSON.parse(fs.readFileSync(presetDir + '/journals.json', 'utf8')),
  templates: JSON.parse(fs.readFileSync(presetDir + '/templates.json', 'utf8')),
  palettes: JSON.parse(fs.readFileSync(presetDir + '/palettes.json', 'utf8'))
});
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({name, ok: true, detail: 'PASS'}); }
  catch (err) { results.push({name, ok: false, detail: err && err.stack ? err.stack : String(err)}); }
}
function element(chart) {
  return {id: 'chart', type: 'chart', transform: {x: 0, y: 0, w: 140, h: 65}, style: {}, chart};
}
function documentWith(chart) {
  const doc = FigDoc.create({width_mm: 140, height_mm: 65, dpi: 100});
  doc.elements = [element(chart)];
  return doc;
}
function scatter(rows, characterization) {
  return {
    chartType: 'scatter',
    data: {inline: {columns: ['Z real', '-Z imag', 'Group'], rows}},
    mapping: {x: 'Z real', y: '-Z imag', color: 'Group'},
    axes: {xLabel: '错误旧轴', yLabel: '错误旧轴'},
    characterization, legend: 'right'
  };
}
function circles(svg) {
  return [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)]
    .map(match => [Number(match[1]), Number(match[2])]);
}
function lineChart() {
  return {chartType: 'line', data: {inline: {columns: ['x', 'y'], rows: [[1, 2], [3, 4]]}},
    mapping: {x: 'x', y: 'y'}, axes: {}};
}
(async () => {
  await test('60模板能力同源RENDERS/FigDiagram：27 full / 12 layout / 21 unsupported且推荐最低分也不返回unsupported', () => {
    assert.strictEqual(FigData.supportsChartType('bar'), true);
    assert.strictEqual(FigData.supportsChartType('pca'), false);
    assert.strictEqual(FigData.supportsChartType('roc'), false);
    assert.strictEqual(FigData.supportedChartTypes().includes('line'), true);
    const templates = FigData.templateCapabilities();
    const counts = templates.reduce((out, template) => {
      out[template.capability.status] = (out[template.capability.status] || 0) + 1;
      return out;
    }, {});
    assert.strictEqual(templates.length, 60);
    assert.deepStrictEqual(counts, {full: 27, unsupported: 21, layout: 12});
    for (const template of templates) {
      if (template.category === 'composite' && template.chart_type === null) {
        assert.strictEqual(template.capability.status, 'layout');
        assert.match(template.capability.reason, /不自动填图/);
      } else if (template.capability.status === 'full' && template.category === 'diagram') {
        assert.strictEqual(FigDiagram.supportsTemplate(template).supported, true);
      } else if (template.capability.status === 'full') {
        assert.strictEqual(FigData.supportsChartType(template.chart_type), true);
      }
    }
    const stats = {n_rows: 24, columns: [
      {name: 'truth', kind: 'categorical', nunique: 2},
      {name: 'score', kind: 'numeric', nunique: 24, min: 0, max: 1},
      {name: 'group', kind: 'categorical', nunique: 2}
    ]};
    const recommendations = FigPresets.recommend(stats, {n: 59});
    assert.ok(recommendations.length > 0);
    assert.strictEqual(recommendations.some(rec => rec.template_id === 'tpl-roc'), false);
    assert.strictEqual(recommendations.some(rec => rec.template_id === 'tpl-pca'), false);
    for (const rec of recommendations) assert.strictEqual(rec.capability.can_apply, true);
  });

  await test('MCP/AI共用模板物化入口拒绝PCA/ROC，layout只创建明示空版式', () => {
    for (const type of ['roc', 'pca']) {
      const data = {columns: ['x', 'y', 'g'], rows: [[1, 2, 'a'], [3, 4, 'b']]};
      assert.throws(() => FigPresets.templateFromStats('tpl-' + type, data, {}),
        /没有本地实际 SVG 渲染器|不可应用/);
    }
    const built = FigPresets.templateFromStats('tpl-composite-2x2', null, {});
    assert.strictEqual(built.data_bound, false);
    assert.strictEqual(built.elements.filter(item => item.type === 'chart').length, 4);
    assert.ok(built.elements.filter(item => item.type === 'chart')
      .every(item => item.chart.chartType == null));
    assert.ok(built.warnings.some(text => text.includes('不自动填图')));
  });

  await test('EIS真实FigRender SVG共同单位像素尺度、轴标题、图例和原始点顺序不变', () => {
    const chart = scatter([[0, 0, 'b'], [200, 100, 'b'], [100, 50, 'a']], {
      technique: 'EIS Nyquist', x_label: 'Zreal Ω', y_label: '-Zimag Ω'
    });
    const before = JSON.stringify(chart);
    const svg = FigData.renderChartSVG(chart, {width_mm: 140, height_mm: 65, dpi: 100});
    const points = circles(svg);
    assert.strictEqual(points.length, 3);
    const pxPerXUnit = Math.abs(points[1][0] - points[0][0]) / 200;
    const pxPerYUnit = Math.abs(points[1][1] - points[0][1]) / 100;
    assert.ok(Math.abs(pxPerXUnit - pxPerYUnit) < 0.00011,
      `不同单位比例：${pxPerXUnit} vs ${pxPerYUnit}`);
    assert.ok(svg.includes('equal_aspect=true'));
    assert.ok(svg.includes('Zreal Ω') && svg.includes('-Zimag Ω'));
    assert.strictEqual(svg.includes('错误旧轴'), false);
    assert.ok(points[2][0] > points[0][0] && points[2][0] < points[1][0]);
    assert.strictEqual(JSON.stringify(chart), before, '不得改写数据/映射/样式');
    const exported = FigRender.toSVG(documentWith(chart));
    assert.ok(exported.startsWith('<svg') && exported.includes('data-chart-type="scatter"'));
    assert.strictEqual(circles(exported).length, 3);
  });

  await test('characterization.equal_aspect显式声明优先且不依赖EIS名称，零span有安全域', () => {
    const explicit = scatter([[0, 0, 'g'], [200, 100, 'g'], [100, 50, 'g']], {
      technique: 'Impedance plane', equal_aspect: true, x_label: 'Re', y_label: '-Im'
    });
    const named = scatter(explicit.data.inline.rows, {
      technique: 'EIS Nyquist', equal_aspect: true, x_label: 'Re', y_label: '-Im'
    });
    assert.strictEqual(circles(FigData.renderChartSVG(explicit)).join(';'),
      circles(FigData.renderChartSVG(named)).join(';'));
    const single = scatter([[1, 1, 'g']], {
      technique: 'Impedance plane', equal_aspect: true, x_label: 'Re', y_label: '-Im'
    });
    const points = circles(FigData.renderChartSVG(single));
    assert.strictEqual(points.length, 1);
    assert.ok(points[0].every(Number.isFinite));
  });

  await test('粒径characterization轴标题覆盖generic axes并保持真实直方图数据', () => {
    const chart = {chartType: 'histogram', data: {inline: {columns: ['Diameter'], rows: [[1], [2], [3]]}},
      mapping: {x: 'Diameter'}, axes: {xLabel: 'wrong', yLabel: 'wrong'},
      characterization: {technique: 'PSD', x_label: 'Particle size (nm)', y_label: 'Count'}};
    const before = JSON.stringify(chart.data.inline.rows);
    const svg = FigData.renderChartSVG(chart, {width_mm: 120, height_mm: 90, dpi: 100});
    assert.ok(svg.includes('Particle size (nm)') && svg.includes('Count'));
    assert.strictEqual(svg.includes('wrong'), false);
    assert.strictEqual(JSON.stringify(chart.data.inline.rows), before);
  });

  await test('FigRender区分UnsupportedChartError与缺列/映射/非法尺寸，不再silent placeholder导出', () => {
    const pca = lineChart();
    pca.chartType = 'pca';
    assert.throws(() => FigRender.toSVG(documentWith(pca)), err =>
      err.name === 'UnsupportedChartError' && err.message.includes('pca') &&
      !err.message.includes('需 v2') && err.message.includes('不支持'));
    const missing = lineChart();
    missing.mapping.y = '不存在';
    assert.throws(() => FigRender.toSVG(documentWith(missing)), err =>
      err.name !== 'UnsupportedChartError' && err.message.includes('line') &&
      err.message.includes('mapping.y') && !err.message.includes('需 v2'));
    for (const options of [{width_mm: 0}, {width_mm: NaN}, {height_mm: -1}, {dpi: 0}]) {
      assert.throws(() => FigData.renderChartSVG(lineChart(), options), err =>
        err.name !== 'UnsupportedChartError' && /有限正数/.test(err.message));
    }
    const empty = FigRender.toSVG(documentWith({}));
    assert.ok(empty.includes('data-render="empty-layout"') && empty.includes('未绑定图表'));
    assert.strictEqual(empty.includes('data-chart-type'), false);
    assert.strictEqual(empty.includes('需 v2'), false);
  });

  await test('browser ChartRender同步/异步仅允许受控unsupported preview，普通错误原样失败', async () => {
    const pca = lineChart();
    pca.chartType = 'pca';
    const pcaDoc = documentWith(pca);
    const markup = ChartRender.elementSVG(pcaDoc, pcaDoc.elements[0], {useBackend: false});
    assert.ok(markup.includes('data-render="unsupported-preview"'));
    assert.ok(markup.includes('data-real-data="false"') && !markup.includes('需 v2'));
    const pack = await ChartRender.elementSVGAsync(pcaDoc, pcaDoc.elements[0], {useBackend: false});
    assert.strictEqual(pack.source, 'unsupported-preview');
    assert.strictEqual(pack.preview, true);
    assert.ok(pack.warnings.some(text => text.includes('禁止应用与成功导出')));
    const missing = lineChart();
    delete missing.mapping.y;
    const badDoc = documentWith(missing);
    assert.throws(() => ChartRender.elementSVG(badDoc, badDoc.elements[0], {useBackend: false}),
      err => err.name !== 'UnsupportedChartError' && err.message.includes('mapping.y'));
    await assert.rejects(ChartRender.elementSVGAsync(badDoc, badDoc.elements[0], {useBackend: false}),
      /mapping\.y/);
    const emptyDoc = documentWith({});
    const emptyPack = await ChartRender.elementSVGAsync(emptyDoc, emptyDoc.elements[0], {useBackend: false});
    assert.strictEqual(emptyPack.source, 'empty-layout');
    assert.strictEqual(emptyPack.preview, true);
  });
  console.log('__RESULTS__' + JSON.stringify(results));
})().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
"""
    env = dict(os.environ)
    env.pop("DEEPSEEK_API_KEY", None)
    try:
        proc = subprocess.run(["node", "-e", script], cwd=str(MCP_DIR), env=env,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=90)
    except Exception as exc:
        return [("第五阶段 Node/browser 回归环境", False, "%s: %s" % (exc.__class__.__name__, exc))]
    marker = "__RESULTS__"
    line = next((item for item in proc.stdout.splitlines() if item.startswith(marker)), None)
    if proc.returncode != 0 or line is None:
        return [("第五阶段 Node/browser 回归环境", False, clip(proc.stderr or proc.stdout))]
    try:
        results = json.loads(line[len(marker):])
        return [(item["name"], bool(item["ok"]), clip(item.get("detail", "")))
                for item in results]
    except Exception as exc:
        return [("第五阶段 Node/browser 结果解析", False, str(exc))]


def stage5_mcp_regression_probe(client, out_dir):
    """MCP application gates and export failures use isolated docs and paths."""
    results = []

    def clone(doc):
        return json.loads(json.dumps(doc, ensure_ascii=False))

    def capture(name, fn):
        try:
            passed, detail = fn()
            results.append((name, bool(passed), detail))
        except Exception as exc:
            results.append((name, False, "%s: %s" % (exc.__class__.__name__, exc)))

    def unsupported_application():
        base = client.call_tool("figure_create", {
            "title": "第五阶段不支持模板隔离", "width_mm": 140, "height_mm": 65})["doc"]
        data = {"inline": {"columns": ["fpr", "tpr", "group"],
                           "rows": [[0, 0, "m"], [1, 1, "m"]]}}
        payload = client.call_tool("figure_create_chart", {
            "doc": base, "data": data, "template_id": "tpl-roc", "chart_type": "roc"})
        error = str(payload.get("error") or "")
        return (payload.get("ok") is False and "roc" in error.lower() and "禁止" in error
                and "需 v2" not in error and base["elements"] == [],
                error)

    capture("真实MCP直接应用ROC仍被能力校验拒绝且不创建占位元素", unsupported_application)

    def layout_application():
        base = client.call_tool("figure_create", {
            "title": "第五阶段空版式隔离", "width_mm": 120, "height_mm": 90})["doc"]
        payload = client.call_tool("figure_apply_edits", {
            "doc": base, "ops": [{"op": "apply_template", "template_id": "tpl-composite-2x2",
                                  "data": {"columns": ["x", "y"], "rows": [[1, 2]]}, "options": {}}]})
        charts = [item for item in (payload.get("doc") or {}).get("elements") or []
                  if item.get("type") == "chart"]
        return (payload.get("ok") is True and len(charts) == 4
                and all(item.get("chart", {}).get("chartType") is None for item in charts)
                and any("不自动填图" in str(text).replace("不会自动填入", "不自动填图")
                        for text in payload.get("warnings") or [])
                and all("columns" not in item.get("chart", {}).get("data", {}).get("inline", {})
                        for item in charts),
                "charts=%d warnings=%s" % (len(charts), payload.get("warnings")))

    capture("真实MCP应用layout只产生空复合版式且对话说明不自动填图", layout_application)

    def failed_exports():
        base = client.call_tool("figure_create", {
            "title": "第五阶段导出错误隔离", "width_mm": 140, "height_mm": 65})["doc"]
        created = client.call_tool("figure_create_chart", {
            "doc": base, "template_id": "tpl-line",
            "data": {"inline": {"columns": ["x", "y"], "rows": [[1, 2], [3, 4]]}}})
        unsupported_doc = clone(created["doc"])
        chart = next(item for item in unsupported_doc["elements"] if item["type"] == "chart")
        chart["chart"]["chartType"] = "pca"
        pca_path = out_dir / "stage5-pca-must-not-exist.png"
        unsupported = client.call_tool("figure_export", {
            "doc": unsupported_doc, "format": "png", "out_path": str(pca_path)})
        unsupported_error = str(unsupported.get("error") or "")
        mapped_doc = clone(created["doc"])
        chart = next(item for item in mapped_doc["elements"] if item["type"] == "chart")
        chart["chart"]["mapping"]["y"] = "不存在"
        mapping_path = out_dir / "stage5-mapping-must-not-exist.svg"
        mapped = client.call_tool("figure_export", {
            "doc": mapped_doc, "format": "svg", "out_path": str(mapping_path)})
        mapping_error = str(mapped.get("error") or "")
        return (unsupported.get("ok") is False and "pca" in unsupported_error
                and "不支持真实 SVG" in unsupported_error and "需 v2" not in unsupported_error
                and not pca_path.exists() and mapped.get("ok") is False
                and "mapping.y" in mapping_error and "line" in mapping_error
                and "需 v2" not in mapping_error and not mapping_path.exists(),
                {"unsupported": unsupported_error, "mapping": mapping_error})

    capture("真实MCP不支持chart与映射错误均不生成成功SVG/PNG文件", failed_exports)
    return results


def export_scope_security_regression_probe(out_dir):
    """Real MCP and loopback HTTP exports; never opens the formal current project."""
    import fitz
    from PIL import Image

    results = []

    def capture(name, fn, detail=None):
        try:
            outcome = fn()
            if isinstance(outcome, tuple) and len(outcome) == 2:
                passed, outcome_detail = outcome
                if detail is None:
                    detail = outcome_detail
            else:
                passed = outcome
            results.append((name, bool(passed), detail))
        except Exception as exc:
            results.append((name, False, "%s: %s" % (exc.__class__.__name__, exc)))

    def element(eid, etype, x, y, w, h, **extra):
        value = {"id": eid, "type": etype, "z": 0, "parent_id": None,
                 "transform": {"x": x, "y": y, "w": w, "h": h}, "style": {}}
        value.update(extra)
        return value

    def clone(doc):
        return json.loads(json.dumps(doc, ensure_ascii=False))

    def svg_dimensions(data):
        root = ET.fromstring(data)
        view_box = [float(value) for value in (root.get("viewBox") or "").split()]
        return root, root.get("width"), root.get("height"), view_box

    def scoped_svg_ok(data):
        root, width, height, view_box = svg_dimensions(data)
        ids = {node.get("data-fig-id") for node in root.iter()}
        text = "".join(root.itertext())
        return (width == "40mm" and height == "30mm"
                and view_box == [20.0, 15.0, 40.0, 30.0]
                and {"panel-main", "white-rect", "nested-panel", "nested-inner"}.issubset(ids)
                and "outside" not in ids and "panel-other" not in ids
                and "MARK_MAIN" in text and "MARK_OTHER" not in text and "MARK_OUT" not in text)

    def scoped_png_ok(data, expected_size=(152, 114)):
        with Image.open(io.BytesIO(data)) as im:
            rgba = im.convert("RGBA")
            reds = sum(1 for red, green, blue, alpha in rgba.getdata()
                       if alpha > 200 and red > 200 and green < 60 and blue < 60)
            return rgba.size == expected_size and reds == 0

    def scoped_pdf_ok(data):
        pdf = fitz.open(stream=data, filetype="pdf")
        try:
            page = pdf[0]
            text = page.get_text()
            return (pdf.page_count == 1
                    and abs(page.rect.width - 40 * 72 / 25.4) < 0.1
                    and abs(page.rect.height - 30 * 72 / 25.4) < 0.1
                    and "MARK_MAIN" in text
                    and "MARK_OTHER" not in text and "MARK_OUT" not in text)
        finally:
            pdf.close()

    def transparent_png_ok(data):
        with Image.open(io.BytesIO(data)) as im:
            rgba = im.convert("RGBA")
            background = rgba.getpixel((0, 0))
            explicit_white = rgba.getpixel((113, 85))
            return (rgba.size == (378, 265) and background[3] == 0
                    and explicit_white[0] == 255 and explicit_white[1] == 255
                    and explicit_white[2] == 255 and explicit_white[3] == 255), {
                        "mode": im.mode, "background": background,
                        "explicit_white": explicit_white}

    client = MCPClient()
    doc = None
    try:
        client.start()
        created = client.call_tool("figure_create", {
            "title": "scope-export", "width_mm": 100, "height_mm": 70, "dpi": 300})
        assert created.get("ok") is True
        doc = created["doc"]
        doc["elements"] = [
            element("outside", "rect", 2, 2, 8, 8,
                    style={"fill": "#FF0000"}, text="MARK_OUT"),
            element("outside-label", "text", 2, 11, 20, 3,
                    text="MARK_OUT", style={"fontSizePt": 6}),
            element("panel-main", "panel", 20, 15, 40, 30, clip=True,
                    children=["white-rect", "main-label", "nested-panel"],
                    panelLayout={"padding_mm": 2}),
            element("white-rect", "rect", 25, 20, 10, 5, parent_id="panel-main",
                    style={"fill": "#FFFFFF", "stroke": "none"}),
            element("main-label", "text", 27, 36, 18, 3, parent_id="panel-main",
                    text="MARK_MAIN", style={"fontSizePt": 6}),
            element("nested-panel", "panel", 30, 25, 15, 10,
                    parent_id="panel-main", children=["nested-inner"],
                    panelLayout={"padding_mm": 1}),
            element("nested-inner", "rect", 0.1, 0.2, 0.4, 0.3,
                    parent_id="nested-panel",
                    style={"panelRelative": True, "fill": "#0080FF", "stroke": "none"}),
            element("panel-other", "panel", 65, 15, 30, 30,
                    children=["other-label"], panelLayout={"padding_mm": 1}),
            element("other-label", "text", 67, 18, 18, 4, parent_id="panel-other",
                    text="MARK_OTHER", style={"fontSizePt": 7}),
        ]

        def mcp_export(fmt, name, **extra):
            path = out_dir / name
            request = {"doc": doc, "format": fmt, "out_path": str(path), **extra}
            return client.call_tool("figure_export", request), path

        capture_cases = [
            ("MCP 单 panel SVG：真实裁剪 nested normalized 且 root=40x30mm", "svg", 96,
             scoped_svg_ok),
            ("MCP 单 panel PNG：独立解码尺寸且无外部红色元素", "png", 96,
             scoped_png_ok),
            ("MCP 单 panel PDF：独立解码页面范围与 panel 文本", "pdf", 96,
             scoped_pdf_ok),
        ]
        outputs = {}
        for name, fmt, dpi, checker in capture_cases:
            payload, path = mcp_export(fmt, "scope-mcp." + fmt, dpi=dpi, panel_id="panel-main")
            outputs[fmt] = path.read_bytes() if path.is_file() and payload.get("ok") else b""
            expected_px = {"width": math.ceil(40 * dpi / 25.4),
                           "height": math.ceil(30 * dpi / 25.4)}
            capture(name, lambda payload=payload, fmt=fmt, expected_px=expected_px,
                    checker=checker: (
                        payload.get("ok") is True and payload.get("px") == expected_px
                        and checker(outputs[fmt]),
                        {"px": payload.get("px"), "error": payload.get("error")}))

        for transparent in (False, True):
            payload, path = mcp_export("png", "transparent-mcp-%s.png" % transparent,
                                       dpi=96, transparent=transparent)
            data = path.read_bytes() if path.is_file() else b""
            capture("MCP PNG %s：%s默认白底且显式白色元素保留" % (
                        "transparent=true" if transparent else "旧默认",
                        "去除" if transparent else "保留"),
                    lambda payload=payload, transparent=transparent, data=data: (
                        payload.get("ok") is True
                        and ((transparent_png_ok(data)[0] if transparent else
                              Image.open(io.BytesIO(data)).convert("RGB").getpixel((0, 0))
                              == (255, 255, 255))),
                        transparent_png_ok(data)[1] if transparent else {"opaque": True}))

        vector_bytes = (b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">'
                        b'<rect width="2" height="2" fill="#0080FF"/></svg>')
        resources = {"svg": ("image/svg+xml", vector_bytes)}
        for fmt, pil_fmt in (("gif", "GIF"), ("bmp", "BMP"), ("webp", "WEBP")):
            bio = io.BytesIO()
            Image.new("RGB", (2, 2), (0, 128, 255)).save(bio, pil_fmt)
            resources[fmt] = ("image/" + fmt, bio.getvalue())
        image_doc = clone(doc)
        for kind, (mime, raw) in resources.items():
            resource_doc = clone(image_doc)
            resource_doc["elements"] = [element(
                "embedded-" + kind, "image", 0, 0, 100, 70,
                src="data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii")),
                style={"imageFit": "stretch"})]
            request_doc, doc = doc, resource_doc
            try:
                payload, path = mcp_export(
                    "png", "resource-mcp-" + kind + ".png", dpi=25.4)
            finally:
                doc = request_doc
            if path.is_file():
                with Image.open(str(path)) as im:
                    pixel = im.convert("RGB").getpixel((50, 35))
            else:
                pixel = (-1, -1, -1)
            capture("MCP 内嵌静态 %s 资源经真实转换后独立解码" % kind.upper(),
                    lambda payload=payload, pixel=pixel: (
                        payload.get("ok") is True
                        and abs(pixel[0]) < 50 and abs(pixel[1] - 128) < 50
                        and abs(pixel[2] - 255) < 50), {"pixel": pixel})

        remote_doc = clone(doc)
        remote_doc["elements"] = [element(
            "remote-paint", "rect", 10, 10, 30, 20,
            style={"fill": "url(https://example.invalid/paint.svg#p)"})]
        request_doc, doc = doc, remote_doc
        remote_payload, remote_path = mcp_export("png", "remote-mcp-must-not-exist.png")
        huge_doc = clone(doc)
        doc = request_doc
        huge_doc["canvas"]["width_mm"] = huge_doc["canvas"]["height_mm"] = 1e308
        request_doc, doc = doc, huge_doc
        huge_payload, huge_path = mcp_export("png", "huge-mcp-must-not-exist.png")
        doc = request_doc
        capture("MCP 拒绝远程 paint 与超大 canvas，不生成伪造成功文件",
                lambda: (remote_payload.get("ok") is False and huge_payload.get("ok") is False
                         and not remote_path.exists() and not huge_path.exists()),
                {"remote": remote_payload.get("error"), "huge": huge_payload.get("error")})

        bad_outputs = []
        for panel_id in ("missing-panel", "white-rect"):
            payload, path = mcp_export("png", "bad-panel-mcp-must-not-exist.png",
                                       panel_id=panel_id)
            bad_outputs.append(payload.get("ok") is False and not path.exists())
        capture("MCP 明确拒绝不存在 panel 与非 panel/chart 的 panel_id",
                lambda: all(bad_outputs), bad_outputs)
        invalid_alpha, invalid_alpha_path = mcp_export(
            "pdf", "invalid-alpha-mcp-must-not-exist.pdf", transparent=True)
        capture("MCP transparent=true 用于 PDF 时明确 ToolError",
                lambda: invalid_alpha.get("ok") is False and not invalid_alpha_path.exists(),
                invalid_alpha.get("error"))
    except Exception as exc:
        results.append(("MCP scope/安全回归环境", False,
                        "%s: %s" % (exc.__class__.__name__, exc)))
    finally:
        client.stop()

    if doc is None:
        return results
    httpd = None
    thread = None
    try:
        import viewer
        previous_paths = (viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH)
        previous_state = viewer._STATE
        viewer.PROJECT_DIR = out_dir / "isolated-http-project"
        viewer.CURRENT_PROJECT_PATH = viewer.PROJECT_DIR / "current.figureproj.json"
        viewer._STATE = {"doc": None, "project_path": None}
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), viewer.ViewerHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        endpoint = "http://127.0.0.1:%d/api/export" % httpd.server_address[1]

        def http_export(request_doc, **options):
            body = json.dumps({"doc": request_doc, **options}, ensure_ascii=False).encode("utf-8")
            request = urllib.request.Request(endpoint, data=body,
                                             headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    return response.status, response.read(), response.headers, None
            except urllib.error.HTTPError as exc:
                raw = exc.read()
                try:
                    error = (json.loads(raw.decode("utf-8")) or {}).get("error")
                except Exception:
                    error = raw.decode("utf-8", errors="replace")
                return exc.code, raw, exc.headers, error

        http_outputs = {}
        http_headers = {}
        for fmt, checker in (("svg", scoped_svg_ok), ("pdf", scoped_pdf_ok),
                             ("png", scoped_png_ok)):
            status, data, headers, error = http_export(
                doc, format=fmt, dpi=96, panel_id="panel-main")
            http_outputs[fmt] = data
            http_headers[fmt] = headers
            capture("HTTP 单 panel %s：同源透传并独立解码真实裁剪" % fmt.upper(),
                    lambda status=status, data=data, checker=checker, error=error: (
                        status == 200 and checker(data),
                        {"status": status, "error": error, "bytes": len(data)}))

        disposition = http_headers["svg"].get("Content-Disposition", "")
        expected_name = "scope-export_panel-panel-main_40x30mm_96dpi.svg"
        capture("HTTP 自定义 DPI 与 panel scope 文件名不被 toolbar/workflow 覆盖",
                lambda: expected_name in disposition, disposition)

        for transparent in (False, True):
            status, data, headers, error = http_export(doc, format="png", dpi=96,
                                                       transparent=transparent)
            capture("HTTP PNG %s：%s默认白底且显式白色元素独立解码" % (
                        "transparent=true" if transparent else "旧默认",
                        "去除" if transparent else "保留"),
                    lambda status=status, data=data, transparent=transparent: (
                        status == 200 and (transparent_png_ok(data)[0] if transparent else
                                           Image.open(io.BytesIO(data)).convert("RGB")
                                           .getpixel((0, 0)) == (255, 255, 255))),
                    {"status": status, "detail": transparent_png_ok(data)[1]})

        for kind, (mime, raw) in resources.items():
            resource_doc = clone(doc)
            resource_doc["elements"] = [element(
                "embedded-http-" + kind, "image", 0, 0, 100, 70,
                src="data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii")),
                style={"imageFit": "stretch"})]
            status, data, headers, error = http_export(resource_doc, format="png", dpi=25.4)
            if status == 200:
                with Image.open(io.BytesIO(data)) as im:
                    pixel = im.convert("RGB").getpixel((50, 35))
            else:
                pixel = (-1, -1, -1)
            capture("HTTP 内嵌静态 %s 资源经真实转换后独立解码" % kind.upper(),
                    lambda status=status, pixel=pixel: (
                        status == 200 and pixel[0] < 50
                        and abs(pixel[1] - 128) < 50 and abs(pixel[2] - 255) < 50),
                    {"status": status, "pixel": pixel, "error": error})

        rejected = [http_export(remote_doc, format="png"),
                    http_export(huge_doc, format="png")]
        capture("HTTP 拒绝远程 paint 与超大 canvas（4xx），不联网",
                lambda: all(400 <= status < 500 and error for status, data, headers, error
                            in rejected),
                [(status, error) for status, data, headers, error in rejected])
        panel_errors = [http_export(doc, format="png", panel_id=panel_id)
                        for panel_id in ("missing-panel", "white-rect")]
        capture("HTTP 不存在/非 panel/chart 均返回 4xx 中文错误",
                lambda: all(400 <= status < 500 and error
                            for status, data, headers, error in panel_errors),
                [(status, error) for status, data, headers, error in panel_errors])
        alpha_status, alpha_data, alpha_headers, alpha_error = http_export(
            doc, format="pdf", transparent=True)
        capture("HTTP transparent=true 用于 PDF 时明确返回 4xx",
                lambda: 400 <= alpha_status < 500 and bool(alpha_error),
                {"status": alpha_status, "error": alpha_error})
    except Exception as exc:
        results.append(("HTTP scope/安全回归环境", False,
                        "%s: %s" % (exc.__class__.__name__, exc)))
    finally:
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        if thread is not None:
            thread.join(timeout=10)
        if "viewer" in locals():
            viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH = previous_paths
            viewer._STATE = previous_state
    return results


def xps_chart_scope_regression_probe(out_dir):
    """Export both real XPS chart ids through MCP and HTTP using only scoped frames."""
    import fitz
    from PIL import Image, ImageChops, ImageStat

    results = []

    def capture(name, fn):
        try:
            passed, detail = fn()
            results.append((name, bool(passed), detail))
        except Exception as exc:
            results.append((name, False, "%s: %s" % (exc.__class__.__name__, exc)))

    def png_rgba(data):
        with Image.open(io.BytesIO(data)) as image:
            return image.convert("RGBA")

    def pdf_facts(data):
        with fitz.open(stream=data, filetype="pdf") as pdf:
            page = pdf[0]
            return pdf.page_count, page.rect.width, page.rect.height, page.get_text()

    def crop_pixel_similarity(scoped_png, full_png, transform, source_origin, dpi=96):
        scale = dpi / 25.4
        expected_x = (transform["x"] - source_origin[0]) * scale
        expected_y = (transform["y"] - source_origin[1]) * scale
        with Image.open(io.BytesIO(full_png)) as source:
            full = source.convert("RGB")
        white = Image.new("RGBA", scoped_png.size, (255, 255, 255, 255))
        target = Image.alpha_composite(white, scoped_png).convert("RGB")
        best = 1e308
        best_offset = None
        for dx in range(-2, 3):
            for dy in range(-2, 3):
                left = int(math.floor(expected_x)) + dx
                top = int(math.floor(expected_y)) + dy
                if left < 0 or top < 0 or left + target.width > full.width \
                        or top + target.height > full.height:
                    continue
                reference = full.crop((left, top, left + target.width, top + target.height))
                rms = sum(ImageStat.Stat(ImageChops.difference(target, reference)).rms) / 3
                if rms < best:
                    best = rms
                    best_offset = (left, top)
        return best, best_offset

    rows = [[1200, 50, 49, 20, 7], [1180, 60, 59, 21, 12],
            [300, 100, 99, 22, 47], [280, 90, 89, 23, 52]]
    columns = ["Binding energy (eV)", "Intensity (cps)", "Total fit",
               "Baseline", "Peak component"]
    client = MCPClient()
    doc = None
    full_png = b""
    chart_results = {}
    try:
        client.start(cwd=out_dir)
        base = client.call_tool("figure_create", {
            "title": "XPS-chart-scope", "width_mm": 180, "height_mm": 85})["doc"]
        doc = client.call_tool("figure_apply_edits", {
            "doc": base,
            "ops": [{"op": "apply_template", "template_id": "tpl-xps-two-regions",
                     "data": {"columns": columns, "rows": rows},
                     "options": {"journal_id": "nature-single", "palette_id": "npg"}}],
        })["doc"]
        charts = [element for element in doc["elements"] if element["type"] == "chart"]
        assert len(charts) == 2
        labels = ("REGION-ALPHA-ONLY", "REGION-BETA-ONLY")
        for chart, label in zip(charts, labels):
            doc = client.call_tool("figure_apply_edits", {
                "doc": doc,
                "ops": [{"op": "set_chart_properties", "targets": [chart["id"]],
                         "properties": {"characterization": {"x_label": label}}}],
            })["doc"]
        charts = [element for element in doc["elements"] if element["type"] == "chart"]
        source_before = json.dumps(doc, ensure_ascii=False, sort_keys=True)
        full_path = out_dir / "xps-chart-scope-panel.png"
        full = client.call_tool("figure_export", {
            "doc": doc, "format": "png", "dpi": 96, "out_path": str(full_path),
            "panel_id": charts[0]["parent_id"]})
        assert full.get("ok") is True
        full_png = full_path.read_bytes()
        full_svg_path = out_dir / "xps-chart-scope-panel.svg"
        full_svg = client.call_tool("figure_export", {
            "doc": doc, "format": "svg", "dpi": 96, "out_path": str(full_svg_path),
            "panel_id": charts[0]["parent_id"]})
        assert full_svg.get("ok") is True
        full_view_box = [float(value) for value in ET.fromstring(
            full_svg_path.read_bytes()).get("viewBox").split()]
        full_origin = (full_view_box[0], full_view_box[1])
        body_width = full["px"]["width"]

        for chart, label, other_label in zip(charts, labels, reversed(labels)):
            chart_id = chart["id"]
            transform = chart["transform"]
            width_mm, height_mm = transform["w"], transform["h"]
            expected_px = {"width": math.ceil(width_mm * 96 / 25.4),
                           "height": math.ceil(height_mm * 96 / 25.4)}
            paths = {}
            payloads = {}
            svg_result = client.call_tool("figure_export", {
                "doc": doc, "format": "svg", "dpi": 96, "panel_id": chart_id})
            paths["svg"] = Path(svg_result.get("path") or "")
            payloads["svg"] = svg_result
            for fmt in ("png", "pdf"):
                path = out_dir / ("xps-chart-%s.%s" % (chart_id, fmt))
                payload = client.call_tool("figure_export", {
                    "doc": doc, "format": fmt, "dpi": 96, "panel_id": chart_id,
                    "out_path": str(path), "transparent": fmt == "png"})
                paths[fmt], payloads[fmt] = path, payload
            data = {fmt: paths[fmt].read_bytes() for fmt in ("svg", "png", "pdf")
                    if paths[fmt].is_file()}
            root = ET.fromstring(data.get("svg") or b"")
            actual_box = [float(value) for value in root.get("viewBox", "").split()]
            expected_box = [transform[key] for key in ("x", "y", "w", "h")]
            expected_name = "XPS-chart-scope_chart-%s_%gx%gmm_96dpi.svg" % (
                chart_id, width_mm, height_mm)
            with fitz.open(stream=data["pdf"], filetype="pdf") as pdf:
                page = pdf[0]
                pdf_ok = (pdf.page_count == 1
                          and abs(page.rect.width - width_mm * 72 / 25.4) < 0.1
                          and abs(page.rect.height - height_mm * 72 / 25.4) < 0.1
                          and label in page.get_text() and other_label not in page.get_text())
            with Image.open(io.BytesIO(data["png"])) as image:
                rgba = image.convert("RGBA")
                png_ok = rgba.size == (expected_px["width"], expected_px["height"])
            chart_results[chart_id] = {
                "png": data["png"], "expected_px": expected_px,
                "transform": transform, "label": label, "other_label": other_label,
            }
            capture("真实XPS单chart MCP %s：两格式px=物理尺寸且chart默认文件名/原panel不变" % chart_id,
                    lambda payloads=payloads, paths=paths, expected_px=expected_px,
                           expected_name=expected_name, root=root, actual_box=actual_box,
                           expected_box=expected_box, png_ok=png_ok, pdf_ok=pdf_ok,
                           body_width=body_width: (
                        all(payloads[fmt].get("ok") is True
                            and payloads[fmt].get("px") == expected_px for fmt in payloads)
                        and expected_px["width"] < body_width and png_ok and pdf_ok
                        and paths["svg"].name == expected_name
                        and root.get("width") == "%gmm" % expected_box[2]
                        and root.get("height") == "%gmm" % expected_box[3]
                        and actual_box == expected_box,
                        {"px": {fmt: payloads[fmt].get("px") for fmt in payloads},
                         "filename": paths["svg"].name, "viewBox": actual_box,
                         "pdf_ok": pdf_ok}))

            colored_strokes = {node.get("stroke") for node in root.iter()
                               if node.tag.rsplit("}", 1)[-1] == "polyline"
                               and node.get("stroke", "").startswith("#")}
            stroke_rgb = [tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))
                          for color in colored_strokes if len(color) == 7]
            image = png_rgba(data["png"])
            try:
                corners = [image.getpixel(point) for point in (
                    (0, 0), (image.width - 1, 0), (0, image.height - 1),
                    (image.width - 1, image.height - 1))]
                curve_pixels = sum(1 for red, green, blue, alpha in image.getdata()
                                   if alpha > 100 and any(
                                       abs(red - rgb[0]) < 55 and abs(green - rgb[1]) < 55
                                       and abs(blue - rgb[2]) < 55 for rgb in stroke_rgb))
            finally:
                image.close()
            capture("真实XPS单chart透明PNG %s：四角alpha=0且保留实际曲线颜色" % chart_id,
                    lambda corners=corners, curve_pixels=curve_pixels: (
                        all(pixel[3] == 0 for pixel in corners) and curve_pixels > 20,
                        {"corners": corners, "curve_pixels": curve_pixels}))

        assert json.dumps(doc, ensure_ascii=False, sort_keys=True) == source_before

        def invalid_ids_rejected():
            rect = {"id": "error-rect", "type": "rect", "parent_id": None,
                    "transform": {"x": 0, "y": 0, "w": 5, "h": 5},
                    "style": {"fill": "#FF0000"}}
            group = {"id": "error-group", "type": "group", "parent_id": None,
                     "transform": {"x": 0, "y": 0, "w": 5, "h": 5},
                     "style": {}, "children": []}
            cases = ((doc, "unknown-chart-id", "unknown-chart-id"),
                     (dict(doc, elements=doc["elements"] + [rect]), "error-rect", "rect"),
                     (dict(doc, elements=doc["elements"] + [group]), "error-group", "group"))
            for error_doc, bad_id, expected in cases:
                path = out_dir / ("rejected-" + bad_id + ".png")
                payload = client.call_tool("figure_export", {
                    "doc": error_doc, "format": "png", "panel_id": bad_id,
                    "out_path": str(path)})
                if payload.get("ok") is not False or expected not in str(payload.get("error")) \
                        or path.exists():
                    return False
            return True

        capture("单chart导出不改源doc/canvas/data且未知id、rect、group精确拒绝",
                lambda: (json.dumps(doc, ensure_ascii=False, sort_keys=True) == source_before
                         and invalid_ids_rejected(), "scope export 不生成回退整图文件"))
    except Exception as exc:
        results.append(("真实XPS单chart MCP回归环境", False,
                        "%s: %s" % (exc.__class__.__name__, exc)))
    finally:
        client.stop()

    if doc is None or len(chart_results) != 2:
        return results
    httpd = None
    thread = None
    try:
        import viewer
        previous_paths = (viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH)
        previous_state = viewer._STATE
        viewer.PROJECT_DIR = out_dir / "isolated-xps-chart-http-project"
        viewer.CURRENT_PROJECT_PATH = viewer.PROJECT_DIR / "current.figureproj.json"
        viewer._STATE = {"doc": None, "project_path": None}
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), viewer.ViewerHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        endpoint = "http://127.0.0.1:%d/api/export" % httpd.server_address[1]

        def http_export(fmt, chart_id):
            body = json.dumps({"doc": doc, "format": fmt, "dpi": 96,
                               "panel_id": chart_id, "transparent": fmt == "png"},
                              ensure_ascii=False).encode("utf-8")
            request = urllib.request.Request(endpoint, data=body,
                                             headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.status, response.read(), response.headers

        for chart_id, state in chart_results.items():
            http_data = {}
            headers = {}
            for fmt in ("png", "pdf"):
                status, data, response_headers = http_export(fmt, chart_id)
                assert status == 200, "%s/%s HTTP %s" % (chart_id, fmt, status)
                http_data[fmt], headers[fmt] = data, response_headers
            image = png_rgba(http_data["png"])
            try:
                size_ok = image.size == (state["expected_px"]["width"],
                                         state["expected_px"]["height"])
                corners = [image.getpixel(point)[3] for point in (
                    (0, 0), (image.width - 1, 0), (0, image.height - 1),
                    (image.width - 1, image.height - 1))]
            finally:
                image.close()
            page_count, width_pt, height_pt, text = pdf_facts(http_data["pdf"])
            transform = state["transform"]
            disposition = headers["pdf"].get("Content-Disposition", "")
            capture("真实XPS单chart HTTP %s：透明PNG/PDF实际范围、文件名和另一chart文本隔离" % chart_id,
                    lambda size_ok=size_ok, corners=corners, page_count=page_count,
                           width_pt=width_pt, height_pt=height_pt, text=text,
                           disposition=disposition, chart_id=chart_id, state=state: (
                        size_ok and all(alpha == 0 for alpha in corners) and page_count == 1
                        and abs(width_pt - transform["w"] * 72 / 25.4) < 0.1
                        and abs(height_pt - transform["h"] * 72 / 25.4) < 0.1
                        and state["label"] in text and state["other_label"] not in text
                        and "_chart-" + chart_id in disposition,
                        {"png_size": state["expected_px"], "pdf_pt": [width_pt, height_pt],
                         "filename": disposition, "text_isolated": state["other_label"] not in text}))

            comparison_image = png_rgba(http_data["png"])
            try:
                rms, offset = crop_pixel_similarity(
                    comparison_image, full_png, transform, full_origin)
            finally:
                comparison_image.close()
            capture("真实XPS单chart最终PNG像素 %s：只复核整图对应frame而非raw SVG token" % chart_id,
                    lambda rms=rms, offset=offset: (
                        rms < 18, {"crop_offset": offset, "RGB_RMS": rms, "threshold": 18}))

        rejected = []
        for suffix, element_type in (("rect", "rect"), ("group", "group")):
            invalid_doc = json.loads(json.dumps(doc))
            invalid_doc["elements"].append({
                "id": "http-error-" + suffix, "type": element_type, "parent_id": None,
                "transform": {"x": 0, "y": 0, "w": 5, "h": 5}, "style": {}, "children": []})
            body = json.dumps({"doc": invalid_doc, "format": "png",
                               "panel_id": "http-error-" + suffix}).encode("utf-8")
            request = urllib.request.Request(endpoint, data=body,
                                             headers={"Content-Type": "application/json"})
            try:
                urllib.request.urlopen(request, timeout=30)
                rejected.append(False)
            except urllib.error.HTTPError as exc:
                error = json.loads(exc.read().decode("utf-8")).get("error", "")
                rejected.append(400 <= exc.code < 500 and "http-error-" + suffix in error
                                and element_type in error)
        body = json.dumps({"doc": doc, "format": "png",
                           "panel_id": "unknown-chart-id"}).encode("utf-8")
        request = urllib.request.Request(endpoint, data=body,
                                         headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(request, timeout=30)
            rejected.append(False)
        except urllib.error.HTTPError as exc:
            rejected.append(400 <= exc.code < 500
                            and "unknown-chart-id" in exc.read().decode("utf-8"))
        capture("真实XPS HTTP未知id、rect、group均4xx精确拒绝且不回退整图",
                lambda: (all(rejected), rejected))
    except Exception as exc:
        results.append(("真实XPS单chart HTTP回归环境", False,
                        "%s: %s" % (exc.__class__.__name__, exc)))
    finally:
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        if thread is not None:
            thread.join(timeout=10)
        if "viewer" in locals():
            viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH = previous_paths
            viewer._STATE = previous_state
    return results


def spreadsheet_regression_probe(out_dir):
    """Actual workbook bytes through MCP, loopback HTTP and the real import UI."""
    import hashlib
    import openpyxl

    results = []

    def capture(name, fn):
        try:
            outcome = fn()
            if isinstance(outcome, tuple):
                passed, detail = outcome
            else:
                passed, detail = bool(outcome), ""
            results.append((name, bool(passed), detail))
        except Exception as exc:
            results.append((name, False, "%s: %s" % (exc.__class__.__name__, exc)))

    workbook = openpyxl.Workbook()
    raw_sheet = workbook.active
    raw_sheet.title = "Raw"
    raw_sheet.append(["workbook title"])
    raw_sheet.append(["group", "value", "total", "enabled"])
    raw_sheet.append(["A", 12.5, "=B3*2", True])
    raw_sheet.append(["B", 7, "=B4*2", False])
    second = workbook.create_sheet("Second")
    second.append(["other title"])
    second.append(["kind", "amount"])
    second.append(["first", 9])
    second.append(["second", 4])
    stream = io.BytesIO()
    workbook.save(stream)
    workbook.close()
    workbook_bytes = stream.getvalue()
    encoded = base64.b64encode(workbook_bytes).decode("ascii")
    expected_sha = hashlib.sha256(workbook_bytes).hexdigest()
    expected_rows = [["A", 12.5, None, True], ["B", 7, None, False]]
    local_path = out_dir / "local-input.xlsx"
    local_path.write_bytes(workbook_bytes)

    client = MCPClient()
    try:
        client.start()
        initial = client.call_tool("figure_open_data", {
            "xlsx_base64": encoded, "file_name": "actual.xlsx",
            "sheet": "Raw", "header_row": 2,
        })
        selected = client.call_tool("figure_open_data", {
            "xlsx_base64": encoded, "file_name": "actual.xlsx",
            "sheet": "Second", "header_row": 2,
        })
        capture("真实MCP工作簿bytes：类型/SHA/公式缺缓存位置与bcall列统计", lambda: (
            initial.get("ok") is True and initial.get("data", {}).get("rows") == expected_rows
            and initial.get("source_info", {}).get("sha256") == expected_sha
            and initial.get("source_info", {}).get("bytes") == len(workbook_bytes)
            and initial.get("source_info", {}).get("file_name") == "actual.xlsx"
            and initial.get("source_info", {}).get("formulas_evaluated") is False
            and any(item.get("kind") == "numeric" and item.get("name") == "value"
                    for item in initial.get("stats", {}).get("columns", []))
            and any(item.get("code") == "formula_cache_missing"
                    and "C3" in item.get("message", "")
                    and "C4" in item.get("message", "")
                    for item in initial.get("notices", [])),
            {"source_info": initial.get("source_info"), "notices": initial.get("notices")}))

        capture("真实MCP工作表选择与表头重读复用同一工作簿bytes", lambda: (
            selected.get("ok") is True and selected.get("sheet_name") == "Second"
            and selected.get("header_row") == 2
            and selected.get("data") == {
                "columns": ["kind", "amount"],
                "rows": [["first", 9], ["second", 4]]}
            and selected.get("source_info", {}).get("sha256") == expected_sha,
            selected.get("data")))

        base_doc = client.call_tool("figure_create", {
            "title": "spreadsheet-regression", "width_mm": 120, "height_mm": 90})["doc"]
        charted = client.call_tool("figure_create_chart", {
            "doc": base_doc,
            "data": {"xlsx_base64": encoded, "file_name": "actual.xlsx",
                     "sheet": "Raw", "header_row": 2},
            "template_id": "tpl-bar",
        })
        chart = next((el for el in (charted.get("doc") or {}).get("elements") or []
                      if el.get("type") == "chart"), None)
        chart_rows = (((chart or {}).get("chart") or {}).get("data") or {}) \
            .get("inline", {}).get("rows")
        capture("真实MCP bytes直接建图保留number/bool且公式不重算", lambda: (
            charted.get("ok") is True and chart is not None and chart_rows == expected_rows,
            {"rows": chart_rows, "error": charted.get("error")}))

        from_path = client.call_tool("figure_open_data", {
            "path": str(local_path), "sheet": "Raw", "header_row": 2})
        capture("真实MCP本机路径与base64共用解析并捕获一致source_info", lambda: (
            from_path.get("ok") is True and from_path.get("data") == initial.get("data")
            and from_path.get("source_info", {}).get("sha256") == expected_sha
            and from_path.get("source_info", {}).get("file_name") == local_path.name,
            from_path.get("source_info")))
    except Exception as exc:
        results.append(("真实MCP工作簿回归环境", False, "%s: %s" % (exc.__class__.__name__, exc)))
        initial = locals().get("initial", {})
    finally:
        client.stop()

    httpd = None
    thread = None
    try:
        import viewer
        previous_paths = (viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH)
        previous_state = viewer._STATE
        viewer.PROJECT_DIR = out_dir / "spreadsheet-http-project"
        viewer.CURRENT_PROJECT_PATH = viewer.PROJECT_DIR / "current.figureproj.json"
        viewer._STATE = {"doc": None, "project_path": None}
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), viewer.ViewerHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        endpoint = "http://127.0.0.1:%d/api/import-spreadsheet" % httpd.server_address[1]

        def http_import(body):
            request = urllib.request.Request(
                endpoint, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    return response.status, json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                return exc.code, json.loads(exc.read().decode("utf-8"))

        status, http_second = http_import({
            "data_base64": encoded, "file_name": "<img src=x>.xlsx",
            "sheet": "Second", "header_row": 2})
        capture("随机端口POST /api/import-spreadsheet返回真实解析而非伪造预览", lambda: (
            status == 200 and http_second.get("ok") is True
            and http_second.get("data") == selected.get("data")
            and http_second.get("source_info", {}).get("sha256") == expected_sha,
            {"status": status, "error": http_second.get("error")}))
        bad_status, bad_body = http_import({
            "data_base64": base64.b64encode(b"not an xlsx").decode("ascii"),
            "file_name": "broken.xlsx"})
        capture("HTTP工作簿错误明确返回4xx JSON且不含API key", lambda: (
            400 <= bad_status < 500 and bad_body.get("ok") is False
            and bool(bad_body.get("error"))
            and "api_key" not in json.dumps(bad_body).lower(),
            {"status": bad_status, "body": bad_body}))

        if initial:
            env = dict(os.environ)
            env.pop("DEEPSEEK_API_KEY", None)
            env["FIGURE_TEST_SPREADSHEET_URL"] = endpoint
            env["FIGURE_TEST_SPREADSHEET_BYTES"] = encoded
            env["FIGURE_TEST_SPREADSHEET_SHA256"] = expected_sha
            script = r"""
const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
for (const file of ['figdoc', 'ops', 'palette', 'presets', 'data']) require('./lib/' + file + '.js');
FigPresets.load({
  journals: JSON.parse(fs.readFileSync('../presets/journals.json', 'utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json', 'utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json', 'utf8'))
});
class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null;
    this.style = {}; this.attributes = {}; this.listeners = {}; this._text = '';
    this._innerHTML = ''; this.value = ''; this.disabled = false;
  }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this._text = value == null ? '' : String(value);
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; this.children.push(child); return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null; return child;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] == null ? null : this.attributes[key]; }
  addEventListener(name, handler) { (this.listeners[name] || (this.listeners[name] = [])).push(handler); }
  click() { for (const handler of this.listeners.click || []) handler({target: this}); }
}
global.document = {
  body: new Element('body'),
  createElement: tag => new Element(tag),
  createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; }
};
const modals = [];
const notices = [];
global.Ui = {
  modal(options) { const item = {options, closed: false}; modals.push(item);
    return {close() { item.closed = true; }, root: options.body}; },
  toast(text, options) { notices.push({text: String(text), options}); }
};
global.App = {
  doc: FigDoc.create({title: 'spreadsheet-ui', width_mm: 120, height_mm: 90}),
  commits: 0,
  commit(ops, context) {
    const result = FigOps.applyAll(this.doc, ops, {
      label: context.label, source: context.source, ts: '2026-11-11T00:00:00Z'});
    if (result.applied) { this.doc = result.doc; this.commits += 1; }
    return Promise.resolve({applied: result.applied, doc: this.doc});
  },
  select() {}, error(text) { notices.push({text: String(text), options: {type: 'error'}}); },
  status() {}
};
const nativeFetch = global.fetch;
const endpoint = process.env.FIGURE_TEST_SPREADSHEET_URL;
const requests = [];
global.fetch = function (_relative, options) {
  requests.push({options});
  return nativeFetch(endpoint, options);
};
require('./viewer_static/app/import.js');
require('./viewer_static/app/data-wizard.js');
const raw = Buffer.from(process.env.FIGURE_TEST_SPREADSHEET_BYTES, 'base64');
const copyBuffer = () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const xlsmFile = {name: '<img src=x onerror=alert(1)>.xlsm', arrayBuffer: async () => copyBuffer()};
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({name, ok: true, detail: 'DOM-level UI function PASS'}); }
  catch (err) { results.push({name, ok: false, detail: err && err.stack ? err.stack : String(err)}); }
}
function lastAction(label) {
  const modal = modals[modals.length - 1];
  assert.ok(modal, '缺少导入/模板 modal');
  const action = modal.options.actions.find(item => item.label === label);
  assert.ok(action, '缺少动作 ' + label);
  return action;
}
(async () => {
  await test('文件accept包含xlsx/xlsm/xls且File.arrayBuffer走真实HTTP而非CSV parser', async () => {
    const input = Import.openData();
    for (const ext of ['.xlsx', '.xlsm', '.xls']) assert.ok(input.getAttribute('accept').includes(ext));
    assert.strictEqual(App.commits, 0);
  });

  let preview;
  await test('双工作表切换和header_row重解析只更新预览/stats且公式坐标可见', async () => {
    preview = await Import._applySpreadsheetFile(xlsmFile, err => { if (err) throw err; });
    assert.ok(preview && preview.getResult());
    assert.strictEqual(preview.getResult().header_row, 2);
    preview.sheetSelect.value = 'Second'; preview.headerInput.value = '2';
    const second = await preview.refresh();
    assert.deepStrictEqual(second.data.rows, [['first', 9], ['second', 4]]);
    preview.sheetSelect.value = 'Raw'; preview.headerInput.value = '1';
    preview.headerInput.value = '2';
    const rawPreview = await preview.refresh();
    assert.deepStrictEqual(rawPreview.data.rows, [['A', 12.5, null, true], ['B', 7, null, false]]);
    assert.strictEqual(rawPreview.source_info.sha256, process.env.FIGURE_TEST_SPREADSHEET_SHA256);
    assert.strictEqual(rawPreview.source_info.format, 'xlsm');
    const text = preview.body.textContent;
    assert.ok(text.includes('C3') && text.includes('C4'));
    assert.ok(text.includes('value [numeric'));
    assert.ok(text.includes('<img src=x onerror=alert(1)>'));
    assert.strictEqual(preview.body.innerHTML.includes('<img'), false);
    assert.strictEqual(App.commits, 0);
    assert.strictEqual(App.doc.history.length, 0);
    assert.strictEqual(requests.length >= 3, true);
    for (const request of requests) {
      assert.strictEqual(request.options.headers['Content-Type'], 'application/json');
      const body = JSON.parse(request.options.body);
      assert.ok(body.data_base64);
      assert.strictEqual('api_key' in body, false);
      assert.strictEqual('authorization' in body, false);
    }
  });

  await test('切换工作表自动重新识别表头，不把上一表自动行号当手动覆盖', async () => {
    preview.sheetSelect.value = 'Second';
    preview.headerInput.value = '2';
    preview.sheetSelect.listeners.change[0]({target: preview.sheetSelect});
    const deadline = Date.now() + 3000;
    while (preview.getResult().sheet_name !== 'Second' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(preview.getResult().sheet_name, 'Second');
    assert.strictEqual(preview.getResult().header_row, 2);
    assert.deepStrictEqual(preview.getResult().data.columns, ['kind', 'amount']);
    const changeBody = JSON.parse(requests[requests.length - 1].options.body);
    assert.strictEqual(changeBody.sheet, 'Second');
    assert.strictEqual('header_row' in changeBody, false);
    assert.strictEqual(App.commits, 0);
    assert.strictEqual(App.doc.history.length, 0);
    preview.sheetSelect.value = 'Raw';
    preview.headerInput.value = '2';
    await preview.refresh();
  });

  await test('用户确认后经真实FigOps/App.commit一次导入并记录file/sheet/header/sha', async () => {
    const continueResult = lastAction('继续：选择模板').onClick();
    if (continueResult && continueResult.then) await continueResult;
    await lastAction('创建图表').onClick();
    assert.strictEqual(App.commits, 1);
    assert.strictEqual(App.doc.history.length, 1);
    const chart = App.doc.elements.find(element => element.type === 'chart');
    assert.ok(chart);
    assert.deepStrictEqual(chart.chart.data.inline.rows,
      [['A', 12.5, null, true], ['B', 7, null, false]]);
    const note = App.doc.history[0].ops.find(op => op.op === 'note');
    assert.ok(note && note.note.includes('Raw') && note.note.includes('表头第 2 行'));
    assert.ok(note.note.includes(process.env.FIGURE_TEST_SPREADSHEET_SHA256));
    assert.ok(note.note.includes('<img src=x onerror=alert(1)>.xlsm'));
  });

  await test('无效工作簿与服务不可达均明确失败且不commit', async () => {
    const before = App.commits;
    const bad = await Import._applySpreadsheetFile({
      name: 'broken.xlsx', arrayBuffer: async () => new TextEncoder().encode('not workbook').buffer
    });
    assert.strictEqual(bad, null);
    assert.strictEqual(App.commits, before);
    const oldFetch = global.fetch;
    global.fetch = () => Promise.reject(new TypeError('offline'));
    let unavailable;
    try { unavailable = await Import._applySpreadsheetFile(xlsmFile); }
    finally { global.fetch = oldFetch; }
    assert.strictEqual(unavailable, null);
    assert.strictEqual(App.commits, before);
    assert.ok(notices.some(item => item.text.includes('Excel') &&
      item.text.includes('图工作台服务')));
  });

  await test('App.commit拒绝时不写figure/history；原有CSV导入仍可成功', async () => {
    const docBefore = JSON.stringify(App.doc);
    const originalCommit = App.commit;
    App.commit = () => Promise.reject(new Error('offline validation failure'));
    const secondPreview = await Import._applySpreadsheetFile(xlsmFile);
    try {
      lastAction('继续：选择模板').onClick();
      const outcome = await lastAction('创建图表').onClick();
      assert.strictEqual(outcome, false);
      assert.strictEqual(JSON.stringify(App.doc), docBefore);
    } finally {
      App.commit = originalCommit;
      if (secondPreview && secondPreview.modal) secondPreview.modal.close();
    }
    const before = App.commits;
    Import._applyDataTable('group,value\nctrl,1\nmu,2', 'still-works.csv');
    await lastAction('创建图表').onClick();
    assert.strictEqual(App.commits, before + 1);
    assert.strictEqual(App.doc.history.length >= 2, true);
  });
  console.log('__RESULTS__' + JSON.stringify(results));
})().catch(err => {
  console.error(err && err.stack ? err.stack : String(err)); process.exitCode = 1;
});
"""
            try:
                proc = subprocess.run(
                    ["node", "-e", script], cwd=str(MCP_DIR), env=env,
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
                marker = "__RESULTS__"
                line = next((item for item in proc.stdout.splitlines()
                             if item.startswith(marker)), None)
                ui_results = json.loads(line[len(marker):]) if line else []
                if proc.returncode != 0 or line is None:
                    results.append(("工作簿DOM级UI回归环境", False, clip(proc.stderr or proc.stdout)))
                for item in ui_results:
                    results.append((item["name"], bool(item["ok"]), clip(item.get("detail", ""))))
            except Exception as exc:
                results.append(("工作簿DOM级UI回归环境", False,
                                "%s: %s" % (exc.__class__.__name__, exc)))
    except Exception as exc:
        results.append(("随机端口工作簿HTTP/UI回归环境", False,
                        "%s: %s" % (exc.__class__.__name__, exc)))
    finally:
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        if thread is not None:
            thread.join(timeout=10)
        if "viewer" in locals():
            viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH = previous_paths
            viewer._STATE = previous_state
    return results


def _selftest_schematic_contract(identifier, graphical=False):
    roles = ["question", "method", "evidence", "conclusion"]
    nodes = [{
        "id": "self-node-%d" % (i + 1), "label": "DEMO " + roles[i],
        "role": roles[i] if graphical else "method", "shape": "box",
        "kind": "entity", "x": 8 + i * 40, "y": 15, "w": 24, "h": 14,
        "evidence": ["DEMO-SOURCE"],
    } for i in range(4)]
    relations = [
        {"id": "self-activate", "source": nodes[0]["id"], "target": nodes[1]["id"],
         "kind": "activate", "label": "DEMO relation", "evidence": ["DEMO-SOURCE"]},
        {"id": "self-inhibit", "source": nodes[1]["id"], "target": nodes[2]["id"],
         "kind": "inhibit", "evidence": ["DEMO-SOURCE"]},
        {"id": "self-associate", "source": nodes[2]["id"], "target": nodes[3]["id"],
         "kind": "associate", "evidence": ["DEMO-SOURCE"]},
        {"id": "self-include", "source": nodes[0]["id"], "target": nodes[1]["id"],
         "kind": "include", "evidence": ["DEMO-SOURCE"]},
    ]
    return {"schema_version": "1.0", "id": identifier,
            "template": "graphical_abstract" if graphical else "flow",
            "nodes": nodes, "relations": relations,
            "sources": [{"id": "DEMO-SOURCE", "locator": "DEMO synthetic §1",
                         "version": "demo-v1", "text": "Synthetic user text, not a paper."}],
            "canvas": {"width_mm": 180, "height_mm": 60, "dpi": 96, "background": "#FFFFFF"},
            "layout": {"mode": "manual", "auto_layout": False}}


def schematic_source_scenarios(client, out_dir):
    results = []

    def source_value_chart():
        created = client.call_tool("figure_create", {"title": "DEMO source-value", "width_mm": 120,
                                                     "height_mm": 90, "dpi": 96})
        table = {"columns": ["condition", "response"], "rows": [["CONTROL", 2], ["TREATMENT", 4]]}
        made = client.call_tool("figure_create_chart", {"doc": created["doc"], "template_id": "tpl-bar",
            "data": {"inline": table}})
        cid = next(el["id"] for el in made["doc"]["elements"] if el["type"] == "chart")
        changed = client.call_tool("figure_apply_edits", {"doc": made["doc"], "ops": [{
            "op": "set_chart_data", "targets": [cid], "approved": True,
            "data": {"columns": ["condition", "response"], "rows": [["CONTROL", 6], ["TREATMENT", 8]]},
            "source_ref": "DEMO-v2.csv", "version": "v2"}]})
        chart = next(el for el in changed["doc"]["elements"] if el["id"] == cid)
        lineage = client.call_tool("figure_lineage", {"doc": changed["doc"],
            "lookup": {"element_id": cid, "source_row": 1}})
        assert lineage["lookup"]["matches"][0]["raw_point"]["values_by_column"]["response"] == 8
        assert chart["chart"]["statistics_review"]["status"] == "required"
        assert chart["chart"]["data_history"][0]["data"]["inline"]["rows"][0][1] == 2
        assert chart["chart"]["data"]["row_mapping"][1]["source_row_index"] is None
        return "approved set_chart_data + immutable original + reverse lookup"

    def source_linked_flow():
        contract = _selftest_schematic_contract("selftest-source-flow")
        made = client.call_tool("figure_schematic", {"contract": contract, "preview": True})
        baseline = client.call_tool("figure_render", {"doc": made["doc"], "format": "svg"})["svg"]
        assert made["svg"] == baseline
        assert made["diagram"]["source_verification"] == "user_provided_unverified"
        moved = client.call_tool("figure_apply_edits", {"doc": made["doc"], "ops": [
            {"op": "move", "targets": ["self-node-2"], "dx": 4, "dy": 3}]})
        after = client.call_tool("figure_render", {"doc": moved["doc"], "format": "svg"})["svg"]
        assert after != baseline and 'data-relation-kind="inhibit"' in after
        source = out_dir / "DEMO-source.txt"
        source.write_text("Synthetic DEMO only; not a paper.\n", encoding="utf-8")
        bundle = client.call_tool("figure_export_bundle", {
            "doc": moved["doc"], "output_directory": str(out_dir / "schematic-bundle"),
            "case_id": "DEMO-not-official", "input_source": str(source),
            "output_contract": {"formats": ["svg", {"format": "png", "dpi": 96}, {"format": "pdf", "dpi": 96}]}})
        formats = {item.get("format") for item in bundle["artifacts"] if item.get("decoded")}
        assert {"svg", "png", "pdf"}.issubset(formats)
        assert bundle["human_review"] is None
        return "dynamic connector + real SVG/PNG/PDF + no fake human review"

    def graphical_abstract():
        one = client.call_tool("figure_schematic", {
            "contract": _selftest_schematic_contract("selftest-ga", True), "preview": True})
        two = client.call_tool("figure_schematic", {
            "contract": _selftest_schematic_contract("selftest-ga", True), "preview": True})
        assert one["svg"] == two["svg"]
        moved = client.call_tool("figure_apply_edits", {"doc": one["doc"], "ops": [
            {"op": "move", "targets": ["self-node-2"], "dx": 5, "dy": 2}]})
        updated = client.call_tool("figure_schematic", {
            "doc": moved["doc"], "contract": _selftest_schematic_contract("selftest-ga", True), "preview": True})
        node = next(el for el in updated["doc"]["elements"] if el["id"] == "self-node-2")
        assert node["transform"] == next(el["transform"] for el in moved["doc"]["elements"] if el["id"] == "self-node-2")
        assert updated["diagram"]["review_status"] == "not_recorded"
        return "same contract same SVG + semantic manual layout retained"

    def structural_errors():
        missing = _selftest_schematic_contract("selftest-missing")
        missing["sources"] = []
        for item in missing["nodes"] + missing["relations"]:
            item["evidence"] = []
        partial = client.call_tool("figure_schematic", {"contract": missing})
        assert any(w["code"] in ("MISSING_MATERIALS", "EVIDENCE_MISSING") for w in partial["warnings"])
        invalid = _selftest_schematic_contract("selftest-invalid")
        invalid["nodes"][0]["shape"] = "not-a-real-shape"
        rejected = client.call_tool("figure_schematic", {"contract": invalid})
        assert rejected["ok"] is False and "INVALID_SHAPE" in rejected["error"]
        return "MISSING_MATERIALS / EVIDENCE_MISSING vs INVALID_SHAPE explicit"

    for name, fn in (("DEMO source_value_chart 真正 MCP 数据版本/行回溯", source_value_chart),
                     ("DEMO source-linked flow 真正 MCP 动态关系与导出包", source_linked_flow),
                     ("DEMO Graphical Abstract 同构/布局保留与未复核状态", graphical_abstract),
                     ("DEMO 缺材料/非法形状失败态精确区分", structural_errors)):
        try:
            results.append((name, True, fn()))
        except Exception as exc:
            results.append((name, False, "%s: %s" % (exc.__class__.__name__, exc)))
    return results


def main():
    parser = argparse.ArgumentParser(description="figure-drawing 插件端到端自测")
    parser.add_argument("--out", default=None,
                        help="临时目录的已存在父目录（默认系统临时目录；结束后全部清理）")
    args = parser.parse_args()

    sandbox = tempfile.TemporaryDirectory(prefix="figure-selftest-", dir=args.out)
    out_dir = Path(sandbox.name) / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    print("figure-drawing selftest — 插件根目录: %s" % PLUGIN_ROOT)
    print("MCP 服务: %s" % (MCP_DIR / "server.py"))
    print("样例数据: %s" % SAMPLE_CSV)
    print("隔离临时产物目录（结束后删除）: %s" % out_dir, flush=True)

    if not SAMPLE_CSV.is_file():
        record("样例数据存在", False, "缺少 %s" % SAMPLE_CSV)
        sandbox.cleanup()
        return 1

    client = MCPClient()
    try:
        client.start()

        # -- initialize ------------------------------------------------------
        resp = client.request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "selftest", "version": "1"}})
        res = resp.get("result") or {}
        record("initialize 返回 protocolVersion/serverInfo",
               bool(res.get("protocolVersion")) and bool(res.get("serverInfo")),
               clip(res))

        # -- tools/list --------------------------------------------------------
        tools = ((client.request("tools/list").get("result") or {}).get("tools")) or []
        record("tools/list 工具数 == %d" % EXPECTED_TOOLS,
               len(tools) == EXPECTED_TOOLS, "实际=%d" % len(tools))
        export_schema = next((tool.get("inputSchema") or {}
                              for tool in tools if tool.get("name") == "figure_export"), {})
        export_properties = export_schema.get("properties") or {}
        record("figure_export schema 包含可选 panel_id/transparent 与中文说明",
               isinstance((export_properties.get("panel_id") or {}).get("description"), str)
               and "仅" in (export_properties.get("panel_id") or {}).get("description", "")
               and (export_properties.get("transparent") or {}).get("type") == "boolean"
               and "仅 PNG" in (export_properties.get("transparent") or {})
               .get("description", "")
               and "panel_id" not in (export_schema.get("required") or [])
               and "transparent" not in (export_schema.get("required") or []))

        probe_ok, probe_detail = history_origin_memory_probe()
        record("纯内存 history_origin 捕获/恢复/去递归与旧基线边界",
               probe_ok, probe_detail)
        for name, passed, detail in history_ui_regression_probe():
            record(name, passed, detail)
        for name, passed, detail in canvas_regression_probe():
            record(name, passed, detail)
        for name, passed, detail in ai_ui_regression_probe():
            record(name, passed, detail)
        for name, passed, detail in server_history_regression_probe(client, out_dir):
            record(name, passed, detail)
        for name, passed, detail in spreadsheet_regression_probe(out_dir):
            record(name, passed, detail)

        # -- 1/3. figure_create（套期刊预设；同时验证本地 presets/ 生效）--------
        payload = client.call_tool("figure_create", {
            "journal_id": JOURNAL_ID, "title": "自测：组间比较", "dpi": 300})
        doc = payload.get("doc") or {}
        canvas = doc.get("canvas") or {}
        record("figure_create ok=True 且画布 = 89x170mm（nature-single 预设生效）",
               payload.get("ok") is True
               and canvas.get("width_mm") == 89 and canvas.get("height_mm") == 170
               and canvas.get("journal_preset_id") == JOURNAL_ID,
               "canvas=%sx%s journal=%s" % (canvas.get("width_mm"),
                                            canvas.get("height_mm"),
                                            canvas.get("journal_preset_id")))

        # -- 1. figure_open_data（读样例 CSV）----------------------------------
        csv_text = SAMPLE_CSV.read_text(encoding="utf-8-sig")
        payload = client.call_tool("figure_open_data", {"csv": csv_text})
        recs = payload.get("recommended") or []
        record("figure_open_data ok=True 且 columns=6、有模板推荐",
               payload.get("ok") is True and len(payload.get("columns") or []) == 6
               and bool(recs),
               "columns=%s 推荐=%s" % (payload.get("columns"),
                                       [r.get("template_id") for r in recs[:3]]))
        top_template = recs[0]["template_id"]
        print("  -> 采用推荐第 1 个模板：%s" % top_template, flush=True)

        # -- 3. figure_create_chart --------------------------------------------
        payload = client.call_tool("figure_create_chart", {
            "doc": doc, "data": {"csv": csv_text},
            "template_id": top_template, "journal_id": JOURNAL_ID,
            "palette_id": "npg"})
        doc = payload.get("doc") or {}
        elements = doc.get("elements") or []
        record("figure_create_chart ok=True 且产生 chart 元素",
               payload.get("ok") is True and any(e.get("type") == "chart"
                                                 for e in elements),
               "元素类型=%s warnings=%s" % ([e.get("type") for e in elements],
                                           payload.get("warnings")))

        # -- 4. figure_add_anchor -----------------------------------------------
        target = next((e for e in elements if e.get("type") == "text"),
                      next((e for e in elements if e.get("type") == "chart"), None))
        t = target["transform"]
        payload = client.call_tool("figure_add_anchor", {
            "doc": doc, "label": "(a) 主图",
            "bbox_mm": {k: t[k] for k in ("x", "y", "w", "h")},
            "element_ids": [target["id"]],
            "note": "selftest 锚点：主图区域"})
        doc = payload.get("doc") or {}
        anchor_id = (payload.get("anchor") or {}).get("id")
        record("figure_add_anchor ok=True 且锚点写入 doc.anchors",
               payload.get("ok") is True and bool(anchor_id)
               and any(a.get("id") == anchor_id for a in doc.get("anchors") or []),
               "anchor.id=%s" % anchor_id)

        # -- 5. figure_apply_edits（移到左上 + 字号 8pt，经 @锚点id 定位）--------
        ops = [
            {"op": "move", "targets": ["@" + anchor_id], "x": 4.0, "y": 4.0,
             "reason": "selftest：移到画布左上"},
            {"op": "set_style", "targets": ["@" + anchor_id],
             "style": {"fontSizePt": 8}, "reason": "selftest：字号 8pt"},
        ]
        payload = client.call_tool("figure_apply_edits", {"doc": doc, "ops": ops})
        doc = payload.get("doc") or {}
        record("figure_apply_edits ok=True applied=2 errors=[]",
               payload.get("ok") is True and payload.get("applied") == 2
               and payload.get("errors") == [],
               "applied=%r errors=%r" % (payload.get("applied"), payload.get("errors")))

        # -- 6. figure_check ------------------------------------------------------
        payload = client.call_tool("figure_check", {"doc": doc})
        record("figure_check 返回 ok 布尔与 warnings 数组",
               isinstance(payload.get("ok"), bool)
               and isinstance(payload.get("warnings"), list),
               "ok=%s warnings=%d" % (payload.get("ok"),
                                      len(payload.get("warnings") or [])))

        # -- 6.5 科学论证合同（query / 非法输入 / apply / 幂等 / audit / revert）--
        chart_el = next((e for e in doc.get("elements") or []
                         if e.get("type") == "chart"), None)
        record("科学合同前置：文档中存在 chart 元素", chart_el is not None,
               "chart_id=%s" % (chart_el or {}).get("id"))

        payload = client.call_tool("figure_scientific_contract", {"doc": doc})
        q0 = payload.get("contract") or {}
        record("figure_scientific_contract 只读查询 ok=True 且空轮廓结构一致"
               "（schema_version=1、panels=[]、statistics={}）",
               payload.get("ok") is True and q0.get("schema_version") == 1
               and q0.get("panels") == [] and q0.get("statistics") == {},
               "schema_version=%r panels=%r" % (q0.get("schema_version"), q0.get("panels")))

        bad = client.call_tool("figure_scientific_contract", {
            "doc": doc,
            "contract": {"archetype": "no-such-arch", "results_question": "x"}})
        record("非法 contract（archetype 不在白名单）→ ok=False 且不修改源 doc",
               bad.get("ok") is False
               and (bad.get("doc") is None or bad.get("doc") == doc),
               clip(bad.get("error")))

        contract_input = {
            "schema_version": 1,
            "results_question": "处理 A 与 B 的平均 value 是否不同？",
            "figure_claim": "B 组平均 value 高于 A 组（图级声明）",
            "falsifier": "若 B 组均值不高于 A 组，或组内 SD 覆盖组间差值，则该声明不成立",
            "archetype": "quantitative_grid",
            "hero_panel": chart_el["id"],
            "panels": [{
                "element_id": chart_el["id"], "label": "a", "sequence": 1,
                "question": "A 与 B 的均值差异是否大于组内变异？",
                "evidence_role": "primary",
                "decisive_comparison": "category A vs B（均值±SD）",
                "unique_gain": "唯一同时展示两处理全部重复观测离散度的主图",
                "claim_dependency": "图级声明完全依赖本面板的均值比较",
                "destination": "main",
            }],
            "statistics": {
                chart_el["id"]: {
                    "n_definition": "每类别×分组 5 次独立重复观测",
                    "biological_replicates": 5,
                    "technical_replicates": 1,
                    "center": "mean",
                    "spread": "SD",
                    "uncertainty_source": "replicates",
                    "source_data": "examples/sample.csv",
                    "unit_x": "category",
                    "unit_y": "value",
                },
            },
        }
        base_rev = ((doc.get("history") or [{}])[-1] or {}).get("rev") or 0

        def _chart_stats_of(d):
            el = next((e for e in d.get("elements") or []
                       if e.get("type") == "chart" and e.get("id") == chart_el["id"]), None)
            return (el or {}).get("chart", {}).get("statistics") or {}

        payload = client.call_tool("figure_scientific_contract",
                                   {"doc": doc, "contract": contract_input})
        doc = payload.get("doc") or doc
        meta_sc = (doc.get("meta") or {}).get("scientific_contract") or {}
        stats1 = _chart_stats_of(doc)
        record("figure_scientific_contract apply ok=True 且 meta.scientific_contract 写入",
               payload.get("ok") is True and bool(meta_sc)
               and meta_sc.get("results_question") == contract_input["results_question"],
               "label=%s" % ((doc.get("history") or [{}])[-1].get("label")))
        record("apply 后 statistics 写入对应 chart.chart.statistics（center/spread/n）",
               stats1.get("center") == "mean" and stats1.get("spread") == "SD"
               and stats1.get("biological_replicates") == 5,
               clip(json.dumps(stats1, ensure_ascii=False)))
        record("合同视图 statistics 由 chart 派生（meta 不留 statistics 镜像）",
               (payload.get("contract") or {}).get("statistics", {})
               .get(chart_el["id"], {}).get("spread") == "SD"
               and "statistics" not in meta_sc,
               "meta keys=%s" % sorted(meta_sc.keys()))

        meta_json1 = json.dumps(meta_sc, sort_keys=True, ensure_ascii=False)
        elements_json1 = json.dumps(doc.get("elements"), sort_keys=True, ensure_ascii=False)
        payload = client.call_tool("figure_scientific_contract",
                                   {"doc": doc, "contract": contract_input})
        doc = payload.get("doc") or doc
        meta_sc2 = (doc.get("meta") or {}).get("scientific_contract") or {}
        record("重复 apply 幂等（合同与 chart.statistics 内容不变）",
               json.dumps(meta_sc2, sort_keys=True, ensure_ascii=False) == meta_json1
               and json.dumps(_chart_stats_of(doc), sort_keys=True, ensure_ascii=False)
               == json.dumps(stats1, sort_keys=True, ensure_ascii=False)
               and json.dumps(doc.get("elements"), sort_keys=True, ensure_ascii=False)
               == elements_json1,
               "meta/elements 一致性比对")

        payload = client.call_tool("figure_scientific_audit", {"doc": doc})
        cov = payload.get("coverage") or {}
        coverage_keys = {"question", "panels", "statistics", "hero_panel", "final_size"}
        record("figure_scientific_audit ok=True 且 scientific_ready=True、coverage 核心项与 hero_panel 均为 true",
               payload.get("ok") is True and payload.get("scientific_ready") is True
               and coverage_keys.issubset(cov)
               and all(isinstance(cov.get(k), bool) for k in coverage_keys)
               and all(v is True for v in cov.values()),
               clip(json.dumps(cov, ensure_ascii=False)))
        record("audit warnings 含统计推断免责声明（info：不能从颜色/数值/形状推断结论）",
               any(w.get("code") == "STATS_INFERENCE_DISCLAIMER"
                   for w in payload.get("warnings") or []),
               "warnings=%d" % len(payload.get("warnings") or []))

        payload = client.call_tool("figure_revert", {"doc": doc, "rev": base_rev})
        doc = payload.get("doc") or doc
        record("figure_revert 回合同前版本后 meta.scientific_contract 与 chart.statistics 均还原",
               payload.get("ok") is True
               and not (doc.get("meta") or {}).get("scientific_contract")
               and not _chart_stats_of(doc),
               "revert_to=%d" % base_rev)

        resp = client.raw_line("{这是非法JSON")
        record("非法 JSON 请求返回 -32700 解析错误",
               resp.get("error", {}).get("code") == -32700, clip(str(resp)))
        resp2 = client.request("ping")
        record("非法 JSON 后 ping 仍正常响应（服务未退出、源 doc 不受影响）",
               "result" in resp2, clip(str(resp2)))

        # -- 6c. 表征模板、真实渲染与数据保持 -------------------------------------
        default_templates = (client.call_tool("figure_templates", {})
                             .get("templates") or [])
        record("模板推荐默认仅含 full/layout，不包含 unsupported",
               len(default_templates) == 39
               and all(t.get("capability") in ("full", "layout")
                       and t.get("can_apply") is True for t in default_templates),
               "templates=%d" % len(default_templates))
        template_payload = client.call_tool("figure_templates", {"include_unsupported": True})
        templates = template_payload.get("templates") or []
        record("模板能力表覆盖60个模板及 XPS / Raman 表征谱图",
               len(templates) == 60
               and all(t.get("capability") in ("full", "layout", "unsupported")
                       for t in templates)
               and any(t.get("id") == "tpl-xps-highres-fit" for t in templates)
               and any(t.get("id") == "tpl-raman-single" for t in templates),
               "templates=%d" % len(templates))
        for name, passed, detail in stage5_node_browser_regression_probe():
            record(name, passed, detail)
        for name, passed, detail in stage5_mcp_regression_probe(client, out_dir):
            record(name, passed, detail)
        for name, passed, detail in schematic_source_scenarios(client, out_dir):
            record(name, passed, detail)

        def chart_data(template_id, columns, rows):
            base = client.call_tool("figure_create", {
                "title": "表征验收", "journal_id": JOURNAL_ID, "dpi": 300})
            return client.call_tool("figure_create_chart", {
                "doc": base.get("doc"),
                "data": {"inline": {"columns": columns, "rows": rows}},
                "chart_type": "line",
                "template_id": template_id,
            })

        def svg_points(polyline):
            return [[float(v) for v in pair.split(",")]
                    for pair in (polyline.get("points") or "").split()]

        def svg_texts(svg):
            return ["".join(node.itertext()) for node in ET.fromstring(svg).iter(
                "{http://www.w3.org/2000/svg}text")]

        def chart_of(document, element_id=None):
            return next(e for e in document.get("elements") or []
                        if e.get("type") == "chart"
                        and (element_id is None or e.get("id") == element_id))

        xps_columns = ["Binding energy (eV)", "Intensity (cps)", "Total fit",
                       "Baseline", "Peak component"]
        xps_rows = [[1200, 50, 49, 20, 7], [1180, 60, 59, 21, 12],
                    [300, 100, 99, 22, 47], [280, 90, 89, 23, 52]]
        xps_result = chart_data("tpl-xps-highres-fit", xps_columns, xps_rows)
        xps_doc = xps_result.get("doc") or {}
        xps_el = chart_of(xps_doc)
        xps_char = xps_el["chart"]["characterization"]
        record("XPS 高分辨模板保留乱序原始行、结合能反轴和用户拟合列",
               xps_result.get("ok") is True
               and xps_char.get("x_reverse") is True
               and xps_el["chart"]["data"]["inline"]["rows"] == xps_rows
               and any(c.get("role") == "fit" and c.get("column") == "Total fit"
                       for c in xps_char.get("curves") or []),
               json.dumps(xps_char, ensure_ascii=False))
        xps_svg_result = client.call_tool("figure_render", {"doc": xps_doc, "format": "svg"})
        xps_svg = xps_svg_result.get("svg") or ""
        import xml.etree.ElementTree as ET
        xps_root = ET.fromstring(xps_svg)
        paint_order = [node for node in xps_root.iter()
                       if node.tag == "{http://www.w3.org/2000/svg}polyline"]
        xps_fit_lines = [node for node in paint_order
                         if node.get("stroke-dasharray") == "6 3"]
        xps_baseline_lines = [node for node in paint_order
                              if node.get("stroke-dasharray") == "2 3"]
        raw_marker_colors = {node.get("fill") for node in xps_root.iter(
            "{http://www.w3.org/2000/svg}circle")}
        xps_raw_lines = [node for node in paint_order
                         if node.get("stroke-dasharray") is None
                         and node.get("stroke") in raw_marker_colors]
        assert len(xps_fit_lines) == 1, "XPS SVG 未得到唯一 stroke-dasharray=6 3 拟合线"
        assert len(xps_baseline_lines) == 1, "XPS SVG 未得到唯一基线"
        assert len(xps_raw_lines) == 1, "XPS SVG 未得到唯一原始曲线"
        xps_fit_points = svg_points(xps_fit_lines[0])
        xps_raw_points = svg_points(xps_raw_lines[0])
        xps_text = svg_texts(xps_svg)
        record("XPS SVG baseline 先于 fit 绘制，raw/fit 各有真实 polyline 与图例且反轴递减",
               xps_svg_result.get("ok") is True
               and paint_order.index(xps_baseline_lines[0]) < paint_order.index(xps_fit_lines[0])
               and len(xps_fit_points) == len(xps_rows)
               and len(xps_raw_points) == len(xps_rows)
               and all(a[0] > b[0] for a, b in zip(xps_fit_points, xps_fit_points[1:]))
               and all(a[0] > b[0] for a, b in zip(xps_raw_points, xps_raw_points[1:]))
               and "fit:Total fit" in xps_svg and 'x_reverse=true' in xps_svg
               and xps_text.count("fit") == 1
               and xps_text.count("Intensity (cps)") == 1,
               "baseline<fit；fit/raw 每条 %d 点；高结合能在左" % len(xps_fit_points))
        xps_rows_before = json.loads(json.dumps(xps_el["chart"]["data"]["inline"]["rows"]))
        edited = client.call_tool("figure_apply_edits", {
            "doc": xps_doc,
            "ops": [{"op": "set_chart_properties", "targets": [xps_el["id"]],
                     "properties": {"characterization": {"x_reverse": False}}}],
        })
        edited_el = chart_of(edited["doc"], xps_el["id"])
        record("set_chart_properties 修改轴向但不改变 chartType 与原始数据",
               edited.get("ok") is True and edited.get("applied") == 1
               and edited_el["type"] == "chart" and edited_el["chart"]["chartType"] == "line"
               and edited_el["chart"]["characterization"].get("x_reverse") is False
               and edited_el["chart"]["data"]["inline"]["rows"] == xps_rows_before,
               "chartType=line; raw inline rows unchanged")

        # 从同一 PDF 矢量链取 plot 几何，再逐段核对位图；图例同色线不是 plot。
        from PIL import Image
        export_dpi = 96
        expected_xps_px = (math.ceil(89 * export_dpi / 25.4),
                           math.ceil(170 * export_dpi / 25.4))
        fit_rgb = tuple(int(xps_fit_lines[0].get("stroke")[i:i + 2], 16)
                        for i in (1, 3, 5))
        baseline_rgb = tuple(int(xps_baseline_lines[0].get("stroke")[i:i + 2], 16)
                             for i in (1, 3, 5))
        export_fit_points_px = []

        def fit_geometry_ok():
            return (len(export_fit_points_px) == len(xps_rows)
                    and all(a[0] > b[0] for a, b in zip(
                        export_fit_points_px, export_fit_points_px[1:])))

        def raster_export_check(path, fmt):
            with Image.open(str(path)) as im:
                size = im.size
                if fmt == "tiff":
                    dpi = (float(im.tag_v2[282]), float(im.tag_v2[283]))
                else:
                    dpi = im.info.get("dpi") or (0, 0)
                rgb = im.convert("RGB")
                tolerance = 90 if fmt == "jpeg" else 75
                radius = 3
                sample_fractions = (0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9)
                sampled_segments = set()
                samples = hits = 0
                for segment, (start, end) in enumerate(zip(
                        export_fit_points_px, export_fit_points_px[1:])):
                    for fraction in sample_fractions:
                        samples += 1
                        cx = start[0] + (end[0] - start[0]) * fraction
                        cy = start[1] + (end[1] - start[1]) * fraction
                        matched = False
                        for px in range(max(0, int(round(cx)) - radius),
                                        min(im.width, int(round(cx)) + radius + 1)):
                            for py in range(max(0, int(round(cy)) - radius),
                                            min(im.height, int(round(cy)) + radius + 1)):
                                distance = math.sqrt(sum(
                                    (rgb.getpixel((px, py))[channel] - fit_rgb[channel]) ** 2
                                    for channel in range(3)))
                                if distance <= tolerance:
                                    matched = True
                        if matched:
                            hits += 1
                            sampled_segments.add(segment)
                dpi_ok = len(dpi) == 2 and all(abs(float(v) - export_dpi) < 0.2 for v in dpi)
                return (size == expected_xps_px and dpi_ok and fit_geometry_ok()
                        and samples == len(sample_fractions) * (len(xps_rows) - 1)
                        and len(sampled_segments) == len(xps_rows) - 1), {
                            "size": size, "dpi": dpi, "fit_points": len(export_fit_points_px),
                            "fit_segments": "%d/%d" % (len(sampled_segments), len(xps_rows) - 1),
                            "samples": "%d/%d" % (hits, samples), "radius_px": radius,
                            "rgb_distance_max": tolerance,
                            "dash_gaps": "虚线间隙允许样本落空；每段至少一个内部样本命中"}

        def pdf_export_check(path):
            try:
                import fitz
                pdf = fitz.open(str(path))
                try:
                    page = pdf[0]
                    drawings = page.get_drawings()

                    def with_color(rgb):
                        return [d for d in drawings if d.get("type") == "s"
                                and d.get("color") is not None and len(d["color"]) == 3
                                and all(abs(d["color"][i] * 255 - rgb[i]) < 1
                                        for i in range(3))
                                and all(item[0] == "l" for item in d.get("items") or [])]

                    fit_drawings = with_color(fit_rgb)
                    baseline_drawings = with_color(baseline_rgb)
                    fit_plots = [d for d in fit_drawings
                                 if len(d.get("items") or []) == len(xps_rows) - 1]
                    baseline_plots = [d for d in baseline_drawings
                                      if len(d.get("items") or []) == len(xps_rows) - 1]
                    if len(fit_plots) == 1:
                        items = fit_plots[0]["items"]
                        points = [items[0][1]] + [item[2] for item in items]
                        export_fit_points_px[:] = [
                            (point.x * export_dpi / 72, point.y * export_dpi / 72)
                            for point in points]
                    words = page.get_text("words")
                    texts = page.get_text().splitlines()
                    tick_values = {"1200", "1000", "800", "600", "400", "200"}
                    x_ticks = sorted((w for w in words if w[4] in tick_values),
                                     key=lambda w: w[0])
                    reverse_axis = len(x_ticks) >= 3 and all(
                        float(a[4]) > float(b[4]) for a, b in zip(x_ticks, x_ticks[1:]))
                    expected_pt = (89 * 72 / 25.4, 170 * 72 / 25.4)
                    size_ok = abs(page.rect.width - expected_pt[0]) < 0.1 \
                        and abs(page.rect.height - expected_pt[1]) < 0.1
                    return (pdf.page_count == 1 and size_ok and len(fit_plots) == 1
                            and len(baseline_plots) == 1 and reverse_axis and fit_geometry_ok()
                            and not page.get_images(full=True)
                            and texts.count("fit") == 1 and texts.count("Intensity (cps)") == 1), {
                                "pages": pdf.page_count, "pt": [page.rect.width, page.rect.height],
                                "fit_vectors": len(fit_drawings), "fit_plots": len(fit_plots),
                                "baseline_vectors": len(baseline_drawings),
                                "baseline_plots": len(baseline_plots),
                                "reverse_ticks": [w[4] for w in x_ticks],
                                "images": len(page.get_images(full=True))}
                finally:
                    pdf.close()
            except Exception as exc:
                return False, "%s: %s" % (exc.__class__.__name__, exc)

        for fmt, suffix in (("pdf", "pdf"), ("png", "png"),
                            ("jpeg", "jpg"), ("tiff", "tiff")):
            path = out_dir / ("xps-fit-reverse." + suffix)
            result = client.call_tool("figure_export", {
                "doc": xps_doc, "format": fmt, "dpi": export_dpi, "out_path": str(path)})
            if fmt == "pdf":
                content_ok, detail = pdf_export_check(path)
            else:
                content_ok, detail = raster_export_check(path, fmt)
            record("XPS 真实导出 %s 含拟合曲线、反轴内容与尺寸/DPI 元数据%s" % (
                fmt.upper(), "且非整页位图" if fmt == "pdf" else ""),
                result.get("ok") is True and path.is_file()
                and (result.get("px") or {}).get("width") == expected_xps_px[0]
                and (result.get("px") or {}).get("height") == expected_xps_px[1]
                and content_ok, detail)

        # apply_template 直接接收已解析 data；经真实 MCP app/ops 链重建双区域模板。
        dual_base = client.call_tool("figure_create", {
            "title": "XPS 双区域", "width_mm": 180, "height_mm": 85})
        dual_anchor = client.call_tool("figure_add_anchor", {
            "doc": dual_base["doc"], "label": "保留锚点",
            "bbox_mm": {"x": 1, "y": 1, "w": 10, "h": 5}})
        dual_data = {"columns": xps_columns, "rows": xps_rows}
        dual_applied = client.call_tool("figure_apply_edits", {
            "doc": dual_anchor["doc"],
            "ops": [{"op": "apply_template", "template_id": "tpl-xps-two-regions",
                     "data": dual_data, "options": {"journal_id": "nature-single",
                                                   "palette_id": "npg"}}]})
        two_doc = dual_applied.get("doc") or {}
        two_charts = [e for e in two_doc.get("elements") or [] if e.get("type") == "chart"]
        record("apply_template 经真实 app/ops 提交 data/options 后生成两个 characterization 图表",
               dual_applied.get("ok") is True and dual_applied.get("applied") == 1
               and len(two_charts) == 2
               and (two_doc.get("meta") or {}).get("template_id") == "tpl-xps-two-regions"
               and all(e["chart"].get("characterization") for e in two_charts)
               and all(e["chart"]["data"]["inline"] == dual_data for e in two_charts)
               and len(two_doc.get("anchors") or []) == 1,
               "charts=%d" % len(two_charts))

        raman_columns = ["Raman shift (cm-1)", "Intensity (a.u.)", "Sample"]
        raman_rows = [[1300, 7, "A"], [200, 3, "A"], [2800, 4, "A"],
                      [2800, 8, "B"], [200, 6, "B"], [1300, 10, "B"]]
        raman_result = chart_data("tpl-raman-multi-compare", raman_columns, raman_rows)
        raman_doc = raman_result.get("doc") or {}
        raman_svg_result = client.call_tool("figure_render", {"doc": raman_doc, "format": "svg"})
        raman_svg = raman_svg_result.get("svg") or ""
        raman_lines = ET.fromstring(raman_svg).findall(
            ".//{http://www.w3.org/2000/svg}polyline")
        raman_el = chart_of(raman_doc)
        assert len(raman_lines) == 2, "Raman 多样品原始曲线应为两条 polyline"
        raman_points = [svg_points(line) for line in raman_lines]
        record("Raman 乱序原材料不变、每谱升序渲染，归一化只作用于显示",
               raman_result.get("ok") is True and raman_svg_result.get("ok") is True
               and raman_el["chart"]["data"]["inline"]["rows"] == raman_rows
               and all(len(points) == 3 for points in raman_points)
               and all(all(a[0] < b[0] for a, b in zip(points, points[1:]))
                       for points in raman_points)
               and sorted(t for t in svg_texts(raman_svg) if t in ("A", "B")) == ["A", "B"]
               and 'normalize=max_to_unity' in raman_svg and 'x_reverse=false' in raman_svg
               and raman_el["chart"]["characterization"].get("x_reverse") is False,
               "两条原始谱均由 200→1300→2800 绘制，inline 未排序")

        cv_columns = ["Potential (V)", "Current (A)", "Cycle"]
        cv_rows = [[0.0, 0.0, 10], [0.1, 1.0, 10], [0.4, 0.2, 10], [0.2, 0.0, 10],
                   [0.0, 0.0, 2], [0.1, 2.0, 2], [0.4, 0.4, 2], [0.2, 0.0, 2]]
        cv_base = client.call_tool("figure_create", {
            "title": "CV 测量顺序", "width_mm": 120, "height_mm": 70})
        cv_result = client.call_tool("figure_create_chart", {
            "doc": cv_base["doc"], "data": {"inline": {"columns": cv_columns, "rows": cv_rows}},
            "template_id": "tpl-cv"})
        cv_doc = cv_result.get("doc") or {}
        cv_el = chart_of(cv_doc)
        cv_root = ET.fromstring((client.call_tool(
            "figure_render", {"doc": cv_doc, "format": "svg"})).get("svg") or "")
        cv_lines = cv_root.findall(".//{http://www.w3.org/2000/svg}polyline")
        assert len(cv_lines) == 2, "CV 数字循环应得到两条 polyline"
        cv_points = [svg_points(line) for line in cv_lines]
        measurement_order = all(len(points) == 4 and
                                points[0][0] < points[1][0] < points[2][0]
                                and points[1][0] < points[3][0] < points[2][0]
                                for points in cv_points)
        cv_labels = ["".join(node.itertext()) for node in cv_root.iter(
            "{http://www.w3.org/2000/svg}text")
            if node.get("text-anchor") is None and "".join(node.itertext()) in ("10", "2")]
        record("CV 数字循环映射保持 Cycle=10/2，曲线保留测量顺序而不是升序排序",
               cv_result.get("ok") is True
               and cv_el["chart"]["mapping"].get("group") == "Cycle"
               and cv_el["chart"]["data"]["inline"]["rows"] == cv_rows
               and measurement_order and cv_labels == ["10", "2"]
               and cv_el["chart"]["characterization"].get("x_reverse") is False,
               "四条点按 0.0→0.1→0.4→0.2 连接；图例 10 先于 2")

        # 两图统计不能相互替代；合同是补丁，统计清除不影响其他声明。
        def science_stats(source):
            return {"n_definition": "每条测量序列", "biological_replicates": 1,
                    "technical_replicates": 1, "center": "mean", "spread": "SD",
                    "uncertainty_source": "replicates", "source_data": source,
                    "unit_x": "eV", "unit_y": "cps"}

        first_id, second_id = two_charts[0]["id"], two_charts[1]["id"]
        stat_a, stat_b = science_stats("region-a.csv"), science_stats("region-b.csv")
        two_contract = {
            "schema_version": 1,
            "results_question": "两个区域的谱形是否一致？",
            "figure_claim": "双区域显示可比较的差异",
            "falsifier": "若两区域没有可复核差异则声明不成立",
            "archetype": "quantitative_grid", "hero_panel": first_id,
            "panels": [{"element_id": chart["id"], "label": label, "sequence": i + 1,
                        "question": "区域差异", "evidence_role": role,
                        "decisive_comparison": "区域 A 与区域 B",
                        "unique_gain": "提供本区域独立谱形", "claim_dependency": "双区域比较",
                        "destination": "main"}
                       for i, (chart, label, role) in enumerate(zip(
                           two_charts, ("a", "b"), ("primary", "orthogonal")))],
            "statistics": {first_id: stat_a},
        }
        one_stats = client.call_tool("figure_scientific_contract", {
            "doc": two_doc, "contract": two_contract})
        one_audit = client.call_tool("figure_scientific_audit", {"doc": one_stats["doc"]})
        record("两图一图有统计一图缺失时 coverage.statistics=false 且不 ready",
               (one_audit.get("coverage") or {}).get("statistics") is False
               and one_audit.get("scientific_ready") is False
               and any(w.get("code") == "STATS_NO_TRACE" and w.get("element_id") == second_id
                       for w in one_audit.get("warnings") or []))
        complete_stats = client.call_tool("figure_scientific_contract", {
            "doc": one_stats["doc"], "contract": {"statistics": {second_id: stat_b}}})
        complete_audit = client.call_tool("figure_scientific_audit", {"doc": complete_stats["doc"]})
        record("两图分别补齐统计后统计覆盖完整并可 ready",
               (complete_audit.get("coverage") or {}).get("statistics") is True
               and complete_audit.get("scientific_ready") is True)

        patched = client.call_tool("figure_scientific_contract", {
            "doc": complete_stats["doc"], "contract": {"figure_claim": "补丁后的声明"}})
        patched_view = patched.get("contract") or {}
        patched_stats = patched_view.get("statistics") or {}
        record("科学合同 patch 省略统计时保留两图统计、panels 与其他声明",
               patched_view.get("figure_claim") == "补丁后的声明"
               and patched_view.get("results_question") == two_contract["results_question"]
               and patched_view.get("panels") == two_contract["panels"]
               and patched_stats.get(first_id) == stat_a and patched_stats.get(second_id) == stat_b)
        dangling_doc = json.loads(json.dumps(patched["doc"]))
        dangling_doc["meta"]["scientific_contract"]["hero_panel"] = "chart-does-not-exist"
        dangling = client.call_tool("figure_scientific_audit", {"doc": dangling_doc})
        record("hero_panel 悬挂时 coverage.hero_panel=false 且不 ready",
               dangling.get("ok") is False and dangling.get("scientific_ready") is False
               and (dangling.get("coverage") or {}).get("hero_panel") is False
               and any(w.get("code") == "HERO_PANEL_MISSING"
                       for w in dangling.get("warnings") or []))

        missing_fit_source_doc = json.loads(json.dumps(xps_doc))
        missing_fit_source_char = chart_of(
            missing_fit_source_doc, xps_el["id"])["chart"]["characterization"]
        del missing_fit_source_char["fit_source"]
        fit_source_audit = client.call_tool("figure_scientific_audit", {
            "doc": missing_fit_source_doc})
        record("fit_source 告警独立于 chart.statistics，即使没有统计也明确报告",
               not chart_of(missing_fit_source_doc, xps_el["id"])["chart"].get("statistics")
               and any(w.get("code") == "CHAR_FIT_SOURCE_MISSING"
                       and w.get("element_id") == xps_el["id"]
                       for w in fit_source_audit.get("warnings") or []))

        kept_empty = client.call_tool("figure_scientific_contract", {
            "doc": patched["doc"], "contract": {"statistics": {}}})
        record("statistics={} 不改未列出的图表，保留两图统计",
               (kept_empty.get("contract") or {}).get("statistics", {}).get(first_id) == stat_a
               and (kept_empty.get("contract") or {}).get("statistics", {}).get(second_id) == stat_b)
        cleared_one = client.call_tool("figure_scientific_contract", {
            "doc": kept_empty["doc"], "contract": {"statistics": {first_id: None}}})
        cleared_one_stats = (cleared_one.get("contract") or {}).get("statistics") or {}
        restored_one = client.call_tool("figure_scientific_contract", {
            "doc": cleared_one["doc"],
            "contract": {"statistics": {first_id: stat_a, second_id: {}}}})
        restored_stats = (restored_one.get("contract") or {}).get("statistics") or {}
        record("单图 statistics[id]=null 或 {} 清除该图且保留另一图",
               first_id not in cleared_one_stats and cleared_one_stats.get(second_id) == stat_b
               and restored_stats.get(first_id) == stat_a and second_id not in restored_stats)
        cleared_all = client.call_tool("figure_scientific_contract", {
            "doc": restored_one["doc"], "contract": {"statistics": None}})
        record("statistics=null 清除全部统计但保留科学合同其他字段",
               (cleared_all.get("contract") or {}).get("statistics") == {}
               and (cleared_all.get("contract") or {}).get("figure_claim") == "补丁后的声明"
               and (cleared_all.get("contract") or {}).get("panels") == two_contract["panels"])

        # no-op 不写历史也不截断 redo；无 id add_element 的规范化 id 可跨进程重放。
        replay_base = client.call_tool("figure_create", {
            "title": "历史重放", "width_mm": 90, "height_mm": 50})
        text_element = {"type": "text", "text": "before",
                        "transform": {"x": 5, "y": 5, "w": 30, "h": 8},
                        "style": {"fontSizePt": 8}}
        added = client.call_tool("figure_apply_edits", {
            "doc": replay_base["doc"],
            "ops": [{"op": "add_element", "element": dict(text_element)}]})
        added_doc = added["doc"]
        replay_id = added_doc["elements"][0]["id"]
        recorded_add_op = added_doc["history"][-1]["ops"][0]
        undo_added = client.call_tool("figure_revert", {"doc": added_doc, "rev": 0})
        replay_client = MCPClient()
        try:
            replay_client.start()
            replayed = replay_client.call_tool("figure_revert", {
                "doc": undo_added["doc"], "rev": added_doc["history"][-1]["rev"]})
        finally:
            replay_client.stop()
        replayed_ids = [e.get("id") for e in (replayed.get("doc") or {}).get("elements") or []]
        record("无 id add_element 首次写入规范 id，undo 后跨进程 redo 重放保持同一 id",
               added.get("applied") == 1 and replay_id
               and recorded_add_op["element"].get("id") == replay_id
               and replayed_ids == [replay_id],
               "首次 id=%s；重放 ids=%s" % (replay_id, replayed_ids))

        changed = client.call_tool("figure_apply_edits", {
            "doc": xps_doc,
            "ops": [{"op": "set_chart_properties", "targets": [xps_el["id"]],
                     "properties": {"characterization": {"x_reverse": False}}}]})
        changed_rev = changed["doc"]["history"][-1]["rev"]
        original_xps_rev = xps_doc["history"][-1]["rev"]
        undone = client.call_tool("figure_revert", {"doc": changed["doc"], "rev": original_xps_rev})
        history_before_noop = (client.call_tool("figure_history", {"doc": undone["doc"]})
                               .get("history") or [])
        no_op = client.call_tool("figure_apply_edits", {
            "doc": undone["doc"],
            "ops": [{"op": "set_chart_properties", "targets": [xps_el["id"]],
                     "properties": {"characterization": {"x_reverse": True}}}]})
        noop_history = client.call_tool("figure_history", {"doc": no_op.get("doc") or {}})
        record("applied=0 不写 history、不改 doc，undo 后的 redo 尾部不消失",
               no_op.get("ok") is True and no_op.get("applied") == 0
               and no_op.get("errors") == [] and no_op.get("doc") == undone["doc"]
               and noop_history.get("history") == history_before_noop
               and any(r.get("rev") == changed_rev for r in noop_history.get("history") or []),
               "applied=%r history %d→%d" % (no_op.get("applied"),
                                              len(history_before_noop),
                                              len(noop_history.get("history") or [])))
        redone = client.call_tool("figure_revert", {"doc": no_op["doc"], "rev": changed_rev})
        redone_reverse = chart_of(redone["doc"], xps_el["id"])["chart"]["characterization"]["x_reverse"]
        record("applied=0 后 redo 恢复原表征修改而非丢失",
               redone.get("ok") is True and redone_reverse is False)

        # 首次 create 的 applyJournal 也要留下真实 rev0，而不是把首个历史伪称空基线。
        first_origin = ((replay_doc_origin := doc.get("meta") or {}).get("history_origin") or {})
        record("首次 create/applyJournal 后 origin.rev=0 且基线不含历史或后续素材",
               first_origin.get("rev") == 0
               and first_origin.get("doc", {}).get("elements") == []
               and "history" not in first_origin.get("doc", {})
               and "history_origin" not in (first_origin.get("doc", {}).get("meta") or {}),
               "origin.rev=%r" % first_origin.get("rev"))

        # 真实应用链：create -> 物化模板与数据 -> 修改 -> 保存 -> 新进程导入，无会话 cache。
        recovery_base = client.call_tool("figure_create", {
            "title": "跨会话历史恢复", "width_mm": 100, "height_mm": 70})["doc"]
        recovery_base["key"] = "checkpoint-excluded"
        recovery_base["DOM"] = {"host": "checkpoint-excluded"}
        recovery_base["saveToken"] = "checkpoint-excluded"
        recovery_base["meta"]["key"] = "checkpoint-excluded"
        recovery_base["meta"]["saveToken"] = "checkpoint-excluded"
        recovery_base["meta"]["recovery_marker"] = "元数据须保留"
        recovery_template = client.call_tool("figure_apply_edits", {
            "doc": recovery_base,
            "ops": [{"op": "apply_template", "template_id": "tpl-xps-highres-fit",
                     "data": {"columns": xps_columns, "rows": xps_rows},
                     "options": {"journal_id": JOURNAL_ID, "palette_id": "npg"}}]})
        recovery_first = recovery_template["doc"]
        recovery_chart = chart_of(recovery_first)
        recovery_second = client.call_tool("figure_apply_edits", {
            "doc": recovery_first,
            "ops": [{"op": "set_chart_properties", "targets": [recovery_chart["id"]],
                     "properties": {"characterization": {"x_reverse": False}}}]})["doc"]
        recovery_path = out_dir / "history-origin-recovery.figureproj.json"
        client.call_tool("figure_save_project", {
            "doc": recovery_second, "path": str(recovery_path)})
        saved_project = json.loads(recovery_path.read_text(encoding="utf-8"))
        saved_origin = saved_project["doc"]["meta"]["history_origin"]
        materialized = saved_project["history"][0]["ops"][0].get("materialized_template") or {}
        record("真实模板/素材写入 rev0 持久化 origin 与首条物化历史",
               saved_origin.get("rev") == 0
               and saved_origin.get("doc", {}).get("elements") == []
               and materialized.get("elements") == recovery_first["elements"]
               and saved_project["history"][0]["ops"][0]["data"]["rows"] == xps_rows
               and saved_project["doc"]["history"] == [],
               "origin.rev=%r materialized=%d" % (
                   saved_origin.get("rev"), len(materialized.get("elements") or [])))

        def invalid_checkpoint_field(value):
            if isinstance(value, list):
                return any(invalid_checkpoint_field(item) for item in value)
            if not isinstance(value, dict):
                return False
            return any(key in {"history_origin", "key", "DOM", "saveToken", "__snapshots"}
                       or invalid_checkpoint_field(item) for key, item in value.items())

        origin_doc = saved_origin.get("doc") or {}
        record("origin.doc 保留实际文档元数据但无 history/递归检查点/key/DOM/saveToken",
               not invalid_checkpoint_field(origin_doc)
               and "history" not in origin_doc
               and origin_doc.get("id") == recovery_base["id"]
               and (origin_doc.get("meta") or {}).get("recovery_marker") == "元数据须保留",
               "origin bytes=%d" % len(json.dumps(saved_origin, ensure_ascii=False)))

        def recovered_content(document):
            content = json.loads(json.dumps(document, ensure_ascii=False))
            content["history"] = []
            content.pop("key", None)
            content.pop("DOM", None)
            content.pop("saveToken", None)
            content["meta"].pop("updated", None)
            content["meta"].pop("key", None)
            content["meta"].pop("saveToken", None)
            return content

        recovery_client = MCPClient()
        try:
            recovery_client.start()
            loaded = recovery_client.call_tool("figure_load_project", {
                "path": str(recovery_path)})["doc"]
            restored_first = recovery_client.call_tool("figure_revert", {
                "doc": loaded, "rev": 1})
            restored_second = recovery_client.call_tool("figure_revert", {
                "doc": restored_first.get("doc") or {}, "rev": 2})
            record("导出/导入后无 cache 向前重放：模板元素/IDs/data/meta 与首次应用一致",
                   restored_first.get("ok") is True
                   and restored_first["doc"]["elements"] == recovery_first["elements"]
                   and recovered_content(restored_first["doc"]) == recovered_content(recovery_first)
                   and restored_first["doc"]["meta"]["history_origin"]["rev"] == 0,
                   "rev1 charts=%d" % len([
                       e for e in restored_first.get("doc", {}).get("elements", [])
                       if e.get("type") == "chart"]))
            record("从恢复点二次跨版本 forward replay 仍复用同一物化模板与原始数据",
                   restored_second.get("ok") is True
                   and restored_second["doc"]["elements"] == recovery_second["elements"]
                   and recovered_content(restored_second["doc"]) == recovered_content(recovery_second)
                   and chart_of(restored_second["doc"])["chart"]["characterization"]["x_reverse"] is False)

            # Legacy 只能以当前 content playhead 建基线；rev0/1 无 older cache 必须报错。
            legacy_project = json.loads(json.dumps(saved_project))
            del legacy_project["doc"]["meta"]["history_origin"]
            legacy_path = out_dir / "history-origin-legacy.figureproj.json"
            legacy_path.write_text(json.dumps(legacy_project, ensure_ascii=False), encoding="utf-8")
            legacy_loaded = recovery_client.call_tool("figure_load_project", {
                "path": str(legacy_path)})["doc"]
            legacy_origin = legacy_loaded["meta"]["history_origin"]
            record("旧工程无 capture 时以真实当前 content playhead rev2 初始化，不伪称 rev0",
                   legacy_origin.get("rev") == 2
                   and legacy_origin.get("doc", {}).get("elements") == recovery_second["elements"],
                   "legacy origin.rev=%r" % legacy_origin.get("rev"))
            legacy_failure = recovery_client.call_tool("figure_revert", {
                "doc": legacy_loaded, "rev": 1})
            legacy_ping = recovery_client.request("ping")
            record("目标 rev 早于后期 origin 且无 older cache 时明确失败，figure_revert 服务不退出",
                   legacy_failure.get("ok") is False
                   and "恢复检查点" in str(legacy_failure.get("error") or "")
                   and "rev 2 建立" in str(legacy_failure.get("error") or "")
                   and "更早的日志" in str(legacy_failure.get("error") or "")
                   and "result" in legacy_ping,
                   clip(legacy_failure.get("error")))
        finally:
            recovery_client.stop()

        # -- 7. figure_render（SVG 预览）------------------------------------------
        payload = client.call_tool("figure_render", {"doc": doc, "format": "svg"})
        svg = payload.get("svg") or ""
        record("figure_render ok=True 且 SVG 含 mm 尺寸声明",
               payload.get("ok") is True and len(svg) > 100
               and 'width="89mm"' in svg and "<svg" in svg,
               "svg_len=%d" % len(svg))

        # -- 7. figure_export（TIFF + PNG）----------------------------------------
        tiff_path = out_dir / "fig1.tiff"
        payload = client.call_tool("figure_export", {
            "doc": doc, "format": "tiff", "out_path": str(tiff_path)})
        exp_w = math.ceil(89 * 300 / 25.4)
        exp_h = math.ceil(170 * 300 / 25.4)
        record("figure_export tiff ok=True 且文件落盘、px=%dx%d" % (exp_w, exp_h),
               payload.get("ok") is True and tiff_path.is_file()
               and (payload.get("bytes") or 0) > 0
               and (payload.get("px") or {}).get("width") == exp_w
               and (payload.get("px") or {}).get("height") == exp_h,
               "path=%s bytes=%s" % (payload.get("path"), payload.get("bytes")))
        png_path = out_dir / "fig1.png"
        payload = client.call_tool("figure_export", {
            "doc": doc, "format": "png", "out_path": str(png_path)})
        record("figure_export png ok=True 且文件落盘",
               payload.get("ok") is True and png_path.is_file()
               and (payload.get("bytes") or 0) > 0,
               "path=%s bytes=%s" % (payload.get("path"), payload.get("bytes")))

        # -- Pillow 复核 TIFF ------------------------------------------------------
        try:
            from PIL import Image
            im = Image.open(str(tiff_path))
            dpi_ok = (abs(float(im.tag_v2[282]) - 300.0) < 0.5
                      and abs(float(im.tag_v2[283]) - 300.0) < 0.5)
            record("Pillow 复核 TIFF 尺寸 %s == (%d, %d) 且 282/283 ≈ 300dpi" % (
                im.size, exp_w, exp_h),
                im.size == (exp_w, exp_h) and dpi_ok,
                "282=%.3f 283=%.3f" % (float(im.tag_v2[282]), float(im.tag_v2[283])))
            im.close()
        except ImportError:
            record("Pillow 复核 TIFF", False, "未安装 Pillow，无法复核")
        except Exception as e:
            record("Pillow 复核 TIFF", False, "%s: %s" % (e.__class__.__name__, e))

        for name, passed, detail in export_scope_security_regression_probe(out_dir):
            record(name, passed, detail)
        for name, passed, detail in xps_chart_scope_regression_probe(out_dir):
            record(name, passed, detail)
    except Exception as e:
        record("主流程未捕获异常", False, "%s: %s" % (e.__class__.__name__, e))
    finally:
        client.stop()
        temporary_path = Path(sandbox.name)
        sandbox.cleanup()
        record("隔离临时产物与 HTTP 工程目录全部清理", not temporary_path.exists(),
               str(temporary_path))

    total = len(RESULTS)
    failed = [name for name, ok in RESULTS if not ok]
    print("\n===== 结果汇总 =====")
    print("总计 %d 项断言：PASS %d 项，FAIL %d 项" % (
        total, total - len(failed), len(failed)))
    for name in failed:
        print("  - FAIL: %s" % name)
    if not failed:
        print("全部测试产物均来自独立临时目录，且已清理；未使用正式当前工程。")
    print("退出码：%d" % (1 if failed else 0))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
