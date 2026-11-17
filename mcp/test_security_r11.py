# -*- coding: utf-8 -*-
"""test_security_r11.py — R11 安全/正确性回归。

覆盖：
1. llm 桥（llm-bridge.js）：无 CORS 头、OPTIONS 落 404、带 Origin 回 403、/chat 超 16 MiB 回 413、
   正常 /chat 仍返回模型内容；
2. viewer.py 统一请求守卫：evil Origin / 错误 Content-Type / evil Host →
   403/415 且文档不变；同源 Origin 与无 Origin 推送正常；/api/ai/chat 外源
   Origin → 403；
3. /api/doc 推送不同 id：旧活动标签保留在 order 且其标签文件含推送前最新内容；
4. Ui.confirm 字符串 body 按纯文本插入（XSS）：<img onerror> 不执行、
   原文可见。
"""
import http.client
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent      # mcp/
ROOT = HERE.parent                           # bundle root
BRIDGE_JS = ROOT / "llm-bridge.js"
sys.path.insert(0, str(HERE))
from test_modal_layout import _ViewerServer, HAS_PLAYWRIGHT, _launch_chromium  # noqa: E402


def _doc(doc_id, title=""):
    return {
        "id": doc_id,
        "schema_version": "1.0",
        "title": title,
        "canvas": {"width_mm": 210, "height_mm": 297, "unit": "mm",
                   "dpi": 300, "background": "#FFFFFF"},
        "elements": [],
        "anchors": [],
        "meta": {"created": "2026-01-01T00:00:00Z",
                 "updated": "2026-01-01T00:00:00Z"},
        "history": [],
    }


def _post(base, path, payload, headers=None):
    req = urllib.request.Request(
        base + path, data=json.dumps(payload).encode("utf-8"),
        headers=headers or {"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"ok": False, "error": "http %s" % e.code}


def _get(base, path):
    with urllib.request.urlopen(base + path, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---------------------------------------------------------------------------
# 1. llm 桥（node 直跑 llm-bridge.js，假 ctx.llm）
# ---------------------------------------------------------------------------

_BRIDGE_MJS = r"""
import { startLlmBridge, closeLlmBridge } from 'BRIDGE_URL'
const port = Number(process.argv[2])
const ctx = { llm: {}, logger: { info() {}, warn() {}, error() {} } }
startLlmBridge(ctx, { llmBridgePort: port }, {
  callLlm: async (c, msgs) => 'FAKE-' + msgs.length,
  hasImage: () => false,
  imageErr: 'img-unsupported',
})
const base = 'http://127.0.0.1:' + port
const out = { checks: {} }
async function probe(path, opts) {
  const r = await fetch(base + path, opts)
  let body = null
  try { body = await r.json() } catch (e) { body = null }
  return { status: r.status,
           acao: r.headers.get('access-control-allow-origin'),
           acam: r.headers.get('access-control-allow-methods'),
           acah: r.headers.get('access-control-allow-headers'),
           body: body }
}
// 等桥就绪
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(base + '/health'); if (r.ok) break } catch (e) {}
  await new Promise(r => setTimeout(r, 100))
}
out.checks.health = await probe('/health')
out.checks.chat = await probe('/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) })
out.checks.options = await probe('/chat', { method: 'OPTIONS' })
out.checks.evilOrigin = await probe('/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) })
// 超过 16 MiB：17 MiB 原始字节（不必是合法 JSON——大小检查先于解析）
const big = 'x'.repeat(17 * 1024 * 1024)
out.checks.oversize = await probe('/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big })
closeLlmBridge()
console.log(JSON.stringify(out))
process.exit(0)
"""


class BridgeSecurityTest(unittest.TestCase):
    def test_bridge_no_cors_and_body_limit(self):
        if not BRIDGE_JS.is_file():
            self.skipTest("llm-bridge.js 不存在")
        port = _free_port()
        script = _BRIDGE_MJS.replace(
            "BRIDGE_URL",
            "file:///" + str(BRIDGE_JS).replace("\\", "/"))
        tmp = Path(tempfile.mkdtemp(prefix="fig-r11-bridge-")) / "bridge_test.mjs"
        tmp.write_text(script, encoding="utf-8")
        try:
            proc = subprocess.run(
                ["node", str(tmp), str(port)],
                capture_output=True, text=True, timeout=60,
                encoding="utf-8", errors="replace")
        finally:
            shutil.rmtree(tmp.parent, ignore_errors=True)
        self.assertEqual(proc.returncode, 0,
                         "bridge 脚本失败: %s" % proc.stderr[-800:])
        out = json.loads(proc.stdout.strip().splitlines()[-1])
        c = out["checks"]
        # /health、/chat、OPTIONS 均不得出现任何 CORS 响应头
        for name in ("health", "chat", "options", "evilOrigin", "oversize"):
            r = c[name]
            self.assertIsNone(r["acao"], "%s 泄漏 ACAO" % name)
            self.assertIsNone(r["acam"], "%s 泄漏 ACAM" % name)
            self.assertIsNone(r["acah"], "%s 泄漏 ACAH" % name)
        self.assertEqual(c["health"]["status"], 200)
        self.assertEqual(c["chat"]["status"], 200)
        self.assertEqual(
            c["chat"]["body"]["choices"][0]["message"]["content"], "FAKE-1")
        # OPTIONS 不再特判：落到 404
        self.assertEqual(c["options"]["status"], 404)
        # 带 Origin（浏览器发起）的 /chat 一律 403，网页无法盗用模型额度
        self.assertEqual(c["evilOrigin"]["status"], 403)
        # 超 16 MiB → 413
        self.assertEqual(c["oversize"]["status"], 413)


# ---------------------------------------------------------------------------
# 2/3. viewer 守卫 + 标签保留（隔离 FIGURE_DATA_DIR）
# ---------------------------------------------------------------------------

class ViewerGuardTest(unittest.TestCase):
    def setUp(self):
        self.datadir = tempfile.mkdtemp(prefix="fig-r11-data-")
        self.server = _ViewerServer(self.datadir)
        self.server.wait_ready()
        self.base = self.server.base
        self.port = int(self.base.rsplit(":", 1)[1])

    def tearDown(self):
        try:
            self.server.stop()
        finally:
            shutil.rmtree(self.datadir, ignore_errors=True)

    def _current_id(self):
        cur = _get(self.base, "/api/current")
        doc = cur.get("doc")
        return doc.get("id") if isinstance(doc, dict) else None

    def test_host_origin_content_type_guards(self):
        evil_headers = {"Content-Type": "application/json",
                        "Origin": "http://evil.example"}
        # 1) evil Origin → 403，文档不变（仍空）
        st, res = _post(self.base, "/api/doc", {"doc": _doc("d-evil")},
                        headers=evil_headers)
        self.assertEqual(st, 403, res)
        self.assertIsNone(self._current_id())
        # 2) Origin: null → 403
        st, res = _post(self.base, "/api/doc", {"doc": _doc("d-null")},
                        headers={"Content-Type": "application/json",
                                 "Origin": "null"})
        self.assertEqual(st, 403, res)
        # 3) 错误 Content-Type → 415，文档不变
        req = urllib.request.Request(
            self.base + "/api/doc", data=b'{"doc":{"id":"d-ct"}}',
            headers={"Content-Type": "text/plain"}, method="POST")
        try:
            urllib.request.urlopen(req, timeout=15)
            st = 200
        except urllib.error.HTTPError as e:
            st = e.code
        self.assertEqual(st, 415)
        self.assertIsNone(self._current_id())
        # 4) evil Host → 403（http.client 显式 Host 头）
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("POST", "/api/doc",
                     body=json.dumps({"doc": _doc("d-host")}),
                     headers={"Content-Type": "application/json",
                              "Host": "evil.example:%d" % self.port})
        resp = conn.getresponse()
        resp.read()
        self.assertEqual(resp.status, 403)
        conn.close()
        self.assertIsNone(self._current_id())
        # 5) 同源 Origin + JSON → 200
        st, res = _post(self.base, "/api/doc", {"doc": _doc("d-ok", "OK")},
                        headers={"Content-Type": "application/json",
                                 "Origin": "http://127.0.0.1:%d" % self.port})
        self.assertEqual(st, 200, res)
        self.assertEqual(self._current_id(), "d-ok")
        # 6) 无 Origin 的 Python/MCP 推送 → 200
        st, res = _post(self.base, "/api/doc", {"doc": _doc("d-py", "PY")})
        self.assertEqual(st, 200, res)
        self.assertEqual(self._current_id(), "d-py")
        # 7) /api/ai/chat 外源 Origin → 403（守卫先于路由）
        st, res = _post(self.base, "/api/ai/chat",
                        {"messages": [{"role": "user", "content": "hi"}]},
                        headers=evil_headers)
        self.assertEqual(st, 403, res)

    def test_doc_push_new_id_preserves_previous_tab(self):
        """两标签 + 推送新 id：旧活动标签留在 order 且标签文件=推送前最新内容。"""
        st, res = _post(self.base, "/api/current",
                        {"doc": _doc("doc-a", "A"), "base_token": None})
        self.assertEqual(st, 200, res)
        token_a = res["save_token"]
        st, res = _post(self.base, "/api/tabs/new",
                        {"doc": _doc("doc-b", "B"), "base_token": token_a})
        self.assertEqual(st, 200, res)
        token_b = res["save_token"]
        # 在 doc-b（活动）上做一次条件保存：最新内容只在 current，
        # tabs/doc-b 副本仍是建标签时的旧内容——正是被吞的那份。
        st, res = _post(self.base, "/api/current",
                        {"doc": _doc("doc-b", "B-最新"),
                         "base_token": token_b})
        self.assertEqual(st, 200, res)
        # MCP 风格推送：无 base_token、不同 id
        st, res = _post(self.base, "/api/doc", {"doc": _doc("doc-mcp", "MCP")})
        self.assertEqual(st, 200, res)
        tabs = _get(self.base, "/api/tabs")
        ids = [t["id"] for t in tabs["tabs"]]
        self.assertEqual(tabs["active_id"], "doc-mcp")
        self.assertIn("doc-a", ids)
        self.assertIn("doc-b", ids)          # 旧活动标签不再被吞
        self.assertIn("doc-mcp", ids)
        # doc-b 标签文件必须等于推送前 current 的最新内容
        tab_file = Path(self.datadir) / "projects" / "tabs" / "doc-b.figureproj.json"
        self.assertTrue(tab_file.is_file())
        saved = json.loads(tab_file.read_text(encoding="utf-8"))
        self.assertEqual(saved["doc"]["title"], "B-最新")
        self.assertEqual(saved["doc"]["id"], "doc-b")
        # doc-mcp 自己的标签文件也已写入
        mcp_file = Path(self.datadir) / "projects" / "tabs" / "doc-mcp.figureproj.json"
        self.assertTrue(mcp_file.is_file())
        self.assertEqual(self._current_id(), "doc-mcp")


# ---------------------------------------------------------------------------
# 4. modal 字符串 body XSS（Playwright）
# ---------------------------------------------------------------------------

@unittest.skipUnless(HAS_PLAYWRIGHT,
                     "Python playwright + chromium/Chrome 不可用，跳过")
class ModalXssTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.datadir = tempfile.mkdtemp(prefix="fig-r11-xss-")
        cls.server = _ViewerServer(cls.datadir)
        cls.server.wait_ready()
        cls.base = cls.server.base

    @classmethod
    def tearDownClass(cls):
        try:
            cls.server.stop()
        finally:
            shutil.rmtree(cls.datadir, ignore_errors=True)

    def test_confirm_string_body_is_text_not_html(self):
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        try:
            browser = _launch_chromium(pw)
            page = browser.new_page()
            page.goto(self.base + "/", wait_until="domcontentloaded")
            page.wait_for_function(
                "window.Ui && typeof Ui.confirm === 'function'", timeout=20000)
            payload = '<img src=x onerror="window.__xss=1">'
            # evaluate 会 await 表达式返回值：Ui.confirm 的 Promise 需用户点击
            # 才 resolve，用 void 让它立即返回。
            page.evaluate(
                "void (window.__confirmP = Ui.confirm(%s))"
                % json.dumps(payload))
            page.wait_for_selector(".ui-modal-overlay .ui-modal", timeout=10000)
            page.wait_for_timeout(300)
            # onerror 不得执行
            self.assertIsNone(page.evaluate("window.__xss || null"))
            # 对话框里不得出现真实 <img> 节点
            self.assertEqual(
                page.evaluate(
                    "document.querySelectorAll('.ui-modal-overlay img').length"),
                0)
            # 原文作为文本可见
            text = page.evaluate(
                "document.querySelector('.ui-modal-overlay .ui-modal-body')"
                " && document.querySelector('.ui-modal-overlay .ui-modal-body')"
                ".textContent")
            self.assertIn(payload, text or "")
            browser.close()
        finally:
            pw.stop()


if __name__ == "__main__":
    unittest.main(verbosity=2)
